import { test, expect, type Page } from '@playwright/test';
import { API, DEFAULT_ITEMS, NEAR, POINT, PT, STACK, filler, mapEval, setView, setup, userPan, waitForMap, zoomOf } from './street-mocks';

// /street — the map-first "My street" page (.claude/street-map-spec.md): one mocked GET /api/street/map, everything else
// (bbox, counts, clusters, hoods, URL) computed in the browser. Mobile project = iPhone 13 (390×664); one desktop describe.

const mapCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('/api/street/map'));
const sheet = (page: Page) => page.locator('.street-sheet');
const grab = (page: Page) => page.locator('.street-grab');
const title = (page: Page) => page.locator('.street-title');
const sub = (page: Page) => page.locator('.street-sub');
const rows = (page: Page) => page.locator('.street-row-btn');
const chip = (page: Page, name: RegExp) => page.getByRole('button', { name });

async function landing(page: Page, o: Parameters<typeof setup>[1] = {}) {
  const calls = await setup(page, o);
  await page.goto('/street');
  await waitForMap(page);
  await expect(page.locator('.map-cluster').first()).toBeVisible();
  return calls;
}
async function point(page: Page, o: Parameters<typeof setup>[1] = {}, url = POINT) {
  const calls = await setup(page, o);
  await page.goto(url);
  await waitForMap(page);
  await expect(rows(page).first()).toBeVisible();
  return calls;
}
/** Click a drawn case pin by its coordinates (pins are aria-hidden; the list is the accessible surface). */
async function clickPin(page: Page, lat: number, lng: number) {
  const p = await mapEval<{ x: number; y: number }>(page, `m => { const q = m.latLngToContainerPoint([${lat}, ${lng}]); return { x: q.x, y: q.y }; }`);
  const box = (await page.locator('.mapview').boundingBox())!;
  await page.mouse.click(box.x + p.x, box.y + p.y - 14);
}

test('landing: one feed request, clusters, peek sheet with the city summary, tab bar untouched', async ({ page }) => {
  const calls = await landing(page);
  await expect.poll(() => mapCalls(calls).map((c) => c.url)).toEqual([`${API}/api/street/map?days=30`]);
  expect(calls.filter((c) => /\/api\/street(\?|\/city)/.test(c.url))).toEqual([]);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await expect(title(page)).toHaveText('Providence');
  await expect(sub(page)).toHaveText('1,234 requests · 740 open · 494 closed · last 30 days');
  await expect(page.locator('.street-extra')).toContainText("126 aren't on the map yet");
  await expect(page.locator('main h1')).toHaveText('My street');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const report = page.locator('.tabbar a[href="/"]');
  await expect(report).toBeVisible();
  await report.click();
  await expect(page).toHaveURL(/\/$/);
});

test('landing half: the grabber cycles detents; Most reported, the neighborhood select with counts, and Latest', async ({ page }) => {
  await landing(page);
  const g = grab(page);
  await expect(g).toHaveAttribute('aria-label', 'Show list');
  await expect(g).toHaveAttribute('aria-expanded', 'false');
  await g.click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(g).toHaveAttribute('aria-expanded', 'true');
  await expect(g).toHaveAttribute('aria-label', 'Show more of the list');
  const top = page.locator('.street-top-item');
  await expect(top).toHaveCount(3);
  await expect(top.first()).toContainText('Pothole');
  await expect(top.first().locator('b')).toHaveText(/^\d+$/);
  // The chips flow as a wrapping row (the sheet header's wrapper used to share the .street-top class: column + gap leaked both ways).
  expect(await page.locator('ul.street-top').evaluate((el) => getComputedStyle(el).flexDirection)).toBe('row');
  expect(await page.locator('.street-sheet-top').evaluate((el) => [getComputedStyle(el).flexDirection, getComputedStyle(el).rowGap])).toEqual(['column', 'normal']);
  const opts = await page.getByLabel('Jump to a neighborhood…').locator('option').allTextContents();
  expect(opts[0]).toBe('Jump to a neighborhood…');
  expect(opts.length).toBe(26);
  const counts = opts.slice(1).map((o) => Number(/\((\d+)\)$/.exec(o)![1]));
  expect(counts).toEqual([...counts].sort((a, b) => b - a));
  expect(opts.slice(1).some((o) => /^Elmhurst \(\d+\)$/.test(o))).toBe(true);
  const noStreet = page.locator('.street-row-btn', { hasText: 'Street not given' });
  expect(await noStreet.count()).toBeGreaterThan(0);
  await expect(noStreet.first()).not.toContainText('m away');
  await g.click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
  await expect(g).toHaveAttribute('aria-label', 'Hide list');
  await g.click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
});

