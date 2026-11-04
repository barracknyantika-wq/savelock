// Classifies confirmed generic bank/wallet transactions by sender category
// and completed-transaction structure, not loose keyword scores. This pure
// module runs in the JS tests and mirrors the native Android Kotlin engine.
// parse() returns { ok:true, tx } or { ok:false, reason }; loan reminders
// use a private type that the store retains without counting or surfacing.

const CUR = '(?:KES|KSHS?|USD|TZS|UGX)';
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const B0 = '(?<![A-Za-z0-9])';
const B1 = '(?![A-Za-z0-9])';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (p) => esc(p).replace(/ /g, '\\s+');
const anyOf = (list) => new RegExp(`${B0}(?:${list.map(phrase).join('|')})${B1}`, 'i');
const toNum = (s) => parseFloat(s.replace(/,/g, ''));

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).toUpperCase();
}

export const senderKey = (sender) => (sender || 'UNK').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');

const ACCT_RE = /(?:[Xx*]{2,}|ending(?:\s+in|\s+with)?\s*)[\s-]*(\d{3,4})(?!\d)/i;
const REF_RE = new RegExp(
  `${B0}(?:ref(?:erence)?|txn|trx|trans(?:action)?|rrn|receipt|conf(?:irmation)?)\\s*(?:no\\.?|number|id|code)?\\s*[:#\\-]?\\s*([A-Z0-9][A-Z0-9\\-]{5,24})`,
  'gi'
);
const CP_BODY = "([A-Za-z0-9][A-Za-z0-9 &'\\-/]{1,40}?)";
const CP_STOP =
  '(?=\\s+(?:on|ref|reference|via|from|using|for|date|dated|bal|balance|avail|available|a/c|acc|account|txn|trx|at|to|narration)(?![A-Za-z0-9])|\\s*[.;,(]|\\s*$)';
const DEBIT_CUES = ['sent to', 'paid to', 'transferred to', 'transfer to', 'payment to', 'used at', 'purchase at', 'purchased at', 'spent at', 'paid at', 'bought at', 'withdrawn at', 'at'];
const CREDIT_CUES = ['received from', 'transferred from', 'transfer from', 'deposit from', 'payment from', 'credited by', 'from'];
const BAD_CP = /^(your|my|the|a\/c|acc|account|card|self|you|atm|pos)(?![A-Za-z0-9])/i;
const MASKED_CP = /^[\dXx*\s-]+$/;
const LOAN_REMINDER_RE = /\b(?:repay\s+(?:kshs?|kes)\b|loan\s+eligibility|extend\s+by\b|have\s+not\s+yet\s+received\s+payment)\b/i;
const CREDIT_RE = /\b(?:has\s+been\s+credited\s+to|you\s+have\s+received|successfully\s+sent\s+to\s+(?:you|your\s+(?:account|wallet)))\b/i;
const DEBIT_RE = /\b(?:has\s+been\s+successfully\s+sent\s+to|has\s+been\s+debited)\b/i;
const FAILED_RE = /\b(?:failed|unsuccessful|declined|could\s+not\s+be\s+completed)\b/i;

export function senderCategory(sender) {
  const key = senderKey(sender);
  if (!key || key === 'UNK' || /^\d+$/.test(key)) return null;
  if (/MPESA|SAFARICOM/.test(key)) return 'mpesa';
  if (/LOAN|LEND|CREDIT|REPAY|KORO|TALA|BRANCH|ZENKA|FULIZA|M-SHWARI|MSHWARI/.test(key)) return 'lending';
  if (/BANK|EQUITY|KCB|COOP|NCBA|ABSA|DTB|STANBIC|FAMILY|BARCLAYS|STANDARDCHARTERED|IANDM|IMBANK|SIDIAN|HF|CITI/.test(key)) return 'bank';
  if (/WALLET|FINANCE|MICROFINANCE/.test(key)) return 'financial';
  return null;
}

