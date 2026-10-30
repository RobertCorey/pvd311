import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { handleApi, paceIdentity, notFiledReason } from '../src/api';
import { UI_EVENTS } from '../src/ui';
import { isAdmin } from '../src/adminapi';
import type { Store, ReportDoc } from '../src/contracts';

const ts = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0, toDate: () => new Date(iso) });
const report = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  id: 'abc123456789', timestamp: ts('2026-08-22T12:00:00Z') as any, category: 'pothole', address: '25 Dorrance St', lat: 41.8236, lng: -71.4128,
  description: 'hole', photo: 'https://api.fixmypvd.org/api/photos/abc123456789', reporterName: null, reporterEmail: 'r@example.com',
  status: 'submitted', statusDetail: null, portalCaseId: 'PVD2026-1', statusUpdatedAt: ts('2026-08-22T12:05:00Z') as any, portalStatus: 'Assigned', ...over,
} as ReportDoc);

function mockStore(over: Partial<Store> = {}): Store {
  const base: Partial<Store> = {
    fetchReport: vi.fn(async (id) => (id === 'abc123456789' ? report() : null)),
    findReportsSince: vi.fn(async () => Array.from({ length: 5 }, (_, i) => report({ id: `ours${i}00000000000`, timestamp: ts(`2026-08-2${i}T12:00:00Z`) as any }))),
    getMeta: vi.fn(async (doc: string) => (doc === 'cityFeed' ? { fetchedAt: '', items: [
      { caseTypeName: 'Pothole Report', category: 'pothole', street: '1 Main', lat: 41.8236, lng: -71.4128, status: 'Assigned', createdOn: '8/22/2026 1:00 PM' },
      { caseTypeName: 'Pothole Report', category: 'pothole', street: '2 Main', lat: 41.8236, lng: -71.4128, status: 'Draft', createdOn: '8/22/2026 1:00 PM' },
    ] } : null)),
    setMeta: vi.fn(async () => {}),
  };
  return { ...base, ...over } as Store;
}
const env = { ANTHROPIC_API_KEY: '' } as any;
const get = (path: string) => handleApi(new Request(`https://api.test${path}`, { headers: { origin: 'https://fixmypvd.org' } }), env, { store: mockStore() });

describe('tracking projection', () => {
  it('exposes no PII, maps status, builds a timeline', async () => {
    const r = await get('/api/reports/abc123456789');
    const j = await r!.json() as any;
    expect(r!.status).toBe(200);
    expect(j.status).toBe('sent');
    expect(j.reporterEmail).toBeUndefined();
    expect(j.hasEmail).toBeUndefined();
    expect(j.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining([expect.stringContaining('PVD2026-1'), 'City status: Assigned']));
  });
  it('timeline shows every city status the watcher saw (oldest first), not just the latest', async () => {
    const store = mockStore({ fetchReport: vi.fn(async () => report({
      portalStatus: 'In Progress', portalStatusUpdatedAt: new Date('2026-10-01T19:31:30Z'),
      portalStatusHistory: [
        { status: 'Submitted', at: '2026-09-29T13:02:59Z' },
        { status: 'Assigned', at: '2026-09-29T15:31:30Z' },
        { status: 'In Progress', at: '2026-10-01T19:31:30Z' },
      ],
    })) });
    const j = await (await handleApi(new Request('https://api.test/api/reports/abc123456789'), env, { store }))!.json() as any;
    const city = j.timeline.filter((t: any) => t.label.startsWith('City status: '));
    expect(city.map((t: any) => t.label)).toEqual(['City status: Submitted', 'City status: Assigned', 'City status: In Progress']);
    expect(city[0].at).toBe('2026-09-29T13:02:59Z');
  });
  it('timeline: a report from before the history field still shows its latest city status once', async () => {
    const store = mockStore({ fetchReport: vi.fn(async () => report({ portalStatus: 'Assigned', portalStatusHistory: null })) });
    const j = await (await handleApi(new Request('https://api.test/api/reports/abc123456789'), env, { store }))!.json() as any;
    expect(j.timeline.filter((t: any) => t.label.startsWith('City status: ')).map((t: any) => t.label)).toEqual(['City status: Assigned']);
  });
  it('maps failed → needs_attention and rejected → rejected', async () => {
    const store = mockStore({ fetchReport: vi.fn(async () => report({ status: 'failed' })) });
    const j = await (await handleApi(new Request('https://api.test/api/reports/abc123456789'), env, { store }))!.json() as any;
    expect(j.status).toBe('needs_attention');
  });
  it('404s unknown ids and rejects malformed ids', async () => {
    expect((await get('/api/reports/zzzzzzzzzzzz'))!.status).toBe(404);
    expect((await get('/api/reports/x'))!.status).toBe(404);
  });
});

