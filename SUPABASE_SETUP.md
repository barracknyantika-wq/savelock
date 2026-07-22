# Setting up cloud sync (Supabase)

SaveLock works exactly as it always has with none of this set up — everything
stays local-only on-device. This is entirely opt-in: nobody sees an account
option that does anything until you complete the steps below.

None of this has been tested against a real Supabase project, a real phone
number, or a real Google Cloud OAuth client — I don't have the credentials
or dashboard access to do any of that myself. The schema and RLS policies
were verified against a real local Postgres instance (schema applies
cleanly, the signup trigger works and correctly populates one `profiles` row
whether the user came in via phone or Google, row-level isolation was tested
and confirmed with a non-superuser role). The client code (auth + sync,
including Google's redirect handling) was verified against the exact
request/response shapes in the installed `@supabase/supabase-js`,
`@capacitor/browser`, and `@capacitor/app` SDK source, and exercised with a
mocked network layer standing in for both Supabase's API and Google's
redirect. What's specifically unverified: the Android deep link actually
delivering the redirect back into the app (`com.savelock.app://auth-callback`,
needs a real device and a real OAuth client to test), and anything about
Google's own consent screen or account picker behavior. The one thing only
you can do is actually create the project and OAuth client and try both
sign-in methods for real, on a real phone, please tell me what breaks if
anything does.

## 1. Create the project

1. Go to [supabase.com](https://supabase.com), sign in, and create a **new
   project** (pick any name, e.g. "savelock", and a region close to Kenya —
   likely `eu-west` or similar for lowest latency).
2. Wait for provisioning to finish (a couple of minutes).

## 2. Run the schema migrations

1. In the project dashboard, open **SQL Editor**.
2. Paste the entire contents of
   [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql)
   and run it once.
3. Then paste and run
   [`supabase/migrations/0002_google_auth.sql`](./supabase/migrations/0002_google_auth.sql)
   too, even if you only plan to use phone sign-in for now, it just adds two
   nullable columns (`email`, `display_name`) to `profiles` and updates the
   signup trigger to fill them in when they're available. Nothing here
   requires Google sign-in to actually be turned on.
4. Confirm under **Table Editor** that `profiles`, `settings`, `daily_logs`,
   `spends`, `goals`, `badges`, `challenges`, and `fuliza_events` all exist,
   and that each has a green "RLS enabled" badge.

## 3. Turn on phone sign-in

1. **Authentication → Providers → Phone** → enable it.
2. Supabase needs an SMS provider to actually send the OTP text — pick one
   under **Authentication → Providers → Phone → SMS Provider**:
   - **Twilio** is the best-documented option and has a
     [Twilio Verify guide](https://supabase.com/docs/guides/auth/phone-login?showSMSProvider=Twilio)
     specifically for this. You'll need your own Twilio account (has its own
     cost per SMS) — sign up, get an Account SID/Auth Token, and a Verify
     Service SID or a phone number to send from.
   - MessageBird and Vonage are also natively supported if you already use
     one of those.
   - Deliverability to Kenyan (+254) numbers varies by provider — worth
     sending yourself a test code before rolling this out to anyone else.
3. Save. Test it once from **Authentication → Users** isn't really possible
   for phone OTP from the dashboard — the real test is signing in from the
   app itself (see step 6).

## 4. Turn on Google sign-in (optional, alongside phone)

Phone sign-in and Google sign-in are two separate ways into the same
account, either produces one `profiles` row per user, and phone sign-in
keeps working exactly as above if you skip this section entirely.

### 4a. Google Cloud Console: create an OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/),
   create a project if you don't already have one to use for this.
2. **APIs & Services → OAuth consent screen**: set it up (External user
   type is fine for a small app), fill in an app name and support email.
   You don't need to submit it for verification just to test with your own
   Google account, it works immediately in "Testing" mode for accounts you
   add as test users.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Application type: **Web application** (yes, even though this app is
     used on Android, because Supabase's own auth server is what actually
     talks to Google, not the phone).
   - **Authorized redirect URIs**: add
     `https://<your-project-ref>.supabase.co/auth/v1/callback` (the exact
     project ref from step 1, no trailing slash).
4. Save. You'll get a **Client ID** and **Client Secret**, both needed next.

### 4b. Supabase: enable the provider and allow the app's own redirect back

1. **Authentication → Providers → Google** → enable it, paste in the
   **Client ID** and **Client Secret** from 4a, save.
2. **Authentication → URL Configuration → Redirect URLs**: add
   `com.savelock.app://auth-callback`. This is the one this app actually
   uses to get back in on Android: the OAuth consent screen runs in the
   system browser (Google blocks it from running inside an embedded WebView
   like this app's), and when Google finishes, it hands control back to
   this exact URL, which the app's manifest is registered to catch as a
   deep link (see `android/app/src/main/AndroidManifest.xml`, the
   `<intent-filter>` with `android:scheme="com.savelock.app"` and
   `android:host="auth-callback"`). Without this exact URL in the allowlist,
   Supabase will refuse to redirect there and the sign-in will dead-end in
   the browser.
3. If you also plan to test the sign-in from a plain desktop browser (not
   the Android app), the redirect there is just this site's own
   `/account/` page, already covered by whatever URL you're serving the app
   from, nothing extra to add for that case.

## 5. Get your API keys

**Project Settings → API**:
- **Project URL** → this is `PUBLIC_SUPABASE_URL`
- **anon / public key** → this is `PUBLIC_SUPABASE_ANON_KEY` (this key is
  safe to ship in the app — it has no special privileges by itself; every
  table's RLS policy is what actually protects the data, keyed off
  `auth.uid()` from the user's own session, not this key)

Never use the **service_role** key anywhere in the app — it bypasses RLS
entirely and must never leave a trusted server.

## 6. Wire the keys in

**For local development**, create a `.env` file at the repo root (already
gitignored):

```
PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

Then `npm run dev` / `npm run build` as normal — the Account screen in
Settings will switch from "Cloud sync isn't set up" to a real phone
sign-in form.

**For the GitHub Actions cloud Android build**, add two repository secrets
(**Settings → Secrets and variables → Actions → New repository secret**):

- `PUBLIC_SUPABASE_URL`
- `PUBLIC_SUPABASE_ANON_KEY`

`build-android.yml` already reads both into the build step — leaving them
unset just keeps the built APK local-only, same as today.

## 7. Try it

Open the app, go to **Settings → Account & sync**, and sign in either way:
- **Phone**: enter a real phone number, confirm the OTP arrives and signs
  you in.
- **Google**: tap "Sign in with Google", complete the consent screen in the
  system browser, and confirm it lands you back in the app signed in.

If you already have data tracked locally on that device, you'll be offered a
choice to import it into the account (or, if the account already had data
from elsewhere, a choice of which copy to keep) — nothing is silently merged
or discarded, and this happens the same way regardless of which sign-in
method you used.

## What this does and doesn't do

- **Sync strategy**: pushes a full mirror of your local state up on every
  change (debounced ~2.5s), so this device's copy is always what "wins" once
  it pushes. There's no field-by-field merge across two devices editing at
  the same time — if you use two phones on the same account, whichever last
  finishes writing determines the account's state. Fine for the realistic
  use case (one phone at a time), not built for simultaneous multi-device
  editing.
- **Deletes propagate correctly**: pushing mirrors exactly what's local, so
  deleting a spend or a goal on-device removes it from the account too on
  the next push — this was a deliberate design choice specifically to avoid
  the more complex "tombstone" bookkeeping a partial-sync approach would need.
- **RLS is real**: verified directly against Postgres (not just written and
  assumed) that a user can only ever see and modify their own rows in every
  table.
