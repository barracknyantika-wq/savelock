# Setting up cloud sync (Supabase)

SaveLock works exactly as it always has with none of this set up — everything
stays local-only on-device. This is entirely opt-in: nobody sees an account
option that does anything until you complete the steps below.

None of this has been tested against a real Supabase project or a real phone
number — I don't have the credentials or dashboard access to do that myself.
The schema and RLS policies were verified against a real local Postgres
instance (schema applies cleanly, the signup trigger works, row-level
isolation was tested and confirmed with a non-superuser role). The client
code (auth + sync) was verified against the exact request/response shapes in
the installed `@supabase/supabase-js` SDK source and exercised end-to-end
with a mocked network layer standing in for Supabase's API. The one thing
only you can do is actually create the project and try it with a real phone
number — please tell me what breaks if anything does.

## 1. Create the project

1. Go to [supabase.com](https://supabase.com), sign in, and create a **new
   project** (pick any name, e.g. "savelock", and a region close to Kenya —
   likely `eu-west` or similar for lowest latency).
2. Wait for provisioning to finish (a couple of minutes).

## 2. Run the schema migration

1. In the project dashboard, open **SQL Editor**.
2. Paste the entire contents of
   [`supabase/migrations/0001_init.sql`](./supabase/migrations/0001_init.sql)
   and run it once.
3. Confirm under **Table Editor** that `profiles`, `settings`, `daily_logs`,
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
   app itself (see step 5).

## 4. Get your API keys

**Project Settings → API**:
- **Project URL** → this is `PUBLIC_SUPABASE_URL`
- **anon / public key** → this is `PUBLIC_SUPABASE_ANON_KEY` (this key is
  safe to ship in the app — it has no special privileges by itself; every
  table's RLS policy is what actually protects the data, keyed off
  `auth.uid()` from the user's own session, not this key)

Never use the **service_role** key anywhere in the app — it bypasses RLS
entirely and must never leave a trusted server.

## 5. Wire the keys in

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

## 6. Try it

Open the app, go to **Settings → Account & sync**, enter a real phone
number, and confirm the OTP arrives and signs you in. If you already have
data tracked locally on that device, you'll be offered a choice to import it
into the account (or, if the account already had data from elsewhere, a
choice of which copy to keep) — nothing is silently merged or discarded.

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
