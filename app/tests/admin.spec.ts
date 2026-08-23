import { test, expect, type Page } from '@playwright/test';

// /admin gate + row actions, API mocked. The Worker is the authority; the screen routes on /api/me `admin`.
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
const me = (admin: boolean) => ({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google.com', prefs: { emailUpdates: true }, addresses: [], following: [], createdAt: new Date().toISOString(), admin });
const report = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, status, statusDetail: 'Emailed for approval', category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St', lat: 41.82, lng: -71.4,
  description: 'Big hole', descriptionOriginal: 'big hole!!!', extra: { size: 'Medium' }, intakeFlags: status === 'awaiting_review' ? ['personal_info'] : [], moderatedAt: null,
  photoUrl: null, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), statusUpdatedAt: null, reporterEmail: 'r@example.com', ownerUid: 'u9',
  portalCaseId: null, portalStatus: null, retries: 0, retryAfter: null, review: null, approvedAt: null, ...extra,
});
const overview = () => ({
  engine: { paused: false, consecutiveFailures: 0, submissionsThisHour: 1, lastSubmissionTime: new Date().toISOString(), hitlMode: 'ramp', accountTrustN: '3' },
  awaitingReview: [report('aaaaaaaaaaaa', 'awaiting_review')], failed: [report('ffffffffffff', 'failed')], pending: [], submitted7d: [],
});

async function setup(page: Page, opts: { signedIn?: boolean; admin?: boolean } = {}) {
  if (opts.signedIn !== false) await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort()); // primary host → network failure → apiFetch falls back to workers.dev (mocked below)
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me(opts.admin === true)) }));
  await page.route(`${API}/api/admin/overview`, (r) => r.fulfill({ status: opts.admin ? 200 : 403, contentType: 'application/json', body: opts.admin ? JSON.stringify(overview()) : '{"error":"forbidden"}' }));
  await page.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, body: '' }));
}

test('signed out → Google sign-in prompt only', async ({ page }) => {
  await setup(page, { signedIn: false });
  await page.goto('/admin');
  await expect(page.locator('main')).toContainText(/Sign in with the admin Google account|Inicia sesión con la cuenta/);
  await expect(page.locator('main')).not.toContainText('Awaiting review');
});

test('signed in, not an admin → plain refusal, no queue', async ({ page }) => {
  await setup(page, { admin: false });
  await page.goto('/admin');
  await expect(page.locator('main')).toContainText(/isn't an admin|no es de administrador/);
  await expect(page.locator('main')).not.toContainText('Awaiting review');
});

test('admin → queue renders; approve moves the row; 409 resyncs', async ({ page }) => {
  await setup(page, { admin: true });
  await page.route(`${API}/api/admin/reports/aaaaaaaaaaaa/approve`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report('aaaaaaaaaaaa', 'pending', { statusDetail: 'Approved by admin:me@example.com' })) }));
  await page.route(`${API}/api/admin/reports/ffffffffffff/requeue`, (r) => r.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"not_failed","status":"submitted"}' }));
  await page.goto('/admin');
  const main = page.locator('main');
  await expect(main).toContainText('Running');
  await expect(main).toContainText('personal_info');
  await expect(main).toContainText('Original wording');
  await page.getByRole('button', { name: /Approve & send/ }).click();
  await expect(main).toContainText(/Approved — goes out/);
  // Row moved from Awaiting review (now empty) to Pending and lost its approve action.
  await expect(main.locator('.admin-section', { hasText: 'Awaiting review' })).toContainText('Nothing here');
  await expect(main.locator('.admin-section', { hasText: 'Pending' })).toContainText('Pothole');
  await expect(page.getByRole('button', { name: /Approve & send/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Requeue/ }).click();
  await expect(main).toContainText(/Already moved on/);
});

test('account page links to /admin only for admins', async ({ page }) => {
  await setup(page, { admin: true });
  await page.route(`${API}/api/me/following`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.goto('/account');
  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
});

// ── System tab ──
const health = () => ({
  generatedAt: new Date().toISOString(), overall: 'error',
  engine: { paused: false, consecutiveFailures: 0, submissionsThisHour: 2, lastSubmissionTime: new Date(Date.now() - 120_000).toISOString(), locked: false, hitlMode: 'ramp', accountTrustN: '3', reporterEmailEnabled: true },
  subsystems: [
    { key: 'tick', label: 'Engine tick', what: 'Runs every minute and files one report.', status: 'ok', lastOkAt: new Date(Date.now() - 30_000).toISOString(), lastErrorAt: null, lastError: null, lastDetail: null, okToday: 900, errToday: 0, expectedEvery: '1 min' },
    { key: 'watcher', label: 'Status watcher', what: 'Reads My Requests on the city portal.', status: 'error', lastOkAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), lastErrorAt: new Date(Date.now() - 600_000).toISOString(), lastError: 'portal login failed: selector #email not found', lastDetail: 'attempt 3', okToday: 10, errToday: 2, expectedEvery: '30 min' },
    { key: 'canary', label: 'Selector canary', what: 'Daily check that the portal still looks the way we expect.', status: 'unknown', lastOkAt: null, lastErrorAt: null, lastError: null, lastDetail: null, okToday: 0, errToday: 0, expectedEvery: '1 d' },
  ],
  counts: { pending: 1, awaiting_review: 2, processing: 0, submitted: 40, failed: 1, rejected: 3, 'auto-rejected': 0 },
  users: 12, ai: { intakeToday: 5, dailyCap: 200 }, cityFeed: { fetchedAt: new Date(Date.now() - 900_000).toISOString(), items: 230 },
  events: [
    { id: 'e1', at: new Date(Date.now() - 60_000).toISOString(), level: 'error', kind: 'watcher.status', msg: 'portal login failed', reportId: null, data: null },
    { id: 'e2', at: new Date(Date.now() - 300_000).toISOString(), level: 'info', kind: 'submit.ok', msg: 'Filed as PVD2026-90001', reportId: 'rrrrrrrrrrrr', data: null },
    { id: 'e3', at: new Date(Date.now() - 600_000).toISOString(), level: 'info', kind: 'admin.resume', msg: 'Engine resumed by admin', reportId: null, data: null },
  ],
});

test('system tab: banner, traffic lights with error + unknown, numbers, filtered events', async ({ page }) => {
  await setup(page, { admin: true });
  await page.route(`${API}/api/admin/health*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health()) }));
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'System' }).click();
  const main = page.locator('main');
  await expect(main).toContainText('Something is broken');
  await expect(main.locator('.sys-card--error')).toContainText('selector #email not found');
  await expect(main.locator('.sys-card--unknown')).toContainText('Never ran yet');
  await expect(main.locator('.sys-card--ok')).toContainText('Expected every 1 min');
  await expect(main.locator('.sys-num', { hasText: 'Awaiting review' })).toContainText('2');
  await expect(main.locator('.sys-event')).toHaveCount(3);
  await page.getByRole('button', { name: 'Errors' }).click();
  await expect(main.locator('.sys-event')).toHaveCount(1);
  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(main.locator('.sys-event')).toHaveCount(1);
  await expect(main.locator('.sys-event a')).toHaveAttribute('href', '/r/rrrrrrrrrrrr');
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(main.locator('.sys-event')).toContainText('admin.resume');
  // Deep link keeps the tab
  await page.goto('/admin#system');
  await expect(main).toContainText('Subsystems');
});
