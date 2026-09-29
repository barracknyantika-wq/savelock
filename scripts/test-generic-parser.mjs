// Tests for the template-free engine. Every message here is SYNTHETIC
// (invented wording from a fictional "EXAMPLEBANK"), not a real bank template.
// Real inbox samples exported by the in-app scan should be added as new
// cases as they arrive.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../src/scripts/generic-sms-engine.js';

const vocab = JSON.parse(readFileSync(new URL('../src/scripts/finance-vocab.json', import.meta.url), 'utf8'));
const { parse } = createEngine(vocab);
const BANK = 'EXAMPLEBANK';

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ' + name);
  } catch (e) {
    console.error('FAIL ' + name + '\n     ' + e.message);
    process.exitCode = 1;
  }
}

t('bank debit alert: amount, balance, ref, account, auto tier', () => {
  const r = parse('EXAMPLEBANK: KES 15,000.00 debited from A/C XXXXXX1234 on 23/09/2026. Ref: FT26266ABCD. Available balance KES 45,210.55.', { sender: BANK });
  assert.equal(r.ok, true);
  assert.equal(r.tx.type, 'spend');
  assert.equal(r.tx.amount, 15000);
  assert.equal(r.tx.balance, 45210.55);
  assert.equal(r.tx.reference, 'FT26266ABCD');
  assert.equal(r.tx.accountLast4, '1234');
  assert.equal(r.tx.tier, 'auto');
});

t('credit alert: income, salary category', () => {
  const r = parse('EXAMPLEBANK: Dear customer, KES 85,000.00 has been credited to your account XXXX5678 on 25/09/2026. Narration: SALARY SEPT. Bal KES 90,120.10.', { sender: BANK });
  assert.equal(r.ok, true);
  assert.equal(r.tx.type, 'received');
  assert.equal(r.tx.amount, 85000);
  assert.equal(r.tx.incomeCategory, 'Salary');
  assert.equal(r.tx.balance, 90120.1);
  assert.equal(r.tx.category, null);
});

t('card purchase: counterparty and category', () => {
  const r = parse('EXAMPLEBANK: Card ending 4321 used at NAIVAS SUPERMARKET for KES 3,450.00 on 26/09/2026. Avail bal KES 20,000.00', { sender: BANK });
  assert.equal(r.ok, true);
  assert.equal(r.tx.counterparty, 'NAIVAS SUPERMARKET');
  assert.equal(r.tx.category, 'Food');
  assert.equal(r.tx.accountLast4, '4321');
});

t('rent payment is categorized as Rent', () => {
  const r = parse('EXAMPLEBANK: KES 25,000.00 debited from A/C XXXX8899 on 01/10/2026. Narration: RENT OCTOBER. Ref: TRX778899. Bal KES 60,000.00.', { sender: BANK });
  assert.equal(r.ok, true);
  assert.equal(r.tx.category, 'Rent');
  assert.equal(r.tx.amount, 25000);
});

t('fee and balance are not mistaken for the transaction amount', () => {
  const r = parse('EXAMPLEBANK: KES 1,000.00 withdrawn at ATM. Charge KES 33.00. Bal KES 9,000.00', { sender: BANK });
  assert.equal(r.ok, true);
  assert.equal(r.tx.amount, 1000);
  assert.equal(r.tx.balance, 9000);
});

t('OTP message is rejected', () => {
  const r = parse('EXAMPLEBANK: Your OTP is 482913 for a KES 5,000.00 payment to Jumia. Do not share.', { sender: BANK });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'otp');
});

t('real alert that mentions OTP in its footer is still accepted', () => {
  const r = parse('EXAMPLEBANK: KES 700.00 debited from A/C XXXX1111 on 27/09/2026. Bal KES 5,000.00. Never share your OTP with anyone.', { sender: BANK });
  assert.equal(r.ok, true);
  assert.equal(r.tx.amount, 700);
});

t('loan promo is rejected', () => {
  const r = parse('EXAMPLEBANK: Congratulations! You qualify for a loan of KES 50,000. Dial *123# to apply now.', { sender: BANK });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'promo');
});

t('failed transaction is rejected', () => {
  const r = parse('EXAMPLEBANK: Transaction of KES 2,000.00 failed due to insufficient funds.', { sender: BANK });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'failed_transaction');
});

t('balance-only message is rejected', () => {
  const r = parse('EXAMPLEBANK: Your available balance is KES 12,340.00.', { sender: BANK });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_transaction_amount');
});

t('personal text from a phone number is rejected', () => {
  const r = parse('I sent to you KES 500 for lunch', { sender: '+254712345678' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'low_confidence');
});

t('minimal credit is review tier, trusted sender lifts it to auto', () => {
  const msg = 'EXAMPLEBANK: KES 500 credited to your account';
  assert.equal(parse(msg, { sender: BANK }).tx.tier, 'review');
  assert.equal(parse(msg, { sender: BANK, trustedSenders: [BANK] }).tx.tier, 'auto');
});

t('same message gives the same dedup code, with and without a reference', () => {
  const withRef = 'EXAMPLEBANK: KES 15,000.00 debited from A/C XXXXXX1234. Ref: FT26266ABCD. Bal KES 100.00.';
  const noRef = 'EXAMPLEBANK: KES 500 credited to your account XXXX1234. Bal KES 100.00.';
  assert.equal(parse(withRef, { sender: BANK }).tx.mpesaCode, parse(withRef, { sender: BANK, receivedAtMs: 1 }).tx.mpesaCode);
  assert.ok(parse(withRef, { sender: BANK }).tx.mpesaCode.endsWith('FT26266ABCD'));
  assert.equal(parse(noRef, { sender: BANK }).tx.mpesaCode, parse(noRef, { sender: BANK, receivedAtMs: 2 }).tx.mpesaCode);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
