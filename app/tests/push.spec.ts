import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, POINT, PT, SESSION, setup, waitForMap } from './street-mocks';
import { isIOS, pushSupport, urlBase64ToUint8Array, type PushEnv } from '../src/lib/push';

// "Notify me on this phone" (components/PushCard, lib/push.ts, src/sw.ts). The browser side is stubbed in
// addInitScript — navigator.userAgent, window.Notification, window.PushManager and navigator.serviceWorker.ready
// (a fake registration whose pushManager logs what the card asks of it) — so every state is reachable in headless
// Chromium; the Worker side is the mocked GET /api/push/key and POST/DELETE /api/me/push.

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ENDPOINT = 'https://push.example.test/send/abc123';
/** A 65-byte raw P-256 point (0x04 ‖ 64 bytes), base64url like GET /api/push/key gives it. */
const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : (i * 37) % 256));
const KEY = Buffer.from(KEY_BYTES).toString('base64url');

interface Stub {
  ua?: string; standalone?: boolean; pushManager?: boolean;
  permission?: NotificationPermission; grant?: NotificationPermission;
  subscribed?: boolean; endpoint?: string;
}
interface PushLog { log: string[] }

async function stubPush(page: Page, o: Stub = {}) {
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
const pushLog = (page: Page) => page.evaluate(() => (window as unknown as { __push: PushLog }).__push.log);

interface Call { method: string; body: unknown }
/** GET /api/push/key + POST/DELETE /api/me/push. */
async function pushApi(page: Page, o: { postStatus?: number } = {}): Promise<Call[]> {
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
/** A signed-in /account with the Updates card (GET /api/me, GET /api/me/following). */
async function account(page: Page, me: Record<string, unknown> = {}) {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [], createdAt: new Date().toISOString(), ...me }) }));
  await page.route(`${API}/api/me/following`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
}
const card = (page: Page, within = '') => page.locator(`${within} .push-card`.trim());

/* ── Pure helpers (no browser) ─────────────────────────────────────────────────────────────────── */
const ENV: PushEnv = { ua: ANDROID, maxTouchPoints: 5, standalone: false, serviceWorker: true, pushManager: true, notification: true, permission: 'default' };

test.describe('lib/push', () => {
  test('pushSupport: ready / blocked / unsupported, and iOS needs a Home Screen install before anything else', () => {
    expect(pushSupport(ENV)).toBe('ready');
    expect(pushSupport({ ...ENV, permission: 'granted' })).toBe('ready');
    expect(pushSupport({ ...ENV, permission: 'denied' })).toBe('blocked');
    expect(pushSupport({ ...ENV, pushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...ENV, serviceWorker: false })).toBe('unsupported');
    expect(pushSupport({ ...ENV, notification: false, permission: null })).toBe('unsupported');
    // iOS Safari in a tab has no PushManager at all: the install hint, not "unsupported".
    expect(pushSupport({ ...ENV, ua: IPHONE, pushManager: false })).toBe('ios-needs-install');
    expect(pushSupport({ ...ENV, ua: IPHONE, pushManager: false, permission: 'denied' })).toBe('ios-needs-install');
    // Installed: the ordinary rules apply (16.4+ exposes PushManager; older iOS is simply unsupported).
    expect(pushSupport({ ...ENV, ua: IPHONE, standalone: true })).toBe('ready');
    expect(pushSupport({ ...ENV, ua: IPHONE, standalone: true, permission: 'denied' })).toBe('blocked');
    expect(pushSupport({ ...ENV, ua: IPHONE, standalone: true, pushManager: false })).toBe('unsupported');
    // iPadOS says Macintosh but has touch points; a real Mac does not.
    expect(isIOS({ ua: IPAD, maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ ua: IPAD, maxTouchPoints: 0 })).toBe(false);
    expect(pushSupport({ ...ENV, ua: IPAD, maxTouchPoints: 5 })).toBe('ios-needs-install');
    expect(pushSupport({ ...ENV, ua: IPAD, maxTouchPoints: 0 })).toBe('ready');
  });

  test('urlBase64ToUint8Array: base64url (no padding, -_ alphabet) → bytes; the 65-byte key round-trips', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(urlBase64ToUint8Array('AQIDBA'))).toEqual([1, 2, 3, 4]); // 6 chars → needs == padding
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([0xfb, 0xff]); // '-' '_' stand for '+' '/'
    expect(Array.from(urlBase64ToUint8Array(' AQID\n'))).toEqual([1, 2, 3]);
    const k = urlBase64ToUint8Array(KEY);
    expect(k.byteLength).toBe(65);
    expect(k[0]).toBe(4);
    expect(Array.from(k)).toEqual(Array.from(KEY_BYTES));
  });

  test('i18n parity: every push.* key exists in both languages', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (f: string) => JSON.parse(readFileSync(resolve(here, '../src/i18n', f), 'utf8')) as Record<string, string>;
    const en = read('strings.en.json'), es = read('strings.es.json');
    const enKeys = Object.keys(en).filter((k) => k.startsWith('push.'));
    expect(enKeys).toEqual(expect.arrayContaining(['push.title', 'push.body', 'push.enable', 'push.on', 'push.off', 'push.blocked', 'push.iosInstall', 'push.error']));
    expect(enKeys.filter((k) => !(k in es))).toEqual([]);
    expect(Object.keys(es).filter((k) => k.startsWith('push.') && !(k in en))).toEqual([]);
    for (const k of enKeys) { expect(es[k].length, k).toBeGreaterThan(0); }
    expect(es['push.title']).not.toBe(en['push.title']);
  });
});

