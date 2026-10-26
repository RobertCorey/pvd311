import { test, expect, type Page } from '@playwright/test';
import { QUIET, WEEK, setupWeek } from './week-mocks';
import { setup as setupStreet, waitForMap } from './street-mocks';

// /week — "This week in Providence": one mocked GET /api/week rendered as a plain page; every section is a door into
// /street. Mobile project = iPhone 13.

const main = (page: Page) => page.locator('main');
const weekCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith('/api/week'));

async function open(page: Page, o: Parameters<typeof setupWeek>[1] = {}) {
  const calls = await setupWeek(page, o);
  await page.goto('/week');
  await expect(page.locator('main h1')).toHaveText('This week in Providence');
  return calls;
}

test('renders every section from the feed: numbers, deltas, types, hoods, outcomes, closes, busiest day', async ({ page }) => {
  const calls = await open(page);
  await expect(page.locator('.week-stats')).toBeVisible();
  expect(weekCalls(calls)).toHaveLength(1);
  await expect(page.locator('.week-range')).toHaveText('Oct 18 – Oct 25 · the last 7 days');

  // Stat tiles: the delta is words (the arrow glyph is aria-hidden), never colour alone.
  const tiles = page.locator('.week-stat');
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0).locator('dt')).toHaveText('Requests');
  await expect(tiles.nth(0).locator('.week-stat-n')).toHaveText('312');
  await expect(tiles.nth(0).locator('.week-delta')).toHaveText('↑ 22 more than last week');
  await expect(tiles.nth(0).locator('.week-delta')).toHaveClass(/week-delta--up/);
  await expect(tiles.nth(1).locator('dt')).toHaveText('Closed');
  await expect(tiles.nth(1).locator('.week-stat-n')).toHaveText('114');
  await expect(tiles.nth(1).locator('.week-delta')).toHaveText('↓ 16 fewer than last week');
  await expect(tiles.nth(2).locator('dt')).toHaveText('Median days to close');
  await expect(tiles.nth(2).locator('.week-stat-n')).toHaveText('3.5');

  // Most reported: six rows → /street?g=<group>, unknown category → other; the muted "last week n".
  const top = page.locator('.week-top .week-row');
  await expect(top).toHaveCount(6);
  expect(await top.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual([
    '/street?g=streets', '/street?g=lights', '/street?g=trash', '/street?g=property', '/street?g=traffic', '/street?g=other',
  ]);
  await expect(top.nth(0)).toContainText('Pothole');
  await expect(top.nth(0).locator('.week-row-n')).toHaveText('this week 61');   // "this week" is visually hidden
  await expect(top.nth(0).locator('.week-row-sub')).toHaveText('last week 48');
  // Both numbers are labelled for a screen reader, not just laid out.
  await expect(top.nth(0)).toHaveAccessibleName(/Pothole.*last week 48.*this week 61/);
  expect(await top.nth(0).locator('.week-vh').evaluate((e) => getComputedStyle(e).position)).toBe('absolute');
  await expect(top.nth(0).locator('svg')).toHaveCount(1);

  // By neighborhood: the top 8 of 10, bar width = n / max, count in text, each → /street?n=<slug>.
  const hoods = page.locator('.week-hoods .week-row');
  await expect(hoods).toHaveCount(8);
  expect(await hoods.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual([
    '/street?n=elmhurst', '/street?n=west-end', '/street?n=downtown', '/street?n=fox-point', '/street?n=upper-south-providence',
    '/street?n=mount-pleasant', '/street?n=silver-lake', '/street?n=washington-park',
  ]);
  await expect(hoods.nth(0)).toContainText('Elmhurst');
  await expect(hoods.nth(0).locator('.week-row-n')).toHaveText('48');
  expect(await hoods.nth(0).locator('.week-hood-bar > span').evaluate((e) => (e as HTMLElement).style.width)).toBe('100%');
  expect(await hoods.nth(7).locator('.week-hood-bar > span').evaluate((e) => (e as HTMLElement).style.width)).toBe('40%'); // 19 / 48
  await expect(main(page)).not.toContainText('Smith Hill');

  // What closing meant: the stacked bar names every share; the legend carries counts and percentages; zero buckets are left out.
  const bar = page.locator('.week-outbar');
  await expect(bar).toHaveAttribute('aria-label', 'Closed requests by outcome: Work done 40 (35%), Citation or enforcement 10 (9%), Referred elsewhere 30 (26%), Logged in another system 20 (18%), Information only 5 (4%), Nothing found 9 (8%)');
  await expect(bar.locator('.week-seg')).toHaveCount(6);
  await expect(bar.locator('.week-seg').first()).toHaveAttribute('title', 'Work done 40');
  const legend = page.locator('.week-legend li');
  await expect(legend).toHaveCount(6);
  await expect(legend.nth(0)).toHaveText('Work done 40 (35%)');
  await expect(legend.nth(2)).toHaveText('Referred elsewhere 30 (26%)');
  await expect(main(page)).not.toContainText('Cancelled or merged');
  await expect(page.locator('.week-outcomes-hint')).toContainText('not that the work is done');
  expect(await legend.nth(0).locator('.week-sw').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(42, 120, 214)');

  // What got done: notable closes → /street?case=<id>&lat&lng (lat/lng only when placed), with the city's note.
  const done = page.locator('.week-done .week-row');
  await expect(done).toHaveCount(3);
  expect(await done.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual([
    '/street?case=n1&lat=41.82856&lng=-71.40050', '/street?case=n2&lat=41.82830&lng=-71.40060', '/street?case=n3',
  ]);
  await expect(done.nth(0).locator('.street-type')).toHaveText('Street Light Out');
  await expect(done.nth(0).locator('.street-addr')).toHaveText('22 Thayer St · College Hill');
  await expect(done.nth(0).locator('.street-when')).toHaveText(/^Closed /);
  await expect(done.nth(0).locator('.street-note')).toHaveText('Bulb replaced.');
  await expect(done.nth(2).locator('.street-addr')).toHaveText('Street not given');

  await expect(page.locator('.week-busiest')).toHaveText('Busiest day: Wednesday, Oct 21 (61 requests)');
  await expect(page.locator('.week-source')).toContainText('public request list');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('share: with navigator.share absent the URL lands on the clipboard and the live region says so', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s: string) => { (window as unknown as { __copied: string }).__copied = s; return Promise.resolve(); } }, configurable: true });
  });
  await open(page);
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText('Link copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe('http://localhost:4173/week');
});

