import { test, expect, type Page } from '@playwright/test';

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'email' };

async function mockApi(page: Page, opts: { intake?: object; reportStatus?: number; reportBody?: object; signedIn?: boolean } = {}) {
  await page.addInitScript(() => { (window as unknown as { __TURNSTILE_TOKEN__: string }).__TURNSTILE_TOKEN__ = 'test-token'; });
  if (opts.signedIn !== false) await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
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
  expect(body).toMatch(/name="clientId"\r?\n\r?\n[0-9a-f-]{36}/);
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
  const flushed = page.waitForRequest(`${API}/api/report`);
  await page.goto('/');
  await flushed;
  await expect(page.locator('.notice-ok')).toContainText('Sent a saved report', { timeout: 15_000 });
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

test('typed address geocodes → mini-map with draggable pin appears', async ({ page }) => {
  await mockApi(page);
  await page.route('https://*.tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://*.basemaps.cartocdn.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  await expect(page.locator('.mini-map .leaflet-container')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.mini-map .leaflet-marker-draggable')).toHaveCount(1);
});

test('dedupe: nearby match shows the prompt with a tracking link; dismiss hides it', async ({ page }) => {
  await mockApi(page);
  await page.route(`${API}/api/nearby*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
    { id: 'near1', source: 'snappvd', category: 'missed_trash', categoryLabel: 'Missed Trash Day Pick-up Issue', lat: 41.8241, lng: -71.4129, address: '27 Dorrance St, Providence, RI', createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), status: 'sent', portalStatus: 'Submitted', distanceM: 18 },
  ] }) }));
  await page.route('https://*.tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://*.basemaps.cartocdn.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await page.fill('#address', '25 Dorrance St');
  await page.locator('#address').blur();
  const card = page.locator('.nearby-card');
  await expect(card).toContainText('Already reported nearby', { timeout: 10_000 });
  await expect(card).toContainText('27 Dorrance St, 2 days ago — 18 m');
  await expect(card.getByRole('link', { name: 'View that report' })).toHaveAttribute('href', '/r/near1');
  await card.getByRole('button', { name: 'Report anyway' }).click();
  await expect(card).toHaveCount(0);
});

test('cold offline start: can queue without a Turnstile token', async ({ page, context }) => {
  await mockApi(page);
  // No test token this time: simulate the widget script failing offline.
  await page.addInitScript(() => { delete (window as unknown as { __TURNSTILE_TOKEN__?: string }).__TURNSTILE_TOKEN__; });
  await page.route('https://challenges.cloudflare.com/**', (r) => r.abort());
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await page.fill('#address', '25 Dorrance St');
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const submit = page.getByRole('button', { name: 'Send to Providence 311' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('.queued')).toContainText('Saved on your phone');
});

test('flush failure pauses retries instead of looping (no second request until an online event)', async ({ page }) => {
  await mockApi(page);
  let calls = 0;
  await page.route(`${API}/api/report`, (r) => { calls++; r.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', retryAfterSec: 600 }) }); });
  await page.goto('/');
  // Seed one queued item directly (avoids the harness's synthetic offline/online events).
  await page.evaluate(() => new Promise<void>((done) => {
    const r = indexedDB.open('snappvd', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => {
      const tx = r.result.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').add({ queuedAt: Date.now(), clientId: 'seed-1', attempts: 0, report: { category: 'missed_trash', description: '', address: '25 Dorrance St', lat: null, lng: null, extra: null, photo: null } });
      tx.oncomplete = () => done();
    };
  }));
  await page.reload();
  await expect(page.locator('.outbox-card')).toContainText('1 saved report');
  await page.waitForTimeout(2500);
  expect(calls).toBe(1);
  // A real reconnect resumes exactly one more attempt.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(2000);
  expect(calls).toBe(2);
});

test('signed out: Send parks the draft and shows the sign-in gate; after sign-in the draft is restored', async ({ page }) => {
  await mockApi(page, { signedIn: false });
  await page.goto('/');
  await page.click('[data-category="missed_trash"]');
  await page.fill('#address', '25 Dorrance St');
  await page.fill('#description', 'bins not collected');
  await page.getByRole('button', { name: 'Send to Providence 311' }).click();
  await expect(page.locator('.gate')).toBeVisible();
  await expect(page.locator('.submit-bar')).toBeHidden();
  // "Sign in" (seed a session) and come back — the draft survives the round trip.
  await page.evaluate((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.goto('/');
  await expect(page.locator('#address')).toHaveValue('25 Dorrance St');
  await expect(page.locator('#description')).toHaveValue('bins not collected');
  await expect(page.locator('.submit-bar')).toContainText("You're signed in");
  const [req] = await Promise.all([page.waitForRequest(`${API}/api/report`), page.getByRole('button', { name: 'Send to Providence 311' }).click()]);
  expect(req.headers()['authorization']).toBe('Bearer tok');
  await expect(page).toHaveURL(/\/r\/abc123xyz$/);
});
