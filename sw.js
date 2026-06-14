/* Service worker — offline caching for the app shell.
 *
 * Strategy:
 *   • App shell (html/css/js/manifest/icons): cache-first, so the app opens
 *     instantly and works offline.
 *   • history.json: network-first, so you always get the freshest data when
 *     online, but fall back to the last cached copy when offline. This is what
 *     lets the installed app still show the accrued history with no signal.
 *
 * Bump CACHE_VERSION whenever you change the shell files to force an update. */
const CACHE_VERSION = 'semi-learn-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // history.json -> network-first
  if (url.pathname.endsWith('history.json')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // everything else -> cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      return res;
    }).catch(() => cached))
  );
});
