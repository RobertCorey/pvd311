import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { mockAdmin, TABS } from './admin-mocks';

// Desktop /admin (14" MacBook, 1512×982): layout sanity + one reference screenshot per tab for eyeballing.
// Screenshots land in app/tests/__screenshots__/admin-<tab>.png (not asserted against).
test.use({ viewport: { width: 1512, height: 982 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

test.beforeEach(async ({ page }) => { mkdirSync('tests/__screenshots__', { recursive: true }); await mockAdmin(page); });

const noHScroll = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test('queue: rail + table + 480px detail pane, no phone chrome', async ({ page }) => {
  await page.goto('/admin#queue');
  await expect(page.locator('.admin-rail')).toBeVisible();
  await expect(page.locator('.tabbar')).toBeHidden();
  await expect(page.locator('.app-footer')).toBeHidden();
  await expect(page.locator('.admin-table tbody tr')).toHaveCount(3);
  await page.locator('.admin-table tbody tr').first().click();
  const pane = page.locator('.admin-pane');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.admin-proofs img')).toHaveCount(1);
  const coords = pane.locator('a[href^="https://www.google.com/maps/search/"]');
  await expect(coords).toHaveText('41.82680, -71.40530');
  await expect(coords).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=41.8268,-71.4053');
  await expect(coords).toHaveAttribute('target', '_blank');
  const box = await pane.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(470);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1512);
  expect(await noHScroll(page)).toBe(false);
  await page.screenshot({ path: 'tests/__screenshots__/admin-queue.png' });
});

test('system: 5-wide subsystem grid, 3-col row, events table', async ({ page }) => {
  await page.goto('/admin#system');
  await expect(page.locator('.sys-grid .sys-card')).toHaveCount(10);
  const tops = await page.locator('.sys-grid .sys-card').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(2);
  await expect(page.locator('.sys-events-table tbody tr')).toHaveCount(24);
  expect(await noHScroll(page)).toBe(false);
  await page.screenshot({ path: 'tests/__screenshots__/admin-system.png', fullPage: true });
});

test('overview: needs-you list, counts, lights, last events', async ({ page }) => {
  await page.goto('/admin#overview');
  await expect(page.locator('.admin-ov-needs li')).toHaveCount(4); // awaiting 3, failed 1, case ids pending, watcher warn
  await expect(page.locator('.admin-ov-lights .admin-light')).toHaveCount(10);
  await expect(page.locator('.sys-events-table tbody tr')).toHaveCount(10);
  await page.getByRole('button', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/#queue$/);
  await page.goto('/admin#overview');
  await page.screenshot({ path: 'tests/__screenshots__/admin-overview.png', fullPage: true });
});

test('reports: filters, cursor paging, deep link by q, detail pane', async ({ page }) => {
  await page.goto('/admin#reports?q=neighbor%40example.com');
  await expect(page.locator('.admin-filters input[type=search]')).toHaveValue('neighbor@example.com');
  await expect(page.locator('.admin-table tbody tr')).toHaveCount(8);
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible();
  await page.locator('.admin-table tbody tr').last().click();
  await expect(page.locator('.admin-pane')).toContainText('Auto-rejected');
  await page.locator('.admin-pane').getByRole('button', { name: 'Raw JSON' }).click();
  await expect(page.locator('.admin-pane .admin-raw')).toContainText('"intakeFlags"');
  await page.screenshot({ path: 'tests/__screenshots__/admin-reports.png' });
});

test('events: filters + raw data toggle', async ({ page }) => {
  await page.goto('/admin#events');
  await expect(page.locator('.sys-events-table tbody tr.sys-event')).toHaveCount(100);
  await page.getByRole('button', { name: 'Raw JSON' }).first().click();
  await expect(page.locator('.admin-raw-row')).toHaveCount(1);
  await page.screenshot({ path: 'tests/__screenshots__/admin-events.png' });
});

for (const tab of ['usage', 'accounts', 'portal', 'config', 'explain'] as const) {
  test(`${tab}: renders with data, no horizontal scroll`, async ({ page }) => {
    await page.goto(`/admin#${tab}`);
    await expect(page.locator('.admin-main')).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator('.admin-main')).not.toContainText(/Loading…|Cargando/);
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: `tests/__screenshots__/admin-${tab}.png`, fullPage: true });
  });
}

