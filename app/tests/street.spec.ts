import { existsSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { API, DEFAULT_ITEMS, NEAR, POINT, PT, SESSION, STACK, filler, mapEval, setView, setup, userPan, waitForMap, zoomOf, type Case } from './street-mocks';
import { ENDPOINT, IPHONE, pushApi, stubPush } from './push-mocks';

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

  // A case the city's record no longer has: asked for by itself (404) → the gone line, no card, case= dropped.
  const calls = await setup(page);
  await page.goto(`${POINT}&case=unknown`);
  await waitForMap(page);
  await expect(page.locator('.street-gone')).toContainText("We couldn't find that request");
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(rows(page)).toHaveCount(3);
  expect(calls.filter((c) => c.url.includes('/api/street/case/')).map((c) => c.url.split('/').pop())).toEqual(['unknown']);
});

test('deep link to a case older than the window (the follow mail, a /my row): fetched by itself, card + pin, the window untouched', async ({ page }) => {
  const old: Case = { id: 'old1', t: 6, status: 'Assigned', createdDaysAgo: 140, lat: 41.83, lng: -71.41, street: '5 Elm St' };
  const unplaced: Case = { id: 'old2', t: 0, status: 'Resolved', createdDaysAgo: 200, closedDaysAgo: 120, lat: null, lng: null, street: '', res: 'Filled.' };
  const calls = await setup(page, { extraCases: [old, unplaced] });
  const lookups = () => calls.filter((c) => c.url.includes('/api/street/case/')).map((c) => c.url.split('/').pop());
  // The mail's link: case= with the case's own lat/lng.
  await page.goto('/street?case=old1&lat=41.83000&lng=-71.41000');
  await waitForMap(page);
  const card = page.locator('.street-detail');
  await expect(card).toContainText('Tree Down');
  await expect(card).toContainText('5 Elm St');
  await expect(card).toBeFocused();
  await expect(page).toHaveURL(/[?&]case=old1/);
  await expect(page.locator('.map-pin--selected')).toHaveCount(1);
  await expect(title(page)).toHaveText('Tree Down');
  expect(lookups()).toEqual(['old1']);
  expect(mapCalls(calls)).toHaveLength(1); // 30 days only — no 90-day refetch, no gone notice
  await expect(page.locator('.street-gone')).toHaveCount(0);
  // Follow works on it like any card (signed out here: the sign-in link returns to this URL).
  expect(decodeURIComponent((await card.locator('a.street-follow-signin').getAttribute('href'))!)).toBe('/account?returnTo=/street?case=old1&lat=41.83000&lng=-71.41000');
  // Back to list drops the case and its pin; the window's rows are what is listed.
  await card.getByRole('button', { name: 'Back to list' }).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);

  // Bare case= on an unplaced closed case: the card (with the city's note) over the whole city, no pin.
  await page.goto('/street?case=old2');
  await waitForMap(page);
  await expect(card).toContainText('Pothole');
  await expect(card.locator('.street-note')).toHaveText('Filled.');
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]case=old2/);
  expect(lookups()).toEqual(['old1', 'old2']);
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

