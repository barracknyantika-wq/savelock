// Gates the app behind the device's own biometric/PIN prompt, the same way
// M-Pesa and banking apps do — the OS handles the actual authentication
// (fingerprint, face, or device PIN/pattern/password as fallback); this app
// never sees or stores a credential of its own. A no-op everywhere but a
// native build, same convention as native-bridge.js: there is no meaningful
// "lock" concept for the plain web/PWA build, so isNative() gates every
// function here exactly like it does there.
//
// Deliberately fail-closed on any ambiguous outcome: if the plugin errors
// for a reason other than "the device has no biometric/PIN capability at
// all", the app stays locked rather than risk waving someone through. The
// one designed way out of a stuck lock is Settings -> Erase all data
// (store.eraseAll(), already existed before this feature) — there is no
// bypass that keeps the data and skips the prompt, because that would
// defeat the point of locking sensitive financial data in the first place.

import { Capacitor, registerPlugin } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();

const NativeBiometric = registerPlugin('NativeBiometric');

// Whether this device can actually enforce a lock at all (has a fingerprint
// enrolled, face unlock set up, or at minimum a device PIN/pattern/password
// set). If this comes back false, do not silently pretend the app is
// locked — settings.js should show a clear "set a device PIN to enable
// this" message instead of a prompt that can never succeed.
export async function isLockAvailable() {
  if (!isNative()) return false;
  try {
    const result = await NativeBiometric.isAvailable({ useFallback: true });
    return !!(result && result.isAvailable);
  } catch {
    return false;
  }
}

// Shows the OS-native prompt and resolves true only on a real success.
// Any rejection (wrong fingerprint, cancelled, too many attempts, no
// biometric/PIN configured, plugin error) resolves false — callers must
// treat false as "still locked," never as "skip the check."
export async function unlock() {
  if (!isNative()) return true; // nothing to unlock on the plain web build
  try {
    await NativeBiometric.verifyIdentity({
      reason: 'Unlock SaveLock',
      title: 'SaveLock',
      subtitle: 'Confirm it is you',
      description: 'Use your fingerprint, face, or device PIN to continue.',
      useFallback: true, // let Android offer device PIN/pattern/password too, not fingerprint only
      maxAttempts: 5,
    });
    return true;
  } catch {
    return false;
  }
}
