// Pure parsing/decision logic for the M-Pesa Edge Functions, deliberately
// kept free of any Supabase/Deno/network dependency so it can be unit
// tested directly (see mpesa-logic.test.ts). The index.ts files that
// actually talk to Daraja and the database import these functions rather
// than duplicating the parsing inline.

export interface StkCallbackItem {
  Name: string;
  Value?: string | number;
}

export interface StkCallbackPayload {
  Body?: {
    stkCallback?: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: { Item: StkCallbackItem[] };
    };
  };
}

export interface ParsedStkResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  resultCode: number;
  resultDesc: string;
  succeeded: boolean;
  amount?: number;
  mpesaReceiptNumber?: string;
  phoneNumber?: string;
  transactionDate?: string;
}

// Throws on a payload that isn't shaped like an STK callback at all (wrong
// endpoint hit, garbage body), so the caller can tell "not a real Safaricom
// callback" apart from "a real callback reporting failure", the two need
// different HTTP handling even though both end with SaveLock doing nothing
// further.
export function parseStkCallback(payload: StkCallbackPayload): ParsedStkResult {
  const cb = payload?.Body?.stkCallback;
  if (!cb || !cb.CheckoutRequestID) {
    throw new Error('Missing Body.stkCallback.CheckoutRequestID in STK callback payload');
  }
  const succeeded = cb.ResultCode === 0;
  const result: ParsedStkResult = {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
    succeeded,
  };
  if (succeeded && cb.CallbackMetadata?.Item) {
    const items = cb.CallbackMetadata.Item;
    const find = (name: string) => items.find((i) => i.Name === name)?.Value;
    const amount = find('Amount');
    result.amount = amount === undefined ? undefined : Number(amount);
    result.mpesaReceiptNumber = find('MpesaReceiptNumber') != null ? String(find('MpesaReceiptNumber')) : undefined;
    result.phoneNumber = find('PhoneNumber') != null ? String(find('PhoneNumber')) : undefined;
    result.transactionDate = find('TransactionDate') != null ? String(find('TransactionDate')) : undefined;
  }
  return result;
}

export interface B2CResultParameter {
  Key: string;
  Value?: string | number;
}

export interface B2CCallbackPayload {
  Result?: {
    ResultType?: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID?: string;
    ResultParameters?: { ResultParameter: B2CResultParameter[] };
  };
}

export interface ParsedB2CResult {
  conversationId: string;
  originatorConversationId: string;
  resultCode: number;
  resultDesc: string;
  succeeded: boolean;
  transactionId?: string;
  amount?: number;
  receipt?: string;
}

// Handles both the ResultURL callback (a real outcome) and the
// QueueTimeOutURL callback (Safaricom never got a result in time) — the
// timeout payload is shaped the same way (a Result object) but with a
// nonzero ResultCode and no ResultParameters, so it naturally falls into
// the "failed" branch below without special-casing.
export function parseB2CCallback(payload: B2CCallbackPayload): ParsedB2CResult {
  const r = payload?.Result;
  if (!r || !r.ConversationID) {
    throw new Error('Missing Result.ConversationID in B2C callback payload');
  }
  const succeeded = r.ResultCode === 0;
  const result: ParsedB2CResult = {
    conversationId: r.ConversationID,
    originatorConversationId: r.OriginatorConversationID,
    resultCode: r.ResultCode,
    resultDesc: r.ResultDesc,
    succeeded,
    transactionId: r.TransactionID,
  };
  if (succeeded && r.ResultParameters?.ResultParameter) {
    const params = r.ResultParameters.ResultParameter;
    const find = (key: string) => params.find((p) => p.Key === key)?.Value;
    const amount = find('TransactionAmount');
    result.amount = amount === undefined ? undefined : Number(amount);
    const receipt = find('TransactionReceipt');
    result.receipt = receipt != null ? String(receipt) : r.TransactionID;
  }
  return result;
}

// Daraja requires MSISDN as 2547XXXXXXXX/2541XXXXXXXX, no plus sign, no
// leading zero. Users will realistically type +2547..., 07..., 7..., or
// already-correct 2547... Returns null for anything that doesn't resolve
// to a plausible Kenyan Safaricom-range number, rather than guessing.
export function normalizeMsisdn(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, '');
  if (/^254[71]\d{8}$/.test(digits)) return digits;
  if (/^0[71]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^[71]\d{8}$/.test(digits)) return '254' + digits;
  return null;
}

// Small epsilon so a request for exactly the available balance (which can
// arrive as a slightly-off float from JSON/JS numeric handling) isn't
// rejected by a hairline rounding difference.
const BALANCE_EPSILON = 1e-6;

export function exceedsBalance(requestedAmount: number, availableBalance: number): boolean {
  return requestedAmount > availableBalance + BALANCE_EPSILON;
}

export function darajaTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

// Base64(ShortCode + Passkey + Timestamp), exactly as Daraja's STK Push
// docs specify. Kept here (not inline in index.ts) so it's covered by the
// same unit tests as everything else in this file.
export function stkPassword(shortCode: string, passkey: string, timestamp: string): string {
  const raw = `${shortCode}${passkey}${timestamp}`;
  // btoa is available in the Deno runtime Edge Functions run on.
  return btoa(raw);
}
