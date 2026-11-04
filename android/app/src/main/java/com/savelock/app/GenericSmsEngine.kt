package com.savelock.app

/**
 * Kotlin mirror of generic-sms-engine.js. Keep its sender categories,
 * completed-transaction phrases, and loan-reminder exclusions aligned.
 */
object GenericSmsEngine {
    private val loanReminderRe = Regex(
        "\\b(?:repay\\s+(?:kshs?|kes)\\b|loan\\s+eligibility|extend\\s+by\\b|have\\s+not\\s+yet\\s+received\\s+payment)\\b",
        RegexOption.IGNORE_CASE
    )
    private val creditRe = Regex(
        "\\b(?:has\\s+been\\s+credited\\s+to|you\\s+have\\s+received|successfully\\s+sent\\s+to\\s+(?:you|your\\s+(?:account|wallet)))\\b",
        RegexOption.IGNORE_CASE
    )
    private val debitRe = Regex(
        "\\b(?:has\\s+been\\s+successfully\\s+sent\\s+to|has\\s+been\\s+debited)\\b",
        RegexOption.IGNORE_CASE
    )
    private val failedRe = Regex(
        "\\b(?:failed|unsuccessful|declined|could\\s+not\\s+be\\s+completed)\\b",
        RegexOption.IGNORE_CASE
    )
    private val amountRe = Regex(
        "(?<![A-Za-z0-9])(?:(KES|KSHS?)\\.?\\s*)?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)\\s*(KES|KSHS?)?(?![A-Za-z0-9])",
        RegexOption.IGNORE_CASE
    )
    private val referenceRe = Regex(
        "(?<![A-Za-z0-9])(?:ref(?:erence)?|txn|trx|trans(?:action)?|rrn|receipt|conf(?:irmation)?)\\s*(?:no\\.?|number|id|code)?\\s*[:#\\-]?\\s*([A-Z0-9][A-Z0-9\\-]{5,24})",
        RegexOption.IGNORE_CASE
    )
    private val debitRecipientRe = Regex(
        "\\bsuccessfully\\s+sent\\s+to\\s+([A-Za-z][A-Za-z0-9 &'./-]{1,40})",
        RegexOption.IGNORE_CASE
    )
    private val creditCounterpartyRe = Regex(
        "\\bcredited\\s+to\\s+(?:your\\s+)?(?:account|wallet)\\b",
        RegexOption.IGNORE_CASE
    )
    private val debitCounterpartyRe = Regex(
        "\\bdebited\\s+from\\s+([A-Za-z][A-Za-z0-9 &'./-]{1,40})",
        RegexOption.IGNORE_CASE
    )

    fun senderCategory(sender: String?): String? {
        val key = senderKey(sender)
        if (key.isEmpty() || key == "UNK" || key.all { it.isDigit() }) return null
        return when {
            Regex("MPESA|SAFARICOM").containsMatchIn(key) -> "mpesa"
            Regex("LOAN|LEND|CREDIT|REPAY|KORO|TALA|BRANCH|ZENKA|FULIZA|MSHWARI").containsMatchIn(key) -> "lending"
            Regex("BANK|EQUITY|KCB|COOP|NCBA|ABSA|DTB|STANBIC|FAMILY|BARCLAYS|STANDARDCHARTERED|IANDM|IMBANK|SIDIAN|HF|CITI").containsMatchIn(key) -> "bank"
            Regex("WALLET|FINANCE|MICROFINANCE").containsMatchIn(key) -> "financial"
            else -> null
        }
    }

    fun senderKey(sender: String?): String =
        (sender ?: "UNK").uppercase().replace(Regex("[^A-Z0-9]"), "")

    private fun hash(value: String): String {
        var h = 0
        for (c in value) h = h * 31 + c.code
        return Integer.toUnsignedString(h, 36).uppercase()
    }

