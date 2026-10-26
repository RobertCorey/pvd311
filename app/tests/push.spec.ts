import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, POINT, PT, SESSION, setup, waitForMap } from './street-mocks';
import { ANDROID, ENDPOINT, IPAD, IPHONE, KEY, KEY_BYTES, pushApi, pushLog, stubPush } from './push-mocks';
import { isIOS, pushSupport, urlBase64ToUint8Array, type PushEnv } from '../src/lib/push';
import { GROUPS_ID, PHONE_ID, WATCH_ID, summaryItems, type SummaryItem, type Tr } from '../src/lib/updatesSummary';
import type { Me } from '../src/api/me';

// "Notify me on this phone" (components/PushCard, lib/push.ts, src/sw.ts). The browser side is stubbed in
// addInitScript (tests/push-mocks.ts stubPush) — navigator.userAgent, window.Notification, window.PushManager and
// navigator.serviceWorker.ready (a fake registration whose pushManager logs what the card asks of it) — so every state
// is reachable in headless Chromium; the Worker side is the mocked GET /api/push/key and POST/DELETE /api/me/push.

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

/* ── What you'll hear about (lib/updatesSummary): the lines, without a browser ─────────────────── */
test.describe('lib/updatesSummary', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const en = JSON.parse(readFileSync(resolve(here, '../src/i18n/strings.en.json'), 'utf8')) as Record<string, string>;
  const t: Tr = (k, vars) => { let s = en[k] ?? k; for (const [a, b] of Object.entries(vars ?? {})) s = s.split(`{${a}}`).join(String(b)); return s; };
  const text = (items: SummaryItem[]) => items.map((i) => `${i.before}${i.link}${i.after}`);
  const ME: Me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [], createdAt: '2026-10-01T00:00:00Z' };
  const HOME = { id: 'a1', label: 'Home', address: '481 Angell St, Providence', lat: 41.8282, lng: -71.4005 };
  const WORK = { id: 'a2', label: 'Work', address: '25 Dorrance St, Providence', lat: 41.8239, lng: -71.4128 };
  const UNPLACED = { id: 'a3', label: 'Old', address: 'Somewhere, Providence', lat: null, lng: null };

  test('nothing on → no lines (a left-over type filter alone is not a line); everything on → the five lines in the card\'s order, each with its link and target; the groups follow GROUP_ORDER and stop at four + N', () => {
    expect(summaryItems({ ...ME, prefs: { emailUpdates: false } }, 'off', t)).toEqual([]);
    expect(summaryItems({ ...ME, prefs: { emailUpdates: false, watchGroups: ['trash'] } }, 'off', t)).toEqual([]);
    const all = summaryItems({ ...ME, prefs: { emailUpdates: true, streetDigest: true, weekDigest: true, streetWatch: true, watchGroups: ['water', 'trash', 'lights', 'streets', 'trees'] }, addresses: [HOME, WORK, UNPLACED], cityFollowing: ['c1', 'c2', 'c3'], push: { endpoints: [ENDPOINT, 'https://push.example.test/send/other'] } }, 'on', t);
    expect(all.map((i) => i.key)).toEqual(['reports', 'street', 'week', 'watch', 'groups']);
    expect(text(all)).toEqual([
      'City updates on your reports and the 3 requests you follow',
      'Monday email for 2 saved places', // the unplaced address does not count
      'This week in Providence every Monday',
      'Instant notifications on this phone',
      'Only about: Trash, Streets, Trees, Lights +1',
    ]);
    expect(all.map((i) => i.link)).toEqual(['your reports and the 3 requests you follow', '2 saved places', 'This week in Providence', 'Instant notifications', 'Trash, Streets, Trees, Lights +1']);
    expect(all.map((i) => i.to)).toEqual(['/my', '/street', '/week', `#${PHONE_ID}`, `#${GROUPS_ID}`]);
    expect(all.map((i) => i.icon)).toEqual(['mail', 'calendar', 'calendar', 'bell', 'filter']);
    // Exactly four groups: no "+0".
    expect(summaryItems({ ...ME, prefs: { emailUpdates: false, streetDigest: true, watchGroups: ['trash', 'streets', 'trees', 'lights'] } }, 'off', t).map((i) => i.link)).toEqual(['save a place on the map first', 'Trash, Streets, Trees, Lights']);
    // An unknown group key (an older selection) is skipped rather than shown raw.
    expect(summaryItems({ ...ME, prefs: { emailUpdates: false, streetDigest: true, watchGroups: ['bogus' as never, 'water'] } }, 'off', t).map((i) => i.link)).toEqual(['save a place on the map first', 'Water']);
  });

  test('the singular and empty forms; the phone line follows the PushCard: on here, else the other devices (1 → singular), else turn it on first; where no PushCard renders the line jumps to the watch row', () => {
    const one = summaryItems({ ...ME, prefs: { emailUpdates: true, streetDigest: true }, addresses: [HOME], cityFollowing: ['c1'] }, 'off', t);
    expect(text(one)).toEqual(['City updates on your reports and the one request you follow', 'Monday email for 1 saved place']);
    expect(text(summaryItems({ ...ME, prefs: { emailUpdates: true, streetDigest: true }, addresses: [UNPLACED] }, 'off', t))).toEqual(['City updates on your reports', 'Monday email — save a place on the map first']);
    expect(summaryItems({ ...ME, prefs: { emailUpdates: true, streetDigest: true }, addresses: [UNPLACED] }, 'off', t).map((i) => i.to)).toEqual(['/my', '/street']);
    const watch = (pushState: Parameters<typeof summaryItems>[1], endpoints: string[]) => summaryItems({ ...ME, prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints } }, pushState, t)[0];
    expect(text([watch('on', [ENDPOINT])])).toEqual(['Instant notifications on this phone']);
    expect(text([watch('on', [])])).toEqual(['Instant notifications on this phone']); // just registered; GET /api/me not refreshed yet
    expect(text([watch('off', ['a', 'b'])])).toEqual(['Instant notifications on 2 other devices']);
    expect(text([watch('off', ['a'])])).toEqual(['Instant notifications on 1 other device']);
    expect(text([watch(undefined, ['a'])])).toEqual(['Instant notifications on 1 other device']); // before the card's first report
    expect(text([watch('blocked', ['a'])])).toEqual(['Instant notifications on 1 other device']);
    expect(text([watch('off', [])])).toEqual(['Instant notifications — turn on phone notifications first']);
    expect(watch('off', []).link).toBe('turn on phone notifications first');
    expect(watch('off', []).to).toBe(`#${PHONE_ID}`);
    expect(watch('ios-needs-install', []).to).toBe(`#${PHONE_ID}`); // the card renders the install hint there
    expect(watch('unsupported', ['a']).to).toBe(`#${WATCH_ID}`);
    expect(text([watch('unsupported', ['a'])])).toEqual(['Instant notifications on 1 other device']);
    // An older Worker without `push`: no devices known.
    expect(text(summaryItems({ ...ME, prefs: { emailUpdates: false, streetWatch: true } }, 'off', t))).toEqual(['Instant notifications — turn on phone notifications first']);
    // This phone's own endpoint is never "another device": after Turn off the account's list still carries it until
    // the next GET /api/me; under another account (off, not in the list) the filter changes nothing.
    const mine = (pushState: Parameters<typeof summaryItems>[1], endpoints: string[], thisPhone: string | null) => summaryItems({ ...ME, prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints } }, pushState, t, thisPhone)[0];
    expect(text([mine('off', [ENDPOINT], ENDPOINT)])).toEqual(['Instant notifications — turn on phone notifications first']);
    expect(text([mine('off', [ENDPOINT, 'a'], ENDPOINT)])).toEqual(['Instant notifications on 1 other device']);
    expect(text([mine('off', ['a', 'b'], ENDPOINT)])).toEqual(['Instant notifications on 2 other devices']);
    expect(text([mine('off', ['a'], null)])).toEqual(['Instant notifications on 1 other device']);
    expect(text([mine('on', [ENDPOINT], ENDPOINT)])).toEqual(['Instant notifications on this phone']);
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

