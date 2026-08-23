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

for (const tab of ['accounts', 'portal', 'config', 'explain'] as const) {
  test(`${tab}: renders with data, no horizontal scroll`, async ({ page }) => {
    await page.goto(`/admin#${tab}`);
    await expect(page.locator('.admin-main')).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator('.admin-main')).not.toContainText(/Loading…|Cargando/);
    expect(await noHScroll(page)).toBe(false);
    await page.screenshot({ path: `tests/__screenshots__/admin-${tab}.png`, fullPage: true });
  });
}

test('every tab is reachable from the rail and keeps the hash', async ({ page }) => {
  await page.goto('/admin');
  for (const tab of TABS) {
    await page.getByRole('tab', { name: new RegExp(`^${tab === 'explain' ? 'How it works' : tab}`, 'i') }).click();
    await expect(page).toHaveURL(new RegExp(`#${tab}$`));
  }
});
