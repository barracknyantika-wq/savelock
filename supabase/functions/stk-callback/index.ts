// Public endpoint Safaricom's servers POST to once an STK Push prompt has
// been answered (paid, cancelled, or timed out). There is no user JWT on
// this request at all, it comes straight from Safaricom, so this function
// must be deployed with JWT verification OFF (see supabase/config.toml)
// and does all its writes through the service_role key.
//
// The one rule that shapes this entire file: ALWAYS return HTTP 200, even
// when something on our side goes wrong. Safaricom's retry policy treats
// anything other than 200 as "delivery failed" and keeps re-sending the
// same callback, so a bug on our end that returned a 4xx/5xx would turn
// into an indefinite retry storm rather than a single failed request.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseStkCallback } from '../_shared/mpesa-logic.ts';
import { jsonResponse } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json().catch(() => null);
    if (!payload) {
      console.error('stk-callback: request body was not valid JSON');
      return jsonResponse({ ok: true }, 200);
    }

    let parsed;
    try {
      parsed = parseStkCallback(payload);
    } catch (parseErr) {
      console.error('stk-callback: payload did not look like a real STK callback', parseErr);
      return jsonResponse({ ok: true }, 200);
    }

    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (parsed.succeeded) {
      if (parsed.amount === undefined || !parsed.mpesaReceiptNumber) {
        console.error('stk-callback: ResultCode 0 but CallbackMetadata was missing Amount/MpesaReceiptNumber', parsed.checkoutRequestId);
        return jsonResponse({ ok: true }, 200);
      }
      const { data, error } = await supabaseAdmin.rpc('complete_deposit', {
        p_checkout_request_id: parsed.checkoutRequestId,
        p_mpesa_receipt_number: parsed.mpesaReceiptNumber,
        p_confirmed_amount: parsed.amount,
        p_result_code: parsed.resultCode,
        p_result_desc: parsed.resultDesc,
      });
      if (error) {
        console.error('stk-callback: complete_deposit RPC failed', parsed.checkoutRequestId, error);
      } else if (!data?.id) {
        // Either an unknown CheckoutRequestID, or (far more likely) this is
        // Safaricom retrying a callback already processed, exactly the
        // case this guard exists for. Not an error, nothing more to do.
        console.log('stk-callback: no pending deposit matched (already processed, or unknown), skipping', parsed.checkoutRequestId);
      } else {
        console.log('stk-callback: deposit completed', parsed.checkoutRequestId, parsed.mpesaReceiptNumber);
      }
    } else {
      const { data, error } = await supabaseAdmin.rpc('fail_deposit', {
        p_checkout_request_id: parsed.checkoutRequestId,
        p_result_code: parsed.resultCode,
        p_result_desc: parsed.resultDesc,
      });
      if (error) {
        console.error('stk-callback: fail_deposit RPC failed', parsed.checkoutRequestId, error);
      } else if (!data?.id) {
        console.log('stk-callback: no pending deposit matched for failure callback, skipping', parsed.checkoutRequestId);
      } else {
        console.log('stk-callback: deposit marked failed', parsed.checkoutRequestId, parsed.resultDesc);
      }
    }

    return jsonResponse({ ok: true }, 200);
  } catch (err) {
    // Whatever this was, Safaricom still needs a 200 or it will retry
    // indefinitely. The failure is only visible in these logs.
    console.error('stk-callback: unexpected error', err);
    return jsonResponse({ ok: true }, 200);
  }
});