/* ── Street watch (components/StreetWatchRow) in Account → Updates ─────────────────────────────── */
const WATCH_NAME = 'Tell me right away when something new is reported near my places';
/** A signed-in /account whose PATCH /api/me merges `prefs` into the account (so a checked box stays checked when the
 *  Worker answers), or fails with `patchStatus`; returns the PATCH bodies. */
type PrefPatch = { prefs?: Record<string, unknown> };
/** The mocked Worker applies a PATCH's prefs on ARRIVAL and answers with that snapshot — after `patch(body, i).delayMs`
 *  when given, so two PATCHes can answer out of order; `status` fails that one (nothing applied); `answered` logs the
 *  bodies in the order the answers left. */
async function accountPrefs(page: Page, me: Record<string, unknown> = {}, o: { patchStatus?: number; patch?: (body: PrefPatch, i: number) => { status?: number; delayMs?: number }; answered?: unknown[] } = {}): Promise<unknown[]> {
  const patches: unknown[] = [];
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  let acct = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [], createdAt: new Date().toISOString(), ...me } as Record<string, unknown>;
  await page.route(`${API}/api/me`, async (r) => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON() as PrefPatch;
      const p = o.patch?.(body, patches.length) ?? {};
      patches.push(body);
      const status = p.status ?? o.patchStatus ?? 200;
      if (status === 200) acct = { ...acct, prefs: { ...(acct.prefs as object), ...(body.prefs ?? {}) } };
      const snapshot = JSON.stringify(acct);
      if (p.delayMs) await new Promise((res) => setTimeout(res, p.delayMs));
      o.answered?.push(body);
      if (status !== 200) return r.fulfill({ status, contentType: 'application/json', body: '{"error":"boom"}' });
      return r.fulfill({ status: 200, contentType: 'application/json', body: snapshot });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(acct) });
  });
  await page.route(`${API}/api/me/following`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  return patches;
}
const watchRow = (page: Page) => page.locator('.account-prefs .watch-row');
const watchBox = (page: Page) => watchRow(page).getByRole('checkbox', { name: WATCH_NAME });