describe('feed + nearby', () => {
  it('token-gated ops endpoints fall through to index.ts (2026-10-16: /api/deploy-hold 404ed here, so the deploy guard could not hold)', async () => {
    expect(await get('/api/status')).toBeNull();
    expect(await handleApi(new Request('https://api.test/api/deploy-hold?seconds=120', { method: 'POST' }), env, { store: mockStore() })).toBeNull();
  });

  it('public-feed and anonymous follow are gone (they leaked tracking ids / allowed email spam)', async () => {
    expect((await get('/api/public-feed'))!.status).toBe(404);
    const r = await handleApi(new Request('https://api.test/api/reports/abc123456789/follow', { method: 'POST', body: '{"email":"x@y.z"}', headers: { 'content-type': 'application/json' } }), env, { store: mockStore() });
    expect(r!.status).toBe(404);
  });
  it('nearby filters by radius and ignores NaN radius', async () => {
    const near = await (await get('/api/nearby?lat=41.8236&lng=-71.4128&radiusM=50'))!.json() as any;
    expect(near.items.length).toBeGreaterThan(0);
    expect(near.items.every((i: any) => i.distanceM <= 50)).toBe(true);
    const far = await (await get('/api/nearby?lat=41.9&lng=-71.3&radiusM=abc'))!.json() as any;
    expect(far.items).toHaveLength(0);
  });
  it('CORS reflects allowed origins only', async () => {
    const ok = await get('/api/public-feed');
    expect(ok!.headers.get('access-control-allow-origin')).toBe('https://fixmypvd.org');
    const bad = await handleApi(new Request('https://api.test/api/public-feed', { headers: { origin: 'https://evil.example' } }), env, { store: mockStore() });
    expect(bad!.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});

describe('hardening', () => {
  it('paceIdentity collapses plus-tags and gmail dots so one mailbox = one budget', () => {
    expect(paceIdentity('uid1', 'Me+tag@Example.com')).toBe('me@example.com');
    expect(paceIdentity('uid1', 'r.o.b+x@gmail.com')).toBe('rob@gmail.com');
    expect(paceIdentity('uid1', null)).toBe('uid1');
  });
  it('report creation still needs a verified account (the sign-in is the human check)', async () => {
    const fd = new FormData(); fd.set('category', 'pothole'); fd.set('address', '25 Dorrance St');
    const r = await handleApi(new Request('https://api.test/api/report', { method: 'POST', body: fd, headers: { authorization: 'Bearer nope' } }), env, { store: mockStore() });
    expect(r!.status).toBe(401);
  });
});

describe('admin gate', () => {
  const envA = { ADMIN_EMAILS: 'Rob@Example.com, other@x.y' } as any;
  it('admits only allowlisted, verified, Google-provider accounts', () => {
    expect(isAdmin(envA, { uid: 'u', email: 'rob@example.com', emailVerified: true, name: null, provider: 'google.com' })).toBe(true);
    expect(isAdmin(envA, { uid: 'u', email: 'rob@example.com', emailVerified: true, name: null, provider: 'password' })).toBe(false); // email-link account: no
    expect(isAdmin(envA, { uid: 'u', email: 'rob@example.com', emailVerified: false, name: null, provider: 'google.com' })).toBe(false);
    expect(isAdmin(envA, { uid: 'u', email: 'someone@example.com', emailVerified: true, name: null, provider: 'google.com' })).toBe(false);
    expect(isAdmin(envA, null)).toBe(false);
    expect(isAdmin({} as any, { uid: 'u', email: 'rob@example.com', emailVerified: true, name: null, provider: 'google.com' })).toBe(false); // no allowlist → nobody
  });
  it('/api/admin/* is 401 without a token', async () => {
    expect((await get('/api/admin/overview'))!.status).toBe(401);
  });
});

describe('notFiledReason', () => {
  it('maps internal auto-reject details to reporter-safe text and never leaks the reviewer', () => {
    expect(notFiledReason(report({ status: 'auto-rejected', statusDetail: 'Duplicate: within 12m of submitted report abcdefghijkl' }))).toMatchObject({ code: 'duplicate', duplicateOf: 'abcdefghijkl' });
    expect(notFiledReason(report({ status: 'auto-rejected', statusDetail: 'Outside Providence (42.3, -71.0)' }))!.code).toBe('outside');
    expect(notFiledReason(report({ status: 'rejected', statusDetail: 'Rejected by admin:rob@x.y', review: { requestedAt: '', telegramMessageId: null, mode: 'ramp', reason: 'Private driveway — not a city street.' } as any }))!.text).toBe('Private driveway — not a city street.');
    expect(JSON.stringify(notFiledReason(report({ status: 'rejected', statusDetail: 'Rejected by admin:rob@x.y' })))).not.toContain('rob@');
    expect(notFiledReason(report({ status: 'rejected', cancelledByReporter: true }))!.code).toBe('cancelled');
    expect(notFiledReason(report({ status: 'submitted' }))).toBeNull();
  });
});

describe('first-party usage events (POST /api/ui)', () => {
  const ui = (body: unknown, o: { origin?: string; ua?: string; dataset?: boolean } = {}) => {
    const writeDataPoint = vi.fn();
    const e = { ...env, ...(o.dataset === false ? {} : { UI_EVENTS: { writeDataPoint } }) };
    const headers: Record<string, string> = { 'content-type': 'text/plain', 'user-agent': o.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' };
    if (o.origin !== '') headers.origin = o.origin ?? 'https://fixmypvd.org';
    const p = handleApi(new Request('https://api.test/api/ui', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), e, { store: mockStore() });
    return { p, writeDataPoint };
  };
  it('writes one data point for a known event, keyed by visitor id, with no auth', async () => {
    const { p, writeDataPoint } = ui({ e: 'select_category', p: '/', v: 'vid1', s: 'sid1', c: 'pothole', u: 'Reddit', l: 'en' });
    expect((await p)!.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledWith({ indexes: ['vid1'], blobs: ['select_category', '/', 'pothole', '', '', 'mobile', 'reddit', '', 'sid1', 'en'], doubles: [1] });
  });
  it('drops unknown events, missing visitor ids, bots, foreign origins and junk — still 204', async () => {
    for (const [body, o] of [
      [{ e: 'evil', v: 'v' }, {}], [{ e: 'page_view' }, {}], [{ e: 'page_view', v: 'v' }, { ua: 'Googlebot/2.1' }],
      [{ e: 'page_view', v: 'v' }, { origin: 'https://evil.example' }], [{ e: 'page_view', v: 'v' }, { origin: '' }], ['not json', {}], ['x'.repeat(3000), {}],
      [{ e: 'page_view', v: 'v' }, { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36' }], // our own automation
    ] as const) {
      const { p, writeDataPoint } = ui(body, o);
      expect((await p)!.status).toBe(204);
      expect(writeDataPoint).not.toHaveBeenCalled();
    }
  });
  it('is a no-op without the binding (tests/dev)', async () => {
    expect((await ui({ e: 'page_view', v: 'v' }, { dataset: false }).p)!.status).toBe(204);
  });
  it('knows every event name the app sends — 25 track() names were silently dropped until 2026-10-30', () => {
    const src = new URL('../../app/src/', import.meta.url);
    // The whole first argument must be one literal or `cond ? 'a' : 'b'` — anything partly dynamic ('street_' + kind,
    // on ? 'x' : name) fails here instead of slipping a real name past the UI_EVENTS check.
    const LITERALS = /^\s*(?:.+\?\s*)?(['"`])([a-z_]+)\1(?:\s*:\s*(['"`])([a-z_]+)\3)?\s*$/s;
    const sent = new Set<string>();
    for (const f of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(f) || f.endsWith('lib/analytics.ts')) continue; // defines track(); its page_view is in UI_EVENTS
      for (const [, arg] of readFileSync(new URL(f, src), 'utf8').matchAll(/\btrack\(([^,)]*)/g)) {
        const m = arg.match(LITERALS);
        expect(m, `${f}: track(${arg.trim()}…) — keep the name a literal (or a ternary of two literals) so this scan sees it`).not.toBeNull();
        [m![2], m![4]].filter(Boolean).forEach((n) => sent.add(n));
      }
    }
    // The scan really read the app: a core funnel step, not a count — a later feature cut (e.g. /street's 16 names) must not fail this.
    expect(sent).toContain('report_submitted');
    expect([...sent].filter((n) => !(UI_EVENTS as readonly string[]).includes(n))).toEqual([]);
  });
});
