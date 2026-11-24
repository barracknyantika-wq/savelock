// Bridges the web store to the native Android SMS auto-detection shell.
// A no-op everywhere else (plain browser install, iOS) — SmsMpesa has no
// web implementation on purpose, since there is no web API this could ever
// call; every method here is guarded behind isNative() so the plain PWA
// build's behavior is completely unchanged.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications, Weekday } from '@capacitor/local-notifications';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

const SmsMpesa = registerPlugin('SmsMpesa');
let activeStore = null;
let reconcilePromise = null;

export const isNative = () => Capacitor.isNativePlatform();

function notifyPermissionState(state) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('savelock:permission-state', { detail: state }));
  }
}

// ---- haptics --------------------------------------------------------------
// A no-op everywhere but a native build, same convention as every other
// bridge function here. Three tiers, not one blanket vibrate: a light tap
// for routine actions (logging a spend), a notification-success pulse for
// milestone-style moments, and a stronger two-part pulse reserved for a
// real M-Pesa deposit actually clearing — that's a bigger moment than a UI
// update, and it should feel like one.

export async function hapticTap() {
  if (!isNative()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* no haptics hardware, or the plugin isn't ready — never block on this */
  }
}

export async function hapticSuccess() {
  if (!isNative()) return;
  try {
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    /* see hapticTap */
  }
}

export async function hapticCelebrate() {
  if (!isNative()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Heavy });
    setTimeout(() => {
      Haptics.notification({ type: NotificationType.Success }).catch(() => {});
    }, 90);
  } catch {
    /* see hapticTap */
  }
}

function pushBudget(store) {
  if (!isNative()) return;
  SmsMpesa.syncBudgetState({
    dailyLimit: store.settings.dailyLimit,
    spentToday: store.spentToday,
    currency: store.settings.currency,
  }).catch(() => {});
}

export function pushNotificationPrefs(store) {
  if (!isNative()) return;
  SmsMpesa.setNotificationPrefs({
    notifySpend: store.settings.smsNotifySpend,
    notifyReceived: store.settings.smsNotifyReceived,
    notifyMode: store.settings.smsNotifyMode,
  }).catch(() => {});
}

// ---- scheduled local notifications (morning/evening/weekly) -------------
//
// These use @capacitor/local-notifications' own device-side scheduler —
// no custom native code needed, unlike the instant SMS-triggered ones. Their
// content can only be as fresh as the last time this function ran, since
// there's no server push here: a weekly summary scheduled today keeps
// firing with today's numbers until the app next opens and reschedules it.

const REMINDER_IDS = { morning: 1001, evening: 1002, weekly: 1003 };

function parseTime(hhmm) {
  const [h, m] = (hhmm || '08:00').split(':').map(Number);
  return { hour: Number.isFinite(h) ? h : 8, minute: Number.isFinite(m) ? m : 0 };
}

// Exported (this used to be an internal helper only reached as a side
// effect of scheduling a reminder, both call sites below already guarded
// by isNative()) so the onboarding tour can trigger this exact same prompt
// directly, at the moment it explains reminders, rather than only ever
// firing later as a side effect of someone first turning a reminder on in
// Settings. Guards itself now that it's reachable from outside this file —
// @capacitor/local-notifications ships a real web fallback that would
// otherwise ask a plain browser sign in for a permission this app has no
// native shell to ever act on.
export async function requestNotificationPermission() {
  if (!isNative()) return false;
  try {
    const state = await LocalNotifications.checkPermissions();
    if (state.display === 'granted') return true;
    const req = await LocalNotifications.requestPermissions();
    return req.display === 'granted';
  } catch {
    return false;
  }
}

// Reschedules the daily morning/evening reminders from current settings.
// Cancels first so toggling off, or changing a time, never leaves a stale
// duplicate behind — safe to call any time these settings change.
export async function syncReminders(store) {
  if (!isNative()) return;
  try {
    await LocalNotifications.cancel({
      notifications: [{ id: REMINDER_IDS.morning }, { id: REMINDER_IDS.evening }],
    });
  } catch {
    /* nothing was scheduled yet */
  }
  const { reminderMorningEnabled, reminderEveningEnabled } = store.settings;
  if (!reminderMorningEnabled && !reminderEveningEnabled) return;
  if (!(await requestNotificationPermission())) return;

  const notifications = [];
  if (reminderMorningEnabled) {
    notifications.push({
      id: REMINDER_IDS.morning,
      title: 'SaveLock',
      body: "Good morning. Check today's allowance before you spend.",
      schedule: { on: parseTime(store.settings.reminderMorningTime), repeats: true },
    });
  }
  if (reminderEveningEnabled) {
    notifications.push({
      id: REMINDER_IDS.evening,
      title: 'SaveLock',
      body: "Evening check-in: how did today's spending go?",
      schedule: { on: parseTime(store.settings.reminderEveningTime), repeats: true },
    });
  }
  if (notifications.length) {
    try {
      await LocalNotifications.schedule({ notifications });
    } catch {
      /* scheduling failed silently — nothing user-actionable to do here */
    }
  }
}