/** A second saved place for the places card, clear of every fixture cluster (Downtown's is 1.6 km, the stack 2.9 km). */
const WORK = { lat: 41.835, lng: -71.41 };
/** Around WORK: one new (2 d, open), one closed yesterday, one open but 10 d old, one closed 9 d ago, one new but 350 m off → "1 new · 1 closed". */
const WORK_CASES: Case[] = [
  { id: 'w1', t: 0, status: 'Submitted', createdDaysAgo: 2, lat: 41.8352, lng: -71.4101, street: '5 Hope St' },
  { id: 'w2', t: 1, status: 'Resolved', createdDaysAgo: 10, closedDaysAgo: 1, lat: 41.8348, lng: -71.4099, street: '7 Hope St', res: 'Fixed.' },
  { id: 'w3', t: 3, status: 'Assigned', createdDaysAgo: 10, lat: 41.8351, lng: -71.4102, street: '9 Hope St' },
  { id: 'w4', t: 4, status: 'Closed', createdDaysAgo: 20, closedDaysAgo: 9, lat: 41.8349, lng: -71.41, street: '11 Hope St' },
  { id: 'w5', t: 0, status: 'Submitted', createdDaysAgo: 1, lat: 41.8382, lng: -71.41, street: '99 Hope St' },
];
const PLACES = [
  { id: 'a1', label: 'Home', address: '481 Angell St, Providence', lat: PT.lat, lng: PT.lng },
  { id: 'a2', label: 'Work', address: '5 Hope St, Providence', lat: WORK.lat, lng: WORK.lng },
  { id: 'a3', label: 'Gym', address: '1 Quiet Ln, Providence', lat: 41.8, lng: -71.43 },
  { id: 'a4', label: 'Mom', address: 'Somewhere, Providence', lat: null, lng: null },
];