test('Account → Updates, street watch: the row sits right under the phone row; disabled with the hint while push is off; Turn on arms it; check / uncheck PATCH prefs.streetWatch alone, the other prefs untouched', async ({ page }) => {
  const patches = await accountPrefs(page, { prefs: { emailUpdates: false, weekDigest: true } });
  await pushApi(page);
  await stubPush(page);
  await page.goto('/account');
  const prefs = page.locator('.account-prefs');
  const order = await prefs.evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]));
  expect(order.indexOf('watch-row')).toBe(order.indexOf('push-card') + 1);
  expect(order.indexOf('watch-row')).toBeLessThan(order.indexOf('account-inline'));
  const row = watchRow(page), box = watchBox(page);
  await expect(row).toHaveAttribute('data-state', 'needs-push');
  await expect(box).toBeDisabled();
  await expect(row.locator('.watch-hint')).toHaveText('Turn on phone notifications first.');
  await card(page, '.account-prefs').getByRole('button', { name: 'Turn on' }).click();
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'on');
  await expect(box).toBeEnabled();
  await expect(row).toHaveAttribute('data-state', 'off');
  expect((await row.locator('.watch-toggle').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await box.check();
  await expect(box).toBeChecked();
  await expect(row).toHaveAttribute('data-state', 'on');
  await expect(row.locator('.watch-hint')).toHaveText('On — new requests near your places reach this phone right away.');
  expect(patches).toEqual([{ prefs: { streetWatch: true } }]);
  // The other preferences are as they were (the PATCH carried only streetWatch; the Worker's answer kept them).
  await expect(page.getByRole('checkbox', { name: 'Email me when the city updates my reports' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Email me "This week in Providence" every Monday' })).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  expect(patches).toEqual([{ prefs: { streetWatch: true } }, { prefs: { streetWatch: false } }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Account → Updates, street watch: a failed PATCH puts the box back and says so; the next try clears the alert', async ({ page }) => {
  const patches = await accountPrefs(page, { push: { endpoints: [ENDPOINT] } }, { patchStatus: 500 });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  const row = watchRow(page), box = watchBox(page);
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'on');
  await expect(box).toBeEnabled();
  await box.check();
  await expect(row.locator('.watch-error')).toHaveText("Couldn't save that. Try again.");
  await expect(box).not.toBeChecked();
  await expect(row).toHaveAttribute('data-state', 'off');
  expect(patches).toEqual([{ prefs: { streetWatch: true } }]);
  await page.unroute(`${API}/api/me`);
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true, streetWatch: true }, addresses: [], following: [], cityFollowing: [], createdAt: new Date().toISOString(), push: { endpoints: [ENDPOINT] } }) }));
  await box.check();
  await expect(box).toBeChecked();
  await expect(row.locator('.watch-error')).toHaveCount(0);
  await expect(row).toHaveAttribute('data-state', 'on');
});

