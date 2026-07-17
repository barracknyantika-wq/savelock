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

export function initNativeBridge(store) {
  if (!isNative()) return;

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
