import { test, expect, type Page } from '@playwright/test';
import { API, PLACES, QUIET, WEEK, datedWeek, setupWeek } from './week-mocks';
import { setup as setupStreet, waitForMap } from './street-mocks';
import { todayNY, weekLinkProblem } from '../src/lib/week';

// /week — "This week in Providence": one mocked GET /api/week rendered as a plain page; every section is a door into
// /street. Mobile project = iPhone 13.

const main = (page: Page) => page.locator('main');
const weekCalls = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith('/api/week'));
/** Every /api/week call, dated or not, as its path + query. */
const weekUrls = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('/api/week')).map((c) => c.url.slice(API.length));
const weekNav = (page: Page) => page.getByRole('navigation', { name: 'Other weeks' });
/** The mocked week in progress on /street: Monday Oct 19 to the day it was counted (Sunday Oct 25). */
const D = '&from=2026-10-19&to=2026-10-25';

async function open(page: Page, o: Parameters<typeof setupWeek>[1] = {}) {
  const calls = await setupWeek(page, o);
  await page.goto('/week');
  await expect(page.locator('main h1')).toHaveText('This week in Providence');
  return calls;
}

test('renders every section from the feed: numbers, groups, hoods, outcomes, closes, busiest day — the week in progress, so no "vs last week"', async ({ page }) => {
  const calls = await open(page);
  await expect(page.locator('.week-stats')).toBeVisible();
  expect(weekCalls(calls)).toHaveLength(1);
  await expect(page.locator('.week-range')).toHaveText('Since Monday, Oct 19');

  // Stat tiles; a week still in progress is not set against a whole one (compare false): no deltas.
  const tiles = page.locator('.week-stat');
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0).locator('dt')).toHaveText('Requests');
  await expect(tiles.nth(0).locator('.week-stat-n')).toHaveText('312');
  await expect(tiles.nth(1).locator('dt')).toHaveText('Closed');
  await expect(tiles.nth(1).locator('.week-stat-n')).toHaveText('114');
  await expect(tiles.nth(2).locator('dt')).toHaveText('Median days to close');
  await expect(tiles.nth(2).locator('.week-stat-n')).toHaveText('3.5');
  await expect(page.locator('.week-delta')).toHaveCount(0);

  // Most reported: the six busiest type groups, each → /street on that group and this week's days (the row's count is
  // what it opens on); no "last week n" on a week in progress.
  const top = page.locator('.week-top .week-row');
  await expect(top).toHaveCount(6);
  expect(await top.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(
    ['streets', 'trash', 'lights', 'property', 'traffic', 'nuisance'].map((g) => `/street?g=${g}${D}`),
  );
  await expect(top.nth(0).locator('.week-row-name')).toHaveText('Streets & sidewalks');
  await expect(top.nth(0).locator('.week-row-n')).toHaveText('this week 80');   // "this week" is visually hidden
  await expect(page.locator('.week-top .week-row-sub')).toHaveCount(0);
  await expect(top.nth(0)).toHaveAccessibleName(/Streets & sidewalks.*this week 80/);
  expect(await top.nth(0).locator('.week-vh').evaluate((e) => getComputedStyle(e).position)).toBe('absolute');
  await expect(top.nth(0).locator('svg')).toHaveCount(1);

  // By neighborhood: the top 8 of 10, bar width = n / max, count in text, each → /street?n=<slug> on this week's days.
  const hoods = page.locator('.week-hoods .week-row');
  await expect(hoods).toHaveCount(8);
  expect(await hoods.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual(TOP8);
  await expect(hoods.nth(0)).toContainText('Elmhurst');
  // The count is named for a screen reader ("48 requests"), so it never reads as a bare number next to "18 closed".
  await expect(hoods.nth(0).locator('.week-row-n > [aria-hidden="true"]')).toHaveText('48');
  await expect(hoods.nth(0).locator('.week-row-n .week-vh')).toHaveText('48 requests');
  await expect(hoods.nth(0)).toHaveAccessibleName(/^Elmhurst\s*48 requests\s*18 closed · median 2\.5 days$/);
  expect(await hoods.nth(0).locator('.week-hood-bar > span').evaluate((e) => (e as HTMLElement).style.width)).toBe('100%');
  expect(await hoods.nth(7).locator('.week-hood-bar > span').evaluate((e) => (e as HTMLElement).style.width)).toBe('40%'); // 19 / 48
  // Each row's second line: closes and the hood's own median; a hood without a dated close has no median.
  await expect(hoods.nth(0).locator('.week-hood-sub')).toHaveText('18 closed · median 2.5 days');
  await expect(hoods.nth(2).locator('.week-hood-sub')).toHaveText('16 closed · median 1.5 days');
  await expect(hoods.nth(7).locator('.week-hood-sub')).toHaveText('7 closed');
  await expect(main(page)).not.toContainText('Smith Hill');
  await expect(page.getByRole('button', { name: 'Show all 10 neighborhoods' })).toHaveAttribute('aria-expanded', 'false');

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

  // Closed this week, in the city's words (the Monday mail's heading): notable closes → /street?case=<id> framed by a map
  // view c/z when placed — not a lat/lng point, which would make the case's own spot "where you are".
  await expect(page.locator('#week-done-h')).toHaveText("Closed this week, in the city's words");
  const done = page.locator('.week-done .week-row');
  await expect(done).toHaveCount(3);
  expect(await done.evaluateAll((els) => els.map((e) => e.getAttribute('href')))).toEqual([
    '/street?case=n1&c=41.8286,-71.4005&z=17', '/street?case=n2&c=41.8283,-71.4006&z=17', '/street?case=n3',
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
  // The DATED url even on the current week: a link posted on Monday still means this week on Thursday.
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe('http://localhost:4173/week?until=2026-10-25');
});

/** lib/weekPost.ts for the mocked current week, with this origin as the link's site (BRAND.siteUrl off fixmypvd.org). */
const POST = [
  '**This week in Providence (Oct 19 – Oct 25)**',
  '312 requests to 311, 114 closed, median 3.5 days to close.',
  'Most reported: Pothole (61), Street Light Out (44), Missed Trash Pickup (39).',
  'Busiest: Elmhurst (48), West End (41), Downtown (36).',
  'What closing meant: 35% work done, 26% referred elsewhere, 18% logged in another system…',
  '- Street Light Out, 22 Thayer St (College Hill): "Bulb replaced."\n- Pothole, 10 Angell St (College Hill): "Filled with cold patch; permanent repair scheduled."\n- Graffiti: "Referred to Parks."',
  "Full week and the city's own notes: http://localhost:4173/week?until=2026-10-25",
  "From Providence 311's public request list. Not affiliated with the city.",
].join('\n\n');

test('copy as post: next to Share; the week lands on the clipboard as Markdown and the live region says so; a blocked clipboard says so too; a dated week posts its own range and link', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s: string) => { (window as unknown as { __copied: string }).__copied = s; return Promise.resolve(); } }, configurable: true, writable: true });
  });
  await open(page);
  const actions = page.locator('.week-head .week-actions .btn');
  await expect(actions).toHaveText(['Share', 'Copy as post']);
  for (const b of await actions.all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Copy as post' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText('Post copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(POST);
  // The clipboard refuses (no permission) and the old execCommand way fails too: the live region says so and the post is
  // laid open in a read-only box, selected, with Select all and Hide — it can still be copied by hand.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
    document.execCommand = () => false;
  });
  await page.getByRole('button', { name: 'Copy as post' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText("Couldn't copy here. The post is below — select it and copy it yourself.");
  const manual = page.getByRole('textbox', { name: 'The post as Markdown' });
  await expect(manual).toBeVisible();
  await expect(manual).toHaveValue(POST);
  await expect(manual).toHaveAttribute('readonly', '');
  await expect(manual).toBeFocused();
  expect(await manual.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, POST.length]);
  await page.getByRole('button', { name: 'Share' }).focus();   // move focus away, then Select all brings it back selected
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(manual).toBeFocused();
  expect(await manual.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, POST.length]);
  for (const b of await page.locator('.week-manual-actions .btn').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Hide' }).click();
  await expect(manual).toHaveCount(0);
  // A past week: its calendar range in the title and its dated link.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s: string) => { (window as unknown as { __copied: string }).__copied = s; return Promise.resolve(); } }, configurable: true });
  });
  await page.goto('/week?until=2026-10-18');
  await expect(page.locator('main h1')).toHaveText('Providence, Oct 12 – Oct 18');
  await page.getByRole('button', { name: 'Copy as post' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText('Post copied');
  const dated = await page.evaluate(() => (window as unknown as { __copied: string }).__copied);
  expect(dated.split('\n\n').slice(0, 2)).toEqual(['**This week in Providence (Oct 12 – Oct 18)**', '312 requests to 311 (+22 vs last week), 114 closed, median 3.5 days to close.']);
  expect(dated).toContain("Full week and the city's own notes: http://localhost:4173/week?until=2026-10-18");
});

