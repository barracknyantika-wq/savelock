// Template-free financial SMS engine. Recognizes bank/wallet alerts by
// structure and vocabulary instead of per-bank templates, so it works for
// banks nobody has written a rule for yet. Pure function of (text, options):
// no imports, no DOM, so it runs in the WebView, in Node tests, and is small
// enough to port to Kotlin against the same finance-vocab.json.
//
// Deliberately conservative, like mpesa-parser.js: a wrong auto-log is worse
// than a missed one. Every result carries a confidence and a tier:
//   auto   (>= thresholds.auto)   safe to log without asking
//   review (>= thresholds.review) log as "needs review", user confirms
//   below review                  rejected with reason 'low_confidence'
//
// parse() returns { ok:true, tx } or { ok:false, reason, confidence? }.
// tx mirrors parseMpesaSms()'s shape (mpesaCode, type spend|received, ...)
// so the existing drain/store path can consume it, plus provider,
// confidence, tier, currency, accountLast4, reference, incomeCategory.

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
const FALLBACK_AMOUNT_RE = new RegExp(`${B0}(?:amt|amount|value)\\.?\\s*[:\\-]?\\s*${NUM}`, 'i');

const CP_BODY = "([A-Za-z0-9][A-Za-z0-9 &'\\-/]{1,40}?)";
const CP_STOP =
  '(?=\\s+(?:on|ref|reference|via|from|using|for|date|dated|bal|balance|avail|available|a/c|acc|account|txn|trx|at|to|narration)(?![A-Za-z0-9])|\\s*[.;,(]|\\s*$)';
const DEBIT_CUES = ['sent to', 'paid to', 'transferred to', 'transfer to', 'payment to', 'used at', 'purchase at', 'purchased at', 'spent at', 'paid at', 'bought at', 'withdrawn at', 'at'];
const CREDIT_CUES = ['received from', 'transferred from', 'transfer from', 'deposit from', 'payment from', 'credited by', 'from'];
const BAD_CP = /^(your|my|the|a\/c|acc|account|card|self|you|atm|pos)(?![A-Za-z0-9])/i;
const MASKED_CP = /^[\dXx*\s-]+$/;

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
  const T = vocab.thresholds;
  const failedRe = anyOf(vocab.failed);
  const otpRe = anyOf(vocab.otp);
  const promoRes = vocab.promo.map((p) => anyOf([p]));
  const balanceRe = anyOf(vocab.balanceWords);
  const feeRe = anyOf(vocab.feeWords);
  const limitRe = anyOf(vocab.limitWords);
  const compileW = (list) => list.map(([p, w]) => ({ re: anyOf([p]), w }));
  const debit = compileW(vocab.debit);
  const credit = compileW(vocab.credit);
  const catHints = Object.entries(vocab.categoryHints).map(([k, v]) => [k, anyOf(v)]);
  const incHints = Object.entries(vocab.incomeHints).map(([k, v]) => [k, anyOf(v)]);

  const score = (text, list) => {
    let sum = 0;
    let max = 0;
    for (const e of list) {
      if (e.re.test(text)) {
        sum += e.w;
        if (e.w > max) max = e.w;
      }
    }
    return { sum, max };
  };
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

    const d = score(text, debit);
    const c = score(text, credit);
    const maxW = Math.max(d.max, c.max);

    if (failedRe.test(text)) return no('failed_transaction');
    if (otpRe.test(text) && maxW < 3) return no('otp');
    const promoHits = promoRes.filter((r) => r.test(text)).length;
    if (promoHits && maxW < 3) return no('promo');

    const amounts = findAmounts(text);
    amounts.forEach((a, i) => {
      const prevEnd = i ? amounts[i - 1].end : 0;
      const ctx = text.slice(Math.max(prevEnd, a.start - 26), a.start);
      a.kind = balanceRe.test(ctx) ? 'balance' : feeRe.test(ctx) ? 'fee' : limitRe.test(ctx) ? 'limit' : 'tx';
    });
    let txAmt = amounts.find((a) => a.kind === 'tx');
    let usedFallback = false;
    if (!txAmt) {
      const fm = text.match(FALLBACK_AMOUNT_RE);
      if (fm) {
        txAmt = { value: toNum(fm[1]), currency: 'KES' };
        usedFallback = true;
      }
    }
    if (!txAmt || !(txAmt.value > 0)) return no('no_transaction_amount');

    if (d.sum === 0 && c.sum === 0) return no('no_direction');
    const diff = d.sum - c.sum;
    if (diff === 0) return no('ambiguous_direction');
    const isDebit = diff > 0;

    const balance = amounts.find((a) => a.kind === 'balance')?.value ?? null;
    const reference = findReference(text);
    const accountLast4 = text.match(ACCT_RE)?.[1] ?? null;
    const counterparty = findCounterparty(text, isDebit);

    const sk = senderKey(opts.sender);
    const trusted = new Set((opts.trustedSenders ? [...opts.trustedSenders] : []).map(senderKey)).has(sk);
    let conf = 0.15 + (Math.abs(diff) >= 3 ? 0.35 : 0.2);
    if (opts.sender) conf += trusted ? 0.4 : /[A-Za-z]/.test(opts.sender) ? 0.2 : -0.3;
    if (balance !== null) conf += 0.1;
    if (reference) conf += 0.1;
    if (accountLast4) conf += 0.05;
    if (counterparty) conf += 0.05;
    if (usedFallback) conf -= 0.15;
    conf -= 0.3 * Math.min(promoHits, 2);
    conf = Math.round(Math.min(1, Math.max(0, conf)) * 100) / 100;

    const tier = conf >= T.auto ? 'auto' : conf >= T.review ? 'review' : null;
    if (!tier) return no('low_confidence', { confidence: conf });

    const receivedAt = opts.receivedAtMs ?? Date.now();
    const mpesaCode = reference ? `GEN${hash(sk)}${reference}` : `GEN${hash(`${sk}|${text}`)}`;
    return {
      ok: true,
      tx: {
        mpesaCode,
        type: isDebit ? 'spend' : 'received',
        subtype: 'generic',
        amount: txAmt.value,
        counterparty: counterparty || (isDebit ? 'Unknown payee' : 'Unknown sender'),
        category: isDebit ? firstHint(catHints, text) || 'Other' : null,
        incomeCategory: isDebit ? null : firstHint(incHints, text) || 'Other income',
        balance,
        receivedAt,
        viaFuliza: false,
        fulizaAmount: null,
        provider: sk,
        currency: txAmt.currency,
        accountLast4,
        reference,
        confidence: conf,
        tier,
        needsReview: tier === 'review',
      },
    };
  }

  return { parse };
}
