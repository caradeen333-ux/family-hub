// main.cjs — Electron shell for Family Hub (Phase 5).
//
//  - Serves the local site/ bundle over a local HTTP server on a fixed port
//    (http://127.0.0.1:41073). Local HTTP, NOT a custom scheme: Electron's
//    custom-scheme localStorage is never persisted to disk — tokens would die
//    on every restart, violating requirement #1 (logins must stay stable).
//    Localhost HTTP is a secure context, persists localStorage, and keeps a
//    stable origin across app updates.
//  - OAuth: main-process loopback HTTP server on port 0 → opens Google in the
//    default browser → Google redirects to http://localhost:<port>/callback →
//    main validates state and exchanges the code in Node (no CORS issues)
//  - NO SECRETS anywhere. Public clients only.

const { app, BrowserWindow, shell, ipcMain, session } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// FH_TEST_PROFILE=1 → isolated userData in the temp dir (Playwright tests).
// FH_PROFILE_DIR=<abs path> → explicit override (diagnostic sessions).
// The production app on this machine holds its own storage lock; tests must
// never fight it — and must never touch real family data.
if (process.env.FH_TEST_PROFILE === '1' || process.env.FH_PROFILE_DIR) {
  app.setPath('userData', process.env.FH_PROFILE_DIR ?? path.join(os.tmpdir(), 'family-hub-test-profile'));
}

const SITE_DIR = path.join(__dirname, '..', 'site');
const APP_PORT = 41073; // fixed port = stable origin = tokens survive updates
let APP_URL = null;
const CLIENT_ID = '251957454378-3riapnrcu961tvtfcrdifstv791l70h1.apps.googleusercontent.com'; // "Family Hub Desktop"

// Google (verified by spike S2, 2026-09-09) requires client_secret on the
// token endpoint for this client — PKCE does NOT replace it. The secret lives
// ONLY in main/secrets.local.json (gitignored, never in the public repo) and
// is injected into the installed binary at build time. Web code never sees it.
let CLIENT_SECRET = null;
try {
  CLIENT_SECRET = require('./secrets.local.json').desktopClientSecret ?? null;
} catch { /* built without the file — sign-in will fail with the secret error */ }
// email + profile are non-sensitive scopes Google only returns when asked —
// without them the id_token and userinfo contain just `sub`, no email
const SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file';

let mainWindow;
let pendingOauth = null; // {resolve, reject, state}

// ---------- local bundle server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// The bundle origin must be STABLE across launches — localStorage (tokens)
// is keyed by origin including the port. Preferred port order: fixed 41073,
// then whatever port this profile has used before (persisted in prefs.json),
// then a fresh random one that gets persisted for next time.
function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'prefs.json'), 'utf8'));
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  try {
    const prefs = { ...readPrefs(), ...patch };
    fs.writeFileSync(path.join(app.getPath('userData'), 'prefs.json'), JSON.stringify(prefs));
  } catch { /* ignore */ }
}

function startBundleServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let filePath = decodeURIComponent(url.pathname);
    if (filePath === '/' || filePath === '') filePath = '/index.html';
    const full = path.normalize(path.join(SITE_DIR, filePath));

    if (!full.startsWith(SITE_DIR)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  return new Promise((resolve) => {
    const prefs = readPrefs();
    const candidates = [...new Set([prefs.bundlePort ?? APP_PORT, APP_PORT])];
    let index = 0;

    const tryNext = () => {
      const port = candidates[index++] ?? 0; // 0 = random, persisted afterwards
      const onError = (err) => {
        server.removeListener('error', onError);
        if (err.code === 'EADDRINUSE' && index <= candidates.length) {
          tryNext();
        } else if (err.code === 'EADDRINUSE') {
          tryNext(); // random fallback never conflicts
        } else {
          console.error('Family Hub bundle server failed:', err.message);
          app.quit();
        }
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const actual = server.address().port;
        savePrefs({ bundlePort: actual }); // remember for next launch
        APP_URL = `http://127.0.0.1:${actual}/index.html`;
        resolve();
      });
    };
    tryNext();
  });
}

// ---------- loopback OAuth ----------

