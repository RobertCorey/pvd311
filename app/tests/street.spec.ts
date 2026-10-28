import { existsSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { API, BIG_STACK, BIG_STACK_CASES, DEFAULT_ITEMS, NEAR, PAIR, PAIR_CASES, POINT, PT, SESSION, STACK, STACK_CASES, UNPLACED, detailFor, filler, mapEval, setView, setup, userPan, waitForMap, zoomOf, type Case } from './street-mocks';
import { GROUP_GLYPHS } from '../src/lib/mapMarkers';
import { addDays, nyYmd } from '../src/lib/streetMap';
import { IPHONE, stubPush } from './push-mocks';

// /street — the map-first "My street" page (.claude/street-map-spec.md): one mocked GET /api/street/map, everything else
// (bbox, counts, clusters, hoods, URL) computed in the browser. Mobile project = iPhone 13 (390×664); one desktop describe.

const mapCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('/api/street/map'));
const sheet = (page: Page) => page.locator('.street-sheet');
const grab = (page: Page) => page.locator('.street-grab');
const title = (page: Page) => page.locator('.street-title');
const sub = (page: Page) => page.locator('.street-sub');
const rows = (page: Page) => page.locator('.street-row-btn');
/** The filters (components/StreetFilters.tsx): Show = three radios named "All, n" / "Open, n" / "Closed, n"; the When
 *  select, named by its label; Type = a button named by its label and what it reads ("Type All types · 3") that opens a
 *  dialog "Type" of checkboxes named "Trash, 1"; From / To date inputs while "Custom range…" is chosen; Clear (visible
 *  "Clear", named "Clear filters"). */
const radio = (page: Page, name: RegExp) => page.getByRole('radio', { name });
const whenSel = (page: Page) => page.getByLabel('When', { exact: true });
const typeBtn = (page: Page) => page.getByRole('button', { name: /^Type / });
const typeDlg = (page: Page) => page.getByRole('dialog', { name: 'Type', exact: true });
const typeBox = (page: Page, name: RegExp) => typeDlg(page).getByRole('checkbox', { name });
const fromIn = (page: Page) => page.getByLabel('From', { exact: true });
const toIn = (page: Page) => page.getByLabel('To', { exact: true });
const clearBtn = (page: Page) => page.getByRole('button', { name: 'Clear filters', exact: true });
/** Providence's calendar day `n` days from today ("YYYY-MM-DD"), and how the summary prints one ("Oct 20"). */
const nyDay = (n = 0) => addDays(nyYmd(Date.now()), n);
const shortDay = (ymd: string, locale = 'en-US') => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
/** The phone's floating filter rows (Street.tsx RAIL_BOTTOM = 162 px into the stage = their bottom edge). */
const FILTER_ROW = '.street-filters';
const RAIL_BOTTOM = 162;
/** The case page (components/StreetCasePage): a modal dialog over the whole page, named by the case type. */
const casePage = (page: Page) => page.locator('.case-page');
const caseDialog = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
/** Its top bar's "‹ Back to map". */
const backMap = (page: Page) => page.getByRole('button', { name: 'Back to map' });
/** The phone's pin preview (components/StreetPreview, 2026-10-28): a region "Selected request" docked over the PEEK
 *  sheet; its face is one button that opens the case page, beside it the ×. */
const preview = (page: Page) => page.getByRole('region', { name: 'Selected request', exact: true });
const cardFace = (page: Page) => page.locator('.street-preview-open');
const cardX = (page: Page) => page.getByRole('button', { name: 'Close preview', exact: true });
/** The main map's own pins (the case page draws its mini-map's pin with the same classes). */
const mainPins = (page: Page) => page.locator('.street-stage .mapview .map-case');
const selPin = (page: Page) => page.locator('.street-stage .map-pin--selected');
/** The main map's view, to compare before / after the case page: nothing it does may move it. */
const viewOf = (page: Page) => mapEval<{ lat: number; lng: number; z: number }>(page, 'm => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng, z: m.getZoom() }; }');
function expectSameView(a: { lat: number; lng: number; z: number }, b: { lat: number; lng: number; z: number }) {
  expect(a.z).toBe(b.z);
  expect(Math.abs(a.lat - b.lat)).toBeLessThan(1e-7);
  expect(Math.abs(a.lng - b.lng)).toBeLessThan(1e-7);
}

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
  // An address view fits to z16 — but on a slow runner the map has no height at first and MapView holds that fit until
  // it has one: wait for it to land, or it lands after the test has moved the map (CI 2026-10-28: a pin tap missed).
  if (/[?&]lat=/.test(url) && !/[?&](z|case)=/.test(url)) await expect.poll(() => zoomOf(page)).toBe(16);
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
  await expect(page.locator('main h1')).toHaveText('Map');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const report = page.locator('.tabbar a[href="/"]');
  await expect(report).toBeVisible();
  await report.click();
  await expect(page).toHaveURL(/\/$/);
});

test('landing half: the grabber cycles detents; Most reported and Latest — no "Jump to a neighborhood" select any more', async ({ page }) => {
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
  // By type group — the unit the Type filter picks, so a chip's count is what it shows.
  await expect(top.first()).toContainText('Streets & sidewalks');
  await expect(top.first().locator('b')).toHaveText(/^\d+$/);
  // The chips flow as a wrapping row (the sheet header's wrapper used to share the .street-top class: column + gap leaked both ways).
  expect(await page.locator('ul.street-top').evaluate((el) => getComputedStyle(el).flexDirection)).toBe('row');
  expect(await page.locator('.street-sheet-top').evaluate((el) => [getComputedStyle(el).flexDirection, getComputedStyle(el).rowGap])).toEqual(['column', 'normal']);
  // Rob, 2026-10-27: "Jump to a neighborhood can go too much" — /week's neighborhood rows still link to ?n=.
  await expect(page.getByLabel('Jump to a neighborhood…')).toHaveCount(0);
  await expect(page.locator('.street-sheet select')).toHaveCount(0);
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
  await expect(page.locator('.street-widened')).toHaveText('Nothing within a few blocks, so we zoomed out a little.');
  const none = page.locator('.street-none');
  await expect(none).toContainText('Nothing reported near here in the last 30 days.');
  // "Report something here" brings the address along (Report.tsx fills it in).
  await expect(none.locator('a.btn')).toHaveAttribute('href', '/?lat=41.82820&lng=-71.40050&q=481+Angell+St');
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

test('filters: Show is one choice of three (All / Open / Closed) with counts, Type a button over checkboxes, Clear resets; When: 7 cuts locally, 90 refetches once', async ({ page }) => {
  const calls = await point(page);
  await expect(page.locator('.map-case')).toHaveCount(3);
  const show = page.getByRole('group', { name: 'Show' });
  await expect(show.getByRole('radio')).toHaveCount(3);
  await expect(radio(page, /^All, 3$/)).toBeChecked();
  await expect(radio(page, /^Open, 2$/)).not.toBeChecked();
  await expect(radio(page, /^Closed, 1$/)).not.toBeChecked();
  await expect(clearBtn(page)).toHaveCount(0);
  // Open: the closed pin and row go.
  await radio(page, /^Open, 2$/).click();
  await expect(radio(page, /^Open, 2$/)).toBeChecked();
  await expect(radio(page, /^All, 3$/)).not.toBeChecked();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.map-pin--closed')).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]s=open/);
  // One choice: Closed replaces Open — there is no "both off" any more.
  await radio(page, /^Closed, 1$/).click();
  await expect(radio(page, /^Open, 2$/)).not.toBeChecked();
  await expect(radio(page, /^Closed, 1$/)).toBeChecked();
  await expect(page).toHaveURL(/[?&]s=closed/);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('.map-case:not(.map-pin--closed)')).toHaveCount(0);
  await radio(page, /^All, 3$/).click();
  await expect(page).not.toHaveURL(/[?&]s=/);
  await expect(rows(page)).toHaveCount(3);
  await expect(clearBtn(page)).toHaveCount(0);
  // Type: a button reading the selection; its dialog lists every group with its count; checking one writes the same
  // g= the old chips did.
  await expect(typeBtn(page)).toHaveText('All types · 3');
  await typeBtn(page).click();
  await typeBox(page, /^Streets & sidewalks, 1$/).click();
  await expect(page).toHaveURL(/[?&]g=streets/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pothole');
  await expect(page.locator('.map-case')).toHaveCount(1);
  await expect(typeBtn(page)).toHaveText('Streets & sidewalks · 1');
  await expect(typeBox(page, /^All types, 3$/)).not.toBeChecked();
  await typeDlg(page).getByRole('button', { name: 'Done' }).click();
  await expect(typeDlg(page)).toHaveCount(0);
  // Show's counts follow the type (status released, type applied).
  await expect(radio(page, /^All, 1$/)).toBeChecked();
  await expect(radio(page, /^Open, 1$/)).toBeVisible();
  await expect(radio(page, /^Closed, 0$/)).toBeVisible();
  // Clear shows off the defaults (visible "Clear", named "Clear filters") and resets everything.
  await expect(clearBtn(page)).toBeVisible();
  await expect(clearBtn(page)).toHaveText('Clear');
  await radio(page, /^Open, 1$/).click();
  await expect(page).toHaveURL(/[?&]g=streets&s=open/);
  await clearBtn(page).click();
  await expect(page).not.toHaveURL(/[?&](g|s|d)=/);
  await expect(clearBtn(page)).toHaveCount(0);
  await expect(radio(page, /^All, 3$/)).toBeChecked();
  await expect(typeBtn(page)).toHaveText('All types · 3');
  await expect(rows(page)).toHaveCount(3);
  // When: a select labelled "When"; the window alone also counts as a filter for Clear.
  await expect(whenSel(page)).toHaveValue('30');
  await expect(whenSel(page).locator('option')).toHaveText(['24 hours', '7 days', '30 days', '90 days', 'Custom range…']);
  const before = mapCalls(calls).length;
  await whenSel(page).selectOption('7');
  await expect(page).toHaveURL(/[?&]d=7/);
  await expect(clearBtn(page)).toBeVisible();
  await page.waitForTimeout(300);
  expect(mapCalls(calls).length).toBe(before);
  await whenSel(page).selectOption('90');
  await expect(page).toHaveURL(/[?&]d=90/);
  await expect.poll(() => mapCalls(calls).filter((c) => c.url.endsWith('days=90')).length).toBe(1);
  expect(mapCalls(calls).length).toBe(before + 1);
  await clearBtn(page).click();
  await expect(page).not.toHaveURL(/[?&]d=/);
  await expect(whenSel(page)).toHaveValue('30');
  await expect(clearBtn(page)).toHaveCount(0);
});

test('faceted counts: each choice reads what picking it would show; a zero type is still listed, pickable, and leads to the counted empty state', async ({ page }) => {
  await point(page, {}, `${POINT}&s=open`);
  await expect(radio(page, /^Closed, 1$/)).not.toBeChecked();
  await expect(radio(page, /^Open, 2$/)).toBeChecked();
  await expect(radio(page, /^All, 3$/)).not.toBeChecked();
  // Every group, in GROUP_ORDER, with its count under Open (the closed street light makes Lights 0); zeros included.
  await typeBtn(page).click();
  expect(await typeDlg(page).getByRole('checkbox').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual([
    'All types, 2', 'Trash & recycling, 1', 'Streets & sidewalks, 1', 'Traffic, signs & parking, 0', 'Trees, parks & yards, 0', 'Buildings & property, 0', 'Lights & wires, 0', 'Noise & neighborhood, 0', 'Water, sewer & gas, 0', 'Animals & pests, 0', 'Something else, 0',
  ]);
  await expect(typeDlg(page).locator('.street-check-n')).toHaveText(['2', '1', '1', '0', '0', '0', '0', '0', '0', '0', '0']);
  await typeBox(page, /^Trees, parks & yards, 0$/).click();
  await expect(page).toHaveURL(/[?&]g=trees/);
  await page.keyboard.press('Escape');
  await expect(sub(page)).toHaveText('0 in view · 0 open · 0 closed');
  await expect(page.locator('.street-none')).toContainText('Nothing here in the last 30 days with these filters.');
  const fix = page.getByRole('button', { name: 'Show all types (2)' });
  await expect(fix).toBeVisible();
  await expect(page.getByRole('button', { name: /^Include closed/ })).toHaveCount(0); // closed trees in view: 0 → hidden
  await fix.click();
  await expect(page).not.toHaveURL(/[?&]g=/);
  await expect(typeBtn(page)).toHaveText('All types · 2');
  await expect(rows(page)).toHaveCount(2);
});

test('filters: old links restore — no s (both statuses) → All, s=open → Open, s=closed → Closed, g=trash (/week\'s links) → Trash, d=7 → This week; unknown values fall back to the defaults', async ({ page }) => {
  await point(page);
  await expect(radio(page, /^All, 3$/)).toBeChecked();
  await expect(typeBtn(page)).toHaveText('All types · 3');
  await expect(whenSel(page)).toHaveValue('30');
  await expect(clearBtn(page)).toHaveCount(0);
  await page.goto(`${POINT}&s=open`);
  await expect(radio(page, /^Open, 2$/)).toBeChecked();
  await expect(rows(page)).toHaveCount(2);
  await expect(clearBtn(page)).toBeVisible();
  await page.goto(`${POINT}&s=closed`);
  await expect(radio(page, /^Closed, 1$/)).toBeChecked();
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`${POINT}&g=trash`);
  await expect(typeBtn(page)).toHaveText('Trash & recycling · 1');
  await typeBtn(page).click();
  await expect(typeBox(page, /^Trash & recycling, 1$/)).toBeChecked();
  await expect(typeDlg(page).getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(radio(page, /^All, 1$/)).toBeChecked();
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`${POINT}&d=7&s=open&g=lights`);
  await expect(whenSel(page)).toHaveValue('7');
  await expect(radio(page, /^Open, 0$/)).toBeChecked();
  await expect(typeBtn(page)).toHaveText('Lights & wires · 0');
  // A value no build ever wrote (s=both, g=nope, d=15) is the default — and Clear has nothing to clear.
  await page.goto(`${POINT}&s=both&g=nope&d=15`);
  await expect(rows(page)).toHaveCount(3);
  await expect(radio(page, /^All, 3$/)).toBeChecked();
  await expect(typeBtn(page)).toHaveText('All types · 3');
  await expect(whenSel(page)).toHaveValue('30');
  await expect(clearBtn(page)).toHaveCount(0);
  // A list in any order, with a value no build wrote: the known groups, in GROUP_ORDER.
  await page.goto(`${POINT}&g=streets,nope,trash`);
  await expect(typeBtn(page)).toHaveText('Trash & recycling +1 · 2');
  await expect(rows(page)).toHaveCount(2);
  // /week's "Most reported" rows land on the landing with the type picked.
  await page.goto('/street?g=other');
  await waitForMap(page);
  await expect(typeBtn(page)).toHaveText(/^Something else · \d+$/);
});

test('filters: keyboard — one Tab stop for Show, the arrow keys move the choice within it (and wrap), with a visible ring; then When, then the Type button', async ({ page }) => {
  await point(page);
  await radio(page, /^All, 3$/).focus();
  await page.keyboard.press('ArrowRight');
  await expect(radio(page, /^Open, 2$/)).toBeFocused();
  await expect(radio(page, /^Open, 2$/)).toBeChecked();
  await expect(page).toHaveURL(/[?&]s=open/);
  await page.keyboard.press('ArrowRight');
  await expect(radio(page, /^Closed, 1$/)).toBeFocused();
  await expect(radio(page, /^Closed, 1$/)).toBeChecked();
  await expect(page).toHaveURL(/[?&]s=closed/);
  const ring = await page.locator('.street-seg-opt[data-show="closed"] .street-seg-face').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(ring).toBe('solid');
  await page.keyboard.press('ArrowRight');
  await expect(radio(page, /^All, 3$/)).toBeChecked();
  await expect(page).not.toHaveURL(/[?&]s=/);
  await page.keyboard.press('ArrowLeft');
  await expect(radio(page, /^Closed, 1$/)).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(whenSel(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(typeBtn(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(radio(page, /^Closed, 1$/)).toBeFocused(); // back into the group lands on the chosen radio
});

test('filters on the phone: two 44 px rows under the search pill — Show across the width, then When (as wide as its choice), Type and Clear; labels visually hidden but naming them; they end at RAIL_BOTTOM with or without Clear, clear of the map key; nothing is off-screen or scrolls sideways (Type included, also from a /week deep link); When and Type are 16 px (no iOS zoom)', async ({ page }) => {
  await point(page);
  const row = page.locator(`.street-controls ${FILTER_ROW}`);
  await expect(row).toHaveCount(1);
  const stage = await box(page, '.street-stage'), pill = await box(page, '.street-pill');
  /** Every control lies inside the screen's 12 px gutters — nothing hidden past an edge. */
  const inside = async (b: { x: number; width: number }) => { expect(b.x).toBeGreaterThanOrEqual(12 - 0.5); expect(b.x + b.width).toBeLessThanOrEqual(390 - 12 + 0.5); };
  const check = async () => {
    const r = (await row.boundingBox())!;
    expect(r.height).toBeCloseTo(44 + 8 + 44, 0);
    expect(r.y + r.height - stage.y).toBeCloseTo(RAIL_BOTTOM, 0); // the fits, the in-view band and the city's edges read this constant
    expect(r.y).toBeGreaterThanOrEqual(pill.y + pill.height);
    await inside(r);
    const key = (await page.getByRole('button', { name: 'Map key', exact: true }).boundingBox())!;
    expect(key.y).toBeGreaterThanOrEqual(r.y + r.height); // nothing in the rows overlaps the map key
    return r;
  };
  const r = await check();
  // Row 1: the Show segments across the full width, each a 44 px target. Row 2: When then Type, side by side.
  const seg = await box(page, '.street-controls .street-seg'), when = (await whenSel(page).boundingBox())!, type = (await typeBtn(page).boundingBox())!;
  expect(seg.y).toBeCloseTo(r.y, 0);
  expect(seg.width).toBeCloseTo(r.width, 0);
  for (const o of await row.locator('.street-seg-input').all()) expect((await o.boundingBox())!.height).toBeCloseTo(44, 0);
  for (const b of [when, type]) { expect(b.y).toBeCloseTo(r.y + 52, 0); expect(b.height).toBeCloseTo(44, 0); await inside(b); }
  expect(when.x + when.width).toBeLessThanOrEqual(type.x);
  // Labels: visually hidden, still the names (the legend names the group).
  for (const l of await row.locator('.street-filter-label').all()) expect((await l.boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(page.getByRole('group', { name: 'Show' })).toHaveCount(1);
  expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // iOS Safari zooms the page into any select under 16 px on focus: When is 16 px, and Type matches it.
  expect(await row.locator('select, .street-type-btn').evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize))).toEqual(['16px', '16px']);
  // When is as wide as "30 days" needs (not a fixed share), Type takes the rest of the row.
  expect(when.width).toBeLessThan(140);
  expect(type.x + type.width).toBeCloseTo(390 - 12, 0);
  // Clear: the third cell of row 2, in sight, after Type in the tab order; the rows keep their height and bottom.
  await radio(page, /^Open, 2$/).click();
  await expect(clearBtn(page)).toBeVisible();
  await check();
  const c = (await clearBtn(page).boundingBox())!, type2 = (await typeBtn(page).boundingBox())!;
  expect(c.y).toBeCloseTo(r.y + 52, 0);
  expect(c.height).toBeCloseTo(44, 0);
  expect(c.x).toBeGreaterThanOrEqual(type2.x + type2.width);
  await inside(c);
  // Clear from the keyboard: the filters reset and focus lands on the checked "All", not <body>.
  await clearBtn(page).focus();
  await page.keyboard.press('Enter');
  await expect(clearBtn(page)).toHaveCount(0);
  await expect(radio(page, /^All, /)).toBeFocused();
  // "24 hours" + Clear: When grows to its words and Type still reads whole.
  await whenSel(page).selectOption('1');
  await expect(clearBtn(page)).toBeVisible();
  await check();
  expect(await typeBtn(page).locator('.street-type-text').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // A /week deep link (?g=animals) shows the picked type on its button, in sight — no sideways scroll needed.
  await page.goto('/street?g=animals');
  await waitForMap(page);
  await expect(typeBtn(page)).toHaveText(/^Animals & pests · \d+$/);
  await inside((await typeBtn(page).boundingBox())!);
  await check();
});

/** Two more around 481 Angell St for the 24-hour cut: graffiti reported six days ago and closed twelve hours ago (in, by
 *  its close), a noise complaint reported a day and a half ago (out). */
const DAY_CASES: Case[] = [
  { id: 'h1', t: 4, status: 'Resolved', createdDaysAgo: 6, closedDaysAgo: 0.5, lat: 41.8283, lng: -71.4003, street: '470 Angell St', res: 'Removed.' },
  { id: 'h2', t: 7, status: 'Submitted', createdDaysAgo: 1.5, lat: 41.8281, lng: -71.4007, street: '490 Angell St' },
];

test('When: 24 hours — reported or closed in the last 24 hours, cut from the 30-day load (no request); d=1; the summary and the empty state say "last 24 hours"; Clear brings back 30 days', async ({ page }) => {
  const calls = await point(page, { items: [...NEAR, ...DAY_CASES] });
  await expect(rows(page)).toHaveCount(5);
  const before = mapCalls(calls).length;
  await whenSel(page).selectOption('1');
  await expect(page).toHaveURL(/[?&]d=1(&|$)/);
  // c3 reported today and h1 closed 12 h ago; not c2 (closed a day ago to the minute, before this load), h2, c1.
  await expect(rows(page)).toHaveCount(2);
  expect(await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-id')).sort())).toEqual(['c3', 'h1']);
  await expect(radio(page, /^All, 2$/)).toBeChecked();
  await expect(radio(page, /^Closed, 1$/)).toBeVisible();
  await expect(typeBtn(page)).toHaveText('All types · 2');
  await page.waitForTimeout(300);
  expect(mapCalls(calls).length).toBe(before);
  // The empty state names the window.
  await typeBtn(page).click();
  await typeBox(page, /^Trees, parks & yards, 0$/).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.street-none')).toContainText('Nothing here in the last 24 hours with these filters.');
  await clearBtn(page).click();
  await expect(page).not.toHaveURL(/[?&](d|g)=/);
  await expect(whenSel(page)).toHaveValue('30');
  await expect(rows(page)).toHaveCount(5);
  // The city summary's tail.
  await page.goto('/street?d=1');
  await waitForMap(page);
  await expect(sub(page)).toHaveText('2 requests · 1 open · 1 closed · last 24 hours');
});

test('When: Custom range… — From / To (today − 89 … today; first the last 7 days, today included) as from=&to= instead of d; the smallest window that reaches From 00:00 loads (7 / 30 / 90); From ≤ To by their bounds (a date past the other is not applied, nor moves it); a date out of bounds is not applied; the summary and the empty state print the dates; links round-trip; Clear brings back 30 days', async ({ page }) => {
  // The landing (no point): its Latest list is the whole filtered set, so the counts do not depend on the map's band.
  const calls = await setup(page, { items: NEAR });
  await page.goto('/street');
  await waitForMap(page);
  await expect(rows(page)).toHaveCount(3);
  const days = (n: number) => mapCalls(calls).filter((c) => c.url.endsWith(`days=${n}`)).length;
  await expect.poll(() => days(30)).toBe(1);
  await expect(fromIn(page)).toHaveCount(0);
  await whenSel(page).selectOption('custom');
  await expect(page).toHaveURL(new RegExp(`/street\\?from=${nyDay(-6)}&to=${nyDay(0)}$`));
  await expect(page.getByRole('group', { name: 'Custom range' })).toBeVisible();
  await expect(fromIn(page)).toHaveValue(nyDay(-6));
  await expect(toIn(page)).toHaveValue(nyDay(0));
  // Today − 89 … today, each box also bounded by the other date.
  for (const el of [fromIn(page), toIn(page)]) await expect(el).toHaveAttribute('type', 'date');
  await expect(fromIn(page)).toHaveAttribute('min', nyDay(-89));
  await expect(fromIn(page)).toHaveAttribute('max', nyDay(0));
  await expect(toIn(page)).toHaveAttribute('min', nyDay(-6));
  await expect(toIn(page)).toHaveAttribute('max', nyDay(0));
  await expect(sub(page)).toHaveText(`3 requests · 2 open · 1 closed · ${shortDay(nyDay(-6))} – ${shortDay(nyDay(0))}`);
  // Seven dates, today included — the "7 days" /week counts: 00:00 six days ago is inside 7 × 24 h, so the 7-day set loads.
  await expect.poll(() => days(7)).toBe(1);
  // From two days ago: the 7-day set (already here) reaches it. c2 (closed yesterday) and c3 (today); not c1.
  await fromIn(page).fill(nyDay(-2));
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-2)}&to=${nyDay(0)}$`));
  await page.waitForTimeout(300);
  expect(days(7)).toBe(1);
  await expect(rows(page)).toHaveCount(2);
  // From ≤ To by the boxes' bounds: From's max is To, To's min is From. A To before From stays on screen unapplied —
  // From is not moved — and goes back on blur.
  await expect(fromIn(page)).toHaveAttribute('max', nyDay(0));
  await expect(toIn(page)).toHaveAttribute('min', nyDay(-2));
  await toIn(page).fill(nyDay(-3));
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-2)}&to=${nyDay(0)}$`));
  await expect(fromIn(page)).toHaveValue(nyDay(-2));
  await toIn(page).blur();
  await expect(toIn(page)).toHaveValue(nyDay(0));
  // From first, then To: one day (c1, reported three days ago).
  await fromIn(page).fill(nyDay(-3));
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-3)}&to=${nyDay(0)}$`));
  await toIn(page).fill(nyDay(-3));
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-3)}&to=${nyDay(-3)}$`));
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute('data-id', 'c1');
  await expect(sub(page)).toHaveText(new RegExp(` · ${shortDay(nyDay(-3))}$`)); // one day: just its date
  // …and a From after To stays unapplied too, To untouched; To first, then From (c2, closed yesterday).
  await fromIn(page).fill(nyDay(-1));
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-3)}&to=${nyDay(-3)}$`));
  await expect(toIn(page)).toHaveValue(nyDay(-3));
  await fromIn(page).blur();
  await expect(fromIn(page)).toHaveValue(nyDay(-3));
  await toIn(page).fill(nyDay(-1));
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-3)}&to=${nyDay(-1)}$`));
  await fromIn(page).fill(nyDay(-1));
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-1)}&to=${nyDay(-1)}$`));
  await expect(rows(page).first()).toHaveAttribute('data-id', 'c2');
  await expect(rows(page)).toHaveCount(1);
  // Six weeks back: only the 90-day set reaches it.
  await fromIn(page).fill(nyDay(-42));
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-42)}&to=${nyDay(-1)}$`));
  await expect.poll(() => days(90)).toBe(1);
  expect(days(30) + days(7) + days(90)).toBe(mapCalls(calls).length);
  // A typed date past the bounds stays in the box unapplied, and the box goes back to the applied one on blur.
  const applied = page.url();
  await fromIn(page).fill(nyDay(-120));
  await page.waitForTimeout(300);
  expect(page.url()).toBe(applied);
  await fromIn(page).blur();
  await expect(fromIn(page)).toHaveValue(nyDay(-42));
  // The empty state names the dates.
  await typeBtn(page).click();
  await typeBox(page, /^Trees, parks & yards, 0$/).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.street-none')).toContainText(`Nothing here from ${shortDay(nyDay(-42))} to ${shortDay(nyDay(-1))} with these filters.`);
  // Clear: back to 30 days, the dates gone.
  await clearBtn(page).click();
  await expect(page).toHaveURL(/\/street$/);
  await expect(whenSel(page)).toHaveValue('30');
  await expect(fromIn(page)).toHaveCount(0);
  await expect(sub(page)).toHaveText('3 requests · 2 open · 1 closed · last 30 days');
  // A link with a range: Custom range… chosen, its dates in the boxes, the window for its From loaded.
  const n7 = days(7);
  await page.goto(`/street?from=${nyDay(-3)}&to=${nyDay(-1)}`);
  await waitForMap(page);
  await expect(whenSel(page)).toHaveValue('custom');
  await expect(fromIn(page)).toHaveValue(nyDay(-3));
  await expect(toIn(page)).toHaveValue(nyDay(-1));
  await expect.poll(() => days(7)).toBe(n7 + 1);
  await expect(sub(page)).toHaveText(`2 requests · 1 open · 1 closed · ${shortDay(nyDay(-3))} – ${shortDay(nyDay(-1))}`);
  // Spanish prints the same dates its way.
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await page.reload();
  await waitForMap(page);
  await expect(sub(page)).toHaveText(`2 solicitudes · abiertas: 1 · cerradas: 1 · ${shortDay(nyDay(-3), 'es')} – ${shortDay(nyDay(-1), 'es')}`);
  await expect(page.getByLabel('Desde', { exact: true })).toHaveValue(nyDay(-3));
  await expect(page.getByLabel('Cuándo', { exact: true }).locator('option')).toHaveText(['24 horas', '7 días', '30 días', '90 días', 'Personalizado…']);
});

