// Gates the app behind the device's own biometric/PIN prompt, the same way
// M-Pesa and banking apps do -- the OS handles the actual authentication
// (fingerprint, face, or device PIN/pattern/password as fallback); this app
// never sees or stores a credential of its own. A no-op everywhere but a
// native build, same convention as native-bridge.js.
//
// DIAGNOSTIC BUILD: unlock() returns { ok, reason } instead of a plain
// boolean, and races the native call against a 15s timeout, so a hang or
// an unexpected error surfaces as visible text on the lock screen instead
// of silently looking "stuck". Once the real failure mode is known, this
// goes back to the simpler boolean version.

import { Capacitor, registerPlugin } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();

const NativeBiometric = registerPlugin('NativeBiometric');

export async function isLockAvailable() {
  if (!isNative()) return false;
  try {
    const result = await NativeBiometric.isAvailable({ useFallback: true });
    return !!(result && result.isAvailable);
  } catch {
    return false;
  }
}

function timeout(ms, reason) {
  return new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason }), ms));
}

// Returns { ok: true } on a real success, or { ok: false, reason } where
// reason is one of: 'timeout' (the native call never resolved at all --
// strong signal of a plugin/native incompatibility), or the actual
// error message/code the plugin rejected with (wrong credential, user
// cancelled, no biometric enrolled, etc).
export async function unlock() {
  if (!isNative()) return { ok: true };
  const attempt = NativeBiometric.verifyIdentity({
    reason: 'Unlock SaveLock',
    title: 'SaveLock',
    subtitle: 'Confirm it is you',
    description: 'Use your fingerprint, face, or device PIN to continue.',
    useFallback: true,
    maxAttempts: 5,
  })
    .then(() => ({ ok: true }))
    .catch((e) => ({
      ok: false,
      reason: (e && (e.message || e.errorMessage || e.code)) || JSON.stringify(e) || 'unknown error',
    }));
  return Promise.race([attempt, timeout(15000, 'timeout -- the prompt never responded')]);
}
