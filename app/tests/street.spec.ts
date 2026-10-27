import { existsSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { API, BIG_STACK, BIG_STACK_CASES, DEFAULT_ITEMS, NEAR, PAIR, PAIR_CASES, POINT, PT, SESSION, STACK, STACK_CASES, UNPLACED, detailFor, filler, mapEval, setView, setup, userPan, waitForMap, zoomOf, type Case } from './street-mocks';
import { GROUP_GLYPHS } from '../src/lib/mapMarkers';
import { ENDPOINT, IPHONE, pushApi, stubPush } from './push-mocks';

// /street — the map-first "My street" page (.claude/street-map-spec.md): one mocked GET /api/street/map, everything else
// (bbox, counts, clusters, hoods, URL) computed in the browser. Mobile project = iPhone 13 (390×664); one desktop describe.

const mapCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('/api/street/map'));
const sheet = (page: Page) => page.locator('.street-sheet');
const grab = (page: Page) => page.locator('.street-grab');
const title = (page: Page) => page.locator('.street-title');
const sub = (page: Page) => page.locator('.street-sub');
const rows = (page: Page) => page.locator('.street-row-btn');
/** The filters (components/StreetFilters.tsx): Show = three radios named "All, n" / "Open, n" / "Closed, n"; the When and
 *  Type selects, named by their labels; Clear (visible "Clear", named "Clear filters"). */
const radio = (page: Page, name: RegExp) => page.getByRole('radio', { name });
const whenSel = (page: Page) => page.getByLabel('When', { exact: true });
const typeSel = (page: Page) => page.getByLabel('Type', { exact: true });
const clearBtn = (page: Page) => page.getByRole('button', { name: 'Clear filters', exact: true });
/** The phone's floating filter rows (Street.tsx RAIL_BOTTOM = 162 px into the stage = their bottom edge). */
const FILTER_ROW = '.street-filters';
const RAIL_BOTTOM = 162;
/** The case overlay's header × — "Back to list" (the card itself has no back button any more). */
const backX = (page: Page) => page.getByRole('button', { name: 'Back to list' });

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

test('filters: Show is one choice of three (All / Open / Closed) with counts, Type is a select, Clear resets; When: 7 cuts locally, 90 refetches once', async ({ page }) => {
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
  // Type: a select with every group and its count; picking one writes the same g= the old chips did.
  await expect(typeSel(page)).toHaveValue('');
  await typeSel(page).selectOption('streets');
  await expect(page).toHaveURL(/[?&]g=streets/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Pothole');
  await expect(page.locator('.map-case')).toHaveCount(1);
  await expect(typeSel(page).locator('option:checked')).toHaveText('Streets · 1');
  await expect(typeSel(page).locator('option').first()).toHaveText('All types · 3');
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
  await expect(typeSel(page)).toHaveValue('');
  await expect(rows(page)).toHaveCount(3);
  // When: a select labelled "When"; the window alone also counts as a filter for Clear.
  await expect(whenSel(page)).toHaveValue('30');
  await expect(whenSel(page).locator('option')).toHaveText(['This week', '30 days', '90 days']);
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
  await expect(typeSel(page).locator('option')).toHaveText([
    'All types · 2', 'Trash · 1', 'Streets · 1', 'Traffic · 0', 'Trees · 0', 'Property · 0', 'Lights · 0', 'Nuisance · 0', 'Water · 0', 'Animals · 0', 'Other · 0',
  ]);
  await typeSel(page).selectOption('trees');
  await expect(page).toHaveURL(/[?&]g=trees/);
  await expect(sub(page)).toHaveText('0 in view · 0 open · 0 closed');
  await expect(page.locator('.street-none')).toContainText('Nothing here in the last 30 days with these filters.');
  const fix = page.getByRole('button', { name: 'Show all types (2)' });
  await expect(fix).toBeVisible();
  await expect(page.getByRole('button', { name: /^Include closed/ })).toHaveCount(0); // closed trees in view: 0 → hidden
  await fix.click();
  await expect(page).not.toHaveURL(/[?&]g=/);
  await expect(typeSel(page)).toHaveValue('');
  await expect(rows(page)).toHaveCount(2);
});

test('filters: old links restore — no s (both statuses) → All, s=open → Open, s=closed → Closed, g=trash (/week\'s links) → Trash, d=7 → This week; unknown values fall back to the defaults', async ({ page }) => {
  await point(page);
  await expect(radio(page, /^All, 3$/)).toBeChecked();
  await expect(typeSel(page)).toHaveValue('');
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
  await expect(typeSel(page)).toHaveValue('trash');
  await expect(typeSel(page).locator('option:checked')).toHaveText('Trash · 1');
  await expect(radio(page, /^All, 1$/)).toBeChecked();
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`${POINT}&d=7&s=open&g=lights`);
  await expect(whenSel(page)).toHaveValue('7');
  await expect(radio(page, /^Open, 0$/)).toBeChecked();
  await expect(typeSel(page)).toHaveValue('lights');
  // A value no build ever wrote (s=both, g=nope, d=15) is the default — and Clear has nothing to clear.
  await page.goto(`${POINT}&s=both&g=nope&d=15`);
  await expect(rows(page)).toHaveCount(3);
  await expect(radio(page, /^All, 3$/)).toBeChecked();
  await expect(typeSel(page)).toHaveValue('');
  await expect(whenSel(page)).toHaveValue('30');
  await expect(clearBtn(page)).toHaveCount(0);
  // /week's "Most reported" rows land on the landing with the type picked.
  await page.goto('/street?g=other');
  await waitForMap(page);
  await expect(typeSel(page)).toHaveValue('other');
});

