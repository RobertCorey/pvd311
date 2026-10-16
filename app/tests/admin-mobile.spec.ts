import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { mockAdmin, TABS } from './admin-mocks';

// /admin on Rob's phone (Rob, 2026-10-16: "I'm using it"): Android, 1080×2424 screenshot → ~412×915 CSS px.
// Every tab: no sideways scrolling, a sticky one-row tab strip, tap-sized controls; queue rows are cards whose
// actions are on screen; the detail pane is a full-screen sheet. Reference screenshots: admin-mobile-<tab>.png (not asserted).
test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => { mkdirSync('tests/__screenshots__', { recursive: true }); await mockAdmin(page); });

const hScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const tall = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!.height;

for (const tab of TABS) {
  test(`${tab}: fits the phone, the tab strip sticks, the current tab is in view`, async ({ page }) => {
    await page.goto(`/admin#${tab}`);
    const strip = page.locator('.admin-rail-nav');
    const current = strip.locator('[aria-selected="true"]');
    await expect(current).toBeVisible();
    await expect(page.locator('.admin-main-title')).toBeVisible();
    await page.waitForTimeout(400); // the strip's smooth scroll to the current tab
    const s = (await strip.boundingBox())!;
    const c = (await current.boundingBox())!;
    expect(c.x).toBeGreaterThanOrEqual(-1);
    expect(c.x + c.width).toBeLessThanOrEqual(s.x + s.width + 1);
    expect(await hScroll(page)).toBe(0);
    expect(s.height).toBeLessThanOrEqual(64);
    expect(await tall(page, '.admin-rail-tab')).toBeGreaterThanOrEqual(40);
    // desktop-only furniture is gone
    await expect(page.locator('.admin-rail-title')).toBeHidden();
    await expect(page.locator('.admin-keys')).toBeHidden();
    await page.screenshot({ path: `tests/__screenshots__/admin-mobile-${tab}.png` });
    // the strip stays pinned at the top while the page scrolls
    await page.mouse.wheel(0, 1500);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(100);
    if (await page.evaluate(() => window.scrollY) > 100) expect(Math.round((await strip.boundingBox())!.y)).toBe(0);
  });
}

test('queue: rows are cards with the approve button on screen; the engine strip is one compact row', async ({ page }) => {
  await page.goto('/admin#queue');
  const cards = page.locator('.admin-table--rows tbody tr');
  await expect(cards).toHaveCount(3);
  const first = (await cards.first().boundingBox())!;
  expect(first.x).toBeGreaterThanOrEqual(0);
  expect(first.x + first.width).toBeLessThanOrEqual(412);
  const approve = cards.first().getByRole('button', { name: 'Approve & send' });
  await expect(approve).toBeInViewport();
  expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await expect(page.locator('.admin-rail-search input')).toBeVisible();
  expect(await tall(page, '.admin-rail-engine')).toBeLessThanOrEqual(90);
  await expect(page.locator('.admin-rail-engine').getByRole('button', { name: 'Pause engine' })).toBeVisible();
});

test('queue: tapping a card opens the report as a full-screen sheet with thumb-size actions; ✕ closes it', async ({ page }) => {
  await page.goto('/admin#queue');
  await page.locator('.admin-table--rows tbody tr').first().locator('.admin-td-addr').tap();
  const pane = page.locator('.admin-pane');
  await expect(pane).toBeVisible();
  const box = (await pane.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.y).toBe(0);
  expect(box.width).toBe(412);
  expect(box.height).toBeGreaterThanOrEqual(900);
  const approve = pane.getByRole('button', { name: /Approve & send/ });
  await expect(approve).toBeInViewport();
  expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const k of await pane.locator('kbd').all()) await expect(k).toBeHidden(); // no keyboard hints on a touchscreen
  await pane.locator('.admin-pane-close').tap();
  await expect(pane).toBeHidden();
});

test('search shows on the queue only; the engine strip only on overview / queue / system', async ({ page }) => {
  await page.goto('/admin#events');
  await expect(page.locator('.admin-rail-search')).toBeHidden();
  await expect(page.locator('.admin-rail-engine')).toBeHidden();
  await page.locator('.admin-rail-tab', { hasText: 'Overview' }).tap();
  await expect(page.locator('.admin-rail-engine')).toBeVisible();
  await expect(page.locator('.admin-rail-search')).toBeHidden();
});

test('events, accounts and config read as cards: no header row, every value labelled or self-evident', async ({ page }) => {
  await page.goto('/admin#events');
  await expect(page.locator('.sys-events-table thead')).toBeHidden();
  const ev = page.locator('.sys-events-table tbody tr').first();
  expect((await ev.boundingBox())!.width).toBeLessThanOrEqual(412);
  await page.goto('/admin#accounts');
  const acct = page.locator('.acct-table tbody tr').first();
  await expect(acct.locator('td[data-label]').first()).toBeVisible();
  expect(await acct.locator('td[data-label]').first().evaluate((el) => getComputedStyle(el, '::before').content)).toContain('Provider');
  await page.goto('/admin#config');
  await expect(page.locator('.cfg-table thead')).toBeHidden();
  expect(await hScroll(page)).toBe(0);
});
