// sw.js — Service Worker for Family Hub PWA
// Caches the app shell for offline, stale-while-revalidate, never caches
// Google API calls (they carry auth headers).

const CACHE_NAME = 'family-hub-v6';
const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/version.js',
  './js/config.js',
  './js/app.js',
  './js/ui.js',
  './js/calendar.js',
  './js/notes.js',
  './js/votes.js',
  './js/chores.js',
  './js/provisioning.js',
  './js/auth/oauth.js',
  './js/auth/token.js',
  './js/auth/token-store.js',
  './js/storage/adapter.js',
  './js/storage/drive-adapter.js',
  './js/storage/webdav-adapter.js',
  './js/storage/log-format.js',
  './js/storage/merge.js',
  './js/storage/local-db.js',
  './js/sync/sync-engine.js',
  './js/testing/clock.js',
  './silent.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn('SW: some resources failed to cache, continuing', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});

const GOOGLE_HOSTS = ['googleapis.com', 'accounts.google.com'];

// Fetch: stale-while-revalidate for shell, network-only for Google APIs
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Dev servers: let the browser handle normally
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;

  // Google APIs + OAuth: never cache, never intercept
  if (GOOGLE_HOSTS.some((h) => url.hostname.includes(h))) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        network; // stale-while-revalidate: update in background
        return cached;
      }
      return network.then((response) => {
        if (response) return response;
        // Offline fallback for HTML: return cached index.html
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