test('where the data starts (the feed\'s firstDay): a window reaching back before it reads "since <day>" — 30 and 90 days hold no more than that — and a range starts there; a shorter window keeps its words', async ({ page }) => {
  await setup(page, { items: NEAR, firstDay: nyDay(-12) });
  await page.goto('/street');
  await waitForMap(page);
  await expect(sub(page)).toHaveText(`3 requests · 2 open · 1 closed · since ${shortDay(nyDay(-12))}`);
  await whenSel(page).selectOption('7');
  await expect(sub(page)).toHaveText('3 requests · 2 open · 1 closed · last 7 days');
  await page.goto(`/street?from=${nyDay(-20)}&to=${nyDay(0)}`);
  await waitForMap(page);
  await expect(sub(page)).toHaveText(`3 requests · 2 open · 1 closed · ${shortDay(nyDay(-12))} – ${shortDay(nyDay(0))}`);
});

test('custom range links from long ago: read inside the bounds — a From past today − 89 raised to it (and the 90-day load), a To past today lowered to it, the address bar rewritten in place; a range wholly outside them falls back to 30 days', async ({ page }) => {
  const calls = await setup(page, { items: NEAR });
  // Partly stale (a link shared weeks ago): From 100 days back → today − 89, what the 90-day set covers.
  await page.goto(`/street?from=${nyDay(-100)}&to=${nyDay(-50)}`);
  await waitForMap(page);
  await expect(page).toHaveURL(new RegExp(`/street\\?from=${nyDay(-89)}&to=${nyDay(-50)}$`));
  await expect(fromIn(page)).toHaveValue(nyDay(-89));
  await expect(toIn(page)).toHaveValue(nyDay(-50));
  await expect(sub(page)).toHaveText(`0 requests · 0 open · 0 closed · ${shortDay(nyDay(-89))} – ${shortDay(nyDay(-50))}`);
  expect(mapCalls(calls).map((c) => c.url.replace(/^.*days=/, ''))).toEqual(['90']);
  // In place: Back leaves /street rather than returning to the stale link.
  expect(await page.evaluate(() => history.length)).toBe(2);
  // Editing To keeps the raised From.
  await toIn(page).fill(nyDay(-1));
  await expect(page).toHaveURL(new RegExp(`[?&]from=${nyDay(-89)}&to=${nyDay(-1)}$`));
  // A To in the future → today.
  await page.goto(`/street?from=${nyDay(-3)}&to=${nyDay(5)}`);
  await waitForMap(page);
  await expect(page).toHaveURL(new RegExp(`/street\\?from=${nyDay(-3)}&to=${nyDay(0)}$`));
  await expect(toIn(page)).toHaveValue(nyDay(0));
  // Wholly before the bounds (an Oct 1–15 link opened in January): no range at all — 30 days, as if it had none.
  await page.goto(`/street?from=${nyDay(-120)}&to=${nyDay(-100)}`);
  await waitForMap(page);
  await expect(page).toHaveURL(/\/street$/);
  await expect(whenSel(page)).toHaveValue('30');
  await expect(fromIn(page)).toHaveCount(0);
  await expect(sub(page)).toHaveText('3 requests · 2 open · 1 closed · last 30 days');
});

test('custom range typed a digit at a time (desktop Chrome, Edge, Firefox apply each complete date): To passing From on the way ("25" reads the 2nd after its "2") never moves From — each box\'s bounds hold the other date, a date past them stays unapplied (back on blur), and a typed day ends on the day typed', async ({ page }) => {
  const calls = await setup(page, { items: NEAR });
  // The previous month is wholly inside the bounds. Each date box is month · day · year: → moves to the day.
  const [y, m] = nyDay(0).split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const typeDay = async (el: ReturnType<typeof toIn>, keys: string) => { await el.focus(); await page.keyboard.press('ArrowRight'); for (const k of keys) { await page.keyboard.type(k); await page.waitForTimeout(250); } };
  // From the 10th to the 15th: From's max is To, To's min is From.
  await page.goto(`/street?from=${prev}-10&to=${prev}-15`);
  await waitForMap(page);
  await expect(fromIn(page)).toHaveAttribute('min', nyDay(-89));
  await expect(fromIn(page)).toHaveAttribute('max', `${prev}-15`);
  await expect(toIn(page)).toHaveAttribute('min', `${prev}-10`);
  await expect(toIn(page)).toHaveAttribute('max', nyDay(0));
  const n = mapCalls(calls).length;
  // "2" into To's day: it reads the 2nd — before From, so on screen but not applied, and From stays.
  await typeDay(toIn(page), '2');
  await expect(toIn(page)).toHaveValue(`${prev}-02`);
  await expect(page).toHaveURL(new RegExp(`[?&]from=${prev}-10&to=${prev}-15$`));
  await expect(fromIn(page)).toHaveValue(`${prev}-10`);
  // Its "5": the 25th, applied; From untouched, nothing reloaded, From's max follows.
  await page.keyboard.type('5');
  await expect(page).toHaveURL(new RegExp(`[?&]from=${prev}-10&to=${prev}-25$`));
  await expect(fromIn(page)).toHaveValue(`${prev}-10`);
  await expect(toIn(page)).toHaveValue(`${prev}-25`);
  await expect(fromIn(page)).toHaveAttribute('max', `${prev}-25`);
  expect(mapCalls(calls)).toHaveLength(n);
  // A From typed past To ("8": the 8th, after the 5th) stays unapplied — To is never brought along — and goes back on blur.
  await page.goto(`/street?from=${prev}-01&to=${prev}-05`);
  await waitForMap(page);
  await typeDay(fromIn(page), '8');
  await expect(fromIn(page)).toHaveValue(`${prev}-08`);
  await expect(page).toHaveURL(new RegExp(`[?&]from=${prev}-01&to=${prev}-05$`));
  await expect(toIn(page)).toHaveValue(`${prev}-05`);
  await fromIn(page).blur();
  await expect(fromIn(page)).toHaveValue(`${prev}-01`);
  // "28" into To's day: its "2" (the 2nd, after From) applies on the way, and the "8" still makes it the 28th — the box
  // is not rewritten under the typing.
  await typeDay(toIn(page), '28');
  await expect(page).toHaveURL(new RegExp(`[?&]from=${prev}-01&to=${prev}-28$`));
  await expect(toIn(page)).toHaveValue(`${prev}-28`);
});

test('custom range on the phone: a third row — From, To, Clear — under When and Type (Type takes Clear\'s place); the rail ends RANGE_ROW (52 px) lower: the map key and the FULL sheet move down with it, the map keeps the band\'s centre (no c/z written); a preset takes it all back', async ({ page }) => {
  await point(page);
  const stage = await box(page, '.street-stage');
  const rail = page.locator(`.street-controls ${FILTER_ROW}`);
  const keyBtn = page.getByRole('button', { name: 'Map key', exact: true });
  const homeY = async () => (await box(page, '.street-stage .map-home')).y;
  const y0 = await homeY();
  await whenSel(page).selectOption('custom');
  await expect(fromIn(page)).toBeVisible();
  const r = (await rail.boundingBox())!;
  expect(r.height).toBeCloseTo(44 * 3 + 8 * 2, 0);
  expect(r.y + r.height - stage.y).toBeCloseTo(RAIL_BOTTOM + 52, 0);
  const dates = page.locator('.street-controls .street-date');
  const when = (await whenSel(page).boundingBox())!, type = (await typeBtn(page).boundingBox())!;
  const from = (await dates.nth(0).boundingBox())!, to = (await dates.nth(1).boundingBox())!, c = (await clearBtn(page).boundingBox())!;
  for (const b of [when, type]) expect(b.y).toBeCloseTo(r.y + 52, 0);
  for (const b of [from, to, c]) expect(b.y).toBeCloseTo(r.y + 104, 0);
  for (const b of [when, type, from, to, c]) { expect(b.height).toBeCloseTo(44, 0); expect(b.x).toBeGreaterThanOrEqual(12 - 0.5); expect(b.x + b.width).toBeLessThanOrEqual(390 - 12 + 0.5); }
  expect(when.x + when.width).toBeLessThanOrEqual(type.x);
  expect(type.x + type.width).toBeCloseTo(390 - 12, 0);
  expect(from.x + from.width).toBeLessThanOrEqual(to.x);
  expect(to.x + to.width).toBeLessThanOrEqual(c.x);
  // Nothing is cut: "Custom range…" whole in its select (sized to it), the dates whole in their boxes; 16 px (no iOS zoom).
  expect(when.width).toBeGreaterThan(170);
  expect(await page.locator('.street-controls .street-date-input').evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize))).toEqual(['16px', '16px']);
  expect(await rail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The DOM order is the order seen (the tab order): When, Type, From, To, Clear.
  expect(await rail.locator('select, button, input[type="date"]').evaluateAll((els) => els.map((el) => el.className))).toEqual(['street-select', 'street-select street-type-btn', 'street-date-input', 'street-date-input', 'street-clear']);
  // The map key under the taller rail; the band's centre kept — the home pin moved down by half the row, and the view
  // is still the page's own fit, so no c/z.
  expect((await keyBtn.boundingBox())!.y - stage.y).toBeCloseTo(RAIL_BOTTOM + 52 + 8, 0);
  await expect.poll(homeY).toBeCloseTo(y0 + 26, 0);
  await page.waitForTimeout(400);
  await expect(page).not.toHaveURL(/[?&](c|z)=/);
  // FULL stops 52 px lower too: the rail and the OSM attribution under it stay in sight.
  await grab(page).click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
  await expect.poll(async () => Math.round((await box(page, '.street-sheet')).y - stage.y)).toBe(194 + 52);
  const attr = await box(page, '.street-stage > .mapview .leaflet-control-attribution');
  expect(attr.y).toBeGreaterThanOrEqual(r.y + r.height);
  expect(attr.y + attr.height).toBeLessThanOrEqual((await box(page, '.street-sheet')).y + 0.5);
  // A preset: the row goes and everything moves back.
  await whenSel(page).selectOption('30');
  await expect(fromIn(page)).toHaveCount(0);
  await expect(clearBtn(page)).toHaveCount(0);
  await expect.poll(async () => Math.round((await rail.boundingBox())!.height)).toBe(96);
  await expect.poll(async () => Math.round((await box(page, '.street-sheet')).y - stage.y)).toBe(194);
  await grab(page).click(); // full → peek: the key is back, at its old place
  await expect(keyBtn).toBeVisible();
  expect((await keyBtn.boundingBox())!.y - stage.y).toBeCloseTo(RAIL_BOTTOM + 8, 0);
});

