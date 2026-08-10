// preload.js — Injects client secret BEFORE page JS runs
// Secret is loaded from gitignored secrets.js at build time
const { contextBridge } = require('electron');
const path = require('path');

let secret = '';
try {
  const secrets = require('./secrets');
  secret = secrets.clientSecret || '';
} catch (e) {
  // secrets.js not found — PWA fallback (no secret)
}

contextBridge.exposeInMainWorld('__electron', {
  clientSecret: secret,
});
