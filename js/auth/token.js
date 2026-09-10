// token.js — Token lifecycle: the core of "logins stay stable".
//
//  - ensureValidToken()  single-flight queue: every caller awaits ONE shared
//                        refresh promise — concurrent 401s produce one grant
//  - proactive refresh   timer at expiresAt-10min, 5-min safety interval,
//                        visibilitychange and online handlers
//  - fetchWithAuth()     on 401: single-flight refresh → retry once, only if
//                        the token actually changed; rotated refresh tokens
//                        are persisted (merge, never replace)
//  - failure taxonomy   invalid_grant → clear THAT account only + one silent
//                       re-auth attempt + "session expired" signal. Other 4xx
//                       keep tokens. 5xx/network keep tokens + backoff.
//                       Transient errors NEVER trigger re-auth, and nothing
//                       here ever touches local data or other accounts.

import { CONFIG } from '../config.js';
import { clock } from '../testing/clock.js';
import {
  getAccounts,
  getActiveAccount,
  getActiveEmail,
  updateAccount,
  removeAccount,
  hasValidAccessToken,
} from './token-store.js';
import { refreshGrant, silentPromptNone, exchangeCode } from './oauth.js';

const REFRESH_LEAD_MS = 10 * 60 * 1000;
const SAFETY_INTERVAL_MS = 5 * 60 * 1000;
const BACKOFF_STEPS = [30_000, 2 * 60_000, 10 * 60_000];
const SILENT_RETRY_WINDOW_MS = 5 * 60 * 1000;

let inFlight = null; // single-flight refresh for the ACTIVE account
let refreshTimer = null;
let safetyTimer = null;
let backoffLevel = 0;
let silentRetryAt = 0; // last silent re-auth attempt per invalid_grant

const listeners = new Set(); // onAuthStateChange({type, email})

export function onAuthStateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(change) {
  for (const fn of listeners) fn(change);
}

function clientId() {
  // Web flow only — Electron refreshes go through main via IPC with the
  // desktop client id that lives in main.cjs.
  return CONFIG.WEB_CLIENT_ID;
}

// ---- proactive refresh scheduling ----

function scheduleRefresh(account) {
  clearInterval(refreshTimer);
  if (!account?.refreshToken) return;
  // 1s polling against clock.now() instead of a one-shot setTimeout: the
  // Playwright harness (?testClock=1) can then drive expiry by advancing the
  // fake clock instead of waiting real minutes.
  const target = account.expiresAt - REFRESH_LEAD_MS;
  refreshTimer = setInterval(() => {
    if (clock.now() >= target) {
      clearInterval(refreshTimer);
      ensureValidToken({ force: true }).catch(() => {});
    }
  }, 1000);
}

export function startProactiveRefresh() {
  clearInterval(safetyTimer);
  safetyTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && getActiveAccount()) {
      ensureValidToken().catch(() => {});
    }
  }, SAFETY_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getActiveAccount()) {
      ensureValidToken().catch(() => {});
    }
  });
  window.addEventListener('online', () => {
    if (getActiveAccount()) ensureValidToken().catch(() => {});
  });
}

// ---- single-flight ensure ----