test('point: the digest link opens the map at the address — home pin, ring, z16, half sheet, rows by distance', async ({ page }) => {
  await point(page);
  await expect(page.locator('.map-home')).toHaveCount(1);
  await expect(page.locator('.map-ring')).toHaveCount(1);
  await expect.poll(() => zoomOf(page)).toBe(16);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(title(page)).toHaveText('481 Angell St');
  await expect(sub(page)).toHaveText('3 in view · 2 open · 1 closed');
  await expect(rows(page)).toHaveCount(3);
  const texts = await rows(page).allTextContents();
  const dist = texts.map((s) => Number(/(\d+) m away/.exec(s)![1]));
  expect(dist).toEqual([3, 40, 56]);
  await expect(rows(page).nth(0).locator('.my-status')).toHaveText('In progress');
  await expect(rows(page).nth(1).locator('.my-status')).toHaveText('Assigned');
  await expect(rows(page).nth(1)).toContainText('Reported 3 days ago');
  await expect(rows(page).nth(2).locator('.my-status')).toHaveText('Closed');
  await expect(rows(page).nth(2)).toContainText('Closed yesterday');
  await expect(rows(page).nth(2).locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(rows(page).nth(2)).toContainText('College Hill');
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(POINT);
});

test('auto-widen: nothing at z16 → one step to z15 with the note; still nothing → quiet street, Report, Meanwhile', async ({ page }) => {
  await setup(page, { items: filler() });
  await page.goto(POINT);
  await waitForMap(page);
  await expect.poll(() => zoomOf(page)).toBe(15);
  await expect(page.locator('.street-widened')).toHaveText("Nothing within a few blocks, so here's the neighborhood.");
  const none = page.locator('.street-none');
  await expect(none).toContainText('Nothing reported within this distance in the last 30 days');
  await expect(none.locator('a.btn')).toHaveAttribute('href', '/');
  await expect(none.locator('.street-meanwhile .street-h')).toHaveText('Meanwhile, across the city');
  await expect(none.locator('.street-top-item')).toHaveCount(3);
  await expect(none.getByRole('button', { name: 'See the whole city' })).toBeVisible();
  await expect(page.locator('.street-digest')).toBeVisible();
  // A shared view (z in the URL) is never widened.
  await page.goto(`${POINT}&c=41.8282,-71.4005&z=16`);
  await waitForMap(page);
  await expect(page.locator('.street-none')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await zoomOf(page)).toBe(16);
  await expect(page.locator('.street-widened')).toHaveCount(0);
});

test('filters: status toggles, group chip, Clear, and the window select (7 cuts locally, 90 refetches once)', async ({ page }) => {
  const calls = await point(page);
  await expect(page.locator('.map-case')).toHaveCount(3);
  await chip(page, /^Closed, 1$/).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.map-pin--closed')).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]s=open/);
  await expect(chip(page, /^Closed, /)).toHaveAttribute('aria-pressed', 'false');
  // Open off while Closed is off → no-op (status alone can never empty the map)
  await chip(page, /^Open, /).click();
  await expect(chip(page, /^Open, /)).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/[?&]s=open/);
  await chip(page, /^Clear filters$/).click();
  await expect(page).not.toHaveURL(/[?&]s=/);
  await expect(rows(page)).toHaveCount(3);
  await chip(page, /^Streets, 1$/).click();
  await expect(chip(page, /^Streets, /)).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/[?&]g=streets/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pothole');
  await expect(page.locator('.map-case')).toHaveCount(1);
  await expect(chip(page, /^All, 3$/)).toBeVisible();
  const before = mapCalls(calls).length;
  await page.getByLabel('Time window').selectOption('7');
  await expect(page).toHaveURL(/[?&]d=7/);
  await page.waitForTimeout(300);
  expect(mapCalls(calls).length).toBe(before);
  await page.getByLabel('Time window').selectOption('90');
  await expect(page).toHaveURL(/[?&]d=90/);
  await expect.poll(() => mapCalls(calls).filter((c) => c.url.endsWith('days=90')).length).toBe(1);
  expect(mapCalls(calls).length).toBe(before + 1);
});