test('copy as post + share without navigator.clipboard (plain http off localhost): the hidden-textarea execCommand path copies, the box is cleaned up, focus stays on the button', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    // The only copy path left: whatever is selected in the focused textarea when execCommand('copy') runs.
    document.execCommand = (cmd: string) => {
      if (cmd !== 'copy') return false;
      const el = document.activeElement as HTMLTextAreaElement | null;
      if (!el || el.tagName !== 'TEXTAREA') return false;
      (window as unknown as { __copied: string }).__copied = el.value.slice(el.selectionStart, el.selectionEnd);
      return true;
    };
  });
  await open(page);
  expect(await page.evaluate(() => navigator.clipboard === undefined)).toBe(true);
  const post = page.getByRole('button', { name: 'Copy as post' });
  await post.click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText('Post copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(POST);
  await expect(page.locator('textarea')).toHaveCount(0);   // the throwaway box is gone; no manual box either
  await expect(post).toBeFocused();
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText('Link copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe('http://localhost:4173/week?until=2026-10-25');
  // Share with no way to copy at all says so in the same live region.
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText("Couldn't copy here. Try again.");
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('copy as post, Spanish: the button and its status are translated while the post stays English', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('fixmypvd.lang', 'es');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s: string) => { (window as unknown as { __copied: string }).__copied = s; return Promise.resolve(); } }, configurable: true });
  });
  await setupWeek(page);
  await page.goto('/week');
  await expect(page.locator('main h1')).toHaveText('Esta semana en Providence');
  await page.getByRole('button', { name: 'Copiar como post' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText('Post copiado');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe(POST);
});

