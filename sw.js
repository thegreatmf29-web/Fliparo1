/* ==========================================================================
   Fliparo service worker

   Two jobs, in this order of importance:

   1. Make the app installable. Chrome will not offer "Add to home screen"
      without a service worker that handles fetch. iOS installs without one,
      but Android is half the phones.

   2. Survive a cold start. Render's free instance sleeps after 15 minutes and
      takes 30-60 seconds to wake. Without this, opening Fliparo on a sleeping
      instance is a white screen for most of a minute, which reads as a broken
      app rather than a sleeping server. The shell is served from cache the
      moment the network is slow, so the interface is up while the API is
      still waking.

   What this deliberately does NOT do: touch /api. Every response there is
   user-specific, quota-bearing or money-bearing, and a cached one is a wrong
   one. Requests to /api go straight to the network, always, and a failure
   there is passed through to the app's own error handling rather than being
   papered over with stale data.
   ========================================================================== */

/* Bump this to force every client onto new assets. It is the whole cache
   invalidation story — old caches are deleted wholesale on activate. */
const VERSION = 'fliparo-v1';

/* The shell only. Not every asset: a precache list that names a file which
   404s makes the entire install fail, silently, and the worker never takes
   over at all. */
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png'
];

/* How long the network gets before the cached shell is used instead. Long
   enough that a normal connection always wins and the user sees current code;
   short enough that a sleeping instance does not hold a blank screen. */
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    /* Individually, not addAll: one missing file must not fail the install. */
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Let the page trigger an immediate update after a deploy. */
self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

const timedFetch = (request, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('network slow')), ms);
  fetch(request).then(
    res => { clearTimeout(timer); resolve(res); },
    err => { clearTimeout(timer); reject(err); }
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only this origin, only GET. Everything else is none of our business.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never the API, and never the OAuth round-trips that carry one-time codes.
  if (url.pathname.startsWith('/api/')) return;

  const isNavigation = request.mode === 'navigate'
    || (request.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    /* Network-first with a deadline, falling back to the cached shell. The
       fresh copy is written back so the next cold start has current code. */
    event.respondWith((async () => {
      try {
        const res = await timedFetch(request, NETWORK_TIMEOUT_MS);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put('/', copy)).catch(() => {});
        }
        return res;
      } catch {
        const cached = await caches.match('/', { ignoreSearch: true });
        if (cached) return cached;
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Fliparo</title>' +
          '<body style="background:#08090B;color:#F7F8FA;font:16px system-ui;' +
          'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
          '<div><p style="font-weight:700;margin-bottom:6px">Fliparo is waking up</p>' +
          '<p style="color:#9BA1AE;font-size:14px">Give it a few seconds, then reload.</p></div>',
          { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  /* Static assets: cache first, refreshed in the background. These are
     content-stable — an icon does not change without its name changing — so
     serving the cached copy instantly is free speed. */
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => null);

    return cached || (await network) || Response.error();
  })());
});
