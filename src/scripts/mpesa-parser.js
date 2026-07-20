// Parses Safaricom M-Pesa confirmation SMS into a structured transaction.
// Deliberately conservative: returns null rather than guess when a message
// doesn't clearly match a known template, since a wrong auto-log is worse
// than a missed one. The Android SmsReceiver (android/.../SmsReceiver.kt)
// mirrors this exact rule set in Kotlin — keep the two in sync by hand,
// there's no shared runtime between them.
//
// Every real M-Pesa SMS opens with a unique transaction code
// ("TJB2K3L4M5 Confirmed. ...") — that code is the dedup key everywhere
// in this app, native and web alike, so the same SMS can never be logged
// twice even if the OS redelivers the broadcast.

export const MPESA_SENDER_IDS = ['MPESA'];

const CODE_RE = /\b([A-Z][A-Z0-9]{8,11})\b\s+Confirmed/;
const AMOUNT_RE = /Ksh\s?([\d,]+(?:\.\d{2})?)/i;
const BALANCE_RE = /(?:new\s+)?m-pesa balance is ksh\s?([\d,]+(?:\.\d{2})?)/i;

// Fuliza (M-Pesa's overdraft) messages don't fit the plain "X paid to Y"
// shape. A Fuliza-covered purchase rides on a normal Confirmed transaction
// message (still parsed by RULES below) but adds a sentence saying part of
// it was covered by Fuliza — that's an overlay, not a different message.
// Repayment/activation/interest are genuinely separate message types with
// no spend of their own, so they must never be recorded as one.
const FULIZA_USED_RE =
  /fuliza\s*m-pesa\s*amount\s*used\s*to\s*complete\s*(?:this|your)\s*transaction\s*is\s*ksh\s?([\d,]+(?:\.\d{2})?)/i;
const FULIZA_USED_ALT_RE = /fuliza\s*m-pesa\s*amount\s*of\s*ksh\s?([\d,]+(?:\.\d{2})?)\s*has\s*been\s*used/i;
const FULIZA_OUTSTANDING_RE = /fuliza\s*m-pesa\s*outstanding\s*(?:amount|balance)\s*is\s*ksh\s?([\d,]+(?:\.\d{2})?)/i;
const FULIZA_REPAYMENT_RE = /ksh\s?([\d,]+(?:\.\d{2})?)[^.]*?used\s*to\s*(?:fully|partially)?\s*pay\s*your\s*outstanding\s*fuliza\s*m-pesa/i;
const FULIZA_REPAYMENT_ANCHOR_RE = /used\s*to\s*(?:fully|partially)?\s*pay\s*your\s*outstanding\s*fuliza\s*m-pesa/i;
const FULIZA_ACTIVATED_RE = /(?:activated\s*for\s*fuliza\s*m-pesa|fuliza\s*m-pesa\s*has\s*been\s*activated)/i;
const FULIZA_LIMIT_RE = /fuliza\s*m-pesa\s*limit\s*is\s*ksh\s?([\d,]+(?:\.\d{2})?)/i;
const FULIZA_INTEREST_RE =
  /(?:maintenance|access)\s*fee\s*of\s*ksh\s?([\d,]+(?:\.\d{2})?)[^.]*?(?:charged|fuliza)/i;

// No transaction code to dedup on for the code-less Fuliza messages
// (activation, interest/maintenance fee) — derive a stable synthetic one
// from the message text so the same SMS still can't be double-processed.
function syntheticCode(prefix, text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return `${prefix}${(h >>> 0).toString(36).toUpperCase()}`;
}

function matchFulizaUsed(text) {
  return num(text.match(FULIZA_USED_RE)?.[1]) ?? num(text.match(FULIZA_USED_ALT_RE)?.[1]);
}

// Fuliza-only messages that never carry the standard "<CODE> Confirmed"
// transaction wrapper. Checked before the regular gate below, since
// requiring "Confirmed" would otherwise reject them outright.
function parseStandaloneFuliza(text, receivedAtMs) {
  if (FULIZA_ACTIVATED_RE.test(text)) {
    return {
      mpesaCode: syntheticCode('FZACT', text),
      type: 'fuliza_activation',
      subtype: 'fuliza_activation',
      amount: num(text.match(FULIZA_LIMIT_RE)?.[1]) ?? 0,
      counterparty: 'Fuliza M-PESA',
      category: null,
      balance: null,
      receivedAt: receivedAtMs,
      viaFuliza: false,
      fulizaAmount: null,
    };
  }
  const interest = num(text.match(FULIZA_INTEREST_RE)?.[1]);
  if (interest !== null && /fuliza/i.test(text)) {
    return {
      mpesaCode: syntheticCode('FZINT', text),
      type: 'fuliza_interest',
      subtype: 'fuliza_interest',
      amount: interest,
      counterparty: 'Fuliza M-PESA',
      category: null,
      balance: null,
      receivedAt: receivedAtMs,
      viaFuliza: false,
      fulizaAmount: null,
    };
  }
  return null;
}

