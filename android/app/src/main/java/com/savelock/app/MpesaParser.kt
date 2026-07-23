package com.savelock.app

/**
 * Kotlin mirror of src/scripts/mpesa-parser.js — same rules, same priority
 * order, same conservative "return null rather than guess" stance. There is
 * no shared runtime between the web app and this native receiver, so keep
 * the two files in sync by hand if the SMS templates ever change.
 */
data class MpesaTransaction(
    val mpesaCode: String,
    // "spend" | "received" | "fuliza_repayment" | "fuliza_activation" | "fuliza_interest"
    val type: String,
    val subtype: String,
    val amount: Double,
    val counterparty: String,
    val category: String?, // null for anything but "spend"
    val balance: Double?,
    val receivedAt: Long,
    // Real spending, just covered by overdraft rather than balance — set
    // only on "spend" transactions. fuliza_repayment/activation/interest
    // are their own types and are never double-counted as a spend.
    val viaFuliza: Boolean = false,
    val fulizaAmount: Double? = null
)

object MpesaParser {
    val MPESA_SENDER_IDS = setOf("MPESA")

    private val CODE_RE = Regex("\\b([A-Z][A-Z0-9]{8,11})\\b\\s+Confirmed")
    private val AMOUNT_RE = Regex("Ksh\\s?([\\d,]+(?:\\.\\d{2})?)", RegexOption.IGNORE_CASE)
    private val BALANCE_RE =
        Regex("(?:new\\s+)?m-pesa balance is ksh\\s?([\\d,]+(?:\\.\\d{2})?)", RegexOption.IGNORE_CASE)

    // Matches a domestic (0722123456) or international (254722123456) phone
    // number, with any digit possibly replaced by "*" per Safaricom's March
    // 2026 masking feature ("0705***734", "0722*000**"). Always wrapped in
    // an optional, non-capturing group below, never required: real messages
    // exist both with and without this segment ("sent to douglas moseti on
    // 23/7/26...", no number at all).
    private const val PHONE_OR_MASKED_RE = "(?:0[\\d*]{6,12}|[\\d*]{9,12})"

    // Fuliza (M-Pesa's overdraft) messages don't fit the plain "X paid to Y"
    // shape. A Fuliza-covered purchase rides on a normal Confirmed
    // transaction message (still parsed by RULES below) but adds a
    // sentence saying part of it was covered by Fuliza — that's an overlay,
    // not a different message. Repayment/activation/interest are genuinely
    // separate message types with no spend of their own.
    private val FULIZA_USED_RE = Regex(
        "fuliza\\s*m-pesa\\s*amount\\s*used\\s*to\\s*complete\\s*(?:this|your)\\s*transaction\\s*is\\s*ksh\\s?([\\d,]+(?:\\.\\d{2})?)",
        RegexOption.IGNORE_CASE
    )
    private val FULIZA_USED_ALT_RE = Regex(
        "fuliza\\s*m-pesa\\s*amount\\s*of\\s*ksh\\s?([\\d,]+(?:\\.\\d{2})?)\\s*has\\s*been\\s*used",
        RegexOption.IGNORE_CASE
    )
    private val FULIZA_REPAYMENT_RE = Regex(
        "ksh\\s?([\\d,]+(?:\\.\\d{2})?)[^.]*?used\\s*to\\s*(?:fully|partially)?\\s*pay\\s*your\\s*outstanding\\s*fuliza\\s*m-pesa",
        RegexOption.IGNORE_CASE
    )
    private val FULIZA_REPAYMENT_ANCHOR_RE = Regex(
        "used\\s*to\\s*(?:fully|partially)?\\s*pay\\s*your\\s*outstanding\\s*fuliza\\s*m-pesa",
        RegexOption.IGNORE_CASE
    )
    private val FULIZA_ACTIVATED_RE = Regex(
        "(?:activated\\s*for\\s*fuliza\\s*m-pesa|fuliza\\s*m-pesa\\s*has\\s*been\\s*activated)",
        RegexOption.IGNORE_CASE
    )
    private val FULIZA_LIMIT_RE =
        Regex("fuliza\\s*m-pesa\\s*limit\\s*is\\s*ksh\\s?([\\d,]+(?:\\.\\d{2})?)", RegexOption.IGNORE_CASE)
    private val FULIZA_INTEREST_RE = Regex(
        "(?:maintenance|access)\\s*fee\\s*of\\s*ksh\\s?([\\d,]+(?:\\.\\d{2})?)[^.]*?(?:charged|fuliza)",
        RegexOption.IGNORE_CASE
    )
    private val FULIZA_MENTION_RE = Regex("fuliza", RegexOption.IGNORE_CASE)

