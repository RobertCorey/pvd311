import type { Page } from '@playwright/test';
import { API } from './street-mocks';

/** Browser + Worker stubs for "Notify me on this phone" (components/PushCard, lib/push.ts), shared by push.spec.ts,
 *  account.spec.ts and the pages that must show no phone control. stubPush runs in addInitScript: navigator.userAgent, window.Notification,
 *  window.PushManager and navigator.serviceWorker.ready (a fake registration whose pushManager logs what the card
 *  asks of it), so every card state is reachable in headless Chromium — the suite's own device is an iPhone, which
 *  would otherwise always read "ios-needs-install". pushApi mocks GET /api/push/key and POST/DELETE /api/me/push. */

export const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
export const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
export const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
export const ENDPOINT = 'https://push.example.test/send/abc123';
/** A 65-byte raw P-256 point (0x04 ‖ 64 bytes), base64url like GET /api/push/key gives it. */
export const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 37) % 256));
export const KEY = Buffer.from(KEY_BYTES).toString('base64url');

export interface Stub {
  ua?: string; standalone?: boolean; pushManager?: boolean;
  permission?: NotificationPermission; grant?: NotificationPermission;
  subscribed?: boolean; endpoint?: string;
}
interface PushLog { log: string[] }

export async function stubPush(page: Page, o: Stub = {}) {
  await page.addInitScript((o: Stub & { android: string }) => {
    const w = window as unknown as Record<string, unknown> & { __push: PushLog };
    w.__push = { log: [] };
    Object.defineProperty(navigator, 'userAgent', { get: () => o.ua ?? o.android, configurable: true });
    if (o.standalone != null) Object.defineProperty(navigator, 'standalone', { get: () => o.standalone, configurable: true });
    if (o.pushManager === false) delete w.PushManager;
    else if (!('PushManager' in w)) w.PushManager = function PushManager() { /* feature flag only */ };
    const N = {
      permission: o.permission ?? 'default',
      requestPermission: async () => { w.__push.log.push('perm'); N.permission = o.grant ?? 'granted'; return N.permission; },
    };
    Object.defineProperty(w, 'Notification', { value: N, configurable: true, writable: true });
    const mkSub = (endpoint: string) => ({
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } }),
      unsubscribe: async () => { w.__push.log.push('unsubscribe'); current = null; return true; },
    });
    let current: ReturnType<typeof mkSub> | null = o.subscribed ? mkSub(o.endpoint ?? 'https://push.example.test/send/abc123') : null;
    const reg = {
      pushManager: {
        getSubscription: async () => current,
        subscribe: async (opts: { userVisibleOnly?: boolean; applicationServerKey?: ArrayBufferView }) => {
          w.__push.log.push(`subscribe:${opts.applicationServerKey?.byteLength ?? 'none'}:${String(opts.userVisibleOnly)}`);
          current = mkSub(o.endpoint ?? 'https://push.example.test/send/abc123');
          return current;
        },
      },
    };
    // The real worker still registers (main.tsx); only `ready` — what lib/push.ts awaits — is pointed at the fake.
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg), configurable: true });
  }, { ...o, android: ANDROID });
}
export const pushLog = (page: Page) => page.evaluate(() => (window as unknown as { __push: PushLog }).__push.log);

export interface Call { method: string; body: unknown }
/** GET /api/push/key + POST/DELETE /api/me/push. */
export async function pushApi(page: Page, o: { postStatus?: number } = {}): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route(`${API}/api/push/key`, (r) => { calls.push({ method: 'KEY', body: null }); return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'public, max-age=3600' }, body: JSON.stringify({ publicKey: KEY }) }); });
  await page.route(`${API}/api/me/push`, (r) => {
    const m = r.request().method();
    calls.push({ method: m, body: r.request().postDataJSON() });
    const status = m === 'POST' ? (o.postStatus ?? 204) : 204;
    return r.fulfill({ status, contentType: 'application/json', body: status === 204 ? '' : '{"error":"boom"}' });
  });
  return calls;
}
