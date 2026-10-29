/*
 * Cargo POS service worker: the app itself opens without internet.
 * Pages: from the internet first (always the newest app), the copy kept here when there is none.
 * The app's files (/assets/…, icons, the logo): kept here once loaded. /assets/ names change with every new version;
 * the icons and /brand/ pictures keep theirs, so CACHE gets a new number whenever one of them changes.
 * The API (/api/…) is never touched here: the app keeps its own offline data (src/offline.js).
 */
const CACHE = 'cargo-pos-app-v3';

async function keepApp() {
  const cache = await caches.open(CACHE);
  const res = await fetch('/', { cache: 'no-store' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put('/', res);
  // the scripts and styles this version of the app needs
  const files = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|svg|png|webmanifest))"/g)].map((m) => m[1]);
  await Promise.all(files.map(async (f) => { if (!(await cache.match(f))) await cache.add(f).catch(() => {}); }));
  // an older version's files are not needed any more
  for (const k of await cache.keys()) {
    const path = new URL(k.url).pathname;
    if (path.startsWith('/assets/') && !files.includes(path)) await cache.delete(k);
  }
}

self.addEventListener('install', (e) => { e.waitUntil(keepApp().catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);   // an older version's files (old icons, logo …)
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    // a page: the newest from the internet (kept for next time), else the kept app
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) keepApp().catch(() => {});   // this version of the app, kept for when there is no internet
      return res;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  // the app's files: kept copy first, else the internet (and keep it)
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