test('Account → Updates, street watch already on for the account: checked on a subscribed phone; checked and enabled (to turn it off) when this phone is blocked; no row at all in a browser without push unless it is on', async ({ page }) => {
  await accountPrefs(page, { prefs: { emailUpdates: true, streetWatch: true }, push: { endpoints: [ENDPOINT] } });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(watchBox(page)).toBeChecked();
  await expect(watchBox(page)).toBeEnabled();
  await expect(watchRow(page)).toHaveAttribute('data-state', 'on');

  await stubPush(page, { permission: 'denied' });
  await page.goto('/account');
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'blocked');
  await expect(watchBox(page)).toBeChecked();
  await expect(watchBox(page)).toBeEnabled();
  await expect(watchRow(page)).toHaveAttribute('data-state', 'needs-push');
  await expect(watchRow(page).locator('.watch-hint')).toHaveText('Turn on phone notifications first.');

  await stubPush(page, { pushManager: false });
  await page.goto('/account');
  await expect(card(page, '.account-prefs')).toHaveCount(0);
  await expect(watchRow(page)).toHaveCount(1); // on → it stays, so it can be turned off from here
  await expect(watchBox(page)).toBeChecked();
  await expect(watchBox(page)).toBeEnabled();
  await expect(watchRow(page).locator('.watch-hint')).toHaveText("On for your other phones — this browser can't receive notifications."); // no phone row above to point at

  await accountPrefs(page, { prefs: { emailUpdates: true } });
  await page.goto('/account');
  await expect(page.locator('.account-prefs')).toBeVisible();
  await expect(card(page, '.account-prefs')).toHaveCount(0);
  await expect(watchRow(page)).toHaveCount(0);
});

test('Account → Updates, street watch in Spanish: the label and the needs-push hint', async ({ page }) => {
  await accountPrefs(page);
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await stubPush(page);
  await page.goto('/account');
  await expect(watchRow(page).getByRole('checkbox', { name: 'Avisarme de inmediato cuando se reporte algo nuevo cerca de mis lugares' })).toBeDisabled();
  await expect(watchRow(page).locator('.watch-hint')).toHaveText('Primero activa las notificaciones del teléfono.');
});

/* ── Only tell me about (components/WatchGroups) in Account → Updates ─────────────────────────── */
const groupsRow = (page: Page) => page.locator('.account-prefs .watch-groups');
const groupChip = (page: Page, name: string) => groupsRow(page).getByRole('button', { name, exact: true });

test('Account → Updates, watch groups: no rail while neither the watch nor the digest is on; checking the watch brings it in right under the row with All pressed; a tap → one PATCH prefs.watchGroups alone after the debounce; unchecking the watch takes it away', async ({ page }) => {
  const patches = await accountPrefs(page, { push: { endpoints: [ENDPOINT] } });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(watchRow(page)).toHaveAttribute('data-state', 'off');
  await expect(groupsRow(page)).toHaveCount(0);
  await watchBox(page).check();
  await expect(groupsRow(page)).toHaveCount(1);
  const order = await page.locator('.account-prefs').evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]));
  expect(order.indexOf('watch-groups')).toBe(order.indexOf('watch-row') + 1);
  expect(order.indexOf('watch-groups')).toBeLessThan(order.indexOf('account-inline'));
  await expect(groupsRow(page).locator('.watch-groups-title')).toHaveText('Only tell me about');
  await expect(groupsRow(page).getByRole('button')).toHaveCount(11);
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  expect((await groupChip(page, 'Trees').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await groupChip(page, 'Trees').click();
  await expect(groupChip(page, 'Trees')).toHaveAttribute('aria-pressed', 'true'); // at once
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => patches).toEqual([{ prefs: { streetWatch: true } }, { prefs: { watchGroups: ['trees'] } }]);
  await expect(groupChip(page, 'Trees')).toHaveAttribute('aria-pressed', 'true'); // and after the Worker's answer
  await expect(watchBox(page)).toBeChecked(); // the answer kept the other prefs
  await watchBox(page).uncheck();
  await expect(groupsRow(page)).toHaveCount(0);
  expect(patches).toHaveLength(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Account → Updates, watch groups: the digest on (from /street) with the watch off still shows the rail with the saved selection — even in a browser without push, where there are no phone rows at all; a failed PATCH puts the selection back and says so; the next tap clears the alert', async ({ page }) => {
  const patches = await accountPrefs(page, { prefs: { emailUpdates: true, streetDigest: true, watchGroups: ['streets', 'water'] } }, { patchStatus: 500 });
  await stubPush(page, { pushManager: false });
  await page.goto('/account');
  await expect(page.locator('.account-prefs')).toBeVisible();
  await expect(card(page, '.account-prefs')).toHaveCount(0);
  await expect(watchRow(page)).toHaveCount(0);
  await expect(groupsRow(page)).toHaveCount(1);
  await expect(groupChip(page, 'Streets')).toHaveAttribute('aria-pressed', 'true');
  await expect(groupChip(page, 'Water')).toHaveAttribute('aria-pressed', 'true');
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'false');
  await groupChip(page, 'Streets').click();
  await expect(groupChip(page, 'Streets')).toHaveAttribute('aria-pressed', 'false'); // optimistic
  await expect(groupsRow(page).locator('.watch-error')).toHaveText("Couldn't save that. Try again.");
  await expect(groupChip(page, 'Streets')).toHaveAttribute('aria-pressed', 'true'); // put back
  await expect(groupChip(page, 'Water')).toHaveAttribute('aria-pressed', 'true');
  expect(patches).toEqual([{ prefs: { watchGroups: ['water'] } }]);
  // The Worker is well again: the next tap clears the alert and sticks.
  await page.unroute(`${API}/api/me`);
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true, streetDigest: true, watchGroups: ['water'] }, addresses: [], following: [], cityFollowing: [], createdAt: new Date().toISOString() }) }));
  await groupChip(page, 'Streets').click();
  await expect(groupsRow(page).locator('.watch-error')).toHaveCount(0);
  await expect(groupChip(page, 'Streets')).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(600);
  await expect(groupChip(page, 'Streets')).toHaveAttribute('aria-pressed', 'false');
  await expect(groupChip(page, 'Water')).toHaveAttribute('aria-pressed', 'true');
});

