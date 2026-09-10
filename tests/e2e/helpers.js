// helpers.js — Shared mocks for the Playwright suites.
// Everything here is deterministic and CI-safe: no real Google calls.

export function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fakeIdToken({ sub = 'abc123', email = 'mike@test.local', name = 'Mike' } = {}) {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub, email, name, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

export const TEST_EMAIL = 'mike@test.local';

// Seed accounts into localStorage before the app boots.
// Once-guarded via sessionStorage: addInitScript re-runs on EVERY navigation,
// including the app's own reloads — re-seeding there would clobber runtime
// changes like an account switch.
export function seedAccounts(accounts, active = TEST_EMAIL) {
  return async ({ context }) => {
    await context.addInitScript(({ accounts, active }) => {
      try {
        if (sessionStorage.getItem('__fhSeeded')) return;
        sessionStorage.setItem('__fhSeeded', '1');
        localStorage.setItem('fh_accounts', JSON.stringify(accounts));
        if (active) localStorage.setItem('fh_activeAccount', active);
      } catch { /* cross-origin frame — skip */ }
    }, { accounts, active });
  };
}

export function accountPatch(overrides = {}) {
  return {
    sub: 'abc123',
    name: 'Mike',
    email: TEST_EMAIL,
    accessToken: 'AT-1',
    refreshToken: 'RT-1',
    expiresAt: Date.now() + 3600 * 1000,
    ...overrides,
  };
}

// Mock the token endpoint with a scripted handler.
// handler(route, request) decides the JSON response; use route.fulfill.
export async function mockTokenEndpoint(page, handler) {
  const calls = [];
  await page.route('**/oauth2.googleapis.com/token', async (route) => {
    const body = new URLSearchParams(route.request().postData() ?? '');
    calls.push(Object.fromEntries(body));
    await handler(route, body);
  });
  return calls;
}

// Intercept the Google authorize URL: capture it and bounce back to
// redirectUri with a code + the same state (or an override).
export async function mockAuthorizeRedirect(page, { code = 'test-code', state = null, query = {} } = {}) {
  const seen = [];
  await page.route('**/accounts.google.com/o/oauth2/v2/auth**', async (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const s = state ?? url.searchParams.get('state');
    const params = new URLSearchParams({ code, state: s, ...query });
    await route.fulfill({
      status: 302,
      headers: { Location: `${redirectUri}?${params}` },
    });
  });
  return seen;
}

// Minimal in-memory Drive API mock (REST surface the adapter uses).
export function mockDrive(page) {
  const files = new Map(); // id → {name, content, etag, parents, appProperties}
  let nextId = 1;
  const calls = [];

  const listQuery = (q) => {
    let out = [...files.values()];
    const parent = /'([^']+)' in parents/.exec(q ?? '');
    if (parent) out = out.filter((f) => f.parents?.includes(parent[1]));
    const prop = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q ?? '');
    if (prop) out = out.filter((f) => f.appProperties?.[prop[1]] === prop[2]);
    const name = /name = '([^']+)'/.exec(q ?? '');
    if (name) out = out.filter((f) => f.name === name[1]);
    return out;
  };

  const routeAll = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash
    calls.push({ method: req.method(), path, query: url.search });

    if (path === '/drive/v3/files' && req.method() === 'POST') {
      const meta = JSON.parse(req.postData() ?? '{}');
      const id = `f${nextId++}`;
      files.set(id, { id, name: meta.name, content: '', etag: `e${nextId}`, parents: meta.parents ?? [], appProperties: meta.appProperties ?? {} });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, name: meta.name }) });
    }
    if (path === '/drive/v3/files' && req.method() === 'GET') {
      const files_ = listQuery(url.searchParams.get('q')).map((f) => ({ id: f.id, name: f.name, etag: f.etag, trashed: false }));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: files_ }) });
    }

    const perm = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(path);
    if (perm && req.method() === 'POST') {
      calls.push({ method: 'permission', fileId: perm[1], body: JSON.parse(req.postData() ?? '{}') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"perm1"}' });
    }

    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (m) {
      const file = files.get(m[1]);
      if (!file) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
      if (url.searchParams.get('alt') === 'media') {
        return route.fulfill({ status: 200, contentType: 'text/plain', body: file.content, headers: { etag: file.etag } });
      }
      if (req.method() === 'PATCH') {
        file.content = req.postData();
        file.etag = `e${nextId++}`;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: file.id, etag: file.etag }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: file.id, name: file.name, etag: file.etag, trashed: false, appProperties: file.appProperties, parents: file.parents }),
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no match"}' });
  };

  // Pre-populate a file (mirrors what provision() left in real Drive)
  const seed = ({ id, name, content = '', parents = ['FOLDER'] }) => {
    files.set(id, { id, name, content, etag: `e${nextId++}`, parents, appProperties: {} });
  };
  seed({ id: 'DIRFILE', name: 'dir.json', content: '{"v":1,"members":{}}' });

  return { files, calls, routeAll, seed };
}

// Seed dirState into IndexedDB before boot (once per session — same
// reload-clobbering concern as seedAccounts)
export function seedDirState(dirState, knownEtags = {}) {
  return async ({ context }) => {
    await context.addInitScript(({ dirState, knownEtags }) => {
      if (sessionStorage.getItem('__fhDirStateSeeded')) return;
      sessionStorage.setItem('__fhDirStateSeeded', '1');
      const req = indexedDB.open('family-hub-local', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('unconfirmed')) db.createObjectStore('unconfirmed', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(dirState, 'dirState');
        tx.objectStore('kv').put(knownEtags, 'knownEtags');
      };
    }, { dirState, knownEtags });
  };
}

export const TEST_DIRSTATE = {
  folderId: 'FOLDER',
  dirFileId: 'DIRFILE',
  memberKey: 'mike',
  name: 'Mike',
  email: TEST_EMAIL,
};