test('your places this week: signed in, a card above the week link with a row per saved address that has coordinates — 7-day counts within 300 m from the loaded feed, "nothing new" for a quiet place, no extra request; a row tap opens the address view', async ({ page }) => {
  const calls = await landing(page, { items: [...DEFAULT_ITEMS, ...WORK_CASES], signedIn: true, me: { addresses: PLACES } });
  await grab(page).click();
  const card = page.locator('.street-places-card');
  await expect(card.getByRole('heading', { name: 'Your places this week' })).toBeVisible();
  const places = card.locator('.street-place');
  await expect(places).toHaveCount(3); // Mom has no coordinates
  await expect(places.locator('.street-place-label')).toHaveText(['Home', 'Work', 'Gym']);
  // Home: the three cases around 481 Angell St — c3 today and c1 three days ago are new, c2 closed yesterday.
  await expect(places.nth(0).locator('.street-place-n')).toHaveText('2 new · 1 closed');
  await expect(places.nth(1).locator('.street-place-n')).toHaveText('1 new · 1 closed');
  await expect(places.nth(2).locator('.street-place-n')).toHaveText('nothing new');
  await expect(places.nth(2).locator('.street-place-n')).toHaveClass(/street-place-n--quiet/);
  await expect(places.nth(1)).toHaveAttribute('title', '5 Hope St, Providence');
  for (const b of await places.all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Above the week link, which keeps its place above Most reported.
  expect(await page.evaluate(() => {
    const c = document.querySelector('.street-places-card')!; const a = document.querySelector('a.street-week-link')!;
    return c.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
  })).toBe('above');
  // The header's "Your places" chips stay (all four; the thumb-zone shortcut).
  await expect(page.locator('.street-places .chip')).toHaveCount(4);
  // Everything came from the one feed load and the account: no per-place request.
  expect(calls.filter((c) => /\/api\/street(\?|\/city)|\/api\/week/.test(c.url))).toEqual([]);
  expect(mapCalls(calls)).toHaveLength(1);
  // A row does what its chip does: the address view at z16, titled by the address; the card is a landing thing.
  await places.nth(1).click();
  await expect(page).toHaveURL(/lat=41\.83500&lng=-71\.41000&q=5\+Hope\+St%2C\+Providence/);
  await expect.poll(() => zoomOf(page)).toBe(16);
  await expect(title(page)).toHaveText('5 Hope St, Providence');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(page.locator('.street-places-card')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(4); // w1–w4; w5 is outside the z16 band's few blocks
});

test('your places this week: no card when signed out', async ({ page }) => {
  await landing(page);
  await grab(page).click();
  await expect(page.locator('a.street-week-link')).toBeVisible();
  await expect(page.locator('.street-places-card')).toHaveCount(0);
});

test('your places this week: no card when no saved address has coordinates (the chip still offers the geocode), Spanish singulars', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await landing(page, { signedIn: true, me: { addresses: [PLACES[3]] } });
  await grab(page).click();
  await expect(page.locator('a.street-week-link')).toBeVisible();
  await expect(page.locator('.street-places-card')).toHaveCount(0);
  await expect(page.locator('.street-places .chip')).toHaveCount(1);
  // With coordinates: the Spanish card, "1 nueva · 1 cerrada" for Work, "nada nuevo" for the quiet place.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await landing(page, { items: [...DEFAULT_ITEMS, ...WORK_CASES], signedIn: true, me: { addresses: [PLACES[1], PLACES[2]] } });
  await grab(page).click();
  const card = page.locator('.street-places-card');
  await expect(card.getByRole('heading', { name: 'Tus lugares esta semana' })).toBeVisible();
  await expect(card.locator('.street-place-n')).toHaveText(['1 nueva · 1 cerrada', 'nada nuevo']);
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

// ── Street watch (StreetWatchRow): the push-only "tell me right away" checkbox under the phone row in the digest on-state ──
/** Digest on for Home = 481 Angell St (the point itself), so the on-state — phone row + watch row — renders at once. */
const WATCH_ME = { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: PT.lat, lng: PT.lng }] };
const WATCH_NAME = 'Tell me right away when something new is reported near my places';
const watchRow = (page: Page) => page.locator('.street-digest .watch-row');
const watchBox = (page: Page) => watchRow(page).getByRole('checkbox', { name: WATCH_NAME });

test('street watch: disabled with the "turn on notifications first" hint while push is off; Turn on arms it; check → PATCH streetWatch true + the on-copy; uncheck → false; push off disarms it', async ({ page }) => {
  const calls = await setup(page, { signedIn: true, me: WATCH_ME });
  await pushApi(page);
  await stubPush(page); // Android, no subscription yet: the phone row reads "off"
  await page.goto(POINT);
  await waitForMap(page);
  const push = page.locator('.street-digest .push-card');
  await expect(push).toHaveAttribute('data-state', 'off');
  const row = watchRow(page), box = watchBox(page);
  await expect(row).toHaveAttribute('data-state', 'needs-push');
  await expect(box).toBeDisabled();
  await expect(box).not.toBeChecked();
  await expect(row.locator('.watch-hint')).toHaveText('Turn on phone notifications first.');
  // The row sits right under the phone row, inside the on-state.
  const order = await page.locator('.street-digest-on').evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]));
  expect(order).toEqual(['notice', 'btn', 'push-card', 'watch-row', 'watch-groups']);
  // Push comes on → the checkbox arms itself with the body copy; the label is the 44 px target.
  await push.getByRole('button', { name: 'Turn on' }).click();
  await expect(push).toHaveAttribute('data-state', 'on');
  await expect(row).toHaveAttribute('data-state', 'off');
  await expect(box).toBeEnabled();
  await expect(row.locator('.watch-hint')).toHaveText('A notification on this phone when the city logs a new request within a few blocks of a saved address — usually within half an hour. No email.');
  expect((await row.locator('.watch-toggle').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]); // turning push on is not a pref
  await box.check();
  await expect(box).toBeChecked();
  await expect(row).toHaveAttribute('data-state', 'on');
  await expect(row.locator('.watch-hint')).toHaveText('On — new requests near your places reach this phone right away.');
  expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ prefs: { streetWatch: true } }]);
  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect(row).toHaveAttribute('data-state', 'off');
  expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ prefs: { streetWatch: true } }, { prefs: { streetWatch: false } }]);
  // Push off again → disarmed (unchecked, so there is nothing left to turn off here).
  await push.getByRole('button', { name: 'Turn off on this phone' }).click();
  await expect(push).toHaveAttribute('data-state', 'off');
  await expect(row).toHaveAttribute('data-state', 'needs-push');
  await expect(box).toBeDisabled();
  expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
});

