package com.savelock.app

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.content.pm.PackageManager
import android.os.Build
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
        // Separate alias so the inbox history permission can be explained
        // and requested at its own onboarding step.
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

    // Reads inbox messages since `sinceMs`, classifies financial SMS locally,
    // and returns only new fingerprints. Requires the separately granted
    // READ_SMS permission and rejects the whole scan if the provider fails.
    @PluginMethod
    fun reconcileInbox(call: PluginCall) {
        try {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                call.reject("READ_SMS permission not granted")
                return
            }
            val sinceMs = call.getLong("sinceMs") ?: 0L
            val result = SmsReceiver.reconcileInbox(context, sinceMs)
            val ret = JSObject()
            ret.put("transactions", JSArray(result.transactions.toString()))
            ret.put("found", result.found)
            ret.put("added", result.added)
            ret.put("skipped", result.skipped)
            ret.put("sinceMs", result.sinceMs)
            ret.put("completedAt", result.completedAt)
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "reconcileInbox failed", e)
            call.reject("reconcileInbox failed: ${e.message}", e)
        }
    }

    @PluginMethod
    fun getReconcileState(call: PluginCall) {
        try {
            val ret = JSObject()
            ret.put("lastSuccessfulAt", SmsReceiver.lastReconcileTime(context))
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "getReconcileState failed", e)
            call.reject("getReconcileState failed: ${e.message}", e)
        }
    }

    @PluginMethod
    fun getAppInstallInfo(call: PluginCall) {
        try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            val ret = JSObject()
            ret.put("lastUpdateTime", info.lastUpdateTime)
            ret.put("firstInstallTime", info.firstInstallTime)
            ret.put("versionName", info.versionName ?: "")
            ret.put("versionCode", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong())
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "getAppInstallInfo failed", e)
            call.reject("getAppInstallInfo failed: ${e.message}", e)
        }
    }

    @PluginMethod
    fun markPermissionRequest(call: PluginCall) {
        try {
            val alias = call.getString("permission") ?: ""
            val permission = when (alias) {
                "readSms" -> Manifest.permission.READ_SMS
                "sms" -> Manifest.permission.RECEIVE_SMS
                else -> {
                    call.reject("Unsupported permission alias")
                    return
                }
            }
            context.getSharedPreferences(SmsReceiver.PREFS, android.content.Context.MODE_PRIVATE)
                .edit().putBoolean("permission_requested_$permission", true).apply()
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "markPermissionRequest failed", e)
            call.reject("markPermissionRequest failed: ${e.message}", e)
        }
    }

    @PluginMethod
    fun getSmsPermissionState(call: PluginCall) {
        try {
            val ret = JSObject()
            putPermissionState(ret, "sms", Manifest.permission.RECEIVE_SMS)
            putPermissionState(ret, "readSms", Manifest.permission.READ_SMS)
            call.resolve(ret)
        } catch (e: Exception) {
            Log.e(TAG, "getSmsPermissionState failed", e)
            call.reject("getSmsPermissionState failed: ${e.message}", e)
        }
    }

    private fun putPermissionState(result: JSObject, alias: String, permission: String) {
        val granted = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        val requested = context.getSharedPreferences(SmsReceiver.PREFS, android.content.Context.MODE_PRIVATE)
            .getBoolean("permission_requested_$permission", false)
        val canShowPrompt = activity?.shouldShowRequestPermissionRationale(permission) ?: false
        result.put(alias, if (granted) "granted" else if (!requested) "prompt" else if (!canShowPrompt) "settings" else "denied")
        result.put("${alias}Granted", granted)
        result.put("${alias}RequiresSettings", !granted && requested && !canShowPrompt)
    }

    @PluginMethod
    fun openAppInfo(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "openAppInfo failed", e)
            call.reject("openAppInfo failed: ${e.message}", e)
        }
    }
}
