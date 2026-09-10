// gis.js — Google Identity Services (GIS) Authorization Code flow.
//
// THE mobile/web sign-in path. Spike S2 proved plain PKCE exchanges get
// "client_secret is missing" from Google's token endpoint; the GIS flow
// doesn't need one — the code is issued through Google's own first-party
// popup, so its internal binding authenticates the exchange. The token
// request uses redirect_uri = the page's origin, no secret, no verifier.

let scriptPromise = null;

export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(true);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      scriptPromise = null;
      reject(Object.assign(new Error('gsi script failed'), { gisUnavailable: true }));
    };
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    s.onerror = fail;
    // Aborted/blocked fetches don't always fire onerror — a timeout is the
    // deterministic backstop for the legacy-fallback path
    setTimeout(() => {
      if (!settled && !window.google?.accounts?.oauth2) fail();
    }, 4000);
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// Opens Google's consent popup and resolves with the authorization code.
// The popup origin (window.location.origin) is the exchange redirect_uri.
export function gisSignIn({ clientId, scopes }) {
  return new Promise((resolve, reject) => {
    loadGis()
      .then(() => {
        const oauth2 = window.google?.accounts?.oauth2;
        if (!oauth2?.initCodeClient) {
          reject(Object.assign(new Error('gsi unavailable'), { gisUnavailable: true }));
          return;
        }
        const client = oauth2.initCodeClient({
          client_id: clientId,
          scope: scopes.join(' '),
          ux_mode: 'popup',
          callback: (response) => {
            if (response.code) {
              resolve({ code: response.code, redirectUri: window.location.origin });
            } else {
              reject(Object.assign(new Error(response.error_description || response.error || 'Sign-in cancelled'), {
                gisError: response.error,
              }));
            }
          },
        });
        client.requestCode();
      })
      .catch(reject);
  });
}
