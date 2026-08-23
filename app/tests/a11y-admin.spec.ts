// axe (WCAG 2.1 AA) on the admin screens — queue + System tab — with the admin API mocked as in admin.spec.ts.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// axe-core WCAG 2.x A/AA pass over the main screens, light and dark.
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

async function mocks(page: Page) {
  await page.addInitScript(() => { (window as unknown as { __TURNSTILE_TOKEN__: string }).__TURNSTILE_TOKEN__ = 'x'; });
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/public-feed*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'a', source: 'snappvd', category: 'pothole', categoryLabel: 'Pothole', lat: 41.8268, lng: -71.4053, address: '120 Benefit St', createdAt: new Date().toISOString(), status: 'sent', portalStatus: 'Assigned' }] }) }));
  await page.route(`${API}/api/reports/demo`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'demo', category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-1', portalStatus: 'Assigned', timeline: [{ at: new Date().toISOString(), label: 'Received' }], nextUpdateHint: null, hasEmail: false }) }));
  await page.route(`${API}/api/nearby*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route(/tile|basemaps\.cartocdn/, (r) => r.fulfill({ status: 200, body: '' }));
}

async function violations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].target[0]}`);
  });
}
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

const reconcile = (over: Record<string, unknown> = {}) => ({ at: new Date(Date.now() - 8 * 3_600_000).toISOString(), scanned: 42, adopted: 3, stranded: 2, missing: 0, error: null, ...over });
const syncBlock = (over: Record<string, unknown> = {}) => ({ status: 'warn', caseIdPending: 3, caseIdPendingOldestAt: new Date(Date.now() - 90 * 60_000).toISOString(), reconcile: reconcile(), ...over });
const health = (sync: Record<string, unknown> = syncBlock()) => ({
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
  events: [
    { id: 'e1', at: new Date(Date.now() - 60_000).toISOString(), level: 'error', kind: 'watcher.status', msg: 'portal login failed', reportId: null, data: null },
    { id: 'e2', at: new Date(Date.now() - 300_000).toISOString(), level: 'info', kind: 'submit.ok', msg: 'Filed as PVD2026-90001', reportId: 'rrrrrrrrrrrr', data: null },
    { id: 'e3', at: new Date(Date.now() - 600_000).toISOString(), level: 'info', kind: 'admin.resume', msg: 'Engine resumed by admin', reportId: null, data: null },
  ],
});

const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
test.use({ colorScheme: 'light' });
for (const [name, path] of [['admin queue', '/admin'], ['admin system', '/admin?tab=system']] as const) {
  test(`axe: ${name}`, async ({ page }) => {
    await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
    await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
    await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me(true)) }));
    await page.route(`${API}/api/admin/overview`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overview()) }));
    await page.route(`${API}/api/admin/health*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health()) }));
    await page.goto(path);
    if (name === 'admin system') { await page.getByRole('tab', { name: 'System' }).click(); await expect(page.getByText(/reconcile/i).first()).toBeVisible({ timeout: 10000 }); }
    await page.waitForTimeout(800);
    const v = await violations(page);
    expect(v, v.join('\n')).toEqual([]);
  });
}