// Reschedules the Sunday-evening weekly summary with content computed right
// now (spend total, days under budget, active-goal progress). Re-synced on
// every app open/resume so it stays as fresh as possible given the
// no-server-push constraint above.
export async function syncWeeklySummary(store) {
  if (!isNative()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: REMINDER_IDS.weekly }] });
  } catch {
    /* nothing was scheduled yet */
  }
  if (!store.settings.weeklySummaryEnabled) return;
  if (!(await requestNotificationPermission())) return;

  const spentThisWeek = store.categoryBreakdown(7).reduce((s, c) => s + c.total, 0);
  const daysUnderBudget = store.last7.filter((d) => d.limit > 0 && d.spent <= d.limit).length;
  const goalLines = store.activeGoals
    .slice(0, 2)
    .map((g) => `${g.name} ${Math.round(store.progress(g) * 100)}%`)
    .join(', ');
  const body = [`${store.money(spentThisWeek)} spent this week`, `${daysUnderBudget}/7 days under budget`, goalLines || null]
    .filter(Boolean)
    .join(' · ');

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: REMINDER_IDS.weekly,
          title: 'SaveLock weekly summary',
          body,
          schedule: { on: { weekday: Weekday.Sunday, hour: 19, minute: 0 }, repeats: true },
        },
      ],
    });
  } catch {
    /* scheduling failed silently — nothing user-actionable to do here */
  }
}

async function drain(store) {
  if (!isNative()) return;
  try {
    const { transactions } = await SmsMpesa.getPendingTransactions();
    if (transactions?.length) store.drainNativeTransactions(transactions);
  } catch {
    // permission not granted yet, or plugin not ready — nothing to drain
  }
}

// Capacitor's bundled Android WebView server has no directory-index
// resolution: a request to an extensionless path like /goals/ either falls
// back to serving the root index.html (html5mode on, the old default here —
// which silently showed Today again on every Goals/Settings tap) or gets no
// response at all (html5mode off, our capacitor.config.json setting, with
// nothing else changed). Either way, extensionless internal links never
// reach the real page in the native shell — only requests with a file
// extension do. So every same-origin link starting and ending with "/" gets
// rewritten to point at its real index.html, but only inside the native
// shell; the plain PWA/web build (and its offline service-worker cache,
// which is keyed by the pretty "/goals/"-style URL) is untouched.
export function fixNativeLinks(root = document) {
  if (!isNative()) return;
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href && href.startsWith('/') && href.endsWith('/')) {
      a.setAttribute('href', href + 'index.html');
    }
  });
}

// Same underlying reason as fixNativeLinks: reloading the current page only
// reaches the right content in the native shell if the reload target has a
// file extension (otherwise it's the html5mode failure mode all over again,
// this time on whatever non-root page called this).
export function nativeReload() {
  if (isNative() && location.pathname.endsWith('/')) {
    location.href = location.pathname + 'index.html' + location.search;
  } else {
    location.reload();
  }
}

export function initNativeBridge(store) {
  if (!isNative()) return;

  activeStore = store;
  fixNativeLinks();
  drain(store);
  refreshPermissionState();
  pushBudget(store);
  pushNotificationPrefs(store);
  syncReminders(store);
  syncWeeklySummary(store);
  runSmsReconcile().catch(() => {});

  window.addEventListener('savelock:persist', () => pushBudget(store));

  App.addListener('resume', () => {
    drain(store);
    refreshPermissionState();
    pushBudget(store);
    syncWeeklySummary(store);
    runSmsReconcile().catch(() => {});
  }).catch(() => {});

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      drain(store);
      refreshPermissionState();
      runSmsReconcile().catch(() => {});
    }
  });
}

// { sms: 'granted'|'denied'|'prompt', notifications: 'granted'|'denied'|'prompt' }
export async function checkSmsPermission() {
  if (!isNative()) return null;
  try {
    return await SmsMpesa.checkPermissions();
  } catch {
    return null;
  }
}

