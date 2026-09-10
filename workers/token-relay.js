// workers/token-relay.js — Production token-exchange relay for Family Hub
// web sign-in. Holds the WEB client secret server-side and exchanges auth
// codes / refresh tokens with Google. Never stores tokens, never logs them.
//
// Deploy:  npx wrangler secret put WEB_CLIENT_SECRET   (paste the web secret)
//          npx wrangler secret put WEB_CLIENT_ID
//          npx wrangler deploy
// Then put the workers.dev URL in js/config.js relayEndpoint and redeploy Pages.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Origins allowed to call the relay: the live Pages site + local dev/test.
const ALLOWED_ORIGINS = [
  'https://caradeen333-ux.github.io',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

export default {
  async fetch(request, env) {
    const corsHeaders = (origin) => ({
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin') ?? '') });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/exchange') {
      return new Response('not found', { status: 404, headers: corsHeaders(request.headers.get('Origin') ?? '') });
    }

    try {
      const body = new URLSearchParams(await request.text());
      // Server-side credentials; tokens are returned to the caller, never stored.
      body.set('client_id', env.WEB_CLIENT_ID);
      body.set('client_secret', env.WEB_CLIENT_SECRET);
      const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      return new Response(await resp.text(), {
        status: resp.status,
        headers: { ...corsHeaders(request.headers.get('Origin') ?? ''), 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'relay_error', error_description: String(err && err.message) }),
        { status: 500, headers: { ...corsHeaders(request.headers.get('Origin') ?? ''), 'Content-Type': 'application/json' } }
      );
    }
  },
};
