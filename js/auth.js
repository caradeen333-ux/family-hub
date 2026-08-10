// auth.js — Manual PKCE OAuth flow
// No client secret needed — PKCE replaces it. No GIS library needed.

let accessToken = null;
let tokenExpiry = 0;

function loadToken() {
  try {
    const raw = localStorage.getItem('fh_token');
    const exp = localStorage.getItem('fh_token_expiry');
    if (raw && exp) {
      accessToken = raw;
      tokenExpiry = parseInt(exp, 10);
    }
  } catch (e) { /* */ }
  return isSignedIn();
}

function isSignedIn() {
  return !!accessToken && Date.now() < tokenExpiry;
}

function getAccessToken() {
  if (!isSignedIn()) return null;
  return accessToken;
}

// Begin OAuth PKCE flow — redirect to Google for sign-in
async function signIn() {
  if (!CONFIG.clientId) {
    throw new Error('Google OAuth not configured.');
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallengeAsync(codeVerifier);
  sessionStorage.setItem('fh_code_verifier', codeVerifier);
  sessionStorage.setItem('fh_auth_started', '1');

  const redirectUri = window.location.origin + window.location.pathname;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CONFIG.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',
    'https://www.googleapis.com/auth/calendar.readonly ' +
    'https://www.googleapis.com/auth/calendar.events ' +
    'https://www.googleapis.com/auth/spreadsheets'
  );
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  window.location.href = authUrl.toString();
}

// Handle redirect back from Google (?code=... in URL)
async function handleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  const authStarted = sessionStorage.getItem('fh_auth_started');

  if (!code && !error) return null; // No auth in progress
  if (!authStarted) return null;    // Not our auth

  sessionStorage.removeItem('fh_auth_started');

  if (error) {
    return { success: false, error: params.get('error_description') || error };
  }

  const codeVerifier = sessionStorage.getItem('fh_code_verifier');
  sessionStorage.removeItem('fh_code_verifier');
  if (!codeVerifier) {
    return { success: false, error: 'Missing code verifier — restart sign-in' };
  }

  try {
    const redirectUri = window.location.origin + window.location.pathname;
    const body = new URLSearchParams({
      client_id: CONFIG.clientId,
      code: code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    // Electron preload injects the secret (never in public code)
    if (window.__electron?.clientSecret) {
      body.set('client_secret', window.__electron.clientSecret);
      console.log('Auth: using Electron-injected client secret');
    } else {
      console.warn('Auth: no client secret available — token exchange may fail');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Token exchange failed:', data);
      return { success: false, error: data.error_description || data.error || 'Token exchange failed' };
    }

    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000) - 300000; // 5-min buffer

    localStorage.setItem('fh_token', accessToken);
    localStorage.setItem('fh_token_expiry', tokenExpiry.toString());
    if (data.refresh_token) {
      localStorage.setItem('fh_refresh_token', data.refresh_token);
    }

    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);

    return { success: true };
  } catch (e) {
    console.error('Token exchange error:', e);
    return { success: false, error: e.message };
  }
}

// Refresh using refresh token
async function refreshToken() {
  const refresh = localStorage.getItem('fh_refresh_token');
  if (!refresh || !CONFIG.clientId) return false;

  try {
    const body = new URLSearchParams({
      client_id: CONFIG.clientId,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });

    // Electron preload injects the client secret — include it
    if (window.__electron?.clientSecret) {
      body.set('client_secret', window.__electron.clientSecret);
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      // Only sign out if the refresh token itself is invalid (not a transient error)
      const err = await response.json().catch(() => ({}));
      if (err.error === 'invalid_grant') {
        console.error('Refresh token revoked or expired — signing out');
        signOut();
      }
      return false;
    }

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000) - 300000;
    localStorage.setItem('fh_token', accessToken);
    localStorage.setItem('fh_token_expiry', tokenExpiry.toString());
    if (data.refresh_token) {
      localStorage.setItem('fh_refresh_token', data.refresh_token);
    }
    return true;
  } catch (e) {
    console.error('Refresh error:', e);
    return false;
  }
}

function signOut() {
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem('fh_token');
  localStorage.removeItem('fh_token_expiry');
  localStorage.removeItem('fh_refresh_token');
}

// PKCE helpers (no crypto.subtle needed for basic support)
function generateCodeVerifier() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return Array.from(array, b => chars[b % chars.length]).join('').substring(0, 128);
}

function generateCodeChallenge(verifier) {
  // SHA-256 via SubtleCrypto
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  // We can't do async here, so we use a synchronous approach
  // The hash will be computed when signIn() is called
  return null; // Will be filled in by the async version
}

// Actually use async version in signIn
async function generateCodeChallengeAsync(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
