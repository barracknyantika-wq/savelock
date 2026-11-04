// Regression test for the one time onboarding tour and the first time vs
// returning account detection it depends on. Two things are verified
// separately, for real, not just read through:
//
// 1. reconcile()'s wiring: the real, unmodified reconcile() in app.js is
//    called directly (after manually setting a fake signed in session,
//    since a real phone OTP round trip needs a live Supabase project this
//    sandbox does not have), with only the network transport faked via
//    Playwright route interception so it hits a controlled
//    tour_seen response instead of a real database. This proves showTour
//    actually comes out true for a brand new account and false for one
//    that already saw it, through the real code path, not a
//    reimplementation of the logic.
// 2. The tour's own step mechanics (skip from any step, next() walking
//    through in order, finish() resetting state, and the awaited permission
//    prompts resolving into clear states before the user continues — these
//    need no network at all, so they're driven directly
//    against the real $store.tour.
//
// Requires a running preview server built WITH Supabase env vars set
// (PUBLIC_SUPABASE_URL/PUBLIC_SUPABASE_ANON_KEY), since the tour only
// exists at all on a cloud configured build. Run with:
//   PUBLIC_SUPABASE_URL=... PUBLIC_SUPABASE_ANON_KEY=... npm run build
//   npm run preview -- --port 4321
//   node scripts/test-onboarding-tour.mjs

import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });

async function mockedPage(tourSeenValue) {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.route('**/rest/v1/settings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
  await page.route('**/rest/v1/goals*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' })
  );
  await page.route('**/rest/v1/profiles*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tour_seen: tourSeenValue }) })
  );
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  return page;
}

// ---- reconcile() wiring: brand new account (tour_seen false) -------------
{
  const page = await mockedPage(false);
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'brand-new-user-id' } };
    await auth.reconcile();
    return { stage: auth.stage, showTour: auth.showTour };
  });
  check(
    'a brand new account (tour_seen false) reaches ready with showTour true',
    result.stage === 'ready' && result.showTour === true,
    JSON.stringify(result)
  );
  await page.close();
}

// ---- reconcile() wiring: returning account (tour_seen true) --------------
{
  const page = await mockedPage(true);
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'returning-user-id' } };
    await auth.reconcile();
    return { stage: auth.stage, showTour: auth.showTour };
  });
  check(
    'a returning account (tour_seen true) reaches ready with showTour false',
    result.stage === 'ready' && result.showTour === false,
    JSON.stringify(result)
  );
  await page.close();
}

// ---- tour step mechanics: skip from the very first step ------------------
{
  const page = await mockedPage(false);
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'x' } };
    await auth.reconcile();
    Alpine.store('tour').skip();
    return { showTour: auth.showTour, step: Alpine.store('tour').step };
  });
  check('skipping from the developer letter closes the tour and resets its step', result.showTour === false && result.step === 0, JSON.stringify(result));
  await page.close();
}

// ---- tour step mechanics: permissions resolve before continuing ----------
{
  const page = await mockedPage(false);
  const steps = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'x' } };
    await auth.reconcile();
    const tour = Alpine.store('tour');
    const seen = [tour.current];
    for (let i = 0; i < 5; i++) {
      if (tour.current === 'today') await tour.askForSmsPermission();
      if (tour.current === 'settings') await tour.askForNotificationPermission();
      tour.next();
      seen.push(tour.current);
    }
    return seen;
  });
  check(
    'the tour walks Today, Goals, Report, Settings, Groups in that exact order',
    JSON.stringify(steps) === JSON.stringify(['letter', 'today', 'goals', 'report', 'settings', 'groups']),
    JSON.stringify(steps)
  );
  await page.close();
}

// ---- finishing the last step marks tour_seen and closes the overlay ------
{
  const page = await mockedPage(false);
  let markCalled = false;
  await page.route('**/rest/v1/profiles*', async (route) => {
    if (route.request().method() === 'PATCH') {
      markCalled = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tour_seen: false }) });
  });
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'x' } };
    await auth.reconcile();
    const tour = Alpine.store('tour');
    for (let i = 0; i < 5; i++) tour.next();
    await tour.finish();
    return { showTour: auth.showTour, step: tour.step };
  });
  check('finishing the tour marks tour_seen on the account and closes the overlay', result.showTour === false && result.step === 0, JSON.stringify(result));
  check('finishing the tour actually called markTourSeen against the account', markCalled);
  await page.close();
}

// ---- permission prompts resolve in place before the next step -----------
{
  const page = await mockedPage(false);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const permissions = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'x' } };
    await auth.reconcile();
    const tour = Alpine.store('tour');
    tour.next();
    await tour.askForSmsPermission();
    const sms = { status: tour.smsPermissionStatus, step: tour.current };
    tour.next();
    tour.next();
    tour.next();
    await tour.askForNotificationPermission();
    return {
      sms,
      notification: { status: tour.notificationPermissionStatus, step: tour.current },
    };
  });
  check('awaited permission requests complete without throwing', errors.length === 0, errors.join(' | '));
  check(
    'SMS prompt resolves while the Today explanation remains visible',
    permissions.sms.step === 'today' && permissions.sms.status === 'unavailable',
    JSON.stringify(permissions.sms)
  );
  check(
    'notification prompt resolves while the Settings explanation remains visible',
    permissions.notification.step === 'settings' && permissions.notification.status === 'unavailable',
    JSON.stringify(permissions.notification)
  );
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