    private fun num(group: String?): Double? {
        if (group == null) return null
        return group.replace(",", "").toDoubleOrNull()
    }

    // No transaction code to dedup on for the code-less Fuliza messages
    // (activation, interest/maintenance fee) — derive a stable synthetic
    // one from the message text so the same SMS still can't be
    // double-processed.
    private fun syntheticCode(prefix: String, text: String): String {
        var h = 0
        for (c in text) {
            h = h * 31 + c.code
        }
        return prefix + Integer.toUnsignedString(h, 36).uppercase()
    }

    private fun matchFulizaUsed(text: String): Double? =
        num(FULIZA_USED_RE.find(text)?.groupValues?.get(1)) ?: num(FULIZA_USED_ALT_RE.find(text)?.groupValues?.get(1))

    // Fuliza-only messages that never carry the standard "<CODE> Confirmed"
    // transaction wrapper. Checked before the regular gate, since requiring
    // "Confirmed" would otherwise reject them outright.
    private fun parseStandaloneFuliza(text: String, receivedAtMs: Long): MpesaTransaction? {
        if (FULIZA_ACTIVATED_RE.containsMatchIn(text)) {
            return MpesaTransaction(
                mpesaCode = syntheticCode("FZACT", text),
                type = "fuliza_activation",
                subtype = "fuliza_activation",
                amount = num(FULIZA_LIMIT_RE.find(text)?.groupValues?.get(1)) ?: 0.0,
                counterparty = "Fuliza M-PESA",
                category = null,
                balance = null,
                receivedAt = receivedAtMs
            )
        }
        val interest = num(FULIZA_INTEREST_RE.find(text)?.groupValues?.get(1))
        if (interest != null && FULIZA_MENTION_RE.containsMatchIn(text)) {
            return MpesaTransaction(
                mpesaCode = syntheticCode("FZINT", text),
                type = "fuliza_interest",
                subtype = "fuliza_interest",
                amount = interest,
                counterparty = "Fuliza M-PESA",
                category = null,
                balance = null,
                receivedAt = receivedAtMs
            )
        }
        return null
    }

    private fun clean(name: String): String =
        name.removeSuffix(".").replace(Regex("\\s+"), " ").trim()

    // Best-effort category guess from the counterparty name, for spends
    // only — always overridable by the user, never trusted blindly. Order
    // matters: first matching rule wins. Falls back to "Other" rather than
    // a wrong guess. Kept in sync by hand with mpesa-parser.js's
    // CATEGORY_RULES / guessCategory.
    private val CATEGORY_RULES = listOf(
        "Transport" to Regex("\\b(uber|bolt|little cab|matatu|sgr|shuttle|taxi)\\b", RegexOption.IGNORE_CASE),
        "Bills" to Regex("\\b(kplc|nairobi water|dstv|gotv|startimes|zuku|utility|utilities)\\b", RegexOption.IGNORE_CASE),
        "Food" to Regex(
            "\\b(java|kfc|pizza|naivas|quickmart|carrefour|tuskys|chandarana|supermarket|restaurant|eatery|hotel|cafe|butchery|bakery)\\b",
            RegexOption.IGNORE_CASE
        ),
        "Shopping" to Regex("\\b(shop|mall|store|boutique|mart)\\b", RegexOption.IGNORE_CASE),
    )