test('the current week: the title stays "This week", only Previous week is offered, and the sign-in round trip returns to the live page', async ({ page }) => {
  await open(page);
  const nav = weekNav(page);
  await expect(nav.getByRole('link')).toHaveCount(1);
  await expect(nav.getByRole('link', { name: 'Previous week' })).toHaveAttribute('href', '/week?until=2026-10-18');
  await expect(nav.getByRole('link', { name: 'Next week' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Latest week' })).toHaveCount(0);
  // The glyphs are decoration; the link's name is the words.
  await expect(nav.locator('.week-nav-prev')).toHaveText('‹ Previous week');
  expect(decodeURIComponent((await page.locator('.week-digest a.btn').getAttribute('href'))!)).toBe('/account?returnTo=/week');
});

test('a dated link: /week?until=2026-10-18 asks the Worker for that week and is titled by its range, with Previous · Next · Latest', async ({ page }) => {
  const calls = await setupWeek(page);
  await page.goto('/week?until=2026-10-18');
  await expect(page.locator('main h1')).toHaveText('Providence, Oct 12 – Oct 18');
  await expect(page.locator('.week-stats')).toBeVisible();
  expect(weekUrls(calls)).toEqual(['/api/week?until=2026-10-18']);
  await expect(page.locator('.week-range')).toHaveText('Monday to Sunday · 7 days');
  const nav = weekNav(page);
  await expect(nav.getByRole('link', { name: 'Previous week' })).toHaveAttribute('href', '/week?until=2026-10-11');
  await expect(nav.getByRole('link', { name: 'Next week' })).toHaveAttribute('href', '/week?until=2026-10-25');
  await expect(nav.getByRole('link', { name: 'Latest week' })).toHaveAttribute('href', '/week');
  // Signing in from a past week comes back to that week.
  expect(decodeURIComponent((await page.locator('.week-digest a.btn').getAttribute('href'))!)).toBe('/account?returnTo=/week?until=2026-10-18');
  // The rest of the page is the same page: tiles — with "vs last week", two whole weeks — rows into /street on THAT
  // week's days, the busiest day of THAT week.
  const tiles = page.locator('.week-stat');
  await expect(tiles.nth(0).locator('.week-stat-n')).toHaveText('312');
  // The delta is words (the arrow glyph is aria-hidden), never colour alone.
  await expect(tiles.nth(0).locator('.week-delta')).toHaveText('↑ 22 more than last week');
  await expect(tiles.nth(0).locator('.week-delta')).toHaveClass(/week-delta--up/);
  await expect(tiles.nth(1).locator('.week-delta')).toHaveText('↓ 16 fewer than last week');
  const top = page.locator('.week-top .week-row');
  await expect(top.first()).toHaveAttribute('href', '/street?g=streets&from=2026-10-12&to=2026-10-18');
  await expect(top.first().locator('.week-row-sub')).toHaveText('last week 70');
  await expect(top.first()).toHaveAccessibleName(/Streets & sidewalks.*last week 70.*this week 80/);
  await expect(page.locator('.week-hoods .week-row').first()).toHaveAttribute('href', '/street?n=elmhurst&from=2026-10-12&to=2026-10-18');
  await expect(page.locator('.week-busiest')).toHaveText('Busiest day: Wednesday, Oct 14 (61 requests)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a dated week shares its own url', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s: string) => { (window as unknown as { __copied: string }).__copied = s; return Promise.resolve(); } }, configurable: true });
  });
  await setupWeek(page);
  await page.goto('/week?until=2026-10-11');
  await expect(page.locator('main h1')).toHaveText('Providence, Oct 5 – Oct 11');
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.locator('.week-flash[role="status"]')).toHaveText('Link copied');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe('http://localhost:4173/week?until=2026-10-11');
});

