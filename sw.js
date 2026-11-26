/* Ludo Offline service worker.

   Strategy: cache-first, with a background refresh on every request
   (stale-while-revalidate). The game always opens instantly from the cache,
   including offline, and every launch quietly fetches the latest files.
   When the fetched index.html differs from the cached copy, open pages are told
   to update, so a new deploy reaches players with no manual cache bump.

   CACHE_NAME only needs changing to force-drop every old cached file. */
const CACHE_NAME = 'ludo-offline-v3';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

const ROOT = new URL('./', self.location).href;     // scope root, works from a GitHub Pages subpath
const INDEX = ROOT + 'index.html';

// Both "/" and "/index.html" are the same page; navigations are stored once under INDEX.
function keyFor(request) {
  const u = new URL(request.url);
  u.search = ''; u.hash = '';
  let k = u.href;
  if (request.mode === 'navigate' || k === ROOT) k = INDEX;
  return k;
}

async function sameBytes(a, b) {
  const [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  const u = new Uint8Array(x), v = new Uint8Array(y);
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  return true;
}

async function tellPages() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  pages.forEach(p => p.postMessage({ type: 'content-updated' }));
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(PRECACHE.map(url =>
        // 'reload' skips the browser HTTP cache so the freshest files are stored
        fetch(new Request(url, { cache: 'reload' })).then(res => {
          if (!res.ok) throw new Error('Precache failed: ' + url);
          return cache.put(url, res);
        }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(ROOT)) return;

  const key = keyFor(request);
  const isPage = key === INDEX;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    const cachedCopy = cached && isPage ? cached.clone() : null;      // the page consumes `cached`, so compare against a copy

    const refresh = (async () => {
      const res = await fetch(new Request(key, { cache: 'no-cache' }));   // always revalidate with the server
      if (!res.ok) return res;
      const changed = cachedCopy ? !(await sameBytes(cachedCopy, res.clone())) : false;
      await cache.put(key, res.clone());
      if (isPage) await cache.put(ROOT, res.clone());
      if (changed) await tellPages();
      return res;
    })();

    if (cached) {
      event.waitUntil(refresh.catch(() => {}));           // refresh in the background, ignore being offline
      return cached;
    }
    try { return await refresh; }
    catch (err) { return request.mode === 'navigate' ? (await cache.match(INDEX)) || Response.error() : Response.error(); }
  })());
});
