package com.savelock.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Declared in AndroidManifest.xml (not registered at runtime), so it keeps
 * receiving android.provider.Telephony.SMS_RECEIVED even when the app's
 * process isn't running — Android exempts this specific broadcast from the
 * background-execution limits that block most other implicit broadcasts.
 *
 * Everything here runs without any JS/WebView alive: parsing, dedup, the
 * pending queue, and the notification itself are all plain native code.
 * The JS store only sees these transactions later, when the app is opened
 * and drains PREFS_PENDING_QUEUE — see native-bridge.js.
 */
class SmsReceiver : BroadcastReceiver() {

    companion object {
        const val PREFS = "savelock_native"
        const val KEY_PENDING_QUEUE = "sms_pending_queue"
        const val KEY_PROCESSED_CODES = "sms_processed_codes"
        const val KEY_BUDGET_LIMIT = "budget_daily_limit"
        const val KEY_BUDGET_SPENT = "budget_spent_today"
        const val KEY_BUDGET_CURRENCY = "budget_currency"
        const val KEY_BUDGET_DAY = "budget_day"
        const val KEY_NOTIFY_SPEND = "notify_spend"
        const val KEY_NOTIFY_RECEIVED = "notify_received"
        const val KEY_NOTIFY_MODE = "notify_mode" // "always" | "importantOnly"
        const val CHANNEL_ID = "transactions"
        const val QUEUE_CAP = 200
        const val PROCESSED_CAP = 300

        private fun todayStr(): String =
            SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

        private fun prefs(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        /** Read by the Capacitor plugin bridge when JS drains on launch/resume. */
        fun readAndClearPendingQueue(context: Context): JSONArray {
            val sp = prefs(context)
            val raw = sp.getString(KEY_PENDING_QUEUE, "[]") ?: "[]"
            sp.edit().putString(KEY_PENDING_QUEUE, "[]").apply()
            return JSONArray(raw)
        }

        /** Called by the plugin bridge whenever the JS store persists. */
        fun syncBudgetState(context: Context, limit: Double, spentToday: Double, currency: String) {
            prefs(context).edit()
                .putFloat(KEY_BUDGET_LIMIT, limit.toFloat())
                .putFloat(KEY_BUDGET_SPENT, spentToday.toFloat())
                .putString(KEY_BUDGET_CURRENCY, currency)
                .putString(KEY_BUDGET_DAY, todayStr())
                .apply()
        }

        fun setNotificationPrefs(context: Context, notifySpend: Boolean, notifyReceived: Boolean, notifyMode: String) {
            prefs(context).edit()
                .putBoolean(KEY_NOTIFY_SPEND, notifySpend)
                .putBoolean(KEY_NOTIFY_RECEIVED, notifyReceived)
                .putString(KEY_NOTIFY_MODE, notifyMode)
                .apply()
        }

        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Transaction alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Instant confirmation when SaveLock detects an M-Pesa transaction."
            }
            nm.createNotificationChannel(channel)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) return

        val sender = messages[0].originatingAddress
        if (!MpesaParser.isMpesaSender(sender)) return // never touch non-M-Pesa SMS

        val body = messages.joinToString("") { it.messageBody ?: "" }
        val tx = MpesaParser.parse(body, System.currentTimeMillis()) ?: return

        val sp = prefs(context)
        val processed = JSONArray(sp.getString(KEY_PROCESSED_CODES, "[]") ?: "[]")
        for (i in 0 until processed.length()) {
            if (processed.getString(i) == tx.mpesaCode) return // already handled, no double notify
        }
        processed.put(tx.mpesaCode)
        val trimmedProcessed = trimJsonArray(processed, PROCESSED_CAP)
        sp.edit().putString(KEY_PROCESSED_CODES, trimmedProcessed.toString()).apply()

        val queue = JSONArray(sp.getString(KEY_PENDING_QUEUE, "[]") ?: "[]")
        queue.put(toJson(tx))
        val trimmedQueue = trimJsonArray(queue, QUEUE_CAP)
        sp.edit().putString(KEY_PENDING_QUEUE, trimmedQueue.toString()).apply()