test('browsing: Previous week fetches that week once; stepping back to a week already seen is served from the client cache keyed by until', async ({ page }) => {
  const calls = await open(page);
  await weekNav(page).getByRole('link', { name: 'Previous week' }).click();
  await expect(page).toHaveURL(/\/week\?until=2026-10-18$/);
  await expect(page.locator('main h1')).toHaveText('Providence, Oct 12 – Oct 18');
  await expect(page.locator('.week-stats')).toBeVisible();
  expect(weekUrls(calls)).toEqual(['/api/week', '/api/week?until=2026-10-18']);
  // Next week is the dated form of today: the Worker answers the current week; the client has not seen that key yet.
  await weekNav(page).getByRole('link', { name: 'Next week' }).click();
  await expect(page).toHaveURL(/\/week\?until=2026-10-25$/);
  await expect(page.locator('main h1')).toHaveText('This week in Providence');
  await expect(weekNav(page).getByRole('link', { name: 'Latest week' })).toHaveCount(0);
  expect(weekUrls(calls)).toEqual(['/api/week', '/api/week?until=2026-10-18', '/api/week?until=2026-10-25']);
  // Back to Oct 18: no new request.
  await weekNav(page).getByRole('link', { name: 'Previous week' }).click();
  await expect(page.locator('main h1')).toHaveText('Providence, Oct 12 – Oct 18');
  await expect(page.locator('.week-stats')).toBeVisible();
  expect(weekUrls(calls)).toHaveLength(3);
  // Latest week → the bare page, also cached.
  await weekNav(page).getByRole('link', { name: 'Latest week' }).click();
  await expect(page).toHaveURL(/\/week$/);
  await expect(page.locator('main h1')).toHaveText('This week in Providence');
  await expect(page.locator('.week-stats')).toBeVisible();
  expect(weekUrls(calls)).toHaveLength(3);
});