test('faceted counts: a chip reads what tapping it would show; a zero chip stays enabled and leads to the counted empty state', async ({ page }) => {
  await point(page, {}, `${POINT}&s=open`);
  await expect(chip(page, /^Closed, 1$/)).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, /^Open, 2$/)).toHaveAttribute('aria-pressed', 'true');
  const trees = chip(page, /^Trees, 0$/);
  await expect(trees).toBeVisible();
  await expect(trees).not.toHaveAttribute('aria-disabled', 'true');
  await trees.click();
  await expect(sub(page)).toHaveText('0 in view · 0 open · 0 closed');
  await expect(page.locator('.street-none')).toContainText('Nothing here in the last 30 days with these filters.');
  const fix = page.getByRole('button', { name: 'Show all types (2)' });
  await expect(fix).toBeVisible();
  await expect(page.getByRole('button', { name: /^Include closed/ })).toHaveCount(0); // closed trees in view: 0 → hidden
  await fix.click();
  await expect(page).not.toHaveURL(/[?&]g=/);
  await expect(rows(page)).toHaveCount(2);
});

test('selection via row: the card takes focus, writes case=, marks the pin; Back and Escape return focus to the row', async ({ page }) => {
  await point(page);
  const row = page.locator('.street-row-btn[data-id="c2"]');
  await row.click();
  const card = page.locator('.street-detail');
  await expect(card).toBeFocused();
  await expect(card).toContainText('Street Light Out');
  await expect(card).toContainText('22 Thayer St');
  await expect(card.locator('.my-status')).toHaveText('Closed');
  await expect(card.locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(page.locator('.map-pin--selected')).toHaveCount(1);
  await expect(title(page)).toHaveText('Street Light Out');
  await card.getByRole('button', { name: 'Back to list' }).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-row-btn[data-id="c2"]')).toBeFocused();
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(page.locator('.street-detail')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-row-btn[data-id="c1"]')).toBeFocused();
});

test('selection via pin and deep link: a pin tap raises peek → half; ?case= opens on load; an unknown case says so', async ({ page }) => {
  await point(page);
  await grab(page).press('ArrowDown');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await setView(page, NEAR[0].lat!, NEAR[0].lng!, 17);
  await page.waitForTimeout(400);
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  await expect(page.locator('.street-detail')).toContainText('Pothole');
  await expect(page).toHaveURL(/[?&]case=c1/);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(page.locator('.map-pin--selected')).toHaveCount(1);
  // Focus lands on the card, never on the aria-hidden marker (the sheet body was inert at PEEK when the tap landed).
  await expect(page.locator('.street-detail')).toBeFocused();
  // The pin was panned clear of the sheet that rose under it.
  const pin = (await page.locator('.map-pin--selected').boundingBox())!, sh = (await sheet(page).boundingBox())!;
  expect(pin.y + pin.height).toBeLessThanOrEqual(sh.y + 1);

  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  await expect(page.locator('.street-detail')).toContainText('Pothole');
  await expect(page.locator('.street-detail')).toBeFocused();
  await expect(page.locator('.map-pin--selected')).toHaveCount(1);
  await expect(title(page)).toHaveText('Pothole');

  await page.goto(`${POINT}&case=unknown`);
  await waitForMap(page);
  await expect(page.locator('.street-gone')).toContainText("That request isn't in the last 30 days anymore.");
  await expect(page.locator('.street-gone').getByRole('button', { name: 'Look back 90 days' })).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(rows(page)).toHaveCount(3);
});

test('clusters and stacks: six cases at one spot are one disc at every zoom; at z18 the disc lists them', async ({ page }) => {
  await landing(page);
  const six = page.locator('.map-cluster', { hasText: /^6$/ });
  await expect(six).toHaveCount(1);
  const z0 = await zoomOf(page);
  await six.click();
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(z0);
  await setView(page, STACK.lat, STACK.lng, 18);
  await page.waitForTimeout(400);
  await expect(page.locator('.map-cluster', { hasText: /^6$/ })).toHaveCount(1);
  await expect(page.locator('.map-case')).toHaveCount(0);
  await page.locator('.map-cluster', { hasText: /^6$/ }).click();
  await expect(page.locator('.street-body .street-h').first()).toHaveText('6 requests at this spot');
  await expect(title(page)).toHaveText('6 requests at this spot');
  await expect(rows(page)).toHaveCount(6);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await page.getByRole('button', { name: 'Show everything in view' }).click();
  await expect(page.locator('.street-body .street-h').first()).toHaveText('In view');
  await expect(rows(page)).toHaveCount(6);
});

test('the in-view list follows the map: an empty corner → zeros, plain empty copy, Zoom out and See the whole city', async ({ page }) => {
  await landing(page);
  await page.evaluate(() => {
    const w = window as unknown as { __subChanges: number };
    w.__subChanges = 0;
    new MutationObserver(() => { w.__subChanges++; }).observe(document.querySelector('.street-sub')!, { childList: true, characterData: true, subtree: true });
  });
  await setView(page, 41.775, -71.47, 16);
  await expect(sub(page)).toHaveText('0 in view · 0 open · 0 closed');
  await expect(page.locator('.street-none')).toContainText('Nothing reported here in the last 30 days.');
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => (window as unknown as { __subChanges: number }).__subChanges)).toBe(1);
  await grab(page).click(); // the empty state lives in the sheet body
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(() => zoomOf(page)).toBe(14);
  await page.locator('.street-none').getByRole('button', { name: 'See the whole city' }).click();
  await expect.poll(() => zoomOf(page)).toBeLessThanOrEqual(13);
  await expect(title(page)).toHaveText('Providence');
  await expect(page).not.toHaveURL(/[?&][cz]=/);
});

