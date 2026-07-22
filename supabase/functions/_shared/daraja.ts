// Thin wrapper around the two Daraja calls every M-Pesa Edge Function
// needs: getting an OAuth token, and knowing which host to call it against.
// Kept separate from mpesa-logic.ts because this file actually reaches out
// over the network and so can't be exercised by the offline unit tests,
// unlike everything in mpesa-logic.ts.

export function darajaBaseUrl(): string {
  const env = (Deno.env.get('MPESA_ENV') || 'sandbox').toLowerCase();
  return env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}

export async function getDarajaAccessToken(consumerKey: string, consumerSecret: string): Promise<string> {
  const credentials = btoa(`${consumerKey}:${consumerSecret}`);
  const res = await fetch(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) {
    throw new Error(`Daraja OAuth token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Daraja OAuth response had no access_token');
  }
  return data.access_token as string;
}