test('at the archive floor there is no Previous week; Next and Latest remain', async ({ page }) => {
  await setupWeek(page);
  await page.goto('/week?until=2026-08-30');
  await expect(page.locator('main h1')).toHaveText('Providence, Aug 24 – Aug 30');
  const nav = weekNav(page);
  await expect(nav.getByRole('link', { name: 'Previous week' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Next week' })).toHaveAttribute('href', '/week?until=2026-09-06');
  await expect(nav.getByRole('link', { name: 'Latest week' })).toHaveAttribute('href', '/week');
});

test('a quiet dated week names its dates', async ({ page }) => {
  await setupWeek(page, { body: { ...QUIET, untilDate: '2026-10-11', prevUntil: '2026-10-04', nextUntil: '2026-10-18', current: false } });
  await page.goto('/week?until=2026-10-11');
  await expect(page.locator('.week-quiet')).toHaveText("The city's list was quiet that week — nothing opened or closed between Oct 5 and Oct 11.");
  await expect(weekNav(page).getByRole('link', { name: 'Latest week' })).toBeVisible();
});

test('where the data starts: the first week says when we started reading the city\'s list, has no Previous and no "vs last week"; a week before it says so instead of "quiet"', async ({ page }) => {
  await setupWeek(page, { body: (until: string | null) => (until === '2026-10-04'
    ? { ...QUIET, untilDate: '2026-10-04', prevUntil: null, nextUntil: '2026-10-11', current: false, firstDay: '2026-10-10', compare: false }
    : until === '2026-10-11' ? { ...datedWeek(until), prevUntil: null, firstDay: '2026-10-10', compare: false }
    : { ...datedWeek(until ?? '2026-10-25'), firstDay: '2026-10-10' }) });
  await page.goto('/week?until=2026-10-11');
  await expect(page.locator('main h1')).toHaveText('Providence, Oct 5 – Oct 11');
  await expect(page.locator('.week-started')).toHaveText("We started reading the city's list on Oct 10.");
  await expect(weekNav(page).getByRole('link', { name: 'Previous week' })).toHaveCount(0);
  await expect(weekNav(page).getByRole('link', { name: 'Next week' })).toBeVisible();
  await expect(page.locator('.week-stats')).toBeVisible();
  await expect(page.locator('.week-delta')).toHaveCount(0);
  await expect(page.locator('.week-top .week-row-sub')).toHaveCount(0);
  // An older link (still inside the archive) to a week before the data: that, not "the city's list was quiet".
  await page.goto('/week?until=2026-10-04');
  await expect(page.locator('.week-quiet')).toHaveText("We started reading the city's list on Oct 10.");
  // A later week does not repeat it.
  await page.goto('/week?until=2026-10-18');
  await expect(page.locator('.week-stats')).toBeVisible();
  await expect(page.locator('.week-started')).toHaveCount(0);
});

test('400 too_old / invalid_until: a plain message and the Latest week link, no Retry', async ({ page }) => {
  const calls = await setupWeek(page, { status: () => 400, error: { error: 'too_old' } });
  await page.goto('/week?until=2026-07-05');
  await expect(page.locator('main h1')).toHaveText('Providence, Jun 29 – Jul 5');
  await expect(page.locator('.notice-error[role="alert"]')).toHaveText('That week is older than the eight weeks we keep.');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(weekNav(page).getByRole('link', { name: 'Latest week' })).toHaveAttribute('href', '/week');
  expect(weekUrls(calls)).toEqual(['/api/week?until=2026-07-05']);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await setupWeek(page, { status: () => 400, error: { error: 'invalid_until' } });
  await page.goto('/week?until=garbage');
  await expect(page.locator('main h1')).toHaveText('This week in Providence');
  await expect(page.locator('.notice-error[role="alert"]')).toHaveText("That link doesn't point at a week we have.");
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await weekNav(page).getByRole('link', { name: 'Latest week' }).click();
  await expect(page).toHaveURL(/\/week$/);
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

/** A box's top and height in CSS px, of the first element matching `sel`. */
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, height: r.height }; });

test('the skeleton has the loaded page\'s geometry: tiles and rows land where their bars stood (±1 px) and the footer never enters the first screen', async ({ page }) => {
  // Pins the hand-measured heights in Week.css (.week-skel-* ↔ .week-stat / .week-h / .week-row): a padding or font-size
  // tweak to the loaded page without its skeleton twin fails here instead of silently bringing back CLS 0.39.
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  await page.route(`${API}/api/week`, async (r) => { await gate; await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(WEEK) }); });
  await page.goto('/week');
  await expect(page.locator('.week-skel')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const before = { stats: await box(page, '.week-skel-stats'), tile: await box(page, '.week-skel-stats i'), type: await box(page, '.week-skel-list i'), hood: await box(page, '.week-skel-list--hoods i'), footer: await box(page, '.app-footer') };
  expect(before.footer.top).toBeGreaterThanOrEqual(await page.evaluate(() => window.innerHeight));
  release();
  await expect(page.locator('.week-stats')).toBeVisible();
  await expect(page.locator('.week-skel')).toHaveCount(0);
  const after = { stats: await box(page, '.week-stats'), tile: await box(page, '.week-stat'), type: await box(page, '.week-top .week-row'), hood: await box(page, '.week-hoods .week-row') };
  expect(Math.abs(after.stats.top - before.stats.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.tile.height - before.tile.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.type.height - before.type.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.hood.height - before.hood.height)).toBeLessThanOrEqual(1);
});

test('while the Week chunk itself loads, /week (and /week/) shows a screen-tall blank so the footer stays below the fold; a link that will 400 gets none', async ({ page }) => {
  for (const [path, tall] of [['/week', true], ['/week/', true], ['/week?until=2026-10-18', true], ['/week?until=2020-01-01', false], ['/week?until=garbage', false]] as const) {
    await setupWeek(page, { status: () => (tall ? 200 : 400), error: { error: 'too_old' } });
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    await page.route(/\/assets\/Week-[^/]*\.js$/, async (r) => { await gate; await r.continue(); });
    await page.goto(path);
    await expect(page.locator('.route-loading')).toHaveCount(tall ? 1 : 0);
    if (tall) expect(await page.locator('.app-footer').evaluate((e) => e.getBoundingClientRect().top >= window.innerHeight)).toBe(true);
    release();
    await expect(page.locator('main article.week')).toBeVisible();
    await expect(page.locator('.route-loading')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('lib/week: weekLinkProblem mirrors the Worker — null for the live week and the archive, invalid_until for malformed or future, too_old past the 56-day floor', async () => {
  const today = '2026-10-25';                                     // the Worker's floor for this day: 2026-08-30
  expect(weekLinkProblem(null, today)).toBeNull();
  expect(weekLinkProblem('', today)).toBeNull();
  expect(weekLinkProblem(today, today)).toBeNull();
  expect(weekLinkProblem('2026-10-18', today)).toBeNull();
  expect(weekLinkProblem('2026-08-30', today)).toBeNull();        // the week at the floor …
  expect(weekLinkProblem('2026-08-24', today)).toBeNull();        // … from its Monday
  expect(weekLinkProblem('2026-08-23', today)).toBe('too_old');   // the week before it
  expect(weekLinkProblem('2020-01-01', today)).toBe('too_old');
  expect(weekLinkProblem('2026-10-26', today)).toBe('invalid_until');
  // Mid-week, the coming Sunday names the week in progress; the day after it does not exist yet.
  expect(weekLinkProblem('2026-11-01', '2026-10-28')).toBeNull();
  expect(weekLinkProblem('2026-11-02', '2026-10-28')).toBe('invalid_until');
  expect(weekLinkProblem('garbage', today)).toBe('invalid_until');
  expect(weekLinkProblem('2026-10-1', today)).toBe('invalid_until');
  expect(weekLinkProblem('2026-02-30', today)).toBe('invalid_until');
  expect(weekLinkProblem('2026-10-18')).toBe(weekLinkProblem('2026-10-18', todayNY()));   // the default clock is Providence's today
});

test('a link the Worker will 400 (too old, malformed, future) loads without the tall skeleton: the short error view is what lands', async ({ page }) => {
  // Every shared dated link ages past the 56-day floor; a 1,400 px skeleton collapsing to three lines dropped the footer
  // onto the screen (CLS 0.35). The live week and in-range dates keep the skeleton (the test above).
  for (const [until, h1, error, message] of [
    ['2020-01-01', 'Providence, Dec 30 – Jan 5', 'too_old', 'That week is older than the eight weeks we keep.'],   // the Monday–Sunday week holding it
    ['garbage', 'This week in Providence', 'invalid_until', "That link doesn't point at a week we have."],
    ['2999-01-01', 'This week in Providence', 'invalid_until', "That link doesn't point at a week we have."],   // a future date is not 'dated' until the Worker says so
  ]) {
    await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    await page.route((u) => u.origin + u.pathname === `${API}/api/week`, async (r) => { await gate; await r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error }) }); });
    await page.goto(`/week?until=${until}`);
    await expect(page.locator('main h1')).toHaveText(h1);
    await expect(page.locator('main article')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.week-skel')).toHaveCount(0);
    release();
    await expect(page.locator('.notice-error[role="alert"]')).toHaveText(message);
    await expect(weekNav(page).getByRole('link', { name: 'Latest week' })).toHaveAttribute('href', '/week');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('Spanish, dated: title by range, weekday subtitle, the nav', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await setupWeek(page);
  await page.goto('/week?until=2026-10-18');
  await expect(page.locator('main h1')).toHaveText('Providence, 12 oct – 18 oct');
  await expect(page.locator('.week-range')).toHaveText('del lunes al domingo · 7 días');
  await expect(page.locator('.week-stat').nth(0).locator('.week-delta')).toHaveText('↑ 22 más que la semana pasada');
  const nav = page.getByRole('navigation', { name: 'Otras semanas' });
  await expect(nav.getByRole('link', { name: 'Semana anterior' })).toHaveAttribute('href', '/week?until=2026-10-11');
  await expect(nav.getByRole('link', { name: 'Semana siguiente' })).toHaveAttribute('href', '/week?until=2026-10-25');
  await expect(nav.getByRole('link', { name: 'Semana más reciente' })).toHaveAttribute('href', '/week');
});

test('Spanish: the page and its sections read in es', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await setupWeek(page);
  await page.goto('/week');
  await expect(page.locator('main h1')).toHaveText('Esta semana en Providence');
  await expect(page.locator('.week-range')).toHaveText('Desde el lunes 19 oct');
  await expect(page.locator('.week-h').first()).toHaveText('Lo más reportado');
  await expect(page.locator('.week-top .week-row-name').first()).toHaveText('Calles y aceras');
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

/* ── By neighborhood: the second line, Show all, and "Yours" for a signed-in reader's saved places ─────────────── */

const hoodRows = (page: Page) => page.locator('.week-hoods .week-row');
const hoodHrefs = (page: Page) => hoodRows(page).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
const TOP8 = ['elmhurst', 'west-end', 'downtown', 'fox-point', 'upper-south-providence', 'mount-pleasant', 'silver-lake', 'washington-park'].map((n) => `/street?n=${n}${D}`);
/** Whether the page fetched the neighborhood rings chunk (lib/neighborhoods' lazy import of shared/neighborhoods). */
const ringsLoaded = (page: Page) => page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/assets\/neighborhoods-[^/]*\.js$/.test(e.name)));

test('neighborhoods: Show all 10 / Show fewer opens and closes the rest — aria-expanded, a 44 px target, focus stays on the button; the singular line', async ({ page }) => {
  await open(page);
  await expect(hoodRows(page)).toHaveCount(8);
  const toggle = page.locator('.week-hoods-more');
  await expect(toggle).toHaveText('Show all 10 neighborhoods');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-controls', 'week-hoods-list');
  await expect(page.locator('#week-hoods-list')).toHaveCount(1);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(toggle).toHaveText('Show fewer');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  await expect(hoodRows(page)).toHaveCount(10);
  expect(await hoodHrefs(page)).toEqual([...TOP8, `/street?n=smith-hill${D}`, `/street?n=hope${D}`]);
  // One close of one day: both singular.
  await expect(hoodRows(page).nth(8).locator('.week-hood-sub')).toHaveText('1 closed · median 1 day');
  await expect(hoodRows(page).nth(9).locator('.week-hood-sub')).toHaveText('6 closed · median 2 days');
  expect(await hoodRows(page).nth(9).locator('.week-hood-bar > span').evaluate((e) => (e as HTMLElement).style.width)).toBe('33%'); // 16 / 48
  // The keyboard closes it again, and focus is still on it.
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveText('Show all 10 neighborhoods');
  await expect(toggle).toBeFocused();
  await expect(toggle).toBeInViewport({ ratio: 1 });
  await expect(hoodRows(page)).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

/** A full week: all 25 neighborhoods with activity, the last with a single request. */
const ALL25 = [
  ...WEEK.neighborhoods,
  ...['Blackstone', 'Mount Hope', 'College Hill', 'Wayland', 'Federal Hill', 'Valley', 'Elmwood', 'South Elmwood', 'Lower South Providence', 'Reservoir', 'Olneyville', 'Hartford', 'Manton', 'Charles', 'Wanskuck']
    .map((name, i) => ({ name, slug: name.toLowerCase().replace(/ /g, '-'), n: 15 - i, open: 15 - i, closed: 0, medianCloseDays: null })),
];

test('neighborhoods: a full week of 25 — Show fewer tapped at the bottom of the open list brings the button back on screen (17 rows, ~1,500 px, go from above it)', async ({ page }) => {
  await open(page, { body: { ...WEEK, neighborhoods: ALL25 } });
  const toggle = page.locator('.week-hoods-more');
  await toggle.click();
  await expect(hoodRows(page)).toHaveCount(25);
  await expect(hoodRows(page).last()).toHaveAccessibleName(/^Wanskuck\s*1 request\s*0 closed$/);   // the singular
  // Read down to the end of the list: the button sits in the lower part of the screen, the rows about to go above it.
  await toggle.evaluate((e) => window.scrollBy(0, e.getBoundingClientRect().bottom - window.innerHeight * 0.75));
  const vh = page.viewportSize()!.height;
  expect((await toggle.boundingBox())!.y).toBeGreaterThan(vh / 2);
  await toggle.click();
  await expect(hoodRows(page)).toHaveCount(8);
  await expect(toggle).toHaveText('Show all 25 neighborhoods');
  await expect(toggle).toBeFocused();
  await expect(toggle).toBeInViewport({ ratio: 1 });
  const box = (await toggle.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vh);
});

test('neighborhoods: eight or fewer with activity → no Show all button; an older Worker without medianCloseDays → "N closed" alone', async ({ page }) => {
  await open(page, { body: { ...WEEK, neighborhoods: WEEK.neighborhoods.slice(0, 8).map(({ medianCloseDays: _m, ...h }) => h) } });
  await expect(hoodRows(page)).toHaveCount(8);
  await expect(page.locator('.week-hoods-more')).toHaveCount(0);
  await expect(hoodRows(page).nth(0).locator('.week-hood-sub')).toHaveText('18 closed');
  await expect(page.locator('.week-hood-compare')).toHaveCount(0);
});

test('signed out: the plain top 8 — no Yours tag, no comparison line, no account call, and the rings never load', async ({ page }) => {
  const calls = await open(page);
  await expect(hoodRows(page)).toHaveCount(8);
  expect(await hoodHrefs(page)).toEqual(TOP8);
  await expect(page.locator('.week-hood-yours')).toHaveCount(0);
  await expect(page.locator('.week-hood-compare')).toHaveCount(0);
  expect(calls.filter((c) => c.url.includes('/api/me'))).toEqual([]);
  await page.waitForTimeout(300);
  expect(await ringsLoaded(page)).toBe(false);
});

test('signed in without placed addresses (none, or none with coordinates): the plain list, and the rings never load', async ({ page }) => {
  await open(page, { signedIn: true, me: { addresses: [{ id: 'x', label: 'Somewhere', address: 'Unplaced Rd', lat: null, lng: null }] } });
  await expect(page.getByRole('button', { name: 'Email me every Monday' })).toBeVisible();   // the account has loaded
  await page.waitForTimeout(300);
  expect(await hoodHrefs(page)).toEqual(TOP8);
  await expect(page.locator('.week-hood-yours')).toHaveCount(0);
  expect(await ringsLoaded(page)).toBe(false);
});

test('signed in with saved places: their hoods say Yours and are pinned on top in list order — one outside the top 8, one with nothing this week — and one line compares the first median with the city\'s', async ({ page }) => {
  const calls = await open(page, { signedIn: true, me: { addresses: PLACES } });
  const yours = page.locator('.week-hood-yours');
  await expect(yours).toHaveCount(3);
  expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/me'))).toHaveLength(1);   // the account the digest card loads; no new endpoint
  expect(await ringsLoaded(page)).toBe(true);
  // Fox Point (4th) and Hope (10th) in the list's order, then College Hill (no activity); then the rest of the top 8.
  expect(await hoodHrefs(page)).toEqual([
    'fox-point', 'hope', 'college-hill',
    'elmhurst', 'west-end', 'downtown', 'upper-south-providence', 'mount-pleasant', 'silver-lake', 'washington-park',
  ].map((n) => `/street?n=${n}${D}`));
  const rows = hoodRows(page);
  await expect(yours.first()).toHaveText('Yours');
  for (const i of [0, 1, 2]) await expect(rows.nth(i)).toHaveClass(/week-hood--yours/);
  await expect(rows.nth(3)).not.toHaveClass(/week-hood--yours/);
  await expect(rows.nth(0)).toHaveAccessibleName(/^Fox Point\s*Yours\s*30 requests\s*11 closed · median 4\.5 days$/);
  await expect(rows.nth(1).locator('.week-row-n > [aria-hidden="true"]')).toHaveText('16');
  await expect(rows.nth(1).locator('.week-hood-sub')).toHaveText('6 closed · median 2 days');
  // Nothing this week: no count, no bar, the words instead — still a door into /street.
  await expect(rows.nth(2).locator('.week-hood-name')).toHaveText('College Hill Yours');
  await expect(rows.nth(2).locator('.week-hood-sub')).toHaveText('Nothing reported');
  await expect(rows.nth(2).locator('.week-row-n')).toHaveCount(0);
  await expect(rows.nth(2).locator('.week-hood-bar')).toHaveCount(0);
  await expect(page.locator('.week-hood-compare')).toHaveText("In Fox Point, closed requests took a median 4.5 days — the city's was 3.5 days.");
  // Show all adds only what was hidden (Smith Hill); the pinned rows stay on top and Hope is not listed twice. The
  // button names the rows the open list will hold (10 with activity + quiet College Hill), not the 10 with activity.
  await page.getByRole('button', { name: 'Show all 11 neighborhoods' }).click();
  await expect(rows).toHaveCount(11);
  expect((await hoodHrefs(page)).slice(0, 3)).toEqual(['fox-point', 'hope', 'college-hill'].map((n) => `/street?n=${n}${D}`));
  expect((await hoodHrefs(page)).filter((h) => h === `/street?n=hope${D}`)).toHaveLength(1);
  await expect(rows.last()).toHaveAttribute('href', `/street?n=smith-hill${D}`);
  await rows.nth(2).click();
  await expect(page).toHaveURL(/\/street\?n=college-hill&from=2026-10-19&to=2026-10-25$/);
});

test('the comparison takes the first yours-hood WITH a median (singular day); a reader whose only hood was quiet gets that row pinned and no comparison', async ({ page }) => {
  const body = { ...WEEK, neighborhoods: WEEK.neighborhoods.map((h) => (h.slug === 'fox-point' ? { ...h, medianCloseDays: null } : h.slug === 'hope' ? { ...h, medianCloseDays: 1 } : h)) };
  await open(page, { signedIn: true, me: { addresses: PLACES }, body });
  await expect(page.locator('.week-hood-yours')).toHaveCount(3);
  await expect(hoodRows(page).nth(0).locator('.week-hood-sub')).toHaveText('11 closed');
  await expect(page.locator('.week-hood-compare')).toHaveText("In Hope, closed requests took a median 1 day — the city's was 3.5 days.");
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await setupWeek(page, { signedIn: true, me: { addresses: [PLACES[1]] } });
  await page.goto('/week');
  await expect(page.locator('.week-hood-yours')).toHaveCount(1);
  expect(await hoodHrefs(page)).toEqual([`/street?n=college-hill${D}`, ...TOP8]);
  await expect(hoodRows(page).nth(0).locator('.week-hood-sub')).toHaveText('Nothing reported');
  await expect(page.locator('.week-hood-compare')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show all 11 neighborhoods' })).toBeVisible();
});

test('Spanish: the second line, Tuyo, Nada reportado, the toggle and the comparison read in es', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
  await setupWeek(page, { signedIn: true, me: { addresses: PLACES } });
  await page.goto('/week');
  await expect(page.locator('.week-hood-yours')).toHaveCount(3);
  const rows = hoodRows(page);
  await expect(page.locator('.week-hood-yours').first()).toHaveText('Tuyo');
  await expect(rows.nth(0).locator('.week-hood-sub')).toHaveText('11 cerradas · mediana de 4,5 días');
  await expect(rows.nth(0)).toHaveAccessibleName(/^Fox Point\s*Tuyo\s*30 solicitudes\s*11 cerradas · mediana de 4,5 días$/);
  await expect(rows.nth(2).locator('.week-hood-sub')).toHaveText('Nada reportado');
  await expect(page.locator('.week-hood-compare')).toHaveText('En Fox Point, las solicitudes cerradas tardaron una mediana de 4,5 días; en toda la ciudad, 3,5 días.');
  const toggle = page.locator('.week-hoods-more');
  await expect(toggle).toHaveText('Ver los 11 vecindarios'); // the 10 with activity + the reader's quiet College Hill
  await toggle.click();
  await expect(toggle).toHaveText('Ver menos');
  await expect(rows.last().locator('.week-hood-sub')).toHaveText('1 cerrada · mediana de 1 día');
});