const ON_WATCH = { prefs: { emailUpdates: true, streetWatch: true }, push: { endpoints: [ENDPOINT] } };
const groupsOf = (b: unknown) => ((b as PrefPatch).prefs?.watchGroups as string[]) ?? [];
const pressedGroups = (page: Page) => groupsRow(page).locator('[data-group][aria-pressed="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));

test('Account → Updates, watch groups: a superseded PATCH answering late does not roll the rail back — tap Trees (slow PATCH), tap Animals (fast PATCH): when the first answer finally lands the rail still shows both, the watch box stays checked, no alert', async ({ page }) => {
  const answered: unknown[] = [];
  const patches = await accountPrefs(page, ON_WATCH, { answered, patch: (b) => ({ delayMs: groupsOf(b).length === 1 ? 2000 : 0 }) });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  await groupChip(page, 'Trees').click();
  await expect.poll(() => patches).toEqual([{ prefs: { watchGroups: ['trees'] } }]); // A left and is in flight
  await groupChip(page, 'Animals').click();
  await expect.poll(() => answered).toEqual([{ prefs: { watchGroups: ['trees', 'animals'] } }]); // B left and answered first
  await expect.poll(() => pressedGroups(page)).toEqual(['trees', 'animals']);
  await expect.poll(() => answered, { timeout: 5000 }).toHaveLength(2); // now A answers with its stale snapshot
  await page.waitForTimeout(250);
  expect(await pressedGroups(page)).toEqual(['trees', 'animals']); // the Worker holds both; so does the rail
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'false');
  await expect(groupsRow(page).locator('.watch-error')).toHaveCount(0);
  await expect(watchBox(page)).toBeChecked();
  expect(patches).toHaveLength(2);
});

test('Account → Updates, watch groups: a superseded save that did land, then the latest save fails → the rail goes back to what the Worker took (Trees), not to the pre-burst All, with the alert', async ({ page }) => {
  const answered: unknown[] = [];
  const patches = await accountPrefs(page, ON_WATCH, { answered, patch: (b) => (groupsOf(b).length === 1 ? { delayMs: 800 } : { delayMs: 1600, status: 500 }) });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await groupChip(page, 'Trees').click();
  await expect.poll(() => patches).toHaveLength(1);
  await groupChip(page, 'Animals').click();
  await expect.poll(() => patches).toHaveLength(2);
  await expect.poll(() => answered, { timeout: 5000 }).toHaveLength(2); // A (success) at ~0.8 s, then B (500) at ~1.6 s
  await expect(groupsRow(page).locator('.watch-error')).toHaveText("Couldn't save that. Try again.");
  expect(await pressedGroups(page)).toEqual(['trees']);
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'false');
  expect(patches).toEqual([{ prefs: { watchGroups: ['trees'] } }, { prefs: { watchGroups: ['trees', 'animals'] } }]);
});

