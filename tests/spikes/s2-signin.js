// s2-signin.js — Spike S2: secret-less token exchange with REAL Google,
// driven through the user's own logged-in Chrome (no passwords typed, no
// user interaction). Replicates main.cjs's loopback + PKCE flow exactly.
//
// Prereq: Chrome remote debugging ON (chrome://inspect/#remote-debugging),
// user logged into their Google account in Chrome.
//
// Run: node tests/spikes/s2-signin.js

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from '@playwright/test';

const CLIENT_ID = '251957454378-3riapnrcu961tvtfcrdifstv791l70h1.apps.googleusercontent.com';
const SCOPES = 'openid https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file';
const OUT_PATH = path.join(os.tmpdir(), 'fh-spike-tokens.json');

// ---- 1. Chrome DevTools endpoint (toggle mode writes DevToolsActivePort) ----
const profileDir = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const activePort = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split('\n');
const WS_ENDPOINT = `ws://127.0.0.1:${activePort[0]}${activePort[1]}`;
console.log('CDP:', WS_ENDPOINT);

// ---- 2. Loopback server (exact main.cjs flow: state + PKCE) ----
const state = crypto.randomBytes(16).toString('hex');
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const port = server.address()?.port;
  server.close();
  try {
    if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('no code: ' + url.searchParams.get('error'));

    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      redirect_uri: `http://localhost:${port}/callback`,
      code_verifier: verifier,
    });
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.log('EXCHANGE FAILED:', JSON.stringify(data));
      res.writeHead(200).end('exchange failed: ' + JSON.stringify(data));
      process.exit(1);
    }
    console.log('EXCHANGE OK');
    fs.writeFileSync(OUT_PATH, JSON.stringify({ ...data, clientId: CLIENT_ID, savedAt: new Date().toISOString() }, null, 2));

    // Granted scopes, straight from Google
    const info = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + data.access_token).then((r) => r.json());
    console.log('GRANTED SCOPES:', info.scope);
    console.log('TOKENS SAVED:', OUT_PATH);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Family Hub sign-in test OK</h2><p>You can close this tab.</p>');
    process.exit(0);
  } catch (err) {
    console.log('FLOW ERROR:', err.message);
    res.writeHead(200).end('flow error: ' + err.message);
    process.exit(1);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

const authorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: `http://localhost:${PORT}/callback`,
  response_type: 'code',
  scope: SCOPES,
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  // include_granted_scopes: 'true',
});

// ---- 3. Drive the user's real Chrome through account picker + consent ----
const browser = await chromium.connect({ wsEndpoint: WS_ENDPOINT });
console.log('Connected to your Chrome');
const page = await browser.newPage();
await page.goto(authorizeUrl);

async function clickWhenSeen(selectors, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
    await page.waitForTimeout(400);
    if (/localhost:\d+\/callback/.test(page.url())) return false;
  }
  return false;
}

console.log('Waiting for Google screens...');
// Account chooser → pick the first (logged-in) account
await clickWhenSeen(['div[data-email]', 'li[data-email]', '[data-identifier]', 'input[type="email"]']);
// Password screens should not appear (Chrome session already authenticated)
// Unverified-app warning → Advanced → proceed
await clickWhenSeen(['a:has-text("Advanced")', 'button:has-text("Advanced")']);
await clickWhenSeen(['a:has-text("Go to Family Hub")', 'a:has-text("unsafe")']);
// Consent → Continue / Allow
await clickWhenSeen(['button:has-text("Continue")', 'button:has-text("Allow")', '#submit_approve_access']);

console.log('Waiting for the callback to land...');
await new Promise((resolve) => setTimeout(resolve, 10_000));
console.log('Timed out waiting — check the loopback log.');
await browser.close();
process.exit(1);
