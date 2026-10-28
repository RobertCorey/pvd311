import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, SESSION } from './street-mocks';
import { ENDPOINT, IPHONE, pushApi, stubPush } from './push-mocks';

// Account (/account: the profile) and Account → Updates (/account/updates, screens/AccountUpdates.tsx): every
// subscription in one place, one switch per row — Your reports · Your streets · Requests you follow · Monday city email ·
// This phone. The Worker is mocked with state: PATCH /api/me merges prefs, PUT /api/me/addresses upserts by id in place,
// DELETE removes; the followed lists answer GET and DELETE.

interface Call { method: string; path: string; body: unknown }
const HOME = { id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: 41.8282, lng: -71.4005, digest: true };
const WORK = { id: 'a8', label: 'Work', address: '25 Dorrance St, Providence', lat: 41.8239, lng: -71.4128, digest: false };
const CASE = { id: 'c1', caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status: 'Assigned', open: true, createdAt: new Date().toISOString(), closedAt: null, resolution: null, lat: 41.82856, lng: -71.4005, followedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const REPORT = { id: 'rep1234567', category: 'street_light', categoryLabel: 'Street light out', address: '22 Thayer St', lat: null, lng: null, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: null, portalStatus: null, timeline: [], nextUpdateHint: null, following: true };
const SWITCH = { emailUpdates: 'Email me when the city updates my reports', week: 'This week in Providence' };

/** A signed-in account with a stateful mocked Worker; returns every write (and GET /api/me) in order. `fail` makes the
 *  matching write answer 500 (nothing applied). `lag` (ms): an address write, like the Worker's, reads the list, then
 *  writes the whole list back from what it read and answers after that long. */
async function account(page: Page, o: { me?: Record<string, unknown>; city?: unknown[]; following?: unknown[]; fail?: (c: Call) => boolean; lag?: number } = {}): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  let me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true, weekDigest: false }, addresses: [] as { id: string }[], following: [], cityFollowing: [], createdAt: new Date().toISOString(), ...o.me } as Record<string, unknown> & { addresses: { id: string }[] };
  let city = o.city ?? [];
  let following = o.following ?? [];
  const log = (r: Parameters<Parameters<Page['route']>[1]>[0]) => {
    const req = r.request();
    const c = { method: req.method(), path: new URL(req.url()).pathname, body: req.postDataJSON() };
    calls.push(c);
    return c;
  };
  const boom = { status: 500, contentType: 'application/json', body: '{"error":"boom"}' };
  const ok = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`${API}/api/me`, (r) => {
    const c = log(r);
    if (c.method === 'PATCH') {
      if (o.fail?.(c)) return r.fulfill(boom);
      me = { ...me, prefs: { ...(me.prefs as object), ...((c.body as { prefs?: object }).prefs ?? {}) } };
    }
    return r.fulfill(ok(me));
  });
  const saveAddresses = async (edit: (list: { id: string }[]) => { id: string }[]) => {
    const read = me.addresses;
    if (o.lag) await new Promise((done) => setTimeout(done, o.lag));
    me = { ...me, addresses: edit(read) };
    return ok({ addresses: me.addresses });
  };
  await page.route(`${API}/api/me/addresses`, async (r) => {
    const c = log(r);
    if (o.fail?.(c)) return r.fulfill(boom);
    const body = c.body as { id?: string; digest?: boolean };
    return r.fulfill(await saveAddresses((list) => {
      const entry = { ...body, id: body.id ?? `n${list.length + 1}`, digest: body.digest === true };
      return list.some((a) => a.id === entry.id) ? list.map((a) => (a.id === entry.id ? entry : a)) : [entry, ...list];
    }));
  });
  await page.route(`${API}/api/me/addresses/*`, async (r) => {
    const c = log(r);
    if (o.fail?.(c)) return r.fulfill(boom);
    return r.fulfill(await saveAddresses((list) => list.filter((a) => a.id !== c.path.split('/').pop())));
  });
  for (const [list, set, path] of [[() => city, (v: unknown[]) => { city = v; }, 'city'], [() => following, (v: unknown[]) => { following = v; }, 'following']] as const) {
    await page.route(`${API}/api/me/${path}`, (r) => { const c = log(r); return r.fulfill(o.fail?.(c) ? boom : ok({ items: list() })); });
    await page.route(`${API}/api/me/${path}/*`, (r) => {
      const c = log(r);
      if (o.fail?.(c)) return r.fulfill(boom);
      set(list().filter((x) => (x as { id: string }).id !== decodeURIComponent(c.path.split('/').pop()!)));
      return r.fulfill({ status: 204, body: '' });
    });
  }
  return calls;
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('signed out: /account/updates (the mails\' footer link) asks you to sign in first, and a sign-in that comes back lands on Updates', async ({ page }) => {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.goto('/account/updates');
  await expect(page).toHaveURL(/\/account\?returnTo=%2Faccount%2Fupdates$/);
  await expect(page.getByRole('button', { name: 'Email me a sign-in link' })).toBeVisible();
  await expect(page.locator('.account-tabs')).toHaveCount(0);
  // Signed in with that returnTo (what the sign-in flow does) → straight to the tab.
  await account(page);
  await page.goto('/account?returnTo=%2Faccount%2Fupdates');
  await expect(page).toHaveURL(/\/account\/updates$/);
  await expect(page.getByRole('heading', { name: 'Your reports' })).toBeVisible();
});

