// token-relay.mjs — Tiny token-exchange relay. Holds the WEB client's
// secret server-side and exchanges authorization codes / refreshes with
// Google. Never stores tokens, never logs them. This is the only piece of
// server infrastructure the product needs — the production version runs as
// a Cloudflare Worker (first function of the planned email/service worker).
//
// Local dev run: node scripts/token-relay.mjs   (listens on 127.0.0.1:4791)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let SECRETS = {};
try {
  SECRETS = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'relay-secrets.local.json'), 'utf8'));
} catch {
  console.error('Missing scripts/relay-secrets.local.json — create it with {"webClientId": "...", "webClientSecret": "..."}');
  process.exit(1);
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST' || req.url !== '/exchange') {
    res.writeHead(404, cors);
    res.end('not found');
    return;
  }

  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    // Server-side secret + code exchange with Google. Tokens are returned to
    // the caller and never stored here.
    body.set('client_id', SECRETS.webClientId);
    body.set('client_secret', SECRETS.webClientSecret);
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await resp.text();
    res.writeHead(resp.status, { ...cors, 'Content-Type': 'application/json' });
    res.end(text);
  } catch (err) {
    res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'relay_error', error_description: err.message }));
  }
});

server.listen(4791, '127.0.0.1', () => console.log('token relay on http://127.0.0.1:4791/exchange'));
