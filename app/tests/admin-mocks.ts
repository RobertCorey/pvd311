// Shared fixtures for the /admin specs (a11y, desktop screenshots). Every /api/admin/* endpoint mocked with rich data.
import type { Page } from '@playwright/test';

export const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
export const SESSION = { uid: 'u1', email: 'robertbcorey@gmail.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
export const me = { uid: 'u1', email: 'robertbcorey@gmail.com', emailVerified: true, displayName: null, provider: 'google.com', prefs: { emailUpdates: true }, addresses: [], following: [], createdAt: new Date().toISOString(), admin: true };
export const mins = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const rep = (id: string, status: string, o: Record<string, unknown> = {}) => ({
  id, status, statusDetail: status === 'awaiting_review' ? 'Emailed for approval' : status === 'failed' ? 'Auto: NEEDS_REVIEW radio no match (Pole number)' : status === 'submitted' ? 'Auto-submitted as PVD2026-90412' : null,
  category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St, Providence, RI', lat: 41.8268, lng: -71.4053,
  description: 'Deep pothole in the right lane just past the crosswalk — about 2 ft wide, tire-damaging.', descriptionOriginal: 'big pothole right lane past crosswalk 2ft wide tire damage!!', extra: { size: 'Large (>36in)' },
  intakeFlags: [] as string[], moderatedAt: mins(12), photoUrl: null, createdAt: mins(12), statusUpdatedAt: mins(11), reporterEmail: 'neighbor@example.com', ownerUid: 'u9',
  portalCaseId: null, portalStatus: null, retries: 0, retryAfter: null, review: { requestedAt: mins(11), emailed: true, mode: 'ramp' }, approvedAt: null, ...o,
});
export const overview = () => ({
  engine: { paused: false, consecutiveFailures: 0, submissionsThisHour: 3, lastSubmissionTime: mins(9), hitlMode: 'ramp', accountTrustN: '3' },
  awaitingReview: [
    rep('aaaaaaaaaaa1', 'awaiting_review', { intakeFlags: ['personal_info'] }),
    rep('aaaaaaaaaaa2', 'awaiting_review', { category: 'street_light', categoryLabel: 'Street light out', address: '25 Dorrance St', createdAt: mins(45), description: 'Light out on the corner, dark at night.', descriptionOriginal: null, extra: null, reporterEmail: 'rob@example.com' }),
    rep('aaaaaaaaaaa3', 'awaiting_review', { category: 'missed_trash', categoryLabel: 'Missed trash / recycling pickup', address: 'Benefit St & Waterman St', createdAt: mins(190), reporterEmail: null }),
  ],
  failed: [rep('fffffffffff1', 'failed', { retries: 3, createdAt: mins(600) })],
  pending: [rep('ppppppppppp1', 'pending', { statusDetail: 'Approved by admin:robertbcorey@gmail.com', createdAt: mins(4) })],
  submitted7d: [rep('sssssssssss1', 'submitted', { portalCaseId: 'PVD2026-90412', portalStatus: 'Assigned', createdAt: mins(2000) })],
});
export const events = (n = 24) => Array.from({ length: n }, (_, i) => ({ id: `evt_${i}`, at: mins(i * 7 + 1), level: i % 9 === 4 ? 'error' : i % 5 === 2 ? 'warn' : 'info', kind: ['submit.ok', 'report.created', 'hitl.requested', 'watcher.status', 'auth.link_sent', 'intake.flagged'][i % 6], msg: ['Filed as PVD2026-90412', 'New report: pothole @ 120 Benefit St', 'Emailed for approval', 'My Requests returned 0 rows', 'Sign-in link sent', 'Moderation flagged personal_info'][i % 6], reportId: i % 2 ? 'aaaaaaaaaaa1' : null, data: i % 3 ? { caseId: 'PVD2026-90412', ms: 4120 + i } : null }));
export const health = () => ({
  generatedAt: new Date().toISOString(), overall: 'warn',
  engine: { ...overview().engine, locked: false, reporterEmailEnabled: true },
  subsystems: ([
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
  ] as const).map(([key, label, what, status, expectedEvery]) => ({ key, label, what, status, expectedEvery, lastOkAt: status === 'unknown' ? null : mins(3), lastErrorAt: status === 'warn' ? mins(40) : null, lastError: status === 'warn' ? 'My Requests returned 0 rows — skipping diff' : null, lastDetail: null, okToday: status === 'unknown' ? 0 : 40, errToday: status === 'warn' ? 1 : 0 })),
  counts: { pending: 1, awaiting_review: 3, processing: 0, submitted: 101, failed: 1, rejected: 18, 'auto-rejected': 12 },
  users: 14, ai: { intakeToday: 9, dailyCap: 1500 }, cityFeed: { fetchedAt: mins(15), items: 230 },
  sync: { status: 'ok', caseIdPending: 1, caseIdPendingOldestAt: mins(4), reconcile: { at: mins(600), scanned: 101, adopted: 1, stranded: 0, missing: 0, ids: { adopted: ['PVD2026-90388'], stranded: [], missing: [] }, error: null } },
  canary: { enabled: true, categories: [{ category: 'pothole', goldenSource: 'live', goldenAt: mins(1500), lastLiveAt: mins(600), drifted: false }, { category: 'street_light', goldenSource: 'sim', goldenAt: mins(3000), lastLiveAt: null, drifted: false }] },
  events: events(24),
});
export const reportsPage = () => ({ items: [...overview().awaitingReview, ...overview().failed, ...overview().pending, ...overview().submitted7d, rep('rrrrrrrrrrr1', 'rejected', { statusDetail: 'Rejected by admin:robertbcorey@gmail.com', createdAt: mins(3000) }), rep('rrrrrrrrrrr2', 'auto-rejected', { statusDetail: 'Auto: moderation flagged spam', intakeFlags: ['spam'], createdAt: mins(4000) })], next: mins(4000) });
export const users = () => ({ items: Array.from({ length: 6 }, (_, i) => ({ uid: `uid_${i}xxxxxxxxxxxxxxxxxxxxxxxx`, email: `resident${i}@example.com`, displayName: i % 2 ? `Resident ${i}` : null, provider: i % 3 ? 'google.com' : 'password', emailVerified: true, createdAt: mins(10_000 + i * 500), lastSeenAt: mins(i * 90), trusted: i === 1, emailUpdates: i !== 4, following: i, addresses: i % 2, submitted: 5 - i, rejected: i === 3 ? 1 : 0, awaitingReview: i === 0 ? 2 : 0, autoFiles: i <= 1 })), next: null });
export const categories = () => ({ items: [
  { key: 'pothole', label: 'Pothole', portalCaseTypeName: 'Report a Pothole', portalCaseTypeGuid: '3f0c2d1e-0000-4000-8000-00000000ab12', portalSearchTerm: 'pothole', requestType: 'Street Repair', photoRequired: true, seasonal: null, fields: { cop_size: { from: 'extra.size', default: 'Medium' } }, golden: { source: 'live', at: mins(1500), lastLiveAt: mins(600), drifted: false }, counts: { submitted: 60, rejected: 4 } },
  { key: 'street_light', label: 'Street light out', portalCaseTypeName: 'Report Street Light Issue', portalCaseTypeGuid: '9a1b7c33-0000-4000-8000-0000000077de', portalSearchTerm: 'street light', requestType: 'Lighting', photoRequired: false, seasonal: null, fields: { cop_polenumber: { from: 'extra.pole' } }, golden: { source: 'sim', at: mins(3000), lastLiveAt: null, drifted: false }, counts: { submitted: 12, rejected: 1 } },
  { key: 'snow_sidewalk', label: 'Unshoveled sidewalk', portalCaseTypeName: 'Snow Removal Complaint', portalCaseTypeGuid: null, portalSearchTerm: 'snow', requestType: 'Snow', photoRequired: true, seasonal: 'winter', fields: null, golden: null, counts: { submitted: 0, rejected: 0 } },
] });
export const config = () => ({ items: [
  { key: 'HITL_MODE', value: 'ramp', what: 'review = every report needs a tap; ramp = first ACCOUNT_TRUST_N per account, then auto; auto = nothing waits.' },
  { key: 'ACCOUNT_TRUST_N', value: 3, what: 'Reports an account must get filed cleanly before it auto-approves.' },
  { key: 'REPORTER_EMAIL_ENABLED', value: true, what: 'Whether reporters get status emails (needs a verified Resend domain).' },
  { key: 'TURNSTILE', value: 'enforced', what: 'Cloudflare bot check on report creation; fails closed without the secret.' },
  { key: 'AI_DAILY_CAP', value: 1500, what: 'Max intake/moderation calls per day before the AI steps aside.' },
  { key: 'PORTAL_BASE_URL', value: 'https://311.providenceri.gov', what: 'The city portal the headless browser drives.' },
  { key: 'RETENTION_DAYS', value: 90, what: 'Photos are deleted this long after the city marks a case resolved.' },
] });
export const explain = () => ({ sections: [
  { key: 'pipeline', title: 'The pipeline, end to end', summary: 'A report goes app → Worker → review gate → headless browser → the city portal → status watcher.', details: ['The app posts `multipart/form-data` to `/api/report`; the Worker validates, paces, and stores it as `pending`.', 'Every minute the tick picks the oldest eligible report.', 'Human review or the trust ramp decides whether it waits.'], live: { pending: 1, awaiting_review: 3, submitted: 101 }, links: [{ label: 'Queue', href: '#queue' }, { label: 'docs/api.md', href: 'https://github.com/RobertCorey/pvd311/blob/main/docs/api.md' }] },
  { key: 'hitl', title: 'Human in the loop', summary: 'Who decides, and when the machine decides alone.', details: ['`HITL_MODE=ramp`: the first 3 reports per account are reviewed.', 'Any intake flag forces review regardless of trust.'], live: { mode: 'ramp', trustN: 3, trustedAccounts: 1 } },
  { key: 'moderation', title: 'Moderation & abuse gates', summary: 'Turnstile, pacing, AI intake.', details: ['Pacing: one report per 3 min per account, 5 per day, plus per-IP.'], live: { intakeToday: 9, dailyCap: 1500 } },
  { key: 'portal', title: 'Driving the city portal', summary: 'A headless Chromium walks the 3-step wizard.', details: ['Step 1 creates a draft the city cannot delete.', 'Step 3 fields come from the category registry.'], live: { categories: 3, drifted: 0 } },
  { key: 'sync', title: 'Staying in sync with the city', summary: 'The watcher and the nightly reconcile.', details: ['Every 30 min the watcher diffs My Requests.'], live: { caseIdPending: 1 } },
  { key: 'email', title: 'Email', summary: 'Resend for reporters and admins.', details: ['Sign-in links are minted by the Worker.'], live: { enabled: true } },
  { key: 'health', title: 'Health & events', summary: 'How the traffic lights are computed.', details: ['Each subsystem writes a heartbeat; status = freshness vs expectedEvery.'], live: { subsystems: 10 } },
  { key: 'data', title: 'Data & retention', summary: 'What we store and for how long.', details: ['Photos live in Firestore until 90 days after resolution.'], live: { retentionDays: 90 } },
] });

/** Route every /api/admin/* + /api/me to fixtures; abort the primary host so apiFetch falls back to the mocked one. */
export async function mockAdmin(page: Page, opts: { events?: number } = {}) {
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(`${API}/api/me`, (r) => r.fulfill(json(me)));
  await page.route(`${API}/api/admin/overview`, (r) => r.fulfill(json(overview())));
  await page.route(`${API}/api/admin/health*`, (r) => r.fulfill(json(health())));
  await page.route(`${API}/api/admin/reports?*`, (r) => r.fulfill(json(reportsPage())));
  await page.route(`${API}/api/admin/reports/*/proofs`, (r) => r.fulfill(json([{ name: 'step3', createdAt: mins(11), contentType: 'image/png' }])));
  await page.route(`${API}/api/admin/reports/*/proofs/*`, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }));
  await page.route(`${API}/api/admin/users?*`, (r) => r.fulfill(json(users())));
  await page.route(`${API}/api/admin/users/*`, (r) => r.fulfill(json({ uid: 'u9', email: 'neighbor@example.com', provider: 'google.com', trusted: false, submitted: 2, rejected: 0, createdAt: mins(9000) })));
  await page.route(`${API}/api/admin/events?*`, (r) => r.fulfill(json({ items: events(opts.events ?? 100), next: mins(900) })));
  await page.route(`${API}/api/admin/categories`, (r) => r.fulfill(json(categories())));
  await page.route(`${API}/api/admin/config`, (r) => r.fulfill(json(config())));
  await page.route(`${API}/api/admin/explain`, (r) => r.fulfill(json(explain())));
}
export const TABS = ['overview', 'queue', 'reports', 'accounts', 'portal', 'events', 'system', 'config', 'explain'] as const;
