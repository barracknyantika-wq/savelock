package com.savelock.app

/**
 * Kotlin mirror of src/scripts/generic-sms-engine.js — same vocabulary, same
 * scoring, same conservative three-tier confidence stance. No shared runtime
 * with the web app, so keep the two in sync by hand if the vocabulary ever
 * changes (same convention this codebase already uses for MpesaParser.kt).
 *
 * Only called for senders MpesaParser.isMpesaSender() rejects — M-Pesa
 * traffic always goes through the proven strict parser first; this engine
 * exists purely to recognize bank/wallet alerts nobody has written a
 * template for.
 */
object GenericSmsEngine {

    private const val AUTO_THRESHOLD = 0.75
    private const val REVIEW_THRESHOLD = 0.5

    private val FAILED_WORDS = listOf(
        "insufficient", "declined", "failed", "unsuccessful", "not successful", "could not", "unable to", "has been blocked"
    )
    private val OTP_WORDS = listOf(
        "otp", "one time password", "one-time password", "verification code", "passcode", "security code"
    )
    private val PROMO_WORDS = listOf(
        "you qualify", "pre-approved", "preapproved", "loan of", "loan limit", "apply now", "dial *", "dial #",
        "special offer", "promo", "terms and conditions", "download the app", "congratulations"
    )
    private val BALANCE_WORDS = listOf("balance", "bal", "avail", "available", "ledger")
    private val FEE_WORDS = listOf("fee", "fees", "charge", "charges", "commission", "excise", "tax", "levy", "duty", "cost")
    private val LIMIT_WORDS = listOf("limit")

    private val DEBIT_WEIGHTS = listOf(
        "debited" to 3, "debit alert" to 3, "withdrawn" to 3, "withdrew" to 3, "withdrawal" to 2,
        "purchase" to 2, "purchased" to 2, "spent" to 2, "sent to" to 3, "transferred to" to 3,
        "transfer to" to 2, "paid to" to 3, "payment to" to 2, "paid" to 1, "payment" to 1,
        "charged" to 2, "deducted" to 3, "bought" to 2, "used at" to 3, "pos" to 1, "atm" to 1,
        "standing order" to 2, "direct debit" to 3, "from your account" to 4, "from your a/c" to 4,
        "from a/c" to 4, "from acc" to 3, "from account" to 3
    )
    private val CREDIT_WEIGHTS = listOf(
        "credited" to 3, "credit alert" to 3, "received" to 3, "deposited" to 3, "deposit" to 1,
        "salary" to 2, "refund" to 2, "refunded" to 3, "reversal" to 2, "reversed" to 2,
        "transferred from" to 3, "transfer from" to 2, "inward" to 2, "cash in" to 2,
        "to your account" to 4, "to your a/c" to 4, "into your account" to 4, "to a/c" to 3, "to acc" to 2
    )
    private val CATEGORY_HINTS = listOf(
        "Rent" to listOf("rent", "landlord", "apartment", "apartments", "estates", "housing"),
        "Transport" to listOf("uber", "bolt", "little cab", "matatu", "sgr", "shuttle", "taxi", "fuel", "petrol", "shell", "rubis", "kenol"),
        "Bills" to listOf("kplc", "kenya power", "nairobi water", "dstv", "gotv", "startimes", "zuku", "utility", "utilities"),
        "Food" to listOf("java", "kfc", "pizza", "naivas", "quickmart", "carrefour", "tuskys", "chandarana", "supermarket", "restaurant", "eatery", "cafe", "butchery", "bakery", "hotel"),
        "Airtime" to listOf("airtime", "bundles"),
        "Shopping" to listOf("shop", "mall", "store", "boutique", "mart")
    )
    private val INCOME_HINTS = listOf(
        "Salary" to listOf("salary", "payroll", "wages"),
        "Refund" to listOf("refund", "refunded", "reversal", "reversed")
    )
    private val DEBIT_CUES = listOf(
        "sent to", "paid to", "transferred to", "transfer to", "payment to", "used at", "purchase at",
        "purchased at", "spent at", "paid at", "bought at", "withdrawn at", "at"
    )
    private val CREDIT_CUES = listOf(
        "received from", "transferred from", "transfer from", "deposit from", "payment from", "credited by", "from"
    )

    private fun esc(s: String) = Regex.escape(s)
    private fun phrase(p: String) = esc(p).replace(" ", "\\s+")
    private fun anyOf(words: List<String>): Regex =
        Regex("(?<![A-Za-z0-9])(?:${words.joinToString("|") { phrase(it) }})(?![A-Za-z0-9])", RegexOption.IGNORE_CASE)