test('engagement: seven tiles in one row, the two run cards side by side, runs + mail tables, no horizontal scroll', async ({ page }) => {
  await page.goto('/admin#engagement');
  const main = page.locator('.admin-main');
  await expect(main.locator('h1')).toContainText('Engagement');
  const tiles = main.locator('.eng-tile');
  await expect(tiles).toHaveCount(7);
  const tops = await tiles.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  const cards = main.locator('.eng-card');
  await expect(cards).toHaveCount(2);
  const [a, b] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
  expect(Math.round(a!.y)).toBe(Math.round(b!.y));
  await expect(main.locator('.eng-events tbody tr')).toHaveCount(9);
  await expect(main.locator('.eng-mails tbody tr')).toHaveCount(13);
  await expect(main.locator('.eng-events thead')).toBeVisible();
  expect(await noHScroll(page)).toBe(false);
  await page.screenshot({ path: 'tests/__screenshots__/admin-engagement.png', fullPage: true });
});

test('city questions: explainer, ranked category × question table, counts, flags, notes — read-only', async ({ page }) => {
  await page.goto('/admin#questions');
  const main = page.locator('.admin-main');
  await expect(main.locator('h1')).toContainText('City questions');
  // in-page explainer
  await expect(main.locator('.cq-how dt')).toHaveText(['Which questions', 'Every live filing', 'Flags', 'Order']);
  // one band per category: the 27 seeded categories + street_light (a live-only new question)
  const cats = main.locator('.cq-table tbody th.cq-cat');
  await expect(cats).toHaveCount(28);
  // ranked by blanks × demand: tree (7 × 33) > noise (3 × 5) > graffiti_private (9 × 0); then unfiled by demand (missed trash 27/wk first)
  await expect(cats.nth(0)).toContainText('tree');
  await expect(cats.nth(1)).toContainText('noise');
  await expect(cats.nth(2)).toContainText('missed_trash');
  await expect(main.locator('tr[data-category="missed_trash"]')).toContainText(/no extra questions.*show\/hide script is broken/);
  // columns + per-question cells
  await expect(main.locator('.cq-table thead th')).toHaveText(['Category', 'City question', 'Choices', 'How answered', 'Last seen live', 'Flags']);
  const treework = main.locator('tr', { has: page.locator('.sys-kind', { hasText: /^cop_treework$/ }) }).first();
  await expect(treework).toContainText('On/off toggle');
  await expect(treework).toContainText('Blank 6');
  await expect(treework).toContainText("bot can't see toggles");
  const noise = main.locator('tr[data-category="noise"]');
  await expect(noise).toContainText('AI 1');
  await expect(noise).toContainText('Blank 3');
  await expect(noise.locator('.admin-flag')).toHaveText('Choices changed');
  await expect(noise).toContainText('+ Construction');
  await expect(noise).toContainText('− Car');
  const pothole = main.locator('tr[data-category="pothole"]');
  await expect(pothole).toContainText('App 9');
  await expect(pothole).toContainText('App sends: Small (~4in)');
  await expect(pothole.locator('.admin-flag')).toHaveText('App choice stale');
  await expect(main.locator('tr[data-category="street_light"] .admin-flag')).toHaveText('New question');
  await expect(main.locator('tr[data-category="illegal_housing"]')).toContainText('not yet filed');
  // read-only: no action buttons in the table
  await expect(main.locator('.cq-table button')).toHaveCount(0);
  expect(await noHScroll(page)).toBe(false);
  await page.screenshot({ path: 'tests/__screenshots__/admin-questions.png' });
});

test('city cases: everyone\'s public-feed cases; a row opens the city\'s detail form fields, plate included', async ({ page }) => {
  await page.goto('/admin#cases');
  const main = page.locator('.admin-main');
  await expect(main.locator('h1')).toContainText('City cases');
  await expect(main.locator('tbody tr')).toHaveCount(3);
  await expect(main).toContainText('231 tracked');
  await expect(main.locator('tbody tr').nth(1)).toContainText('Reported to HHS');
  await main.locator('tbody tr').first().click();
  const pane = page.locator('.admin-pane');
  await expect(pane).toContainText('10 Example St, Providence, RI, 02900, USA');
  await expect(pane).toContainText('Vehicle Details');
  await expect(pane).toContainText('TEST123');
  await expect(pane).toContainText('Routed');
  await main.locator('tbody tr').nth(2).click();
  await expect(pane).toContainText('City detail form not read yet');
  await page.screenshot({ path: 'tests/__screenshots__/admin-cases.png' });
});

