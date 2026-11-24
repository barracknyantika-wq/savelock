import assert from 'node:assert/strict';
import { registerStore, todayStr } from '../src/scripts/store.js';

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.get(key) ?? null; },
  setItem(key, value) { storage.set(key, String(value)); },
};
globalThis.window = { dispatchEvent() {} };
globalThis.document = { addEventListener() {} };
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};

const stores = {};
registerStore({ store(name, value) { stores[name] = value; } });
const state = stores.sl;
const receivedAt = Date.now();
const transaction = (smsId, smsContentHash, type = 'spend') => ({
  mpesaCode: 'same-classifier-code',
  smsId,
  smsContentHash,
  type,
  amount: 25,
  counterparty: 'Test',
  category: 'Food',
  receivedAt,
});

state.recordNativeTransaction(transaction('sms-1', 'hash-one'));
state.recordNativeTransaction(transaction('sms-2', 'hash-two'));
state.recordNativeTransaction(transaction(null, 'hash-one'));
assert.equal(state.day.date, todayStr());
assert.equal(state.day.spends.length, 2, 'distinct SMS IDs/hashes count even if classifier codes match');

state.recordNativeTransaction(transaction('sms-3', 'hash-reminder', 'loan_reminder'));
state.recordNativeTransaction(transaction(null, 'hash-reminder', 'loan_reminder'));
assert.equal(state.loanReminders.length, 1, 'a receiver/inbox copy of a reminder is retained once');
assert.equal(state.day.spends.length, 2, 'loan reminders never enter spending records');
assert.ok(state.processedSmsIdentities.includes('hash-one'));
assert.ok(state.processedSmsIdentities.includes('sms-1:hash-one'));

console.log('Passed SMS ID/content-hash dedupe for broadcast, inbox, repeated classifier codes, and private loan reminders.');