test('Account → Updates, watch groups: the latest save fails FIRST and the superseded one lands after — the rail reverts to All, then shows Trees (what the Worker took) once that answer arrives; the alert stays', async ({ page }) => {
  const answered: unknown[] = [];
  const patches = await accountPrefs(page, ON_WATCH, { answered, patch: (b) => (groupsOf(b).length === 1 ? { delayMs: 1500 } : { status: 500 }) });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await groupChip(page, 'Trees').click();
  await expect.poll(() => patches).toHaveLength(1); // A has left and is slow
  await groupChip(page, 'Animals').click();
  await expect.poll(() => patches).toHaveLength(2);
  await expect(groupsRow(page).locator('.watch-error')).toHaveText("Couldn't save that. Try again."); // B failed at once
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'true'); // nothing known to have landed yet
  await expect.poll(() => answered, { timeout: 5000 }).toHaveLength(2);
  await expect.poll(() => pressedGroups(page)).toEqual(['trees']);
  await expect(groupsRow(page).locator('.watch-error')).toHaveText("Couldn't save that. Try again.");
});

test('Account → Updates, watch groups: a tap followed at once by leaving the page is not lost', async ({ page }) => {
  const patches = await accountPrefs(page, { prefs: { emailUpdates: true, streetWatch: true }, push: { endpoints: [ENDPOINT] } });
  await page.route(`${API}/api/me/reports`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(groupChip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  await groupChip(page, 'Animals').click();
  await page.getByRole('link', { name: 'My reports' }).click(); // inside the debounce: the unmount sends the tap right away
  await expect(page).toHaveURL(/\/my$/);
  await expect.poll(() => patches).toEqual([{ prefs: { watchGroups: ['animals'] } }]);
});

test('Account → Updates, watch groups in Spanish: the title, All, a group label and the hint', async ({ page }) => {
  await accountPrefs(page, { prefs: { emailUpdates: true, streetWatch: true }, push: { endpoints: [ENDPOINT] } });
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(groupsRow(page).locator('.watch-groups-title')).toHaveText('Avisarme solo de');
  await expect(groupChip(page, 'Todo')).toHaveAttribute('aria-pressed', 'true');
  await expect(groupChip(page, 'Calles')).toHaveAttribute('aria-pressed', 'false');
  await expect(groupsRow(page).locator('.watch-groups-hint')).toHaveText('Aplica al correo semanal y a las notificaciones instantáneas cerca de tus lugares.');
});

/* ── What you'll hear about (components/UpdatesSummary) at the top of Account → Updates ─────────── */
const summary = (page: Page) => page.locator('.account-prefs .account-summary');
const summaryRows = (page: Page) => summary(page).locator('.account-summary-row');
const summaryLine = (page: Page, item: string) => summary(page).locator(`[data-item="${item}"] .account-summary-row`);
const OTHER = 'https://push.example.test/send/other-phone';
const HOME = { id: 'a1', label: 'Home', address: '481 Angell St, Providence', lat: 41.8282, lng: -71.4005 };
/** Everything on: three follows, two located places and one unplaced, five groups, this phone plus one more. */
const EVERYTHING = { prefs: { emailUpdates: true, streetDigest: true, weekDigest: true, streetWatch: true, watchGroups: ['trash', 'streets', 'trees', 'lights', 'water'] }, addresses: [HOME, { id: 'a2', label: 'Work', address: '25 Dorrance St, Providence', lat: 41.8239, lng: -71.4128 }, { id: 'a3', label: 'Old', address: 'Somewhere, Providence', lat: null, lng: null }], cityFollowing: ['c1', 'c2', 'c3'], push: { endpoints: [ENDPOINT, OTHER] } };

test('Account → Updates, summary: everything on → the title and five lines first in the card, each the whole row a ≥ 44 px link (/my, /street, /week, the phone block, the group rail); the in-page links land on the rows they describe; nothing scrolls sideways', async ({ page }) => {
  await accountPrefs(page, EVERYTHING);
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(summary(page).locator('.account-summary-title')).toHaveText("What you'll hear about");
  await expect(summaryRows(page)).toHaveText([
    'City updates on your reports and the 3 requests you follow',
    'Monday email for 2 saved places',
    'This week in Providence every Monday',
    'Instant notifications on this phone',
    'Only about: Trash, Streets, Trees, Lights +1',
  ]);
  expect(await summaryRows(page).evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(['/my', '/street', '/week', '#account-phone', '#account-groups']);
  // The river phrase is the part of each sentence that names where it goes.
  await expect(summary(page).locator('.account-summary-go')).toHaveText(['your reports and the 3 requests you follow', '2 saved places', 'This week in Providence', 'Instant notifications', 'Trash, Streets, Trees, Lights +1']);
  for (const row of await summaryRows(page).all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(summary(page).locator('.account-summary-none')).toHaveCount(0);
  await expect(summary(page).getByRole('button')).toHaveCount(0); // text and links only
  const order = await page.locator('.account-prefs').evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]));
  expect(order[0]).toBe('account-summary');
  expect(order.indexOf('account-toggle')).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The two in-page lines point at the controls below and scroll them in.
  await expect(page.locator('#account-phone')).toHaveClass(/push-card/);
  await expect(page.locator('#account-groups')).toHaveClass(/watch-groups/);
  await summaryLine(page, 'groups').click();
  await expect(page).toHaveURL(/\/account#account-groups$/);
  await expect(page.locator('#account-groups')).toBeInViewport();
  await summaryLine(page, 'watch').click();
  await expect(page).toHaveURL(/\/account#account-phone$/);
  await expect(page.locator('#account-phone')).toBeInViewport();
  // The route lines navigate.
  await summaryLine(page, 'week').click();
  await expect(page).toHaveURL(/\/week$/);
  await page.goBack();
  await summaryLine(page, 'reports').click();
  await expect(page).toHaveURL(/\/my$/);
});

test('Account → Updates, summary: nothing on → "Nothing yet", no list (a left-over type filter does not count); checking a box brings its line in at once and unchecking takes it out; the digest off hides its filter line too', async ({ page }) => {
  await accountPrefs(page, { prefs: { emailUpdates: false, watchGroups: ['trash'] }, push: { endpoints: [ENDPOINT] } });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(summary(page).locator('.account-summary-none')).toHaveText('Nothing yet — pick what you want below.');
  await expect(summaryRows(page)).toHaveCount(0);
  await expect(summary(page)).toHaveAttribute('data-n', '0');
  const email = page.getByRole('checkbox', { name: 'Email me when the city updates my reports' });
  await email.check();
  await expect(summaryRows(page)).toHaveText(['City updates on your reports']); // no follows: the sentence ends there
  await expect(summaryLine(page, 'reports')).toHaveAttribute('href', '/my');
  await expect(summary(page).locator('.account-summary-none')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Email me "This week in Providence" every Monday' }).check();
  await expect(summaryRows(page)).toHaveText(['City updates on your reports', 'This week in Providence every Monday']);
  await watchBox(page).check(); // this phone is on, so the watch line reads "on this phone" and the saved filter shows
  await expect(summaryRows(page)).toHaveText(['City updates on your reports', 'This week in Providence every Monday', 'Instant notifications on this phone', 'Only about: Trash']);
  await watchBox(page).uncheck();
  await expect(summaryRows(page)).toHaveText(['City updates on your reports', 'This week in Providence every Monday']);
  await email.uncheck();
  await expect(summaryRows(page)).toHaveText(['This week in Providence every Monday']);
  await page.getByRole('checkbox', { name: 'Email me "This week in Providence" every Monday' }).uncheck();
  await expect(summary(page).locator('.account-summary-none')).toHaveText('Nothing yet — pick what you want below.');
});

test('Account → Updates, summary, the phone line: subscribed on other phones only → "on 2 other devices" / "on 1 other device"; nothing subscribed → "turn on phone notifications first", and Turn on flips it to "on this phone"; a browser without push keeps the count and points the link at the watch row', async ({ page }) => {
  const line = () => summaryLine(page, 'watch');
  await accountPrefs(page, { prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints: [OTHER, 'https://push.example.test/send/third'] } });
  await stubPush(page); // push-capable, not subscribed
  await page.goto('/account');
  await expect(line()).toHaveText('Instant notifications on 2 other devices');
  await expect(line()).toHaveAttribute('href', '#account-phone');
  await expect(summaryRows(page)).toHaveCount(1);

  await accountPrefs(page, { prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints: [OTHER] } });
  await page.goto('/account');
  await expect(line()).toHaveText('Instant notifications on 1 other device');

  await accountPrefs(page, { prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints: [] } });
  await pushApi(page);
  await page.goto('/account');
  await expect(line()).toHaveText('Instant notifications — turn on phone notifications first');
  await expect(line().locator('.account-summary-go')).toHaveText('turn on phone notifications first');
  await line().click();
  await expect(page.locator('#account-phone')).toBeInViewport();
  await card(page, '.account-prefs').getByRole('button', { name: 'Turn on' }).click();
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'on');
  await expect(line()).toHaveText('Instant notifications on this phone');

  await accountPrefs(page, { prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints: [OTHER] } });
  await stubPush(page, { pushManager: false });
  await page.goto('/account');
  await expect(card(page, '.account-prefs')).toHaveCount(0);
  await expect(line()).toHaveText('Instant notifications on 1 other device');
  await expect(line()).toHaveAttribute('href', '#account-watch');
  await expect(page.locator('#account-watch')).toHaveClass(/watch-row/);
});

