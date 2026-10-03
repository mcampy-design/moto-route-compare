// Network-first service worker: always try the network so the newest version
// wins, and fall back to the last good copy when offline. Only this site's own
// GET requests are handled; the route proxy (another origin, POST) is never
// touched or cached. The one exception is the public tile bucket: traffic tiles never
// change for a given version, so they are served cache-first. Each version has its own
// cache, and activating a new worker deletes every cache that isn't the current one.
importScripts('hpms.js'); // defines Hpms.DATA_VERSION, the version in every tile URL
const CACHE = 'route-compare-v1';
const TILE_CACHE = 'route-tiles-' + Hpms.DATA_VERSION;
const TILE_ORIGIN = 'https://pub-c7398e8f9aef4a0a9a7ae6ee5e62c921.r2.dev';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== TILE_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const origin = new URL(req.url).origin;
  if (origin === TILE_ORIGIN) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()); // 404 (no roads in that square) is not stored
      return res;
    })());
    return;
  }
  if (origin !== location.origin) return;
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