test('filters: keyboard — one Tab stop for Show, the arrow keys move the choice within it (and wrap), with a visible ring; then When, then Type', async ({ page }) => {
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
  await expect(typeSel(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(radio(page, /^Closed, 1$/)).toBeFocused(); // back into the group lands on the chosen radio
});

test('filters on the phone: two 44 px rows under the search pill — Show across the width, then When, Type and Clear; labels visually hidden but naming them; they end at RAIL_BOTTOM with or without Clear, clear of the map key; nothing is off-screen or scrolls sideways (Type included, also from a /week deep link); the selects never make iOS zoom', async ({ page }) => {
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
  const seg = await box(page, '.street-controls .street-seg'), when = (await whenSel(page).boundingBox())!, type = (await typeSel(page).boundingBox())!;
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
  // iOS Safari zooms the page into any select under 16 px on focus: When and Type are 16 px.
  expect(await row.locator('select').evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize))).toEqual(['16px', '16px']);
  // Clear: the third cell of row 2, in sight, after Type in the tab order; the rows keep their height and bottom.
  await radio(page, /^Open, 2$/).click();
  await expect(clearBtn(page)).toBeVisible();
  await check();
  const c = (await clearBtn(page).boundingBox())!, type2 = (await typeSel(page).boundingBox())!;
  expect(c.y).toBeCloseTo(r.y + 52, 0);
  expect(c.height).toBeCloseTo(44, 0);
  expect(c.x).toBeGreaterThanOrEqual(type2.x + type2.width);
  await inside(c);
  // Clear from the keyboard: the filters reset and focus lands on the checked "All", not <body>.
  await clearBtn(page).focus();
  await page.keyboard.press('Enter');
  await expect(clearBtn(page)).toHaveCount(0);
  await expect(radio(page, /^All, /)).toBeFocused();
  // A /week deep link (?g=animals) shows the picked type in its select, in sight — no sideways scroll needed.
  await page.goto('/street?g=animals');
  await waitForMap(page);
  await expect(typeSel(page)).toHaveValue('animals');
  await inside((await typeSel(page).boundingBox())!);
  await check();
});

test('selection via row: the card takes focus, writes case=, marks the pin; Back and Escape return focus to the row', async ({ page }) => {
  await point(page);
  const row = page.locator('.street-row-btn[data-id="c2"]');
  await row.click();
  const card = page.locator('.street-detail');
  await expect(card).toBeFocused();
  await expect(title(page)).toHaveText('Street Light Out');
  await expect(card).toContainText('22 Thayer St');
  await expect(page.locator('.street-badge .my-status')).toHaveText('Closed');
  await expect(card.locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(page.locator('.map-pin--selected')).toHaveCount(1);
  await expect(title(page)).toHaveText('Street Light Out');
  await backX(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-row-btn[data-id="c2"]')).toBeFocused();
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(page.locator('.street-detail')).toBeFocused();
  await expect(page.locator('.street-detail')).toHaveAccessibleDescription('Assigned'); // the header's pill, before the card
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
  await expect(title(page)).toHaveText('Pothole');
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
  await expect(title(page)).toHaveText('Pothole');
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
  await expect(title(page)).toHaveText('Tree Down');
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
  await backX(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);

  // Bare case= on an unplaced closed case: the card (with the city's note) over the whole city, no pin.
  await page.goto('/street?case=old2');
  await waitForMap(page);
  await expect(title(page)).toHaveText('Pothole');
  await expect(card.locator('.street-note')).toHaveText('Filled.');
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]case=old2/);
  expect(lookups()).toEqual(['old1', 'old2']);
});

