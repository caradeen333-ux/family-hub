// auth.js — Google Identity Services OAuth (PKCE flow for PWA)
// One-time sign-in per device, token in localStorage, auto-refresh

let accessToken = null;
let tokenExpiry = 0;

// Load token from localStorage on startup
function loadToken() {
  try {
    const raw = localStorage.getItem('fh_token');
    const exp = localStorage.getItem('fh_token_expiry');
    if (raw && exp) {
      accessToken = raw;
      tokenExpiry = parseInt(exp, 10);
    }
  } catch (e) { /* localStorage unavailable */ }
  return isSignedIn();
}

function isSignedIn() {
  return !!accessToken && Date.now() < tokenExpiry;
}

function getAccessToken() {
  if (!isSignedIn()) return null;
  return accessToken;
}

// Begin OAuth PKCE flow using Google Identity Services
// Must be called from a user gesture (click handler)
async function signIn() {
  if (!CONFIG.clientId) {
    console.error('No clientId set in config.js');
    throw new Error('Google OAuth not configured. Add your client ID in Settings.');
  }

  // Use Google's token endpoint with PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  sessionStorage.setItem('fh_code_verifier', codeVerifier);

  // Build auth URL
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
  authUrl.searchParams.set('state', 'family-hub');

  // Redirect to Google
  window.location.href = authUrl.toString();
}

// Handle the OAuth redirect (call on page load if ?code= is present)
async function handleAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) {
    console.error('Auth error:', error);
    return { success: false, error };
  }

  if (!code || state !== 'family-hub') return null; // No auth in progress

  const codeVerifier = sessionStorage.getItem('fh_code_verifier');
  if (!codeVerifier) {
    console.error('Missing code verifier — auth flow broken');
    return { success: false, error: 'Missing code verifier' };
  }

  try {
    const redirectUri = window.location.origin + window.location.pathname;
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CONFIG.clientId,
        code: code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('Token exchange failed:', err);
      return { success: false, error: err.error_description || err.error };
    }

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);

    // Persist
    localStorage.setItem('fh_token', accessToken);
    localStorage.setItem('fh_token_expiry', tokenExpiry.toString());
    if (data.refresh_token) {
      localStorage.setItem('fh_refresh_token', data.refresh_token);
    }

    sessionStorage.removeItem('fh_code_verifier');
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);

    return { success: true };
  } catch (e) {
    console.error('Token exchange error:', e);
    return { success: false, error: e.message };
  }
}

// Try to refresh the access token using the refresh token
async function refreshToken() {
  const refresh = localStorage.getItem('fh_refresh_token');
  if (!refresh || !CONFIG.clientId) return false;

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CONFIG.clientId,
        refresh_token: refresh,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      // Refresh token expired — need full re-auth
      signOut();
      return false;
    }

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in * 1000);
    localStorage.setItem('fh_token', accessToken);
    localStorage.setItem('fh_token_expiry', tokenExpiry.toString());
    return true;
  } catch (e) {
    console.error('Token refresh error:', e);
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

// PKCE helpers
function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .substring(0, 128);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
