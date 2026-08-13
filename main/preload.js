// preload.js — Bridge between Electron main and renderer
const { contextBridge, ipcRenderer } = require('electron');

// Secret is bundled in the .exe. Without a valid user OAuth token
// (stored only in the user's browser), this grants zero access.
// DO NOT REMOVE: v2.0.x stripped this and fresh installs couldn't sign in.
const CLIENT_SECRET = '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';

contextBridge.exposeInMainWorld('__electron', {
  clientSecret: CLIENT_SECRET,
  // Window controls
  setAlwaysOnTop: (onTop) => ipcRenderer.send('set-always-on-top', onTop),
});