    private val failedRe = anyOf(FAILED_WORDS)
    private val otpRe = anyOf(OTP_WORDS)
    private val promoRes = PROMO_WORDS.map { anyOf(listOf(it)) }
    private val balanceRe = anyOf(BALANCE_WORDS)
    private val feeRe = anyOf(FEE_WORDS)
    private val limitRe = anyOf(LIMIT_WORDS)
    private val debitRes = DEBIT_WEIGHTS.map { (p, w) -> anyOf(listOf(p)) to w }
    private val creditRes = CREDIT_WEIGHTS.map { (p, w) -> anyOf(listOf(p)) to w }
    private val categoryRes = CATEGORY_HINTS.map { (k, words) -> k to anyOf(words) }
    private val incomeRes = INCOME_HINTS.map { (k, words) -> k to anyOf(words) }

    private const val CUR = "(?:KES|KSHS?|USD|TZS|UGX)"
    private const val NUM = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)"
    private val PRE_AMOUNT_RE = Regex("(?<![A-Za-z0-9])($CUR)\\.?\\s?$NUM", RegexOption.IGNORE_CASE)
    private val POST_AMOUNT_RE = Regex("(?<![\\d,.])$NUM\\s?(?:(?:KES|KSHS?)(?![A-Za-z])|/=)", RegexOption.IGNORE_CASE)
    private val FALLBACK_AMOUNT_RE = Regex("(?<![A-Za-z0-9])(?:amt|amount|value)\\.?\\s*[:\\-]?\\s*$NUM", RegexOption.IGNORE_CASE)
    private val ACCT_RE = Regex("(?:[Xx*]{2,}|ending(?:\\s+in|\\s+with)?\\s*)[\\s-]*(\\d{3,4})(?!\\d)", RegexOption.IGNORE_CASE)
    private val REF_RE = Regex(
        "(?<![A-Za-z0-9])(?:ref(?:erence)?|txn|trx|trans(?:action)?|rrn|receipt|conf(?:irmation)?)\\s*(?:no\\.?|number|id|code)?\\s*[:#\\-]?\\s*([A-Z0-9][A-Z0-9\\-]{5,24})",
        RegexOption.IGNORE_CASE
    )
    private val CP_BODY = "([A-Za-z0-9][A-Za-z0-9 &'\\-/]{1,40}?)"
    private val CP_STOP =
        "(?=\\s+(?:on|ref|reference|via|from|using|for|date|dated|bal|balance|avail|available|a/c|acc|account|txn|trx|at|to|narration)(?![A-Za-z0-9])|\\s*[.;,(]|\\s*$)"
    private val BAD_CP = Regex("^(your|my|the|a/c|acc|account|card|self|you|atm|pos)(?![A-Za-z0-9])", RegexOption.IGNORE_CASE)
    private val MASKED_CP = Regex("^[\\dXx*\\s-]+$")

    private data class Amount(val start: Int, val end: Int, val value: Double, val currency: String, var kind: String = "tx")

    private fun toNum(s: String): Double = s.replace(",", "").toDouble()

    private fun hash(s: String): String {
        var h = 0
        for (c in s) h = h * 31 + c.code
        return Integer.toUnsignedString(h, 36).uppercase()
    }

    fun senderKey(sender: String?): String =
        (sender ?: "UNK").uppercase().replace(Regex("[^A-Z0-9]"), "")

    private fun findAmounts(text: String): List<Amount> {
        val found = mutableListOf<Amount>()
        for (m in PRE_AMOUNT_RE.findAll(text)) {
            val cur = m.groupValues[1].uppercase()
            found.add(Amount(m.range.first, m.range.last + 1, toNum(m.groupValues[2]), if (cur.startsWith("KS")) "KES" else cur))
        }
        for (m in POST_AMOUNT_RE.findAll(text)) {
            val start = m.range.first
            val end = m.range.last + 1
            if (found.none { start < it.end && end > it.start }) {
                found.add(Amount(start, end, toNum(m.groupValues[1]), "KES"))
            }
        }
        return found.sortedBy { it.start }
    }

    private fun score(text: String, list: List<Pair<Regex, Int>>): Pair<Int, Int> {
        var sum = 0
        var max = 0
        for ((re, w) in list) {
            if (re.containsMatchIn(text)) {
                sum += w
                if (w > max) max = w
            }
        }
        return sum to max
    }

    private fun firstHint(list: List<Pair<String, Regex>>, text: String): String? {
        for ((k, re) in list) if (re.containsMatchIn(text)) return k
        return null
    }

    private fun findCounterparty(text: String, isDebit: Boolean): String? {
        val cues = if (isDebit) DEBIT_CUES else CREDIT_CUES
        for (cue in cues) {
            val re = Regex("(?<![A-Za-z0-9])${phrase(cue)}\\s+$CP_BODY$CP_STOP", RegexOption.IGNORE_CASE)
            for (m in re.findAll(text)) {
                val name = m.groupValues[1].trim().trimEnd(' ', '-', '/')
                if (name.length >= 2 && !BAD_CP.containsMatchIn(name) && !MASKED_CP.matches(name)) return name
            }
        }
        return null
    }

    private fun findReference(text: String): String? {
        for (m in REF_RE.findAll(text)) {
            val ref = m.groupValues[1]
            if (ref.any { it.isDigit() }) return ref.uppercase()
        }
        return null
    }

    /**
     * Returns null when nothing was found, rejected outright (OTP, promo,
     * failed transaction, no clear direction), or scored below the review
     * threshold — same "return null rather than guess" contract as
     * MpesaParser.parse(). trustedSenders lifts a review-tier result to
     * auto for senders the user has confirmed before (per-sender learning,
     * plumbed in from SmsReceiver's own SharedPreferences set).
     */
    fun parse(rawBody: String?, sender: String?, receivedAtMs: Long, trustedSenders: Set<String> = emptySet()): MpesaTransaction? {
        if (rawBody.isNullOrBlank()) return null
        val text = rawBody.replace(Regex("\\s+"), " ").trim()
        if (text.length < 15 || text.length > 800) return null

        val (dSum, dMax) = score(text, debitRes)
        val (cSum, cMax) = score(text, creditRes)
        val maxW = maxOf(dMax, cMax)

        if (failedRe.containsMatchIn(text)) return null
        if (otpRe.containsMatchIn(text) && maxW < 3) return null
        val promoHits = promoRes.count { it.containsMatchIn(text) }
        if (promoHits > 0 && maxW < 3) return null

        val amounts = findAmounts(text).toMutableList()
        for (i in amounts.indices) {
            val prevEnd = if (i > 0) amounts[i - 1].end else 0
            val ctxStart = maxOf(prevEnd, amounts[i].start - 26)
            val ctx = text.substring(ctxStart, amounts[i].start)
            amounts[i].kind = when {
                balanceRe.containsMatchIn(ctx) -> "balance"
                feeRe.containsMatchIn(ctx) -> "fee"
                limitRe.containsMatchIn(ctx) -> "limit"
                else -> "tx"
            }
        }
        var txAmount = amounts.firstOrNull { it.kind == "tx" }
        var usedFallback = false
        if (txAmount == null) {
            val fm = FALLBACK_AMOUNT_RE.find(text)
            if (fm != null) {
                txAmount = Amount(0, 0, toNum(fm.groupValues[1]), "KES")
                usedFallback = true
            }
        }
        if (txAmount == null || !(txAmount.value > 0)) return null

        if (dSum == 0 && cSum == 0) return null
        val diff = dSum - cSum
        if (diff == 0) return null
        val isDebit = diff > 0

        val balance = amounts.firstOrNull { it.kind == "balance" }?.value
        val reference = findReference(text)
        val accountLast4 = ACCT_RE.find(text)?.groupValues?.get(1)
        val counterparty = findCounterparty(text, isDebit)

        val sk = senderKey(sender)
        val trusted = trustedSenders.map { senderKey(it) }.toSet().contains(sk)
        var conf = 0.15 + (if (kotlin.math.abs(diff) >= 3) 0.35 else 0.2)
        conf += if (sender.isNullOrBlank()) 0.0 else if (trusted) 0.4 else if (sender.any { it.isLetter() }) 0.2 else -0.3
        if (balance != null) conf += 0.1
        if (reference != null) conf += 0.1
        if (accountLast4 != null) conf += 0.05
        if (counterparty != null) conf += 0.05
        if (usedFallback) conf -= 0.15
        conf -= 0.3 * minOf(promoHits, 2)
        conf = (conf.coerceIn(0.0, 1.0) * 100).let { Math.round(it) / 100.0 }

        val tier = when {
            conf >= AUTO_THRESHOLD -> "auto"
            conf >= REVIEW_THRESHOLD -> "review"
            else -> return null
        }

        val mpesaCode = if (reference != null) "GEN${hash(sk)}$reference" else "GEN${hash("$sk|$text")}"
        val type = if (isDebit) "spend" else "received"
        return MpesaTransaction(
            mpesaCode = mpesaCode,
            type = type,
            subtype = "generic",
            amount = txAmount.value,
            counterparty = counterparty ?: if (isDebit) "Unknown payee" else "Unknown sender",
            category = if (isDebit) (firstHint(categoryRes, text) ?: "Other") else null,
            balance = balance,
            receivedAt = receivedAtMs,
            viaFuliza = false,
            fulizaAmount = null,
            provider = sk,
            confidence = conf,
            tier = tier,
            currency = txAmount.currency,
            accountLast4 = accountLast4,
            reference = reference,
            incomeCategory = if (!isDebit) (firstHint(incomeRes, text) ?: "Other income") else null
        )
    }
}
