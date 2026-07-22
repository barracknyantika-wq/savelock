// Public endpoint handling BOTH of Daraja's B2C callbacks: ResultURL (a
// real outcome, success or failure) and QueueTimeOutURL (Safaricom never
// got a result in time). Both deliver the same shaped Result object, a
// timeout just arrives with a nonzero ResultCode and no ResultParameters,
// so parseB2CCallback's ordinary failure branch already covers it without
// needing to tell the two callback types apart here.
//
// Same two rules as stk-callback: no user JWT ever arrives on this
// request (deploy with JWT verification OFF, see supabase/config.toml),
// and this must ALWAYS return HTTP 200 no matter what happens internally,
// or Safaricom will retry indefinitely.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseB2CCallback } from '../_shared/mpesa-logic.ts';
import { jsonResponse } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json().catch(() => null);
    if (!payload) {
      console.error('b2c-callback: request body was not valid JSON');
      return jsonResponse({ ok: true }, 200);
    }

    let parsed;
    try {
      parsed = parseB2CCallback(payload);
    } catch (parseErr) {
      console.error('b2c-callback: payload did not look like a real B2C callback', parseErr);
      return jsonResponse({ ok: true }, 200);
    }

    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (parsed.succeeded) {
      if (parsed.amount === undefined || !parsed.receipt) {
        console.error('b2c-callback: ResultCode 0 but ResultParameters was missing amount/receipt', parsed.conversationId);
        return jsonResponse({ ok: true }, 200);
      }
      const { data, error } = await supabaseAdmin.rpc('complete_withdrawal', {
        p_conversation_id: parsed.conversationId,
        p_mpesa_transaction_id: parsed.receipt,
        p_confirmed_amount: parsed.amount,
        p_result_code: parsed.resultCode,
        p_result_desc: parsed.resultDesc,
      });
      if (error) {
        console.error('b2c-callback: complete_withdrawal RPC failed', parsed.conversationId, error);
      } else if (!data?.id) {
        console.log('b2c-callback: no pending withdrawal matched (already processed, or unknown), skipping', parsed.conversationId);
      } else {
        console.log('b2c-callback: withdrawal completed', parsed.conversationId, parsed.receipt);
      }
    } else {
      // Covers both a real failure (insufficient funds in the paying
      // shortcode, wrong details, etc.) and a queue timeout, same as the
      // file comment above explains.
      const { data, error } = await supabaseAdmin.rpc('fail_withdrawal', {
        p_conversation_id: parsed.conversationId,
        p_result_code: parsed.resultCode,
        p_result_desc: parsed.resultDesc,
      });
      if (error) {
        console.error('b2c-callback: fail_withdrawal RPC failed', parsed.conversationId, error);
      } else if (!data?.id) {
        console.log('b2c-callback: no pending withdrawal matched for failure callback, skipping', parsed.conversationId);
      } else {
        console.log('b2c-callback: withdrawal marked failed', parsed.conversationId, parsed.resultDesc);
      }
    }

    return jsonResponse({ ok: true }, 200);
  } catch (err) {
    console.error('b2c-callback: unexpected error', err);
    return jsonResponse({ ok: true }, 200);
  }
});
