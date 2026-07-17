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
      const m = body.match(/withdrawn\s+ksh[\d,.]+\s+from\s+(.+?)\s+on\s/i);
      return m ? clean(m[1]) : null;
    },
  ],
  [
    'spend',
    'airtime',
    (body) => (/bought\s+ksh[\d,.]+\s+of\s+airtime/i.test(body) ? 'Airtime' : null),
  ],
];

export function parseMpesaSms(body, receivedAtMs = Date.now()) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/\s+/g, ' ').trim();

  if (!/confirmed/i.test(text)) return null;
  const codeMatch = text.match(CODE_RE);
  const amountMatch = text.match(AMOUNT_RE);
  if (!codeMatch || !amountMatch) return null;

  const amount = num(amountMatch[1]);
  if (!amount || amount <= 0) return null;

  for (const [type, subtype, matcher] of RULES) {
    const counterparty = matcher(text);
    if (counterparty) {
      return {
        mpesaCode: codeMatch[1],
        type,
        subtype,
        amount,
        counterparty,
        balance: num(text.match(BALANCE_RE)?.[1]),
        receivedAt: receivedAtMs,
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
