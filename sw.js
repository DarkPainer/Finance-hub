// Finance Hub service worker.
// - The app's own code (HTML/JS/manifest): network first, so updates arrive straight away;
//   the cached copy is only used offline. Fetched with cache:'no-cache' so the browser's
//   HTTP cache (GitHub Pages allows 10 minutes) can't hand back an old version.
// - Large libraries that never change (pdf.js, Chart.js, Supabase client, icons): cache first.
// - Data calls to Supabase and price APIs: never touched (other origins).
const CACHE = 'fh-v29';
const APP = ['./', 'index.html', 'investing.html', 'invest-core.js', 'hub-store.js', 'poke-core.js', 'demo-data.js', 'vinyl-core.js', 'vinyl.html', 'manifest.webmanifest'];
const LIBS = ['supabase.js', 'chart.umd.js', 'pdf/pdf.min.mjs', 'pdf/pdf.worker.min.mjs', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll([...APP, ...LIBS].map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const path = url.pathname.replace(/^.*\/Finance-hub\//i, '').replace(/^\//, '');
  const isLib = LIBS.some(l => path === l);
  if (isLib) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })));
    return;
  }
  // app code and pages: always try the network first
  e.respondWith(
    fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(req, { cache: 'no-cache' }))
      .then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