test('street watch, already on for the account: checked at once when this phone is subscribed; checked but still enabled under the iPhone install hint (so it can be turned off here); no row in a browser that cannot push unless it is on', async ({ page }) => {
  const ON = { ...WATCH_ME, prefs: { ...WATCH_ME.prefs, streetWatch: true }, push: { endpoints: [ENDPOINT] } };
  await setup(page, { signedIn: true, me: ON });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto(POINT);
  await waitForMap(page);
  await expect(page.locator('.street-digest .push-card')).toHaveAttribute('data-state', 'on');
  await expect(watchBox(page)).toBeChecked();
  await expect(watchBox(page)).toBeEnabled();
  await expect(watchRow(page)).toHaveAttribute('data-state', 'on');

  // The suite's own iPhone UA in a Safari tab: the install hint above, the checkbox checked and enabled below.
  await setup(page, { signedIn: true, me: ON });
  await stubPush(page, { ua: IPHONE, pushManager: false });
  await page.goto(POINT);
  await waitForMap(page);
  await expect(page.locator('.street-digest .push-card')).toHaveAttribute('data-state', 'ios-needs-install');
  await expect(watchBox(page)).toBeChecked();
  await expect(watchBox(page)).toBeEnabled();
  await expect(watchRow(page)).toHaveAttribute('data-state', 'needs-push');
  await expect(watchRow(page).locator('.watch-hint')).toHaveText('Turn on phone notifications first.');

  // A browser with no push at all and the watch off: the phone row renders nothing, so neither does the watch row.
  await setup(page, { signedIn: true, me: WATCH_ME });
  await stubPush(page, { pushManager: false });
  await page.goto(POINT);
  await waitForMap(page);
  await expect(page.locator('.street-digest-on .notice-ok')).toContainText('for Home');
  await expect(page.locator('.street-digest .push-card')).toHaveCount(0);
  await expect(watchRow(page)).toHaveCount(0);
});

// ── Only tell me about (WatchGroups): the group chips closing the digest on-state, under the watch row ──
const groups = (page: Page) => page.locator('.street-digest .watch-groups');
const gchip = (page: Page, name: string) => groups(page).getByRole('button', { name, exact: true });
const prefPatches = (calls: { method: string; body: unknown }[]) => calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
const GROUP_LABELS = ['All', 'Trash', 'Streets', 'Traffic', 'Trees', 'Property', 'Lights', 'Nuisance', 'Water', 'Animals', 'Other'];