test('a case only the 90-day window holds stays open when the window shrinks under it — Clear, or When → 30 days: fetched by itself, card, × and pin kept', async ({ page }) => {
  // Closed 45 days ago, 30 m from the point: in the 90-day feed only.
  const old: Case = { id: 'old3', t: 4, status: 'Resolved', createdDaysAgo: 60, closedDaysAgo: 45, lat: 41.8279, lng: -71.4008, street: '30 Angell St', res: 'Painted over.' };
  await setup(page, { items90: [...DEFAULT_ITEMS, old] });
  const card = page.locator('.street-detail');
  const kept = async () => {
    await expect(page).toHaveURL(/[?&]case=old3/);
    await expect(card.locator('.street-fact-place')).toHaveText('30 Angell St');
    await expect(page.locator('.street-skel--case')).toHaveCount(0);
    await expect(title(page)).toHaveText('Graffiti');
    await expect(backX(page)).toBeVisible();
    await expect(page.locator('.map-pin--selected')).toHaveCount(1);
  };
  // Clear (it resets the window too) while the card is open.
  await page.goto(`${POINT}&d=90`);
  await waitForMap(page);
  await page.locator('.street-row-btn[data-id="old3"]').click();
  await expect(card.locator('.street-fact-place')).toHaveText('30 Angell St');
  await clearBtn(page).click();
  await expect(page).not.toHaveURL(/[?&](g|s|d)=/);
  await expect(whenSel(page)).toHaveValue('30');
  await kept();
  // When → 30 days on a deep link to it.
  await page.goto(`${POINT}&d=90&case=old3`);
  await waitForMap(page);
  await expect(card.locator('.street-fact-place')).toHaveText('30 Angell St');
  await whenSel(page).selectOption('30');
  await expect(page).not.toHaveURL(/[?&]d=/);
  await kept();
  // × still closes it.
  await backX(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);
});

// ── The case overlay (Rob, 2026-10-27: "When you click on a pin it should show an overlay with all the case details") ──
const caseCalls = (calls: { url: string }[], id: string) => calls.filter((c) => c.url.endsWith(`/api/street/case/${id}`)).length;
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

