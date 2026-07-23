// Regression test for src/scripts/mpesa-parser.js (and its Kotlin mirror,
// android/.../MpesaParser.kt, kept in sync by hand — see that file's own
// header comment). Every case here is either a real M-Pesa SMS that was
// once silently missed, or a documented/real-world Safaricom message shape
// close enough to one that the same gap could plausibly hit it too. Run
// with: node scripts/test-mpesa-parser.mjs
//
// Root cause of the bug this file guards against: the "sent to"/"received
// from" rules required a phone number between the counterparty's name and
// "on <date>". Two real shapes broke that assumption: (1) some messages
// omit the number entirely ("sent to douglas moseti on 23/7/26..."), and
// (2) Safaricom's March 2026 number-masking privacy feature replaces some
// digits with "*" ("0705***734"), which the old \d-only pattern couldn't
// match either — not a total miss in that case, but the masked number got
// swallowed into the captured counterparty name instead of being excluded.

import { parseMpesaSms } from '../src/scripts/mpesa-parser.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- The exact two real messages from the bug report --------------------

const DETECTED_SMS =
  'UGN50032AC Confirmed. Ksh10.00 sent to betty mwenda 0757694673 on 23/7/26 at 7:16 AM. New M-PESA balance is Ksh552.99. Transaction cost, Ksh0.00. Amount you can transact within the day is 499,910.00. Download My OneApp on https://saf.cx/lPKcC';

const MISSED_SMS =
  'UGN5002YER Confirmed. Ksh50.00 sent to douglas moseti on 23/7/26 at 7:24 AM. New M-PESA balance is Ksh502.99. Transaction cost, Ksh0.00. Amount you can transact within the day is 499,860.00. Download My OneApp on https://saf.cx/kWQpy';

{
  const tx = parseMpesaSms(DETECTED_SMS);
  check('already-working case: "sent to NAME <phone> on" still parses', !!tx, JSON.stringify(tx));
  if (tx) {
    check('  type/subtype is spend/send', tx.type === 'spend' && tx.subtype === 'send');
    check('  counterparty is "betty mwenda" (no phone number bleeding in)', tx.counterparty === 'betty mwenda', tx.counterparty);
    check('  amount is 10', tx.amount === 10, tx.amount);
    check('  mpesaCode is UGN50032AC', tx.mpesaCode === 'UGN50032AC', tx.mpesaCode);
  }
}

{
  const tx = parseMpesaSms(MISSED_SMS);
  check('THE REAL MISSED MESSAGE: "sent to NAME on" (no phone number) now parses', !!tx, JSON.stringify(tx));
  if (tx) {
    check('  type/subtype is spend/send', tx.type === 'spend' && tx.subtype === 'send');
    check('  counterparty is "douglas moseti", not swallowing "on 23/7/26..." too', tx.counterparty === 'douglas moseti', tx.counterparty);
    check('  amount is 50', tx.amount === 50, tx.amount);
    check('  mpesaCode is UGN5002YER', tx.mpesaCode === 'UGN5002YER', tx.mpesaCode);
  }
}

// ---- Sibling gap found during the audit: Safaricom's masked phone number
// feature (live since March 2026) replaces digits with "*"
// ("0705***734", "0722*000**", "0722***100" are all real documented
// examples), which the old \d-only pattern also couldn't match — the
// masked number would get captured as part of the name instead of excluded.

{
  const tx = parseMpesaSms(
    'TAB123XYZ9 Confirmed. Ksh200.00 sent to john kamau 0705***734 on 23/7/26 at 8:00 AM. New M-PESA balance is Ksh1,000.00. Transaction cost, Ksh0.00.'
  );
  check('a masked phone number (0705***734) does not get swallowed into the name', !!tx, JSON.stringify(tx));
  check('  counterparty is "john kamau", masked number excluded', tx?.counterparty === 'john kamau', tx?.counterparty);
}

{
  const tx = parseMpesaSms(
    'TAB456XYZ8 Confirmed. Ksh75.00 sent to alice njeri 0722*000** on 23/7/26 at 8:10 AM. New M-PESA balance is Ksh925.00. Transaction cost, Ksh0.00.'
  );
  check('a differently-shaped masked number (0722*000**) does not get swallowed into the name', !!tx, JSON.stringify(tx));
  check('  counterparty is "alice njeri", masked number excluded', tx?.counterparty === 'alice njeri', tx?.counterparty);
}

// ---- The mirror-image "received from" rule has the identical structure,
// so it needed the identical fix. Covers: full international-format phone
// (a real, older-era, still-valid message shape), a masked phone number,
// and no phone number at all.

{
  const tx = parseMpesaSms(
    'QHX7AB12CD Confirmed. You have received Ksh1,250.00 from JANE ATIENO 254712345678 on 23/7/26 at 9:00 AM New M-PESA balance is Ksh2,000.00.'
  );
  check('received-from with an international-format phone number still parses', !!tx, JSON.stringify(tx));
  check('  type is received', tx?.type === 'received', tx?.type);
  check('  counterparty is "JANE ATIENO"', tx?.counterparty === 'JANE ATIENO', tx?.counterparty);
}

{
  const tx = parseMpesaSms(
    'RCV456TEST Confirmed. You have received Ksh300.00 from PETER OTIENO 0722*000** on 23/7/26 at 10:00 AM New M-PESA balance is Ksh800.00.'
  );
  check('received-from with a masked phone number now parses correctly', !!tx, JSON.stringify(tx));
  check('  counterparty is "PETER OTIENO", masked number excluded', tx?.counterparty === 'PETER OTIENO', tx?.counterparty);
}

{
  const tx = parseMpesaSms(
    'RCV789TEST Confirmed. You have received Ksh75.00 from MARY WANJIKU on 23/7/26 at 11:00 AM New M-PESA balance is Ksh900.00.'
  );
  check('received-from with no phone number at all now parses', !!tx, JSON.stringify(tx));
  check('  counterparty is "MARY WANJIKU"', tx?.counterparty === 'MARY WANJIKU', tx?.counterparty);
}

// ---- Audited and confirmed NOT affected: paybill/till/withdraw have no
// required phone-number segment in their rules to begin with, so the same
// class of gap can't hit them. Kept here so a future edit that tightens
// these rules gets caught if it accidentally introduces the same mistake.

{
  const tx = parseMpesaSms(
    'PAY123ABC4 Confirmed. Ksh4,000.00 sent to KCB PAYBILL for account 1137238445 on 23/7/26 at 12:00 PM New M-PESA balance is Ksh22.00.'
  );
  check('paybill payments (no phone segment) are unaffected', !!tx && tx.subtype === 'paybill', JSON.stringify(tx));
}

{
  const tx = parseMpesaSms('TIL123ABC4 Confirmed. Ksh50.00 paid to NAIVAS SUPERMARKET on 23/7/26 at 1:00 PM New M-PESA balance is Ksh450.00.');
  check('till payments (no phone segment) are unaffected', !!tx && tx.subtype === 'till', JSON.stringify(tx));
}

{
  const tx = parseMpesaSms(
    'WDR123ABC4 Confirmed. Ksh2,000.00 withdrawn from 129324 - Brothers Link Agency on 23/7/26 at 2:00 PM New M-PESA balance is Ksh570.00.'
  );
  check('agent withdrawals (already-tolerant capture) are unaffected', !!tx && tx.subtype === 'withdraw', JSON.stringify(tx));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
