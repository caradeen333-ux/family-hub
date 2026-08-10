// cache.js — IndexedDB wrapper for calendar events and notes
// Provides offline-first reads with background sync

const DB_NAME = 'family-hub';
const DB_VERSION = 1;

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('events')) {
        d.createObjectStore('events', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('notes')) {
        d.createObjectStore('notes', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

// ----- Events cache -----
async function cacheEvents(events) {
  const d = await openDB();
  const tx = d.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  store.clear(); // Replace full cache each sync
  for (const ev of events) store.put(ev);
  await txComplete(tx);
}

async function getCachedEvents() {
  const d = await openDB();
  const tx = d.transaction('events', 'readonly');
  const store = tx.objectStore('events');
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ----- Notes cache -----
async function cacheNotes(notes) {
  const d = await openDB();
  const tx = d.transaction('notes', 'readwrite');
  const store = tx.objectStore('notes');
  store.clear();
  for (const n of notes) store.put(n);
  await txComplete(tx);
}

async function getCachedNotes() {
  const d = await openDB();
  const tx = d.transaction('notes', 'readonly');
  const store = tx.objectStore('notes');
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Offline write queue for notes
async function queueOfflineWrite(entry) {
  const d = await openDB();
  const tx = d.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  const existing = await new Promise(r => {
    const req = store.get('offlineQueue');
    req.onsuccess = () => r(req.result);
  });
  const queue = existing ? existing.value : [];
  queue.push({ ...entry, queuedAt: Date.now() });
  store.put({ key: 'offlineQueue', value: queue });
  await txComplete(tx);
}

async function getOfflineQueue() {
  const d = await openDB();
  const tx = d.transaction('meta', 'readonly');
  const store = tx.objectStore('meta');
  const req = store.get('offlineQueue');
  return new Promise(r => { req.onsuccess = () => r(req.result ? req.result.value : []); });
}

async function clearOfflineQueue() {
  const d = await openDB();
  const tx = d.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete('offlineQueue');
  await txComplete(tx);
}

// ----- Meta (sync tokens, last sync time) -----
async function setMeta(key, value) {
  const d = await openDB();
  const tx = d.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txComplete(tx);
}

async function getMeta(key) {
  const d = await openDB();
  const tx = d.transaction('meta', 'readonly');
  const store = tx.objectStore('meta');
  const req = store.get(key);
  return new Promise(r => { req.onsuccess = () => r(req.result ? req.result.value : null); });
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
