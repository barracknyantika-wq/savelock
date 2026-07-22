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

## 7. Turn on M-Pesa deposits and withdrawals (optional)

This is a separate opt-in feature on top of everything above: a user can tap
Deposit on a goal to get an M-Pesa PIN prompt (STK Push), and the goal's
balance updates once Safaricom confirms payment. Withdrawals (money sent
back out to a phone, B2C) exist too, but only for one account, gated by
`profiles.is_owner`, since this is meant for the developer's own testing
with real money for now, not for every user yet.

None of this needs anything from sections 1 through 6 above beyond the
project already existing, it's entirely separate credentials and its own
set of database objects.

### 7a. Run the additional migrations

In the SQL Editor, run these four in order, same as section 2:
[`0003_mpesa_transactions.sql`](./supabase/migrations/0003_mpesa_transactions.sql),
[`0004_owner_flag.sql`](./supabase/migrations/0004_owner_flag.sql),
[`0005_mpesa_functions.sql`](./supabase/migrations/0005_mpesa_functions.sql),
[`0006_goal_balance_readable.sql`](./supabase/migrations/0006_goal_balance_readable.sql).

### 7b. Deploy the Edge Functions

Using the Supabase CLI, from the repo root:

```
supabase link --project-ref your-project-ref
supabase functions deploy initiate-stk-push
supabase functions deploy stk-callback
supabase functions deploy initiate-b2c-withdrawal
supabase functions deploy b2c-callback
```

`stk-callback` and `b2c-callback` are the two Safaricom actually posts to
directly, with no Supabase login of its own, so `supabase/config.toml`
already turns off this project's usual JWT check for just those two. If you
deploy some other way and that setting doesn't carry over, both of those
two calls will fail with an authorization error before your own code ever
runs, that's the first thing to check if callbacks aren't arriving.

### 7c. Set the Edge Function secrets

**Project Settings → Edge Functions → Secrets** (these never reach the app
itself, they only exist inside the functions above):

- `MPESA_ENV`: `sandbox` or `production`. Everything below points at
  Safaricom's sandbox host until this says otherwise.
- `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET`: from your Daraja app, used
  to get an OAuth token for both deposits and withdrawals.
- `MPESA_SHORTCODE`: the PayBill shortcode STK Push deposits go to. The
  sandbox value already confirmed working end to end is `174379`.
- `MPESA_PASSKEY`: the STK Push passkey paired with that shortcode.
- `MPESA_CALLBACK_BASE_URL`: `https://your-project-ref.supabase.co/functions/v1`
  (no trailing slash), this is how the two initiate-\* functions build the
  callback URLs they hand to Daraja.
- `MPESA_B2C_INITIATOR_NAME`, `MPESA_B2C_SECURITY_CREDENTIAL`,
  `MPESA_B2C_SHORTCODE`: from the Daraja Test Credentials page for B2C
  specifically, separate from the STK Push values above. Production values
  for both flows are meant to replace these same variable names later,
  nothing in code should ever need to change for that swap.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` don't need setting by hand,
Supabase injects both into every Edge Function automatically. The service
role key is what lets stk-callback/b2c-callback credit or debit a goal on
Safaricom's behalf, it never appears anywhere in the app itself.

### 7d. Grant withdraw access to one account

Withdrawals stay off for everyone until you turn them on for a specific
user, by hand, in the SQL Editor:

```sql
update public.profiles set is_owner = true where id = 'the-developer-account-user-id';
```

Find that id under **Authentication → Users**. There's deliberately no UI
for this anywhere in the app, flipping it back to `false` disables the
Withdraw button on that account again immediately.

### 7e. What's confirmed and what isn't

The STK Push request and callback shapes here were verified end to end
against the Daraja sandbox already, by hand, with curl, before any of this
code was written. That gives real confidence in the deposit side's request
format. The B2C side is built from the same publicly documented request and
callback shapes, but hasn't been exercised against a live sandbox call the
same way, since the B2C sandbox credentials weren't available yet while this
was built, confirm the exact field names still match once
`MPESA_B2C_INITIATOR_NAME`/`MPESA_B2C_SECURITY_CREDENTIAL` are in place and
a real B2C request has actually gone through.

The database side (RLS so a user can never mark their own deposit or
withdrawal completed, the atomic credit/debit functions never double
counting a duplicate callback retry, the ledger-based balance calculation)
was all verified against a real local Postgres instance, including
deliberately breaking each guard once to confirm the corresponding test
actually catches it. The Realtime piece that updates the Deposit/Withdraw
sheet automatically once a callback lands was verified only up to the point
Supabase's client library takes over, actually watching a live callback
arrive over that connection needs a real project to test.

## 8. Try it

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

If you set up section 7 too, open a goal and try Deposit with the sandbox
test number `254708374149`, the PIN prompt on that number always succeeds in
sandbox. Withdraw only shows up on the one account you flipped `is_owner` on.

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
