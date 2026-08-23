import { test, expect, type Page } from '@playwright/test';

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

interface ViewOverrides {
  status?: string; portalStatus?: string | null; portalCaseId?: string | null;
  photoUrl?: string | null; lat?: number | null; lng?: number | null;
  timeline?: { at: string; label: string }[]; nextUpdateHint?: string | null;
  notFiled?: { code: string; text: string; duplicateOf?: string | null } | null;
  cancelledByReporter?: boolean;
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
    portalCaseId: 'portalCaseId' in o ? o.portalCaseId : 'PVD2026-87657',
    portalStatus: 'portalStatus' in o ? o.portalStatus : 'Assigned',
    timeline: o.timeline ?? [
      { at: now, label: 'Received by FixMyPVD' },
      { at: now, label: 'Sent to the city' },
    ],
    nextUpdateHint: o.nextUpdateHint ?? 'We check the city for updates daily.',
    notFiled: o.notFiled ?? null,
    cancelledByReporter: o.cancelledByReporter ?? false,
  };
}

/** A not-filed report: rejected, no case id, `notFiled` set. */
function notFiledView(code: string, extra: Partial<ViewOverrides> = {}) {
  const now = new Date().toISOString();
  return view({
    status: 'rejected', portalStatus: null, portalCaseId: null,
    timeline: [{ at: now, label: 'Received' }, { at: now, label: 'Not filed' }],
    notFiled: { code, text: extra.notFiled?.text ?? '', duplicateOf: extra.notFiled?.duplicateOf ?? null },
    ...extra,
  });
}

async function mockReport(page: Page, body: object, status = 200) {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/reports/*`, (r) =>
    r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

async function useSpanish(page: Page) {
  await page.addInitScript(() => localStorage.setItem('snappvd.lang', 'es'));
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

test('not filed (duplicate) shows the reason, both next steps, and no case number', async ({ page }) => {
  await mockReport(page, notFiledView('duplicate', {
    notFiled: { code: 'duplicate', text: 'Someone reported this pothole two days ago.', duplicateOf: 'xyz789' },
  }));
  await page.goto('/r/abc');
  await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toBeVisible();
  await expect(page.getByText('Someone reported this pothole two days ago.')).toBeVisible();
  await expect(page.getByRole('link', { name: /view that report/i })).toHaveAttribute('href', '/r/xyz789');
  await expect(page.getByRole('link', { name: /report anyway/i })).toHaveAttribute('href', '/');
  await expect(page.getByText('No city case number — this was never filed with 311.')).toBeVisible();
  // no contradictory city-case chip when nothing was filed
  await expect(page.locator('.track-case')).toHaveCount(0);
  // rail ends at the failure — no future steps ahead
  await expect(page.getByText('City working on it')).toHaveCount(0);
  await expect(page.getByText('Resolved', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: process.env.NOTFILED_SHOT || 'notfiled.png', fullPage: true });
});

for (const code of ['reviewed', 'outside', 'no_photo']) {
  test(`not filed (${code}) offers report-again with a photo and location`, async ({ page }) => {
    await mockReport(page, notFiledView(code, { notFiled: { code, text: 'We couldn’t confirm the location.' } }));
    await page.goto('/r/abc');
    await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /report again with a photo and the exact location/i })).toHaveAttribute('href', '/');
    await expect(page.getByText('City working on it')).toHaveCount(0);
  });
}

test('not filed (failed) says a person is looking at it, with nothing to do', async ({ page }) => {
  await mockReport(page, notFiledView('failed', { notFiled: { code: 'failed', text: '' } }));
  await page.goto('/r/abc');
  await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toBeVisible();
  await expect(page.getByText(/a person is looking at it/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /report again/i })).toHaveCount(0);
});

test('cancelled-by-you stays distinct from not filed and shows no case number', async ({ page }) => {
  await mockReport(page, notFiledView('cancelled', { cancelledByReporter: true, notFiled: { code: 'cancelled', text: '' } }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: /cancelled by you/i })).toBeVisible();
  await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toHaveCount(0);
  await expect(page.getByText('No city case number — this was never filed with 311.')).toBeVisible();
});

test('spanish localizes the not-filed heading, timeline labels, and category', async ({ page }) => {
  await useSpanish(page);
  await mockReport(page, notFiledView('reviewed', { notFiled: { code: 'reviewed', text: '' } }));
  await page.goto('/r/abc');
  await expect(page.locator('.track-status').getByRole('heading', { name: /no presentado/i })).toBeVisible();
  // server timeline labels ("Received", "Not filed") render localized
  await expect(page.locator('.track-timeline').getByText('Recibido')).toBeVisible();
  await expect(page.locator('.track-timeline').getByText('No presentado')).toBeVisible();
  // category from the key, not the English categoryLabel
  await expect(page.locator('.track-cat-label')).toHaveText('Bache');
  await expect(page.getByText('Pothole')).toHaveCount(0);
});
