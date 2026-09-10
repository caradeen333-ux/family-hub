// dpop.js — DPoP (RFC 9449) proof generation with WebCrypto. Zero deps.
//
// Why: Google's token endpoint rejects secretless exchanges for our client
// ("client_secret is missing") — DPoP is the documented proof mechanism
// that lets the exchange authenticate by key possession instead. The key
// pair is generated once per browser, the private key never leaves
// IndexedDB, and every request gets a fresh signed proof.

const DB_NAME = 'family-hub-dpop';
const STORE = 'keys';
const KEY_ID = 'dpop-key';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

let keyPromise = null;
let nonce = null; // DPoP-Nonce returned by Google — echoed in the next proof

export function setDpopNonce(value) {
  nonce = value;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadKey() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY_ID);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function saveKey(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// One key pair per browser, persisted as a CryptoKey (non-extractable)
export function getDpopKey() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const stored = await loadKey();
    if (stored) return stored;
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // non-extractable — the private key never leaves this browser
      ['sign']
    );
    await saveKey(pair.privateKey);
    return pair;
  })();
  return keyPromise;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlStr = (str) => b64url(new TextEncoder().encode(str));

// Build a fresh proof JWT for a request (htm/htu must match the request)
export async function buildDpopProof({ method, url } = {}) {
  const { privateKey, publicKey } = await getDpopKey();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);

  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
  const payload = {
    htm: method,
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
    ...(nonce ? { nonce } : {}),
  };

  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  // WebCrypto ECDSA returns raw r||s — exactly what JWT ES256 uses
  return `${signingInput}.${b64url(sig)}`;
}

// Fetch the token endpoint WITH a DPoP proof attached (secretless exchange)
export async function tokenFetchWithDpop(body, { fetchFn = fetch } = {}) {
  const url = TOKEN_ENDPOINT;
  const proof = await buildDpopProof({ method: 'POST', url });
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: proof,
    },
    body,
  });
  const freshNonce = resp.headers.get('DPoP-Nonce');
  if (freshNonce) setDpopNonce(freshNonce);
  return resp;
}