export async function requestSmsPermission() {
  if (!isNative()) return null;
  try {
    await SmsMpesa.markPermissionRequest({ permission: 'sms' });
    const result = await SmsMpesa.requestPermissions({ permissions: ['sms'] });
    await refreshPermissionState();
    if (result?.sms === 'granted') await runSmsReconcile();
    return result;
  } catch {
    return null;
  }
}

// Inbox history access is requested separately from live RECEIVE_SMS access
// so the welcome tour can explain the purpose before showing its prompt.
export async function requestReadSmsPermission() {
  if (!isNative()) return null;
  try {
    await SmsMpesa.markPermissionRequest({ permission: 'readSms' });
    const result = await SmsMpesa.requestPermissions({ permissions: ['readSms'] });
    await refreshPermissionState();
    if (result?.readSms === 'granted') await runSmsReconcile();
    return result;
  } catch {
    return null;
  }
}

export async function checkAppPermissionState() {
  if (!isNative()) return null;
  const [sms, notifications] = await Promise.all([
    SmsMpesa.getSmsPermissionState(),
    LocalNotifications.checkPermissions(),
  ]);
  return { ...sms, notifications: notifications.display };
}

export async function refreshPermissionState() {
  if (!isNative()) return null;
  try {
    const state = await checkAppPermissionState();
    notifyPermissionState(state);
    return state;
  } catch (error) {
    console.error('Could not check SaveLock permissions:', error);
    return null;
  }
}

export async function openAppInfo() {
  if (!isNative()) return;
  try {
    await SmsMpesa.openAppInfo();
  } catch (error) {
    console.error('Could not open SaveLock app settings:', error);
    throw error;
  }
}

export async function getAppInstallInfo() {
  if (!isNative()) return null;
  return SmsMpesa.getAppInstallInfo();
}

function startOfTodayNairobi() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Date.parse(`${values.year}-${values.month}-${values.day}T00:00:00+03:00`);
}

async function runSmsReconcile() {
  if (!isNative() || !activeStore) return null;
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = (async () => {
    const permissions = await checkAppPermissionState();
    if (permissions?.readSms !== 'granted') {
      LogReconcile('Inbox scan skipped: READ_SMS permission is not granted.');
      return null;
    }
    const sinceMs = Number(activeStore.smsReconcile?.lastSuccessfulAt) || startOfTodayNairobi();
    LogReconcile(`Inbox scan requested since ${new Date(sinceMs).toISOString()}.`);
    const result = await SmsMpesa.reconcileInbox({ sinceMs });
    let added = 0;
    for (const transaction of result.transactions || []) {
      const identity = transaction.smsContentHash
        ? [transaction.smsContentHash, transaction.smsId ? `${transaction.smsId}:${transaction.smsContentHash}` : null].filter(Boolean)
        : [];
      const alreadyRecorded = identity.length
        ? identity.some((value) => activeStore.processedSmsIdentities?.includes(value))
        : activeStore.processedMpesaCodes?.includes(transaction.mpesaCode);
      activeStore.recordNativeTransaction(transaction);
      if (!alreadyRecorded) added++;
    }
    activeStore.smsReconcile = {
      lastSuccessfulAt: Number(result.completedAt) || Date.now(),
      found: Number(result.found) || 0,
      added,
      skipped: Math.max(0, (Number(result.found) || 0) - added),
    };
    activeStore.persist();
    LogReconcile(`Inbox scan finished: found=${activeStore.smsReconcile.found} added=${added} skipped=${activeStore.smsReconcile.skipped}.`);
    return activeStore.smsReconcile;
  })().catch((error) => {
    LogReconcile('Inbox scan failed; the prior successful scan timestamp was retained.', error);
    throw error;
  }).finally(() => {
    reconcilePromise = null;
  });
  return reconcilePromise;
}

function LogReconcile(message, error = null) {
  if (error) console.error(message, error);
  else console.info(message);
}

// Reads SMS since the last successful scan. The native side persists the
// watermark and message fingerprints so Android broadcasts and inbox rows
// share the same deduplication boundary.
export async function reconcileInbox(sinceMs) {
  if (!isNative()) return { transactions: [], found: 0, added: 0, skipped: 0, completedAt: Date.now() };
  return SmsMpesa.reconcileInbox({ sinceMs });
}

export async function scanSmsInbox() {
  return runSmsReconcile();
}
