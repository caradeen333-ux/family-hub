// oauth.js — Public-client OAuth 2.0 with PKCE. No client secret anywhere.
//
// Flows:
//  - signIn()            interactive: code + PKCE + state, verifier/state live
//                        in localStorage (survives tab close on mobile)
//  - exchangeCode()      code → tokens, NO client secret
//  - refreshGrant()      refresh_token → new access token (merge, don't replace)
//  - silentPromptNone()  hidden iframe re-auth without user interaction
//
// The token endpoint is injectable via CONFIG.tokenEndpoint so the Playwright
// harness can page.route it with scripted responses.

import { CONFIG } from '../config.js';
import { clock } from '../testing/clock.js';
import { getAccounts } from './token-store.js';

const OAUTH_STATE_KEY = 'fh_oauth'; // {verifier, state, redirect, expiresAt}
const STATE_TTL_MS = 10 * 60 * 1000;

// ---- PKCE helpers ----

export function randomString(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, len);
}

export async function makeVerifier() {
  return randomString(64);
}

export async function makeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---- authorize URL + state ----

export async function buildAuthorizeUrl({ clientId, redirectUri, scopes, extra = {} }) {
  const verifier = await makeVerifier();
  const challenge = await makeChallenge(verifier);
  const state = randomString(32);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // Only ask consent when the device has no refresh token — minting a new
    // refresh token on every sign-in hits Google's ~50-token revocation cliff.
    ...(hasRefreshToken() ? {} : { prompt: 'consent' }),
    ...extra,
  });
  saveOauthState({ verifier, state, redirect: redirectUri, expiresAt: clock.now() + STATE_TTL_MS });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function saveOauthState(state) {
  try {
    localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — flow still proceeds in-memory via return value */
  }
}

export function loadOauthState() {
  try {
    const raw = localStorage.getItem(OAUTH_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    localStorage.removeItem(OAUTH_STATE_KEY);
    if (clock.now() > state.expiresAt) return null; // stale — reject
    return state;
  } catch {
    return null;
  }
}

function hasRefreshToken() {
  try {
    return Object.values(getAccounts()).some((a) => a.refreshToken);
  } catch {
    return false;
  }
}

// ---- token endpoint calls ----

// Exchange an authorization code. No client secret — public PKCE client.
// code_verifier is sent ONLY for PKCE codes. The silent prompt=none flow
// authorizes WITHOUT a challenge; sending an empty verifier there makes
// Google reject the exchange with invalid_grant.
export async function exchangeCode({ clientId, code, redirectUri, verifier }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  if (verifier) body.set('code_verifier', verifier);
  const resp = await fetch(CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseTokenResponse(resp);
}

// Exchange a GIS-issued code (mobile/web popup flow). NO client secret and
// NO code_verifier — the code's first-party binding authenticates it, and a
// DPoP proof (RFC 9449) replaces the secret. The redirect_uri is the page
// origin that opened the popup.
export async function exchangeGisCode({ clientId, code, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const { tokenFetchWithDpop } = await import('./dpop.js');
  const resp = await tokenFetchWithDpop(body, {
    fetchFn: (url, init) => fetch(url, init),
  });
  return parseTokenResponse(resp);
}

// Refresh grant. The response may omit refresh_token — callers must MERGE,
// never replace (Google often returns none).
// In Electron the grant runs in main via IPC (same desktop client that minted
// the token — a refresh with a different client id is an invalid_grant).
export async function refreshGrant({ clientId, refreshToken }) {
  if (window.__electron?.refreshOauth) {
    const data = await window.__electron.refreshOauth(refreshToken);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token, // may be undefined — merge, don't replace
      expiresAt: clock.now() + (data.expires_in ?? 3600) * 1000,
      scope: data.scope,
    };
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  // Web path: attach a DPoP proof (same key as the exchange) — Google's
  // secretless flow binds tokens to the key
  const { tokenFetchWithDpop } = await import('./dpop.js');
  const resp = await tokenFetchWithDpop(body, {
    fetchFn: (url, init) => fetch(url, init),
  });
  return parseTokenResponse(resp);
}

export async function parseTokenResponse(resp) {
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (!resp.ok) {
    const err = new Error(data.error_description || data.error || `token endpoint ${resp.status}`);
    err.code = data.error ?? `http_${resp.status}`;
    err.status = resp.status;
    throw err;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // may be undefined — merge, don't replace
    expiresAt: clock.now() + (data.expires_in ?? 3600) * 1000,
    idToken: data.id_token,
    scope: data.scope,
  };
}

// ---- silent re-auth (hidden iframe, prompt=none) ----

// Opens a hidden iframe to the authorize endpoint with prompt=none.
// Resolves when the iframe's redirect delivers a code to silent.html, or
// rejects with {interactionRequired:true} when the user must sign in.
export function silentPromptNone({ clientId, redirectUri, scopes, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.setAttribute('aria-hidden', 'true');

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('silent re-auth timed out'), { interactionRequired: true }));
    }, timeoutMs);

    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'fh-silent-auth') return;
      cleanup();
      if (event.data.code && event.data.state) {
        resolve({ code: event.data.code, state: event.data.state });
      } else if (event.data.error === 'interaction_required') {
        reject(Object.assign(new Error('interaction required'), { interactionRequired: true }));
      } else {
        reject(Object.assign(new Error(event.data.error ?? 'silent auth failed'), { interactionRequired: true }));
      }
    };

    window.addEventListener('message', onMessage);

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      prompt: 'none',
      state: randomString(32),
      include_granted_scopes: 'true',
    })}`;
    iframe.src = url;
    document.body.appendChild(iframe);
  });
}
