# SaveLock

A personal savings-discipline PWA. Installable to your phone's home screen, works
fully offline, no app store and no account needed.

**SaveLock holds no money.** The real cash stays in your own M-Shwari Lock / bank
account — this app is the coach on top: it tracks a daily spending allowance and
keeps score while you wait out a savings lock.

## Features

**Daily allowance**

- Set a daily limit (e.g. KSh 500) and see a big "left today" number.
- Log spends in two taps — quick amounts (50/100/200) or a custom amount with a note.
- Resets to the full limit at local midnight.
- Streak counter: every day ended at or above zero extends it; a day over the
  limit resets it.
- Today's spends are listed and deletable if mis-entered.

**Savings goal lock**

- Create a goal with a name, target amount and withdraw date.
- Days-remaining countdown and a progress bar toward the target.
- You update the saved amount manually to mirror the real lock.
- **Breaking a goal early is deliberately high-friction**: a full-screen confirm
  shows the days you'd quit early and the streak you'd lose, and requires typing
  `YES`. The friction is the feature. No money moves — the break is only recorded.
- Celebration state when the withdraw date arrives or the target is hit.

**M-Pesa auto-detection (native Android build only — see below)**

- When installed as the native Android app with SMS permission granted,
  SaveLock reads incoming M-Pesa confirmation texts (only M-Pesa; every other
  message is ignored untouched) and logs spends automatically.
- A heads-up notification fires within a second or two, even if the app is
  closed: "Logged KSh 300 to CORNER SHOP. KSh 200 left today." (or the
  over-budget variant), tapping it opens the app.
- Money received fires a lighter "not counted as spending" notification.
- Either notification is toggleable in Settings, independently, default on.
- Any logged spend — SMS-detected or manual — can be marked "not spending"
  from the Today list and moved into a goal's saved total instead (e.g. a
  transfer to your own savings that looked like an outgoing payment).
- The same M-Pesa transaction can never be logged or notified twice, even if
  the phone redelivers the SMS.

## Data

Everything is stored in `localStorage` on the device. Nothing is sent anywhere.
Settings → Backup exports a JSON file and re-imports it, so data survives a
browser clear or a phone switch.

## Stack

[Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com) +
[Alpine.js](https://alpinejs.dev). No backend, no database, no analytics.

The PWA layer is hand-rolled: `public/manifest.webmanifest` plus a service worker
generated at build time (`scripts/generate-sw.mjs` walks `dist/`, precaches every
built file, and stamps a content-hash cache version so each deploy invalidates
the previous cache).

## Development

```sh
npm install
npm run dev        # dev server (no service worker in dev)
npm run build      # builds to dist/ and generates dist/sw.js
npm run preview    # serve the production build locally
```

## Deployment

Pushes to `main` trigger `.github/workflows/static.yml`, which builds the site
and deploys `dist/` to GitHub Pages. The base path is injected automatically via
`BASE_PATH`, so the app works both at a domain root and under a repo subpath.

Icons: `public/icons/*.png` are rendered at build time by
`scripts/generate-icons.mjs` from the lock mark in `public/favicon.svg` (rounded
tile for regular icons, full-bleed with an 80% safe zone for the maskable/apple
ones), so no binaries live in the repo.

## Install to home screen

Open the deployed URL on your phone:

- **Android (Chrome):** menu ⋮ → "Add to Home screen" / "Install app".
- **iOS (Safari):** Share → "Add to Home Screen".

It opens standalone (no browser chrome) and keeps working with no connection.

## Native Android build (M-Pesa auto-detection)

The PWA above covers every feature except one: **reading incoming SMS**.
There is no web API — on any browser, on any OS — that lets an installed web
app read SMS content or wake up in the background when one arrives. That
capability only exists for real native apps, and only on Android; iOS gives
zero third-party apps (native or otherwise) any access to SMS content,
ever. So SaveLock ships as two things sharing one codebase:

- **The PWA** (everything above) — cross-platform, manual "Log spend" entry.
- **A native Android shell** (`android/`, via [Capacitor](https://capacitorjs.com))
  wrapping the same web UI, adding a manifest-declared `SmsReceiver` that
  detects M-Pesa transactions and fires the confirmation notification —
  entirely in Kotlin, independent of the WebView, so it keeps working even
  when the app is fully closed.

**This cannot be published to the Google Play Store as-is.** Play's sensitive-
permissions policy restricts `RECEIVE_SMS`/`READ_SMS` to apps whose core
function *is* SMS/calling (default SMS or dialer handlers) — a savings
tracker does not qualify, and Google has enforced this tightly since 2020.
Distribution is via a **sideloaded APK** (built locally and installed
directly, "Install from unknown sources"), which is the trade-off explicitly
chosen for this feature. iOS has no equivalent build and never will —
iOS installs stay on the manual-entry PWA permanently.

### What the native shell actually does

- `android/app/src/main/java/com/savelock/app/SmsReceiver.kt` — a
  `<receiver>` declared in `AndroidManifest.xml` (not registered at runtime),
  which is why it keeps working after the app is swiped away: Android
  exempts the SMS broadcast from the background-execution limits that block
  most other implicit broadcasts.
- It only asks for `RECEIVE_SMS`, never `READ_SMS` — it only ever sees the
  message contained in that one broadcast's extras, never the phone's SMS
  history. It also ignores every SMS whose sender isn't the `MPESA` sender
  ID; nothing else is ever parsed or stored.
- `MpesaParser.kt` parses the message (sent/paid/paybill/withdrawn/airtime/
  received) and is a hand-kept mirror of `src/scripts/mpesa-parser.js` — the
  two must stay in sync by hand, there's no shared runtime between native
  and web to enforce it. Both are deliberately conservative: an unrecognized
  message is left alone rather than guessed at.
- Every M-Pesa message opens with a unique transaction code
  (`TJB2K3L4M5 Confirmed. …`); that code is the dedup key everywhere, so a
  redelivered SMS can never double-log or double-notify.
- Detected transactions queue in `SharedPreferences` and drain into the web
  store (`store.drainNativeTransactions`) the next time the app opens or
  resumes — see `src/scripts/native-bridge.js`.

### Building it

Requires the Android SDK and a JDK — **neither is fully usable in the
sandbox this was built in** (see Verification below), so this is untested
beyond compiling the parser logic standalone:

```sh
npm run build          # builds the web app to dist/
npx cap sync android    # copies dist/ into the Android project
cd android
./gradlew assembleDebug # -> app/build/outputs/apk/debug/app-debug.apk
```

Install the resulting APK directly on a device (`adb install` or copy +
open), then grant SMS and notification permissions from Settings when
prompted.

### Verification — what was and wasn't possible in this environment

This sandbox has no Android SDK, and Google's Maven repo
(`dl.google.com`, required to resolve AndroidX/Android Gradle Plugin
dependencies) is network-blocked here even with an SDK — so an actual
Gradle/Android build could not be attempted end-to-end. What was verified:

- The JS parser (`mpesa-parser.js`) against 11 representative real M-Pesa
  message formats, including negative cases that must *not* be misread.
- The Kotlin parser (`MpesaParser.kt`) compiled standalone (it has zero
  Android dependencies) and produces byte-identical results to the JS
  parser on the same 11 cases.
- The store layer (dedup by transaction code, spend vs. received handling,
  reclassify-to-savings, batch drain) — 15 checks.
- The full pre-existing 23-check web regression suite, re-run after adding
  the Capacitor dependency, to confirm nothing in the PWA regressed.
- The new UI in a browser: an SMS-sourced spend appearing tagged "M-Pesa",
  reclassifying it into a goal, the confirmation banner, and the native-only
  Settings section correctly staying hidden on a plain web/PWA install.

What was **not**, and could not be, verified here: that the Gradle/Android
build actually compiles against a real SDK; that the `SmsReceiver` actually
fires on a real incoming SMS; that the notification actually appears
heads-up within a second on a real device; the runtime permission prompts;
or behavior under OEM battery-optimization variants that restrict
background receivers more aggressively than stock Android. All of that
needs a real Android device or emulator to confirm.
