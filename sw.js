// Service worker: the app works offline after the first visit (sensor sites may have no cellular signal).
//
// Every file of the app is stored at install time under a name that carries BUILD, a hash of all the files. When any file
// changes, `node tools/stamp_sw.mjs` writes a new BUILD into this file; the browser then sees a changed sw.js, installs the
// new set as a whole (all files or none) and drops the old one. test/sw.test.mjs fails if BUILD is stale or a file is missing.
//
// A page request (the QR code's address ends in ?d=PROCOM-SENSOR-...) always gets the stored index.html, whatever its query.
// Nothing here talks to any server except for the app's own files, once, at install.
const BUILD = '9498fa2b28f30bb1';
const CACHE = 'mrm-fuel-' + BUILD;
const FILES = [
  'index.html', 'style.css', 'manifest.webmanifest', 'app.js', 'config.js', 'util.js', 'core.js', 'ble.js', 'csv.js', 'reportfile.js',
  'export.js', 'fill.js', 'geo.js', 'storage.js', 'maint.js', 'restart.js', 'ota.js', 'regs.js', 'regs_table.js', 'link.js', 'logs.js',
  'fake_sensor.js', 'ui/dom.js', 'ui/connect.js', 'ui/home.js', 'ui/fill.js', 'ui/login.js', 'ui/maint.js', 'ui/fw.js', 'ui/regs.js',
  'ui/logs.js', 'ui/wait.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

const url = (f) => new URL(f, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 'reload' skips the browser's HTTP cache, so a new version is really fetched; addAll fails as a whole if any file fails
    await cache.addAll(FILES.map((f) => new Request(url(f), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('mrm-fuel-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

// A page request must not be answered with a response that came through a redirect (some hosts send /index.html to /): the browser
// refuses it ("a redirected response was used for a request whose redirect mode is not follow") and the page would not open at all.
async function clean(res) {
  return res.redirected ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;     // not ours: the browser handles it
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req.mode === 'navigate' ? url('index.html') : req);
    if (hit) return clean(hit);
    try { return await fetch(req); } catch (e) {
      return new Response('Offline', { status: req.mode === 'navigate' ? 503 : 504, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
