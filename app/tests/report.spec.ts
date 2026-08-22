import { test, expect, type Page } from '@playwright/test';

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

async function mockApi(page: Page, opts: { intake?: object; reportStatus?: number; reportBody?: object } = {}) {
  await page.addInitScript(() => { (window as unknown as { __TURNSTILE_TOKEN__: string }).__TURNSTILE_TOKEN__ = 'test-token'; });
  await page.route(`${API}/api/intake`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.intake ?? { polishedDescription: null, flags: [], note: null, model: 'mock' }) }));
  await page.route(`${API}/api/report`, (r) => r.fulfill({ status: opts.reportStatus ?? 201, contentType: 'application/json', body: JSON.stringify(opts.reportBody ?? { id: 'abc123xyz', trackingUrl: '/r/abc123xyz', category: 'missed_trash', createdAt: new Date().toISOString() }) }));
  await page.route(`${API}/api/reports/*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'abc123xyz', category: 'missed_trash', categoryLabel: 'Missed Trash Day Pick-up Issue', address: '25 Dorrance St', lat: null, lng: null, photoUrl: null, createdAt: new Date().toISOString(), status: 'received', portalCaseId: null, portalStatus: null, timeline: [{ at: new Date().toISOString(), label: 'Received' }], nextUpdateHint: null }) }));
  await page.route('https://geocode.arcgis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ address: '25 Dorrance St', location: { x: -71.4129, y: 41.8241 }, score: 100, attributes: { Match_addr: '25 Dorrance St, Providence, RI' } }] }) }));
}

test('picker shows 8 featured + Other; Other expands the rest incl. Not sure', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await expect(page.locator('.cat-tile[data-category]')).toHaveCount(8);
  await page.getByRole('button', { name: /Other/ }).click();
  await expect(page.locator('[data-category="unsure"]')).toBeVisible();
  expect(await page.locator('.cat-tile[data-category]').count()).toBeGreaterThan(8);
});

test('photo-optional category: address + turnstile → submit → tracking page', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await expect(page.getByRole('heading', { name: /Add a photo \(optional\)/ })).toBeVisible();
  const submit = page.getByRole('button', { name: 'Send to Providence 311' });
  await expect(submit).toBeDisabled();
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  await expect(submit).toBeEnabled();
  const [req] = await Promise.all([page.waitForRequest(`${API}/api/report`), submit.click()]);
  const body = req.postData() ?? '';
  expect(body).toContain('name="category"');
  expect(body).toContain('missed_trash');
  expect(body).toContain('name="turnstileToken"');
  expect(body).toContain('name="deviceId"');
  await expect(page).toHaveURL(/\/r\/abc123xyz$/);
});

test('chip → Change returns to the grid and clears extras', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.click('[data-category="pothole"]');
  await expect(page.locator('#extra_size')).toBeVisible();
  await page.getByRole('button', { name: /Change/ }).click();
  await expect(page.locator('.cat-tile[data-category="pothole"]')).toBeVisible();
});

test('photo-required category keeps submit disabled without a photo', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.click('[data-category="pothole"]');
  await page.fill('#address', '25 Dorrance St');
  await expect(page.getByRole('button', { name: 'Send to Providence 311' })).toBeDisabled();
  await expect(page.locator('#extra_size')).toBeVisible();
});

test('intake: emergency notice + wording apply/undo', async ({ page }) => {
  await mockApi(page, { intake: { polishedDescription: 'Trash not collected at 25 Dorrance St on Tuesday.', flags: ['emergency'], note: 'If someone is hurt, call 911.' } });
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await page.fill('#description', 'trash not picked up tuesday');
  await expect(page.locator('.notice-error')).toContainText('call 911', { timeout: 6000 });
  await page.getByRole('button', { name: 'Use this wording' }).click();
  await expect(page.locator('#description')).toHaveValue('Trash not collected at 25 Dorrance St on Tuesday.');
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(page.locator('#description')).toHaveValue('trash not picked up tuesday');
});

test('rate limited → friendly message, stays on page', async ({ page }) => {
  await mockApi(page, { reportStatus: 429, reportBody: { error: 'rate_limited', retryAfterSec: 120 } });
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await page.fill('#address', '25 Dorrance St');
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('[role="alert"]')).toContainText('One report at a time');
  await expect(page).toHaveURL(/\/$/);
});

test('offline: submit queues to outbox, shows saved screen; back online it flushes and lands in My reports', async ({ page, context }) => {
  await mockApi(page);
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await page.fill('#address', '25 Dorrance St');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.queued')).toContainText('Saved on your phone');
  await context.setOffline(false);
  await page.goto('/');
  await expect(page.locator('.outbox-card')).toContainText('1 saved report');
  await page.waitForRequest(`${API}/api/report`);
  await expect(page.locator('[role="status"]')).toContainText('Sent a saved report', { timeout: 5000 });
  await expect(page.locator('.outbox-card')).toHaveCount(0);
  await page.goto('/my');
  await expect(page.locator('.my-row')).toHaveCount(1);
});

test('language switch to Español persists and translates the picker', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Español' }).click();
  await expect(page.getByRole('heading', { name: '¿Cuál es el problema?' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '¿Cuál es el problema?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('es');
});
