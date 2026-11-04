import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

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
    if (!user.email) return jsonResponse({ error: 'An email address is required to send this report.' }, 400);

    const body = await req.json().catch(() => null);
    const month = body?.month;
    const pdfBase64 = body?.pdf_base64;
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return jsonResponse({ error: 'A valid report month is required.' }, 400);
    }
    if (
      typeof pdfBase64 !== 'string' ||
      pdfBase64.length > 8 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(pdfBase64)
    ) {
      return jsonResponse({ error: 'The report PDF is missing or invalid.' }, 400);
    }

    const apiKey = Deno.env.get('RESEND_API_KEY');
    const from = Deno.env.get('MONTHLY_REPORTS_FROM');
    if (!apiKey || !from) {
      console.error('send-monthly-report: RESEND_API_KEY and MONTHLY_REPORTS_FROM must be configured');
      return jsonResponse({ error: 'Monthly report email is not configured for this deployment.' }, 503);
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [user.email],
        subject: `Your SaveLock statement for ${month}`,
        html: `<p>Your SaveLock monthly statement for ${month} is attached.</p><p>Keep this message for your records.</p>`,
        attachments: [{ filename: `savelock-statement-${month}.pdf`, content: pdfBase64 }],
      }),
    });
    if (!response.ok) {
      console.error(`send-monthly-report: email provider returned ${response.status}`);
      return jsonResponse({ error: 'The email provider could not deliver this report.' }, 502);
    }

    const sentAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from('monthly_reports')
      .update({ email_sent_at: sentAt })
      .eq('user_id', user.id)
      .eq('month', month);
    if (updateError) console.error('send-monthly-report: could not record delivery timestamp');

    return jsonResponse({ sent_at: sentAt });
  } catch (error) {
    console.error('send-monthly-report failed:', error);
    return jsonResponse({ error: 'The monthly report could not be emailed.' }, 500);
  }
});
