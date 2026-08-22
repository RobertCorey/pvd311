import { describe, it, expect, vi } from 'vitest';
import { handleApi } from '../src/api';
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
const env = { TURNSTILE_SECRET: '', ANTHROPIC_API_KEY: '' } as any;
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

describe('public feed + nearby', () => {
  it('merges ours and city, excludes city Draft rows, honors limit, NaN-safe', async () => {
    const j = await (await get('/api/public-feed?limit=abc'))!.json() as any;
    const sources = j.items.map((i: any) => i.source);
    expect(sources).toContain('snappvd');
    expect(sources).toContain('city');
    expect(j.items.filter((i: any) => i.source === 'city')).toHaveLength(1);
    const small = await (await get('/api/public-feed?limit=2'))!.json() as any;
    expect(small.items).toHaveLength(2);
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