/* ── The card's states (Account → Updates) ─────────────────────────────────────────────────────── */
test('unsupported browser: the card is not rendered at all', async ({ page }) => {
  await account(page);
  await stubPush(page, { pushManager: false });
  await page.goto('/account');
  await expect(page.locator('.account-prefs')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('blocked: the title and the browser-settings hint, no button', async ({ page }) => {
  await account(page);
  await stubPush(page, { permission: 'denied' });
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  await expect(c).toHaveAttribute('data-state', 'blocked');
  await expect(c).toContainText('Notify me on this phone');
  await expect(c).toContainText('Notifications are blocked for this site.');
  await expect(c.locator('button')).toHaveCount(0);
});

test('iPhone in a Safari tab: how to install instead of a dead button; installed (standalone) it is an ordinary Turn on', async ({ page }) => {
  await account(page);
  await stubPush(page, { ua: IPHONE, pushManager: false });
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  await expect(c).toHaveAttribute('data-state', 'ios-needs-install');
  await expect(c).toContainText('add FixMyPVD to your Home Screen first');
  await expect(c.locator('button')).toHaveCount(0);

  await stubPush(page, { ua: IPHONE, standalone: true });
  await page.goto('/account');
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(c.getByRole('button', { name: 'Turn on' })).toBeVisible();
});

test('off → Turn on: permission, the Worker key, subscribe with it, POST the subscription; on → Turn off: unsubscribe + DELETE', async ({ page }) => {
  await account(page);
  const calls = await pushApi(page);
  await stubPush(page);
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(c).toContainText('The same updates as the email, as a notification on this phone.');
  const on = c.getByRole('button', { name: 'Turn on' });
  await expect(on).not.toHaveAttribute('aria-disabled', 'true'); // the subscription check has settled
  expect((await on.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await on.click();
  await expect(c).toHaveAttribute('data-state', 'on');
  await expect(c.locator('.push-on')).toHaveText(/On for this phone$/);
  expect(await pushLog(page)).toEqual(['perm', 'subscribe:65:true']); // the 65-byte key went to PushManager.subscribe
  expect(calls.map((x) => x.method)).toEqual(['KEY', 'POST']);
  const posted = calls[1].body as { endpoint: string; keys: { p256dh: string; auth: string }; ua: string };
  expect(posted.endpoint).toBe(ENDPOINT);
  expect(posted.keys).toEqual({ p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' });
  expect(posted.ua).toContain('Android');
  // Off again.
  const off = c.getByRole('button', { name: 'Turn off on this phone' });
  expect((await off.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await off.click();
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(c.getByRole('button', { name: 'Turn on' })).toBeVisible();
  expect(await pushLog(page)).toEqual(['perm', 'subscribe:65:true', 'unsubscribe']);
  expect(calls.map((x) => x.method)).toEqual(['KEY', 'POST', 'DELETE']);
  expect(calls[2].body).toEqual({ endpoint: ENDPOINT });
});

test('already subscribed and known to the account: opens On without asking anything', async ({ page }) => {
  await account(page, { push: { endpoints: ['https://push.example.test/send/other', ENDPOINT] } });
  const calls = await pushApi(page);
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  await expect(c).toHaveAttribute('data-state', 'on');
  await expect(c.getByRole('button', { name: 'Turn off on this phone' })).toBeVisible();
  expect(calls).toEqual([]);
  expect(await pushLog(page)).toEqual([]);
});

test('this browser is subscribed but the account does not know it (another account used this phone): Off; Turn on re-registers the existing subscription without a new permission prompt or subscribe', async ({ page }) => {
  await account(page, { push: { endpoints: [] } });
  const calls = await pushApi(page);
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  await expect(c).toHaveAttribute('data-state', 'off');
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c).toHaveAttribute('data-state', 'on');
  expect(calls.map((x) => x.method)).toEqual(['KEY', 'POST']);
  expect((calls[1].body as { endpoint: string }).endpoint).toBe(ENDPOINT);
  expect(await pushLog(page)).toEqual(['perm']); // requestPermission on an already-granted site resolves at once; no subscribe
});

test('permission dismissed: stays off with nothing sent; permission denied: becomes the blocked state', async ({ page }) => {
  await account(page);
  const calls = await pushApi(page);
  await stubPush(page, { grant: 'default' });
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c.getByRole('button', { name: 'Turn on' })).not.toHaveAttribute('aria-busy', 'true');
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(c.locator('.push-error')).toHaveCount(0);
  expect(calls).toEqual([]);

  await stubPush(page, { grant: 'denied' });
  await page.goto('/account');
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c).toHaveAttribute('data-state', 'blocked');
  await expect(c).toContainText('Notifications are blocked for this site.');
  expect(calls).toEqual([]);
});

test('a failed POST says so and stays off (the browser subscription is kept for the retry)', async ({ page }) => {
  await account(page);
  const calls = await pushApi(page, { postStatus: 500 });
  await stubPush(page);
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c.locator('.push-error')).toHaveText("Couldn't save that. Try again.");
  await expect(c).toHaveAttribute('data-state', 'off');
  expect(calls.map((x) => x.method)).toEqual(['KEY', 'POST']);
  // Retry: the existing subscription is reused (no second subscribe) and the error clears on success.
  await page.unroute(`${API}/api/me/push`);
  await page.route(`${API}/api/me/push`, (r) => r.fulfill({ status: 204, body: '' }));
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c).toHaveAttribute('data-state', 'on');
  await expect(c.locator('.push-error')).toHaveCount(0);
  expect(await pushLog(page)).toEqual(['perm', 'subscribe:65:true', 'perm']);
});

/* ── The three places ──────────────────────────────────────────────────────────────────────────── */
/** Digest on for Home = 481 Angell St; c1 (10 Angell St) is 40 m away, within the 60 m that makes it the same place. */
const DIGEST_ME = { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: PT.lat, lng: PT.lng }] };

test('/street: the digest card\'s on-state carries the row (point view); under the suite\'s iPhone UA it is the install hint, so no second "Turn off"', async ({ page }) => {
  await setup(page, { signedIn: true, me: DIGEST_ME });
  await pushApi(page);
  await page.goto(POINT);
  await waitForMap(page);
  await expect(page.locator('.street-digest-on .notice-ok')).toContainText('for Home');
  const c = card(page, '.street-digest');
  await expect(c).toHaveAttribute('data-state', 'ios-needs-install');
  await expect(page.getByRole('button', { name: 'Turn off' })).toHaveCount(1); // the digest's own
});

test('/street: on a push-capable phone the digest card\'s row turns on from the sheet', async ({ page }) => {
  await setup(page, { signedIn: true, me: DIGEST_ME });
  const calls = await pushApi(page);
  await stubPush(page);
  await page.goto(POINT);
  await waitForMap(page);
  const c = card(page, '.street-digest');
  await expect(c).toHaveAttribute('data-state', 'off');
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c).toHaveAttribute('data-state', 'on');
  expect(calls.map((x) => x.method)).toEqual(['KEY', 'POST']);
  // Two adjacent buttons, two names: the digest's own "Turn off" (the Monday email) and the row's "Turn off on this
  // phone" — so a voice-control "click Turn off" and a screen reader's button list are unambiguous.
  await expect(page.locator('.street-digest-on > .btn-ghost')).toHaveText('Turn off');
  await expect(page.locator('.street-digest-on').getByRole('button', { name: 'Turn off', exact: true })).toHaveCount(1);
  await expect(page.locator('.street-digest-on').getByRole('button', { name: 'Turn off on this phone', exact: true })).toHaveCount(1);
  const names = await page.locator('.street-digest-on button').evaluateAll((els) => els.map((e) => e.textContent?.trim()));
  expect(new Set(names).size).toBe(names.length);
});

test('keyboard: Turn on and Turn off keep focus on the one toggle button (the node survives the state flip)', async ({ page }) => {
  await account(page);
  await pushApi(page);
  await stubPush(page);
  await page.goto('/account');
  const c = card(page, '.account-prefs');
  const btn = c.locator('.push-btn');
  await expect(btn).toHaveText('Turn on');
  await expect(btn).not.toHaveAttribute('aria-disabled', 'true');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(c).toHaveAttribute('data-state', 'on');
  await expect(btn).toHaveText('Turn off on this phone');
  await expect(btn).toBeFocused();
  await expect(c.locator('.push-btn')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(btn).toHaveText('Turn on');
  await expect(btn).toBeFocused();
});

test('sign out forgets this phone: DELETE /api/me/push with the still-valid bearer, then the browser subscription is dropped', async ({ page }) => {
  await account(page, { push: { endpoints: [ENDPOINT] } });
  const calls: { method: string; auth: string | null; body: unknown }[] = [];
  await page.route(`${API}/api/me/push`, (r) => {
    calls.push({ method: r.request().method(), auth: r.request().headers()['authorization'] ?? null, body: r.request().postDataJSON() });
    return r.fulfill({ status: 204, body: '' });
  });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'on');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => pushLog(page)).toEqual(['unsubscribe']);
  expect(calls).toEqual([{ method: 'DELETE', auth: `Bearer ${SESSION.idToken}`, body: { endpoint: ENDPOINT } }]);
  expect(await page.evaluate(() => localStorage.getItem('fixmypvd.session'))).toBeNull();
});