async function startLoopbackOauth() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    // PKCE: with a verifier/challenge pair the exchange needs no secret for
    // ANY client type (web or desktop) — Google's "client_secret is missing"
    // refusal cannot happen. Also strictly more secure.
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      // Capture BEFORE close() — server.address() is null once closed
      const port = server.address()?.port;
      server.close();
      pendingOauth = null;

      try {
        if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
        const error = url.searchParams.get('error');
        if (error) throw new Error(error);
        const code = url.searchParams.get('code');
        if (!port) throw new Error('loopback server lost its port');

        // The redirect_uri MUST match the authorize request exactly (port
        // included) — a bare 'http://localhost' here is an invalid_grant.
        const callbackUrl = `http://localhost:${port}/callback`;
        const body = new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          grant_type: 'authorization_code',
          redirect_uri: callbackUrl,
          code_verifier: verifier,
        });
        if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
        // Public client: PKCE replaces the secret entirely.
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        const tokenData = await tokenResp.json();
        if (!tokenResp.ok) throw new Error(tokenData.error_description || tokenData.error);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;background:#0d0f1a;color:#eef0fa;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>✓ Signed in</h2><p>You can close this tab.</p></div></body></html>');

        resolve({ ok: true, tokens: tokenData });
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><meta charset="utf-8"></head><body><p>Sign-in failed: ' + err.message + '</p></body></html>');
        resolve({ ok: false, error: err.message });
      }
    });

    // If the user abandons the browser tab, the renderer's "Opening Google…"
    // must not hang forever — resolve with a friendly failure.
    const abandonTimer = setTimeout(() => {
      if (pendingOauth) {
        server.close();
        pendingOauth = null;
        resolve({ ok: false, error: 'Sign-in timed out — please try again' });
      }
    }, 5 * 60 * 1000);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const authorizeUrl =
        'https://accounts.google.com/o/oauth2/v2/auth?' +
        new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: `http://localhost:${port}/callback`,
          response_type: 'code',
          scope: SCOPES,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        });
      shell.openExternal(authorizeUrl);
    });
  });
}

// ---------- window ----------

function createWindow() {
  let alwaysOnTop = false;
  try {
    const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
    if (fs.existsSync(prefsPath)) {
      alwaysOnTop = JSON.parse(fs.readFileSync(prefsPath, 'utf8')).alwaysOnTop || false;
    }
  } catch { /* ignore */ }

  mainWindow = new BrowserWindow({
    width: 500,
    height: 720,
    minWidth: 380,
    minHeight: 500,
    frame: true,
    resizable: true,
    alwaysOnTop,
    skipTaskbar: false,
    // FH_HIDDEN=1 → test mode: never pop a window on the user's screen
    show: process.env.FH_HIDDEN !== '1',
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.setTitle('Family Hub');
  mainWindow.loadURL(APP_URL); // local bundle — no cache clearing, ever

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------- IPC ----------

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('oauth:start', async () => startLoopbackOauth());
ipcMain.handle('oauth:refresh', async (_event, refreshToken) => {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  if (CLIENT_SECRET) body.set('client_secret', CLIENT_SECRET);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error(data.error_description || data.error || 'refresh failed');
    err.code = data.error;
    throw err;
  }
  return data;
});
ipcMain.on('set-always-on-top', (_event, onTop) => {
  if (mainWindow) mainWindow.setAlwaysOnTop(onTop);
  try {
    const prefsPath = path.join(app.getPath('userData'), 'prefs.json');
    fs.writeFileSync(prefsPath, JSON.stringify({ alwaysOnTop: onTop }));
  } catch { /* ignore */ }
});

// ---------- lifecycle ----------

app.whenReady().then(async () => {
  await startBundleServer();
  // First launch after an update: swap the old service worker cache for the
  // new shell — localStorage (tokens) is NOT touched.
  const currentVersion = app.getVersion();
  const versionPath = path.join(app.getPath('userData'), 'version.txt');
  const lastVersion = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : '';
  if (currentVersion !== lastVersion) {
    session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    fs.writeFileSync(versionPath, currentVersion);
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Tokens must survive abrupt exits: force DOM storage to disk on quit
app.on('before-quit', () => {
  session.defaultSession.flushStorageData();
});