test('Account → Updates, summary, the phone line after Turn off: the account\'s endpoint list still holds this phone until the next GET /api/me, so the line discounts it — the only phone → "turn on phone notifications first", this phone plus one more → "on 1 other device"; Turn on again → "on this phone"', async ({ page }) => {
  const line = () => summaryLine(page, 'watch');
  const off = () => card(page, '.account-prefs').getByRole('button', { name: 'Turn off on this phone' });
  await accountPrefs(page, { prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints: [ENDPOINT] } });
  let calls = await pushApi(page);
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(line()).toHaveText('Instant notifications on this phone');
  await off().click();
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'off');
  expect(calls.map((x) => x.method)).toEqual(['DELETE']);
  await expect(line()).toHaveText('Instant notifications — turn on phone notifications first');
  await expect(watchRow(page)).toHaveAttribute('data-state', 'needs-push');
  // On again on the same phone: the re-registered endpoint is this phone's, not another device.
  await card(page, '.account-prefs').getByRole('button', { name: 'Turn on' }).click();
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'on');
  await expect(line()).toHaveText('Instant notifications on this phone');

  await accountPrefs(page, { prefs: { emailUpdates: false, streetWatch: true }, push: { endpoints: [ENDPOINT, OTHER] } });
  calls = await pushApi(page);
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(line()).toHaveText('Instant notifications on this phone');
  await off().click();
  await expect(card(page, '.account-prefs')).toHaveAttribute('data-state', 'off');
  expect(calls.map((x) => x.method)).toEqual(['DELETE']);
  await expect(line()).toHaveText('Instant notifications on 1 other device');
});