test('digest, signed out: the card offers a sign-in link that returns to /week', async ({ page }) => {
  const calls = await open(page);
  const link = page.locator('.week-digest a.btn');
  await expect(link).toHaveText('Sign in to get the weekly email');
  expect(decodeURIComponent((await link.getAttribute('href'))!)).toBe('/account?returnTo=/week');
  await expect(page.locator('.week-digest button')).toHaveCount(0);
  expect(calls.filter((c) => c.url.includes('/api/me'))).toEqual([]);
});

test('digest, signed in: one tap PATCHes weekDigest on and shows the on state; Turn off PATCHes it off', async ({ page }) => {
  const calls = await open(page, { signedIn: true });
  await page.getByRole('button', { name: 'Email me every Monday' }).click();
  await expect(page.locator('.week-digest-on .notice-ok')).toHaveText("On — you'll get this every Monday.");
  expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ prefs: { weekDigest: true } });
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Email me every Monday' })).toBeVisible();
  expect(calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ prefs: { weekDigest: false } });
});

test('digest, signed in and already on: the on state without asking again', async ({ page }) => {
  await open(page, { signedIn: true, me: { prefs: { emailUpdates: true, weekDigest: true } } });
  await expect(page.locator('.week-digest-on .notice-ok')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email me every Monday' })).toHaveCount(0);
});

test('Account → Updates has the Monday digest toggle: it PATCHes prefs.weekDigest and keeps the other prefs', async ({ page }) => {
  const calls = await setupWeek(page, { signedIn: true, me: { prefs: { emailUpdates: false, weekDigest: false } } });
  await page.goto('/account');
  const box = page.getByRole('checkbox', { name: 'Email me "This week in Providence" every Monday' });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(box).toBeChecked();
  expect(calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ prefs: { weekDigest: true } });
  // The optimistic update keeps the other preference as it was.
  await expect(page.getByRole('checkbox', { name: 'Email me when the city updates my reports' })).not.toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
  expect(calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ prefs: { weekDigest: false } });
});

test('a quiet week (total 0) → the quiet state, still the digest card and the source line', async ({ page }) => {
  await open(page, { body: QUIET });
  await expect(page.locator('.week-quiet')).toContainText("The city's list is quiet this week");
  await expect(page.locator('.week-stats')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await expect(page.locator('.week-digest')).toBeVisible();
  await expect(page.locator('.week-source')).toBeVisible();
});

test('500 → error notice + Retry refetches and renders', async ({ page }) => {
  const calls = await open(page, { status: (n) => (n === 1 ? 500 : 200) });
  await expect(page.locator('.notice-error[role="alert"]')).toHaveText("Couldn't load this week's numbers right now.");
  expect(weekCalls(calls)).toHaveLength(1);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.week-stats')).toBeVisible();
  expect(weekCalls(calls)).toHaveLength(2);
  await expect(page.locator('.notice-error')).toHaveCount(0);
});

test('loading shows skeleton bars, never a spinner; the numbers replace them', async ({ page }) => {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  await page.route('https://pvd311-worker.pvd311-worker.workers.dev/api/week', async (r) => { await gate; await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WEEK) }); });
  await page.goto('/week');
  await expect(page.locator('.week-skel')).toBeVisible();
  await expect(page.locator('main h1')).toHaveText('This week in Providence');
  release();
  await expect(page.locator('.week-stats')).toBeVisible();
  await expect(page.locator('.week-skel')).toHaveCount(0);
});

test('Spanish: the page and its sections read in es', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await setupWeek(page);
  await page.goto('/week');
  await expect(page.locator('main h1')).toHaveText('Esta semana en Providence');
  await expect(page.locator('.week-range')).toHaveText(/los últimos 7 días/);
  await expect(page.locator('.week-stat').nth(0).locator('.week-delta')).toHaveText('↑ 22 más que la semana pasada');
  await expect(page.locator('.week-h').first()).toHaveText('Lo más reportado');
  await expect(page.locator('.week-busiest')).toHaveText(/^Día con más actividad: miércoles, 21 oct \(61 solicitudes\)$/);
});

test('the /street landing sheet shows the week link above Most reported', async ({ page }) => {
  await setupStreet(page);
  await page.goto('/street');
  await waitForMap(page);
  await page.locator('.street-grab').click();
  const link = page.locator('a.street-week-link');
  await expect(link).toHaveText('This week in Providence →');
  await expect(link).toHaveAttribute('href', '/week');
  // It sits above the "Most reported" heading.
  expect(await page.evaluate(() => {
    const a = document.querySelector('a.street-week-link')!; const h = [...document.querySelectorAll('.street-h')].find((x) => x.textContent === 'Most reported')!;
    return a.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
  })).toBe('above');
  await link.click();
  await expect(page).toHaveURL(/\/week$/);
  await expect(page.locator('main h1')).toHaveText('This week in Providence');
});