test('city cases → how it gets done: tiles, outcome bars with counts in text, a case type opens its cases', async ({ page }) => {
  await page.goto('/admin#cases');
  await page.getByRole('button', { name: 'How it gets done' }).click();
  const main = page.locator('.admin-main');
  await expect(main.locator('.ci-tiles')).toContainText('Closed with work done');
  await expect(main.locator('.ci-tiles')).toContainText('44%'); // 4 work done of 9 closed
  await expect(main.locator('.ci-legend li')).toHaveCount(8);
  const trees = main.locator('tr.ci-group', { hasText: 'Trees, parks & yards' });
  await expect(trees).toContainText('Work done 4');
  await expect(trees.locator('.ci-bar')).toHaveAttribute('aria-label', /Work done 4, Nothing found \/ no note 1, Cancelled or merged 1, Still open 8/);
  await trees.click();
  await expect(main.locator('tr.ci-type')).toContainText('“Pick up completed” ×2');
  await page.screenshot({ path: 'tests/__screenshots__/admin-cases-insights.png' });
  await main.locator('tr.ci-type').click();
  await expect(main.locator('input[type="search"]')).toHaveValue('Tree Related Issue(s)');
  await expect(page.getByRole('button', { name: 'Cases', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('every tab is reachable from the rail and keeps the hash', async ({ page }) => {
  await page.goto('/admin');
  for (const tab of TABS) {
    await page.getByRole('tab', { name: new RegExp(`^${tab === 'explain' ? 'How it works' : tab === 'questions' ? 'City questions' : tab === 'cases' ? 'City cases' : tab}`, 'i') }).click();
    await expect(page).toHaveURL(new RegExp(`#${tab}$`));
  }
});

// ── Three angles on the same system (Rob, 2026-10-16): by email, by report, by person ──

test('email: every mail in and out, filterable; a row opens it with its report and people', async ({ page }) => {
  await page.goto('/admin#email');
  const rows = page.locator('.email-table tbody tr');
  await expect(rows).toHaveCount(6);
  await expect(page.locator('.email-totals')).toContainText('6 shown · 4 sent · 2 received');
  await expect(page.locator('select option[value="signin_link"]')).toHaveCount(0); // sign-in link emails are not in the log
  await expect(page.locator('.email-trouble')).toHaveText('1 failed or bounced');
  await expect(rows.filter({ hasText: 'Your report was filed' }).locator('.email-pill')).toHaveText('Bounced');
  await page.getByRole('button', { name: 'Received', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(rows).toHaveCount(6);
  await rows.filter({ hasText: 'needs more information about your report' }).click();
  await expect(page).toHaveURL(/#email:rs_ask$/);
  const pane = page.locator('.email-pane');
  await expect(pane.locator('.email-subject')).toHaveText('The city needs more information about your report (PVD2026-90412)');
  await expect(pane.locator('.email-text')).toContainText('Please respond to this email by providing');
  await expect(pane.getByRole('link', { name: 'Noise complaint · 25 Dorrance St' })).toHaveAttribute('href', '#reports?q=aaaaaaaaaaa3');
  await expect(pane.getByRole('link', { name: 'resident0@example.com' })).toHaveAttribute('href', '#accounts:uid_0xxxxxxxxxxxxxxxxxxxxxxxx');
  expect(await noHScroll(page)).toBe(false);
  await page.screenshot({ path: 'tests/__screenshots__/admin-email.png' });
  await pane.getByRole('button', { name: 'Close' }).click();
  await expect(pane).toBeHidden();
  await expect(page).toHaveURL(/#email$/);
});

test('report pane lists the report\'s email; one click opens that mail in Email', async ({ page }) => {
  await page.goto('/admin#queue');
  await page.locator('.admin-table tbody tr').first().click();
  const pane = page.locator('.admin-pane');
  await expect(pane.getByRole('heading', { name: /^Email \(\d+\)$/ })).toBeVisible();
  const mail = pane.locator('.email-row').first();
  await expect(mail).toContainText('City needs info');
  await mail.click();
  await expect(page).toHaveURL(/#email:rs_ask$/);
  await expect(page.locator('.email-pane .email-subject')).toBeVisible();
});

test('accounts: a row opens the person — account, their reports, their email — and links on', async ({ page }) => {
  await page.goto('/admin#accounts');
  await page.locator('.acct-table tbody tr').first().click();
  await expect(page).toHaveURL(/#accounts:uid_0x+$/);
  const pane = page.locator('.user-pane');
  await expect(pane.locator('.admin-pane-head')).toContainText('resident0@example.com');
  await expect(pane.getByRole('heading', { name: 'Reports (2)' })).toBeVisible();
  await expect(pane.getByRole('heading', { name: /^Email \(\d+\)$/ })).toBeVisible();
  await expect(pane.locator('a.email-row[href^="#reports?q="]').first()).toBeVisible();
  await pane.locator('a.email-row[href^="#email:"]').first().click();
  await expect(page).toHaveURL(/#email:/);
  await expect(page.locator('.email-pane')).toBeVisible();
});
