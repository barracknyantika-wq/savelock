// Bridges the web store to the native Android SMS auto-detection shell.
// A no-op everywhere else (plain browser install, iOS) — SmsMpesa has no
// web implementation on purpose, since there is no web API this could ever
// call; every method here is guarded behind isNative() so the plain PWA
// build's behavior is completely unchanged.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { LocalNotifications, Weekday } from '@capacitor/local-notifications';

const SmsMpesa = registerPlugin('SmsMpesa');

export const isNative = () => Capacitor.isNativePlatform();

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

async function ensureLocalNotifPermission() {
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
  if (!(await ensureLocalNotifPermission())) return;

  const notifications = [];
  if (reminderMorningEnabled) {
    notifications.push({
      id: REMINDER_IDS.morning,
      title: 'SaveLock',
      body: "Good morning — check today's allowance before you spend.",
      schedule: { on: parseTime(store.settings.reminderMorningTime), repeats: true },
    });
  }
  if (reminderEveningEnabled) {
    notifications.push({
      id: REMINDER_IDS.evening,
      title: 'SaveLock',
      body: "Evening check-in — how did today's spending go?",
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
  if (!(await ensureLocalNotifPermission())) return;

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
          title: 'SaveLock — weekly summary',
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

  fixNativeLinks();
  drain(store);
  pushBudget(store);
  pushNotificationPrefs(store);
  syncReminders(store);
  syncWeeklySummary(store);
  checkReconciliation(store);

  window.addEventListener('savelock:persist', () => pushBudget(store));

  App.addListener('resume', () => {
    drain(store);
    pushBudget(store);
    syncWeeklySummary(store);
    checkReconciliation(store);
  }).catch(() => {});

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) drain(store);
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
    return await SmsMpesa.requestPermissions();
  } catch {
    return null;
  }
}

// "Deep SMS reconciliation" only — requests just the readSms alias,
// separately from the core sms/notifications permissions above, so opting
// into this never re-prompts for (or silently piggybacks on) those.
// checkSmsPermission() above already reports readSms's state too, since it
// asks for every declared alias's status in one call.
export async function requestReadSmsPermission() {
  if (!isNative()) return null;
  try {
    return await SmsMpesa.requestPermissions({ permissions: ['readSms'] });
  } catch {
    return null;
  }
}

// Reads M-Pesa messages already in the inbox since `sinceMs`, for comparing
// against what was actually logged. Requires readSms to already be granted;
// returns an empty list rather than throwing if it isn't (or anything else
// goes wrong), consistent with this bridge's "never break the app" stance.
export async function reconcileInbox(sinceMs) {
  if (!isNative()) return [];
  try {
    const { transactions } = await SmsMpesa.reconcileInbox({ sinceMs });
    return transactions || [];
  } catch {
    return [];
  }
}

// Runs the opt-in reconciliation check at most once per calendar day, on
// app open/resume. There's no true OS-level background scheduling here
// (that would need a foreground service or WorkManager) — this is a
// best-effort "checked the next time you open the app each day," not a
// guaranteed daily background job. Silently does nothing unless the user
// has both turned the feature on and already granted readSms.
export async function checkReconciliation(store) {
  if (!isNative() || !store.settings.deepReconciliationEnabled) return;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (store.lastReconciliationCheck === today) return;
  const perms = await checkSmsPermission();
  if (perms?.readSms !== 'granted') return;
  const sinceMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const transactions = await reconcileInbox(sinceMs);
  const missed = store.reconcileAgainstInbox(transactions);
  store.recordReconciliationCheck(missed);
}