test('neighborhoods: the select writes n=, draws the outline and fits; a pan clears it; the title follows the map centre', async ({ page }) => {
  await landing(page);
  await grab(page).click();
  await page.getByLabel('Jump to a neighborhood…').selectOption('Fox Point');
  await expect(page).toHaveURL(/[?&]n=fox-point/);
  await expect(page.locator('.map-hood')).toHaveCount(1);
  await expect(title(page)).toHaveText('Fox Point');
  await expect.poll(() => zoomOf(page)).toBeGreaterThanOrEqual(13);
  await page.goto('/street?n=elmhurst');
  await waitForMap(page);
  await expect(title(page)).toHaveText('Elmhurst');
  await expect(page.locator('.map-hood')).toHaveCount(1);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await userPan(page, 240, 0);
  await expect(page).not.toHaveURL(/[?&]n=/);
  await expect(page.locator('.map-hood')).toHaveCount(0);
  await setView(page, 41.8268, -71.4025, 15);
  await expect(title(page)).toHaveText('College Hill');
});

test('search, clear, locate: ArcGIS → point URL + pin + ring; × returns to the city; outside / denied messages', async ({ page, context }) => {
  await landing(page);
  await page.locator('.street-pill-input').fill('481 angell');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050&q=481\+Angell\+St/);
  await expect(page.locator('.map-home')).toHaveCount(1);
  await expect(page.locator('.map-ring')).toHaveCount(1);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect.poll(() => zoomOf(page)).toBe(16);
  await page.getByRole('button', { name: 'Clear address' }).click();
  await expect(page).toHaveURL(/\/street$/);
  await expect(page.locator('.map-home')).toHaveCount(0);
  await expect.poll(() => zoomOf(page)).toBeLessThanOrEqual(13);
  // Outside Providence
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 42.36, longitude: -71.06 });
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.locator('.street-msg')).toContainText("outside Providence");
  // Denied (Chromium keeps answering after clearPermissions, so stub the API like a denied prompt)
  await page.evaluate(() => { navigator.geolocation.getCurrentPosition = (_ok, err) => { err?.({ code: 1, message: 'denied' } as GeolocationPositionError); }; });
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.locator('.street-msg')).toContainText('Location is off for this site');
});

test('saved places: signed in, the "Your places" chip in the peek sheet jumps the map and sets q', async ({ page }) => {
  await landing(page, { signedIn: true, me: { addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: PT.lat, lng: PT.lng }] } });
  const places = page.locator('.street-places');
  await expect(places).toContainText('Your places');
  await places.getByRole('button', { name: 'Home' }).click();
  await expect(page).toHaveURL(/lat=41\.82820&lng=-71\.40050&q=481\+Angell\+St%2C\+Providence/);
  await expect.poll(() => zoomOf(page)).toBe(16);
  await expect(title(page)).toHaveText('481 Angell St, Providence');
});

test('digest, signed out: the sign-in link returns to this exact URL (point view and case view)', async ({ page }) => {
  await point(page);
  const link = page.locator('.street-digest a.btn');
  await expect(link).toHaveText('Sign in to get the weekly email');
  expect(decodeURIComponent((await link.getAttribute('href'))!)).toBe(`/account?returnTo=${POINT}`);
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  const link2 = page.locator('.street-detail .street-digest a.btn');
  expect(decodeURIComponent((await link2.getAttribute('href'))!)).toBe(`/account?returnTo=${POINT}&case=c1`);
});

