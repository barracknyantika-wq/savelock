// Regression test for the savings streak and per goal streak added to
// store.js: both mirror the existing budget streak.count's rollover/break
// on miss shape, extended by one on a day with recorded progress, broken
// to zero on a day without. Verifies the actual mechanism (backdating
// day.date and letting a real rollover() run, the same technique the
// older verify.mjs suite already uses for the budget streak) rather than
// just reading the code, plus the specific rule that a decrease (a
// correction, or a withdrawal flowing through the same updateSaved() call)
// must never count as progress.
//
// Requires a running preview server (npm run build && npm run preview,
// port 4321). Run with: node scripts/test-streaks.mjs

import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.fill('#limit-input', '500');
await page.click('button:has-text("Start")');
await page.waitForSelector('text=Left today');

// Add a goal, log initial progress today (should NOT extend any count yet,
// today is still open).
const setup = await page.evaluate(() => {
  const s = Alpine.store('sl');
  s.addGoal('Trip', 10000, '2030-01-01');
  const goalId = s.goals[0].id;
  const milestones = s.updateSaved(goalId, 1000);
  return {
    goalId,
    savingsCount: s.savingsStreak.count,
    goalCount: s.goals[0].streak.count,
    savingsLastProgress: s.savingsStreak.lastProgressDate,
    goalLastProgress: s.goals[0].streak.lastProgressDate,
    todayStr: s.day.date,
  };
});
check('logging progress today marks lastProgressDate but does not extend count yet', setup.savingsCount === 0 && setup.goalCount === 0 && setup.savingsLastProgress === setup.todayStr && setup.goalLastProgress === setup.todayStr, JSON.stringify(setup));

// Backdate day.date to yesterday, and set the progress marker to that same
// yesterday date, then reload so rollover() closes exactly that one day.
const yesterdayResult = await page.evaluate((goalId) => {
  const raw = JSON.parse(localStorage.getItem('savelock:v1'));
  const y = new Date(Date.now() - 86400000);
  const ys = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  raw.day.date = ys;
  raw.savingsStreak = { count: 0, lastProgressDate: ys };
  const g = raw.goals.find((x) => x.id === goalId);
  g.streak = { count: 0, longest: 0, lastProgressDate: ys };
  localStorage.setItem('savelock:v1', JSON.stringify(raw));
  return ys;
}, setup.goalId);

await page.goto(BASE + '/', { waitUntil: 'networkidle' });
const afterOneDay = await page.evaluate((goalId) => {
  const s = Alpine.store('sl');
  return { savingsCount: s.savingsStreak.count, goalCount: s.goals.find((g) => g.id === goalId).streak.count };
}, setup.goalId);
check('a day with progress extends both the savings streak and the goal streak by one', afterOneDay.savingsCount === 1 && afterOneDay.goalCount === 1, JSON.stringify(afterOneDay));

// Now backdate again, but this time with no matching progress marker at
// all for the newly closing day — the streak should break back to zero.
// lastProgressDate is explicitly cleared here (rather than left at
// yesterday's date from the previous step) because day.date only ever
// advances forward in real usage — a specific calendar date is only ever
// processed by rollover() once, so rewinding to a date already closed
// (as a naive version of this test would) is not a scenario that can
// happen for real, only an artifact of poking at localStorage directly.
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('savelock:v1'));
  const y = new Date(Date.now() - 86400000);
  const ys = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  raw.day.date = ys;
  raw.savingsStreak.lastProgressDate = null;
  for (const g of raw.goals) if (g.streak) g.streak.lastProgressDate = null;
  localStorage.setItem('savelock:v1', JSON.stringify(raw));
});
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
const afterMiss = await page.evaluate((goalId) => {
  const s = Alpine.store('sl');
  return { savingsCount: s.savingsStreak.count, goalCount: s.goals.find((g) => g.id === goalId).streak.count };
}, setup.goalId);
check('a day with no progress breaks both streaks back to zero', afterMiss.savingsCount === 0 && afterMiss.goalCount === 0, JSON.stringify(afterMiss));

// A decrease (simulating a withdrawal or a downward correction) must not
// mark progress at all.
const decreaseResult = await page.evaluate((goalId) => {
  const s = Alpine.store('sl');
  s.savingsStreak.lastProgressDate = null;
  const g = s.goals.find((x) => x.id === goalId);
  g.streak.lastProgressDate = null;
  s.updateSaved(goalId, 500); // less than the goal's current 1000
  return { savingsLastProgress: s.savingsStreak.lastProgressDate, goalLastProgress: g.streak.lastProgressDate };
}, setup.goalId);
check('decreasing a goal\'s saved amount does not mark savings progress', decreaseResult.savingsLastProgress === null && decreaseResult.goalLastProgress === null, JSON.stringify(decreaseResult));

// A second, untouched goal must never have its streak extended by another
// goal's progress.
const secondGoalResult = await page.evaluate(() => {
  const s = Alpine.store('sl');
  s.addGoal('Other goal', 5000, '2030-01-01');
  const other = s.goals.find((g) => g.name === 'Other goal');
  return { hasStreak: !!other.streak, count: other.streak.count };
});
check('a second, untouched goal starts with its own independent zero streak', secondGoalResult.hasStreak && secondGoalResult.count === 0, JSON.stringify(secondGoalResult));

await page.close();
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