    fun guessCategory(counterparty: String?, subtype: String): String {
        if (subtype == "airtime") return "Airtime"
        if (subtype == "withdraw") return "Other"
        val name = counterparty ?: ""
        for ((category, re) in CATEGORY_RULES) {
            if (re.containsMatchIn(name)) return category
        }
        return "Other"
    }

    private data class Rule(val type: String, val subtype: String, val match: (String) -> String?)

    private val RULES = listOf(
        Rule("received", "receive") { body ->
            Regex("received\\s+ksh[\\d,.]+\\s+from\\s+(.+?)\\s+(?:$PHONE_OR_MASKED_RE\\s+)?on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "paybill") { body ->
            Regex("sent\\s+to\\s+(.+?)\\s+for account\\s+.+?\\s+on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "send") { body ->
            Regex("sent\\s+to\\s+(.+?)\\s+(?:$PHONE_OR_MASKED_RE\\s+)?on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "till") { body ->
            Regex("paid\\s+to\\s+(.+?)\\s+on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "withdraw") { body ->
            // Tolerates both real-world orderings seen in agent-withdrawal
            // SMS: "Ksh2,000.00 withdrawn from X" and "withdrawn Ksh2,000.00 from X".
            Regex("(?:ksh[\\d,.]+\\s+)?withdrawn\\s+(?:ksh[\\d,.]+\\s+)?from\\s+(.+?)\\s+on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "airtime") { body ->
            if (Regex("bought\\s+ksh[\\d,.]+\\s+of\\s+airtime", RegexOption.IGNORE_CASE).containsMatchIn(body))
                "Airtime"
            else null
        },
    )

    fun parse(rawBody: String?, receivedAtMs: Long): MpesaTransaction? {
        if (rawBody.isNullOrBlank()) return null
        val text = rawBody.replace(Regex("\\s+"), " ").trim()

        parseStandaloneFuliza(text, receivedAtMs)?.let { return it }

        if (!Regex("confirmed", RegexOption.IGNORE_CASE).containsMatchIn(text)) return null
        val codeMatch = CODE_RE.find(text) ?: return null
        val amountMatch = AMOUNT_RE.find(text) ?: return null
        val amount = num(amountMatch.groupValues[1]) ?: return null
        if (amount <= 0) return null

        // Fuliza repayment rides on the normal Confirmed/code wrapper (money
        // moving is what triggers it) but it's clearing a past debt, not a
        // new expense — checked before RULES so it can't be misread as a
        // spend or a plain receive.
        if (FULIZA_REPAYMENT_ANCHOR_RE.containsMatchIn(text)) {
            val repaid = num(FULIZA_REPAYMENT_RE.find(text)?.groupValues?.get(1)) ?: amount
            return MpesaTransaction(
                mpesaCode = codeMatch.groupValues[1],
                type = "fuliza_repayment",
                subtype = "fuliza_repayment",
                amount = repaid,
                counterparty = "Fuliza M-PESA",
                category = null,
                balance = num(BALANCE_RE.find(text)?.groupValues?.get(1)),
                receivedAt = receivedAtMs
            )
        }

        for (rule in RULES) {
            val counterparty = rule.match(text) ?: continue
            val fulizaAmount = if (rule.type == "spend") matchFulizaUsed(text) else null
            return MpesaTransaction(
                mpesaCode = codeMatch.groupValues[1],
                type = rule.type,
                subtype = rule.subtype,
                amount = amount,
                counterparty = counterparty,
                category = if (rule.type == "spend") guessCategory(counterparty, rule.subtype) else null,
                balance = num(BALANCE_RE.find(text)?.groupValues?.get(1)),
                receivedAt = receivedAtMs,
                viaFuliza = fulizaAmount != null,
                fulizaAmount = fulizaAmount
            )
        }
        return null
    }

    fun isMpesaSender(address: String?): Boolean {
        if (address.isNullOrBlank()) return false
        return MPESA_SENDER_IDS.contains(address.trim().uppercase())
    }
}
