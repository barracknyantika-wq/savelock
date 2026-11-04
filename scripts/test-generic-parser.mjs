import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine, senderCategory } from '../src/scripts/generic-sms-engine.js';
import { registerStore } from '../src/scripts/store.js';

const vocab = JSON.parse(readFileSync(new URL('../src/scripts/finance-vocab.json', import.meta.url), 'utf8'));
const cases = JSON.parse(readFileSync(new URL('../android/app/src/test/resources/generic-sms-cases.json', import.meta.url), 'utf8'));
const { parse } = createEngine(vocab);

for (const sample of cases) {
  const result = parse(sample.body, { sender: sample.sender, receivedAtMs: 1 });
  assert.equal(result.ok, true, sample.name);
  assert.equal(result.tx.type, sample.type, sample.name);
  assert.equal(result.tx.amount, sample.amount, sample.name);
}

assert.equal(senderCategory('EQUITYBANK'), 'bank');
assert.equal(senderCategory('KORO-REPAY'), 'lending');
assert.equal(parse('Your account has received KES 500.', { sender: 'EQUITYBANK' }).ok, false, 'bare received must not classify');

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
};
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class CustomEvent {};
let store;
registerStore({ store(_name, value) { store = value; } });
const reminder = parse(cases[2].body, { sender: cases[2].sender, receivedAtMs: 1 }).tx;
assert.equal(store.recordNativeTransaction(reminder), null);
assert.equal(store.loanReminders.length, 1);
assert.equal(store.day.spends.length, 0);
assert.equal(store.incomeLog.length, 0);
assert.equal(store.notifications.length, 0);
assert.equal(store.categoryBreakdown(30).length, 0);
store.settings.dailyLimit = 1000;
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
store.day.date = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
store.rollover();
assert.equal(store.history[0].spent, 0);
assert.equal(store.streak.count, 1, 'a loan reminder must not affect budget streaks');
assert.equal(store.categoryBreakdown(30).length, 0, 'a loan reminder must not appear in reports');
store.logSpend(1001, 'classified expense', 'Other');
assert.equal(store.spentToday, 1001);
assert.equal(store.budgetStreakStatus, 'broken', 'classified expenses over the daily limit break today status');

console.log(`Passed ${cases.length} shared SMS fixtures and loan-reminder exclusion checks.`);