    private fun transactionAmount(text: String): Pair<Double, String>? {
        for (match in amountRe.findAll(text)) {
            val currency = (match.groupValues[1].ifEmpty { match.groupValues[3] }).uppercase()
            if (currency.isEmpty()) continue
            val amount = match.groupValues[2].replace(",", "").toDoubleOrNull() ?: continue
            if (amount > 0) return amount to if (currency.startsWith("KS")) "KES" else currency.ifEmpty { "KES" }
        }
        return null
    }

    private fun findExpenseCategory(text: String): String =
        when {
            Regex("\\b(?:rent|landlord|apartment|apartments|estates|housing)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Rent"
            Regex("\\b(?:uber|bolt|little\\s+cab|matatu|sgr|shuttle|taxi|fuel|petrol|shell|rubis|kenol)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Transport"
            Regex("\\b(?:kplc|kenya\\s+power|nairobi\\s+water|dstv|gotv|startimes|zuku|utility|utilities)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Bills"
            Regex("\\b(?:java|kfc|pizza|naivas|quickmart|carrefour|tuskys|chandarana|supermarket|restaurant|eatery|cafe|butchery|bakery|hotel)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Food"
            Regex("\\b(?:airtime|bundles)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Airtime"
            Regex("\\b(?:shop|mall|store|boutique|mart)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Shopping"
            else -> "Other"
        }

    private fun findIncomeCategory(text: String): String =
        when {
            Regex("\\b(?:salary|payroll|wages)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Salary"
            Regex("\\b(?:refund|refunded|reversal|reversed)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text) -> "Refund"
            else -> "Other income"
        }

    /**
     * Unrecognized senders and messages without a confirmed transaction
     * structure return null. Loan reminders return a private transaction
     * type so the JS store can retain them without displaying/counting them.
     */
    fun parse(rawBody: String?, sender: String?, receivedAtMs: Long, trustedSenders: Set<String> = emptySet()): MpesaTransaction? {
        if (rawBody.isNullOrBlank()) return null
        val text = rawBody.replace(Regex("\\s+"), " ").trim()
        if (text.length < 15 || text.length > 800) return null

        val senderCategory = senderCategory(sender) ?: return null
        val key = senderKey(sender)
        val amount = transactionAmount(text)
        val reference = referenceRe.find(text)?.groupValues?.get(1)
        val code = if (reference != null) "GEN${hash(key)}${reference.uppercase()}" else "GEN${hash("$key|$text")}"

        if (senderCategory == "lending" && loanReminderRe.containsMatchIn(text)) {
            return MpesaTransaction(
                mpesaCode = code,
                type = "loan_reminder",
                subtype = "loan_reminder",
                amount = amount?.first ?: 0.0,
                counterparty = key,
                category = "loan_reminder",
                balance = null,
                receivedAt = receivedAtMs,
                provider = key,
                currency = amount?.second ?: "KES",
                reference = reference
            )
        }

        if (failedRe.containsMatchIn(text)) return null
        val isCredit = creditRe.containsMatchIn(text)
        val isDebit = !isCredit && debitRe.containsMatchIn(text)
        if (isCredit == isDebit) return null
        val transactionAmount = amount ?: return null
        val recipient = debitRecipientRe.find(text)?.groupValues?.get(1)?.trim()?.trimEnd(' ', '-', '/')
        val counterparty = when {
            recipient != null -> recipient
            isDebit -> debitCounterpartyRe.find(text)?.groupValues?.get(1)?.trim() ?: "Unknown payee"
            creditCounterpartyRe.containsMatchIn(text) -> "Unknown sender"
            else -> "Unknown sender"
        }
        return MpesaTransaction(
            mpesaCode = code,
            type = if (isDebit) "spend" else "received",
            subtype = "generic",
            amount = transactionAmount.first,
            counterparty = counterparty,
            category = if (isDebit) findExpenseCategory(text) else null,
            balance = null,
            receivedAt = receivedAtMs,
            provider = key,
            confidence = 1.0,
            tier = "auto",
            currency = transactionAmount.second,
            reference = reference,
            incomeCategory = if (isCredit) findIncomeCategory(text) else null
        )
    }
}
