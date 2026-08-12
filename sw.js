// sw.js — Service Worker for Family Hub PWA
// Caches app shell for offline, serves cached content, handles background sync

const CACHE_NAME = 'family-hub-v4';
const APP_SHELL = [
  '.',
  'index.html',
  'css/app.css',
  'js/config.js',
  'js/cache.js',
  'js/auth.js',
  'js/calendar.js',
  'js/notes.js',
  'js/ui.js',
  'js/app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
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
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for shell, network-first for API calls
// Skip caching on localhost so dev changes appear immediately
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip caching on localhost — always network-first for development
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return; // Let browser handle normally
  }

  // Don't cache Google API calls
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('oauth2.googleapis.com') ||
      url.hostname.includes('accounts.google.com')) {
    return; // Let browser handle normally
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate: return cached, update in background
        const fetchPromise = fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => null);
        return cached;
      }
      // Not in cache: fetch from network
      return fetch(event.request).then((response) => {
        if (!response.ok) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        // Offline fallback for HTML: return cached index.html
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// Background sync for offline writes
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-notes') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'sync-notes' });
        });
      })
    );
  }
});