function num(matchGroup) {
  if (!matchGroup) return null;
  const n = parseFloat(matchGroup.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function clean(name) {
  return name.replace(/\.$/, '').replace(/\s+/g, ' ').trim();
}

// Each rule: [type, subtype, matcher]. Matcher returns the counterparty
// string, or null if this rule doesn't apply. Tried in order; first hit wins.
const RULES = [
  [
    'received',
    'receive',
    (body) => {
      const m = body.match(/received\s+ksh[\d,.]+\s+from\s+(.+?)\s+(?:0\d{6,12}|\d{9,12})\s+on\s/i);
      return m ? clean(m[1]) : null;
    },
  ],
  [
    'spend',
    'paybill',
    (body) => {
      const m = body.match(/sent\s+to\s+(.+?)\s+for account\s+.+?\s+on\s/i);
      return m ? clean(m[1]) : null;
    },
  ],
  [
    'spend',
    'send',
    (body) => {
      const m = body.match(/sent\s+to\s+(.+?)\s+(?:0\d{6,12}|\d{9,12})\s+on\s/i);
      return m ? clean(m[1]) : null;
    },
  ],
  [
    'spend',
    'till',
    (body) => {
      const m = body.match(/paid\s+to\s+(.+?)\s+on\s/i);
      return m ? clean(m[1]) : null;
    },
  ],
  [
    'spend',
    'withdraw',
    (body) => {
      // Tolerates both real-world orderings seen in agent-withdrawal SMS:
      // "Ksh2,000.00 withdrawn from X" and "withdrawn Ksh2,000.00 from X".
      const m = body.match(/(?:ksh[\d,.]+\s+)?withdrawn\s+(?:ksh[\d,.]+\s+)?from\s+(.+?)\s+on\s/i);
      return m ? clean(m[1]) : null;
    },
  ],
  [
    'spend',
    'airtime',
    (body) => (/bought\s+ksh[\d,.]+\s+of\s+airtime/i.test(body) ? 'Airtime' : null),
  ],
];

// Best-effort category guess from the counterparty name, for spends only —
// always overridable by the user, never trusted blindly. Order matters:
// first matching rule wins. Falls back to "Other" rather than a wrong guess.
const CATEGORY_RULES = [
  ['Transport', /\b(uber|bolt|little cab|matatu|sgr|shuttle|taxi)\b/i],
  ['Bills', /\b(kplc|nairobi water|dstv|gotv|startimes|zuku|utility|utilities)\b/i],
  ['Food', /\b(java|kfc|pizza|naivas|quickmart|carrefour|tuskys|chandarana|supermarket|restaurant|eatery|hotel|cafe|butchery|bakery)\b/i],
  ['Shopping', /\b(shop|mall|store|boutique|mart)\b/i],
];

export function guessCategory(counterparty, subtype) {
  if (subtype === 'airtime') return 'Airtime';
  if (subtype === 'withdraw') return 'Other';
  const name = counterparty || '';
  for (const [category, re] of CATEGORY_RULES) {
    if (re.test(name)) return category;
  }
  return 'Other';
}

export function parseMpesaSms(body, receivedAtMs = Date.now()) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/\s+/g, ' ').trim();

  const standaloneFuliza = parseStandaloneFuliza(text, receivedAtMs);
  if (standaloneFuliza) return standaloneFuliza;

  if (!/confirmed/i.test(text)) return null;
  const codeMatch = text.match(CODE_RE);
  const amountMatch = text.match(AMOUNT_RE);
  if (!codeMatch || !amountMatch) return null;

  const amount = num(amountMatch[1]);
  if (!amount || amount <= 0) return null;

  // Fuliza repayment rides on the normal Confirmed/code wrapper (money moving
  // is what triggers it) but it's clearing a past debt, not a new expense —
  // checked before RULES so it can't be misread as a spend or a plain receive.
  if (FULIZA_REPAYMENT_ANCHOR_RE.test(text)) {
    const repaid = num(text.match(FULIZA_REPAYMENT_RE)?.[1]) ?? amount;
    return {
      mpesaCode: codeMatch[1],
      type: 'fuliza_repayment',
      subtype: 'fuliza_repayment',
      amount: repaid,
      counterparty: 'Fuliza M-PESA',
      category: null,
      balance: num(text.match(BALANCE_RE)?.[1]),
      receivedAt: receivedAtMs,
      viaFuliza: false,
      fulizaAmount: null,
    };
  }

  for (const [type, subtype, matcher] of RULES) {
    const counterparty = matcher(text);
    if (counterparty) {
      const fulizaAmount = type === 'spend' ? matchFulizaUsed(text) : null;
      return {
        mpesaCode: codeMatch[1],
        type,
        subtype,
        amount,
        counterparty,
        category: type === 'spend' ? guessCategory(counterparty, subtype) : null,
        balance: num(text.match(BALANCE_RE)?.[1]),
        receivedAt: receivedAtMs,
        viaFuliza: fulizaAmount !== null,
        fulizaAmount,
      };
    }
  }
  return null;
}

export function isMpesaSender(address) {
  if (!address) return false;
  const a = address.toString().trim().toUpperCase();
  return MPESA_SENDER_IDS.includes(a);
}
