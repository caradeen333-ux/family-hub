// local-db.js — IndexedDB local store: the device's own append-only log,
// unconfirmed (not-yet-Drive-acked) entries, and the cached merged view.
//
// Every mutation is local-first: append to the local log, re-merge, re-render,
// then flush to Drive in the background. Offline writes survive restarts.

const DB_NAME = 'family-hub-local';
const DB_VERSION = 1;
const STORE_LOG = 'log'; // own + mirrored events, keyPath 'id'
const STORE_UNCONFIRMED = 'unconfirmed'; // events awaiting Drive read-back ack, keyPath 'id'
const STORE_KV = 'kv'; // dirState, cached view, sync meta — key/value pairs

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LOG)) db.createObjectStore(STORE_LOG, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_UNCONFIRMED)) {
        db.createObjectStore(STORE_UNCONFIRMED, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result?.result ?? undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Append my own events to the local log; they stay in `unconfirmed` until the
// Drive adapter's read-back acknowledgment confirms them.
export async function appendLocal(events) {
  const db = await openDb();
  await tx(db, STORE_LOG, 'readwrite', (store) => {
    for (const ev of events) store.put(ev);
  });
  await tx(db, STORE_UNCONFIRMED, 'readwrite', (store) => {
    for (const ev of events) store.put(ev);
  });
}

// Events this device authored that Drive has not yet acknowledged
export async function getUnconfirmed() {
  const db = await openDb();
  return tx(db, STORE_UNCONFIRMED, 'readonly', (store) => store.getAll());
}

// Mark event ids as acknowledged by Drive (read-back contains them)
export async function markConfirmed(ids) {
  const db = await openDb();
  await tx(db, STORE_UNCONFIRMED, 'readwrite', (store) => {
    for (const id of ids) store.delete(id);
  });
}

// All events in the local log (mirror of remote logs + own events).
// Used to rebuild the merged view instantly on boot while offline.
export async function getLocalEvents() {
  const db = await openDb();
  return tx(db, STORE_LOG, 'readonly', (store) => store.getAll());
}

// Mirror remote log events into the local log (merged with own events)
export async function mirrorEvents(events) {
  const db = await openDb();
  await tx(db, STORE_LOG, 'readwrite', (store) => {
    for (const ev of events) store.put(ev);
  });
}

// Key/value: dirState, cached merged view, knownEtags, lastSyncAt
export async function getKv(key) {
  const db = await openDb();
  return tx(db, STORE_KV, 'readonly', (store) => store.get(key));
}

export async function setKv(key, value) {
  const db = await openDb();
  await tx(db, STORE_KV, 'readwrite', (store) => store.put(value, key));
}

// Full reset (fresh-start / corrupt-state recovery)
export async function clearLocal() {
  const db = await openDb();
  await tx(db, STORE_LOG, 'readwrite', (store) => store.clear());
  await tx(db, STORE_UNCONFIRMED, 'readwrite', (store) => store.clear());
  await tx(db, STORE_KV, 'readwrite', (store) => store.clear());
}
