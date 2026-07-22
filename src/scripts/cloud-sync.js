// Bridges the local-only store to an optional Supabase account, so data can
// follow the user across devices. A complete no-op when no project is
// configured — isCloudConfigured() gates every function here, exactly like
// isNative() gates native-bridge.js, so the plain local-only PWA is
// completely unaffected by any of this existing.
//
// Local storage stays the source of truth for the UI at all times: every
// screen reads/writes through store.js exactly as before. This module only
// mirrors that state to Supabase (when signed in) and pulls it back down
// (at sign-in, or when this device turns out to have nothing local yet).
//
// Sync strategy, stated plainly because "sync" hides a lot of judgment calls:
//   - Push is a full mirror of today's + logged spends, goals, badges,
//     challenges and settings — upserts everything present locally and
//     deletes any remote row whose id isn't present locally anymore. That
//     makes local deletes (e.g. deleting a spend) propagate correctly
//     without needing tombstone records, at the cost of re-sending more
//     than strictly changed on every push. Fine at this data scale.
//   - Pull only ever happens explicitly (sign-in, or an empty local device)
//     — never silently overwrites a device's already-populated local data.
//     If BOTH the account and this device have real data when signing in,
//     the caller is expected to ask the user which one wins (see
//     resolveSignIn below) rather than silently picking one.
//   - This is last-writer-wins at the granularity of "which whole copy do
//     you want", not a field-by-field merge — deliberately simple, and
//     genuinely untested against a live project (see SUPABASE_SETUP.md).

import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

// Google's own OAuth policy blocks signing in from an embedded WebView (the
// exact environment a Capacitor app runs its UI in), so the native flow
// can't just redirect the app's own window like the plain web build does.
// Instead: open Google's consent screen in the system browser (Custom Tabs
// on Android, via @capacitor/browser), and have it land back in this app
// through a custom URL scheme the manifest registers as a deep link.
const NATIVE_OAUTH_REDIRECT = 'com.savelock.app://auth-callback';

export const isCloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let _client = null;
function client() {
  if (!isCloudConfigured()) return null;
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _client;
}

// ---- auth -----------------------------------------------------------------

export async function getSession() {
  const c = client();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session || null;
}

