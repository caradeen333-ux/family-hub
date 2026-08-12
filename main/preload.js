// preload.js — Bridge between Electron main and renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__electron', {
  // Window controls
  setAlwaysOnTop: (onTop) => ipcRenderer.send('set-always-on-top', onTop),
});
