import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Desktop /admin (14" MacBook, 1512×982): layout sanity + reference screenshots for eyeballing.
// Screenshots land in app/tests/__screenshots__/ (not asserted against — they're for review).
test.use({ viewport: { width: 1512, height: 982 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
const SESSION = { uid: 'u1', email: 'robertbcorey@gmail.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
const me = { uid: 'u1', email: 'robertbcorey@gmail.com', emailVerified: true, displayName: null, provider: 'google.com', prefs: { emailUpdates: true }, addresses: [], following: [], createdAt: new Date().toISOString(), admin: true };
const mins = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const rep = (id: string, status: string, o: Record<string, unknown> = {}) => ({
  id, status, statusDetail: status === 'awaiting_review' ? 'Emailed for approval' : status === 'failed' ? 'Auto: NEEDS_REVIEW radio no match (Pole number)' : null,
  category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St, Providence, RI', lat: 41.8268, lng: -71.4053,
  description: 'Deep pothole in the right lane just past the crosswalk — about 2 ft wide, tire-damaging.', descriptionOriginal: 'big pothole right lane past crosswalk 2ft wide tire damage!!', extra: { size: 'Large (>36in)' },
  intakeFlags: [] as string[], moderatedAt: null, photoUrl: null, createdAt: mins(12), statusUpdatedAt: mins(11), reporterEmail: 'neighbor@example.com', ownerUid: 'u9',
  portalCaseId: null, portalStatus: null, retries: 0, retryAfter: null, review: { requestedAt: mins(11), emailed: true, mode: 'ramp' }, approvedAt: null, ...o,
});
const overview = {
  engine: { paused: false, consecutiveFailures: 0, submissionsThisHour: 3, lastSubmissionTime: mins(9), hitlMode: 'ramp', accountTrustN: '3' },
  awaitingReview: [
    rep('aaaaaaaaaaa1', 'awaiting_review', { intakeFlags: ['personal_info'] }),
    rep('aaaaaaaaaaa2', 'awaiting_review', { category: 'street_light', categoryLabel: 'Street light out', address: '25 Dorrance St', createdAt: mins(45), description: 'Light out on the corner, dark at night.', descriptionOriginal: null, extra: null, reporterEmail: 'rob@example.com' }),
    rep('aaaaaaaaaaa3', 'awaiting_review', { category: 'missed_trash', categoryLabel: 'Missed trash / recycling pickup', address: 'Benefit St & Waterman St', createdAt: mins(190), reporterEmail: null }),
  ],
  failed: [rep('fffffffffff1', 'failed', { retries: 3, createdAt: mins(600) })],
  pending: [rep('ppppppppppp1', 'pending', { statusDetail: 'Approved by admin:robertbcorey@gmail.com', createdAt: mins(4) })],
  submitted7d: [rep('sssssssssss1', 'submitted', { portalCaseId: 'PVD2026-90412', portalStatus: 'Assigned', createdAt: mins(2000), statusDetail: 'Auto-submitted as PVD2026-90412' })],
};
const health = {
  generatedAt: new Date().toISOString(), overall: 'warn',
  engine: { ...overview.engine, locked: false, reporterEmailEnabled: true },
  subsystems: [
    ['tick', 'Engine tick', 'Cron every minute: reaper, gates, review, submit', 'ok', 'every minute'],
    ['submit', 'Portal submit', 'Headless browser filing reports on 311.providenceri.gov', 'ok', null],
    ['watcher', 'Status watcher', 'Every 30 min: diff My Requests, email reporters', 'warn', 'every 30 min'],
    ['cityfeed', 'City feed scrape', 'Public-requests feed + geocoding (nearby dedupe)', 'ok', 'every 30 min'],
    ['canary', 'Portal canary', 'Daily zero-draft check that the city form has not changed', 'ok', 'daily, 7 am'],
    ['daily', 'Daily job', 'Digest, retention, event cleanup', 'ok', 'daily, 7 am'],
    ['email', 'Email (Resend)', 'Reporter + admin mail', 'ok', null],
    ['ai', 'AI moderation', 'Anthropic intake / server-side moderation', 'ok', null],
    ['auth_mail', 'Sign-in links', 'Worker-minted email links', 'unknown', null],
    ['api', 'Public API', 'Report creation', 'ok', null],
  ].map(([key, label, what, status, expectedEvery]) => ({ key, label, what, status, expectedEvery, lastOkAt: status === 'unknown' ? null : mins(3), lastErrorAt: status === 'warn' ? mins(40) : null, lastError: status === 'warn' ? 'My Requests returned 0 rows — skipping diff' : null, lastDetail: null, okToday: status === 'unknown' ? 0 : 40, errToday: status === 'warn' ? 1 : 0 })),
  counts: { pending: 1, awaiting_review: 3, processing: 0, submitted: 101, failed: 1, rejected: 18, 'auto-rejected': 12 },
  users: 14, ai: { intakeToday: 9, dailyCap: 1500 }, cityFeed: { fetchedAt: mins(15), items: 230 },
  sync: { status: 'ok', caseIdPending: 1, caseIdPendingOldestAt: mins(4), reconcile: { at: mins(600), scanned: 101, adopted: 0, stranded: 0, missing: 0, error: null } },
  canary: { enabled: true, categories: [{ category: 'pothole', goldenSource: 'live', goldenAt: mins(1500), lastLiveAt: mins(600), drifted: false }, { category: 'street_light', goldenSource: 'sim', goldenAt: mins(3000), lastLiveAt: null, drifted: false }] },
  events: Array.from({ length: 24 }, (_, i) => ({ id: `e${i}`, at: mins(i * 7 + 1), level: i % 9 === 4 ? 'error' : i % 5 === 2 ? 'warn' : 'info', kind: ['submit.ok', 'report.created', 'hitl.requested', 'watcher.status', 'auth.link_sent', 'intake.flagged'][i % 6], msg: ['Filed as PVD2026-90412', 'New report: pothole @ 120 Benefit St', 'Emailed for approval', 'My Requests returned 0 rows', 'Sign-in link sent', 'Moderation flagged personal_info'][i % 6], reportId: i % 2 ? 'aaaaaaaaaaa1' : null, data: null })),
};

test.beforeEach(async ({ page }) => {
  mkdirSync('tests/__screenshots__', { recursive: true });
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }));
  await page.route(`${API}/api/admin/overview`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overview) }));
  await page.route(`${API}/api/admin/health*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(health) }));
  await page.route(`${API}/api/admin/reports/*/proofs`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ name: 'step3', createdAt: mins(11), contentType: 'image/png' }]) }));
  await page.route(`${API}/api/admin/reports/*/proofs/*`, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }));
  await page.route(`${API}/api/admin/users/*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u9', email: 'neighbor@example.com', provider: 'google.com', trusted: false, submitted: 2, rejected: 0, createdAt: mins(9000) }) }));
  await page.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, body: '' }));
});

test('queue at 1512×982: rail + table + detail pane, no phone chrome', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.locator('.admin-rail')).toBeVisible();
  await expect(page.locator('.tabbar')).toBeHidden();
  await expect(page.locator('.app-footer')).toBeHidden();
  await expect(page.locator('.admin-table tbody tr')).toHaveCount(3);
  await page.locator('.admin-table tbody tr').first().click();
  const pane = page.locator('.admin-pane');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.admin-proofs img')).toHaveCount(1);
  const box = await pane.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(400);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1512);
  const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHScroll).toBe(false);
  await page.screenshot({ path: 'tests/__screenshots__/admin-queue.png', fullPage: false });
});

test('system at 1512×982: 5-wide subsystem grid, 3-col row, events table', async ({ page }) => {
  await page.goto('/admin#system');
  await expect(page.locator('.sys-grid .sys-card')).toHaveCount(10);
  const cards = await page.locator('.sys-grid .sys-card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(new Set(cards.map((t) => Math.round(t))).size).toBe(2); // two rows of five
  await expect(page.locator('.sys-events-table tbody tr')).toHaveCount(24);
  const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHScroll).toBe(false);
  await page.screenshot({ path: 'tests/__screenshots__/admin-system.png', fullPage: true });
});
