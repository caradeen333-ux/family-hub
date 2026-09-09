// preload.js — Bridge between Electron main and renderer
// No secrets. OAuth IPC (startOauth/refreshOauth) is added in Phase 5.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__electron', {
  appVersion: () => ipcRenderer.invoke('app-version'),
  setAlwaysOnTop: (onTop) => ipcRenderer.send('set-always-on-top', onTop),
});
