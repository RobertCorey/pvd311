import { test, expect, type Page } from '@playwright/test';

// /street — "My street": city cases near an address (mocked /api/street), address search, weekly email opt-in.
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
const POINT = '/street?lat=41.82820&lng=-71.40050&q=481%20Angell%20St';
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const ITEMS = [
  { id: 'c1', caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status: 'Assigned', open: true, createdAt: daysAgo(3), closedAt: null, resolution: null, lat: 41.8283, lng: -71.4006, distanceM: 40 },
  { id: 'c2', caseType: 'Street Light Out', category: 'street_light', street: '22 Thayer St', status: 'Resolved', open: false, createdAt: daysAgo(9), closedAt: daysAgo(1), resolution: 'Bulb replaced.', lat: 41.8284, lng: -71.4007, distanceM: 60 },
  { id: 'c3', caseType: 'Overflowing Dumpster', category: 'trash_private', street: '481 Angell St', status: 'In Progress', open: true, createdAt: daysAgo(0), closedAt: null, resolution: null, lat: 41.8282, lng: -71.4005, distanceM: 3 },
];

const CITY = { days: 7, total: 212, open: 115, closed: 97, located: 180, at: new Date().toISOString(),
  topTypes: [{ caseType: 'Pothole', category: 'pothole', n: 41 }, { caseType: 'Missed Trash Pickup', category: 'missed_pickup', n: 30 }, { caseType: 'Street Light Out', category: 'street_light', n: 12 }, { caseType: 'Graffiti', category: 'graffiti', n: 5 }],
  latest: [
    { id: 'z1', caseType: 'Abandoned Vehicle', category: 'abandoned_vehicle', street: '9 Hope St', status: 'Submitted', open: true, createdAt: daysAgo(0), closedAt: null, resolution: null },
    { id: 'z2', caseType: 'Pothole', category: 'pothole', street: '', status: 'Resolved', open: false, createdAt: daysAgo(4), closedAt: daysAgo(0), resolution: 'Filled.' },
  ] };

async function setup(page: Page, o: { items?: unknown[]; signedIn?: boolean; me?: Record<string, unknown> } = {}) {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  const calls: { method: string; url: string; body: unknown }[] = [];
  await page.route(`${API}/api/street/city*`, (r) => {
    calls.push({ method: 'GET', url: r.request().url(), body: null });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CITY) });
  });
  await page.route(`${API}/api/street?*`, (r) => {
    calls.push({ method: 'GET', url: r.request().url(), body: null });
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: o.items ?? ITEMS, radiusM: 300, days: 30, at: new Date().toISOString() }) });
  });
  if (o.signedIn) {
    await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
    let me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true, streetDigest: false }, addresses: [], following: [], createdAt: daysAgo(30), ...(o.me ?? {}) } as Record<string, unknown>;
    await page.route(`${API}/api/me`, async (r) => {
      const req = r.request();
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON();
        calls.push({ method: 'PATCH', url: req.url(), body });
        me = { ...me, prefs: { ...(me.prefs as object), ...(body.prefs ?? {}) } };
      }
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) });
    });
    await page.route(`${API}/api/me/addresses`, async (r) => {
      const body = r.request().postDataJSON();
      calls.push({ method: 'PUT', url: r.request().url(), body });
      me = { ...me, addresses: [{ id: 'a1', ...body }] };
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ addresses: me.addresses }) });
    });
  }
  return calls;
}

test('no point yet: the prompt plus the citywide week, so there is always something to look at', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/street');
  await expect(page.locator('main h1')).toHaveText('My street');
  await expect(page.locator('.street-empty')).toContainText('Type an address');
  const city = page.locator('.street-city');
  await expect(city.locator('.street-city-h')).toHaveText('This week in Providence');
  await expect(city.locator('.street-summary')).toHaveText('212 requests · 97 closed');
  await expect(city.locator('.street-top-item')).toHaveCount(3);
  await expect(city.locator('.street-top-item').first()).toContainText('Pothole41');
  await expect(city.locator('.street-row')).toHaveCount(2);
  await expect(city.locator('.street-row').nth(1)).toContainText('Street not given');
  await expect(city.locator('.street-row').nth(1)).not.toContainText('m away');
  expect(calls.map((c) => c.url)).toEqual([`${API}/api/street/city?days=7`]);
  await expect(page.locator('.tabbar a[href="/street"]')).toHaveText('My street');
});

