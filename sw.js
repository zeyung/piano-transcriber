// Service worker: offline cache + cross-origin isolation.
// Adding COOP/COEP headers here lets the multi-threaded piano model run even on static
// hosts that can't set custom headers (the same trick as coi-serviceworker).
const CACHE = 'piano-transcriber-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // CDN piano samples etc. go straight to network
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Large, versioned-by-content assets: cache first. Everything else: network first.
      const big = /\/(piano-model|piano-samples|ort|tfjs-wasm|model)\//.test(url.pathname) || /\/assets\//.test(url.pathname);
      if (big) {
        const hit = await cache.match(req);
        if (hit) return isolate(hit);
      }
      try {
        const res = await fetch(req);
        if (res.ok && (big || req.mode === 'navigate' || url.pathname.endsWith('/'))) {
          // Caching is best-effort (quota, etc.) and must never fail the request.
          cache.put(req, res.clone()).catch(() => {});
        }
        return isolate(res);
      } catch (err) {
        const hit = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('./') : undefined);
        if (hit) return isolate(hit);
        throw err;
      }
    })(),
  );
});
