// PVD 311 service worker.
// App-shell precache + runtime caching so the app loads offline, plus a
// hook to nudge the page to flush its IndexedDB outbox when connectivity
// returns (via Background Sync where available).

const CACHE = 'pvd311-v1';
const GSTATIC = 'https://www.gstatic.com/firebasejs/10.14.1/';

// App shell. gstatic scripts are fetched with mode:'cors' during install so we
// store real (non-opaque) responses; individual failures are tolerated.
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/outbox.js',
  '/categories.js',
  '/style.css',
  '/manifest.json',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  GSTATIC + 'firebase-app-compat.js',
  GSTATIC + 'firebase-firestore-compat.js',
  GSTATIC + 'firebase-analytics-compat.js',
  GSTATIC + 'firebase-storage-compat.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const req = url.startsWith('http')
          ? new Request(url, { mode: 'cors' })
          : new Request(url);
        const resp = await fetch(req);
        if (resp && (resp.ok || resp.type === 'opaque')) {
          await cache.put(url, resp.clone());
        }
      } catch (e) {
        // Tolerate individual precache failures — don't fail the install.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('pvd311-') && k !== CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// Requests we must never intercept/cache: Firestore, Storage, and any other
// Google API backend (auth, installations, analytics collection, etc.).
function isApiRequest(url) {
  const h = url.hostname;
  return (
    h.endsWith('googleapis.com') ||
    h.endsWith('firebaseio.com') ||
    h.endsWith('google-analytics.com') ||
    h.endsWith('analytics.google.com')
  );
}

function isGstaticFirebase(url) {
  return url.origin === 'https://www.gstatic.com' && url.pathname.includes('/firebasejs/');
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && (resp.ok || resp.type === 'opaque')) {
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (e) {
    return cached || Response.error();
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: true });
    return (
      cached ||
      (await cache.match('/index.html')) ||
      (await cache.match('/')) ||
      Response.error()
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  // ignoreSearch so versioned URLs (/app.js?v=15, /style.css?v=12) hit the
  // unversioned precached shell entries on first offline load.
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // gstatic firebase compat scripts: cache-first (rarely change, version-pinned).
  if (isGstaticFirebase(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Never touch dynamic backends.
  if (isApiRequest(url)) return;

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(networkFirst(request));
    } else {
      event.respondWith(staleWhileRevalidate(request));
    }
    return;
  }

  // Other cross-origin (Sentry, ArcGIS geocode, …): pass through untouched.
});

// Background Sync (Chromium/Android). Where available, the page registers the
// 'pvd311-outbox' tag; on fire we ask any open client to run its outbox flush.
// iOS Safari lacks this API — the page's own online/load flush is the primary path.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'pvd311-outbox') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const client of clients) client.postMessage({ type: 'flush-outbox' });
  })());
});