test('a point in the URL lists open then closed cases, with distance, status, and the city\'s closing note', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(POINT);
  await expect(page.locator('.street-where')).toHaveText('481 Angell St');
  await expect(page.locator('.street-summary')).toHaveText('2 open · 1 closed in the last 30 days');
  const rows = page.locator('.street-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Pothole');
  await expect(rows.nth(0)).toContainText('40 m away');
  await expect(rows.nth(0)).toContainText('Reported 3 days ago');
  await expect(rows.nth(0).locator('.my-status')).toHaveText('Assigned');
  await expect(rows.nth(1).locator('.my-status')).toHaveText('In progress');
  await expect(rows.nth(2)).toContainText('Closed yesterday');
  await expect(rows.nth(2).locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(rows.nth(2).locator('.my-status')).toHaveText('Closed');
  expect(calls[0].url).toContain('lat=41.82820&lng=-71.40050&radiusM=300&days=30');
});

test('nothing within a few blocks → widens to the neighborhood by itself; still nothing → quiet street + Report + the citywide week', async ({ page }) => {
  const calls = await setup(page, { items: [] });
  await page.goto(POINT);
  await expect(page.locator('.street-none')).toContainText('Nothing reported within this distance');
  const street = calls.filter((c) => c.url.includes('/api/street?')).map((c) => c.url);
  expect(street[0]).toContain('radiusM=300');
  expect(street[1]).toContain('radiusM=800');
  await expect(page.getByRole('button', { name: 'The neighborhood' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.street-none a.btn')).toHaveAttribute('href', '/');
  await expect(page.locator('.street-none .street-city-h')).toHaveText('Meanwhile, across the city this week');
  await expect(page.locator('.street-none .street-row')).toHaveCount(2);
  // A chip the visitor taps is honoured even when empty — no bouncing back out.
  await page.getByRole('button', { name: 'This block' }).click();
  await expect.poll(() => calls.filter((c) => c.url.includes('radiusM=150')).length).toBe(1);
  await expect(page.getByRole('button', { name: 'This block' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.street-none')).toBeVisible();
});

test('a quiet few blocks but a busy neighborhood: widened list with a note, no citywide fallback', async ({ page }) => {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/street/city*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CITY) }));
  await page.route(`${API}/api/street?*`, (r) => {
    const wide = r.request().url().includes('radiusM=800');
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: wide ? ITEMS : [], radiusM: wide ? 800 : 300, days: 30, at: new Date().toISOString() }) });
  });
  await page.goto(POINT);
  await expect(page.locator('.street-widened')).toHaveText("Nothing within a few blocks, so here's the neighborhood.");
  await expect(page.locator('.street-row')).toHaveCount(3);
  await expect(page.locator('.street-city')).toHaveCount(0);
});

test('typing an address geocodes it and puts the point in the URL', async ({ page }) => {
  await setup(page);
  await page.route('https://geocode.arcgis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ location: { x: -71.4005, y: 41.8282 }, score: 100, attributes: { Match_addr: '481 Angell St, Providence, Rhode Island, 02906' } }] }) }));
  await page.goto('/street');
  await page.getByRole('searchbox').or(page.locator('.street-search input')).first().fill('481 angell');
  await page.getByRole('button', { name: 'Look' }).click();
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050&q=481\+Angell\+St/);
  await expect(page.locator('.street-row')).toHaveCount(3);
});

test('signed out: the weekly email card sends you to sign in and come back here', async ({ page }) => {
  await setup(page);
  await page.goto(POINT);
  const link = page.locator('.street-digest a.btn');
  await expect(link).toHaveText('Sign in to get the weekly email');
  expect(decodeURIComponent((await link.getAttribute('href'))!)).toBe(`/account?returnTo=${POINT}`);
});

test('signed in: one tap saves the address and turns the weekly email on; turning it off patches the pref', async ({ page }) => {
  const calls = await setup(page, { signedIn: true });
  await page.goto(POINT);
  await page.getByRole('button', { name: 'Email me about this street' }).click();
  await expect(page.locator('.street-digest-on .notice-ok')).toContainText('On — Mondays, for 481 Angell St');
  const put = calls.find((c) => c.method === 'PUT')!;
  expect(put.body).toEqual({ label: '481 Angell St', address: '481 Angell St', lat: 41.8282, lng: -71.4005 });
  expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ prefs: { streetDigest: true } });
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Email me about this street' })).toBeVisible();
  expect(calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ prefs: { streetDigest: false } });
});

test('signed in with this address already saved and the digest on: shows the on state without asking again', async ({ page }) => {
  await setup(page, { signedIn: true, me: { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: 41.8282, lng: -71.4005 }] } });
  await page.goto(POINT);
  await expect(page.locator('.street-digest-on .notice-ok')).toContainText('for Home');
});
