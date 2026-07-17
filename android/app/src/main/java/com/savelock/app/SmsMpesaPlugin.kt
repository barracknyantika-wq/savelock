package com.savelock.app

import android.Manifest
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
 * Plugin class for the two declared aliases — no need to hand-write them.
 * Everything else here just moves state in and out of the SharedPreferences
 * that SmsReceiver (running independently, possibly with no WebView alive)
 * reads and writes.
 */
@CapacitorPlugin(
    name = "SmsMpesa",
    permissions = [
        Permission(strings = [Manifest.permission.RECEIVE_SMS], alias = "sms"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
    ]
)
class SmsMpesaPlugin : Plugin() {

    override fun load() {
        super.load()
        SmsReceiver.ensureChannel(context)
    }

    // Drains whatever the receiver queued (including while the app was
    // fully closed) so the store can merge it in exactly like a live one.
    @PluginMethod
    fun getPendingTransactions(call: PluginCall) {
        val arr = SmsReceiver.readAndClearPendingQueue(context)
        val ret = JSObject()
        ret.put("transactions", JSArray(arr.toString()))
        call.resolve(ret)
    }

    // Called after every store.persist() so the receiver can compute an
    // accurate "left today" / "over" figure without any JS runtime alive.
    @PluginMethod
    fun syncBudgetState(call: PluginCall) {
        val limit = call.getDouble("dailyLimit", 0.0) ?: 0.0
        val spentToday = call.getDouble("spentToday", 0.0) ?: 0.0
        val currency = call.getString("currency", "KSh") ?: "KSh"
        SmsReceiver.syncBudgetState(context, limit, spentToday, currency)
        call.resolve()
    }

    @PluginMethod
    fun setNotificationPrefs(call: PluginCall) {
        val notifySpend = call.getBoolean("notifySpend", true) ?: true
        val notifyReceived = call.getBoolean("notifyReceived", true) ?: true
        SmsReceiver.setNotificationPrefs(context, notifySpend, notifyReceived)
        call.resolve()
    }
}