test('tabs: "Account" | "Updates" are real links with aria-current; Account keeps the profile and no subscription controls; Updates has the sections in order, with no summary; one GET /api/me for both', async ({ page }) => {
  const calls = await account(page, { me: { displayName: 'Ana', admin: true } });
  await page.goto('/account');
  const tabs = page.getByRole('navigation', { name: 'Account sections' });
  const acct = tabs.getByRole('link', { name: 'Account', exact: true });
  const upd = tabs.getByRole('link', { name: 'Updates', exact: true });
  await expect(acct).toHaveAttribute('aria-current', 'page');
  await expect(acct).toHaveAttribute('href', '/account');
  await expect(upd).toHaveAttribute('href', '/account/updates');
  await expect(upd).not.toHaveAttribute('aria-current', 'page');
  for (const t of [acct, upd]) expect((await t.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // The profile: email, My reports (+ Admin), the name, sign out — and nothing to subscribe to.
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText('Your account');
  await expect(main.locator('.account-email')).toHaveText('me@example.com');
  await expect(main.getByRole('link', { name: 'My reports' })).toBeVisible();
  await expect(main.getByRole('link', { name: 'Admin' })).toBeVisible();
  await expect(main.getByLabel('Name (optional)')).toHaveValue('Ana');
  await expect(main.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(main.getByRole('switch')).toHaveCount(0);
  await expect(main.getByRole('checkbox')).toHaveCount(0);
  await expect(main.locator('.push-card')).toHaveCount(0);
  await expect(main.getByRole('heading', { level: 2 })).toHaveCount(0);

  await upd.click();
  await expect(page).toHaveURL(/\/account\/updates$/);
  await expect(upd).toHaveAttribute('aria-current', 'page');
  await expect(acct).not.toHaveAttribute('aria-current', 'page');
  await expect(main.getByRole('heading', { level: 2 })).toHaveText(['Your reports', 'Your streets', 'Requests you follow', 'Monday city email', 'This phone']);
  await expect(main.locator('.account-summary')).toHaveCount(0);
  await expect(main).not.toContainText("What you'll hear about");
  await expect(main.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/me')).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Back to Account by its tab.
  await acct.click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(main.getByRole('button', { name: 'Sign out' })).toBeVisible();
});

test('Your reports: one switch for prefs.emailUpdates — PATCH that pref alone; the line that the city\'s questions always come by email; a failed PATCH puts the switch back and says so in the section', async ({ page }) => {
  let fail = false;
  const calls = await account(page, { fail: () => fail });
  await page.goto('/account/updates');
  const sec = section(page, 'Your reports');
  const sw = sec.getByRole('switch', { name: SWITCH.emailUpdates });
  await expect(sw).toBeChecked();
  await expect(sec.locator('.hint')).toHaveText('Also covers the requests you follow. When the city asks you a question about a report, we always email you.');
  expect((await sec.locator('.switch-row').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(() => writes(calls)).toEqual([{ method: 'PATCH', path: '/api/me', body: { prefs: { emailUpdates: false } } }]);
  fail = true;
  await sw.click();
  await expect(sec.getByRole('alert')).toHaveText("We couldn't save that. Please try again.");
  await expect(sw).not.toBeChecked();
  fail = false;
  await sw.click();
  await expect(sw).toBeChecked();
  await expect(sec.getByRole('alert')).toHaveCount(0);
});

test('Your streets: a row per saved street — name, address, its "Monday email" switch, Remove; the switch PUTs that address back whole with the flag flipped and the rows stay in place; Remove → DELETE', async ({ page }) => {
  const calls = await account(page, { me: { addresses: [HOME, WORK] } });
  await page.goto('/account/updates');
  const sec = section(page, 'Your streets');
  const rows = sec.locator('.account-street');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Home');
  await expect(rows.nth(0)).toContainText('481 Angell St, Providence');
  await expect(sec.locator('.account-lead')).toHaveText('One email on Monday mornings for each street you switch on: what was reported and what got closed within a few blocks.');
  const home = sec.getByRole('switch', { name: 'Monday email — Home' });
  const work = sec.getByRole('switch', { name: 'Monday email — Work' });
  await expect(home).toBeChecked();
  await expect(work).not.toBeChecked();
  await work.click();
  await expect(work).toBeChecked();
  await expect.poll(() => writes(calls)).toEqual([{ method: 'PUT', path: '/api/me/addresses', body: { ...WORK, digest: true } }]);
  await home.click();
  await expect(home).not.toBeChecked();
  await expect.poll(() => writes(calls)).toHaveLength(2);
  expect(writes(calls)[1]).toEqual({ method: 'PUT', path: '/api/me/addresses', body: { ...HOME, digest: false } });
  await expect(rows.nth(0)).toContainText('Home'); // an edit keeps its place
  expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]); // never prefs.streetDigest
  // Remove Work.
  await sec.getByRole('button', { name: 'Remove Work' }).click();
  await expect(rows).toHaveCount(1);
  expect(writes(calls)[2]).toEqual({ method: 'DELETE', path: '/api/me/addresses/a8', body: null });
  expect((await sec.getByRole('button', { name: 'Remove Home' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('Your streets: two quick switches go one at a time and both stick — the first answer does not flick the second back, and a reload shows both', async ({ page }) => {
  const calls = await account(page, { me: { addresses: [HOME, WORK] }, lag: 400 });
  await page.goto('/account/updates');
  const sec = section(page, 'Your streets');
  const home = sec.getByRole('switch', { name: 'Monday email — Home' });
  const work = sec.getByRole('switch', { name: 'Monday email — Work' });
  const answer = () => page.waitForResponse((r) => r.url().endsWith('/api/me/addresses'));
  const first = answer();
  await work.click();
  await home.click();
  await expect(work).toBeChecked();
  await expect(home).not.toBeChecked();
  await first;
  expect(writes(calls)).toHaveLength(1); // the second waits for the first's answer
  const second = answer();
  await page.waitForTimeout(150);
  expect(await home.isChecked()).toBe(false); // the first answer (Home still on) is not shown while the second waits
  await second;
  expect(writes(calls).map((c) => c.body)).toEqual([{ ...WORK, digest: true }, { ...HOME, digest: false }]);
  await expect(work).toBeChecked();
  await expect(home).not.toBeChecked();
  await page.reload();
  await expect(work).toBeChecked();
  await expect(home).not.toBeChecked();
});

test('Your streets: Remove then a quick switch on another street — the removed one stays gone (on the server too) and the switch sticks', async ({ page }) => {
  const calls = await account(page, { me: { addresses: [HOME, WORK] }, lag: 400 });
  await page.goto('/account/updates');
  const sec = section(page, 'Your streets');
  const rows = sec.locator('.account-street');
  const home = sec.getByRole('switch', { name: 'Monday email — Home' });
  const put = page.waitForResponse((r) => r.url().endsWith('/api/me/addresses') && r.request().method() === 'PUT');
  await sec.getByRole('button', { name: 'Remove Work' }).click();
  await home.click();
  await expect(rows).toHaveCount(1);
  await expect(home).not.toBeChecked();
  await put;
  expect(writes(calls).map((c) => c.method)).toEqual(['DELETE', 'PUT']);
  await expect(rows).toHaveCount(1);
  await expect(home).not.toBeChecked();
  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Home');
  await expect(home).not.toBeChecked();
});

test('Your streets: a failed switch save puts it back and says so in the section', async ({ page }) => {
  await account(page, { me: { addresses: [WORK] }, fail: (c) => c.method === 'PUT' });
  await page.goto('/account/updates');
  const sec = section(page, 'Your streets');
  const sw = sec.getByRole('switch', { name: 'Monday email — Work' });
  await sw.click();
  await expect(sec.getByRole('alert')).toHaveText("We couldn't save that. Please try again.");
  await expect(sw).not.toBeChecked();
});

test('Your streets: nothing saved → one line with the map link; Add a street → PUT {label, address} with no digest (a new street starts off), its row appears with the switch off', async ({ page }) => {
  const calls = await account(page);
  await page.goto('/account/updates');
  const sec = section(page, 'Your streets');
  await expect(sec.locator('.account-empty')).toHaveText('No streets saved yet. Find yours on the map');
  await expect(sec.getByRole('link', { name: 'Find yours on the map' })).toHaveAttribute('href', '/street');
  const add = sec.getByRole('button', { name: 'Add a street' });
  await expect(add).toBeDisabled();
  await sec.getByLabel('Label').fill('Corner');
  await sec.getByLabel('Address').fill('100 Hope St');
  await add.click();
  await expect(sec.locator('.account-street')).toHaveCount(1);
  await expect(sec.getByRole('switch', { name: 'Monday email — Corner' })).not.toBeChecked();
  expect(writes(calls)).toEqual([{ method: 'PUT', path: '/api/me/addresses', body: { label: 'Corner', address: '100 Hope St' } }]);
  await expect(sec.locator('.account-empty')).toHaveCount(0);
  await expect(sec.getByLabel('Address')).toHaveValue('');
});

test('Requests you follow: one list of followed city requests and followed reports, each linking to it; Unfollow → DELETE the right one and the row goes; nothing followed → one line', async ({ page }) => {
  const calls = await account(page, { city: [CASE], following: [REPORT] });
  await page.goto('/account/updates');
  const sec = section(page, 'Requests you follow');
  const rows = sec.locator('li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Pothole');
  await expect(rows.nth(0)).toContainText('10 Angell St');
  await expect(rows.nth(0).getByRole('link', { name: 'Pothole' })).toHaveAttribute('href', '/street?case=c1&c=41.8286,-71.4005&z=17');
  await expect(rows.nth(1)).toContainText('Street light out');
  await expect(rows.nth(1).getByRole('link', { name: 'Street light out' })).toHaveAttribute('href', '/r/rep1234567');
  await sec.getByRole('button', { name: 'Unfollow — Pothole, 10 Angell St' }).click();
  await expect(rows).toHaveCount(1);
  await sec.getByRole('button', { name: 'Unfollow — Street light out, 22 Thayer St' }).click();
  await expect(sec.locator('li')).toHaveCount(0);
  expect(writes(calls)).toEqual([{ method: 'DELETE', path: '/api/me/city/c1', body: null }, { method: 'DELETE', path: '/api/me/following/rep1234567', body: null }]);
  await page.reload();
  await expect(sec).toContainText("You're not following any requests. Tap Follow on one to hear when it changes.");
});

test('Requests you follow: a failed Unfollow keeps the row and says so', async ({ page }) => {
  await account(page, { city: [CASE], fail: (c) => c.method === 'DELETE' });
  await page.goto('/account/updates');
  const sec = section(page, 'Requests you follow');
  await sec.getByRole('button', { name: /^Unfollow/ }).click();
  await expect(sec.getByRole('alert')).toHaveText("We couldn't save that. Please try again.");
  await expect(sec.locator('li')).toHaveCount(1);
});

test('Requests you follow: a list that fails to load says so — never "You\'re not following any requests"', async ({ page }) => {
  await account(page, { city: [CASE], fail: (c) => c.method === 'GET' && c.path === '/api/me/city' });
  await page.goto('/account/updates');
  const sec = section(page, 'Requests you follow');
  await expect(sec.getByRole('alert')).toHaveText("We couldn't load the requests you follow. Try again later.");
  await expect(sec).not.toContainText("You're not following any requests");
});

test('Monday city email: "This week in Providence" PATCHes prefs.weekDigest alone, the other pref untouched', async ({ page }) => {
  const calls = await account(page, { me: { prefs: { emailUpdates: false, weekDigest: false } } });
  await page.goto('/account/updates');
  const sw = section(page, 'Monday city email').getByRole('switch', { name: SWITCH.week });
  await expect(sw).not.toBeChecked();
  await sw.click();
  await expect(sw).toBeChecked();
  await expect.poll(() => writes(calls)).toEqual([{ method: 'PATCH', path: '/api/me', body: { prefs: { weekDigest: true } } }]);
  await expect(page.getByRole('switch', { name: SWITCH.emailUpdates })).not.toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  expect(writes(calls)[1]).toEqual({ method: 'PATCH', path: '/api/me', body: { prefs: { weekDigest: false } } });
});

test('This phone: the one phone control, last, with the sentence of what it covers — Turn on registers this phone; the suite\'s iPhone tab says how to install instead', async ({ page }) => {
  await account(page);
  const push = await pushApi(page);
  await stubPush(page);
  await page.goto('/account/updates');
  const sec = section(page, 'This phone');
  await expect(sec.locator('.hint').first()).toHaveText("Notifications here for updates on your reports, the city's questions, requests you follow and the Monday emails.");
  await expect(page.locator('.push-card')).toHaveCount(1);
  await sec.getByRole('button', { name: 'Turn on' }).click();
  await expect(sec.locator('.push-card')).toHaveAttribute('data-state', 'on');
  expect(push.map((c) => c.method)).toEqual(['KEY', 'POST']);
  expect(await page.locator('.account-section').last().getAttribute('aria-labelledby')).toBe('updates-phone');

  await stubPush(page, { ua: IPHONE, pushManager: false });
  await page.goto('/account/updates');
  await expect(sec.locator('.push-card')).toHaveAttribute('data-state', 'ios-needs-install');
  await expect(sec.getByRole('button')).toHaveCount(0);
});

test('a subscribed phone reads "on" in Updates without asking again', async ({ page }) => {
  await account(page, { me: { push: { endpoints: [ENDPOINT] } } });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/account/updates');
  await expect(section(page, 'This phone').locator('.push-card')).toHaveAttribute('data-state', 'on');
});

test('Spanish: the tabs, the section titles and the switches', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await account(page, { me: { addresses: [HOME] } });
  await page.goto('/account/updates');
  const tabs = page.getByRole('navigation', { name: 'Secciones de la cuenta' });
  await expect(tabs.getByRole('link')).toHaveText(['Cuenta', 'Actualizaciones']);
  await expect(page.locator('main').getByRole('heading', { level: 2 })).toHaveText(['Tus reportes', 'Tus calles', 'Solicitudes que sigues', 'Correo de la ciudad los lunes', 'Este teléfono']);
  await expect(page.getByRole('switch', { name: 'Correo del lunes — Home' })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Esta semana en Providence' })).toBeVisible();
});

test('i18n parity: every account.* key exists in both languages, translated, with the same placeholders', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (f: string) => JSON.parse(readFileSync(resolve(here, '../src/i18n', f), 'utf8')) as Record<string, string>;
  const en = read('strings.en.json'), es = read('strings.es.json');
  const ours = (k: string) => k.startsWith('account.') || k.startsWith('street.digest.');
  const enKeys = Object.keys(en).filter(ours);
  expect(enKeys.filter((k) => !(k in es))).toEqual([]);
  expect(Object.keys(es).filter(ours).filter((k) => !(k in en))).toEqual([]);
  const holes = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
  for (const k of enKeys) expect(holes(es[k]), k).toEqual(holes(en[k]));
  // The Updates tab's own words are translations, not the English copied over.
  for (const k of ['account.tabs', 'account.tab.account', 'account.tab.updates', 'account.reports.title', 'account.prefs.emailUpdates.hint', 'account.addresses.title', 'account.addresses.hint', 'account.addresses.empty', 'account.addresses.emptyLink', 'account.addresses.digest', 'account.addresses.add', 'account.following.title', 'account.following.empty', 'account.following.unfollow', 'account.week.title', 'account.prefs.weekDigest', 'account.phone.title', 'account.phone.hint', 'street.digest.switch', 'street.digest.manage']) {
    expect(es[k], k).toBeTruthy();
    expect(es[k], k).not.toBe(en[k]);
  }
  // Gone with the summary and the old street-digest card.
  for (const d of [en, es]) for (const k of ['account.prefs.title', 'street.digest.cta', 'street.digest.on', 'street.digest.off', 'push.body']) expect(d[k], k).toBeUndefined();
});
