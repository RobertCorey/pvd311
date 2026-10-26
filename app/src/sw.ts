/// <reference lib="webworker" />
// The app's service worker (vite-plugin-pwa injectManifest; type-checked by tsconfig.sw.json). It does exactly what
// the generated generateSW worker did — precache the built shell, serve /index.html for navigations (never /api/),
// take over at once (autoUpdate) — and adds web push: "Notify me on this phone" (components/PushCard, lib/push.ts).
// The Worker sends { title, body, url, tag } JSON (worker/src/push.ts); a tap opens `url` in the app's own window.
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0] };

self.skipWaiting();
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST, {});
cleanupOutdatedCaches();
// Never cache the API (same-origin /api/ is not used today — the Worker lives on api.fixmypvd.org — but keep the rule).
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

interface PushPayload { title?: string; body?: string; url?: string; tag?: string }

/** `url` from a payload, resolved against this origin; anything cross-origin falls back to the home screen. */
function safeUrl(url: string | undefined): string {
  try {
    const u = new URL(url || '/', self.location.origin);
    return u.origin === self.location.origin ? u.href : self.location.origin + '/';
  } catch { return self.location.origin + '/'; }
}

self.addEventListener('push', (event: PushEvent) => {
  let data: PushPayload = {};
  try { data = (event.data?.json() as PushPayload | null) ?? {}; } catch { data = { body: event.data?.text() ?? '' }; }
  const options = {
    body: data.body ?? '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-mono.svg',
    tag: data.tag || undefined,
    renotify: false, // a repeat on the same tag (one case moving twice) updates quietly
    data: { url: safeUrl(data.url) },
  } as NotificationOptions;
  event.waitUntil(self.registration.showNotification(data.title || 'FixMyPVD', options));
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = safeUrl((event.notification.data as { url?: string } | undefined)?.url);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clients.find((c) => c.url.startsWith(self.location.origin));
    if (client) {
      await client.focus().catch(() => undefined);
      try { await client.navigate(url); return; } catch { /* an uncontrolled window cannot be navigated: open a new one */ }
    }
    await self.clients.openWindow(url);
  })());
});
