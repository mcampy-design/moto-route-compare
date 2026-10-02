// Network-first service worker: always try the network so the newest version
// wins, and fall back to the last good copy when offline. Only this site's own
// GET requests are handled; the route proxy (another origin, POST) is never
// touched or cached.
const CACHE = 'route-compare-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Pages are cached under one key, so ?a=/?b= and share params don't pile up entries
  const key = req.mode === 'navigate' ? new URL('./', location.href).href : req;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(key);
      if (hit) return hit;
      throw err;
    }
  })());
});