function findAmounts(text) {
  const found = [];
  const pre = new RegExp(`${B0}(${CUR})\\.?\\s?${NUM}`, 'gi');
  let m;
  while ((m = pre.exec(text))) {
    found.push({ start: m.index, end: m.index + m[0].length, value: toNum(m[2]), currency: m[1].toUpperCase().startsWith('KS') ? 'KES' : m[1].toUpperCase() });
  }
  const post = new RegExp(`(?<![\\d,.])${NUM}\\s?(?:(?:KES|KSHS?)(?![A-Za-z])|/=)`, 'gi');
  while ((m = post.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (!found.some((f) => start < f.end && end > f.start)) found.push({ start, end, value: toNum(m[1]), currency: 'KES' });
  }
  return found.sort((a, b) => a.start - b.start);
}

export function createEngine(vocab) {
  const catHints = Object.entries(vocab.categoryHints).map(([k, v]) => [k, anyOf(v)]);
  const incHints = Object.entries(vocab.incomeHints).map(([k, v]) => [k, anyOf(v)]);

  const firstHint = (list, s) => {
    for (const [k, r] of list) if (r.test(s)) return k;
    return null;
  };

  function findCounterparty(text, isDebit) {
    for (const cue of isDebit ? DEBIT_CUES : CREDIT_CUES) {
      const re = new RegExp(`${B0}${phrase(cue)}\\s+${CP_BODY}${CP_STOP}`, 'gi');
      for (const m of text.matchAll(re)) {
        const name = m[1].trim().replace(/[\s\-/]+$/, '');
        if (name.length >= 2 && !BAD_CP.test(name) && !MASKED_CP.test(name)) return name;
      }
    }
    return null;
  }

  function findReference(text) {
    for (const m of text.matchAll(REF_RE)) if (/\d/.test(m[1])) return m[1].toUpperCase();
    return null;
  }

  const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });

  function parse(body, opts = {}) {
    if (!body || typeof body !== 'string') return no('empty');
    const text = body.replace(/\s+/g, ' ').trim();
    if (text.length < 15 || text.length > 800) return no('length');
    const category = senderCategory(opts.sender);
    if (!category) return no('unrecognized_sender');

    const sk = senderKey(opts.sender);
    const receivedAt = opts.receivedAtMs ?? Date.now();
    const amounts = findAmounts(text);
    const reference = findReference(text);
    const code = reference ? `GEN${hash(sk)}${reference}` : `GEN${hash(`${sk}|${text}`)}`;

    if (category === 'lending' && LOAN_REMINDER_RE.test(text)) {
      const amount = amounts.find((a) => a.value > 0)?.value ?? 0;
      return {
        ok: true,
        tx: {
          mpesaCode: code,
          type: 'loan_reminder',
          subtype: 'loan_reminder',
          classification: 'loan_reminder',
          amount,
          counterparty: sk,
          category: 'loan_reminder',
          receivedAt,
          provider: sk,
          currency: amounts[0]?.currency ?? 'KES',
        },
      };
    }

    if (FAILED_RE.test(text)) return no('failed_transaction');
    const isCredit = CREDIT_RE.test(text);
    const isDebit = !isCredit && DEBIT_RE.test(text);
    if (isCredit === isDebit) return no(isCredit ? 'ambiguous_direction' : 'no_completed_transaction');

    const txAmt = amounts.find((a) => a.value > 0);
    if (!txAmt || !(txAmt.value > 0)) return no('no_transaction_amount');

    const accountLast4 = text.match(ACCT_RE)?.[1] ?? null;
    const counterparty = findCounterparty(text, isDebit);
    const recipient = text.match(/\bsuccessfully\s+sent\s+to\s+([A-Za-z][A-Za-z0-9 &'./-]{1,40})/i)?.[1]
      ?.trim()
      .replace(/[\s\-/]+$/, '');
    const debit = isDebit;
    return {
      ok: true,
      tx: {
        mpesaCode: code,
        type: isDebit ? 'spend' : 'received',
        subtype: 'generic',
        amount: txAmt.value,
        counterparty: recipient || counterparty || (debit ? 'Unknown payee' : 'Unknown sender'),
        category: isDebit ? firstHint(catHints, text) || 'Other' : null,
        incomeCategory: isDebit ? null : firstHint(incHints, text) || 'Other income',
        balance: null,
        receivedAt,
        viaFuliza: false,
        fulizaAmount: null,
        provider: sk,
        currency: txAmt.currency,
        accountLast4,
        reference,
        confidence: 1,
        tier: 'auto',
        needsReview: false,
      },
    };
  }

  return { parse };
}
