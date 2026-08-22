import { test, expect, type Page } from '@playwright/test';

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

const THREE = [
  { id: 'a1', category: 'pothole', categoryLabel: 'Pothole in Road', lat: 41.824, lng: -71.412, address: '25 Dorrance St', createdAt: new Date(Date.now() - 3_600_000).toISOString(), status: 'sent', portalStatus: 'Resolved' },
  { id: 'b2', category: 'missed_trash', categoryLabel: 'Missed Trash Day Pick-up Issue', lat: 41.831, lng: -71.401, address: '100 Hope St', createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), status: 'sent', portalStatus: 'Submitted' },
  { id: 'c3', category: 'street_light', categoryLabel: 'Street Light Out', lat: 41.818, lng: -71.421, address: '5 Broad St', createdAt: new Date(Date.now() - 600_000).toISOString(), status: 'received', portalStatus: null },
];

async function setup(page: Page, items: object[]) {
  // Never hit real OSM tiles.
  await page.route('https://*.tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/api/public-feed*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items }) }));
}

test('list renders 3 rows with correct labels and tracking links', async ({ page }) => {
  await setup(page, THREE);
  await page.goto('/map');
  const rows = page.locator('.feed-row');
  await expect(rows).toHaveCount(3);
  await expect(page.getByText('Pothole in Road')).toBeVisible();
  await expect(page.getByText('Street Light Out')).toBeVisible();
  await expect(rows.first()).toHaveAttribute('href', '/r/a1');
  await expect(page.locator('.feed-pill--resolved')).toHaveText(/resolved/i);
});

test('map container exists with an aria-label and 3 markers', async ({ page }) => {
  await setup(page, THREE);
  await page.goto('/map');
  const map = page.locator('.leaflet-container');
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute('aria-label', /.+/);
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(3);
});

test('empty feed shows the empty state', async ({ page }) => {
  await setup(page, []);
  await page.goto('/map');
  await expect(page.locator('.feed-empty')).toBeVisible();
  await expect(page.locator('.feed-row')).toHaveCount(0);
});
