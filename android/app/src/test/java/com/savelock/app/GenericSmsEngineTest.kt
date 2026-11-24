package com.savelock.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class GenericSmsEngineTest {
    @Test
    fun smsContentHashIsStableAndIncludesMessageTimestamp() {
        val first = SmsReceiver.contentHash("EQUITY-BANK", "KES 500 has been credited to your account", 100L)
        val normalizedSender = SmsReceiver.contentHash("equity bank", "KES 500 has been credited to your account", 100L)
        val laterMessage = SmsReceiver.contentHash("EQUITY-BANK", "KES 500 has been credited to your account", 101L)

        assertEquals(first, normalizedSender)
        assertNotEquals(first, laterMessage)
    }

    @Test
    fun parsesSharedClassifierFixtures() {
        val stream = javaClass.classLoader!!.getResourceAsStream("generic-sms-cases.json")
        assertNotNull("shared SMS fixture file must be on the test classpath", stream)
        val json = stream!!.bufferedReader().use { it.readText() }
        val cases = Regex("""\{[^}]*}""").findAll(json)

        for (case in cases) {
            val row = case.value
            fun field(name: String) = Regex("\"$name\"\\s*:\\s*\"([^\"]*)\"").find(row)!!.groupValues[1]
            val sender = field("sender")
            val body = field("body")
            val expectedType = field("type")
            val expectedAmount = Regex("\"amount\"\\s*:\\s*([0-9.]+)").find(row)!!.groupValues[1].toDouble()
            val transaction = GenericSmsEngine.parse(body, sender, 1)

            assertNotNull(field("name"), transaction)
            assertEquals(field("name"), expectedType, transaction!!.type)
            assertEquals(field("name"), expectedAmount, transaction.amount, 0.001)
            val expectedNotification = when (expectedType) {
                "spend" -> "spend"
                "received" -> "received"
                else -> null
            }
            assertEquals(field("name"), expectedNotification, SmsReceiver.notificationKind(transaction.type))
        }
    }

    @Test
    fun rejectsLooseReceivedKeyword() {
        assertEquals(null, GenericSmsEngine.parse("Your account has received KES 500.", "EQUITYBANK", 1))
    }
}