test('watch groups: All pressed with nothing saved, the rail closes the on-state; two taps in one tick → ONE PATCH watchGroups after the debounce, in GROUP_ORDER order; untap → the rest; All clears → []; All again sends nothing', async ({ page }) => {
  const calls = await setup(page, { signedIn: true, me: { ...WATCH_ME, push: { endpoints: [ENDPOINT] } } });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto(POINT);
  await waitForMap(page);
  const g = groups(page);
  await expect(g.locator('.watch-groups-title')).toHaveText('Only tell me about');
  await expect(g.locator('.watch-groups-hint')).toHaveText('Applies to the weekly email and the instant notifications near your places.');
  const order = await page.locator('.street-digest-on').evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]));
  expect(order).toEqual(['notice', 'btn', 'push-card', 'watch-row', 'watch-groups']);
  await expect(g.getByRole('button')).toHaveText(GROUP_LABELS);
  await expect(g.getByRole('group', { name: 'Only tell me about' })).toHaveCount(1);
  await expect(gchip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  for (const name of GROUP_LABELS.slice(1)) await expect(gchip(page, name)).toHaveAttribute('aria-pressed', 'false');
  await expect(g).toHaveAttribute('data-n', '0');
  expect((await gchip(page, 'All').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await gchip(page, 'Trash').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Two taps in one tick, well inside the 400 ms: both pressed at once, All released, one PATCH carrying both (trash first).
  await g.evaluate((el) => { (el.querySelector('[data-group="streets"]') as HTMLElement).click(); (el.querySelector('[data-group="trash"]') as HTMLElement).click(); });
  await expect(gchip(page, 'Streets')).toHaveAttribute('aria-pressed', 'true');
  await expect(gchip(page, 'Trash')).toHaveAttribute('aria-pressed', 'true');
  await expect(gchip(page, 'All')).toHaveAttribute('aria-pressed', 'false');
  await expect(g).toHaveAttribute('data-n', '2');
  await expect.poll(() => prefPatches(calls)).toEqual([{ prefs: { watchGroups: ['trash', 'streets'] } }]);
  await page.waitForTimeout(500);
  expect(prefPatches(calls)).toHaveLength(1); // nothing else trickled out, and the chips kept the Worker's answer
  await expect(gchip(page, 'Streets')).toHaveAttribute('aria-pressed', 'true');
  await expect(gchip(page, 'Trash')).toHaveAttribute('aria-pressed', 'true');
  // Untap Trash → the rest.
  await gchip(page, 'Trash').click();
  await expect(gchip(page, 'Trash')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => prefPatches(calls)).toEqual([{ prefs: { watchGroups: ['trash', 'streets'] } }, { prefs: { watchGroups: ['streets'] } }]);
  // All clears.
  await gchip(page, 'All').click();
  await expect(gchip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  await expect(gchip(page, 'Streets')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => prefPatches(calls)).toHaveLength(3);
  expect(prefPatches(calls)[2]).toEqual({ prefs: { watchGroups: [] } });
  // All when already All: nothing to send.
  await gchip(page, 'All').click();
  await page.waitForTimeout(600);
  expect(prefPatches(calls)).toHaveLength(3);
  await expect(gchip(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('watch groups: a saved selection is pressed on load (All released; a key this app does not know is ignored); on the case card where the pressed Follow toggle owns the phone row the rail still closes the digest on-state, with no watch row above it', async ({ page }) => {
  await setup(page, { signedIn: true, me: { ...WATCH_ME, prefs: { ...WATCH_ME.prefs, watchGroups: ['lights', 'bogus'] }, push: { endpoints: [ENDPOINT] } } });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto(POINT);
  await waitForMap(page);
  await expect(gchip(page, 'Lights')).toHaveAttribute('aria-pressed', 'true');
  await expect(gchip(page, 'All')).toHaveAttribute('aria-pressed', 'false');
  await expect(groups(page)).toHaveAttribute('data-n', '1');

  // Case c1 (10 Angell St, ~40 m from Home, so the digest is on for its street), followed: the Follow toggle carries the
  // phone row; the digest card has neither phone row nor watch row, but the digest is on, so the groups still apply.
  const calls = await setup(page, { signedIn: true, me: { ...WATCH_ME, cityFollowing: ['c1'], prefs: { ...WATCH_ME.prefs, watchGroups: ['lights'] } } });
  await pushApi(page);
  await stubPush(page);
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  const detail = page.locator('.street-detail');
  await expect(detail.locator('.street-follow-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.locator('.street-digest .push-card')).toHaveCount(0);
  await expect(detail.locator('.street-digest .watch-row')).toHaveCount(0);
  expect(await detail.locator('.street-digest-on').evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]))).toEqual(['notice', 'btn', 'watch-groups']);
  const lights = detail.locator('.watch-groups [data-group="lights"]');
  await expect(lights).toHaveAttribute('aria-pressed', 'true');
  await lights.click();
  await expect(lights).toHaveAttribute('aria-pressed', 'false');
  await expect(detail.locator('.watch-groups .watch-chip-all')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => prefPatches(calls)).toEqual([{ prefs: { watchGroups: [] } }]);
});

test('follow, signed out: the card offers a sign-in link that returns to this exact URL; no toggle', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  const card = page.locator('.street-detail');
  const link = card.locator('a.street-follow-signin');
  await expect(link).toHaveText('Sign in to follow this request');
  expect(decodeURIComponent((await link.getAttribute('href'))!)).toBe(`/account?returnTo=${POINT}&case=c1`);
  await expect(card.locator('.street-follow-btn')).toHaveCount(0);
  expect(calls.filter((c) => c.url.includes('/api/me'))).toEqual([]);
});

test('follow, signed out from a typed search: the returnTo keeps the `+` URL and sign-in lands on the case card', async ({ page }) => {
  await landing(page);
  await page.locator('.street-pill-input').fill('481 angell');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050&q=481\+Angell\+St/);
  await page.locator('.street-row-btn[data-id="c1"]').click();
  // The geocoder's full label: spaces as `+`, commas as `%2C` — both must pass takeReturnTo's allowlist.
  const here = '/street?lat=41.82820&lng=-71.40050&q=481+Angell+St%2C+Providence%2C+Rhode+Island%2C+02906&case=c1';
  await expect(page).toHaveURL(here);
  const href = (await page.locator('.street-detail a.street-follow-signin').getAttribute('href'))!;
  expect(decodeURIComponent(href)).toBe(`/account?returnTo=${here}`);
  // Already signed in and sent to /account with that returnTo (what the sign-in flow does) → straight back to the card.
  await page.evaluate((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.goto(href);
  await expect(page).toHaveURL(here);
  await expect(page.locator('.street-detail')).toContainText('Pothole');
  await expect(title(page)).toHaveText('Pothole');
});

test('follow, signed in: Follow → PUT /api/me/city/:id and a pressed "Following"; Unfollow → DELETE; an already-followed case opens pressed and its toggle unfollows', async ({ page }) => {
  const calls = await point(page, { signedIn: true, me: { cityFollowing: ['c2'] } });
  const forCase = (id: string) => calls.filter((c) => c.url.endsWith(`/api/me/city/${id}`)).map((c) => c.method);
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = page.locator('.street-detail');
  const toggle = card.locator('.street-follow-btn');
  await expect(toggle).toHaveText('Follow this request');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(card.getByRole('button', { name: 'Unfollow' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toContainText('Following — we\'ll email you when the city updates it');
  await expect.poll(() => forCase('c1')).toEqual(['PUT']);
  await card.getByRole('button', { name: 'Unfollow' }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('Follow this request');
  await expect.poll(() => forCase('c1')).toEqual(['PUT', 'DELETE']);
  // c2 was followed before the page loaded (users.cityFollowing): pressed on open; the pressed toggle itself unfollows.
  await card.getByRole('button', { name: 'Back to list' }).click();
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await expect(card).toContainText('Street Light Out');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => forCase('c2')).toEqual(['DELETE']);
  // The digest card is still there under the actions.
  await expect(card.locator('.street-digest')).toBeVisible();
});

test('follow, signed in: a failed PUT reverts the toggle and says so', async ({ page }) => {
  const calls = await point(page, { signedIn: true, followStatus: () => 500 });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = page.locator('.street-detail');
  const toggle = card.locator('.street-follow-btn');
  await toggle.click();
  await expect(card.locator('.street-follow-error')).toHaveText("Couldn't save that. Try again.");
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('Follow this request');
  await expect(card.getByRole('button', { name: 'Unfollow' })).toHaveCount(0);
  expect(calls.filter((c) => c.url.includes('/api/me/city/')).map((c) => c.method)).toEqual(['PUT']);
  // Another case: the error line does not follow it.
  await card.getByRole('button', { name: 'Back to list' }).click();
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(card).toContainText('Overflowing Dumpster');
  await expect(card.locator('.street-follow-error')).toHaveCount(0);
});

test('follow, in flight: the toggle stays enabled (aria-busy), keeps focus, and a second tap is ignored', async ({ page }) => {
  const calls = await point(page, { signedIn: true, followDelayMs: 700 });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const toggle = page.locator('.street-detail .street-follow-btn');
  await toggle.focus();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  expect(await toggle.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false);
  await expect(toggle).toBeFocused();
  await toggle.click(); // re-entry: no second request
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toBeFocused(); // the aria-pressed flip happened on the focused element
  expect(calls.filter((c) => c.url.includes('/api/me/city/')).map((c) => c.method)).toEqual(['PUT']);
  // Escape still closes the card from the toggle.
  await toggle.press('Escape');
  await expect(page).not.toHaveURL(/[?&]case=/);
});

test('follow, account not loaded: the toggle reads off (aria-disabled) with "Loading your account…"; a failed load says so and a tap retries', async ({ page }) => {
  await point(page, { signedIn: true, meDelayMs: 6000 });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = page.locator('.street-detail');
  const toggle = card.locator('.street-follow-btn');
  await expect(card.locator('.street-follow-hint')).toHaveText('Loading your account…');
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  expect(await toggle.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false); // aria-disabled, never disabled: focusable, tappable
  const off = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(toggle).not.toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });
  await expect(card.locator('.street-follow-hint')).toHaveCount(0);
  expect(await toggle.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(off); // the off state looked different

  const calls = await point(page, { signedIn: true, meStatus: (n) => (n === 1 ? 500 : 200) });
  const meGets = () => calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/me')).length;
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(card.locator('.street-follow-hint')).toHaveText("Couldn't load your account — tap Follow to retry.");
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  expect(meGets()).toBe(1);
  await toggle.click({ force: true }); // (force: Playwright treats aria-disabled as not actionable) the tap retries the load — not a follow
  await expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
  expect(meGets()).toBe(2);
  expect(calls.filter((c) => c.url.includes('/api/me/city/'))).toEqual([]);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => calls.filter((c) => c.url.includes('/api/me/city/')).map((c) => c.method)).toEqual(['PUT']);
});

test('follow, when no mail would come: email updates off or an unverified address → "Following" without the promise, and a hint that links to Account', async ({ page }) => {
  await point(page, { signedIn: true, me: { cityFollowing: ['c1'], prefs: { emailUpdates: false, streetDigest: false } } });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = page.locator('.street-detail');
  const toggle = card.locator('.street-follow-btn');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText(/^✓?\s*Following$/);
  const hint = card.locator('.street-follow-hint');
  await expect(hint).toHaveText("Email updates are off for your account, so you won't hear about changes. Fix this in Account");
  await expect(hint.getByRole('link', { name: 'Fix this in Account' })).toHaveAttribute('href', '/account');

  await point(page, { signedIn: true, me: { cityFollowing: ['c1'], emailVerified: false } });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(toggle).toHaveText(/Following$/);
  await expect(card.locator('.street-follow-hint')).toContainText('Verify your email to hear about changes.');
  // Not following: no hint at all.
  await card.getByRole('button', { name: 'Back to list' }).click();
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(toggle).toHaveText('Follow this request');
  await expect(card.locator('.street-follow-hint')).toHaveCount(0);
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

test('the self-hosted basemap renders vector tiles and credits Protomaps; a missing manifest falls back to OSM raster', async ({ page }) => {
  // scripts/fetch-basemap.sh fails soft (no manifest) when neither our published copy nor Protomaps could be reached.
  test.skip(!existsSync(new URL('../public/map/basemap.json', import.meta.url)), 'no basemap extract in this build');
  await setup(page, { basemap: true });
  let archive = 0;
  page.on('request', (r) => { if (/\/map\/pvd-\d+\.pmtiles$/.test(r.url())) archive++; });
  await page.goto(POINT);
  await expect(page.locator('.mapview canvas.leaflet-tile').first()).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('.mapview .leaflet-control-attribution')).toContainText('Protomaps');
  expect(archive).toBeGreaterThan(0);
  expect(await page.locator('.mapview img.leaflet-tile').count()).toBe(0);
  // Fallback: the default suite setup 404s the manifest → raster tiles, OSM credit, no archive reads.
  await setup(page);
  await page.goto(POINT);
  await expect(page.locator('.mapview img.leaflet-tile').first()).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('.mapview .leaflet-control-attribution')).not.toContainText('Protomaps');
});
