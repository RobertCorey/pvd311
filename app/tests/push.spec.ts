import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, SESSION } from './street-mocks';
import { ANDROID, ENDPOINT, IPAD, IPHONE, KEY, KEY_BYTES, pushApi, pushLog, stubPush } from './push-mocks';
import { isIOS, pushSupport, urlBase64ToUint8Array, type PushEnv } from '../src/lib/push';

// "Notify me on this phone" (components/PushCard, lib/push.ts, src/sw.ts) — the one phone control, in Account → Updates
// under "This phone". The browser side is stubbed in addInitScript (tests/push-mocks.ts stubPush) — navigator.userAgent,
// window.Notification, window.PushManager and navigator.serviceWorker.ready (a fake registration whose pushManager logs
// what the card asks of it) — so every state is reachable in headless Chromium; the Worker side is the mocked GET
// /api/push/key and POST/DELETE /api/me/push.

/** A signed-in account (GET /api/me; nothing followed). */
async function account(page: Page, me: Record<string, unknown> = {}) {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [], createdAt: new Date().toISOString(), ...me }) }));
  await page.route(`${API}/api/me/following`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route(`${API}/api/me/city`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
}
const UPDATES = '/account/updates';
const PHONE = '.account-updates';
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
    expect(enKeys.sort()).toEqual(['push.blocked', 'push.enable', 'push.error', 'push.iosInstall', 'push.off', 'push.on', 'push.title']);
    expect(enKeys.filter((k) => !(k in es))).toEqual([]);
    expect(Object.keys(es).filter((k) => k.startsWith('push.') && !(k in en))).toEqual([]);
    for (const k of enKeys) { expect(es[k].length, k).toBeGreaterThan(0); }
    expect(es['push.title']).not.toBe(en['push.title']);
  });
});

/* ── The card's states (Account → Updates) ─────────────────────────────────────────────────────── */
test('unsupported browser: no card, and no "This phone" section at all', async ({ page }) => {
  await account(page);
  await stubPush(page, { pushManager: false });
  await page.goto(UPDATES);
  await expect(page.getByRole('heading', { name: 'Monday city email' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'This phone' })).toHaveCount(0);
});

test('blocked: the title and the browser-settings hint, no button', async ({ page }) => {
  await account(page);
  await stubPush(page, { permission: 'denied' });
  await page.goto(UPDATES);
  const c = card(page, PHONE);
  await expect(c).toHaveAttribute('data-state', 'blocked');
  await expect(c).toContainText('Notify me on this phone');
  await expect(c).toContainText('Notifications are blocked for this site.');
  await expect(c.locator('button')).toHaveCount(0);
});

test('iPhone in a Safari tab: how to install instead of a dead button; installed (standalone) it is an ordinary Turn on', async ({ page }) => {
  await account(page);
  await stubPush(page, { ua: IPHONE, pushManager: false });
  await page.goto(UPDATES);
  const c = card(page, PHONE);
  await expect(c).toHaveAttribute('data-state', 'ios-needs-install');
  await expect(c).toContainText('add FixMyPVD to your Home Screen first');
  await expect(c.locator('button')).toHaveCount(0);

  await stubPush(page, { ua: IPHONE, standalone: true });
  await page.goto(UPDATES);
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(c.getByRole('button', { name: 'Turn on' })).toBeVisible();
});

test('off → Turn on: permission, the Worker key, subscribe with it, POST the subscription; on → Turn off: unsubscribe + DELETE', async ({ page }) => {
  await account(page);
  const calls = await pushApi(page);
  await stubPush(page);
  await page.goto(UPDATES);
  const c = card(page, PHONE);
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(c).toContainText('Notify me on this phone');
  // What it covers is the "This phone" section's one sentence, over the card.
  await expect(page.getByRole('region', { name: 'This phone' }).locator('.hint')).toHaveText("Notifications here for updates on your reports, the city's questions, requests you follow and the Monday emails.");
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
  await page.goto(UPDATES);
  const c = card(page, PHONE);
  await expect(c).toHaveAttribute('data-state', 'on');
  await expect(c.getByRole('button', { name: 'Turn off on this phone' })).toBeVisible();
  expect(calls).toEqual([]);
  expect(await pushLog(page)).toEqual([]);
});

test('this browser is subscribed but the account does not know it (another account used this phone): Off; Turn on re-registers the existing subscription without a new permission prompt or subscribe', async ({ page }) => {
  await account(page, { push: { endpoints: [] } });
  const calls = await pushApi(page);
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto(UPDATES);
  const c = card(page, PHONE);
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
  await page.goto(UPDATES);
  const c = card(page, PHONE);
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c.getByRole('button', { name: 'Turn on' })).not.toHaveAttribute('aria-busy', 'true');
  await expect(c).toHaveAttribute('data-state', 'off');
  await expect(c.locator('.push-error')).toHaveCount(0);
  expect(calls).toEqual([]);

  await stubPush(page, { grant: 'denied' });
  await page.goto(UPDATES);
  await c.getByRole('button', { name: 'Turn on' }).click();
  await expect(c).toHaveAttribute('data-state', 'blocked');
  await expect(c).toContainText('Notifications are blocked for this site.');
  expect(calls).toEqual([]);
});

test('a failed POST says so and stays off (the browser subscription is kept for the retry)', async ({ page }) => {
  await account(page);
  const calls = await pushApi(page, { postStatus: 500 });
  await stubPush(page);
  await page.goto(UPDATES);
  const c = card(page, PHONE);
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

test('keyboard: Turn on and Turn off keep focus on the one toggle button (the node survives the state flip)', async ({ page }) => {
  await account(page);
  await pushApi(page);
  await stubPush(page);
  await page.goto(UPDATES);
  const c = card(page, PHONE);
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
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.waitForTimeout(300);
  expect(calls).toEqual([]);
  expect(await pushLog(page)).toEqual([]);
});
