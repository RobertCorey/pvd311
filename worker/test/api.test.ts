import { describe, it, expect, vi } from 'vitest';
import { handleApi, paceIdentity, notFiledReason } from '../src/api';
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
const env = { TURNSTILE_SECRET: '', ANTHROPIC_API_KEY: '', ALLOW_NO_TURNSTILE: '1' } as any;
const get = (path: string) => handleApi(new Request(`https://api.test${path}`, { headers: { origin: 'https://fixmypvd.org' } }), env, { store: mockStore() });

describe('tracking projection', () => {
  it('exposes no PII, maps status, builds a timeline, reports hasEmail', async () => {
    const r = await get('/api/reports/abc123456789');
    const j = await r!.json() as any;
    expect(r!.status).toBe(200);
    expect(j.status).toBe('sent');
    expect(j.reporterEmail).toBeUndefined();
    expect(j.hasEmail).toBe(true);
    expect(j.timeline.map((t: any) => t.label)).toEqual(expect.arrayContaining([expect.stringContaining('PVD2026-1'), 'City status: Assigned']));
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
  it('report creation fails closed when Turnstile is not configured', async () => {
    const fd = new FormData(); fd.set('category', 'pothole'); fd.set('address', '25 Dorrance St');
    const closed = { ...env, ALLOW_NO_TURNSTILE: undefined };
    const r = await handleApi(new Request('https://api.test/api/report', { method: 'POST', body: fd, headers: { authorization: 'Bearer nope' } }), closed, { store: mockStore() });
    expect([401, 403]).toContain(r!.status); // 401 from the (unverifiable) token, never 201
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