test('sign out with no subscription on this phone sends nothing', async ({ page }) => {
  await account(page);
  const calls = await pushApi(page);
  await stubPush(page);
  await page.goto('/account');
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'off');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.waitForTimeout(300);
  expect(calls).toEqual([]);
  expect(await pushLog(page)).toEqual([]);
});

test('/street case card: following shows the row under the pressed toggle — once, even with the digest on for that street; Unfollow moves it to the digest card', async ({ page }) => {
  await setup(page, { signedIn: true, me: { ...DIGEST_ME, cityFollowing: ['c1'] } });
  await pushApi(page);
  await stubPush(page);
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  const detail = page.locator('.street-detail');
  await expect(detail.locator('.street-follow-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.locator('.street-digest-on .notice-ok')).toContainText('for Home');
  await expect(detail.locator('.push-card')).toHaveCount(1);
  await expect(detail.locator('.street-detail-actions .push-card')).toHaveAttribute('data-state', 'off');
  await expect(detail.locator('.street-digest .push-card')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Unfollow' }).click();
  await expect(detail.locator('.street-follow-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(detail.locator('.street-detail-actions .push-card')).toHaveCount(0);
  await expect(detail.locator('.street-digest .push-card')).toHaveCount(1);
  // Not following and no digest for the street (Hope St, far from Home): no row anywhere on the card.
  await page.goto(`${POINT}&case=s1`);
  await waitForMap(page);
  await expect(detail.locator('.street-follow-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(detail.getByRole('button', { name: 'Email me about this street' })).toBeVisible();
  await expect(detail.locator('.push-card')).toHaveCount(0);
});

test('Account → Updates: the row sits in the Updates card under the digest checkboxes', async ({ page }) => {
  await account(page);
  await pushApi(page);
  await stubPush(page);
  await page.goto('/account');
  const prefs = page.locator('.account-prefs');
  await expect(prefs.locator('.push-card')).toHaveCount(1);
  const order = await prefs.evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]));
  expect(order.indexOf('push-card')).toBeGreaterThan(order.lastIndexOf('account-toggle'));
  expect(order.indexOf('push-card')).toBeLessThan(order.indexOf('account-inline'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
