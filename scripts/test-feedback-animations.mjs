// Regression test for the feedback animations/haptics added to SaveLock:
// the spend-logging ink-blot flash (manual and SMS-detected alike), the
// streak sprout motif, that the haptic helpers never throw when called
// outside a native shell (there is no Capacitor native layer in this
// sandbox, or in a plain browser install, so isNative() is false and every
// Haptics call must silently no-op), and the sign-in screen's copy.
//
// The interactive checks (spend logging, streak sprout, haptics) need
// actual app content reachable, which the mandatory sign-in gate blocks
// entirely on a cloud-configured build (see Layout.astro), so this test
// checks which build it's pointed at first and runs only the checks that
// build variant can actually reach, same convention as this project's
// other cloud-only tests.
//
// Requires a running preview server (npm run build && npm run preview,
// port 4321) — this drives a real browser via Playwright, unlike
// scripts/test-mpesa-parser.mjs which needs nothing but node.
// Run with: node scripts/test-feedback-animations.mjs

import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, reason) {
  console.log(`SKIP  ${name} — ${reason}`);
}

// No hardcoded executablePath: Playwright resolves its own managed browser
// install on whatever machine this actually runs on. Run
// `npx playwright install chromium` once first if you've never used
// Playwright on this machine before. PLAYWRIGHT_CHROMIUM_PATH is an escape
// hatch for CI images/sandboxes that pre-cache a specific Chromium binary
// instead of letting Playwright manage its own.
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });

const probe = await (await browser.newContext()).newPage();
await probe.goto(BASE + '/', { waitUntil: 'networkidle' });
const cloudConfigured = await probe.evaluate(() => Alpine.store('auth').cloudConfigured);
await probe.close();

if (!cloudConfigured) {
  // ---- Manual spend logging: flashes then clears, ink blot becomes visible --
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.fill('#limit-input', '500');
    await page.click('button:has-text("Start")');
    await page.waitForSelector('text=Left today');

    const spendId = await page.evaluate(() => {
      const s = Alpine.store('sl');
      const spend = s.logSpend(100, 'lunch', 'Food');
      return spend.id;
    });

    const flashedId = await page.evaluate(() => Alpine.store('sl').lastSpendId);
    check('logSpend() flashes the newly logged spend', flashedId === spendId, flashedId);

    const inkBlotVisible = await page.locator('li:has-text("KSh 100") >> div.animate-ink-pop').first().isVisible();
    check('the ink blot overlay is actually visible on that list item right after logging', inkBlotVisible);

    await page.waitForTimeout(1100);
    const clearedId = await page.evaluate(() => Alpine.store('sl').lastSpendId);
    check('the flash clears itself on its own shortly after', clearedId === null, clearedId);

    await page.close();
  }

  // ---- SMS-detected spend gets the same flash as a manual one ---------------
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.fill('#limit-input', '500');
    await page.click('button:has-text("Start")');
    await page.waitForSelector('text=Left today');

    const result = await page.evaluate(() => {
      const s = Alpine.store('sl');
      const [record] = s.drainNativeTransactions([
        { mpesaCode: 'FLASH001', type: 'spend', subtype: 'till', amount: 60, counterparty: 'SHOP X', receivedAt: Date.now() },
      ]);
      return { recordId: record?.id, flashedId: s.lastSpendId };
    });
    check(
      'an SMS-detected spend gets the same just-logged flash as a manual one',
      !!result.recordId && result.flashedId === result.recordId,
      JSON.stringify(result)
    );

    await page.close();
  }

  // ---- Streak sprout: visibly different content at 0 vs a real streak -------
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.fill('#limit-input', '500');
    await page.click('button:has-text("Start")');
    await page.waitForSelector('text=Left today');

    const sproutHtmlAtZero = await page.locator('[aria-hidden="true"] svg[viewBox^="0 0 40"]').first().innerHTML();

    await page.evaluate(() => {
      Alpine.store('sl').streak.count = 7;
    });
    await page.waitForTimeout(50);
    const sproutHtmlAtSeven = await page.locator('[aria-hidden="true"] svg[viewBox^="0 0 40"]').first().innerHTML();

    check('the streak sprout redraws with different markup once the streak grows', sproutHtmlAtZero !== sproutHtmlAtSeven);
    check(
      'reaching the 7-day mark adds the blossom (a distinct visual step, not just more leaves)',
      sproutHtmlAtSeven.includes('circle') && sproutHtmlAtSeven.length > sproutHtmlAtZero.length,
      `${sproutHtmlAtZero.length} -> ${sproutHtmlAtSeven.length}`
    );

    await page.close();
  }

  // ---- Haptics never throw outside a native shell (no Capacitor layer here) -
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.fill('#limit-input', '500');
    await page.click('button:has-text("Start")');
    await page.waitForSelector('text=Left today');

    // $haptic is an Alpine magic, only callable from within an Alpine
    // expression context, not directly via page.evaluate — exercise it the
    // same way a template would, through a real x-data scope's evaluator.
    await page.evaluate(() => {
      const el = document.querySelector('[x-data="todayPage"]');
      return Alpine.evaluate(el, '$haptic.tap(); $haptic.success(); $haptic.celebrate();');
    });
    await page.waitForTimeout(200);
    check('calling every haptic tier outside a native shell never throws', errors.length === 0, errors.join(' | '));

    await page.close();
  }

  skip('sign-in screen copy checks', 'this build has no Supabase project configured, the gate never shows');
} else {
  for (const name of [
    'logSpend() flashes the newly logged spend',
    'the ink blot overlay is actually visible on that list item right after logging',
    'the flash clears itself on its own shortly after',
    'an SMS-detected spend gets the same just-logged flash as a manual one',
    'the streak sprout redraws with different markup once the streak grows',
    'reaching the 7-day mark adds the blossom (a distinct visual step, not just more leaves)',
    'calling every haptic tier outside a native shell never throws',
  ]) {
    skip(name, 'requires app content the mandatory sign-in gate blocks on a cloud-configured build');
  }

  // ---- Sign-in screen welcomes both new and returning users ------------------
  {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const bodyText = await page.locator('body').innerText();
    check('the sign-in heading welcomes rather than assuming a returning user', bodyText.includes('Welcome to SaveLock'));
    check('the copy explicitly addresses a first-time visitor', bodyText.includes('New here?'));
    check('the copy also explicitly addresses a returning user', bodyText.includes('Already have an account?'));
    await page.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
