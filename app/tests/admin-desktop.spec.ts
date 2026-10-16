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

test('every tab is reachable from the rail and keeps the hash', async ({ page }) => {
  await page.goto('/admin');
  for (const tab of TABS) {
    await page.getByRole('tab', { name: new RegExp(`^${tab === 'explain' ? 'How it works' : tab === 'questions' ? 'City questions' : tab}`, 'i') }).click();
    await expect(page).toHaveURL(new RegExp(`#${tab}$`));
  }
});
