// App-side entry point. Keeps the proven M-Pesa parser first and untouched;
// the generic engine only handles messages M-Pesa did not claim.
//
//   parseAnySms(body, { sender, receivedAtMs, trustedSenders })
//     -> { ok: true, tx } | { ok: false, reason }
//
// trustedSenders: senders the user has confirmed before (per-sender
// learning). A trusted sender lifts medium-confidence messages to auto.

import vocab from './finance-vocab.json';
import { createEngine } from './generic-sms-engine.js';
import { parseMpesaSms, isMpesaSender } from './mpesa-parser.js';

const engine = createEngine(vocab);

export function parseAnySms(body, opts = {}) {
  const { sender, receivedAtMs } = opts;
  const mpesa = parseMpesaSms(body, receivedAtMs);
  if (mpesa) {
    return { ok: true, tx: { ...mpesa, provider: 'MPESA', confidence: 1, tier: 'auto', needsReview: false } };
  }
  // A real M-Pesa sender that the strict parser rejected is not a
  // transaction (promo, PIN notice, etc). Do not let the guesser reinterpret it.
  if (isMpesaSender(sender)) return { ok: false, reason: 'mpesa_unrecognized' };
  return engine.parse(body, opts);
}
