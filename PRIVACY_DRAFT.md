# Privacy notice — DRAFT, not legal advice

This is a starting draft to speed up getting a real privacy policy and terms
of use written — it is **not** a substitute for review by an actual lawyer,
and should not be published or relied on as-is. It describes what the code
in this repository actually does today, as of the accounts/cloud-sync
feature, so nothing here is aspirational or hypothetical.

---

## What SaveLock is

SaveLock is a personal budgeting/savings-discipline tool. It never holds or
moves money, and it never connects to your bank or M-Pesa account directly —
on Android, it can read the confirmation SMS Safaricom already sends you, to
log spends automatically, but it never sends, receives, or requests any
payment itself.

## What data is collected, and why

**If this deployment has no Supabase project connected at all:** nothing
ever leaves your device, there is no sign-in screen and no way to send
anything anywhere. All data lives in your browser's/app's local storage
only. This is a build-time choice, not something you can turn on or off from
inside the app.

**If this deployment does have a Supabase project connected:** signing in
is required before the app can be used at all, it is not optional. You can
sign in with a phone number and SMS code, or with a Google account. Once
signed in:

| Data | Why it's collected |
|---|---|
| Phone number | The only thing used to identify your account and sign you back in on another device. No email, name, or other identity information is requested. |
| Daily allowance / spending limit | Core app function — this is what the app is scoring you against. |
| Individual spends (amount, category, note, timestamp, whether via M-Pesa auto-detect or Fuliza overdraft) | Core app function — the actual budget-tracking data. |
| Goals (name, target, saved amount, target date, history) | Core app function. |
| Streak count, badges earned, weekly challenge progress | Engagement features built on top of the same budget data — nothing new is collected for these, they're computed from the above. |
| Notification/reminder preferences | So they can follow you across devices too. |

Nothing else is collected: no location, no contacts, no device identifiers,
no advertising ID, no analytics/tracking pixels, no browsing history.

On Android with SMS auto-detect enabled, the app reads only M-Pesa
confirmation texts (matched by sender ID) to extract the transaction it
already parses — it does not read, store, or transmit any other SMS content,
and the raw SMS text itself is never sent to the server; only the
already-parsed transaction (amount, category, counterparty name, etc.) is.

## Who can see it

- **You**, always — that's the entire point.
- **Nobody else's account can see your data.** This is enforced by
  row-level security policies in the database itself (not just application
  code), verified directly: a second account genuinely cannot read, edit, or
  insert rows tagged with a different user's ID, even with the same API key.
- **The Supabase project owner** (whoever creates and administers the
  project — presumably you, or your organization) has the technical ability
  to access the raw database directly, the same as any database
  administrator can for any app they run. This is normal and unavoidable for
  a small team running its own backend, but it should be stated plainly
  rather than implied away: signing in means trusting whoever operates that
  Supabase project, not just trusting "the app".
- **Supabase** (the hosting provider) processes this data on your behalf as
  infrastructure — see [Supabase's own privacy policy](https://supabase.com/privacy)
  and data processing terms for what they do with data they host.
- **Whichever SMS/OTP provider is configured** for phone sign-in (e.g.
  Twilio) receives the phone number to send the code, and that provider's
  own privacy policy applies to that specific transaction.

## What's NOT yet built (gaps before real users beyond you/your household)

Flagging these explicitly per your request — these are real, current gaps,
not hypothetical:

1. **No published privacy policy or terms of use.** This document is a
   drafting aid, not a substitute.
2. **No account-deletion flow.** There's no in-app "delete my account and
   all my data" button yet — deletion today would mean an admin manually
   deleting rows in Supabase.
3. **No data export for account holders beyond the existing local JSON
   backup** (which only covers this device's local copy, not the full
   account history stored in Supabase, e.g. the running spendLog/history
   that may have been trimmed locally but persisted server-side).
4. **Kenya Data Protection Act, 2019** — if this handles Kenyan users'
   personal data at any meaningful scale, registration/notification with the
   Office of the Data Protection Commissioner (ODPC) is a real requirement
   worth checking with a lawyer, separate from anything in this codebase.
5. **No documented data-retention period** — data currently persists
   indefinitely with no automatic expiry.
6. **No age-gating.** Nothing here checks or restricts who can sign up.
7. **No incident-response plan** documented for a data breach scenario.

None of items 1–7 are things I can resolve from inside this codebase —
they need a real decision from you (and likely a lawyer) before this goes
from "you and people you trust" to "the general public."