test('digest, signed in: one tap saves the address and turns it on; Turn off; already on; and from a case card', async ({ page }) => {
  const calls = await point(page, { signedIn: true });
  await page.getByRole('button', { name: 'Email me about this street' }).click();
  await expect(page.locator('.street-digest-on .notice-ok')).toContainText('On — Mondays, for 481 Angell St');
  expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ label: '481 Angell St', address: '481 Angell St', lat: 41.8282, lng: -71.4005 });
  expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ prefs: { streetDigest: true } });
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Email me about this street' })).toBeVisible();
  expect(calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ prefs: { streetDigest: false } });
});

test('digest from a case card: one tap saves that case\'s street and coordinates', async ({ page }) => {
  const calls = await point(page, { signedIn: true });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await page.locator('.street-detail').getByRole('button', { name: 'Email me about this street' }).click();
  await expect(page.locator('.street-detail .street-digest-on .notice-ok')).toContainText('for 10 Angell St');
  expect(calls.filter((c) => c.method === 'PUT').pop()!.body).toEqual({ label: '10 Angell St', address: '10 Angell St', lat: NEAR[0].lat, lng: NEAR[0].lng });
});

test('digest, signed in with this address saved and on: shows the on state without asking again', async ({ page }) => {
  await point(page, { signedIn: true, me: { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: PT.lat, lng: PT.lng }] } });
  await expect(page.locator('.street-digest-on .notice-ok')).toContainText('for Home');
});

test('error states: a failed feed shows the notice + retry inside the sheet with the map still up; a failed 90-day switch keeps the 30-day rows', async ({ page }) => {
  let fail = true;
  const calls = await setup(page, { status: () => (fail ? 500 : 200) });
  await page.goto(POINT);
  await waitForMap(page);
  const err = page.locator('.street-sheet .notice-error');
  await expect(err).toContainText("Couldn't load the city's list right now.");
  await expect(page.locator('.mapview')).toBeVisible();
  await expect(page.locator('.map-home')).toHaveCount(1);
  await expect(chip(page, /^Open$/)).toHaveAttribute('aria-disabled', 'true');
  fail = false;
  await err.getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(3);
  expect(mapCalls(calls).length).toBe(2);

  await page.goto(POINT);
  await waitForMap(page);
  await expect(rows(page)).toHaveCount(3);
  fail = true;
  await page.getByLabel('Time window').selectOption('90');
  await expect(page.locator('.street-extra')).toContainText('Showing the list from');
  await expect(rows(page)).toHaveCount(3);
});

test('share: with navigator.share absent the URL lands on the clipboard and the live region says so', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s: string) => { (window as unknown as { __copied: string }).__copied = s; return Promise.resolve(); } }, configurable: true });
  });
  await point(page);
  await page.locator('.street-head-actions').getByRole('button', { name: 'Share' }).click();
  await expect(sub(page)).toHaveText('Link copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toContain('/street?lat=41.82820&lng=-71.40050&q=481+Angell+St');
  await expect(sub(page)).toHaveText('3 in view · 2 open · 1 closed', { timeout: 5000 });
});

test('history: Back to list from a deep-linked case never leaves the app, even after a pan or a chip tap; card → card is one entry', async ({ page }) => {
  // An external link (digest mail, share) with case=: the entry is not ours. Pan, tap a chip, then Back to list.
  await setup(page);
  await page.goto(`${POINT}&case=c2`);
  await waitForMap(page);
  await expect(page.locator('.street-detail')).toContainText('Street Light Out');
  await userPan(page, 120, 0);
  await page.waitForTimeout(500);
  await chip(page, /^Closed, /).click();
  await expect(page).toHaveURL(/[?&]s=open/);
  await page.locator('.street-detail').getByRole('button', { name: 'Back to list' }).click();
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050&q=481/);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(rows(page).first()).toBeVisible();
  // The param was removed in place (no history entry to go forward to), not popped off into whatever came before the link.
  await page.goForward();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(rows(page).first()).toBeVisible();

  // Deep link with case=c1, then a neighbouring pin (c2): Back to list shows the list, not c1's card again.
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  await expect(page.locator('.street-detail')).toContainText('Pothole');
  await setView(page, NEAR[1].lat!, NEAR[1].lng!, 17);
  await page.waitForTimeout(400);
  await clickPin(page, NEAR[1].lat!, NEAR[1].lng!);
  await expect(page.locator('.street-detail')).toContainText('Street Light Out');
  await expect(page).toHaveURL(/[?&]case=c2/);
  await page.locator('.street-detail').getByRole('button', { name: 'Back to list' }).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-detail')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  // Escape on a card opened from the list pops the entry we pushed: the card is still there going forward.
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(page.locator('.street-detail')).toBeFocused();
  await page.locator('.street-row-btn[data-id="c3"]').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(rows(page)).toHaveCount(3);
  await page.goForward();
  await expect(page).toHaveURL(/[?&]case=c3/);
  await expect(page.locator('.street-detail')).toContainText('Overflowing Dumpster');
});