test('Account → Updates, summary, singulars and the empty places: one follow and one saved place; the digest on with no located address says to save a place on the map first (link → /street)', async ({ page }) => {
  await accountPrefs(page, { prefs: { emailUpdates: true, streetDigest: true }, addresses: [HOME], cityFollowing: ['c1'] });
  await stubPush(page);
  await page.goto('/account');
  await expect(summaryRows(page)).toHaveText(['City updates on your reports and the one request you follow', 'Monday email for 1 saved place']);
  await expect(summaryLine(page, 'street')).toHaveAttribute('href', '/street');
  await accountPrefs(page, { prefs: { emailUpdates: false, streetDigest: true }, addresses: [{ ...HOME, lat: null, lng: null }] });
  await page.goto('/account');
  await expect(summaryRows(page)).toHaveText(['Monday email — save a place on the map first']);
  await expect(summaryLine(page, 'street')).toHaveAttribute('href', '/street');
  await expect(summaryLine(page, 'street').locator('.account-summary-go')).toHaveText('save a place on the map first');
});

test('Account → Updates, summary in Spanish: the title and the five lines', async ({ page }) => {
  await accountPrefs(page, EVERYTHING);
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account');
  await expect(summary(page).locator('.account-summary-title')).toHaveText('De qué te vamos a avisar');
  await expect(summaryRows(page)).toHaveText([
    'Actualizaciones de la ciudad sobre tus reportes y las 3 solicitudes que sigues',
    'Correo los lunes sobre 2 lugares guardados',
    'Esta semana en Providence cada lunes',
    'Notificaciones instantáneas en este teléfono',
    'Solo sobre: Basura, Calles, Árboles, Luces +1',
  ]);
  await accountPrefs(page, { prefs: { emailUpdates: false, streetWatch: true, streetDigest: true }, push: { endpoints: [OTHER] }, cityFollowing: [] });
  await stubPush(page);
  await page.goto('/account');
  await expect(summaryRows(page)).toHaveText(['Correo los lunes — primero guarda un lugar en el mapa', 'Notificaciones instantáneas en otro dispositivo']);
  await accountPrefs(page, { prefs: { emailUpdates: false } });
  await page.goto('/account');
  await expect(summary(page).locator('.account-summary-none')).toHaveText('Nada todavía — elige abajo lo que quieres recibir.');
});
