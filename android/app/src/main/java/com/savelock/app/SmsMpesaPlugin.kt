package com.savelock.app

import android.Manifest
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

/**
 * Bridge between the web app and the native SMS auto-detection.
 *
 * checkPermissions/requestPermissions are inherited from Capacitor's base
 * Plugin class for the declared aliases — no need to hand-write them; a JS
 * call can target one alias specifically by passing e.g.
 * { permissions: ['readSms'] }, without re-prompting for the others.
 * Everything else here just moves state in and out of the SharedPreferences
 * that SmsReceiver (running independently, possibly with no WebView alive)
 * reads and writes.
 *
 * Every method here catches its own exceptions and calls call.reject()
 * rather than letting anything propagate — the app opening/resuming must
 * never depend on one of these calls succeeding.
 */
@CapacitorPlugin(
    name = "SmsMpesa",
    permissions = [
        Permission(strings = [Manifest.permission.RECEIVE_SMS], alias = "sms"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
        // Separate from "sms" above deliberately: this is only requested if
        // the user explicitly opts into "Deep SMS reconciliation" in
        // Settings, never as part of the core auto-detect flow.
        Permission(strings = [Manifest.permission.READ_SMS], alias = "readSms"),
    ]
)
class SmsMpesaPlugin : Plugin() {
    companion object {
        private const val TAG = "SaveLockSms"
    }

    override fun load() {
        super.load()
        SmsReceiver.ensureChannel(context)
    }

    // Drains whatever the receiver queued (including while the app was
    // fully closed) so the store can merge it in exactly like a live one.
    @PluginMethod
    fun getPendingTransactions(call: PluginCall) {
        try {
            val arr = SmsReceiver.readAndClearPendingQueue(context)
            val ret = JSObject()
            ret.put("transactions", JSArray(arr.toString()))
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "getPendingTransactions failed", e)
            call.reject("getPendingTransactions failed: ${e.message}", e)
        }
    }

    // Called after every store.persist() so the receiver can compute an
    // accurate "left today" / "over" figure without any JS runtime alive.
    @PluginMethod
    fun syncBudgetState(call: PluginCall) {
        try {
            val limit = call.getDouble("dailyLimit", 0.0) ?: 0.0
            val spentToday = call.getDouble("spentToday", 0.0) ?: 0.0
            val currency = call.getString("currency", "KSh") ?: "KSh"
            SmsReceiver.syncBudgetState(context, limit, spentToday, currency)
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "syncBudgetState failed", e)
            call.reject("syncBudgetState failed: ${e.message}", e)
        }
    }

    @PluginMethod
    fun setNotificationPrefs(call: PluginCall) {
        try {
            val notifySpend = call.getBoolean("notifySpend", true) ?: true
            val notifyReceived = call.getBoolean("notifyReceived", true) ?: true
            val notifyMode = call.getString("notifyMode", "always") ?: "always"
            SmsReceiver.setNotificationPrefs(context, notifySpend, notifyReceived, notifyMode)
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "setNotificationPrefs failed", e)
            call.reject("setNotificationPrefs failed: ${e.message}", e)
        }
    }

    // Opt-in "Deep SMS reconciliation" only. Reads M-Pesa messages from the
    // inbox since `sinceMs` so the JS store can compare them against what
    // was actually logged and flag anything the always-on auto-detect
    // above might have missed. Requires the separately-granted "readSms"
    // permission — rejects cleanly (no crash, no partial read) if it
    // isn't granted rather than assuming it is.
    @PluginMethod
    fun reconcileInbox(call: PluginCall) {
        try {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                call.reject("READ_SMS permission not granted")
                return
            }
            val sinceMs = call.getLong("sinceMs") ?: (System.currentTimeMillis() - 24L * 60 * 60 * 1000)
            val arr = SmsReceiver.reconcileInbox(context, sinceMs)
            val ret = JSObject()
            ret.put("transactions", JSArray(arr.toString()))
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "reconcileInbox failed", e)
            call.reject("reconcileInbox failed: ${e.message}", e)
        }
    }
}
