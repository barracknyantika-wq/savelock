package com.savelock.app

/**
 * Kotlin mirror of src/scripts/mpesa-parser.js — same rules, same priority
 * order, same conservative "return null rather than guess" stance. There is
 * no shared runtime between the web app and this native receiver, so keep
 * the two files in sync by hand if the SMS templates ever change.
 */
data class MpesaTransaction(
    val mpesaCode: String,
    val type: String, // "spend" | "received"
    val subtype: String,
    val amount: Double,
    val counterparty: String,
    val balance: Double?,
    val receivedAt: Long
)

object MpesaParser {
    val MPESA_SENDER_IDS = setOf("MPESA")

    private val CODE_RE = Regex("\\b([A-Z][A-Z0-9]{8,11})\\b\\s+Confirmed")
    private val AMOUNT_RE = Regex("Ksh\\s?([\\d,]+(?:\\.\\d{2})?)", RegexOption.IGNORE_CASE)
    private val BALANCE_RE =
        Regex("(?:new\\s+)?m-pesa balance is ksh\\s?([\\d,]+(?:\\.\\d{2})?)", RegexOption.IGNORE_CASE)

    private fun num(group: String?): Double? {
        if (group == null) return null
        return group.replace(",", "").toDoubleOrNull()
    }

    private fun clean(name: String): String =
        name.removeSuffix(".").replace(Regex("\\s+"), " ").trim()

    private data class Rule(val type: String, val subtype: String, val match: (String) -> String?)

    private val RULES = listOf(
        Rule("received", "receive") { body ->
            Regex("received\\s+ksh[\\d,.]+\\s+from\\s+(.+?)\\s+(?:0\\d{6,12}|\\d{9,12})\\s+on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "paybill") { body ->
            Regex("sent\\s+to\\s+(.+?)\\s+for account\\s+.+?\\s+on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "send") { body ->
            Regex("sent\\s+to\\s+(.+?)\\s+(?:0\\d{6,12}|\\d{9,12})\\s+on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "till") { body ->
            Regex("paid\\s+to\\s+(.+?)\\s+on\\s", RegexOption.IGNORE_CASE)
                .find(body)?.groupValues?.get(1)?.let(::clean)
        },
        Rule("spend", "withdraw") { body ->
            Regex("withdrawn\\s+ksh[\\d,.]+\\s+from\\s+(.+?)\\s+on\\s", RegexOption.IGNORE_CASE)
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

        if (!Regex("confirmed", RegexOption.IGNORE_CASE).containsMatchIn(text)) return null
        val codeMatch = CODE_RE.find(text) ?: return null
        val amountMatch = AMOUNT_RE.find(text) ?: return null
        val amount = num(amountMatch.groupValues[1]) ?: return null
        if (amount <= 0) return null

        for (rule in RULES) {
            val counterparty = rule.match(text) ?: continue
            return MpesaTransaction(
                mpesaCode = codeMatch.groupValues[1],
                type = rule.type,
                subtype = rule.subtype,
                amount = amount,
                counterparty = counterparty,
                balance = num(BALANCE_RE.find(text)?.groupValues?.get(1)),
                receivedAt = receivedAtMs
            )
        }
        return null
    }

    fun isMpesaSender(address: String?): Boolean {
        if (address.isNullOrBlank()) return false
        return MPESA_SENDER_IDS.contains(address.trim().uppercase())
    }
}