test('case overlay: a pin tap at PEEK → the header is the case (type, status pill, 44 px ×) with no second title in the card; status, street, hood · distance and reported · closed after N days are in view at 390×664 without scrolling, the pin stays in the band above, and the card scrolls at HALF to the rest', async ({ page }) => {
  await point(page, { details: { c2: detailFor(NEAR[1]) } });
  await grab(page).press('ArrowDown');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
  await setView(page, NEAR[1].lat!, NEAR[1].lng!, 17);
  await page.waitForTimeout(400);
  await clickPin(page, NEAR[1].lat!, NEAR[1].lng!);
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(sheet(page)).toHaveAttribute('data-overlay', 'true');
  // The header is the case: type, pill, ×; the list's Share icon and summary give way.
  await expect(title(page)).toHaveText('Street Light Out');
  await expect(page.locator('.street-badge .my-status')).toHaveText('Closed');
  const x = (await backX(page).boundingBox())!;
  expect(x.width).toBeGreaterThanOrEqual(44);
  expect(x.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.street-head-actions').getByRole('button', { name: 'Share' })).toHaveCount(0);
  await expect(sub(page)).toHaveText('');
  // No duplicated title: the card holds no type text and is named by the header's h2.
  const card = page.locator('.street-detail');
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute('aria-labelledby', 'street-title');
  await expect(card.getByText('Street Light Out')).toHaveCount(0);
  await expect(card.locator('h3', { hasText: 'Street Light Out' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Street Light Out' })).toBeFocused();
  // …and described by the header's status pill: it sits before the card, so reading on from the card never reaches it.
  await expect(card).toHaveAttribute('aria-describedby', 'street-badge');
  await expect(card).toHaveAccessibleDescription('Closed');
  // Key facts, above the fold at HALF.
  await expect(card.locator('.street-fact-place')).toHaveText('22 Thayer St');
  await expect(card.locator('.street-addr')).toHaveText('College Hill · 56 m away');
  await expect(card.locator('.street-fact-when')).toHaveText(/^Reported [A-Z][a-z]{2} \d{1,2} · closed after 8 days$/);
  const body = page.locator('#street-sheet-body');
  expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
  const sh = await box(page, '.street-sheet'), bd = await box(page, '#street-sheet-body');
  const tabTop = (await box(page, '.tabbar')).y;
  for (const sel of ['.street-badge .my-status', '.street-fact-place', '.street-detail .street-addr', '.street-fact-when']) {
    const b = await box(page, sel);
    expect(b.y, sel).toBeGreaterThanOrEqual(sh.y);
    expect(b.y + b.height, sel).toBeLessThanOrEqual(Math.min(bd.y + bd.height, tabTop));
  }
  // The tapped pin is still in the band between the rail and the sheet.
  const pin = await box(page, '.map-pin--selected'), rail = await box(page, FILTER_ROW);
  expect(pin.y + pin.height).toBeLessThanOrEqual(sh.y + 1);
  expect(pin.y).toBeGreaterThanOrEqual(rail.y + rail.height - 1);
  // The rest of the card is reachable by scrolling the body at this detent (it was clipped at HALF before).
  expect(await body.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const share = card.getByRole('button', { name: 'Share' });
  await share.scrollIntoViewIfNeeded();
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const sb = (await share.boundingBox())!;
  expect(sb.y).toBeGreaterThanOrEqual(bd.y);
  expect(sb.y + sb.height).toBeLessThanOrEqual(Math.min(bd.y + bd.height, tabTop));
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half'); // scrolled, not raised
});

test('case overlay detail: GET /api/street/case/:id once per case — the timeline lists only the steps with dates (the close says how long it took), "What was reported" as label/value text (never HTML), the full address only when it says more than the street; a skeleton while it loads', async ({ page }) => {
  const c1 = NEAR[0];
  const calls = await point(page, {
    caseDelayMs: 900,
    details: {
      c1: detailFor(c1, { address: '12 Angell St, Providence, RI, 02906, USA', workCompletedDaysAgo: 1, answers: [{ label: 'Type of Property', value: '<b>Residential</b>' }, { label: 'Is Property Abandoned', value: 'Yes' }] }),
      c2: { ...detailFor(NEAR[1]), address: '22 THAYER ST, Providence, RI, 02906, USA', timeline: { ...detailFor(NEAR[1]).timeline, received: null, routed: null }, answers: [] },
    },
  });
  await page.locator('.street-row-btn[data-id="c1"]').click();
  const card = page.locator('.street-detail');
  // The basic card is there at once; the detail block is a skeleton until the request lands.
  await expect(card.locator('.street-fact-place')).toHaveText('10 Angell St');
  await expect(card.locator('.street-detail-skel')).toBeVisible();
  await expect(card).toHaveAttribute('aria-busy', 'true');
  await expect(card.locator('.street-tl')).toBeVisible({ timeout: 5000 });
  await expect(card.locator('.street-detail-skel')).toHaveCount(0);
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  // Open case: Reported, Received, Sent to the department, Work completed — no Closed step.
  const steps = card.locator('.street-tl-step');
  expect(await steps.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.step))).toEqual(['reported', 'received', 'routed', 'workCompleted']);
  await expect(steps.locator('.street-tl-label')).toHaveText(['Reported', 'Received by the city', 'Sent to the department', 'Work completed']);
  for (const tm of await steps.locator('time').all()) {
    await expect(tm).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(Number.isFinite(Date.parse((await tm.getAttribute('datetime'))!))).toBe(true);
  }
  await expect(card.locator('.street-tl-days')).toHaveCount(0);
  // "What was reported": a definition list, the value as typed — markup stays text.
  await expect(card.getByRole('heading', { name: 'What was reported' })).toBeVisible();
  await expect(card.locator('.street-answers dt')).toHaveText(['Type of Property', 'Is Property Abandoned']);
  await expect(card.locator('.street-answers dd')).toHaveText(['<b>Residential</b>', 'Yes']);
  await expect(card.locator('.street-answers b')).toHaveCount(0);
  // The city's address has a different house number than its street field → shown, without ", USA".
  await expect(card.locator('.street-fulladdr')).toHaveText('Full address 12 Angell St, Providence, RI, 02906');
  expect(caseCalls(calls, 'c1')).toBe(1);

  // Closed case: Reported → Closed "8 days after it was reported"; the city's note; no answers; the address only
  // repeats the street (case aside) → not shown.
  await backX(page).click();
  await setView(page, NEAR[1].lat!, NEAR[1].lng!, 16); // c2 in the band (the HALF band under the two filter rows is short)
  await page.waitForTimeout(400);
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await expect(card.locator('.street-tl-step')).toHaveCount(2, { timeout: 5000 });
  await expect(card.locator('.street-tl-label')).toHaveText(['Reported', 'Closed']);
  await expect(card.locator('.street-tl-step[data-step="resolved"] .street-tl-days')).toHaveText('8 days after it was reported');
  await expect(card.locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(card.locator('.street-answers')).toHaveCount(0);
  await expect(card.locator('.street-fulladdr')).toHaveCount(0);

  // No detail read yet (c3: the endpoint omits `detail`): the basic card, no skeleton left, no timeline.
  await backX(page).click();
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(title(page)).toHaveText('Overflowing Dumpster');
  await expect.poll(() => caseCalls(calls, 'c3')).toBe(1);
  await expect(card.locator('.street-detail-skel')).toHaveCount(0, { timeout: 5000 });
  await expect(card.locator('.street-tl, .street-answers, .street-fulladdr')).toHaveCount(0);

  // Reopening a case reads the cache: no second request, no skeleton flash.
  await backX(page).click();
  await page.locator('.street-row-btn[data-id="c1"]').click();
  await expect(card.locator('.street-tl')).toBeVisible();
  await expect(card.locator('.street-detail-skel')).toHaveCount(0);
  expect(caseCalls(calls, 'c1')).toBe(1);
});

test('case overlay detail: a failed request leaves the basic card — key facts and the city\'s note, no error, no skeleton', async ({ page }) => {
  const calls = await point(page, { caseStatus: () => 500 });
  await page.locator('.street-row-btn[data-id="c2"]').click();
  const card = page.locator('.street-detail');
  await expect(card).toBeFocused();
  await expect(title(page)).toHaveText('Street Light Out');
  await expect.poll(() => caseCalls(calls, 'c2')).toBe(1);
  await expect(card.locator('.street-detail-skel')).toHaveCount(0);
  await expect(card.locator('.street-fact-when')).toContainText('closed after 8 days');
  await expect(card.locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(card.locator('.street-tl, .street-answers, .street-fulladdr')).toHaveCount(0);
  await expect(page.locator('.street-sheet .notice-error')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Share' })).toBeVisible();
});

test('case overlay ×: does what Back to list did — from a row it pops the entry and refocuses the row, the list header (title, summary, Share) comes back; from a pin it closes the card and keeps focus in the sheet', async ({ page }) => {
  await point(page);
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await expect(page).toHaveURL(/[?&]case=c2/);
  await backX(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-row-btn[data-id="c2"]')).toBeFocused();
  await expect(page.locator('.map-pin--selected')).toHaveCount(0);
  await expect(sheet(page)).not.toHaveAttribute('data-overlay', 'true');
  await expect(title(page)).toHaveText('481 Angell St');
  await expect(page.locator('.street-head-actions').getByRole('button', { name: 'Share' })).toBeVisible();
  await page.goForward(); // the entry the row pushed is still there going forward
  await expect(page).toHaveURL(/[?&]case=c2/);
  await expect(title(page)).toHaveText('Street Light Out');
  // From a pin.
  await page.goto(POINT);
  await waitForMap(page);
  await grab(page).press('ArrowDown');
  await setView(page, NEAR[1].lat!, NEAR[1].lng!, 17);
  await page.waitForTimeout(400);
  await clickPin(page, NEAR[1].lat!, NEAR[1].lng!);
  await expect(title(page)).toHaveText('Street Light Out');
  await backX(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-detail')).toHaveCount(0);
  await expect(page.locator('.street-sheet :focus')).toHaveCount(1);
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
  // Selecting the new pin keeps its emphasis (scale + ring) on top of the halo.
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(page.locator('.map-case[data-id="c3"]')).toHaveClass(/map-pin--selected/);
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

test('map key over the case overlay (390×664, HALF): it covers the sheet header, so Tab past its × closes it with focus where Tab sent it — never on a control under the key; Shift+Tab out past the button closes it too', async ({ page }) => {
  await point(page, { details: { c2: detailFor(NEAR[1]) } });
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await expect(sheet(page)).toHaveAttribute('data-overlay', 'true');
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  const btn = page.getByRole('button', { name: 'Map key', exact: true });
  const dlg = page.getByRole('dialog', { name: 'Map key' });
  await btn.click();
  await expect(dlg).toBeFocused();
  // Precondition: the open key sits over the overlay's × (Back to list).
  const pop = await box(page, '.street-key-pop'), x = (await backX(page).boundingBox())!;
  expect(pop.x <= x.x && pop.x + pop.width >= x.x + x.width && pop.y <= x.y && pop.y + pop.height >= x.y + x.height).toBe(true);
  await page.keyboard.press('Tab');
  await expect(dlg.getByRole('button', { name: 'Close the map key' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dlg).toHaveCount(0);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(grab(page)).toBeFocused(); // not pulled back to the button
  await page.keyboard.press('Tab');
  await expect(backX(page)).toBeFocused();
  const onTop = (l: ReturnType<Page['locator']>) => l.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && el.contains(hit); });
  expect(await onTop(backX(page))).toBe(true);
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
const pinTips = (page: Page) => page.locator('.mapview .map-case').evaluateAll((els) => els.map((el) => {
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

test('a fanned pin is a case pin: a tap at PEEK opens that case\'s overlay, the pin selected and on top, kept in the band above the HALF sheet', async ({ page }) => {
  await landing(page, { details: { s3: detailFor(STACK_CASES[2]) } });
  await page.waitForTimeout(700); // the landing's PEEK refit is done
  await setView(page, STACK.lat, STACK.lng, 18);
  await expect(page.locator('.mapview .map-case')).toHaveCount(6);
  await page.waitForTimeout(500); // the drop-in is over
  const tip = (await pinTips(page)).find((t) => t.id === 's3')!;
  await page.mouse.click(tip.x, tip.y - 14);
  await expect(page).toHaveURL(/[?&]case=s3/);
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(sheet(page)).toHaveAttribute('data-overlay', 'true');
  await expect(title(page)).toHaveText('Street Light Out');
  const pin = page.locator('.mapview .map-case[data-id="s3"]');
  await expect(pin).toHaveClass(/map-pin--selected/);
  await expect(page.locator('.map-pin--selected')).toHaveCount(1);
  await expect(page.locator('.mapview .map-case')).toHaveCount(6); // still fanned
  const z = (l: ReturnType<Page['locator']>) => l.evaluate((el) => Number(getComputedStyle(el).zIndex));
  for (const id of ['s1', 's2', 's4', 's5', 's6']) expect(await z(pin)).toBeGreaterThan(await z(page.locator(`.mapview .map-case[data-id="${id}"]`)));
  await page.waitForTimeout(600); // the pan into the band settles
  const b = (await pin.boundingBox())!, sh = await box(page, '.street-sheet'), rail = await box(page, FILTER_ROW);
  expect(b.y + b.height).toBeLessThanOrEqual(sh.y + 1);
  expect(b.y).toBeGreaterThanOrEqual(rail.y + rail.height - 1);
});

test('selection pans to the fanned pin, not the shared spot: a row tap with its pin under the rail, and a row tap while the stack is still a disc (z16 → 17, the pin centred in the band), both end with that pin in the band', async ({ page }) => {
  await landing(page, { details: { s3: detailFor(STACK_CASES[2]) } });
  await page.waitForTimeout(700); // the landing's PEEK refit is done
  await setView(page, STACK.lat, STACK.lng, 18);
  await grab(page).click();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
  await expect(page.locator('.mapview .map-case')).toHaveCount(6);
  /** Pan so the shared spot sits `y` page px down (panBy moves the view, so the map content moves the other way). */
  const spotAt = async (y: number) => {
    const c = await pagePoint(page, STACK.lat, STACK.lng);
    await mapEval<void>(page, `m => { m.panBy([0, ${c.y - y}], { animate: false }); }`);
    await page.waitForTimeout(400);
  };
  const inBand = async () => {
    const b = (await page.locator('.map-pin--selected').boundingBox())!, sh = await box(page, '.street-sheet'), r = await box(page, FILTER_ROW);
    expect(b.y + b.height).toBeLessThanOrEqual(sh.y + 1);
    expect(b.y).toBeGreaterThanOrEqual(r.y + r.height - 1);
  };
  // The shared spot 20 px under the rail: s3's slot (up and left) is then under the rail itself.
  const rail = await box(page, FILTER_ROW);
  await spotAt(rail.y + rail.height + 20);
  expect((await pinTips(page)).find((t) => t.id === 's3')!.y).toBeLessThan(rail.y + rail.height);
  await page.locator('.street-row-btn[data-id="s3"]').click();
  await expect(page).toHaveURL(/[?&]case=s3/);
  await expect(page.locator('.mapview .map-case[data-id="s3"]')).toHaveClass(/map-pin--selected/);
  await page.waitForTimeout(700);
  await inBand();
  // Back to the list; at z16 the stack is a disc again. A row tap goes to z17 centred on where s3 is drawn there.
  await backX(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await setView(page, STACK.lat, STACK.lng, 16);
  const sh0 = await box(page, '.street-sheet');
  await spotAt((rail.y + rail.height + sh0.y) / 2);
  await expect(page.locator('.map-cluster', { hasText: /^6$/ })).toHaveCount(1);
  await page.locator('.street-row-btn[data-id="s3"]').click();
  await expect.poll(() => zoomOf(page)).toBe(17);
  await expect(page.locator('.mapview .map-case[data-id="s3"]')).toHaveClass(/map-pin--selected/);
  await expect(legs(page)).toHaveCount(6);
  await page.waitForTimeout(700);
  await inBand();
  const sh = await box(page, '.street-sheet'), mid = (rail.y + rail.height + sh.y) / 2;
  const tip = (await pinTips(page)).find((t) => t.id === 's3')!, c = await pagePoint(page, STACK.lat, STACK.lng);
  expect(Math.abs(tip.y - mid), 's3 is the centred one').toBeLessThanOrEqual(4);
  expect(Math.abs(c.y - mid)).toBeGreaterThan(15); // …not the shared spot
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

test('neighborhoods: the select writes n=, draws the outline and fits; a pan clears it; the title follows the map centre', async ({ page }) => {
  await landing(page);
  await grab(page).click();
  await page.getByLabel('Jump to a neighborhood…').selectOption('Fox Point');
  await expect(page).toHaveURL(/[?&]n=fox-point/);
  await expect(page.locator('.map-hood')).toHaveCount(1);
  await expect(title(page)).toHaveText('Fox Point');
  await expect.poll(() => zoomOf(page)).toBeGreaterThanOrEqual(12); // fitted into the HALF band under the two filter rows
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
  await expect(title(page)).toHaveText('Pothole');
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
  await backX(page).click();
  await page.locator('.street-row-btn[data-id="c2"]').click();
  await expect(title(page)).toHaveText('Street Light Out');
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
  await backX(page).click();
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(title(page)).toHaveText('Overflowing Dumpster');
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
  await backX(page).click();
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
  // The filters stay named and focusable but inert: Show's radios aria-disabled (counts "—"), the selects disabled.
  await expect(radio(page, /^Open$/)).toHaveAttribute('aria-disabled', 'true');
  await expect(radio(page, /^All$/)).toBeChecked();
  await expect(page.locator('.street-seg-n')).toHaveText(['—', '—', '—']);
  await expect(whenSel(page)).toBeDisabled();
  await expect(typeSel(page)).toBeDisabled();
  await expect(typeSel(page).locator('option').first()).toHaveText('All types · —');
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

test('history: Back to list from a deep-linked case never leaves the app, even after a pan or a filter change; card → card is one entry', async ({ page }) => {
  // An external link (digest mail, share) with case=: the entry is not ours. Pan, pick Open, then Back to list.
  await setup(page);
  await page.goto(`${POINT}&case=c2`);
  await waitForMap(page);
  await expect(title(page)).toHaveText('Street Light Out');
  await userPan(page, 120, 0);
  await page.waitForTimeout(500);
  await radio(page, /^Open, /).click();
  await expect(page).toHaveURL(/[?&]s=open/);
  await backX(page).click();
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
  await expect(title(page)).toHaveText('Pothole');
  await setView(page, NEAR[1].lat!, NEAR[1].lng!, 17);
  await page.waitForTimeout(400);
  await clickPin(page, NEAR[1].lat!, NEAR[1].lng!);
  await expect(title(page)).toHaveText('Street Light Out');
  await expect(page).toHaveURL(/[?&]case=c2/);
  await backX(page).click();
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(page.locator('.street-detail')).toHaveCount(0);
  await expect(rows(page).first()).toBeVisible(); // the in-view list is back (how many fit depends on the band)
  // Escape on a card opened from the list pops the entry we pushed: the card is still there going forward.
  await page.locator('.street-row-btn[data-id="c3"]').click();
  await expect(page.locator('.street-detail')).toBeFocused();
  await page.locator('.street-row-btn[data-id="c3"]').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/[?&]case=/);
  await expect(rows(page).first()).toBeVisible(); // the in-view list is back (how many fit depends on the band)
  await page.goForward();
  await expect(page).toHaveURL(/[?&]case=c3/);
  await expect(title(page)).toHaveText('Overflowing Dumpster');
});

test('a shared c/z view with case= keeps the sender\'s framing; a point with case= stays at z16', async ({ page }) => {
  await setup(page);
  await page.goto('/street?c=41.8450,-71.4450&z=14&case=c2');
  await waitForMap(page);
  await expect(title(page)).toHaveText('Street Light Out');
  await page.waitForTimeout(700);
  expect(await zoomOf(page)).toBe(14);
  const c = await mapEval<{ lat: number; lng: number }>(page, 'm => { const c = m.getCenter(); return { lat: c.lat, lng: c.lng }; }');
  expect(Math.abs(c.lat - 41.845)).toBeLessThan(0.002);
  expect(Math.abs(c.lng + 71.445)).toBeLessThan(0.002);
  await expect(page).toHaveURL(/[?&]c=41\.8450,-71\.4450&z=14/);
  await page.goto(`${POINT}&case=c2`);
  await waitForMap(page);
  await expect(title(page)).toHaveText('Street Light Out');
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
  const sheetTop = (await sheet(page).boundingBox())!.y;
  expect(Math.abs(await pageY(page, 41.762, -71.42) - (sheetTop - 38))).toBeLessThanOrEqual(2);
  expect(await pageY(page, 41.772, -71.42)).toBeLessThan(sheetTop - 16);

  // Woonsocket (north-west): west edge at minLng − 0.01°, the northern line clear of the search rail.
  await setView(page, 42.0, -71.51, 15);
  v = await edges(page);
  expect(v.w).toBeCloseTo(-71.483, 3);
  const railBottom = await page.locator(FILTER_ROW).evaluate((el) => el.getBoundingClientRect().bottom);
  expect(Math.abs(await pageY(page, 41.881, -71.48) - (railBottom + 38))).toBeLessThanOrEqual(2); // margin line + rail + pin head
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
  });
  test('filters in the panel: three labelled rows — Show, When, Type — label left, control right, lined up; Clear under them only off the defaults; the narrow panel puts the labels above, and no segment overflows (4-digit city counts, Spanish)', async ({ page }) => {
    await point(page);
    const f = page.locator(`.street-panel ${FILTER_ROW}`);
    await expect(f.locator('.street-filter-label')).toHaveText(['Show', 'When', 'Type']);
    await expect(page.locator(`.street-controls`)).toHaveCount(0); // no floating row on desktop
    const layout = () => f.locator('.street-filter').evaluateAll((els) => els.map((el) => {
      const r = (x: Element | null) => { const b = x!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return { label: r(el.querySelector('.street-filter-label')), control: r(el.querySelector('.street-seg, select')) };
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
    await expect(page.getByLabel('Tipo', { exact: true }).locator('option').first()).toHaveText('Todos los tipos · 1234');
    await expect(page.getByLabel('Cuándo', { exact: true })).toHaveValue('30');
    expect(await stacked()).toBe(true);
    expect(await uncut()).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(besides).toBe(true);
    expect(await uncut()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test('case overlay in the panel: the panel header is the case (type, pill, ×) with the same card; the map key sits in the map\'s top-right corner', async ({ page }) => {
    await setup(page, { details: { c2: detailFor(NEAR[1]) } });
    await page.goto(`${POINT}&case=c2`);
    await waitForMap(page);
    const panel = page.locator('.street-panel');
    await expect(panel).toHaveAttribute('data-overlay', 'true');
    await expect(panel.locator('.street-title')).toHaveText('Street Light Out');
    await expect(panel.locator('.street-badge .my-status')).toHaveText('Closed');
    await expect(panel.locator('.street-detail')).toHaveAccessibleDescription('Closed');
    await expect(panel.locator('.street-detail .street-fact-place')).toHaveText('22 Thayer St');
    await expect(panel.locator('.street-tl-step')).toHaveCount(4);
    await expect(page.locator('.street-detail').getByText('Street Light Out')).toHaveCount(0);
    const key = page.getByRole('button', { name: 'Map key', exact: true });
    await expect(key).toHaveText('Map key');
    const k = (await key.boundingBox())!, map = (await page.locator('.mapview').boundingBox())!;
    expect(k.x + k.width).toBeLessThanOrEqual(map.x + map.width);
    expect(k.x + k.width).toBeGreaterThan(map.x + map.width - 40);
    expect(k.y).toBeLessThan(map.y + 30);
    await key.click();
    await expect(page.getByRole('dialog', { name: 'Map key' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(key).toBeFocused();
    await backX(page).click();
    await expect(page).not.toHaveURL(/[?&]case=/);
    await expect(panel).not.toHaveAttribute('data-overlay', 'true');
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
  await expect(card).toContainText('One tap to check your street. Notifications work only from the installed app on iPhone.');
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