        ensureChannel(context)
        if (tx.type == "spend") {
            handleSpendNotification(context, sp, tx)
        } else {
            handleReceivedNotification(context, sp, tx)
        }
    }

    private fun handleSpendNotification(context: Context, sp: SharedPreferences, tx: MpesaTransaction) {
        val currency = sp.getString(KEY_BUDGET_CURRENCY, "KSh") ?: "KSh"
        val limit = sp.getFloat(KEY_BUDGET_LIMIT, 0f).toDouble()
        val cachedDay = sp.getString(KEY_BUDGET_DAY, null)
        val cachedSpent = if (cachedDay == todayStr()) sp.getFloat(KEY_BUDGET_SPENT, 0f).toDouble() else 0.0
        val newSpent = cachedSpent + tx.amount

        // Cache-ahead so a second SMS arriving before the app reopens still
        // shows a correct running total; the JS store overwrites this with
        // its own authoritative figure the moment it next syncs.
        sp.edit()
            .putFloat(KEY_BUDGET_SPENT, newSpent.toFloat())
            .putString(KEY_BUDGET_DAY, todayStr())
            .apply()

        val hasLimit = limit > 0
        val remaining = limit - newSpent
        val overBudget = hasLimit && remaining < 0
        val text = if (!hasLimit) {
            "Logged $currency ${fmt(tx.amount)} to ${tx.counterparty}."
        } else if (!overBudget) {
            "Logged $currency ${fmt(tx.amount)} to ${tx.counterparty}. $currency ${fmt(remaining)} left today."
        } else {
            "$currency ${fmt(tx.amount)} logged. You're $currency ${fmt(-remaining)} over today's limit."
        }

        // "importantOnly" mode still logs every spend silently (already done
        // above) — it only skips the notification for in-budget spends.
        val mode = sp.getString(KEY_NOTIFY_MODE, "always") ?: "always"
        val shouldNotify = sp.getBoolean(KEY_NOTIFY_SPEND, true) && (mode != "importantOnly" || overBudget)
        if (shouldNotify) {
            notify(context, tx.mpesaCode, "SaveLock", text)
        }
    }

    private fun handleReceivedNotification(context: Context, sp: SharedPreferences, tx: MpesaTransaction) {
        if (!sp.getBoolean(KEY_NOTIFY_RECEIVED, true)) return
        val currency = sp.getString(KEY_BUDGET_CURRENCY, "KSh") ?: "KSh"
        val text = "Received $currency ${fmt(tx.amount)} from ${tx.counterparty} — not counted as spending."
        notify(context, tx.mpesaCode, "SaveLock", text)
    }

    private fun notify(context: Context, mpesaCode: String, title: String, text: String) {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ) {
            return // user hasn't granted notification permission; the pending queue still holds the transaction
        }
        val openApp = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent(context, MainActivity::class.java)
        openApp.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        val pendingIntent = PendingIntent.getActivity(
            context,
            mpesaCode.hashCode(),
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_savelock)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(context).notify(mpesaCode.hashCode(), notification)
    }

    private fun toJson(tx: MpesaTransaction): JSONObject = JSONObject().apply {
        put("mpesaCode", tx.mpesaCode)
        put("type", tx.type)
        put("subtype", tx.subtype)
        put("amount", tx.amount)
        put("counterparty", tx.counterparty)
        put("category", tx.category ?: JSONObject.NULL)
        put("balance", tx.balance ?: JSONObject.NULL)
        put("receivedAt", tx.receivedAt)
    }

    private fun trimJsonArray(arr: JSONArray, cap: Int): JSONArray {
        if (arr.length() <= cap) return arr
        val trimmed = JSONArray()
        for (i in (arr.length() - cap) until arr.length()) trimmed.put(arr.get(i))
        return trimmed
    }

    private fun fmt(n: Double): String {
        val rounded = Math.round(n * 100) / 100.0
        return if (rounded == rounded.toLong().toDouble()) {
            String.format(Locale.US, "%,d", rounded.toLong())
        } else {
            String.format(Locale.US, "%,.2f", rounded)
        }
    }
}
