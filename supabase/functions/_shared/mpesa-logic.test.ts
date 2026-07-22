import { assert, assertEquals, assertThrows } from './test-helpers.ts';
import {
  darajaTimestamp,
  exceedsBalance,
  normalizeMsisdn,
  parseB2CCallback,
  parseStkCallback,
  stkPassword,
} from './mpesa-logic.ts';

Deno.test('parseStkCallback: successful payment extracts all callback metadata fields', () => {
  const payload = {
    Body: {
      stkCallback: {
        MerchantRequestID: 'mr-1',
        CheckoutRequestID: 'ws_CO_1',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 100 },
            { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
            { Name: 'TransactionDate', Value: 20260722103000 },
            { Name: 'PhoneNumber', Value: 254708374149 },
          ],
        },
      },
    },
  };
  const r = parseStkCallback(payload);
  assertEquals(r.succeeded, true);
  assertEquals(r.amount, 100);
  assertEquals(r.mpesaReceiptNumber, 'NLJ7RT61SV');
  assertEquals(r.phoneNumber, '254708374149');
  assertEquals(r.checkoutRequestId, 'ws_CO_1');
});

Deno.test('parseStkCallback: user cancelled has no CallbackMetadata, must not throw', () => {
  const payload = {
    Body: {
      stkCallback: {
        MerchantRequestID: 'mr-2',
        CheckoutRequestID: 'ws_CO_2',
        ResultCode: 1032,
        ResultDesc: 'Request cancelled by user.',
      },
    },
  };
  const r = parseStkCallback(payload);
  assertEquals(r.succeeded, false);
  assertEquals(r.amount, undefined);
  assertEquals(r.resultDesc, 'Request cancelled by user.');
});

Deno.test('parseStkCallback: a payload missing stkCallback entirely throws (not a real callback)', () => {
  assertThrows(() => parseStkCallback({}));
  assertThrows(() => parseStkCallback({ Body: {} }));
});

Deno.test('parseB2CCallback: successful payout extracts receipt and amount', () => {
  const payload = {
    Result: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      OriginatorConversationID: 'oc-1',
      ConversationID: 'AG_1',
      TransactionID: 'LGR019G3J2',
      ResultParameters: {
        ResultParameter: [
          { Key: 'TransactionAmount', Value: 50 },
          { Key: 'TransactionReceipt', Value: 'LGR019G3J2' },
          { Key: 'ReceiverPartyPublicName', Value: '254708374149 - John Doe' },
        ],
      },
    },
  };
  const r = parseB2CCallback(payload);
  assertEquals(r.succeeded, true);
  assertEquals(r.amount, 50);
  assertEquals(r.receipt, 'LGR019G3J2');
  assertEquals(r.conversationId, 'AG_1');
});

Deno.test('parseB2CCallback: QueueTimeOutURL payload (no ResultParameters) is treated as failed, not thrown', () => {
  const payload = {
    Result: {
      ResultType: 1,
      ResultCode: 1,
      ResultDesc: 'The service request timed out.',
      OriginatorConversationID: 'oc-2',
      ConversationID: 'AG_2',
    },
  };
  const r = parseB2CCallback(payload);
  assertEquals(r.succeeded, false);
  assertEquals(r.amount, undefined);
  assertEquals(r.resultDesc, 'The service request timed out.');
});

Deno.test('parseB2CCallback: a payload missing Result entirely throws', () => {
  assertThrows(() => parseB2CCallback({}));
});

Deno.test('exceedsBalance: rejects an amount larger than what is available', () => {
  assert(exceedsBalance(200, 150));
});

Deno.test('exceedsBalance: allows an amount exactly equal to what is available', () => {
  assert(!exceedsBalance(150, 150));
});

Deno.test('exceedsBalance: allows an amount under the available balance', () => {
  assert(!exceedsBalance(100, 150));
});

Deno.test('exceedsBalance: a zero or negative available balance rejects any positive request', () => {
  assert(exceedsBalance(1, 0));
  assert(exceedsBalance(1, -50));
});

Deno.test('darajaTimestamp: formats as YYYYMMDDHHmmss with zero-padding', () => {
  const d = new Date(2026, 0, 5, 9, 3, 7); // Jan 5 2026, 09:03:07 local
  assertEquals(darajaTimestamp(d), '20260105090307');
});

Deno.test('stkPassword: is Base64(shortcode + passkey + timestamp), matching Daraja docs exactly', () => {
  const shortCode = '174379';
  const passkey = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const timestamp = '20260722103000';
  const expected = btoa(shortCode + passkey + timestamp);
  assertEquals(stkPassword(shortCode, passkey, timestamp), expected);
});

Deno.test('normalizeMsisdn: already-correct 2547... passes through unchanged', () => {
  assertEquals(normalizeMsisdn('254708374149'), '254708374149');
});

Deno.test('normalizeMsisdn: +254... strips the plus', () => {
  assertEquals(normalizeMsisdn('+254708374149'), '254708374149');
});

Deno.test('normalizeMsisdn: local 07... form converts to 2547...', () => {
  assertEquals(normalizeMsisdn('0708374149'), '254708374149');
});

Deno.test('normalizeMsisdn: local 01... form (newer Safaricom range) converts to 2541...', () => {
  assertEquals(normalizeMsisdn('0112345678'), '254112345678');
});

Deno.test('normalizeMsisdn: bare 9-digit local number without leading zero also converts', () => {
  assertEquals(normalizeMsisdn('708374149'), '254708374149');
});

Deno.test('normalizeMsisdn: formatted with spaces/dashes still normalizes', () => {
  assertEquals(normalizeMsisdn('0708 374 149'), '254708374149');
});

Deno.test('normalizeMsisdn: a non-Safaricom-shaped number returns null, not a best guess', () => {
  assertEquals(normalizeMsisdn('12345'), null);
  assertEquals(normalizeMsisdn('254208374149'), null); // 2540... isn't a mobile prefix
  assertEquals(normalizeMsisdn('not a phone number'), null);
});
