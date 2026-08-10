// preload.js — Exposes client secret to renderer
// Secret is bundled in the .exe, not publicly visible unless someone
// decompiles the installer. Secret alone grants zero access without
// a valid OAuth refresh token (which lives in the user's browser).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('__electron', {
  clientSecret: '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',
});
