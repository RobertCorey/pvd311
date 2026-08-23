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
  await page.route(`${API}/api/admin/reports/*/proofs`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(`${API}/api/admin/users/*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u9', email: 'r@example.com', provider: 'google.com', trusted: false, submitted: 2, rejected: 0, createdAt: new Date().toISOString() }) }));
  await page.goto('/admin#queue');
  const shell = page.locator('.admin-shell');
  await expect(shell).toContainText('Running');
  // Awaiting review is the default section: one row with its flag; open the detail pane by clicking it.
  const table = page.locator('.admin-table');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table).toContainText('personal_info');
  await table.locator('tbody tr').first().click();
  const pane = page.locator('.admin-pane');
  await expect(pane).toContainText('Original wording');
  await expect(pane).toContainText('2 sent · 0 rejected');
  await pane.getByRole('button', { name: /Approve & send/ }).click();
  await expect(page.locator('main')).toContainText(/Approved — goes out/);
  // Row moved from Awaiting review (now 0) to Pending (1); the pane closes because the row left the section.
  await expect(page.getByRole('button', { name: /Awaiting review/ })).toContainText('0');
  await expect(page.getByRole('button', { name: /^Pending/ })).toContainText('1');
  await expect(pane).toHaveCount(0);
  // Failed section → requeue gets a 409 → toast + resync.
  await page.getByRole('button', { name: /^Failed/ }).click();
  await page.getByRole('button', { name: /Requeue/ }).click();
  await expect(page.locator('main')).toContainText(/Already moved on/);
});

test('keyboard: j selects, r opens the reason box, reject sends the reason, Esc closes', async ({ page }) => {
  await setup(page, { admin: true });
  await page.route(`${API}/api/admin/reports/*/proofs`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(`${API}/api/admin/users/*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u9', email: 'r@example.com', provider: 'google.com', trusted: false, submitted: 0, rejected: 0, createdAt: null }) }));
  let sentReason: string | null = null;
  await page.route(`${API}/api/admin/reports/aaaaaaaaaaaa/reject`, (r) => { sentReason = (r.request().postDataJSON() as { reason?: string }).reason ?? null; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(report('aaaaaaaaaaaa', 'rejected')) }); });
  await page.goto('/admin#queue');
  await expect(page.locator('.admin-table tbody tr')).toHaveCount(1);
  await page.locator('body').press('j');
  await expect(page.locator('.admin-pane')).toBeVisible();
  await page.locator('body').press('r');
  const reason = page.locator('#admin-reason');
  await expect(reason).toBeFocused();
  await reason.fill('Duplicate of PVD2026-1');
  await page.getByRole('button', { name: 'Reject report' }).click();
  await expect(page.locator('main')).toContainText('Rejected.');
  expect(sentReason).toBe('Duplicate of PVD2026-1');
  await page.getByRole('button', { name: /^Failed/ }).click();
  await page.locator('.admin-table tbody tr').first().click();
  await expect(page.locator('.admin-pane')).toBeVisible();
  await page.locator('body').press('Escape');
  await expect(page.locator('.admin-pane')).toHaveCount(0);
});

test('account page links to /admin only for admins', async ({ page }) => {
  await setup(page, { admin: true });
  await page.route(`${API}/api/me/following`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.goto('/account');
  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
});

// ── System tab ──
const reconcile = (over: Record<string, unknown> = {}) => ({ at: new Date(Date.now() - 8 * 3_600_000).toISOString(), scanned: 42, adopted: 3, stranded: 2, missing: 0, error: null, ...over });
const syncBlock = (over: Record<string, unknown> = {}) => ({ status: 'warn', caseIdPending: 3, caseIdPendingOldestAt: new Date(Date.now() - 90 * 60_000).toISOString(), reconcile: reconcile(), ...over });
const health = (sync: Record<string, unknown> = syncBlock(), canary?: Record<string, unknown>) => ({
  generatedAt: new Date().toISOString(), overall: 'error',
  engine: { paused: false, consecutiveFailures: 0, submissionsThisHour: 2, lastSubmissionTime: new Date(Date.now() - 120_000).toISOString(), locked: false, hitlMode: 'ramp', accountTrustN: '3', reporterEmailEnabled: true },
  subsystems: [
    { key: 'tick', label: 'Engine tick', what: 'Runs every minute and files one report.', status: 'ok', lastOkAt: new Date(Date.now() - 30_000).toISOString(), lastErrorAt: null, lastError: null, lastDetail: null, okToday: 900, errToday: 0, expectedEvery: 'every minute' },
    { key: 'watcher', label: 'Status watcher', what: 'Reads My Requests on the city portal.', status: 'error', lastOkAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), lastErrorAt: new Date(Date.now() - 600_000).toISOString(), lastError: 'portal login failed: selector #email not found', lastDetail: 'attempt 3', okToday: 10, errToday: 2, expectedEvery: 'every 30 min' },
    { key: 'canary', label: 'Selector canary', what: 'Daily check that the portal still looks the way we expect.', status: 'unknown', lastOkAt: null, lastErrorAt: null, lastError: null, lastDetail: null, okToday: 0, errToday: 0, expectedEvery: 'daily, 7 am' },
  ],
  counts: { pending: 1, awaiting_review: 2, processing: 0, submitted: 40, failed: 1, rejected: 3, 'auto-rejected': 0 },
  users: 12, ai: { intakeToday: 5, dailyCap: 200 }, cityFeed: { fetchedAt: new Date(Date.now() - 900_000).toISOString(), items: 230 },
  sync,
  canary,
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
  await expect(main.locator('.sys-card--ok')).toContainText('Expected every minute');
  await expect(main.locator('.sys-num', { hasText: 'Awaiting review' })).toContainText('2');
  await expect(main.locator('.sys-event')).toHaveCount(3);
  await expect(main.locator('.sys-events-table')).toBeVisible();
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

// ── Sync-with-the-city-portal card ──
async function openSystem(page: Page, sync: Record<string, unknown>) {
  await setup(page, { admin: true });
  await page.route(`${API}/api/admin/health*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health(sync)) }));
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'System' }).click();
  return page.locator('main').locator('.sync-card');
}

test('sync card: warn banner, reconcile counts + plain-English explainers, pending oldest', async ({ page }) => {
  const card = await openSystem(page, syncBlock());
  await expect(card.locator('.sync-banner.is-warn')).toContainText('waiting to reconcile');
  await expect(card.locator('.sync-row', { hasText: 'Awaiting case number' })).toContainText('3');
  await expect(card.locator('.sync-row', { hasText: 'Awaiting case number' })).toContainText('oldest');
  await expect(card.locator('.sync-count', { hasText: 'Scanned' })).toContainText('42');
  await expect(card.locator('.sync-count', { hasText: 'Adopted' })).toContainText('3');
  await expect(card.locator('.sync-count', { hasText: 'Stranded drafts' })).toContainText('2');
  await expect(card).toContainText("City drafts we can't delete");
  await expect(card.locator('.sync-err')).toHaveCount(0);
});

test('sync card: ok banner, never reconciled → no counts', async ({ page }) => {
  const card = await openSystem(page, syncBlock({ status: 'ok', caseIdPending: 0, caseIdPendingOldestAt: null, reconcile: null }));
  await expect(card.locator('.sync-banner.is-ok')).toContainText('in sync');
  await expect(card.locator('.sync-row', { hasText: 'Last reconcile' })).toContainText('never');
  await expect(card.locator('.sync-count')).toHaveCount(0);
});

test('sync card: error banner, missing count highlighted + reconcile error', async ({ page }) => {
  const card = await openSystem(page, syncBlock({ status: 'error', reconcile: reconcile({ missing: 4, error: 'portal search timed out' }) }));
  await expect(card.locator('.sync-banner.is-error')).toContainText('missing from the portal');
  await expect(card.locator('.sync-count.is-warn', { hasText: 'Missing' })).toContainText('4');
  await expect(card.locator('.sync-err')).toContainText('portal search timed out');
});

// ── Portal form drift canary card ──
const canaryCat = (over: Record<string, unknown> = {}) => ({
  category: 'pothole', goldenSource: 'live', goldenAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
  lastLiveAt: new Date(Date.now() - 3_600_000).toISOString(), drifted: false, ...over,
});
const canaryBlock = (over: Record<string, unknown> = {}) => ({ enabled: true, categories: [canaryCat()], ...over });

async function openCanary(page: Page, canary: Record<string, unknown>) {
  await setup(page, { admin: true });
  await page.route(`${API}/api/admin/health*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health(syncBlock(), canary)) }));
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'System' }).click();
  return page.locator('main').locator('.canary-card');
}

test('canary card: ok banner, live golden, no drift', async ({ page }) => {
  const card = await openCanary(page, canaryBlock());
  await expect(card.locator('.canary-banner.is-ok')).toContainText('matches what we expect');
  const row = card.locator('.canary-row', { hasText: 'Pothole' });
  await expect(row.locator('.canary-chip--live')).toContainText('live');
  await expect(row).toContainText('Last live check');
  await expect(card.locator('.canary-pill')).toHaveCount(0);
});

test('canary card: drifted → error banner + drifted pill', async ({ page }) => {
  const card = await openCanary(page, canaryBlock({ categories: [canaryCat(), canaryCat({ category: 'street_light', drifted: true })] }));
  await expect(card.locator('.canary-banner.is-error')).toContainText('form changed');
  await expect(card.locator('.canary-row.is-drifted', { hasText: 'Street light out' }).locator('.canary-pill')).toContainText('Drifted');
});

test('canary card: no live golden anywhere → warn banner, sim chip', async ({ page }) => {
  const card = await openCanary(page, canaryBlock({ categories: [canaryCat({ goldenSource: 'sim' })] }));
  await expect(card.locator('.canary-banner.is-warn')).toContainText('No live baseline yet');
  await expect(card.locator('.canary-row', { hasText: 'Pothole' }).locator('.canary-chip--sim')).toContainText('waiting for a real report');
});

test('canary card: one live golden + sim rows → ok (sim rows are minted by the next real report)', async ({ page }) => {
  const card = await openCanary(page, canaryBlock({ categories: [canaryCat(), canaryCat({ category: 'street_light', goldenSource: 'sim', lastLiveAt: null })] }));
  await expect(card.locator('.canary-banner.is-ok')).toBeVisible();
  await expect(card.locator('.canary-row', { hasText: 'Street light out' }).locator('.canary-chip--sim')).toBeVisible();
});

test('canary card: disabled → neutral Off banner, no rows', async ({ page }) => {
  const card = await openCanary(page, canaryBlock({ enabled: false }));
  await expect(card.locator('.canary-banner.is-off')).toContainText('Off');
});