// Returns an unsubscribe function; a no-op one when cloud sync isn't
// configured, so callers never need to branch on isCloudConfigured() too.
export function onAuthStateChange(callback) {
  const c = client();
  if (!c) return () => {};
  const { data } = c.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function sendOtp(phone) {
  const c = client();
  if (!c) return { error: 'Cloud sync is not configured for this build.' };
  const { error } = await c.auth.signInWithOtp({ phone });
  return { error: error?.message || null };
}

export async function verifyOtp(phone, token) {
  const c = client();
  if (!c) return { error: 'Cloud sync is not configured for this build.', session: null };
  const { data, error } = await c.auth.verifyOtp({ phone, token, type: 'sms' });
  return { error: error?.message || null, session: data?.session || null };
}

export async function signOut() {
  const c = client();
  if (!c) return;
  await c.auth.signOut();
}

// ---- Google Sign-In (second auth option, alongside phone OTP) --------------
//
// Web build: a normal redirect. supabase-js navigates the current window to
// Google, Google sends the user back to redirectTo with the session in the
// URL, and supabase-js's built-in detectSessionInUrl picks it up on the next
// page load automatically. Nothing extra needed here.
//
// Native build: skipBrowserRedirect so supabase-js just hands back the
// Google URL instead of trying to navigate the WebView (which Google would
// refuse anyway). That URL is opened in the system browser; the resulting
// redirect to NATIVE_OAUTH_REDIRECT is caught by onGoogleAuthRedirect below
// once the manifest's deep link delivers it back to this app.

export async function signInWithGoogle() {
  const c = client();
  if (!c) return { error: 'Cloud sync is not configured for this build.' };
  const native = Capacitor.isNativePlatform();
  const { data, error } = await c.auth.signInWithOAuth({
    provider: 'google',
    options: native
      ? { redirectTo: NATIVE_OAUTH_REDIRECT, skipBrowserRedirect: true }
      : { redirectTo: `${window.location.origin}/account/` },
  });
  if (error) return { error: error.message };
  if (native && data?.url) {
    await Browser.open({ url: data.url });
  }
  return { error: null };
}

// Parses the tokens out of the deep-link redirect URL and completes the
// session. Supabase's default (implicit) flow returns them in the URL
// fragment, e.g. com.savelock.app://auth-callback#access_token=...&
// refresh_token=...; an error from Google/Supabase comes back the same way
// as error/error_description instead.
async function completeGoogleSignIn(url) {
  const c = client();
  if (!c) return null;
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  if (!access_token || !refresh_token) return null;
  const { data, error } = await c.auth.setSession({ access_token, refresh_token });
  return error ? null : data.session;
}

// Registers the deep-link listener that catches the native OAuth redirect.
// callback receives the completed session (or null if the redirect wasn't
// actually a completed sign-in, e.g. some unrelated deep link). No-op
// everywhere but a native build, same as every other Capacitor-only hook
// in this codebase.
export function onGoogleAuthRedirect(callback) {
  if (!Capacitor.isNativePlatform()) return () => {};
  let handle;
  App.addListener('appUrlOpen', async ({ url }) => {
    if (!url || !url.startsWith(NATIVE_OAUTH_REDIRECT)) return;
    const session = await completeGoogleSignIn(url);
    Browser.close().catch(() => {});
    callback(session);
  }).then((h) => {
    handle = h;
  });
  return () => handle?.remove();
}

// ---- shape mapping: local store <-> Supabase rows --------------------------

function dateOfMs(ms) {
  const d = new Date(ms || Date.now());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function spendToRow(userId, s) {
  return {
    id: s.id,
    user_id: userId,
    date: dateOfMs(s.at),
    amount: s.amount,
    note: s.note || null,
    category: s.category || null,
    source: s.source || 'manual',
    classification: s.classification || 'spend',
    mpesa_code: s.mpesaCode || null,
    via_fuliza: !!s.viaFuliza,
    fuliza_amount: s.viaFuliza ? s.fulizaAmount ?? null : null,
    at: new Date(s.at || Date.now()).toISOString(),
  };
}

function rowToSpend(r) {
  return {
    id: r.id,
    amount: Number(r.amount),
    note: r.note || '',
    category: r.category || 'Other',
    at: new Date(r.at).getTime(),
    source: r.source,
    mpesaCode: r.mpesa_code || undefined,
    classification: r.classification,
    viaFuliza: r.via_fuliza,
    fulizaAmount: r.fuliza_amount != null ? Number(r.fuliza_amount) : null,
  };
}

function goalToRow(userId, g) {
  return {
    id: g.id,
    user_id: userId,
    name: g.name,
    target: g.target,
    saved: g.saved,
    target_date: g.date,
    status: g.status,
    milestones_hit: g.milestonesHit || [],
    saved_history: g.savedHistory || [],
    created_at_date: g.createdAt || null,
    completed_at: g.completedAt || null,
    broken_at: g.brokenAt || null,
    days_early: g.daysEarly ?? null,
    streak_lost: g.streakLost ?? null,
    updated_at: new Date().toISOString(),
  };
}

function rowToGoal(r) {
  return {
    id: r.id,
    name: r.name,
    target: Number(r.target),
    saved: Number(r.saved),
    date: r.target_date,
    createdAt: r.created_at_date,
    status: r.status,
    milestonesHit: r.milestones_hit || [],
    savedHistory: r.saved_history || [],
    ...(r.completed_at ? { completedAt: r.completed_at } : {}),
    ...(r.broken_at ? { brokenAt: r.broken_at, daysEarly: r.days_early, streakLost: r.streak_lost } : {}),
  };
}

function settingsToRow(userId, settings, streakCount) {
  return {
    user_id: userId,
    daily_limit: settings.dailyLimit,
    currency: settings.currency,
    streak_count: streakCount,
    sms_notify_spend: settings.smsNotifySpend,
    sms_notify_received: settings.smsNotifyReceived,
    sms_notify_mode: settings.smsNotifyMode,
    categories: settings.categories,
    reminder_morning_enabled: settings.reminderMorningEnabled,
    reminder_morning_time: settings.reminderMorningTime,
    reminder_evening_enabled: settings.reminderEveningEnabled,
    reminder_evening_time: settings.reminderEveningTime,
    weekly_summary_enabled: settings.weeklySummaryEnabled,
    updated_at: new Date().toISOString(),
  };
}

function rowToSettings(r) {
  return {
    dailyLimit: Number(r.daily_limit),
    currency: r.currency,
    smsNotifySpend: r.sms_notify_spend,
    smsNotifyReceived: r.sms_notify_received,
    smsNotifyMode: r.sms_notify_mode,
    categories: r.categories,
    reminderMorningEnabled: r.reminder_morning_enabled,
    reminderMorningTime: r.reminder_morning_time,
    reminderEveningEnabled: r.reminder_evening_enabled,
    reminderEveningTime: r.reminder_evening_time,
    weeklySummaryEnabled: r.weekly_summary_enabled,
  };
}

function challengeRows(userId, store) {
  const rows = [];
  if (store.challenge) {
    rows.push({
      id: store.challenge.id,
      user_id: userId,
      target_extra: store.challenge.targetExtra,
      start_date: store.challenge.startDate,
      end_date: null,
      status: 'active',
      saved_amount: null,
    });
  }
  for (const h of store.challengeHistory) {
    rows.push({
      id: h.id,
      user_id: userId,
      target_extra: h.targetExtra,
      start_date: h.startDate,
      end_date: h.endDate,
      status: h.status,
      saved_amount: h.savedAmount,
    });
  }
  return rows;
}

// ---- push: mirror local state up to Supabase -------------------------------

async function mirrorTable(c, table, userId, localRows) {
  const { data: remote, error: fetchErr } = await c.from(table).select('id').eq('user_id', userId);
  if (fetchErr) return fetchErr;
  const localIds = new Set(localRows.map((r) => r.id));
  const staleIds = (remote || []).map((r) => r.id).filter((id) => !localIds.has(id));
  if (staleIds.length) {
    const { error } = await c.from(table).delete().in('id', staleIds);
    if (error) return error;
  }
  if (localRows.length) {
    const { error } = await c.from(table).upsert(localRows);
    if (error) return error;
  }
  return null;
}

// Pushes the full current local state. Safe to call repeatedly (e.g.
// debounced on every store.persist()) — every write here is an upsert or a
// delete-of-what's-gone, never an append that could duplicate.
export async function pushState(store) {
  const c = client();
  if (!c) return { error: null };
  const session = await getSession();
  if (!session) return { error: null };
  const userId = session.user.id;

  const { error: settingsErr } = await c
    .from('settings')
    .upsert(settingsToRow(userId, store.settings, store.streak.count));
  if (settingsErr) return { error: settingsErr.message };

  if (store.history.length) {
    const rows = store.history.map((h) => ({
      user_id: userId,
      date: h.date,
      allowance: h.limit,
      spent: h.spent,
    }));
    const { error } = await c.from('daily_logs').upsert(rows, { onConflict: 'user_id,date' });
    if (error) return { error: error.message };
  }

  const allSpends = [...store.day.spends, ...store.spendLog].map((s) => spendToRow(userId, s));
  const spendsErr = await mirrorTable(c, 'spends', userId, allSpends);
  if (spendsErr) return { error: spendsErr.message };

  const goalRows = store.goals.map((g) => goalToRow(userId, g));
  const goalsErr = await mirrorTable(c, 'goals', userId, goalRows);
  if (goalsErr) return { error: goalsErr.message };

  if (store.badges.length) {
    const rows = store.badges.map((b) => ({ user_id: userId, badge_id: b.id, earned_at: b.earnedAt }));
    const { error } = await c.from('badges').upsert(rows, { onConflict: 'user_id,badge_id', ignoreDuplicates: true });
    if (error) return { error: error.message };
  }

  const chRows = challengeRows(userId, store);
  const challengeErr = await mirrorTable(c, 'challenges', userId, chRows);
  if (challengeErr) return { error: challengeErr.message };

  if (store.fulizaEvents.length) {
    const rows = store.fulizaEvents.map((e) => ({
      id: e.id,
      user_id: userId,
      type: e.type,
      amount: e.amount,
      mpesa_code: e.mpesaCode || null,
      at: new Date(e.at).toISOString(),
    }));
    const { error } = await c.from('fuliza_events').upsert(rows);
    if (error) return { error: error.message };
  }

  return { error: null };
}

// ---- pull: does this account already have data on the server? ------------

export async function hasRemoteData(userId) {
  const c = client();
  if (!c) return false;
  const { data } = await c
    .from('settings')
    .select('daily_limit')
    .eq('user_id', userId)
    .maybeSingle();
  if (data && Number(data.daily_limit) > 0) return true;
  const { count } = await c.from('goals').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return (count || 0) > 0;
}

// Fetches everything for the signed-in user and returns it already shaped
// like local store state, ready to Object.assign onto the Alpine store.
export async function pullState() {
  const c = client();
  if (!c) return null;
  const session = await getSession();
  if (!session) return null;
  const userId = session.user.id;

  const [{ data: settingsRow }, { data: goalRows }, { data: spendRows }, { data: dailyRows }, { data: badgeRows }, { data: challengeRows_ }, { data: fulizaRows }] =
    await Promise.all([
      c.from('settings').select('*').eq('user_id', userId).maybeSingle(),
      c.from('goals').select('*').eq('user_id', userId),
      c.from('spends').select('*').eq('user_id', userId),
      c.from('daily_logs').select('*').eq('user_id', userId).order('date', { ascending: true }),
      c.from('badges').select('*').eq('user_id', userId),
      c.from('challenges').select('*').eq('user_id', userId),
      c.from('fuliza_events').select('*').eq('user_id', userId),
    ]);

  const todayDate = dateOfMs(Date.now());
  const spends = (spendRows || []).map(rowToSpend);
  const activeChallenge = (challengeRows_ || []).find((r) => r.status === 'active');

  return {
    settings: settingsRow ? rowToSettings(settingsRow) : undefined,
    day: { date: todayDate, spends: spends.filter((s) => dateOfMs(s.at) === todayDate) },
    spendLog: spends.filter((s) => dateOfMs(s.at) !== todayDate),
    goals: (goalRows || []).map(rowToGoal),
    history: (dailyRows || []).map((r) => ({ date: r.date, limit: Number(r.allowance), spent: Number(r.spent) })),
    streak: { count: settingsRow ? settingsRow.streak_count : 0 },
    badges: (badgeRows || []).map((r) => ({ id: r.badge_id, earnedAt: r.earned_at })),
    challenge: activeChallenge
      ? { id: activeChallenge.id, targetExtra: Number(activeChallenge.target_extra), startDate: activeChallenge.start_date }
      : null,
    challengeHistory: (challengeRows_ || [])
      .filter((r) => r.status !== 'active')
      .map((r) => ({
        id: r.id,
        targetExtra: Number(r.target_extra),
        startDate: r.start_date,
        endDate: r.end_date,
        status: r.status,
        savedAmount: r.saved_amount != null ? Number(r.saved_amount) : 0,
      })),
    fulizaEvents: (fulizaRows || []).map((r) => ({ id: r.id, type: r.type, amount: Number(r.amount), at: new Date(r.at).getTime(), mpesaCode: r.mpesa_code })),
  };
}

// ---- M-Pesa deposits and withdrawals ---------------------------------------
//
// The actual money movement (talking to Daraja, deciding what counts as
// available balance, crediting/debiting a goal) all happens server-side in
// the initiate-stk-push/stk-callback/initiate-b2c-withdrawal/b2c-callback
// Edge Functions, never here. This is just the thin client side of that:
// start a request, then watch the row it created until the callback
// resolves it.

async function invokeFunction(name, body) {
  const c = client();
  if (!c) return { error: 'Cloud sync is not configured for this build.' };
  const { data, error } = await c.functions.invoke(name, { body });
  if (error) {
    // A non-2xx response from the function arrives as a FunctionsHttpError;
    // the actual message SaveLock's function sent back is in the response
    // body, not error.message (which is just "Edge Function returned a
    // non-2xx status code").
    const detail = await error.context?.json?.().catch(() => null);
    return { error: detail?.error || error.message };
  }
  if (data?.error) return { error: data.error };
  return { error: null, ...data };
}

export async function initiateDeposit(goalId, amount, phoneNumber) {
  return invokeFunction('initiate-stk-push', { goal_id: goalId, amount, phone_number: phoneNumber });
}

export async function initiateWithdrawal(goalId, amount, phoneNumber) {
  return invokeFunction('initiate-b2c-withdrawal', { goal_id: goalId, amount, phone_number: phoneNumber });
}

// Gates the Withdraw button. Deposits stay open to everyone; this feature
// is developer-only for now, see migration 0004_owner_flag.sql.
export async function isAccountOwner() {
  const c = client();
  if (!c) return false;
  const session = await getSession();
  if (!session) return false;
  const { data } = await c.from('profiles').select('is_owner').eq('id', session.user.id).maybeSingle();
  return !!data?.is_owner;
}

// The ledger-derived balance used to enable/disable the Withdraw button and
// show "available" in its sheet. This is read-only display, the real
// enforcement of this same number happens again, authoritatively, inside
// initiate-b2c-withdrawal itself.
export async function getGoalMpesaBalance(goalId) {
  const c = client();
  if (!c) return 0;
  const { data, error } = await c.rpc('goal_mpesa_balance', { p_goal_id: goalId });
  if (error) return 0;
  return Number(data) || 0;
}

// Re-reads one goal row from the server, used right after a deposit or
// withdrawal completes so the on-device saved amount matches what M-Pesa
// actually confirmed. Needed because pushState() mirrors the *local* copy
// of goals up to Supabase, so without this, the next debounced push would
// overwrite the server's just-credited amount back down to the stale local
// number the instant something else on this device triggers a save.
export async function refetchGoal(goalId) {
  const c = client();
  if (!c) return null;
  const { data, error } = await c.from('goals').select('*').eq('id', goalId).maybeSingle();
  if (error || !data) return null;
  return rowToGoal(data);
}

// Watches one deposits/withdrawals row for the status flip a callback
// makes, so the UI updates the instant Safaricom's callback lands instead
// of the user needing to refresh. Returns an unsubscribe function; a no-op
// one if cloud sync isn't configured, same convention as onAuthStateChange.
export function subscribeToRow(table, id, onChange) {
  const c = client();
  if (!c || !id) return () => {};
  const channel = c
    .channel(`${table}-${id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter: `id=eq.${id}` }, (payload) => onChange(payload.new))
    .subscribe();
  return () => {
    c.removeChannel(channel);
  };
}

// ---- wiring -----------------------------------------------------------------

const PUSH_DEBOUNCE_MS = 2500;
let pushTimer = null;

export function initCloudSync(store) {
  if (!isCloudConfigured()) return () => {};

  window.addEventListener('savelock:persist', () => {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushState(store).catch(() => {}), PUSH_DEBOUNCE_MS);
  });

  return onAuthStateChange((session) => {
    if (session) pushState(store).catch(() => {});
  });
}
