// Starts an M-Pesa STK Push: the signed-in user asks to deposit into one of
// their own goals, this function asks Daraja to prompt their phone for a
// PIN, and records a pending row that stk-callback will later resolve.
//
// Deliberately uses only the user's own JWT-scoped Supabase client, never
// the service_role key, both the goal lookup and the deposits insert are
// covered by existing RLS policies ("own goals", "insert own pending
// deposit"), so ownership is enforced by Postgres itself rather than by a
// separate check in this function that could be gotten wrong.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { darajaBaseUrl, getDarajaAccessToken } from '../_shared/daraja.ts';
import { darajaTimestamp, normalizeMsisdn, stkPassword } from '../_shared/mpesa-logic.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401);

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return jsonResponse({ error: 'Not signed in' }, 401);

    const body = await req.json().catch(() => null);
    const goalId = body?.goal_id;
    const amount = Number(body?.amount);
    const phoneRaw = String(body?.phone_number || '');

    if (!goalId || typeof goalId !== 'string') return jsonResponse({ error: 'goal_id is required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: 'amount must be a positive number' }, 400);
    const phone = normalizeMsisdn(phoneRaw);
    if (!phone) return jsonResponse({ error: 'phone_number is not a valid Safaricom number' }, 400);

    // RLS ("own goals") means this simply returns nothing for a goal_id
    // that isn't this user's, whether it doesn't exist at all or belongs
    // to someone else, both look identical here on purpose.
    const { data: goal, error: goalError } = await supabase.from('goals').select('id, name').eq('id', goalId).single();
    if (goalError || !goal) return jsonResponse({ error: 'Goal not found' }, 404);

    const consumerKey = Deno.env.get('MPESA_CONSUMER_KEY');
    const consumerSecret = Deno.env.get('MPESA_CONSUMER_SECRET');
    const shortCode = Deno.env.get('MPESA_SHORTCODE');
    const passkey = Deno.env.get('MPESA_PASSKEY');
    const callbackBaseUrl = Deno.env.get('MPESA_CALLBACK_BASE_URL');
    if (!consumerKey || !consumerSecret || !shortCode || !passkey || !callbackBaseUrl) {
      console.error('initiate-stk-push: missing one or more MPESA_* environment variables');
      return jsonResponse({ error: 'M-Pesa is not configured for this deployment' }, 500);
    }

    const accessToken = await getDarajaAccessToken(consumerKey, consumerSecret);
    const timestamp = darajaTimestamp(new Date());
    const password = stkPassword(shortCode, passkey, timestamp);

    // AccountReference has historically had a ~12-character practical limit
    // on Daraja, so this is deliberately short rather than the full goal
    // name (which can be up to 40 characters in this app).
    const accountReference = goal.name.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 12) || 'SaveLock';

    const stkRes = await fetch(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: phone,
        PartyB: shortCode,
        PhoneNumber: phone,
        CallBackURL: `${callbackBaseUrl}/stk-callback`,
        AccountReference: accountReference,
        TransactionDesc: 'SaveLock goal deposit',
      }),
    });

    const stkData = await stkRes.json().catch(() => ({}));
    if (!stkRes.ok || String(stkData.ResponseCode) !== '0') {
      console.error('initiate-stk-push: Daraja rejected the STK push request', stkRes.status, stkData);
      return jsonResponse(
        { error: stkData.errorMessage || stkData.ResponseDescription || 'M-Pesa declined the request' },
        502
      );
    }

    const { data: deposit, error: insertError } = await supabase
      .from('deposits')
      .insert({
        user_id: user.id,
        goal_id: goalId,
        phone_number: phone,
        amount,
        merchant_request_id: stkData.MerchantRequestID,
        checkout_request_id: stkData.CheckoutRequestID,
        status: 'pending',
      })
      .select()
      .single();

    if (insertError || !deposit) {
      console.error('initiate-stk-push: STK push was accepted by Daraja but recording the pending deposit failed', insertError);
      return jsonResponse({ error: 'Could not record the deposit request. Do not retry the PIN prompt twice.' }, 500);
    }

    return jsonResponse({
      ok: true,
      deposit_id: deposit.id,
      customer_message: stkData.CustomerMessage || 'Check your phone to complete the payment.',
    });
  } catch (err) {
    console.error('initiate-stk-push: unexpected error', err);
    return jsonResponse({ error: 'Something went wrong starting the deposit.' }, 500);
  }
});
