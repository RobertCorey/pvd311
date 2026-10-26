// Web push on this phone ("Notify me on this phone", components/PushCard). Pure helpers over the Push API: feature
// detection that knows about iOS (push works only from a Home Screen install), the VAPID key decoder, and
// subscribe/unsubscribe over the app's service worker registration. The Worker side is worker/src/push.ts
// (GET /api/push/key, POST/DELETE /api/me/push); api/me.ts carries the calls.

export type PushSupport = 'unsupported' | 'ios-needs-install' | 'blocked' | 'ready';

/** What pushSupport() looks at — injectable so the rules are testable without a browser. */
export interface PushEnv {
  /** navigator.userAgent */
  ua: string;
  /** iPadOS 13+ says "Macintosh" but has touch points; iPhones never report 0. */
  maxTouchPoints: number;
  /** navigator.standalone (iOS Safari: installed to the Home Screen) or display-mode: standalone. */
  standalone: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  permission: NotificationPermission | null;
}

export function currentEnv(): PushEnv {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { ua: '', maxTouchPoints: 0, standalone: false, serviceWorker: false, pushManager: false, notification: false, permission: null };
  }
  let standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  try { standalone = standalone || window.matchMedia('(display-mode: standalone)').matches; } catch { /* ignore */ }
  const notification = 'Notification' in window;
  return {
    ua: navigator.userAgent || '',
    maxTouchPoints: navigator.maxTouchPoints || 0,
    standalone,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notification,
    permission: notification ? Notification.permission : null,
  };
}

/** True for every iOS/iPadOS browser (all WebKit): push needs the app installed to the Home Screen there. */
export function isIOS(env: Pick<PushEnv, 'ua' | 'maxTouchPoints'>): boolean {
  return /iP(hone|ad|od)/.test(env.ua) || (/Macintosh/.test(env.ua) && env.maxTouchPoints > 1);
}

/** The card's state: hidden (unsupported), the iOS install hint, blocked by the browser, or ready to toggle.
 *  iOS Safari in a tab has no PushManager at all, so the iOS check comes first — otherwise it would read "unsupported"
 *  and the card would vanish instead of saying how to get it. */
export function pushSupport(env: PushEnv = currentEnv()): PushSupport {
  if (isIOS(env) && !env.standalone) return 'ios-needs-install';
  if (!env.serviceWorker || !env.pushManager || !env.notification) return 'unsupported';
  if (env.permission === 'denied') return 'blocked';
  return 'ready';
}

/** The VAPID public key (base64url, 65 raw P-256 bytes) as the BufferSource PushManager.subscribe wants. */
export function urlBase64ToUint8Array(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

/** The app's service worker registration (main.tsx registers it at startup). `ready` never settles where no worker
 *  is registered (the dev server), so it is raced against a timeout and the card shows its error line instead of hanging. */
export function swRegistration(timeoutMs = 8_000): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.reject(new Error('no_service_worker'));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sw_timeout')), timeoutMs);
    navigator.serviceWorker.ready.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** This browser's current push subscription for the app, or null. */
export async function currentSubscription(reg: ServiceWorkerRegistration | Promise<ServiceWorkerRegistration>): Promise<PushSubscriptionJSON | null> {
  const sub = await (await reg).pushManager.getSubscription();
  return sub ? sub.toJSON() : null;
}

/** Subscribe (or reuse the subscription this browser already holds for `publicKey`; one made for another key — the
 *  Worker re-minted its VAPID pair — is dropped and replaced). Returns the JSON the Worker stores. */
export async function subscribePush(reg: ServiceWorkerRegistration | Promise<ServiceWorkerRegistration>, publicKey: string): Promise<PushSubscriptionJSON> {
  const r = await reg;
  const key = urlBase64ToUint8Array(publicKey);
  let sub = await r.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey != null && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return sub.toJSON();
}

/** Drop this browser's subscription. Returns the endpoint that was removed (for DELETE /api/me/push), or null if none. */
export async function unsubscribePush(reg: ServiceWorkerRegistration | Promise<ServiceWorkerRegistration> = swRegistration()): Promise<string | null> {
  const sub = await (await reg).pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
