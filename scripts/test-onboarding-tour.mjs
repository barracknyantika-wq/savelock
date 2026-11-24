// Regression test for the one time onboarding tour and the first time vs
// returning account detection it depends on. Two things are verified
// separately, for real, not just read through:
//
// 1. The welcome tour is keyed to the local install/update marker, not to
//    the Supabase profile: both new and returning accounts see it.
// 2. The tour's own step mechanics (next() walking through every page,
//    finish() resetting state, and the awaited permission
//    prompts resolving into clear states before the user continues — these
//    need no network at all, so they're driven directly
//    against the real $store.tour.
//
// Requires a running preview server. Run with:
//   npm run build && npm run preview -- --port 4321
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

// ---- account state does not control the local install tour ---------------
{
  const page = await mockedPage(false);
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'brand-new-user-id' } };
    await auth.reconcile();
    return { stage: auth.stage, showTour: auth.showTour };
  });
  check(
    'a brand new account sees the local welcome tour',
    result.stage === 'ready' && result.showTour === true,
    JSON.stringify(result)
  );
  await page.close();
}

{
  const page = await mockedPage(true);
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'returning-user-id' } };
    await auth.reconcile();
    return { stage: auth.stage, showTour: auth.showTour };
  });
  check(
    'a returning account also sees the local welcome tour after an app update',
    result.stage === 'ready' && result.showTour === true,
    JSON.stringify(result)
  );
  await page.close();
}

// ---- tour step mechanics: finish the welcome tour -------------------------
{
  const page = await mockedPage(false);
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'x' } };
    await auth.reconcile();
    const tour = Alpine.store('tour');
    for (let i = 0; i < 8; i++) tour.next();
    await tour.finish();
    return { showTour: auth.showTour, step: Alpine.store('tour').step };
  });
  check('finishing all pages closes the welcome tour and resets its step', result.showTour === false && result.step === 0, JSON.stringify(result));
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
    for (let i = 0; i < 8; i++) {
      if (tour.current === 'today') await tour.askForSmsPermission();
      if (tour.current === 'inbox') await tour.askForReadSmsPermission();
      if (tour.current === 'settings') await tour.askForNotificationPermission();
      tour.next();
      seen.push(tour.current);
    }
    return seen;
  });
  check(
    'the tour visits every page and the inbox permission step in order',
    JSON.stringify(steps) === JSON.stringify(['welcome', 'today', 'inbox', 'goals', 'report', 'settings', 'groups', 'badges', 'account']),
    JSON.stringify(steps)
  );
  await page.close();
}

// ---- finishing the last step records the local tour version --------------
{
  const page = await mockedPage(false);
  const result = await page.evaluate(async () => {
    const auth = Alpine.store('auth');
    auth.session = { user: { id: 'x' } };
    await auth.reconcile();
    const tour = Alpine.store('tour');
    for (let i = 0; i < 8; i++) tour.next();
    await tour.finish();
    return {
      showTour: auth.showTour,
      step: tour.step,
      marker: localStorage.getItem('savelock:tour-version'),
      fingerprint: auth.tourFingerprint,
    };
  });
  check('finishing the tour closes it and saves a local version marker', result.showTour === false && result.step === 0 && result.marker === result.fingerprint, JSON.stringify(result));
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
    await tour.askForReadSmsPermission();
    const inbox = { status: tour.readPermissionStatus, step: tour.current };
    tour.next();
    tour.next();
    tour.next();
    await tour.askForNotificationPermission();
    return {
      sms,
      inbox,
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
    'READ_SMS prompt resolves while the inbox explanation remains visible',
    permissions.inbox.step === 'inbox' && permissions.inbox.status === 'unavailable',
    JSON.stringify(permissions.inbox)
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
