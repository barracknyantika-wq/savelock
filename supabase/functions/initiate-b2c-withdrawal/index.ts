// Starts an M-Pesa B2C payout: a signed-in owner asks to withdraw from one
// of their own goals, straight to their phone. Gated twice before Daraja is
// ever called: the account must have profiles.is_owner = true (this whole
// feature is developer-only for now, deposits stay open to everyone but
// withdrawals don't), and the requested amount must not exceed what's
// actually confirmed available for that specific goal through this app's
// own M-Pesa flow.
//
// Uses the service_role client throughout, not the user's own JWT-scoped
// client: goal_mpesa_balance() is intentionally restricted to service_role
// only (see migration 0005), since the balance figure it returns is the one
// piece of data in this whole feature that must never be computed from
// anything the client could influence. user.id itself still comes from the
// validated JWT below, never from the request body.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { darajaBaseUrl, getDarajaAccessToken } from '../_shared/daraja.ts';
import { exceedsBalance, normalizeMsisdn } from '../_shared/mpesa-logic.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401);

    // Validates the JWT against Supabase's own auth server, this is the
    // only client used just to establish who is actually calling.
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) return jsonResponse({ error: 'Not signed in' }, 401);

    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('is_owner')
      .eq('id', user.id)
      .single();
    if (profileError || !profile?.is_owner) {
      return jsonResponse({ error: 'Withdrawals are not available on this account yet.' }, 403);
    }

    const body = await req.json().catch(() => null);
    const goalId = body?.goal_id;
    const amount = Number(body?.amount);
    const phoneRaw = String(body?.phone_number || '');

    if (!goalId || typeof goalId !== 'string') return jsonResponse({ error: 'goal_id is required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: 'amount must be a positive number' }, 400);
    const phone = normalizeMsisdn(phoneRaw);
    if (!phone) return jsonResponse({ error: 'phone_number is not a valid Safaricom number' }, 400);

    const { data: goal, error: goalError } = await supabaseAdmin
      .from('goals')
      .select('id, name, user_id')
      .eq('id', goalId)
      .single();
    if (goalError || !goal || goal.user_id !== user.id) return jsonResponse({ error: 'Goal not found' }, 404);

    const { data: available, error: balanceError } = await supabaseAdmin.rpc('goal_mpesa_balance', { p_goal_id: goalId });
    if (balanceError) {
      console.error('initiate-b2c-withdrawal: goal_mpesa_balance RPC failed', goalId, balanceError);
      return jsonResponse({ error: 'Could not verify this goal’s available balance.' }, 500);
    }
    if (exceedsBalance(amount, Number(available))) {
      return jsonResponse(
        { error: `Only ${Number(available).toFixed(2)} is confirmed available for this goal through M-Pesa.` },
        400
      );
    }

    const consumerKey = Deno.env.get('MPESA_CONSUMER_KEY');
    const consumerSecret = Deno.env.get('MPESA_CONSUMER_SECRET');
    const initiatorName = Deno.env.get('MPESA_B2C_INITIATOR_NAME');
    const securityCredential = Deno.env.get('MPESA_B2C_SECURITY_CREDENTIAL');
    const b2cShortCode = Deno.env.get('MPESA_B2C_SHORTCODE');
    const callbackBaseUrl = Deno.env.get('MPESA_CALLBACK_BASE_URL');
    if (!consumerKey || !consumerSecret || !initiatorName || !securityCredential || !b2cShortCode || !callbackBaseUrl) {
      console.error('initiate-b2c-withdrawal: missing one or more required MPESA_* environment variables');
      return jsonResponse({ error: 'M-Pesa withdrawals are not configured for this deployment' }, 500);
    }

    const accessToken = await getDarajaAccessToken(consumerKey, consumerSecret);
    const occasion = goal.name.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 12) || 'SaveLock';

    const b2cRes = await fetch(`${darajaBaseUrl()}/mpesa/b2c/v1/paymentrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        InitiatorName: initiatorName,
        SecurityCredential: securityCredential,
        CommandID: 'BusinessPayment',
        Amount: Math.round(amount),
        PartyA: b2cShortCode,
        PartyB: phone,
        Remarks: 'SaveLock goal withdrawal',
        QueueTimeOutURL: `${callbackBaseUrl}/b2c-callback`,
        ResultURL: `${callbackBaseUrl}/b2c-callback`,
        Occasion: occasion,
      }),
    });

    const b2cData = await b2cRes.json().catch(() => ({}));
    if (!b2cRes.ok || String(b2cData.ResponseCode) !== '0') {
      console.error('initiate-b2c-withdrawal: Daraja rejected the B2C request', b2cRes.status, b2cData);
      return jsonResponse(
        { error: b2cData.errorMessage || b2cData.ResponseDescription || 'M-Pesa declined the withdrawal request' },
        502
      );
    }

    const { data: withdrawal, error: insertError } = await supabaseAdmin
      .from('withdrawals')
      .insert({
        user_id: user.id,
        goal_id: goalId,
        phone_number: phone,
        amount,
        conversation_id: b2cData.ConversationID,
        originator_conversation_id: b2cData.OriginatorConversationID,
        status: 'pending',
      })
      .select()
      .single();

    if (insertError || !withdrawal) {
      console.error(
        'initiate-b2c-withdrawal: B2C request was accepted by Daraja but recording the pending withdrawal failed',
        insertError
      );
      return jsonResponse({ error: 'Could not record the withdrawal request.' }, 500);
    }

    return jsonResponse({
      ok: true,
      withdrawal_id: withdrawal.id,
      customer_message: b2cData.ResponseDescription || 'Your withdrawal is being processed.',
    });
  } catch (err) {
    console.error('initiate-b2c-withdrawal: unexpected error', err);
    return jsonResponse({ error: 'Something went wrong starting the withdrawal.' }, 500);
  }
});
