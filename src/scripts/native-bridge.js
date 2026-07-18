// Bridges the web store to the native Android SMS auto-detection shell.
// A no-op everywhere else (plain browser install, iOS) — SmsMpesa has no
// web implementation on purpose, since there is no web API this could ever
// call; every method here is guarded behind isNative() so the plain PWA
// build's behavior is completely unchanged.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';

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
  }).catch(() => {});
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

  window.addEventListener('savelock:persist', () => pushBudget(store));

  App.addListener('resume', () => {
    drain(store);
    pushBudget(store);
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
