// preload.cjs — Bridge between Electron main and renderer. NO SECRETS.
// OAuth token calls go through main via IPC (CORS-safe, public client).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__electron', {
  // OAuth: main runs the loopback server + token exchange. Returns
  // {ok, tokens: {access_token, refresh_token?, expires_in, id_token}}
  // or {ok:false, error}. refreshOauth returns {access_token, expires_in, ...}
  // and throws with {code:'invalid_grant'} on dead refresh tokens.
  startOauth: () => ipcRenderer.invoke('oauth:start'),
  refreshOauth: (refreshToken) => ipcRenderer.invoke('oauth:refresh', refreshToken),
  oauthClientId: undefined, // desktop public client id lives in main only
  appVersion: () => ipcRenderer.invoke('app-version'),
  setAlwaysOnTop: (onTop) => ipcRenderer.send('set-always-on-top', onTop),
});
