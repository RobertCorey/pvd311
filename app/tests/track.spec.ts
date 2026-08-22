import { test, expect, type Page } from '@playwright/test';

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

interface ViewOverrides {
  status?: string; portalStatus?: string | null; portalCaseId?: string | null;
  photoUrl?: string | null; lat?: number | null; lng?: number | null;
  timeline?: { at: string; label: string }[]; nextUpdateHint?: string | null;
}

function view(o: ViewOverrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'abc',
    category: 'pothole',
    categoryLabel: 'Pothole',
    address: '120 Benefit St, Providence, RI',
    lat: o.lat ?? 41.8268,
    lng: o.lng ?? -71.4053,
    photoUrl: o.photoUrl ?? null,
    createdAt: now,
    status: o.status ?? 'sent',
    portalCaseId: o.portalCaseId ?? 'PVD2026-87657',
    portalStatus: o.portalStatus ?? 'Assigned',
    timeline: o.timeline ?? [
      { at: now, label: 'Received by FixMyPVD' },
      { at: now, label: 'Sent to the city' },
    ],
    nextUpdateHint: o.nextUpdateHint ?? 'We check the city for updates daily.',
  };
}

async function mockReport(page: Page, body: object, status = 200) {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/reports/*`, (r) =>
    r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

test('sent + Assigned shows the case id and a city status row', async ({ page }) => {
  await mockReport(page, view());
  await page.goto('/r/abc');
  await expect(page.getByText('PVD2026-87657')).toBeVisible();
  await expect(page.getByRole('heading', { name: /a city crew is on it/i })).toBeVisible();
  await expect(page.getByText('Sent to the city')).toBeVisible();
});

test('unknown token shows the not-found state', async ({ page }) => {
  await mockReport(page, { error: 'not_found' }, 404);
  await page.goto('/r/missing');
  await expect(page.getByRole('heading', { name: /can.?t find that report/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /report something/i })).toBeVisible();
});

test('justSubmitted (?submitted=1) shows the confirmation header', async ({ page }) => {
  await mockReport(page, view());
  await page.goto('/r/abc?submitted=1');
  await expect(page.getByRole('heading', { name: /sent to providence 311/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /copy link/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /report another problem/i })).toBeVisible();
});

test('copy-link button writes the tracking url to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockReport(page, view());
  await page.goto('/r/abc?submitted=1');
  await page.getByRole('button', { name: /copy link/i }).click();
  await expect(page.getByRole('button', { name: /copied/i })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('/r/abc');
});

test('cancelled report explains and links to the official portal', async ({ page }) => {
  await mockReport(page, view({ portalStatus: 'Cancelled' }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: /the city closed this one/i })).toBeVisible();
  await expect(page.locator('.track-status').getByRole('link', { name: /official 311 portal/i })).toBeVisible();
});