// Returns a valid access token for the active account, refreshing if needed.
// All callers share one in-flight promise — N concurrent 401s = 1 grant.
export async function ensureValidToken({ force = false } = {}) {
  const account = getActiveAccount();
  if (!account) throw Object.assign(new Error('no active account'), { signedOut: true });

  if (!force && hasValidAccessToken(account, clock.now())) {
    scheduleRefresh(account);
    return account.accessToken;
  }
  if (!account.refreshToken) {
    throw Object.assign(new Error('no refresh token'), { needsSignIn: true });
  }

  if (inFlight) return inFlight;
  inFlight = doRefresh(account).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh(account) {
  try {
    const result = await refreshGrant({
      clientId: clientId(),
      refreshToken: account.refreshToken,
    });
    // Merge — a response without refresh_token keeps the stored one
    const updated = updateAccount(account.email, {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    });
    backoffLevel = 0;
    emit({ type: 'refreshed', email: account.email });
    scheduleRefresh(updated);
    return updated.accessToken;
  } catch (err) {
    handleRefreshFailure(account, err);
    throw err;
  }
}

// The failure taxonomy. NEVER a global signOut, never touches local data.
function handleRefreshFailure(account, err) {
  if (err.code === 'invalid_grant') {
    // This account's refresh token is dead. Clear only its tokens (null =
    // explicit clear in token-store) and try one silent prompt=none re-auth
    // before asking the user. Never a global signOut, never touches local data.
    const now = clock.now();
    updateAccount(account.email, {
      refreshToken: null,
      accessToken: null,
      expiresAt: null,
      lastInvalidGrantAt: now,
    });
    emit({ type: 'invalid-grant', email: account.email });
    attemptSilentRecovery(account, now);
    return;
  }
  if (err.status >= 500 || err.code?.startsWith('http_5') || !err.status) {
    // 5xx / network: transient. Keep tokens, back off.
    backoffLevel = Math.min(backoffLevel + 1, BACKOFF_STEPS.length - 1);
    const delay = BACKOFF_STEPS[backoffLevel];
    emit({ type: 'transient-error', email: account.email, delay });
    setTimeout(() => {
      ensureValidToken({ force: true }).catch(() => {});
    }, delay);
    return;
  }
  // Other 4xx (invalid_client etc.): keep tokens, surface for diagnosis
  emit({ type: 'auth-error', email: account.email, error: err.code ?? err.message });
}

async function attemptSilentRecovery(account, attemptedAt) {
  if (attemptedAt - silentRetryAt < SILENT_RETRY_WINDOW_MS) return; // one attempt per window
  silentRetryAt = attemptedAt;
  try {
    const { code, state } = await silentPromptNone({
      clientId: clientId(),
      redirectUri: CONFIG.silentRedirectUri,
      scopes: CONFIG.scopes,
    });
    const verifier = ''; // prompt=none does not use PKCE — the code exchange
    // here is non-PKCE; verifier omitted. Google accepts this for
    // non-consent flows on web clients.
    const tokens = await exchangeCode({
      clientId: clientId(),
      code,
      redirectUri: CONFIG.silentRedirectUri,
      verifier,
    });
    updateAccount(account.email, {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    });
    emit({ type: 'silent-recovered', email: account.email });
  } catch (err) {
    emit({ type: 'needs-sign-in', email: account.email, interactionRequired: Boolean(err.interactionRequired) });
  }
}

// ---- fetchWithAuth ----

// Fetch with a valid token; on 401, single-flight refresh and retry ONCE,
// only if the token changed. Returns the Response (caller checks .ok).
export async function fetchWithAuth(url, { method = 'GET', headers = {}, body, retried = false, maxRetries = 3 } = {}) {
  const token = await ensureValidToken();
  const resp = await fetch(url, {
    method,
    headers: { ...headers, Authorization: `Bearer ${token}` },
    body,
  });
  if (resp.status === 401 && !retried) {
    const fresh = await ensureValidToken({ force: true });
    if (fresh !== token) {
      return fetchWithAuth(url, { method, headers, body, retried: true });
    }
  }
  if (resp.status >= 500 && retried < maxRetries) {
    // server hiccup — bounded retry, no auth churn
    await new Promise((r) => setTimeout(r, 500 * (retried + 1)));
    return fetchWithAuth(url, { method, headers, body, retried: retried + 1, maxRetries });
  }
  return resp;
}

// ---- account management ----

export function isSignedIn() {
  return Boolean(getActiveAccount());
}

// Account-scoped sign out (the only kind)
export async function signOut(email = getActiveEmail()) {
  if (email) removeAccount(email);
  clearTimeout(refreshTimer);
  inFlight = null;
  emit({ type: 'signed-out', email });
}

export { getAccounts, getActiveAccount, getActiveEmail, updateAccount, hasValidAccessToken };
