// relay.js — Routes web token-endpoint calls through the exchange relay
// when one is configured. The relay holds the client secret server-side —
// the only secretless-compatible architecture Google's endpoint accepts
// for this client (proven live: PKCE alone, GIS alone, and DPoP-from-
// browser all fail — "client_secret is missing" / CORS-blocked).
//
// Without a relay (CONFIG.relayEndpoint unset) the request goes straight
// to Google and will fail for web flows — desktop/Electron never uses this
// (its exchange runs in main with the desktop secret).

import { CONFIG } from '../config.js';

export async function tokenEndpointForWeb(body) {
  const endpoint = CONFIG.relayEndpoint;
  const url = endpoint ?? CONFIG.tokenEndpoint;

  // Direct-to-Google path: attach a DPoP proof if the browser can (harmless
  // when the endpoint is a mock in tests)
  if (!endpoint) {
    const { tokenFetchWithDpop } = await import('./dpop.js');
    return tokenFetchWithDpop(body);
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return resp;
}
