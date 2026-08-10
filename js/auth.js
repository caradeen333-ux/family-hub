// auth.js — Google Identity Services OAuth (Token Client flow)
// Uses Google's official GIS library — no client secret in code
// Access tokens last 1 hour; auto-refresh via silent re-auth

let accessToken = null;
let tokenExpiry = 0;
let tokenClient = null;

// Load token from localStorage on startup
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

// Initialize GIS token client (called once on load if library is available)
function initTokenClient() {
  if (!window.google?.accounts?.oauth2) {
    console.warn('Google GIS library not loaded yet, retrying...');
    setTimeout(initTokenClient, 500);
    return;
  }

  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.clientId,
      scope: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/spreadsheets',
      ].join(' '),
      callback: (resp) => {
        console.log('Token callback:', resp?.error || 'success');
        handleTokenResponse(resp);
      },
      error_callback: (err) => {
        console.error('Token error callback:', err);
        handleTokenError(err);
      },
    });
    console.log('Token client initialized');
  } catch (e) {
    console.error('Failed to init token client:', e);
  }
}

// Called when user clicks "Sign in with Google"
function signIn() {
  if (!CONFIG.clientId) {
    console.error('No clientId set in config.js');
    throw new Error('Google OAuth not configured.');
  }

  if (!tokenClient) {
    // Library might not be loaded yet; retry
    initTokenClient();
  }

  if (!tokenClient) {
    throw new Error('Google sign-in library not loaded. Check your internet connection.');
  }

  tokenClient.requestAccessToken({ prompt: 'consent', ux_mode: 'popup' });
}

// Handle successful token response
function handleTokenResponse(response) {
  if (response.error) {
    console.error('Token error:', response.error, response.error_description);
    if (typeof toast !== 'undefined') toast('Sign in failed: ' + (response.error_description || response.error), 'error');
    return;
  }

  accessToken = response.access_token;
  // Token expires in ~1 hour; set expiry with 5-min buffer
  const expiresIn = (response.expires_in || 3600) - 300;
  tokenExpiry = Date.now() + (expiresIn * 1000);

  localStorage.setItem('fh_token', accessToken);
  localStorage.setItem('fh_token_expiry', tokenExpiry.toString());

  if (typeof toast !== 'undefined') toast('Signed in!', 'success');
  if (typeof updateAuthUI !== 'undefined') updateAuthUI();

  // Trigger data load (app.js listens for this via polling or we call directly)
  if (typeof loadAllData !== 'undefined') loadAllData();
  if (typeof autoConfigureCalendars !== 'undefined') autoConfigureCalendars();
}

function handleTokenError(error) {
  console.error('Token error:', error);
  if (typeof toast !== 'undefined') toast('Sign in failed: ' + (error.message || 'Unknown error'), 'error');
}

// Try silent refresh (no user prompt) — only works if user already consented
async function refreshToken() {
  if (!tokenClient) return false;

  return new Promise((resolve) => {
    // Override callback temporarily for silent refresh
    const origCallback = tokenClient.callback;
    tokenClient.callback = (response) => {
      tokenClient.callback = origCallback; // Restore
      if (response.error) {
        resolve(false);
        return;
      }
      accessToken = response.access_token;
      const expiresIn = (response.expires_in || 3600) - 300;
      tokenExpiry = Date.now() + (expiresIn * 1000);
      localStorage.setItem('fh_token', accessToken);
      localStorage.setItem('fh_token_expiry', tokenExpiry.toString());
      resolve(true);
    };

    tokenClient.requestAccessToken({ prompt: '', ux_mode: 'popup' }); // Silent — no UI
  });
}

function signOut() {
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem('fh_token');
  localStorage.removeItem('fh_token_expiry');

  // Also revoke with Google if possible
  if (window.google?.accounts?.oauth2?.revoke) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
}
