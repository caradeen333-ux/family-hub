// preload.js — loads client secret from gitignored secrets.js
const { contextBridge } = require('electron');

let clientSecret = '';
try {
  // secrets.js is gitignored but bundled in the .exe via electron-builder
  const secrets = require('./secrets');
  clientSecret = secrets.clientSecret || '';
} catch (e) {
  console.warn('[preload] secrets.js not found — OAuth may fail');
}

console.log('[preload] clientSecret available:', !!clientSecret);

contextBridge.exposeInMainWorld('__electron', {
  clientSecret: clientSecret,
});
