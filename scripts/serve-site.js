// serve-site.js — Tiny static server for the built site/ (Playwright webServer).
// Serves the same files GitHub Pages serves, at http://localhost:4173.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const full = path.normalize(path.join(root, filePath));
  if (!full.startsWith(root)) {
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
}).listen(PORT, () => console.log(`site/ served at http://localhost:${PORT}`));