test('Type: several at once — the button opens a dialog of checkboxes (All types, then every group with its count); any mix filters the map and the list to their union, g= in GROUP_ORDER with commas; All types clears; Escape, Done, an outside tap and Tab out close it, focus back on the button; on the phone it fits the screen and scrolls inside', async ({ page }) => {
  await point(page);
  const btn = typeBtn(page);
  const done = typeDlg(page).getByRole('button', { name: 'Done' });
  await expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await expect(typeDlg(page)).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(btn).toHaveAttribute('aria-controls', (await typeDlg(page).getAttribute('id'))!);
  await expect(typeBox(page, /^All types, 3$/)).toBeFocused();
  await expect(typeBox(page, /^All types, 3$/)).toBeChecked();
  await expect(typeDlg(page).getByRole('checkbox')).toHaveCount(11);
  // Streets, then Trash: the URL lists them in GROUP_ORDER, with plain commas; the dialog stays open for more.
  await typeBox(page, /^Streets & sidewalks, 1$/).click();
  await typeBox(page, /^Trash & recycling, 1$/).click();
  await expect(page).toHaveURL(/[?&]g=trash,streets(&|$)/);
  await expect(btn).toHaveText('Trash & recycling +1 · 2');
  await expect(typeBox(page, /^All types, 3$/)).not.toBeChecked();
  await expect(typeDlg(page)).toBeVisible();
  // The union: the dumpster and the pothole, not the street light; Show counts follow; each box keeps its own count.
  await expect(rows(page)).toHaveCount(2);
  await expect(mainPins(page)).toHaveCount(2);
  await expect(radio(page, /^All, 2$/)).toBeChecked();
  await expect(radio(page, /^Closed, 0$/)).toBeVisible();
  await expect(typeBox(page, /^Lights & wires, 1$/)).not.toBeChecked();
  // Escape closes it, focus back on the button.
  await page.keyboard.press('Escape');
  await expect(typeDlg(page)).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  // From the keyboard: Enter opens it on "All types"; Space there clears the selection (and it stays checked).
  await page.keyboard.press('Enter');
  await expect(typeBox(page, /^All types, 3$/)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page).not.toHaveURL(/[?&]g=/);
  await expect(btn).toHaveText('All types · 3');
  await expect(typeDlg(page).getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(typeBox(page, /^All types, 3$/)).toBeChecked();
  // Tab to Lights, Space; Tab on to Done, Enter: closed, focus on the button.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  await expect(typeBox(page, /^Lights & wires, 1$/)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/[?&]g=lights(&|$)/);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  await expect(done).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(typeDlg(page)).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(btn).toHaveText('Lights & wires · 1');
  // Tab past Done closes it, focus where Tab sent it (Clear).
  await page.keyboard.press('Enter');
  await done.focus();
  await page.keyboard.press('Tab');
  await expect(typeDlg(page)).toHaveCount(0);
  await expect(clearBtn(page)).toBeFocused();
  // An outside tap on plain background (the page header's edge — on the phone the dialog spans the sheet's header):
  // closed; focus was inside, so it goes back to the button. A tap that takes focus itself (the search box) keeps it.
  await btn.click();
  await expect(typeBox(page, /^All types, 3$/)).toBeFocused();
  const hdr = await box(page, '.app-header');
  await page.mouse.click(hdr.x + 4, hdr.y + hdr.height / 2);
  await expect(typeDlg(page)).toHaveCount(0);
  await expect(btn).toBeFocused();
  await btn.click();
  await page.locator('.street-pill-input').click();
  await expect(typeDlg(page)).toHaveCount(0);
  await expect(page.locator('.street-pill-input')).toBeFocused();
  // The phone: under its button, inside the 12 px gutters, above the tab bar — over the sheet and the map key; the
  // list scrolls inside, Done stays in sight, the last box scrolls into view and takes a tap.
  await btn.click();
  const d = (await typeDlg(page).boundingBox())!, b = (await btn.boundingBox())!, st = await box(page, '.street-stage');
  expect(d.x).toBeGreaterThanOrEqual(12 - 0.5);
  expect(d.x + d.width).toBeLessThanOrEqual(390 - 12 + 0.5);
  expect(d.y).toBeGreaterThanOrEqual(b.y + b.height);
  expect(d.y + d.height).toBeLessThanOrEqual(st.y + st.height - 12 + 0.5);
  expect(await typeDlg(page).locator('.street-checks').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const onTop = (l: ReturnType<Page['locator']>) => l.evaluate((el) => { const q = el.getBoundingClientRect(); const hit = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2); return !!hit && el.contains(hit); });
  expect(await onTop(done)).toBe(true);
  const other = typeBox(page, /^Something else, 0$/);
  await other.scrollIntoViewIfNeeded();
  expect(await onTop(other)).toBe(true);
  await other.click();
  await expect(page).toHaveURL(/[?&]g=lights,other(&|$)/);
  await expect(btn).toHaveText('Lights & wires +1 · 1');
  for (const ck of await typeDlg(page).locator('.street-check').all()) expect((await ck.boundingBox())!.height).toBeGreaterThanOrEqual(44 - 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Clear closes it and resets the types with the rest.
  await page.keyboard.press('Escape');
  await clearBtn(page).click();
  await expect(page).not.toHaveURL(/[?&]g=/);
  await expect(btn).toHaveText('All types · 3');
});

test('selection via row: the case page opens as a modal dialog named by the case and takes focus, writes case=, marks the pin behind it; the sheet keeps its list; Back to map and Escape return focus to the row', async ({ page }) => {
  await point(page);
  const row = page.locator('.street-row-btn[data-id="c2"]');
  await row.click();
  const dlg = caseDialog(page, 'Street Light Out');
  await expect(dlg).toBeFocused();
  await expect(dlg).toHaveAttribute('aria-modal', 'true');
  await expect(dlg.locator('.case-addr')).toHaveText('22 Thayer St');
  await expect(dlg.locator('.case-pill .my-status')).toHaveText('Closed');
  await expect(dlg.locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(selPin(page)).toHaveCount(1);
  // Behind it: the sheet still lists the point's cases under the address, and the whole app is inert.
  await expect(title(page)).toHaveText('481 Angell St');
  await expect(sheet(page).locator('.street-row-btn')).toHaveCount(3);
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  await backMap(page).click();
  await expect(dlg).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  await expect(row).toBeFocused();
  await expect(selPin(page)).toHaveCount(0);
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(caseDialog(page, 'Pothole')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(casePage(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-row-btn[data-id="c1"]')).toBeFocused();
});

test('selection via pin and deep link: a pin tap at PEEK shows its preview card (no case page, no case=) without moving the map; the card opens the page, closing it finds the card again; × gives focus to the map; ?case= opens the page on load; an unknown case says so', async ({ page }) => {
  await point(page);
  await grab(page).press('ArrowDown');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await setView(page, NEAR[0].lat!, NEAR[0].lng!, 17);
  await page.waitForTimeout(400);
  const before = await viewOf(page);
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  // Phone (2026-10-28): the card first — focused, never the aria-hidden marker; the case page waits for its tap.
  const card = preview(page);
  await expect(card).toBeFocused();
  await expect(card.locator('.street-type')).toHaveText('Pothole');
  await expect(casePage(page)).toHaveCount(0);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await expect(selPin(page)).toHaveCount(1);
  await page.waitForTimeout(600);
  await expect(page).not.toHaveURL(/[?&]case=/);
  expectSameView(await viewOf(page), before);
  await cardFace(page).click();
  const dlg = caseDialog(page, 'Pothole');
  await expect(dlg).toBeFocused();
  await expect(page).toHaveURL(/[?&]case=c1/);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await expect(selPin(page)).toHaveCount(1);
  expectSameView(await viewOf(page), before);
  // Closed: the map is where it was and the card still shows, focus on its face; × closes the card and focus goes to
  // the map (pins are aria-hidden; the map is their focusable owner).
  await backMap(page).click();
  await expect(dlg).toHaveCount(0);
  await expect(cardFace(page)).toBeFocused();
  await expect(selPin(page)).toHaveCount(1);
  await cardX(page).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.street-stage .mapview')).toBeFocused();
  await expect(selPin(page)).toHaveCount(0);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  expectSameView(await viewOf(page), before);

  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  await expect(caseDialog(page, 'Pothole')).toBeFocused();
  await expect(selPin(page)).toHaveCount(1);
  await expect(title(page)).toHaveText('481 Angell St');

  // A case the city's record no longer has: asked for by itself (404) → the gone line, no page, case= dropped.
  const calls = await setup(page);
  await page.goto(`${POINT}&case=unknown`);
  await waitForMap(page);
  await expect(page.locator('.street-gone')).toContainText("We couldn't find that request");
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(casePage(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  expect(calls.filter((c) => c.url.includes('/api/street/case/')).map((c) => c.url.split('/').pop())).toEqual(['unknown']);
});

test('deep link to a case older than the window (the follow mail, a /my row): fetched by itself, the case page + its pin, the window untouched; an unplaced one has no mini-map and no Nearby, the rest stays', async ({ page }) => {
  const old: Case = { id: 'old1', t: 6, status: 'Assigned', createdDaysAgo: 140, lat: 41.83, lng: -71.41, street: '5 Elm St' };
  const unplaced: Case = { id: 'old2', t: 0, status: 'Resolved', createdDaysAgo: 200, closedDaysAgo: 120, lat: null, lng: null, street: '', res: 'Filled.' };
  const calls = await setup(page, { extraCases: [old, unplaced] });
  const lookups = () => calls.filter((c) => c.url.includes('/api/street/case/')).map((c) => c.url.split('/').pop());
  // The mail's link: case= with the case's own lat/lng.
  await page.goto('/street?case=old1&lat=41.83000&lng=-71.41000');
  await waitForMap(page);
  const card = caseDialog(page, 'Tree Down');
  await expect(card).toBeFocused();
  await expect(card.locator('.case-addr')).toHaveText('5 Elm St');
  await expect(card.locator('.case-map .map-case')).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]case=old1/);
  await expect(selPin(page)).toHaveCount(1);
  expect(lookups()).toEqual(['old1']);
  expect(mapCalls(calls)).toHaveLength(1); // 30 days only — no 90-day refetch, no gone notice
  await expect(page.locator('.street-gone')).toHaveCount(0);
  // Follow works on it like any case (signed out here: the sign-in link returns to this URL).
  expect(decodeURIComponent((await card.locator('a.street-follow-signin').getAttribute('href'))!)).toBe('/account?returnTo=/street?case=old1&lat=41.83000&lng=-71.41000');
  // Back to map drops the case and its pin.
  await backMap(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(selPin(page)).toHaveCount(0);

  // Bare case= on an unplaced closed case: the page (with the city's note) over the whole city, no mini-map, no pin, no Nearby.
  await page.goto('/street?case=old2');
  await waitForMap(page);
  const card2 = caseDialog(page, 'Pothole');
  await expect(card2).toBeFocused();
  await expect(card2.locator('.street-note')).toHaveText('Filled.');
  await expect(card2.locator('.case-hero')).toHaveClass(/case-hero--nomap/);
  await expect(card2.locator('.case-map')).toHaveCount(0);
  await expect(card2.locator('.case-nearby')).toHaveCount(0);
  await expect(card2.locator('.street-digest')).toHaveCount(0);
  await expect(card2.locator('.case-addr')).toHaveText('Street not given');
  await expect(card2.locator('.case-stat')).toHaveText([/^Closed after\s*80 days$/, /^Reported\s*[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/]);
  await expect(card2.locator('.case-tile')).toHaveText([/^Type\s*Streets & sidewalks$/, /^Status\s*Closed$/]);
  await expect(selPin(page)).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]case=old2/);
  expect(lookups()).toEqual(['old1', 'old2']);
});

// ── The phone's pin preview (components/StreetPreview; Rob, 2026-10-28, "idk you pick": Zillow's small card first) ──
//    Under 720 px a pin tap shows a compact card docked over the PEEK sheet instead of the case page; its face opens the
//    page. Not in the URL. Desktop keeps the page on a pin click (the desktop describe).

test('pin preview: a pin tap at HALF lowers the sheet to PEEK and shows the card — icon, type, status, street · neighborhood, "Reported … · open N days" — one 44 px face and a 44 px ×, the pin selected and clear of it, the attribution under it; the browser\'s Back from the page it opens finds the card; raising the sheet closes it', async ({ page }) => {
  await point(page, { details: { c1: detailFor(NEAR[0]) } });
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  const before = await viewOf(page);
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  const card = preview(page);
  await expect(card).toBeFocused();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await expect(casePage(page)).toHaveCount(0);
  await expect(card.locator('.street-icon svg')).toHaveCount(1);
  await expect(card.locator('.street-type')).toHaveText('Pothole');
  await expect(card.locator('.my-status')).toHaveText('Assigned');
  await expect(card.locator('.street-addr')).toHaveText('10 Angell St · College Hill');
  await expect(card.locator('.street-when')).toHaveText(/^Reported [A-Z][a-z]{2} \d{1,2} · open 3 days$/);
  // The whole face is one button, named by what it shows + "See details"; the × is the card's only other control.
  await expect(card.getByRole('button')).toHaveCount(2);
  const face = card.getByRole('button', { name: /^Pothole.*See details$/ });
  const fb = (await face.boundingBox())!, xb = (await cardX(page).boundingBox())!;
  expect(fb.height).toBeGreaterThanOrEqual(44);
  expect(fb.width).toBeGreaterThan(300);
  expect(xb.width).toBeGreaterThanOrEqual(44);
  expect(xb.height).toBeGreaterThanOrEqual(44);
  // Docked over the sheet with the OSM attribution between them; inside the screen's width.
  await page.waitForTimeout(400); // the sheet's 220 ms slide down to PEEK
  const cb = (await card.boundingBox())!, sh = (await sheet(page).boundingBox())!, attr = (await page.locator('.street-stage .leaflet-control-attribution').boundingBox())!;
  expect(attr.y).toBeGreaterThanOrEqual(cb.y + cb.height);
  expect(attr.y + attr.height).toBeLessThanOrEqual(sh.y);
  expect(cb.x).toBeGreaterThanOrEqual(12);
  expect(cb.x + cb.width).toBeLessThanOrEqual(page.viewportSize()!.width - 12);
  // Its pin: the selected one, whole above the card; every pin still aria-hidden.
  await expect(selPin(page)).toHaveAttribute('data-id', 'c1');
  const pb = (await selPin(page).boundingBox())!;
  expect(pb.y + pb.height).toBeLessThan(cb.y);
  expect(await mainPins(page).evaluateAll((els) => els.length > 0 && els.every((e) => e.getAttribute('aria-hidden') === 'true'))).toBe(true);
  // Not in the URL; the map did not move (the pin was clear of the card).
  await page.waitForTimeout(400);
  await expect(page).not.toHaveURL(/[?&]case=/);
  expectSameView(await viewOf(page), before);
  // The face opens the case page (case=, a history entry); the browser's Back closes it, the card still there, focus on its face.
  await face.click();
  await expect(caseDialog(page, 'Pothole')).toBeFocused();
  await expect(page).toHaveURL(/[?&]case=c1/);
  await page.goBack();
  await expect(casePage(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(card).toHaveAttribute('data-id', 'c1');
  await expect(face).toBeFocused();
  expectSameView(await viewOf(page), before);
  // Raising the sheet (the list) closes the card.
  await grab(page).click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(card).toHaveCount(0);
  await expect(selPin(page)).toHaveCount(0);
});

test('pin preview: another pin swaps the card (focus follows); ×, a tap on the map and Escape close it with focus on the map; a small pan keeps it, a pan that takes its pin out of view closes it; never a case=', async ({ page }) => {
  await point(page);
  await grab(page).press('ArrowDown');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await setView(page, PT.lat, PT.lng, 17);
  await page.waitForTimeout(400);
  const card = preview(page), map = page.locator('.street-stage .mapview');
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute('data-id', 'c1');
  // Another pin: one card, now that case's, focused again; its pin the selected one.
  await clickPin(page, NEAR[2].lat!, NEAR[2].lng!);
  await expect(card).toHaveAttribute('data-id', 'c3');
  await expect(card.locator('.street-type')).toHaveText('Overflowing Dumpster');
  await expect(card).toBeFocused();
  await expect(page.locator('.street-preview')).toHaveCount(1);
  await expect(selPin(page)).toHaveCount(1);
  await expect(selPin(page)).toHaveAttribute('data-id', 'c3');
  // ×: closed, nothing selected, focus on the map.
  await cardX(page).click();
  await expect(card).toHaveCount(0);
  await expect(map).toBeFocused();
  await expect(selPin(page)).toHaveCount(0);
  // A tap on the map itself (no pin there).
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  await expect(card).toBeVisible();
  const mb = (await map.boundingBox())!;
  await page.mouse.click(mb.x + 40, mb.y + 240);
  await expect(card).toHaveCount(0);
  await expect(selPin(page)).toHaveCount(0);
  // Escape.
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  await expect(card).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(map).toBeFocused();
  // A small pan keeps it; one that takes the pin out of the band between the rail and the sheet closes it.
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  await expect(card).toBeVisible();
  await userPan(page, 0, -30);
  await page.waitForTimeout(500);
  await expect(card).toBeVisible();
  await expect(selPin(page)).toHaveCount(1);
  await userPan(page, 0, 300);
  await expect(card).toHaveCount(0);
  await expect(selPin(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(casePage(page)).toHaveCount(0);
});

test('pin preview: the card never covers its pin — one tapped just above the sheet moves up just clear of the card and no further; its page opens and closes over that view', async ({ page }) => {
  await point(page, { details: { c2: detailFor(NEAR[1]) } });
  await grab(page).press('ArrowDown');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await setView(page, PT.lat, PT.lng, 17);
  await page.waitForTimeout(400);
  const pin = page.locator('.street-stage .map-case[data-id="c2"]');
  const p0 = (await pin.boundingBox())!, sh = (await sheet(page).boundingBox())!;
  expect(p0.y + p0.height).toBeLessThan(sh.y); // above the sheet: a pin you can tap
  const before = await viewOf(page);
  await clickPin(page, NEAR[1].lat!, NEAR[1].lng!);
  const card = preview(page);
  await expect(card).toBeFocused();
  await expect(card.locator('.street-type')).toHaveText('Street Light Out');
  await page.waitForTimeout(500); // the card's 160 ms rise, the map's 250 ms nudge
  const cb = (await card.boundingBox())!;
  expect(p0.y + p0.height).toBeGreaterThan(cb.y); // where it was, the card would have covered it
  // Moved up: its tip and selection ring 8 px over the card's top (the pin's box ends 1 px under the tip, the ring 5 px),
  // no more — and only up.
  const gap = async () => { const b = (await pin.boundingBox())!; return cb.y - (b.y + b.height); };
  expect(await gap()).toBeGreaterThanOrEqual(12);
  expect(await gap()).toBeLessThanOrEqual(15);
  const after = await viewOf(page);
  expect(after.z).toBe(before.z);
  expect(after.lat).toBeLessThan(before.lat);
  expect(Math.abs(after.lng - before.lng)).toBeLessThan(1e-5); // under a pixel (Leaflet's pan re-derives the centre)
  await expect(page).not.toHaveURL(/[?&]case=/);
  // Its page opens over that view and closes back to it, the card still clear of the pin.
  await cardFace(page).click();
  await expect(caseDialog(page, 'Street Light Out')).toBeFocused();
  await backMap(page).click();
  await expect(casePage(page)).toHaveCount(0);
  await expect(card).toBeVisible();
  expectSameView(await viewOf(page), after);
  expect(await gap()).toBeGreaterThanOrEqual(12);
});

test('pin preview: at the landing, a lone pin in the city\'s south end moves up clear of the card — the city\'s pan limit makes room for the card and does not pull the pin back under it', async ({ page }) => {
  // Washington Park, 0.013° north of the city's south line: at the landing's z11 its pin sits where the card docks.
  const SOUTH: Case = { id: 'w1', t: 0, status: 'Submitted', createdDaysAgo: 0, lat: 41.785, lng: -71.41, street: '50 Broad St' };
  await landing(page, { items: [...NEAR, SOUTH] });
  await page.waitForTimeout(700); // the landing's PEEK refit is done
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  const z = await zoomOf(page);
  const pin = page.locator('.street-stage .map-case[data-id="w1"]');
  const p0 = (await pin.boundingBox())!;
  await clickPin(page, SOUTH.lat!, SOUTH.lng!);
  const card = preview(page);
  await expect(card).toHaveAttribute('data-id', 'w1');
  await page.waitForTimeout(1000); // the card's rise, the 250 ms nudge, then the limit's check a frame after it
  const cb = (await card.boundingBox())!;
  expect(p0.y + p0.height).toBeGreaterThan(cb.y); // where it was, the card would have covered it
  const pb = (await pin.boundingBox())!;
  expect(pb.y + pb.height).toBeLessThan(cb.y);
  expect(pb.y).toBeGreaterThanOrEqual((await page.locator('.street-stage').boundingBox())!.y + RAIL_BOTTOM); // and whole under the filter rows
  expect(await zoomOf(page)).toBe(z);
  await expect(selPin(page)).toHaveAttribute('data-id', 'w1');
});

test('pin preview: Back to another view leaves the card behind — search an address, tap a pin, the browser\'s Back to the city: no card, nothing selected', async ({ page }) => {
  await landing(page);
  await page.locator('.street-pill-input').fill('481 angell');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050/);
  await expect.poll(() => zoomOf(page)).toBe(16);
  await expect(page.locator('.street-stage .map-case[data-id="c1"]')).toBeVisible();
  await page.waitForTimeout(400); // the fit's flight is over: the pin is where clickPin reads it
  await clickPin(page, NEAR[0].lat!, NEAR[0].lng!);
  const card = preview(page);
  await expect(card).toHaveAttribute('data-id', 'c1');
  await page.goBack();
  await expect(page).toHaveURL(/\/street$/);
  await expect.poll(() => zoomOf(page)).toBeLessThanOrEqual(13);
  await expect(card).toHaveCount(0);
  await expect(selPin(page)).toHaveCount(0);
  await expect(page.locator('.street-stage .map-cluster--selected')).toHaveCount(0);
  // Forward to the address: no card there either (it was never in the URL).
  await page.goForward();
  await expect(page.locator('.map-home')).toHaveCount(1);
  await page.waitForTimeout(400);
  await expect(card).toHaveCount(0);
});

test('pin preview in Spanish: the region, the lines (a closed request: "cerrada en 8 días") and the ×', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await point(page);
  await clickPin(page, NEAR[1].lat!, NEAR[1].lng!);
  const card = page.getByRole('region', { name: 'Solicitud seleccionada', exact: true });
  await expect(card).toBeFocused();
  await expect(card.locator('.street-type')).toHaveText('Street Light Out');
  await expect(card.locator('.my-status')).toHaveText('Cerrada');
  await expect(card.locator('.street-addr')).toHaveText('22 Thayer St · College Hill');
  await expect(card.locator('.street-when')).toHaveText(/^Reportada el \d{1,2} \S+ · cerrada en 8 días$/);
  await expect(card.getByRole('button', { name: /Ver detalles$/ })).toBeVisible();
  await card.getByRole('button', { name: 'Cerrar la vista previa', exact: true }).click();
  await expect(card).toHaveCount(0);
});

// ── The case page (Rob, 2026-10-27, with a Zillow listing opened over its map: "when you click on a pin you should get like
//    a full screen overlay … also clicking in the sidepanel should give you detailed view") ──
const caseCalls = (calls: { url: string }[], id: string) => calls.filter((c) => c.url.endsWith(`/api/street/case/${id}`)).length;
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

test('case page on the phone (390×664): the whole screen, tab bar included; a sticky top bar (Back to map · Follow · Share, 44 px targets); the hero — a static mini-map with the case\'s pin, then type, address, neighborhood and pill; the stat row and the fact tiles; nothing scrolls sideways', async ({ page }) => {
  await point(page, { details: { c2: detailFor(NEAR[1], { workCompletedDaysAgo: 2 }) } });
  await page.locator('.street-row-btn[data-id="c2"]').click();
  const dlg = caseDialog(page, 'Street Light Out');
  await expect(dlg).toBeFocused();
  // Full screen, over the tab bar: what sits at the tab bar's spot is the page.
  const vp = page.viewportSize()!;
  expect(await dlg.boundingBox()).toEqual({ x: 0, y: 0, width: vp.width, height: vp.height });
  const tab = await box(page, '.tabbar-inner');
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.case-page'), [tab.x + tab.width / 2, tab.y + tab.height / 2] as [number, number])).toBe(true);
  // The top bar: Back to map on the left, Follow (signed out: the sign-in link) and Share on the right.
  const bar = dlg.locator('.case-bar');
  const back = (await backMap(page).boundingBox())!, follow = (await bar.getByRole('link', { name: 'Sign in to follow this request' }).boundingBox())!;
  const share = (await bar.getByRole('button', { name: 'Share' }).boundingBox())!;
  for (const b of [back, follow, share]) { expect(b.height).toBeGreaterThanOrEqual(44); expect(b.width).toBeGreaterThanOrEqual(44); }
  expect(back.x).toBeLessThan(follow.x);
  expect(follow.x + follow.width).toBeLessThanOrEqual(share.x + 1);
  expect(share.x + share.width).toBeLessThanOrEqual(vp.width);
  await expect(bar.getByRole('link', { name: 'Sign in to follow this request' })).toHaveText('Follow');
  // Hero: the mini-map — the case's pin, selected; no zoom control, no drag, not a tab stop; named for the place.
  const mini = dlg.locator('.case-map .mapview');
  await expect(mini).toHaveAttribute('role', 'region');
  await expect(mini).toHaveAttribute('aria-label', 'Map: 22 Thayer St');
  expect(await mini.getAttribute('tabindex')).toBeNull();
  await expect(mini).not.toHaveClass(/leaflet-grab/);
  await expect(mini.locator('.leaflet-control-zoom')).toHaveCount(0);
  await expect(mini.locator('.map-case')).toHaveCount(1);
  await expect(mini.locator('.map-case')).toHaveClass(/map-pin--selected/);
  await expect(mini.locator('.leaflet-control-attribution').getByRole('link', { name: 'OpenStreetMap' })).toBeVisible();
  const m = (await mini.boundingBox())!, head = await box(page, '.case-head');
  expect(m.y + m.height).toBeLessThanOrEqual(head.y); // the title block under the map on a phone
  await expect(dlg.locator('.case-title')).toHaveText('Street Light Out');
  await expect(dlg.getByRole('heading', { level: 2, name: 'Street Light Out' })).toBeVisible();
  await expect(dlg.locator('.case-addr')).toHaveText('22 Thayer St');
  await expect(dlg.locator('.case-hood')).toHaveText('College Hill');
  await expect(dlg.locator('.case-pill')).toHaveText('Closed');
  // Stat row: label over value, each one phrase — how long to close, when reported, how far from the searched address.
  await expect(dlg.locator('.case-stat')).toHaveText([/^Closed after\s*8 days$/, /^Reported\s*[A-Z][a-z]{2} \d{1,2}$/, /^From 481 Angell St\s*56 m$/]);
  // Fact tiles: type group, status, and the two form dates the city has.
  await expect(dlg.locator('.case-tile dt')).toHaveText(['Type', 'Status', 'Sent to the department', 'Work completed']);
  await expect(dlg.locator('.case-tile dd')).toHaveText(['Lights & wires', 'Closed', /^[A-Z][a-z]{2} \d{1,2}$/, /^[A-Z][a-z]{2} \d{1,2}$/]);
  // The page scrolls inside; the bar stays on top.
  await dlg.evaluate((el) => { el.scrollTop = 700; });
  await expect.poll(() => dlg.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect((await bar.boundingBox())!.y).toBe(0);
  expect(await dlg.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('case page focus: moved into the dialog when it opens; Tab and Shift+Tab wrap inside it and never reach the map, the sheet or the tab bar (the app root is inert)', async ({ page }) => {
  await point(page, { details: { c2: detailFor(NEAR[1]) } });
  await page.locator('.street-row-btn[data-id="c2"]').click();
  const dlg = casePage(page);
  await expect(dlg).toBeFocused();
  const inside = () => page.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && !!a.closest('.case-page'); });
  // From the dialog itself, Shift+Tab goes to its last control; Tab from there wraps to the first.
  await page.keyboard.press('Shift+Tab');
  await expect(dlg.locator('.case-report a')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(backMap(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dlg.locator('.case-report a')).toBeFocused();
  // All the way round: every stop is inside the dialog.
  const stops = new Set<string>();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(await inside(), `Tab ${i + 1}`).toBe(true);
    stops.add(await page.evaluate(() => document.activeElement!.textContent ?? ''));
  }
  expect(stops.size).toBeGreaterThan(5);
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  // Escape from any control closes it.
  await dlg.getByRole('button', { name: 'Share' }).focus();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.street-row-btn[data-id="c2"]')).toBeFocused();
});

test('case page detail: GET /api/street/case/:id once per case — the timeline lists only the steps with dates (the close says how long it took), "What was reported" as label/value text (never HTML), the city\'s full address in the hero only when it says more than the street, the form\'s dates as tiles; a skeleton while it loads', async ({ page }) => {
  const c1 = NEAR[0];
  const calls = await point(page, {
    caseDelayMs: 900,
    details: {
      c1: detailFor(c1, { address: '12 Angell St, Providence, RI, 02906, USA', workCompletedDaysAgo: 1, answers: [{ label: 'Type of Property', value: '<b>Residential</b>' }, { label: 'Is Property Abandoned', value: 'Yes' }] }),
      c2: { ...detailFor(NEAR[1]), address: '22 THAYER ST, Providence, RI, 02906, USA', timeline: { ...detailFor(NEAR[1]).timeline, received: null, routed: null }, answers: [] },
    },
  });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = casePage(page);
  // The basic page is there at once; the detail block is a skeleton until the request lands.
  await expect(card.locator('.case-addr')).toHaveText('10 Angell St');
  await expect(card.locator('.case-skel')).toBeVisible();
  await expect(card.locator('.case-main')).toHaveAttribute('aria-busy', 'true');
  await expect(card.locator('.case-tile')).toHaveCount(2);
  await expect(card.locator('.street-tl')).toBeVisible({ timeout: 5000 });
  await expect(card.locator('.case-skel')).toHaveCount(0);
  await expect(card.locator('.case-main')).not.toHaveAttribute('aria-busy', 'true');
  // Open case: Reported, Received, Sent to the department, Work completed — no Closed step.
  const steps = card.locator('.street-tl-step');
  expect(await steps.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.step))).toEqual(['reported', 'received', 'routed', 'workCompleted']);
  await expect(steps.locator('.street-tl-label')).toHaveText(['Reported', 'Received by the city', 'Sent to the department', 'Work completed']);
  for (const tm of await steps.locator('time').all()) {
    await expect(tm).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(Number.isFinite(Date.parse((await tm.getAttribute('datetime'))!))).toBe(true);
  }
  await expect(card.locator('.street-tl-days')).toHaveCount(0);
  await expect(card.locator('.case-tile dt')).toHaveText(['Type', 'Status', 'Sent to the department', 'Work completed']);
  await expect(card.locator('.case-stat').first()).toHaveText(/^Open\s*3 days$/);
  // "What was reported": a definition list, the value as typed — markup stays text.
  await expect(card.getByRole('heading', { name: 'What was reported' })).toBeVisible();
  await expect(card.locator('.street-answers dt')).toHaveText(['Type of Property', 'Is Property Abandoned']);
  await expect(card.locator('.street-answers dd')).toHaveText(['<b>Residential</b>', 'Yes']);
  await expect(card.locator('.street-answers b')).toHaveCount(0);
  // The city's address has a different house number than its street field → the hero shows it, without ", USA".
  await expect(card.locator('.case-addr')).toHaveText('12 Angell St, Providence, RI, 02906');
  await expect(card.getByRole('heading', { name: "The city's note" })).toHaveCount(0); // open: no note
  expect(caseCalls(calls, 'c1')).toBe(1);

  // Closed case: Reported → Closed "8 days after it was reported"; the city's note; no answers; the address only
  // repeats the street (case aside) → the street; no form dates beyond the two → two tiles.
  await backMap(page).click();
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await expect(card.locator('.street-tl-step')).toHaveCount(2, { timeout: 5000 });
  await expect(card.locator('.street-tl-label')).toHaveText(['Reported', 'Closed']);
  await expect(card.locator('.street-tl-step[data-step="resolved"] .street-tl-days')).toHaveText('8 days after it was reported');
  await expect(card.getByRole('heading', { name: "The city's note" })).toBeVisible();
  await expect(card.locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(card.locator('.street-answers')).toHaveCount(0);
  await expect(card.locator('.case-addr')).toHaveText('22 Thayer St');
  await expect(card.locator('.case-tile dt')).toHaveText(['Type', 'Status']);

  // No detail read yet (c3: the endpoint omits `detail`): the basic page, no skeleton left, no timeline.
  await backMap(page).click();
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(caseDialog(page, 'Overflowing Dumpster')).toBeVisible();
  await expect.poll(() => caseCalls(calls, 'c3')).toBe(1);
  await expect(card.locator('.case-skel')).toHaveCount(0, { timeout: 5000 });
  await expect(card.locator('.street-tl, .street-answers')).toHaveCount(0);
  await expect(card.locator('.case-addr')).toHaveText('481 Angell St');

  // Reopening a case reads the cache: no second request, no skeleton flash.
  await backMap(page).click();
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(card.locator('.street-tl')).toBeVisible();
  await expect(card.locator('.case-skel')).toHaveCount(0);
  expect(caseCalls(calls, 'c1')).toBe(1);
});

test('case page detail: a failed request leaves the basic page — hero, stats, the two tiles and the city\'s note, no error, no skeleton', async ({ page }) => {
  const calls = await point(page, { caseStatus: () => 500 });
  await page.locator('.street-row-btn[data-id="c2"]').click();
  const card = caseDialog(page, 'Street Light Out');
  await expect(card).toBeFocused();
  await expect.poll(() => caseCalls(calls, 'c2')).toBe(1);
  await expect(card.locator('.case-skel')).toHaveCount(0);
  await expect(card.locator('.case-addr')).toHaveText('22 Thayer St');
  await expect(card.locator('.case-stat').first()).toHaveText(/^Closed after\s*8 days$/);
  await expect(card.locator('.case-tile dt')).toHaveText(['Type', 'Status']);
  await expect(card.locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(card.locator('.street-tl, .street-answers')).toHaveCount(0);
  await expect(card.locator('.notice-error')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Share' })).toBeVisible();
  await expect(card.locator('.case-nearby .street-row-btn')).toHaveCount(2);
});

test('closing the case page returns to exactly what was there: the browser Back closes it (and Forward reopens it); the detent, the list\'s scroll, the map view and the focused row are as before — no refit', async ({ page }) => {
  await landing(page);
  await page.waitForTimeout(700); // the landing's PEEK refit is done
  await grab(page).click();
  await grab(page).click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
  const body = page.locator('#street-sheet-body');
  const target = sheet(page).locator('.street-row-btn').nth(8);
  await target.scrollIntoViewIfNeeded();
  const scrolled = await body.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  const id = (await target.getAttribute('data-id'))!;
  const before = await viewOf(page);
  await target.click();
  await expect(casePage(page)).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`[?&]case=${id}`));
  await page.goBack();
  await expect(casePage(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator(`.street-row-btn[data-id="${id}"]`)).toBeFocused();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
  expect(await body.evaluate((el) => el.scrollTop)).toBe(scrolled);
  await expect(title(page)).toHaveText('Providence');
  await page.waitForTimeout(400);
  expectSameView(await viewOf(page), before);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`[?&]case=${id}`));
  await expect(casePage(page)).toBeFocused();
  // Escape pops that entry again; Forward still has it.
  await page.keyboard.press('Escape');
  await expect(casePage(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(scrolled);
  expectSameView(await viewOf(page), before);
  // The same entry again (Forward): Back to map closes it again, one entry only (still on /street, the list as before).
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`[?&]case=${id}`));
  await expect(casePage(page)).toBeFocused();
  await backMap(page).click();
  await expect(casePage(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/street$/);
  expect(await body.evaluate((el) => el.scrollTop)).toBe(scrolled);
});

test('case page Nearby: up to five other requests within 150 m of it from the loaded feed, nearest first, with their distance from this case; a row swaps the page — a history entry, so Back returns to the first case and Back to map closes both; nothing near says so', async ({ page }) => {
  const lone: Case = { id: 'lone', t: 8, status: 'Submitted', createdDaysAgo: 2, lat: 41.83, lng: -71.43, street: '1 Lone St' };
  await point(page, { items: [...DEFAULT_ITEMS, ...BIG_STACK_CASES, lone] });
  await page.locator('.street-row-btn[data-id="c2"]').click();
  const dlg = casePage(page);
  const near = dlg.locator('.case-nearby');
  await expect(near.getByRole('heading', { name: 'Nearby' })).toBeVisible();
  await expect(near.locator('.case-nearby-hint')).toHaveText('Other requests within 150 m in the last 30 days');
  const nrows = near.locator('.street-row-btn');
  await expect(nrows).toHaveCount(2);
  expect(await nrows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual(['c3', 'c1']);
  await expect(nrows.nth(0).locator('.street-addr')).toHaveText('481 Angell St · College Hill · 58 m away');
  await expect(nrows.nth(1).locator('.street-addr')).toHaveText('10 Angell St · College Hill · 96 m away');
  await dlg.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await nrows.nth(1).click();
  await expect(page).toHaveURL(/[?&]case=c1/);
  await expect(caseDialog(page, 'Pothole')).toBeFocused();
  expect(await dlg.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await dlg.locator('.case-nearby .street-row-btn').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))).toEqual(['c3', 'c2']);
  // The browser Back returns to the first case; Forward to the second.
  await page.goBack();
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(caseDialog(page, 'Street Light Out')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/[?&]case=c1/);
  await expect(caseDialog(page, 'Pothole')).toBeVisible();
  // Back to map from the second case: the list (not c2 again), focus on the row that opened the first.
  await backMap(page).click();
  await expect(casePage(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-row-btn[data-id="c2"]')).toBeFocused();
  await expect(title(page)).toHaveText('481 Angell St');

  // Thirteen at one spot: five of the other twelve, all 0 m away.
  await page.goto('/street?case=b1');
  await waitForMap(page);
  await expect(caseDialog(page, 'Pothole')).toBeVisible();
  await expect(casePage(page).locator('.case-nearby .street-row-btn')).toHaveCount(5);
  await expect(casePage(page).locator('.case-nearby .street-row-btn .street-addr').first()).toContainText('0 m away');
  // Nothing within 150 m.
  await page.goto('/street?case=lone');
  await waitForMap(page);
  await expect(caseDialog(page, 'Water Leak')).toBeVisible();
  await expect(casePage(page).locator('.case-nearby .street-row-btn')).toHaveCount(0);
  await expect(casePage(page).locator('.case-nearby')).toContainText('Nothing else reported within 150 m in the last 30 days.');
});

test('pins say more than open/closed: each type group\'s glyph in white in the pin head (ten groups, open and closed alike); the halo only on new pins — open and reported in the last 48 h — and none under reduced motion', async ({ page }) => {
  // One case per group around a quiet spot, 50 m apart: z17 draws them as pins. Open for the first five, closed after.
  const spot = { lat: 41.835, lng: -71.41 };
  const groups: [number, string][] = [[0, 'streets'], [1, 'lights'], [2, 'trash'], [4, 'property'], [5, 'traffic'], [6, 'trees'], [7, 'nuisance'], [8, 'water'], [9, 'animals'], [10, 'other']];
  const glyphCases: Case[] = groups.map(([t], i) => ({
    id: `g${i}`, t, status: i < 5 ? 'Submitted' : 'Closed', createdDaysAgo: i < 5 ? 3 : 6, closedDaysAgo: i < 5 ? null : 2,
    lat: Math.round((spot.lat + (i % 5) * 0.00045) * 1e5) / 1e5, lng: Math.round((spot.lng + Math.floor(i / 5) * 0.0006) * 1e5) / 1e5, street: `${i + 1} Hope St`,
  }));
  await setup(page, { items: [...DEFAULT_ITEMS, ...glyphCases] });
  await page.goto('/street?c=41.8359,-71.4097&z=17');
  await waitForMap(page);
  await expect(page.locator('.map-case[data-id="g0"]')).toHaveCount(1);
  for (const [i, [, g]] of groups.entries()) {
    const svg = page.locator(`.map-case[data-id="g${i}"] svg`);
    await expect(svg, g).toHaveAttribute('data-group', g);
    const want = GROUP_GLYPHS[g as keyof typeof GROUP_GLYPHS];
    const ds = await svg.locator('.map-pin-glyph path').evaluateAll((els) => els.map((e) => e.getAttribute('d')));
    expect(ds, g).toEqual([want.d, want.dots, want.solid].filter(Boolean));
    expect(await svg.locator('.map-pin-glyph').evaluate((el) => getComputedStyle(el).stroke), g).toBe('rgb(255, 255, 255)');
    await expect(page.locator(`.map-case[data-id="g${i}"]`)).toHaveClass(i < 5 ? /^(?!.*map-pin--closed)/ : /map-pin--closed/);
  }
  // Same footprint as before: 26×32 open, 22×27 closed.
  expect([(await box(page, '.map-case[data-id="g0"]')).width, (await box(page, '.map-case[data-id="g0"]')).height]).toEqual([26, 32]);
  expect([(await box(page, '.map-case[data-id="g5"]')).width, (await box(page, '.map-case[data-id="g5"]')).height]).toEqual([22, 27]);
  // None of these is new (3+ days old): no halo, although open and at z17 (the old rule pulsed every open pin from z16).
  await expect(page.locator('.map-pin--halo')).toHaveCount(0);

  // Around 481 Angell St at z16: c3 (today, open) pulses; c1 (open, 3 days) and c2 (closed) do not.
  await page.goto(POINT);
  await waitForMap(page);
  await expect(page.locator('.map-case')).toHaveCount(3);
  await expect(page.locator('.map-pin--halo')).toHaveCount(1);
  await expect(page.locator('.map-case[data-id="c3"]')).toHaveClass(/map-pin--halo/);
  await expect(page.locator('.map-case[data-id="c3"]')).toHaveClass(/map-case--new/);
  await expect(page.locator('.map-case[data-id="c3"] .map-pin-halo')).toBeVisible();
  await expect(page.locator('.map-case[data-id="c1"] .map-pin-halo')).toHaveCount(0);
  await expect(page.locator('.map-case[data-id="c2"] .map-pin-halo')).toHaveCount(0);
  // Selecting the new pin keeps its emphasis (scale + ring) on top of the halo, behind the case page.
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(page.locator('.street-stage .map-case[data-id="c3"]')).toHaveClass(/map-pin--selected/);
  await expect(page.locator('.street-stage .map-case[data-id="c3"]')).toHaveClass(/map-pin--halo/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(POINT);
  await waitForMap(page);
  await expect(page.locator('.map-case')).toHaveCount(3);
  await expect(page.locator('.map-pin--halo')).toHaveCount(0);
});

test('legend: the Open and Closed choices lead with a dot in the pin colours (decorative; All has none); their names are unchanged', async ({ page }) => {
  await point(page);
  await expect(radio(page, /^Open, 2$/)).toBeVisible();
  await expect(radio(page, /^Closed, 1$/)).toBeVisible();
  const open = page.locator('.street-seg-opt[data-show="open"]'), closed = page.locator('.street-seg-opt[data-show="closed"]');
  await expect(page.locator('.street-dot')).toHaveCount(2);
  await expect(page.locator('.street-seg-opt[data-show="all"] .street-dot')).toHaveCount(0);
  await expect(open.locator('.street-dot--open')).toHaveAttribute('aria-hidden', 'true');
  await expect(closed.locator('.street-dot--closed')).toHaveAttribute('aria-hidden', 'true');
  const fillOf = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fill);
  const bgOf = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor);
  const openPin = await fillOf('.mapview .map-case:not(.map-pin--closed) svg > path:nth-of-type(2)');
  expect(await bgOf('.street-dot--open')).toBe(openPin);
  expect(await bgOf('.street-dot--closed')).toBe(await fillOf('.mapview .map-pin--closed svg > path:nth-of-type(2)'));
  // The dot comes first, before the word.
  expect(await open.locator('.street-seg-name').evaluate((el) => (el.firstElementChild as HTMLElement).className)).toContain('street-dot');
  // Chosen (filled ink), the dot keeps the pin colour — only its ring turns paper.
  await radio(page, /^Open, 2$/).click();
  await expect(radio(page, /^Open, 2$/)).toBeChecked();
  expect(await bgOf('.street-dot--open')).toBe(openPin);
});

test('map key: a 44 px button under the rail opens a dialog drawn with the map\'s own markers — every entry\'s classes match the map\'s, the open pin is the same markup; Escape, ×, the button and an outside tap close it and focus returns to the button', async ({ page }) => {
  await point(page);
  const btn = page.getByRole('button', { name: 'Map key', exact: true });
  const b = (await btn.boundingBox())!, rail = await box(page, FILTER_ROW);
  expect(b.width).toBeGreaterThanOrEqual(44);
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.y).toBeGreaterThanOrEqual(rail.y + rail.height); // not in the rail
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  const dlg = page.getByRole('dialog', { name: 'Map key' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  const items = dlg.locator('.street-key-item');
  expect(await items.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key))).toEqual(['open', 'closed', 'cluster', 'stack', 'type', 'new', 'home', 'ring']);
  await expect(items.locator('.street-key-text')).toHaveText([
    'Orange pin: still open', 'Gray pin: closed', 'Number: several requests here — the ring shows open (orange) and closed (gray)',
    'Pins joined by thin lines: several requests at the same spot',
    'Icon in the pin: the type of request', 'Pulsing ring: open, reported in the last 48 hours', '× pin: the address you looked up', 'Dashed circle: the area the weekly email covers',
  ]);
  for (const el of await dlg.locator('.street-key-sw').all()) await expect(el).toHaveAttribute('aria-hidden', 'true');
  // Each swatch carries the classes the map's own marker has (the map's element adds Leaflet's and state classes).
  const classesOf = (l: ReturnType<Page['locator']>) => l.first().evaluate((el) => (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.startsWith('map-')).sort());
  const pairs: [string, string][] = [
    ['[data-key="open"] .street-key-swatch', '.mapview .map-case[data-id="c1"]'],
    ['[data-key="closed"] .street-key-swatch', '.mapview .map-case[data-id="c2"]'],
    ['[data-key="new"] .street-key-swatch', '.mapview .map-case[data-id="c3"]'],
    ['[data-key="home"] .street-key-swatch', '.mapview .map-home'],
  ];
  for (const [k, m] of pairs) expect(await classesOf(dlg.locator(k)), k).toEqual(await classesOf(page.locator(m)));
  expect(await classesOf(dlg.locator('[data-key="ring"] circle'))).toEqual(['map-ring']);
  expect(await page.locator('.mapview path.map-ring').getAttribute('class')).toContain('map-ring');
  // Same markup: the key's open streets pin IS the map's pin for c1 (a pothole, open, not new).
  expect(await dlg.locator('[data-key="open"] .street-key-swatch').innerHTML()).toBe(await page.locator('.mapview .map-case[data-id="c1"]').innerHTML());
  expect(await dlg.locator('[data-key="new"] .map-pin-halo').evaluate((el) => getComputedStyle(el).display)).toBe('block');
  // …and the same styles: MapView.css draws both.
  const stroke = (l: ReturnType<Page['locator']>) => l.evaluate((el) => { const s = getComputedStyle(el); return `${s.stroke}|${s.strokeDasharray}|${s.fill}`; });
  expect(await stroke(dlg.locator('[data-key="ring"] circle'))).toBe(await stroke(page.locator('.mapview path.map-ring')));
  // Escape → closed, focus on the button.
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  // The dialog's own ×.
  await btn.click();
  await dlg.getByRole('button', { name: 'Close the map key' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(btn).toBeFocused();
  // The button again (the open dialog covers its corner, so from the keyboard: Shift+Tab back to it, Enter).
  await btn.click();
  await expect(dlg).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(btn).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dlg).toHaveCount(0);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  // An outside tap on plain text (the sheet's title).
  await btn.click();
  await expect(dlg).toBeFocused();
  const tt = await box(page, '.street-title');
  await page.mouse.click(tt.x + 8, tt.y + tt.height / 2);
  await expect(dlg).toHaveCount(0);
  await expect(btn).toBeFocused();
  // Clusters: the key's disc is the map's disc (landing).
  await setView(page, 41.83, -71.42, 12);
  await expect(page.locator('.mapview .map-cluster').first()).toBeVisible();
  await btn.click();
  expect(await dlg.locator('[data-key="cluster"] .street-key-swatch').evaluate((el) => [(el.getAttribute('class') ?? '').split(' ').filter((c) => c.startsWith('map-cluster')).length, !!el.querySelector('.map-cluster-ring > .map-cluster-disc')])).toEqual([2, true]);
  expect(await page.locator('.mapview .map-cluster').first().evaluate((el) => !!el.querySelector('.map-cluster-ring > .map-cluster-disc'))).toBe(true);
  await expect(dlg.locator('[data-key="cluster"] .map-cluster-disc')).toHaveText('8');
  // Fanned stacks: the key's legs and dot are the map's (classes and styles, a 6-stack at z18); its pins are case pins.
  await setView(page, STACK.lat, STACK.lng, 18);
  await expect(page.locator('.mapview path.map-leg')).toHaveCount(6);
  for (const [k, m] of [['[data-key="stack"] .map-leg', '.mapview path.map-leg'], ['[data-key="stack"] .map-spot', '.mapview path.map-spot']]) {
    expect(await classesOf(dlg.locator(k)), k).toEqual(await classesOf(page.locator(m)));
    expect(await stroke(dlg.locator(k).first()), k).toBe(await stroke(page.locator(m).first()));
  }
  await expect(dlg.locator('[data-key="stack"] .map-pin.map-case')).toHaveCount(2);
  expect(await dlg.locator('[data-key="stack"] .map-case:not(.map-pin--closed)').innerHTML()).toBe(await page.locator('.mapview .map-case[data-id="s4"]').innerHTML()); // s4: an open pothole, not new
  // Not drawn at FULL (the sheet covers its spot); an open key closes; back at HALF the button is there, closed.
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await grab(page).press('ArrowUp');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
  await expect(btn).toHaveCount(0);
  await expect(dlg).toHaveCount(0);
  await grab(page).press('ArrowDown');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('map key under reduced motion: no "pulsing ring" line (the map draws no halos then)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await point(page);
  await page.getByRole('button', { name: 'Map key', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Map key' });
  await expect(dlg.locator('[data-key="open"]')).toBeVisible();
  await expect(dlg.locator('[data-key="new"]')).toBeHidden();
});

test('map key over the sheet header (390×664, HALF): it covers the header\'s Share, so Tab past its × closes it with focus where Tab sent it — never on a control under the key; Shift+Tab out past the button closes it too', async ({ page }) => {
  await point(page);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  const btn = page.getByRole('button', { name: 'Map key', exact: true });
  const dlg = page.getByRole('dialog', { name: 'Map key' });
  const shareBtn = page.locator('.street-head-actions').getByRole('button', { name: 'Share' });
  await btn.click();
  await expect(dlg).toBeFocused();
  // Precondition: the open key sits over the header's Share.
  const pop = await box(page, '.street-key-pop'), x = (await shareBtn.boundingBox())!;
  expect(pop.x <= x.x && pop.x + pop.width >= x.x + x.width && pop.y <= x.y && pop.y + pop.height >= x.y + x.height).toBe(true);
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('button', { name: 'Close the map key' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dlg).toHaveCount(0);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(grab(page)).toBeFocused(); // not pulled back to the button
  await page.keyboard.press('Tab');
  await expect(shareBtn).toBeFocused();
  const onTop = (l: ReturnType<Page['locator']>) => l.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && el.contains(hit); });
  expect(await onTop(shareBtn)).toBe(true);
  // Shift+Tab: the dialog → the button keeps it open; one more → the rail before it, and it closes.
  await btn.click();
  await expect(dlg).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(btn).toBeFocused();
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.street-controls'))).toBe(true);
});

/** Each drawn case pin's tip (its anchor) in page px, read off its box: open pins are 26×32 anchored at (13, 31), closed
 *  ones 22×27 at (11, 26) (lib/mapMarkers caseMarker). */
const pinTips = (page: Page) => mainPins(page).evaluateAll((els) => els.map((el) => {
  const r = el.getBoundingClientRect(), closed = el.classList.contains('map-pin--closed');
  return { id: (el as HTMLElement).dataset.id ?? '', x: r.x + (closed ? 11 : 13), y: r.y + (closed ? 26 : 31) };
}));
/** A coordinate in page px. */
async function pagePoint(page: Page, lat: number, lng: number) {
  const p = await mapEval<{ x: number; y: number }>(page, `m => { const q = m.latLngToContainerPoint([${lat}, ${lng}]); return { x: q.x, y: q.y }; }`);
  const box = (await page.locator('.mapview').boundingBox())!;
  return { x: box.x + p.x, y: box.y + p.y };
}
const legs = (page: Page) => page.locator('.mapview path.map-leg');
const spot = (page: Page) => page.locator('.mapview path.map-spot');

test('clusters and stacks: six cases at one spot are one disc below street zoom and a tap flies in to their own pins; thirteen at one spot stay one disc at z18, and its tap lists them', async ({ page }) => {
  await landing(page, { items: [...DEFAULT_ITEMS, ...BIG_STACK_CASES] });
  const six = page.locator('.map-cluster', { hasText: /^6$/ });
  await expect(six).toHaveCount(1);
  await six.click();
  await expect.poll(() => zoomOf(page)).toBe(18);
  await expect(page.locator('.mapview .map-case')).toHaveCount(6);
  await expect(legs(page)).toHaveCount(6);
  await expect(six).toHaveCount(0);
  // Thirteen is one more than fans out: the disc at every zoom, and at z18 its tap lists them.
  await setView(page, BIG_STACK.lat, BIG_STACK.lng, 18);
  await page.waitForTimeout(400);
  const big = page.locator('.map-cluster', { hasText: /^13$/ });
  await expect(big).toHaveCount(1);
  await expect(page.locator('.mapview .map-case')).toHaveCount(0);
  await expect(legs(page)).toHaveCount(0);
  await big.click();
  await expect(page.locator('.street-body .street-h').first()).toHaveText('13 requests at this spot');
  await expect(title(page)).toHaveText('13 requests at this spot');
  await expect(rows(page)).toHaveCount(13);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await page.getByRole('button', { name: 'Show everything in view' }).click();
  await expect(page.locator('.street-body .street-h').first()).toHaveText('In view');
  await expect(rows(page)).toHaveCount(13);
});

test('fanned stacks (Rob: "impossible to zoom in far enough to get individual pins"): from z17 the 2-stack and the 6-stack are their own case pins on thin legs around a dot on the true spot — no disc, no pin on the spot, none overlapping; a pan keeps the nodes; z16 folds them back into a disc with nothing left over', async ({ page }) => {
  await landing(page, { items: [...DEFAULT_ITEMS, ...PAIR_CASES] });
  await page.waitForTimeout(700); // the PEEK sheet settles and the landing refits the city before we move the map
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  for (const [at, cases] of [[PAIR, PAIR_CASES], [STACK, STACK_CASES]] as const) {
    const n = cases.length, ids = cases.map((c) => c.id).sort();
    for (const z of [17, 18, 19]) {
      await setView(page, at.lat, at.lng, z);
      await page.waitForTimeout(250);
      await expect(page.locator('.mapview .map-case'), `${n} at z${z}`).toHaveCount(n);
      await expect(page.locator('.mapview .map-cluster')).toHaveCount(0);
      await expect(legs(page)).toHaveCount(n);
      await expect(spot(page)).toHaveCount(1);
      const tips = await pinTips(page), c = await pagePoint(page, at.lat, at.lng);
      expect(tips.map((t) => t.id).sort()).toEqual(ids);
      for (const [i, a] of tips.entries()) {
        expect(Math.hypot(a.x - c.x, a.y - c.y), `${a.id} is off the spot`).toBeGreaterThanOrEqual(20);
        for (const b of tips.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id}–${b.id} at z${z}`).toBeGreaterThanOrEqual(26);
      }
      // The dot marks the true spot; each leg runs from it to one pin's tip.
      const d = (await spot(page).boundingBox())!;
      expect([d.x + d.width / 2, d.y + d.height / 2].map((v, k) => near(v, k ? c.y : c.x))).toEqual([true, true]);
      const ends = await legs(page).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }));
      for (const tip of tips) {
        expect(ends.some((e) => near(e.l, Math.min(tip.x, c.x)) && near(e.r, Math.max(tip.x, c.x)) && near(e.t, Math.min(tip.y, c.y)) && near(e.b, Math.max(tip.y, c.y))), `a leg to ${tip.id}`).toBe(true);
      }
      if (n === 2) expect(Math.abs(tips[0].y - tips[1].y)).toBeLessThanOrEqual(5); // a pair sits side by side
    }
  }
  // The same pins as singles: type glyph, open / closed, data-id (the pair: an open pothole, a closed tree).
  await setView(page, PAIR.lat, PAIR.lng, 18);
  await expect(page.locator('.map-case[data-id="p1"] svg')).toHaveAttribute('data-group', 'streets');
  await expect(page.locator('.map-case[data-id="p1"]')).not.toHaveClass(/map-pin--closed/);
  await expect(page.locator('.map-case[data-id="p2"] svg')).toHaveAttribute('data-group', 'trees');
  await expect(page.locator('.map-case[data-id="p2"]')).toHaveClass(/map-pin--closed/);
  // A pan keeps the very nodes (the keys are the cases, not the view).
  await setView(page, STACK.lat, STACK.lng, 18);
  await expect(page.locator('.mapview .map-case')).toHaveCount(6);
  await page.waitForTimeout(400);
  await page.locator('.mapview .map-case').evaluateAll((els) => els.forEach((el) => el.setAttribute('data-mark', '1')));
  await userPan(page, 30, 20);
  await page.waitForTimeout(400);
  await expect(page.locator('.mapview .map-case[data-mark="1"]')).toHaveCount(6);
  await expect(legs(page)).toHaveCount(6);
  // z16: one disc again — no pins, legs or dot left; back at z17, exactly one fan (nothing leaked from the last).
  await setView(page, STACK.lat, STACK.lng, 16);
  await expect(page.locator('.map-cluster', { hasText: /^6$/ })).toHaveCount(1);
  await expect(page.locator('.mapview .map-case')).toHaveCount(0);
  await expect(legs(page)).toHaveCount(0);
  await expect(spot(page)).toHaveCount(0);
  await setView(page, STACK.lat, STACK.lng, 17);
  await expect(page.locator('.mapview .map-case')).toHaveCount(6);
  await expect(legs(page)).toHaveCount(6);
  await expect(spot(page)).toHaveCount(1);
  await expect(page.locator('.map-cluster')).toHaveCount(0);
  // Revealed by a user zoom, they drop in like any pin — never under reduced motion.
  await expect(page.locator('.mapview .map-case.map-pin--drop')).toHaveCount(6);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/street');
  await waitForMap(page);
  await expect(page.locator('.map-cluster').first()).toBeVisible();
  await page.waitForTimeout(700); // the landing's PEEK refit is done before we move the map
  await setView(page, STACK.lat, STACK.lng, 16);
  await expect(page.locator('.map-cluster', { hasText: /^6$/ })).toHaveCount(1);
  await setView(page, STACK.lat, STACK.lng, 17);
  await expect(page.locator('.mapview .map-case')).toHaveCount(6);
  await expect(page.locator('.mapview .map-pin--drop')).toHaveCount(0);
});

/** Start a zoom on the map (`start`, a function of it) and watch every frame until zoomend: how many frames the map pane
 *  animated, and in those the legs drawn (not hidden) that do not end at a pin's tip and the dots drawn at another size
 *  than their own (7 px across). Pin tips as in pinTips. */
const zoomFrames = (page: Page, start: string) => page.evaluate(`(async () => {
  const m = window.__streetMap, pane = m.getPane('mapPane'), near = (a, b) => Math.abs(a - b) <= 2;
  let done = false, frames = 0; const off = [];
  m.once('zoomend', () => { done = true; });
  (${start})(m);
  for (const t0 = performance.now(); !done && performance.now() - t0 < 2000;) {
    await new Promise((r) => requestAnimationFrame(r));
    if (!pane.classList.contains('leaflet-zoom-anim')) continue;
    frames++;
    const tips = [...document.querySelectorAll('.mapview .map-case')].map((el) => {
      const r = el.getBoundingClientRect(), closed = el.classList.contains('map-pin--closed');
      return { x: r.x + (closed ? 11 : 13), y: r.y + (closed ? 26 : 31) };
    });
    for (const el of document.querySelectorAll('.mapview path.map-leg, .mapview path.map-spot')) {
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (el.classList.contains('map-spot')) { if (!near(r.width, 7)) off.push('dot ' + r.width.toFixed(1) + ' px'); continue; }
      const corners = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];
      if (!tips.some((t) => corners.some(([x, y]) => near(x, t.x) && near(y, t.y)))) off.push('leg ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
    }
  }
  return { frames, off, done };
})()`) as Promise<{ frames: number; off: string[]; done: boolean }>;

test('an animated zoom keeps a fan together: while the map animates no leg is drawn past its pin or short of it and the dot keeps its size (one level out, one in, the Zoom-out pill\'s two, a pinch let go mid-level); once it settles each leg ends at its pin\'s tip', async ({ page }) => {
  await landing(page);
  await page.waitForTimeout(700); // the landing's PEEK refit is done
  const legsAtTips = async () => {
    const tips = await pinTips(page), c = await pagePoint(page, STACK.lat, STACK.lng);
    const near = (a: number, b: number) => Math.abs(a - b) <= 2;
    const ends = await legs(page).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, shown: getComputedStyle(el).visibility !== 'hidden' }; }));
    expect(ends.every((e) => e.shown)).toBe(true);
    for (const tip of tips) {
      expect(ends.some((e) => near(e.l, Math.min(tip.x, c.x)) && near(e.r, Math.max(tip.x, c.x)) && near(e.t, Math.min(tip.y, c.y)) && near(e.b, Math.max(tip.y, c.y))), `a leg to ${tip.id}`).toBe(true);
    }
  };
  const runs: [number, string, number][] = [
    [18, 'm => m.setZoom(17)', 17],
    [17, 'm => m.setZoom(18)', 18],
    [19, 'm => m.setZoom(17)', 17],
    // a pinch: Leaflet's touch zoom moves the map to a fractional zoom, then on release animates to the snapped one
    [18, 'm => { const c = m.getCenter(); m._moveStart(true, false); m._move(c, 17.4, { pinch: true, round: false }); m._animateZoom(c, 17, true, 1); }', 17],
  ];
  for (const [from, start, to] of runs) {
    await setView(page, STACK.lat, STACK.lng, from);
    await expect(legs(page)).toHaveCount(6);
    await page.waitForTimeout(300);
    const r = await zoomFrames(page, start);
    expect(r.done, `${start} ended`).toBe(true);
    expect(r.frames, `${start} animated`).toBeGreaterThanOrEqual(3);
    expect(r.off, `${start}: z${from} → ${to}`).toEqual([]);
    await expect.poll(() => zoomOf(page)).toBe(to);
    await page.waitForTimeout(300);
    await expect(page.locator('.mapview .map-case')).toHaveCount(6);
    await legsAtTips();
  }
});

test('a fanned pin is a case pin: a tap at PEEK shows that case\'s card; behind it the pin is selected and on top, the stack still fanned, the sheet at PEEK and the map where it was; the card opens its page', async ({ page }) => {
  await landing(page, { details: { s3: detailFor(STACK_CASES[2]) } });
  await page.waitForTimeout(700); // the landing's PEEK refit is done
  await setView(page, STACK.lat, STACK.lng, 18);
  await expect(mainPins(page)).toHaveCount(6);
  await page.waitForTimeout(500); // the drop-in is over
  const before = await viewOf(page);
  const tip = (await pinTips(page)).find((t) => t.id === 's3')!;
  await page.mouse.click(tip.x, tip.y - 14);
  const card = preview(page);
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute('data-id', 's3');
  await expect(card.locator('.street-type')).toHaveText('Street Light Out');
  await expect(casePage(page)).toHaveCount(0);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  const pin = page.locator('.street-stage .map-case[data-id="s3"]');
  await expect(pin).toHaveClass(/map-pin--selected/);
  await expect(selPin(page)).toHaveCount(1);
  await expect(mainPins(page)).toHaveCount(6); // still fanned
  const z = (l: ReturnType<Page['locator']>) => l.evaluate((el) => Number(getComputedStyle(el).zIndex));
  for (const id of ['s1', 's2', 's4', 's5', 's6']) expect(await z(pin)).toBeGreaterThan(await z(page.locator(`.street-stage .map-case[data-id="${id}"]`)));
  const pb = (await pin.boundingBox())!;
  expect(pb.y + pb.height).toBeLessThan((await card.boundingBox())!.y);
  await page.waitForTimeout(600);
  await expect(page).not.toHaveURL(/[?&]case=/);
  expectSameView(await viewOf(page), before);
  await cardFace(page).click();
  await expect(page).toHaveURL(/[?&]case=s3/);
  await expect(caseDialog(page, 'Street Light Out')).toBeFocused();
  await expect(pin).toHaveClass(/map-pin--selected/);
  await backMap(page).click();
  await expect(casePage(page)).toHaveCount(0);
  await expect(cardFace(page)).toBeFocused();
  await expect(mainPins(page)).toHaveCount(6);
  expectSameView(await viewOf(page), before);
});

test('selection never moves the map (the case page covers it): a row tap with its fanned pin under the rail, and one while its stack is still a disc, leave the view exactly as it was — closing finds it there', async ({ page }) => {
  await landing(page, { details: { s3: detailFor(STACK_CASES[2]) } });
  await page.waitForTimeout(700); // the landing's PEEK refit is done
  await setView(page, STACK.lat, STACK.lng, 18);
  await grab(page).click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(mainPins(page)).toHaveCount(6);
  /** Pan so the shared spot sits `y` page px down (panBy moves the view, so the map content moves the other way). */
  const spotAt = async (y: number) => {
    const c = await pagePoint(page, STACK.lat, STACK.lng);
    await mapEval<void>(page, `m => { m.panBy([0, ${c.y - y}], { animate: false }); }`);
    await page.waitForTimeout(400);
  };
  // The shared spot 20 px under the rail: s3's slot (up and left) is then under the rail itself.
  const rail = await box(page, FILTER_ROW);
  await spotAt(rail.y + rail.height + 20);
  expect((await pinTips(page)).find((t) => t.id === 's3')!.y).toBeLessThan(rail.y + rail.height);
  const before = await viewOf(page);
  await page.locator('.street-row-btn[data-id="s3"]').click();
  await expect(casePage(page)).toBeFocused();
  await expect(page.locator('.street-stage .map-case[data-id="s3"]')).toHaveClass(/map-pin--selected/);
  await page.waitForTimeout(700);
  expectSameView(await viewOf(page), before);
  await backMap(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await page.waitForTimeout(400);
  expectSameView(await viewOf(page), before);
  // At z16 the stack is a disc: the row tap marks the disc and still moves nothing (no zoom to 17).
  await setView(page, STACK.lat, STACK.lng, 16);
  const sh0 = await box(page, '.street-sheet');
  await spotAt((rail.y + rail.height + sh0.y) / 2);
  await expect(page.locator('.map-cluster', { hasText: /^6$/ })).toHaveCount(1);
  const before2 = await viewOf(page);
  // The in-view list re-renders for a moment after the pan; a tap on the row it is replacing is lost — tap until it opens.
  await expect(async () => {
    if (await casePage(page).count()) return; // opened by the previous attempt (slow to show under load)
    await page.locator('.street-row-btn[data-id="s3"]').click({ timeout: 2000 });
    await expect(casePage(page)).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 12000 });
  await expect(casePage(page)).toBeFocused();
  await expect(page.locator('.map-cluster--selected')).toHaveCount(1);
  await page.waitForTimeout(700);
  expectSameView(await viewOf(page), before2);
  await page.keyboard.press('Escape');
  await expect(casePage(page)).toHaveCount(0);
  await expect(page.locator('.map-cluster--selected')).toHaveCount(0);
  expectSameView(await viewOf(page), before2);
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
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek'); // the whole city is the PEEK band's view
  await expect.poll(() => zoomOf(page)).toBe(await mapEval<number>(page, 'm => m.getMinZoom()'));
  await expect(title(page)).toHaveText('Providence');
  await expect(page).not.toHaveURL(/[?&][cz]=/);
});

test('neighborhoods: a ?n= link (/week\'s neighborhood rows) opens at PEEK, draws the outline and fits it between the filter rows and the sheet, keeps n= (its own fit is not a pan), titles the sheet, and counts and lists only the cases inside it; a pan clears it; the title follows the map centre', async ({ page }) => {
  await setup(page);
  await page.goto('/street?n=fox-point');
  await waitForMap(page);
  await expect(page.locator('.map-hood')).toHaveCount(1);
  await expect(title(page)).toHaveText('Fox Point');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek'); // HALF would leave a ~95 px strip under the filter rows
  await expect.poll(() => zoomOf(page)).toBeGreaterThanOrEqual(13); // was 12 at HALF
  // The whole outline sits between the filter rows and the PEEK sheet, and is not a sliver.
  await expect.poll(async () => {
    const [hood, stage, sh] = await Promise.all(['.map-hood', '.street-stage', '.street-sheet'].map((sel) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().toJSON())));
    return hood.top >= stage.top + 162 - 1 && hood.bottom <= sh.top + 1 && hood.height >= 100; // HALF made it ~70 px
  }).toBe(true);
  await page.waitForTimeout(1200);
  await expect(page).toHaveURL(/[?&]n=fox-point/); // the link's own fit never counts as a pan
  // "N in Fox Point": the count and the list are the cases inside the outline, not the box the map shows.
  await expect(sub(page)).toHaveText(/^\d+ in Fox Point · \d+ open · \d+ closed$/);
  await expect(page.locator('.street-body .street-h').first()).toHaveText('Fox Point');
  const texts = await rows(page).allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.every((t) => t.includes('Fox Point'))).toBe(true);
  const n = Number(/^(\d+)/.exec((await sub(page).textContent())!)![1]);
  const more = page.locator('.street-more');
  expect(texts.length + ((await more.count()) ? Number(/(\d+)/.exec((await more.textContent())!)![1]) : 0)).toBe(n);
  await expect(page.getByLabel('Jump to a neighborhood…')).toHaveCount(0);
  await page.goto('/street?n=elmhurst');
  await waitForMap(page);
  await expect(title(page)).toHaveText('Elmhurst');
  await expect(page.locator('.map-hood')).toHaveCount(1);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await userPan(page, 240, 0);
  await expect(page).not.toHaveURL(/[?&]n=/);
  await expect(page.locator('.map-hood')).toHaveCount(0);
  await setView(page, 41.8268, -71.4025, 15);
  await expect(title(page)).toHaveText('College Hill');
});

test('a case link framed by a view (c/z — /week, the follow mail, /my): its page names the neighborhood, never "From where you are", and Report brings the place along', async ({ page }) => {
  await setup(page);
  await page.goto('/street?case=c1&c=41.8286,-71.4005&z=17');
  await waitForMap(page);
  const dlg = caseDialog(page, 'Pothole');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.case-stat[data-stat="hood"]')).toHaveText(/^Neighborhood\s*College Hill$/);
  await expect(dlg.locator('.case-stat[data-stat="from"]')).toHaveCount(0);
  await expect(page.locator('.map-home')).toHaveCount(0);
  await expect(dlg.locator('.case-report a')).toHaveAttribute('href', '/?lat=41.82856&lng=-71.40050&q=10+Angell+St');
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

test('saved places: signed in, the "Your streets" chip in the peek sheet jumps the map and sets q', async ({ page }) => {
  await landing(page, { signedIn: true, me: { addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: PT.lat, lng: PT.lng }] } });
  const places = page.locator('.street-places');
  await expect(places).toContainText('Your streets');
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

test('your streets this week: signed in, a card above the week link with a row per saved address that has coordinates — 7-day counts within 300 m from the loaded feed, "nothing new" for a quiet place, no extra request; a row tap opens the address view', async ({ page }) => {
  const calls = await landing(page, { items: [...DEFAULT_ITEMS, ...WORK_CASES], signedIn: true, me: { addresses: PLACES } });
  await grab(page).click();
  const card = page.locator('.street-places-card');
  await expect(card.getByRole('heading', { name: 'Your streets this week' })).toBeVisible();
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
  // The header's "Your streets" chips stay (all four; the thumb-zone shortcut).
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

test('your streets this week: no card when signed out', async ({ page }) => {
  await landing(page);
  await grab(page).click();
  await expect(page.locator('a.street-week-link')).toBeVisible();
  await expect(page.locator('.street-places-card')).toHaveCount(0);
});

test('your streets this week: no card when no saved address has coordinates (the chip still offers the geocode), Spanish singulars', async ({ page }) => {
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
  await expect(card.getByRole('heading', { name: 'Tus calles esta semana' })).toBeVisible();
  await expect(card.locator('.street-place-n')).toHaveText(['1 nueva · 1 cerrada', 'nada nuevo']);
});

// ── The address view's one subscription control (components/StreetDigestCard): a switch + "Manage" ──
const digestSwitch = (page: Page) => page.getByRole('switch', { name: 'Email me Mondays about this street' });
const HOME = { id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: PT.lat, lng: PT.lng };
const puts = (calls: { method: string; body: unknown }[]) => calls.filter((c) => c.method === 'PUT').map((c) => c.body);

test('digest, signed out: the address view offers sign-in back to this exact URL; the case page has no digest control', async ({ page }) => {
  await point(page);
  const link = page.locator('.street-digest a.btn');
  await expect(link).toHaveText('Sign in to get the weekly email');
  expect(decodeURIComponent((await link.getAttribute('href'))!)).toBe(`/account?returnTo=${POINT}`);
  await expect(digestSwitch(page)).toHaveCount(0);
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  await expect(caseDialog(page, 'Pothole')).toBeVisible();
  await expect(casePage(page).locator('.street-digest')).toHaveCount(0);
});

test('digest, signed in: one switch and "Manage" (→ Account → Updates); on saves this point as a street with its Monday email on, off turns it off and keeps it saved — never a prefs PATCH', async ({ page }) => {
  const calls = await point(page, { signedIn: true });
  const card = page.locator('.street-digest');
  const sw = digestSwitch(page);
  await expect(sw).toBeEnabled();
  await expect(sw).not.toBeChecked();
  await expect(card.getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/account/updates');
  expect((await card.locator('.switch-row').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // The one control: no button, no phone row, no type chips.
  await expect(card.getByRole('switch')).toHaveCount(1);
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(page.locator('.push-card, .watch-row, .watch-groups')).toHaveCount(0);
  await sw.click();
  await expect(sw).toBeChecked();
  await expect.poll(() => puts(calls)).toEqual([{ label: '481 Angell St', address: '481 Angell St', lat: 41.8282, lng: -71.4005, digest: true }]);
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(() => puts(calls)).toHaveLength(2);
  expect(puts(calls)[1]).toEqual({ id: 'n1', label: '481 Angell St', address: '481 Angell St', lat: 41.8282, lng: -71.4005, digest: false });
  expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
});

test('digest, signed in with this street saved: the switch reads its own flag; a tap sends that saved address back whole with the flag flipped', async ({ page }) => {
  const calls = await point(page, { signedIn: true, me: { addresses: [{ ...HOME, digest: true }] } });
  await expect(digestSwitch(page)).toBeChecked();
  await digestSwitch(page).click();
  await expect(digestSwitch(page)).not.toBeChecked();
  await expect.poll(() => puts(calls)).toEqual([{ ...HOME, digest: false }]);
  await digestSwitch(page).click();
  await expect(digestSwitch(page)).toBeChecked();
  await expect.poll(() => puts(calls)).toEqual([{ ...HOME, digest: false }, { ...HOME, digest: true }]);
});

test('digest: a failed save puts the switch back and says so', async ({ page }) => {
  await point(page, { signedIn: true, addressStatus: 500 });
  await digestSwitch(page).click();
  await expect(page.locator('.street-digest [role="alert"]')).toHaveText("Couldn't save that. Try again.");
  await expect(digestSwitch(page)).not.toBeChecked();
});

test('follow, signed out: the top bar\'s Follow is a sign-in link (named for it) that returns to this exact URL; no toggle', async ({ page }) => {
  const calls = await setup(page);
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  const card = casePage(page);
  const link = card.locator('.case-bar a.street-follow-signin');
  await expect(link).toHaveText('Follow');
  await expect(link).toHaveAccessibleName('Sign in to follow this request');
  expect(decodeURIComponent((await link.getAttribute('href'))!)).toBe(`/account?returnTo=${POINT}&case=c1`);
  await expect(card.locator('.street-follow-btn')).toHaveCount(0);
  await expect(card.locator('.case-follow-notes')).toBeEmpty();
  expect(calls.filter((c) => c.url.includes('/api/me'))).toEqual([]);
});

test('follow, signed out from a typed search: the returnTo keeps the `+` URL and sign-in lands on the case page', async ({ page }) => {
  await landing(page);
  await page.locator('.street-pill-input').fill('481 angell');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050&q=481\+Angell\+St/);
  await page.locator('.street-row-btn[data-id="c1"]').click();
  // The geocoder's full label: spaces as `+`, commas as `%2C` — both must pass takeReturnTo's allowlist.
  const here = '/street?lat=41.82820&lng=-71.40050&q=481+Angell+St%2C+Providence%2C+Rhode+Island%2C+02906&case=c1';
  await expect(page).toHaveURL(here);
  const href = (await page.locator('.case-page a.street-follow-signin').getAttribute('href'))!;
  expect(decodeURIComponent(href)).toBe(`/account?returnTo=${here}`);
  // Already signed in and sent to /account with that returnTo (what the sign-in flow does) → straight back to the page.
  await page.evaluate((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.goto(href);
  await expect(page).toHaveURL(here);
  await expect(caseDialog(page, 'Pothole')).toBeVisible();
});

test('follow, signed in: Follow → PUT /api/me/city/:id, the toggle pressed ("✓ Following") and the promise under the title; a tap on it → DELETE; an already-followed case opens pressed', async ({ page }) => {
  const calls = await point(page, { signedIn: true, me: { cityFollowing: ['c2'] } });
  const forCase = (id: string) => calls.filter((c) => c.url.endsWith(`/api/me/city/${id}`)).map((c) => c.method);
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = casePage(page);
  const toggle = card.locator('.case-bar .street-follow-btn');
  await expect(toggle).toHaveText('Follow');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(card.locator('.street-follow-note')).toHaveCount(0);
  const tb = (await toggle.boundingBox())!;
  expect(tb.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText(/^✓\s*Following$/);
  await expect(card.locator('.case-head .street-follow-note')).toHaveText("We'll email you when the city updates it.");
  await expect.poll(() => forCase('c1')).toEqual(['PUT']);
  // The bar still fits: nothing in it wraps or runs off the screen.
  const bar = (await card.locator('.case-bar').boundingBox())!;
  expect(bar.height).toBeLessThanOrEqual(64);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('Follow');
  await expect(card.locator('.street-follow-note')).toHaveCount(0);
  await expect.poll(() => forCase('c1')).toEqual(['PUT', 'DELETE']);
  // c2 was followed before the page loaded (users.cityFollowing): pressed on open; the pressed toggle unfollows.
  await backMap(page).click();
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await expect(caseDialog(page, 'Street Light Out')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => forCase('c2')).toEqual(['DELETE']);
  // Subscriptions live in Account → Updates: no digest card and no phone row on the case page.
  await expect(card.locator('.street-digest, .push-card')).toHaveCount(0);
});

test('follow, signed in: a failed PUT reverts the toggle and says so under the title', async ({ page }) => {
  const calls = await point(page, { signedIn: true, followStatus: () => 500 });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = casePage(page);
  const toggle = card.locator('.street-follow-btn');
  await toggle.click();
  await expect(card.locator('.case-head .street-follow-error')).toHaveText("Couldn't save that. Try again.");
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveText('Follow');
  expect(calls.filter((c) => c.url.includes('/api/me/city/')).map((c) => c.method)).toEqual(['PUT']);
  // Another case: the error line does not follow it.
  await backMap(page).click();
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(caseDialog(page, 'Overflowing Dumpster')).toBeVisible();
  await expect(card.locator('.street-follow-error')).toHaveCount(0);
});

test('follow, in flight: the toggle stays enabled (aria-busy), keeps focus, and a second tap is ignored', async ({ page }) => {
  const calls = await point(page, { signedIn: true, followDelayMs: 700 });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const toggle = page.locator('.case-page .street-follow-btn');
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
  // Escape still closes the page from the toggle.
  await toggle.press('Escape');
  await expect(page).not.toHaveURL(/[?&]case=/);
});

test('follow, account not loaded: the toggle reads off (aria-disabled) with "Loading your account…"; a failed load says so and a tap retries', async ({ page }) => {
  await point(page, { signedIn: true, meDelayMs: 6000 });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = casePage(page);
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

test('follow, when no mail would come: email updates off or an unverified address → "Following" without the promise, and a hint under the title that links to Account', async ({ page }) => {
  await point(page, { signedIn: true, me: { cityFollowing: ['c1'], prefs: { emailUpdates: false } } });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = casePage(page);
  const toggle = card.locator('.street-follow-btn');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveText(/^✓?\s*Following$/);
  const hint = card.locator('.street-follow-hint');
  await expect(hint).toHaveText("Email updates are off for your account, so you won't hear about changes. Fix this in Account");
  await expect(hint.getByRole('link', { name: 'Fix this in Account' })).toHaveAttribute('href', '/account/updates');
  await expect(card.locator('.street-follow-note')).toHaveCount(0);

  await point(page, { signedIn: true, me: { cityFollowing: ['c1'], emailVerified: false } });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(toggle).toHaveText(/Following$/);
  await expect(card.locator('.street-follow-hint')).toContainText('Verify your email to hear about changes.');
  // Not following: no hint at all.
  await backMap(page).click();
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(toggle).toHaveText('Follow');
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
  // The filters stay named and focusable but inert: Show's radios aria-disabled (counts "—"), the selects disabled.
  await expect(radio(page, /^Open$/)).toHaveAttribute('aria-disabled', 'true');
  await expect(radio(page, /^All$/)).toBeChecked();
  await expect(page.locator('.street-seg-n')).toHaveText(['—', '—', '—']);
  await expect(whenSel(page)).toBeDisabled();
  await expect(typeBtn(page)).toBeDisabled();
  await expect(typeBtn(page)).toHaveText('All types · —');
  fail = false;
  await err.getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(3);
  expect(mapCalls(calls).length).toBe(2);

  await page.goto(POINT);
  await waitForMap(page);
  await expect(rows(page)).toHaveCount(3);
  fail = true;
  await whenSel(page).selectOption('90');
  await expect(page.locator('.street-extra')).toContainText('Showing the list from');
  await expect(rows(page)).toHaveCount(3);
});

test('share: with navigator.share absent the URL lands on the clipboard and the live region says so — the sheet\'s, or the case page\'s own (the sheet is inert behind it)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s: string) => { (window as unknown as { __copied: string }).__copied = s; return Promise.resolve(); } }, configurable: true });
  });
  await point(page);
  await page.locator('.street-head-actions').getByRole('button', { name: 'Share' }).click();
  await expect(sub(page)).toHaveText('Link copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toContain('/street?lat=41.82820&lng=-71.40050&q=481+Angell+St');
  await expect(sub(page)).toHaveText('3 in view · 2 open · 1 closed', { timeout: 5000 });
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await casePage(page).getByRole('button', { name: 'Share' }).click();
  await expect(casePage(page).locator('.case-flash')).toHaveText('Link copied');
  await expect(casePage(page).locator('.case-flash')).toHaveAttribute('role', 'status');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toMatch(/\/street\?lat=41\.82820&lng=-71\.40050&q=481\+Angell\+St.*&case=c2/);
  await expect(sub(page)).toHaveText('3 in view · 2 open · 1 closed');
  await expect(casePage(page).locator('.case-flash')).toHaveText('', { timeout: 5000 });
});

test('history: Back to map from a deep-linked case never leaves the app, even after a pan or a filter change before it was opened; from a deep link that went on to a nearby case it closes both and removes the first case= in place', async ({ page }) => {
  // An external link (digest mail, share) with case=: the entry is not ours. Back to map removes the param in place.
  await setup(page);
  await page.goto(`${POINT}&case=c2`);
  await waitForMap(page);
  await expect(caseDialog(page, 'Street Light Out')).toBeVisible();
  await backMap(page).click();
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050&q=481/);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(rows(page).first()).toBeVisible();
  await expect(grab(page)).toBeFocused(); // no opener on this page: the sheet's grabber
  // The param was removed in place (no history entry to go forward to), not popped off into whatever came before the link.
  await page.goForward();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(casePage(page)).toHaveCount(0);
  // Pan and filter, then a row: Back to map pops just that entry, the pan and the filter stay.
  await userPan(page, 120, 0);
  await page.waitForTimeout(500);
  await radio(page, /^Open, /).click();
  await expect(page).toHaveURL(/[?&]s=open/);
  await expect(page).toHaveURL(/[?&]c=/);
  const here = page.url();
  await rows(page).first().click();
  await expect(casePage(page)).toBeFocused();
  await backMap(page).click();
  await expect(casePage(page)).toHaveCount(0);
  expect(page.url()).toBe(here);

  // Deep link with case=c1, then its nearby c2 (a pushed entry): Back to map shows the list, not c1's page again —
  // c1's entry loses its case= in place, and c2's entry is still there going forward.
  await page.goto(`${POINT}&case=c1`);
  await waitForMap(page);
  await expect(caseDialog(page, 'Pothole')).toBeVisible();
  await casePage(page).locator('.case-nearby .street-row-btn[data-id="c2"]').click();
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(caseDialog(page, 'Street Light Out')).toBeFocused();
  await backMap(page).click();
  await expect(casePage(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page).toHaveURL(/\/street\?lat=41\.82820&lng=-71\.40050&q=481/);
  await expect(rows(page).first()).toBeVisible();
  await page.waitForTimeout(300);
  await expect(casePage(page)).toHaveCount(0); // stays closed (nothing reopens c1 behind the scenes)
  await page.goForward();
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(caseDialog(page, 'Street Light Out')).toBeVisible();
  // …and the browser Back from it is c1's entry, now without its case=.
  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(casePage(page)).toHaveCount(0);
});

test('a shared c/z view with case= keeps the sender\'s framing; a point with case= stays at z16', async ({ page }) => {
  await setup(page);
  await page.goto('/street?c=41.8450,-71.4450&z=14&case=c2');
  await waitForMap(page);
  await expect(caseDialog(page, 'Street Light Out')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await zoomOf(page)).toBe(14);
  const c = await mapEval<{ lat: number; lng: number }>(page, 'm => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; }');
  expect(Math.abs(c.lat - 41.845)).toBeLessThan(0.002);
  expect(Math.abs(c.lng + 71.445)).toBeLessThan(0.002);
  await expect(page).toHaveURL(/[?&]c=41\.8450,-71\.4450&z=14/);
  await page.goto(`${POINT}&case=c2`);
  await waitForMap(page);
  await expect(caseDialog(page, 'Street Light Out')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await zoomOf(page)).toBe(16);
  await expect(selPin(page)).toHaveCount(1);
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
    const a = (await attr.boundingBox())!, sh = (await sheet(page).boundingBox())!, rail = (await page.locator(FILTER_ROW).boundingBox())!;
    expect(a.y + a.height).toBeLessThanOrEqual(sh.y);
    expect(a.y).toBeGreaterThanOrEqual(rail.y + rail.height);
    await expect(attr.getByRole('link', { name: 'OpenStreetMap' })).toBeVisible();
    expect(await hit()).toMatch(/leaflet-control-attribution|^A\./);
  }
  // The control's box is pointer-transparent (only its links take taps): a pin drawn through it still opens.
  expect(await attr.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  expect(await attr.locator('a').first().evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto');
});

/** The view's edges, and where a latitude line sits on the page (map container top + container y). */
const edges = (page: Page) => mapEval<{ n: number; s: number; e: number; w: number; z: number }>(page, 'm => { const b = m.getBounds(); return { n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest(), z: m.getZoom() }; }');
const pageY = (page: Page, lat: number, lng: number) => mapEval<number>(page, `m => m.getContainer().getBoundingClientRect().top + m.latLngToContainerPoint([${lat}, ${lng}]).y`);

test('the map stays on Providence: zoom out stops where the whole city fits; a jump or a pan far away stops ~1 km past the line — further south only by the sheet, so the southern edge still clears it', async ({ page }) => {
  await landing(page);
  // The landing is the furthest out: the whole city between the rail and the PEEK sheet (390×514 map → z11).
  const landingZ = await zoomOf(page);
  expect(landingZ).toBe(11);
  expect(await mapEval<number>(page, 'm => m.getMinZoom()')).toBe(landingZ);
  await mapEval<void>(page, 'm => m.setZoom(4, { animate: false })');
  await expect.poll(() => zoomOf(page)).toBe(landingZ);
  // …once the PEEK sheet has settled: the whole city between the filter rows and the sheet — the band is a few pixels
  // shorter than the city at z11 and the floor is never more than one step below the whole-map fit (z12), so its
  // edges may sit a few pixels under the chrome, never more.
  const peekTop = (await sheet(page).boundingBox())!.y;
  const railBottom0 = await page.locator(FILTER_ROW).evaluate((el) => el.getBoundingClientRect().bottom);
  await expect.poll(() => pageY(page, 41.772, -71.42)).toBeLessThanOrEqual(peekTop + 12);
  expect(await pageY(page, 41.871, -71.42)).toBeGreaterThanOrEqual(railBottom0 - 12);

  // Newport (south-east): the view stops at the corner — east edge at maxLng + 0.01°.
  await setView(page, 41.49, -71.31, 15);
  let v = await edges(page);
  expect(v.z).toBe(15);
  expect(v.e).toBeCloseTo(-71.36, 3);
  // The south limit is the margin line (41.762) dropped by the sheet's height + a pin head: that line sits exactly
  // a pin head above the sheet, and the city's southern line clears it.
  // Polled: the sheet may still be settling (its height transition) and the limit follows it a frame later.
  const southGap = async () => Math.abs(await pageY(page, 41.762, -71.42) - ((await sheet(page).boundingBox())!.y - 38));
  await expect.poll(southGap).toBeLessThanOrEqual(2);
  const sheetTop = (await sheet(page).boundingBox())!.y;
  expect(await pageY(page, 41.772, -71.42)).toBeLessThan(sheetTop - 16);

  // Woonsocket (north-west): west edge at minLng − 0.01°, the northern line clear of the search rail.
  await setView(page, 42.0, -71.51, 15);
  v = await edges(page);
  expect(v.w).toBeCloseTo(-71.483, 3);
  const railBottom = await page.locator(FILTER_ROW).evaluate((el) => el.getBoundingClientRect().bottom);
  await expect.poll(async () => Math.abs(await pageY(page, 41.881, -71.48) - (railBottom + 38))).toBeLessThanOrEqual(2); // margin line + rail + pin head
  expect(await pageY(page, 41.871, -71.42)).toBeGreaterThan(railBottom);

  // A user pan 5000 px east from the middle of the city is pulled back to the same line — also after a cluster flight
  // (Leaflet leaves its flight marker set once a flyTo ends; the correction must not take that for a flight in progress).
  await mapEval<void>(page, 'm => m.flyTo([41.82, -71.41], 14, { duration: 0.2 })');
  await page.waitForTimeout(600);
  await setView(page, 41.824, -71.41, 15);
  await userPan(page, 5000, 0);
  await expect.poll(async () => (await edges(page)).e).toBeCloseTo(-71.36, 3);
});

test('the map stays on Providence: a saved place outside the city is refused like a typed one (the map could not go there)', async ({ page }) => {
  await landing(page, { signedIn: true, me: { addresses: [{ id: 'a9', label: 'Cousin', address: '1 Main St, Pawtucket', lat: 41.878, lng: -71.383 }] } });
  await page.locator('.street-places').getByRole('button', { name: 'Cousin' }).click();
  await expect(page.getByText("That's outside Providence — the city's 311 only covers the city.")).toBeVisible();
  await expect(page).not.toHaveURL(/lat=/);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  test('a ?n= neighborhood link keeps n= and its outline once fitted — the fit is not taken for a pan (live 2026-10-28)', async ({ page }) => {
    await setup(page);
    await page.goto('/street?n=fox-point');
    await waitForMap(page);
    await expect(page.locator('.map-hood')).toHaveCount(1);
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/[?&]n=fox-point/);
    await expect(page.locator('.map-hood')).toHaveCount(1);
    await expect(title(page)).toHaveText('Fox Point');
  });

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
    await expect(page.locator(`.street-panel ${FILTER_ROW}`)).toBeVisible();
    await page.goto(POINT);
    await waitForMap(page);
    await expect(rows(page)).toHaveCount(3);
    await rows(page).first().hover();
    await expect(page.locator('.map-pin--hover')).toHaveCount(1);
    await page.screenshot({ path: 'tests/__screenshots__/street-desktop.png' });
  });
  test('a fanned stack beside the panel: each in-view row hovers its own fanned pin', async ({ page }) => {
    await setup(page);
    await page.goto(`/street?c=${STACK.lat},${STACK.lng}&z=18`);
    await waitForMap(page);
    await expect(page.locator('.mapview .map-case')).toHaveCount(6);
    await expect(legs(page)).toHaveCount(6);
    await expect(rows(page)).toHaveCount(6);
    await page.locator('.street-row-btn[data-id="s2"]').hover();
    await expect(page.locator('.map-pin--hover')).toHaveCount(1);
    await expect(page.locator('.mapview .map-case[data-id="s2"]')).toHaveClass(/map-pin--hover/);
    // A fanned pin opens its case page here too, and closing it leaves the fan and the view as they were.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const before = await viewOf(page);
    const tip = (await pinTips(page)).find((t) => t.id === 's4')!;
    await page.mouse.click(tip.x, tip.y - 14);
    await expect(page).toHaveURL(/[?&]case=s4/);
    await expect(caseDialog(page, 'Pothole')).toBeFocused();
    await expect(page.locator('.street-preview')).toHaveCount(0);
    await expect(page.locator('.street-stage .map-case[data-id="s4"]')).toHaveClass(/map-pin--selected/);
    await backMap(page).click();
    await expect(casePage(page)).toHaveCount(0);
    await expect(mainPins(page)).toHaveCount(6);
    expectSameView(await viewOf(page), before);
  });
  test('filters in the panel: three labelled rows — Show, When, Type — label left, control right, lined up; Clear under them only off the defaults; the narrow panel puts the labels above, and no segment overflows (4-digit city counts, Spanish)', async ({ page }) => {
    await point(page);
    const f = page.locator(`.street-panel ${FILTER_ROW}`);
    await expect(f.locator('.street-filter-label')).toHaveText(['Show', 'When', 'Type']);
    await expect(page.locator(`.street-controls`)).toHaveCount(0); // no floating row on desktop
    const layout = () => f.locator('.street-filter').evaluateAll((els) => els.map((el) => {
      const r = (x: Element | null) => { const b = x!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return { label: r(el.querySelector('.street-filter-label')), control: r(el.querySelector('.street-seg, select, .street-type-btn')) };
    }));
    const wide = await layout();
    expect(wide).toHaveLength(3);
    for (const { label, control } of wide) {
      expect(label.x + label.w).toBeLessThanOrEqual(control.x);                                   // label left of its control
      expect(Math.abs(label.y + label.h / 2 - (control.y + control.h / 2))).toBeLessThanOrEqual(2); // on its line
      expect(control.h).toBeCloseTo(44, 0);
      expect(control.x).toBeCloseTo(wide[0].control.x, 0);                                         // the controls line up
      expect(control.w).toBeCloseTo(wide[0].control.w, 0);
    }
    expect(wide[0].control.y + wide[0].control.h).toBeLessThanOrEqual(wide[1].control.y);
    expect(wide[1].control.y + wide[1].control.h).toBeLessThanOrEqual(wide[2].control.y);
    // Selected = filled ink with paper text; the others outlined surface.
    const faceBg = (k: string) => page.locator(`.street-panel .street-seg-opt[data-show="${k}"] .street-seg-face`).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await faceBg('all')).toBe('rgb(22, 33, 58)');
    expect(await faceBg('open')).not.toBe('rgb(22, 33, 58)');
    // Clear: only off the defaults, a small text button under the rows at the right.
    await expect(clearBtn(page)).toHaveCount(0);
    await radio(page, /^Open, 2$/).click();
    await expect(clearBtn(page)).toBeVisible();
    const c = (await clearBtn(page).boundingBox())!, typeRow = wide[2].control;
    expect(c.y).toBeGreaterThanOrEqual(typeRow.y + typeRow.h);
    expect(Math.abs(c.x + c.width - (typeRow.x + typeRow.w))).toBeLessThanOrEqual(2);
    await expect.poll(() => faceBg('open')).toBe('rgb(22, 33, 58)'); // after the .15 s fill transition
    await clearBtn(page).click();
    await expect(clearBtn(page)).toHaveCount(0);
    await expect(radio(page, /^All, 3$/)).toBeChecked();
    // No segment's words or count are cut, at 1280 (440 px panel) and 800 (360 px panel), citywide (4-digit counts), English and Spanish.
    const uncut = () => page.locator('.street-panel .street-seg-face').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight));
    await page.goto('/street');
    await waitForMap(page);
    await expect(radio(page, /^All, 1234$/)).toBeChecked();
    expect(await uncut()).toBe(true);
    const stacked = async () => (await layout()).every(({ label, control }) => label.y + label.h <= control.y + 1);
    const besides = async () => (await layout()).every(({ label, control }) => label.x + label.w <= control.x);
    expect(await besides()).toBe(true);
    await page.setViewportSize({ width: 800, height: 800 });
    await expect.poll(stacked).toBe(true); // labels above their controls in the 360 px panel
    expect(await uncut()).toBe(true);
    await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
    await page.goto('/street');
    await waitForMap(page);
    await expect(f.locator('.street-filter-label')).toHaveText(['Mostrar', 'Cuándo', 'Tipo']);
    await expect(radio(page, /^Todas, 1234$/)).toBeChecked();
    await expect(page.getByRole('button', { name: /^Tipo / })).toHaveText('Todos los tipos · 1234');
    await expect(page.getByLabel('Cuándo', { exact: true })).toHaveValue('30');
    expect(await stacked()).toBe(true);
    expect(await uncut()).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(besides).toBe(true);
    expect(await uncut()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test('filters in the panel with a custom range: From and To under When, in the controls\' column (the labels above them in the narrow panel); the tab order is the order seen; Type\'s dialog opens under its button, right edges lined up, inside the window', async ({ page }) => {
    await point(page, {}, `${POINT}&from=${nyDay(-7)}&to=${nyDay(0)}&g=trash,streets`);
    const f = page.locator(`.street-panel ${FILTER_ROW}`);
    await expect(whenSel(page)).toHaveValue('custom');
    await expect(f.locator('.street-date-label')).toHaveText(['From', 'To']);
    await expect(typeBtn(page)).toHaveText('Trash & recycling +1 · 2');
    const layout = async () => {
      const when = (await whenSel(page).boundingBox())!, type = (await typeBtn(page).boundingBox())!;
      const from = (await f.locator('.street-date').nth(0).boundingBox())!, to = (await f.locator('.street-date').nth(1).boundingBox())!;
      expect(from.y).toBeGreaterThanOrEqual(when.y + when.height);
      expect(from.y + from.height).toBeLessThanOrEqual(type.y);
      expect(to.y).toBeCloseTo(from.y, 0);
      expect(from.x).toBeCloseTo(when.x, 0);
      expect(to.x + to.width).toBeCloseTo(when.x + when.width, 0);
      for (const b of [from, to]) expect(b.height).toBeCloseTo(44, 0);
      return type;
    };
    const type = await layout();
    expect(await f.locator('select, button, input[type="date"]').evaluateAll((els) => els.map((el) => el.className))).toEqual(['street-select', 'street-date-input', 'street-date-input', 'street-select street-type-btn', 'street-clear']);
    await typeBtn(page).click();
    const d = (await typeDlg(page).boundingBox())!;
    expect(d.y).toBeGreaterThanOrEqual(type.y + type.height);
    expect(d.y + d.height).toBeLessThanOrEqual(800);
    expect(d.x + d.width).toBeCloseTo(type.x + type.width, 0);
    await expect(typeBox(page, /^Trash & recycling, 1$/)).toBeChecked();
    await expect(typeBox(page, /^Streets & sidewalks, 1$/)).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(typeBtn(page)).toBeFocused();
    await page.setViewportSize({ width: 800, height: 800 });
    await expect.poll(async () => Math.round((await f.locator('.street-date').first().boundingBox())!.x - (await whenSel(page).boundingBox())!.x)).toBe(0);
    await layout();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test('case page on desktop: a centred dialog min(1100, 100vw − 48) wide over the dimmed map and panel (which keeps its list), the mini-map beside the title block, four tiles in a row; focus trapped; Escape, a backdrop click and Back to map close it and focus returns to the row; the map key still sits in the map\'s corner', async ({ page }) => {
    await setup(page, { details: { c2: detailFor(NEAR[1], { workCompletedDaysAgo: 2 }) } });
    await page.goto(POINT);
    await waitForMap(page);
    await expect.poll(() => zoomOf(page)).toBe(16); // the point's fit has landed
    await page.waitForTimeout(400);
    const before = await viewOf(page);
    const row = page.locator('.street-row-btn[data-id="c2"]');
    await row.click();
    const dlg = caseDialog(page, 'Street Light Out');
    await expect(dlg).toBeFocused();
    const b = (await dlg.boundingBox())!;
    expect(b.width).toBe(1100);
    expect(Math.abs(b.x + b.width / 2 - 640)).toBeLessThanOrEqual(1);
    expect(b.y).toBeGreaterThanOrEqual(24);
    expect(b.y + b.height).toBeLessThanOrEqual(800 - 24 + 1);
    // Behind it: the panel's list and the map, dimmed by the backdrop; the dialog scrolls inside.
    await expect(page.locator('.case-backdrop')).toBeVisible();
    await expect(page.locator('.street-panel .street-title')).toHaveText('481 Angell St');
    await expect(page.locator('.street-panel .street-row-btn')).toHaveCount(3);
    expect(await dlg.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    // Layout: the mini-map left of the title block; the stat row; four tiles on one line; Share with its label.
    const m = (await dlg.locator('.case-map').boundingBox())!, head = (await dlg.locator('.case-head').boundingBox())!;
    expect(m.x + m.width).toBeLessThanOrEqual(head.x);
    expect(Math.abs(m.y - head.y)).toBeLessThan(20);
    const tiles = await dlg.locator('.case-tile').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tiles).toHaveLength(4);
    expect(new Set(tiles).size).toBe(1);
    await expect(dlg.getByRole('button', { name: 'Share' })).toHaveText('Share');
    await expect(dlg.locator('.case-stat')).toHaveText([/^Closed after\s*8 days$/, /^Reported/, /^From 481 Angell St\s*56 m$/]);
    // Focus trap.
    await page.keyboard.press('Shift+Tab');
    await expect(dlg.locator('.case-report a')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(backMap(page)).toBeFocused();
    // Escape → closed, focus on the row, the map untouched.
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(row).toBeFocused();
    expectSameView(await viewOf(page), before);
    // A click on the backdrop (outside the card) closes it; a click inside does not.
    await row.click();
    await expect(dlg).toBeFocused();
    await dlg.locator('.case-stats').click();
    await expect(dlg).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(dlg).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]case=/);
    await expect(row).toBeFocused();
    // Back to map.
    await row.click();
    await backMap(page).click();
    await expect(dlg).toHaveCount(0);
    await expect(row).toBeFocused();
    expectSameView(await viewOf(page), before);
    // A pin beside the panel opens it too; closed, focus is on the map.
    await setView(page, NEAR[1].lat!, NEAR[1].lng!, 17);
    await page.waitForTimeout(400);
    await clickPin(page, NEAR[1].lat!, NEAR[1].lng!);
    await expect(dlg).toBeFocused();
    await expect(page.locator('.street-preview')).toHaveCount(0); // no preview card at ≥ 720 px: the page, straight away
    await backMap(page).click();
    await expect(page.locator('.street-stage .mapview')).toBeFocused();
    // The map key: the map's top-right corner.
    const key = page.getByRole('button', { name: 'Map key', exact: true });
    await expect(key).toHaveText('Map key');
    const k = (await key.boundingBox())!, map = (await page.locator('.street-stage .mapview').boundingBox())!;
    expect(k.x + k.width).toBeLessThanOrEqual(map.x + map.width);
    expect(k.x + k.width).toBeGreaterThan(map.x + map.width - 40);
    expect(k.y).toBeLessThan(map.y + 30);
  });
  test('case page on desktop from a deep link: open on load over the panel; closed, it stays in the app and focus goes to the map', async ({ page }) => {
    await setup(page, { details: { c2: detailFor(NEAR[1]) } });
    await page.goto(`${POINT}&case=c2`);
    await waitForMap(page);
    await expect(caseDialog(page, 'Street Light Out')).toBeFocused();
    await expect(page.locator('.street-panel .street-tl-step')).toHaveCount(0);
    await expect(casePage(page).locator('.street-tl-step')).toHaveCount(4);
    await backMap(page).click();
    await expect(page).not.toHaveURL(/[?&]case=/);
    await expect(page.locator('.street-stage .mapview')).toBeFocused();
    await expect(page.locator('.street-panel .street-row-btn')).toHaveCount(3);
  });
  test('the map stays on Providence: zoom out stops where the whole city fits the map beside the panel, and the − button greys out there', async ({ page }) => {
    await landing(page);
    const min = await mapEval<number>(page, 'm => m.getMinZoom()');
    expect(min).toBe(12); // 1280×800 less the header: z13 needs ~775 px of height
    await mapEval<void>(page, `m => m.setZoom(${min}, { animate: false })`);
    await expect(page.locator('.leaflet-control-zoom-out')).toHaveClass(/leaflet-disabled/);
    await page.locator('.leaflet-control-zoom-out').click({ force: true });
    await page.waitForTimeout(400);
    expect(await zoomOf(page)).toBe(min);
  });

  test('no home-screen nudge at 1280 px, even on a later visit with the prompt on offer', async ({ page }) => {
    await stubInstallPrompt(page);
    await page.addInitScript(() => localStorage.setItem('fixmypvd.street.visits', '4'));
    await landing(page);
    await expect(page.locator('a.street-week-link')).toBeVisible();
    await expect(page.locator('.street-install')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('fixmypvd.street.visits'))).toBe('5');
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
  await expect(page.locator('.street-stage .mapview')).toHaveAttribute('data-basemap', 'raster');
});

/* ── The basemap's two passes (MapView BASEMAP_COARSE / upgradeBasemap, 2026-10-28) ─────────────────────────────────────
 * A cheap pass first (data a zoom coarser, 1× canvases), the full-detail layer once the page has settled: the coarse
 * layer has drawn the view and nothing has loaded and no long task has run for 3 s, then the next idle moment (≤ 2 s).
 * `data-basemap` on the map says which is showing. */
const hasBasemap = () => existsSync(new URL('../public/map/basemap.json', import.meta.url));
const mainMap = (page: Page) => page.locator('.street-stage .mapview');
const tileLayers = (page: Page) => mainMap(page).locator('.leaflet-tile-pane > .leaflet-layer');
/** A drawn tile's canvas buffer width: 256 × the pass's pixel ratio (the iPhone 13 profile is 3×). */
const tileWidth = (page: Page) => mainMap(page).locator('canvas.leaflet-tile-loaded').first().evaluate((c) => (c as HTMLCanvasElement).width);
async function coarsePass(page: Page) {
  await setup(page, { basemap: true });
  await page.goto(POINT);
  await waitForMap(page);
  await expect(mainMap(page)).toHaveAttribute('data-basemap', 'coarse', { timeout: 20_000 });
  await expect(mainMap(page).locator('canvas.leaflet-tile-loaded').first()).toBeAttached({ timeout: 20_000 });
}

test('the basemap draws a coarse pass first; once the page is idle the full-detail layer replaces it — one layer left, the view unmoved', async ({ page }) => {
  test.skip(!hasBasemap(), 'no basemap extract in this build');
  await coarsePass(page);
  const shown = Date.now();
  expect(await tileWidth(page)).toBe(256);
  await expect(tileLayers(page)).toHaveCount(1);
  await expect(mainPins(page).first()).toBeVisible();
  const view = await viewOf(page);
  await expect(mainMap(page)).toHaveAttribute('data-basemap', 'full', { timeout: 15_000 });
  expect(Date.now() - shown).toBeGreaterThan(2_000);
  await expect(tileLayers(page)).toHaveCount(1);
  expect(await tileWidth(page)).toBe(768);
  expectSameView(await viewOf(page), view);
});

test('the full-detail pass never starts while the map moves: due mid-move, it waits for the moveend', async ({ page }) => {
  test.skip(!hasBasemap(), 'no basemap extract in this build');
  test.setTimeout(30_000);
  await coarsePass(page);
  await mapEval(page, "m => { m.fire('movestart'); }");
  await page.waitForTimeout(6_500); // past the 3 s quiet wait and the ≤ 2 s idle wait
  await expect(mainMap(page)).toHaveAttribute('data-basemap', 'coarse');
  await expect(tileLayers(page)).toHaveCount(1);
  await mapEval(page, "m => { m.fire('moveend'); }");
  await expect(mainMap(page)).toHaveAttribute('data-basemap', 'full', { timeout: 10_000 });
  await expect(tileLayers(page)).toHaveCount(1);
});

test('a map unmounted before its full-detail pass gets no layer after map.remove() and reads no more of the archive', async ({ page }) => {
  test.skip(!hasBasemap(), 'no basemap extract in this build');
  test.setTimeout(30_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await coarsePass(page);
  await page.evaluate(() => { const w = window as unknown as { __streetMap?: unknown; __oldMap?: unknown }; w.__oldMap = w.__streetMap; });
  await page.locator('.tabbar').getByRole('link', { name: 'My reports', exact: true }).click();
  await expect(page).toHaveURL(/\/my$/);
  await expect(page.locator('.mapview')).toHaveCount(0);
  // Requests the coarse layer had in flight may still finish; count only from a beat later.
  await page.waitForTimeout(1_000);
  let reads = 0;
  page.on('request', (r) => { if (/\/map\/pvd-\d+\.pmtiles$/.test(r.url())) reads++; });
  await page.waitForTimeout(6_000); // past the moment the full pass was due
  expect(await page.evaluate(() => Object.keys((window as unknown as { __oldMap: { _layers: object } }).__oldMap._layers).length)).toBe(0);
  expect(reads).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

/** The most colours any drawn tile of the main map has (sampled): bare background — what protomaps paints for a tile
 *  whose read failed — is one. */
const tileColours = (page: Page) => mainMap(page).locator('canvas.leaflet-tile-loaded').evaluateAll((cs) => Math.max(0, ...cs.map((c) => {
  const cv = c as HTMLCanvasElement;
  if (!cv.width || !cv.height) return 0;
  const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data, seen = new Set<number>();
  for (let i = 0; i < d.length; i += 4 * 37) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return seen.size;
})));

test('the full-detail pass needs the network, not just navigator.onLine: archive reads failing when it is due keep the coarse layer drawn (never a blank map); once they work, the next move brings full detail, drawn', async ({ page }) => {
  test.skip(!hasBasemap(), 'no basemap extract in this build');
  test.setTimeout(45_000);
  await coarsePass(page);
  // A weak signal or a captive portal: every read of the archive fails while navigator.onLine stays true.
  let blocked = 0;
  const archive = /\/map\/pvd-\d+\.pmtiles$/;
  await page.route(archive, (r) => { blocked++; return r.abort('failed'); });
  await expect.poll(() => blocked, { timeout: 20_000 }).toBeGreaterThan(0); // the full pass came due and tried
  await page.waitForTimeout(1_500);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await expect(mainMap(page)).toHaveAttribute('data-basemap', 'coarse');
  await expect(tileLayers(page)).toHaveCount(1);
  expect(await tileWidth(page)).toBe(256);
  expect(await tileColours(page)).toBeGreaterThan(10);
  // The reads work again: the next moveend retries, and the full layer draws real tiles.
  await page.unroute(archive);
  await mapEval(page, 'm => { m.panBy([0, 2], { animate: false }); }');
  await expect(mainMap(page)).toHaveAttribute('data-basemap', 'full', { timeout: 15_000 });
  await expect(tileLayers(page)).toHaveCount(1);
  expect(await tileWidth(page)).toBe(768);
  expect(await tileColours(page)).toBeGreaterThan(10);
});

/* ── Coming back: "since you last looked" + the home-screen nudge (lib/streetVisit.ts) ──────────────────────────────── */

const SEEN = 'fixmypvd.street.seenAt', SEEN_FEED = 'fixmypvd.street.seenFeedAt', VISITS = 'fixmypvd.street.visits', SNOOZE = 'fixmypvd.street.installDismissed';
const ls = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const note = (page: Page) => page.locator('.street-since');
const newTags = (page: Page) => page.locator('.street-row .my-status--new');
const nudge = (page: Page) => page.locator('.street-install');
/** The ten fixture cases without the filler: created today (c3), 1 d (s1) and 2 d (s2) are fresher than a visit 2½ days
 *  ago; c1 (3 d), z2 (4 d), s3–s6 and c2 (created 9 d ago, CLOSED yesterday) are not. */
const RETURN_ITEMS: Case[] = [...NEAR, UNPLACED, ...STACK_CASES];
/** Land again with seenAt set `agoMs` ago (and, optionally, another feed): the routes persist across navigations. */
async function revisit(page: Page, agoMs: number, items?: Case[]) {
  await page.evaluate(([k, s, f]) => { localStorage.setItem(k, s); localStorage.removeItem(f); }, [SEEN, new Date(Date.now() - agoMs).toISOString(), SEEN_FEED]);
  if (items) { await page.unrouteAll({ behavior: 'ignoreErrors' }); await setup(page, { items }); }
  await page.goto('/street');
  await waitForMap(page);
  await expect(page.locator('.map-cluster').first()).toBeVisible();
}
/** Chromium's beforeinstallprompt, fired until a listener preventDefaults it (the hooks mount after the init script);
 *  prompt() is logged on window.__install and the native sheet reads "dismissed". */
async function stubInstallPrompt(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __install: string[] };
    w.__install = [];
    const fire = () => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(e, { prompt: async () => { w.__install.push('prompt'); }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
      window.dispatchEvent(e);
      if (!e.defaultPrevented) setTimeout(fire, 100);
    };
    setTimeout(fire, 50);
  });
}
const installLog = (page: Page) => page.evaluate(() => (window as unknown as { __install: string[] }).__install);

test('since you last looked: nothing on a first visit (no line, no New), seenAt + the visit count written once the landing has loaded — a point URL never counts; a key under an hour old is the same sitting', async ({ page }) => {
  await setup(page);
  await page.goto(POINT);
  await waitForMap(page);
  await expect(rows(page)).toHaveCount(3);
  expect(await ls(page, SEEN)).toBeNull();
  expect(await ls(page, VISITS)).toBeNull();
  await page.goto('/street');
  await waitForMap(page);
  await expect(page.locator('.map-cluster').first()).toBeVisible();
  await expect(note(page)).toHaveCount(0);
  await expect.poll(() => ls(page, SEEN)).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(Date.now() - Date.parse((await ls(page, SEEN))!)).toBeLessThan(60_000);
  expect(await ls(page, VISITS)).toBe('1');
  await grab(page).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(newTags(page)).toHaveCount(0);
  // Ten minutes ago: nothing to compare against yet.
  await revisit(page, 10 * 60_000);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await expect(note(page)).toHaveCount(0);
  await grab(page).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(newTags(page)).toHaveCount(0);
  expect(await ls(page, VISITS)).toBe('2');
});

test('since you last looked: a return visit 2½ days later → the second subtitle line at PEEK (plain text, not a live region), New on the three fresher Latest rows only, the key moved to now; singular, none and "a while ago"; Spanish', async ({ page }) => {
  const seen = new Date(Date.now() - 2.5 * 86_400_000).toISOString();
  // Only the first load (init scripts re-run on every navigation; the later revisits set their own seenAt).
  await page.addInitScript(([k, s]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, s); }, [SEEN, seen]);
  await landing(page, { items: RETURN_ITEMS });
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await expect(note(page)).toHaveText('3 new since you last looked (2 days ago)');
  await expect(note(page)).toBeVisible(); // in the header: readable at PEEK, under the live summary
  await expect(sub(page)).toHaveText('10 requests · 6 open · 4 closed · last 30 days');
  expect(await note(page).evaluate((el) => [el.hasAttribute('role'), el.hasAttribute('aria-live'), el.tagName])).toEqual([false, false, 'P']);
  // The key moved to now (the next visit compares against this one).
  await expect.poll(async () => Date.now() - Date.parse((await ls(page, SEEN))!)).toBeLessThan(60_000);
  await grab(page).click();
  await expect(newTags(page)).toHaveCount(3);
  await expect(newTags(page)).toHaveText(['New', 'New', 'New']);
  expect((await page.locator('.street-row-btn:has(.my-status--new)').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).sort()).toEqual(['c3', 's1', 's2']);
  // One pill per row: c2 (closed yesterday, created 9 days ago) keeps its status pill alone.
  await expect(page.locator('.street-row-btn[data-id="c2"] .my-status')).toHaveText(['Closed']);
  await expect(page.locator('.street-row-btn[data-id="c3"] .my-status')).toHaveText(['New', 'In progress']);
  // Singular, none, and the far past.
  const quiet = [UNPLACED, ...STACK_CASES]; // freshest is s1, one day old
  await revisit(page, 1.5 * 86_400_000, quiet);
  await expect(note(page)).toHaveText('1 new since you last looked (yesterday)');
  await revisit(page, 2 * 60 * 60_000);
  await expect(note(page)).toHaveText('Nothing new since you last looked (today)');
  await grab(page).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(newTags(page)).toHaveCount(0);
  await revisit(page, 45 * 86_400_000, RETURN_ITEMS);
  await expect(note(page)).toHaveText('10 new since you last looked (a while ago)');
  // Spanish: the feminine of "solicitud", and the nudge copy (the suite's iPhone UA, a later visit).
  await page.evaluate(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await revisit(page, 2.5 * 86_400_000);
  await expect(note(page)).toHaveText('3 nuevas desde tu última visita (hace 2 días)');
  await grab(page).click();
  await expect(newTags(page)).toHaveText(['Nueva', 'Nueva', 'Nueva']);
  await expect(nudge(page).getByRole('heading', { name: 'Guárdala en tu pantalla de inicio' })).toBeVisible();
  await expect(nudge(page).getByRole('button', { name: 'Agregar a pantalla de inicio' })).toBeVisible();
  await expect(nudge(page).getByRole('button', { name: 'Ahora no' })).toBeVisible();
});

test('since you last looked: "new" starts after the newest case that visit saw, not at the visit — a case the city made before it but the feed stored after it still counts', async ({ page }) => {
  const h = 3_600_000;
  // Last visit 3 h ago; the newest case it showed was 5 h old. The feed now has one made 4 h ago (stored late) and older ones.
  await page.addInitScript(([k, s, f, fv]) => { if (!localStorage.getItem(k)) { localStorage.setItem(k, s); localStorage.setItem(f, fv); } },
    [SEEN, new Date(Date.now() - 3 * h).toISOString(), SEEN_FEED, new Date(Date.now() - 5 * h).toISOString()]);
  const late: Case = { id: 'late1', t: 0, status: 'Submitted', createdDaysAgo: 4 / 24, lat: 41.8282, lng: -71.4005, street: '481 Angell St' };
  await landing(page, { items: [late, ...STACK_CASES] });
  await expect(note(page)).toHaveText('1 new since you last looked (today)');
  // This visit's cutoff is its own newest case (late1, 4 h old), never later than now.
  await expect.poll(async () => Math.round((Date.now() - Date.parse((await ls(page, SEEN_FEED))!)) / h)).toBe(4);
});

test('install nudge: not on the first visit; from the second, with beforeinstallprompt on offer, the card tops the list (PEEK height untouched) with 44 px buttons — the CTA calls prompt() and the card goes; never once installed (standalone)', async ({ page }) => {
  await stubInstallPrompt(page);
  await landing(page);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  // The PEEK height the sheet publishes (its target, not a frame of the 220 ms height transition), once the extra lines have landed.
  const peekH = () => page.locator('.street-stage').evaluate((el) => getComputedStyle(el).getPropertyValue('--sheet-h').trim());
  await page.waitForTimeout(400);
  const firstPeek = await peekH();
  expect(firstPeek).toMatch(/^\d+px$/);
  await grab(page).click();
  await expect(page.locator('a.street-week-link')).toBeVisible();
  await expect(nudge(page)).toHaveCount(0);
  expect(await ls(page, VISITS)).toBe('1');
  await revisit(page, 5 * 60_000);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  // The nudge lives in the body, not the measured header: PEEK is exactly the first visit's height, not + a card.
  await expect(page.locator('#street-sheet-body .street-install')).toHaveCount(1);
  await expect.poll(peekH).toBe(firstPeek);
  await grab(page).click();
  const card = nudge(page);
  await expect(card.getByRole('heading', { name: 'Keep it on your home screen' })).toBeVisible();
  await expect(card).toContainText('One tap to check your street. On iPhone, phone notifications need the installed app. Turn them on in Account → Updates.');
  expect(await page.evaluate(() => {
    const c = document.querySelector('.street-install')!; const a = document.querySelector('a.street-week-link')!;
    return c.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
  })).toBe('above');
  const cta = card.getByRole('button', { name: 'Add to home screen' });
  expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await card.getByRole('button', { name: 'Not now' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(card.locator('.street-install-ios')).toBeHidden(); // the iPhone hint has no business on a phone with the prompt
  await cta.click();
  await expect.poll(() => installLog(page)).toEqual(['prompt']);
  await expect(card).toHaveCount(0);
  expect(await ls(page, VISITS)).toBe('2');
  expect(await ls(page, SNOOZE)).toBeNull(); // a tap is not "Not now"
  // Installed (display-mode / navigator.standalone): never, whatever the count.
  await stubPush(page, { standalone: true });
  await revisit(page, 5 * 60_000);
  await grab(page).click();
  await expect(page.locator('a.street-week-link')).toBeVisible();
  await expect(nudge(page)).toHaveCount(0);
  expect(await ls(page, VISITS)).toBe('3');
});

test('install nudge, iPhone in a Safari tab (no prompt event): the CTA reveals "Share → Add to Home Screen" in the card\'s status line; Not now stamps a 30-day snooze; a 31-day-old snooze shows it again', async ({ page }) => {
  await stubPush(page, { ua: IPHONE, pushManager: false });
  await page.addInitScript((k) => localStorage.setItem(k, '1'), VISITS);
  await landing(page);
  await grab(page).click();
  const card = nudge(page);
  await expect(card).toBeVisible();
  const ios = card.locator('.street-install-ios');
  await expect(ios).toHaveAttribute('role', 'status');
  await expect(ios).toBeHidden();
  await card.getByRole('button', { name: 'Add to home screen' }).click();
  await expect(ios).toHaveText('Share → Add to Home Screen');
  await expect(ios).toBeFocused(); // the tapped button is gone: focus lands on the hint it revealed, not on <body>
  await expect(card.getByRole('button', { name: 'Add to home screen' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Not now' })).toBeVisible();
  expect(await ls(page, SNOOZE)).toBeNull();
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
  // …and with the card gone, on the next control in the sheet.
  expect(await page.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && !!a.closest('.street-sheet'); })).toBe(true);
  expect(Date.now() - Date.parse((await ls(page, SNOOZE))!)).toBeLessThan(60_000);
  await revisit(page, 5 * 60_000);
  await grab(page).click();
  await expect(page.locator('a.street-week-link')).toBeVisible();
  await expect(nudge(page)).toHaveCount(0);
  await page.evaluate((k) => localStorage.setItem(k, new Date(Date.now() - 31 * 86_400_000).toISOString()), SNOOZE);
  await revisit(page, 5 * 60_000);
  await grab(page).click();
  await expect(nudge(page).getByRole('button', { name: 'Add to home screen' })).toBeVisible();
});
