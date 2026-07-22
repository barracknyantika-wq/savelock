package com.savelock.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONException
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
 *
 * onReceive() runs on the app's main thread as a system-invoked component —
 * an uncaught exception here doesn't just fail this one message, it crashes
 * the entire app process (standard Android component behavior, not specific
 * to this receiver), and since the same stored state is read again on every
 * future launch (via SmsMpesaPlugin.getPendingTransactions -> drain()), a
 * persistently-bad stored value would crash every subsequent launch attempt
 * too. So every read of previously-stored state, and the method as a whole,
 * is deliberately defensive: log and continue, never let an exception escape.
 */
class SmsReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "SaveLockSms"
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

        // Previously-stored state is parsed defensively: if it's ever not
        // valid JSON (a corrupted write, an odd backup/restore onto a
        // different schema, or any other edge case), this must never crash
        // the caller — fall back to an empty array and log it, so the next
        // write starts clean instead of failing forever on the same bad value.
        private fun readJsonArray(sp: SharedPreferences, key: String): JSONArray {
            val raw = sp.getString(key, "[]") ?: "[]"
            return try {
                JSONArray(raw)
            } catch (e: JSONException) {
                Log.e(TAG, "Stored value for $key was not valid JSON, resetting to empty", e)
                sp.edit().putString(key, "[]").apply()
                JSONArray()
            }
        }

        /** Read by the Capacitor plugin bridge when JS drains on launch/resume. */
        fun readAndClearPendingQueue(context: Context): JSONArray {
            return try {
                val sp = prefs(context)
                val arr = readJsonArray(sp, KEY_PENDING_QUEUE)
                sp.edit().putString(KEY_PENDING_QUEUE, "[]").apply()
                arr
            } catch (e: Exception) {
                // Whatever went wrong, an empty queue is always a safe
                // fallback — the app opening must never depend on this
                // succeeding.
                Log.e(TAG, "readAndClearPendingQueue failed, returning empty", e)
                JSONArray()
            }
        }

        /** Called by the plugin bridge whenever the JS store persists. */
        fun syncBudgetState(context: Context, limit: Double, spentToday: Double, currency: String) {
            try {
                prefs(context).edit()
                    .putFloat(KEY_BUDGET_LIMIT, limit.toFloat())
                    .putFloat(KEY_BUDGET_SPENT, spentToday.toFloat())
                    .putString(KEY_BUDGET_CURRENCY, currency)
                    .putString(KEY_BUDGET_DAY, todayStr())
                    .apply()
            } catch (e: Exception) {
                Log.e(TAG, "syncBudgetState failed", e)
            }
        }

        fun setNotificationPrefs(context: Context, notifySpend: Boolean, notifyReceived: Boolean, notifyMode: String) {
            try {
                prefs(context).edit()
                    .putBoolean(KEY_NOTIFY_SPEND, notifySpend)
                    .putBoolean(KEY_NOTIFY_RECEIVED, notifyReceived)
                    .putString(KEY_NOTIFY_MODE, notifyMode)
                    .apply()
            } catch (e: Exception) {
                Log.e(TAG, "setNotificationPrefs failed", e)
            }
        }

        fun ensureChannel(context: Context) {
            try {
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
            } catch (e: Exception) {
                Log.e(TAG, "ensureChannel failed", e)
            }
        }

        fun toJson(tx: MpesaTransaction): JSONObject = JSONObject().apply {
            put("mpesaCode", tx.mpesaCode)
            put("type", tx.type)
            put("subtype", tx.subtype)
            put("amount", tx.amount)
            put("counterparty", tx.counterparty)
            put("category", tx.category ?: JSONObject.NULL)
            put("balance", tx.balance ?: JSONObject.NULL)
            put("receivedAt", tx.receivedAt)
            put("viaFuliza", tx.viaFuliza)
            put("fulizaAmount", tx.fulizaAmount ?: JSONObject.NULL)
        }

        // Opt-in "Deep SMS reconciliation" only — reads M-Pesa messages
        // already sitting in the inbox since `sinceMs`, so the JS side can
        // compare them against what was actually logged. Requires READ_SMS;
        // callers must have already confirmed that's granted (via the
        // plugin's normal permission flow) before calling this. Never
        // throws: any failure just means an empty result, same "log and
        // continue" stance as the rest of this file.
        fun reconcileInbox(context: Context, sinceMs: Long): JSONArray {
            val results = JSONArray()
            try {
                val cursor = context.contentResolver.query(
                    Telephony.Sms.CONTENT_URI,
                    arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
                    "${Telephony.Sms.DATE} >= ?",
                    arrayOf(sinceMs.toString()),
                    "${Telephony.Sms.DATE} ASC"
                )
                cursor?.use { c ->
                    val addressIdx = c.getColumnIndex(Telephony.Sms.ADDRESS)
                    val bodyIdx = c.getColumnIndex(Telephony.Sms.BODY)
                    val dateIdx = c.getColumnIndex(Telephony.Sms.DATE)
                    if (addressIdx < 0 || bodyIdx < 0 || dateIdx < 0) {
                        Log.e(TAG, "SMS content provider missing expected columns")
                        return@use
                    }
                    while (c.moveToNext()) {
                        val address = c.getString(addressIdx)
                        if (!MpesaParser.isMpesaSender(address)) continue
                        val body = c.getString(bodyIdx) ?: continue
                        val date = c.getLong(dateIdx)
                        val tx = MpesaParser.parse(body, date) ?: continue
                        results.put(toJson(tx))
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "reconcileInbox failed", e)
            }
            return results
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Nothing below this line may ever throw uncaught: onReceive() is
        // invoked directly by the OS, main thread, no surrounding framework
        // try/catch — an exception here kills the whole app process, not
        // just this one message.
        try {
            handleReceive(context, intent)
        } catch (e: Exception) {
            Log.e(TAG, "onReceive failed, message dropped without crashing", e)
        }
    }

    private fun handleReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) {
            Log.w(TAG, "SMS_RECEIVED broadcast carried no messages")
            return
        }

        val sender = messages[0].originatingAddress
        if (!MpesaParser.isMpesaSender(sender)) {
            Log.d(TAG, "Ignoring SMS from non-M-Pesa sender")
            return // never touch non-M-Pesa SMS
        }

        val body = messages.joinToString("") { it.messageBody ?: "" }
        val tx = MpesaParser.parse(body, System.currentTimeMillis())
        if (tx == null) {
            // Deliberately conservative parser: an unrecognized format is
            // silently dropped by design (a wrong auto-log is worse than a
            // missed one) — but "silently" should only mean "not logged as
            // a transaction," not "invisible for diagnosis." Log length only,
            // never the message body itself (may contain personal details).
            Log.w(TAG, "M-Pesa SMS received but did not match any known format (length=${body.length})")
            return
        }
        Log.d(TAG, "Parsed M-Pesa SMS: type=${tx.type} subtype=${tx.subtype} code=${tx.mpesaCode}")

        val sp = prefs(context)
        val processed = readJsonArray(sp, KEY_PROCESSED_CODES)
        for (i in 0 until processed.length()) {
            if (processed.optString(i) == tx.mpesaCode) {
                Log.d(TAG, "Duplicate mpesaCode ${tx.mpesaCode}, already processed")
                return // already handled, no double notify
            }
        }
        processed.put(tx.mpesaCode)
        val trimmedProcessed = trimJsonArray(processed, PROCESSED_CAP)
        sp.edit().putString(KEY_PROCESSED_CODES, trimmedProcessed.toString()).apply()

        val queue = readJsonArray(sp, KEY_PENDING_QUEUE)
        queue.put(toJson(tx))
        val trimmedQueue = trimJsonArray(queue, QUEUE_CAP)
        sp.edit().putString(KEY_PENDING_QUEUE, trimmedQueue.toString()).apply()

        ensureChannel(context)
        try {
            when (tx.type) {
                "spend" -> handleSpendNotification(context, sp, tx)
                "fuliza_repayment", "fuliza_activation", "fuliza_interest" -> handleFulizaEventNotification(context, sp, tx)
                else -> handleReceivedNotification(context, sp, tx)
            }
        } catch (e: Exception) {
            // The transaction is already queued above regardless of whether
            // the notification succeeds — a notification failure must never
            // undo that.
            Log.e(TAG, "Notification step failed after successful queueing", e)
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

    // Fuliza clearing/servicing a past debt, not a new expense — informational
    // only, gated on the same "notify on non-spend events" preference.
    private fun handleFulizaEventNotification(context: Context, sp: SharedPreferences, tx: MpesaTransaction) {
        if (!sp.getBoolean(KEY_NOTIFY_RECEIVED, true)) return
        val currency = sp.getString(KEY_BUDGET_CURRENCY, "KSh") ?: "KSh"
        val text = when (tx.type) {
            "fuliza_repayment" -> "$currency ${fmt(tx.amount)} used to repay Fuliza M-PESA — not counted as new spending."
            "fuliza_activation" -> "Fuliza M-PESA activated. Limit: $currency ${fmt(tx.amount)}."
            else -> "Fuliza M-PESA fee of $currency ${fmt(tx.amount)} charged — not counted as new spending."
        }
        notify(context, tx.mpesaCode, "SaveLock", text)
    }

    private fun notify(context: Context, mpesaCode: String, title: String, text: String) {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        ) {
            Log.w(TAG, "Notification permission not granted, skipping notification (transaction is still queued)")
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