test('a shared c/z view with case= keeps the sender\'s framing; a point with case= stays at z16', async ({ page }) => {
  await setup(page);
  await page.goto('/street?c=41.8450,-71.4450&z=14&case=c2');
  await waitForMap(page);
  await expect(page.locator('.street-detail')).toContainText('Street Light Out');
  await page.waitForTimeout(700);
  expect(await zoomOf(page)).toBe(14);
  const c = await mapEval<{ lat: number; lng: number }>(page, 'm => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; }');
  expect(Math.abs(c.lat - 41.845)).toBeLessThan(0.002);
  expect(Math.abs(c.lng + 71.445)).toBeLessThan(0.002);
  await expect(page).toHaveURL(/[?&]c=41\.8450,-71\.4450&z=14/);
  await page.goto(`${POINT}&case=c2`);
  await waitForMap(page);
  await expect(page.locator('.street-detail')).toContainText('Street Light Out');
  await page.waitForTimeout(700);
  expect(await zoomOf(page)).toBe(16);
  await expect(page.locator('.map-pin--selected')).toHaveCount(1);
});

test('the OSM attribution stays visible and clickable at every detent, and never swallows a pin tap', async ({ page }) => {
  await landing(page);
  const attr = page.locator('.leaflet-control-attribution');
  const hit = async () => {
    const b = (await attr.boundingBox())!;
    return page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? `${el.tagName}.${el.className}` : ''; }, [b.x + b.width / 2, b.y + b.height / 2] as [number, number]);
  };
  for (const d of ['half', 'full'] as const) {
    await grab(page).click();
    await expect(sheet(page)).toHaveAttribute('data-detent', d);
    await page.waitForTimeout(300);
    const a = (await attr.boundingBox())!, sh = (await sheet(page).boundingBox())!, rail = (await page.locator('.street-rail').boundingBox())!;
    expect(a.y + a.height).toBeLessThanOrEqual(sh.y);
    expect(a.y).toBeGreaterThanOrEqual(rail.y + rail.height);
    await expect(attr.getByRole('link', { name: 'OpenStreetMap' })).toBeVisible();
    expect(await hit()).toMatch(/leaflet-control-attribution|^A\./);
  }
  // The control's box is pointer-transparent (only its links take taps): a pin drawn through it still opens.
  expect(await attr.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  expect(await attr.locator('a').first().evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  test('panel beside the map, no sheet, zoom control, row hover highlights its pin', async ({ page }) => {
    await landing(page);
    await expect(page.locator('.street-panel')).toBeVisible();
    await expect(page.locator('.mapview')).toBeVisible();
    await expect(page.locator('.street-grab')).toHaveCount(0);
    await expect(page.locator('.tabbar')).toBeHidden();
    await expect(page.locator('.header-street')).toBeVisible();
    await expect(page.locator('.leaflet-control-zoom')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const map = (await page.locator('.mapview').boundingBox())!, panel = (await page.locator('.street-panel').boundingBox())!;
    expect(map.x + map.width).toBeLessThanOrEqual(panel.x + 1);
    await expect(page.locator('.street-panel .street-rail')).toBeVisible();
    await page.goto(POINT);
    await waitForMap(page);
    await expect(rows(page)).toHaveCount(3);
    await rows(page).first().hover();
    await expect(page.locator('.map-pin--hover')).toHaveCount(1);
    await page.screenshot({ path: 'tests/__screenshots__/street-desktop.png' });
  });
});

test('fixture sanity: the default feed has the stack, the unplaced case and the near cases', () => {
  expect(DEFAULT_ITEMS.filter((c) => c.lat === STACK.lat && c.lng === STACK.lng)).toHaveLength(6);
  expect(DEFAULT_ITEMS.filter((c) => c.lat == null)).toHaveLength(126);
  expect(DEFAULT_ITEMS).toHaveLength(1234);
});
