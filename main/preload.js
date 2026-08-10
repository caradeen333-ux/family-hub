// preload.js — Injects client secret BEFORE page JS runs
const { contextBridge } = require('electron');

// Secret is bundled in the .exe. Without a valid user OAuth token
// (stored only in the user's browser), this grants zero access.
const CLIENT_SECRET = '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';

contextBridge.exposeInMainWorld('__electron', {
  clientSecret: CLIENT_SECRET,
});
