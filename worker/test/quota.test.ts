import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthUser } from '../src/auth';

// Tokens → users. handleApi verifies Bearer tokens through userFromRequest; tests swap in this table.
const TOKENS: Record<string, AuthUser> = {
  alice: { uid: 'uid_alice', email: 'Alice+x@Example.com', emailVerified: true, name: null, provider: 'password' },
  alice2: { uid: 'uid_alice2', email: 'alice@example.com', emailVerified: true, name: null, provider: 'google.com' }, // same mailbox, other account
  bob: { uid: 'uid_bob', email: 'bob@example.com', emailVerified: true, name: null, provider: 'password' },
  admin: { uid: 'uid_admin', email: 'rob@example.com', emailVerified: true, name: null, provider: 'google.com' },
};
vi.mock('../src/auth', async (orig) => ({
  ...(await orig<typeof import('../src/auth')>()),
  userFromRequest: async (_env: unknown, req: Request) => TOKENS[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')] ?? null,
}));

import { handleApi } from '../src/api';
import { checkQuota, etDate, etMidnight, etWeekStart, quotaFor, refundQuota, QUOTA, _test } from '../src/quota';
import type { Store, ReportDoc, UserDoc } from '../src/contracts';

function memStore() {
  const meta = new Map<string, unknown>();
  const users = new Map<string, UserDoc>();
  const reports = new Map<string, ReportDoc>();
  const events: { kind: string; msg: string }[] = [];
  const store = {
    getMeta: async (id: string) => (meta.has(id) ? structuredClone(meta.get(id)) : null),
    setMeta: async (id: string, v: unknown) => { meta.set(id, structuredClone(v)); },
    getUser: async (uid: string) => (users.has(uid) ? structuredClone(users.get(uid)!) : null),
    patchUser: async (uid: string, f: Record<string, unknown>) => { users.set(uid, { ...(users.get(uid) ?? {}), ...f } as UserDoc); },
    findByClientId: async () => null,
    putPhoto: async () => {},
    patchReport: async (id: string, f: Record<string, unknown>) => { reports.set(id, { ...(reports.get(id) ?? { id }), ...f } as ReportDoc); },
    fetchReport: async (id: string) => (reports.has(id) ? structuredClone(reports.get(id)!) : null),
    updateReportStatus: async (id: string, status: string, detail?: string) => { reports.set(id, { ...reports.get(id)!, status, statusDetail: detail ?? null } as ReportDoc); },
    addEvent: async (e: { kind: string; msg: string }) => { events.push(e); },
    countOwnerByStatus: async () => 0,
  };
  return { store: store as unknown as Store, meta, users, reports, events };
}

const env = { TURNSTILE_SECRET: '', ALLOW_NO_TURNSTILE: '1', ADMIN_EMAILS: 'rob@example.com' } as any;
const at = (iso: string) => vi.setSystemTime(new Date(iso));

function post(s: ReturnType<typeof memStore>, token: string, ip = '203.0.113.7') {
  const fd = new FormData();
  fd.set('category', 'missed_trash'); fd.set('address', '25 Dorrance St');
  return handleApi(new Request('https://api.test/api/report', { method: 'POST', body: fd, headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip } }), env, { store: s.store }) as Promise<Response>;
}
const call = (s: ReturnType<typeof memStore>, token: string, path: string, method = 'GET', body?: unknown) =>
  handleApi(new Request(`https://api.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { store: s.store }) as Promise<Response>;
/** Send n reports, each 61 s after the previous one (clears the gap). Returns the last response. */
async function sendN(s: ReturnType<typeof memStore>, token: string, n: number, ip?: string) {
  let r!: Response;
  for (let i = 0; i < n; i++) { r = await post(s, token, ip); vi.advanceTimersByTime(61_000); }
  return r;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('Eastern-time calendar', () => {
  it('days turn over at midnight New York time, not UTC', () => {
    expect(etDate(Date.parse('2026-10-16T03:59:59Z'))).toBe('2026-10-15'); // 23:59:59 EDT
    expect(etDate(Date.parse('2026-10-16T04:00:00Z'))).toBe('2026-10-16'); // 00:00 EDT
    expect(etDate(Date.parse('2026-12-16T04:59:59Z'))).toBe('2026-12-15'); // 23:59:59 EST
    expect(etDate(Date.parse('2026-12-16T05:00:00Z'))).toBe('2026-12-16');
    expect(new Date(etMidnight('2026-10-16')).toISOString()).toBe('2026-10-16T04:00:00.000Z');
    expect(new Date(etMidnight('2026-12-16')).toISOString()).toBe('2026-12-16T05:00:00.000Z');
  });
  it('DST: midnight on the switch days and the day after', () => {
    // Fall back Sun 2026-11-01 02:00 EDT → 01:00 EST; spring forward Sun 2026-03-08 02:00 EST → 03:00 EDT.
    expect(new Date(etMidnight('2026-11-01')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(new Date(etMidnight('2026-11-02')).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(new Date(etMidnight('2026-03-08')).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(etMidnight('2026-03-09')).toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(etDate(Date.parse('2026-11-02T04:59:00Z'))).toBe('2026-11-01'); // 23:59 EST on the 25-hour day
  });
  it('weeks start Monday 00:00 ET', () => {
    expect(etWeekStart(Date.parse('2026-10-16T16:00:00Z'))).toBe('2026-10-12'); // Fri
    expect(etWeekStart(Date.parse('2026-10-19T03:59:00Z'))).toBe('2026-10-12'); // Sun 23:59 EDT
    expect(etWeekStart(Date.parse('2026-10-19T04:00:00Z'))).toBe('2026-10-19'); // Mon 00:00 EDT
    expect(etWeekStart(Date.parse('2026-11-02T04:30:00Z'))).toBe('2026-10-26'); // Sun 23:30 EST (DST week)
    expect(etWeekStart(Date.parse('2026-11-02T05:00:00Z'))).toBe('2026-11-02'); // Mon 00:00 EST
  });
});

describe('reporter quota (POST /api/report)', () => {
  it('day limit: 5, then a 429 with reason day until ET midnight; the next ET day is open again', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z'); // Wed 10:00 EDT
    expect((await sendN(s, 'alice', 5)).status).toBe(201);
    const r = await post(s, 'alice');
    expect(r.status).toBe(429);
    const j = await r.json() as any;
    expect(j).toMatchObject({ error: 'rate_limited', reason: 'day', quota: { dayUsed: 5, dayLimit: 5, weekUsed: 5, weekLimit: 15, dayResetsAt: '2026-10-15T04:00:00.000Z', weekResetsAt: '2026-10-19T04:00:00.000Z', nextAllowedAt: '2026-10-15T04:00:00.000Z' } });
    expect(j.retryAfterSec).toBe(Math.ceil((Date.parse('2026-10-15T04:00:00Z') - Date.now()) / 1000));
    expect(r.headers.get('retry-after')).toBe(String(j.retryAfterSec));
    at('2026-10-15T03:59:00Z'); // 23:59 EDT, still Wednesday in Providence (Thursday in UTC)
    expect((await post(s, 'alice')).status).toBe(429);
    at('2026-10-15T04:00:30Z'); // 00:00:30 EDT Thursday
    expect((await post(s, 'alice')).status).toBe(201);
  });

  it('alias accounts (plus-tag, same mailbox) share one budget', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z');
    await sendN(s, 'alice', 5);
    const r = await post(s, 'alice2');
    expect(r.status).toBe(429);
    expect((await r.json() as any).reason).toBe('day');
  });

  it('week limit: 15 across the week, then reason week until Monday 00:00 ET', async () => {
    const s = memStore();
    for (const d of ['12', '13', '14']) { at(`2026-10-${d}T14:00:00Z`); expect((await sendN(s, 'bob', 5)).status).toBe(201); }
    at('2026-10-16T14:00:00Z'); // Friday: day is fresh, week is spent
    const r = await post(s, 'bob');
    const j = await r.json() as any;
    expect(r.status).toBe(429);
    expect(j.reason).toBe('week');
    expect(j.quota).toMatchObject({ dayUsed: 0, weekUsed: 15, weekLimit: 15, nextAllowedAt: '2026-10-19T04:00:00.000Z' });
    at('2026-10-19T04:00:01Z'); // Monday 00:00:01 EDT
    expect((await post(s, 'bob')).status).toBe(201);
  });

  it('gap: 60 s between reports', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z');
    expect((await post(s, 'bob')).status).toBe(201);
    vi.advanceTimersByTime(30_000);
    const r = await post(s, 'bob');
    const j = await r.json() as any;
    expect(r.status).toBe(429);
    expect(j.reason).toBe('gap');
    expect(j.retryAfterSec).toBe(30);
    expect(j.quota.dayUsed).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect((await post(s, 'bob')).status).toBe(201);
  });

  it('IP backstop: 30/day across accounts, no gap; an IP rejection costs the account nothing', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z');
    for (let i = 0; i < 30; i++) {
      const uid = `uid_ip${i}`; TOKENS[`ip${i}`] = { uid, email: `n${i}@example.com`, emailVerified: true, name: null, provider: 'password' };
      expect((await post(s, `ip${i}`, '198.51.100.1')).status).toBe(201); // no gap between different accounts on one IP
    }
    const r = await post(s, 'bob', '198.51.100.1');
    expect(r.status).toBe(429);
    expect((await r.json() as any).reason).toBe('ip');
    expect(s.meta.get('pace_u_bob_example_com')).toBeUndefined(); // peek-then-commit: bob's budget untouched
    expect((await post(s, 'bob', '198.51.100.2')).status).toBe(201); // other network: fine
  });

  it('an account rejection costs the IP nothing', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z');
    await sendN(s, 'bob', 5, '198.51.100.9');
    for (let i = 0; i < 3; i++) expect((await post(s, 'bob', '198.51.100.9')).status).toBe(429);
    expect((s.meta.get('pace_ip_198_51_100_9') as any).dayCount).toBe(5);
  });

  it('one tier only: a quotaRaised flag on the user doc changes nothing (the raised tier was dropped)', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z');
    await s.store.patchUser('uid_bob', { uid: 'uid_bob', email: 'bob@example.com', quotaRaised: true });
    expect((await sendN(s, 'bob', QUOTA.day)).status).toBe(201);
    const j = await (await post(s, 'bob')).json() as any;
    expect(j).toMatchObject({ reason: 'day', quota: { dayUsed: 5, dayLimit: 5, weekLimit: 15 } });
    expect(j.quota.raised).toBeUndefined();
  });

  it('every accepted report counts and records the buckets it used on the report', async () => {
    const s = memStore();
    at('2026-10-15T02:00:00Z'); // Wed 22:00 EDT (Thursday in UTC)
    const r = await post(s, 'alice');
    const { id } = await r.json() as any;
    expect(s.reports.get(id)!.quotaSlot).toEqual({ key: 'u_alice@example.com', ipKey: 'ip_203.0.113.7', day: '2026-10-14', week: '2026-10-12' });
  });
});

describe('refund on cancel', () => {
  it('cancelling a pending report gives the day + week slot back (once)', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { ids.push((await (await post(s, 'alice')).json() as any).id); vi.advanceTimersByTime(61_000); }
    expect((await post(s, 'alice')).status).toBe(429);
    const c = await call(s, 'alice', `/api/reports/${ids[4]}/cancel`, 'POST', {});
    expect(c.status).toBe(200);
    const me = await (await call(s, 'alice', '/api/me')).json() as any;
    expect(me.quota).toMatchObject({ dayUsed: 4, weekUsed: 4, nextAllowedAt: null });
    expect((s.meta.get('pace_ip_203_0_113_7') as any).dayCount).toBe(4);
    expect(s.reports.get(ids[4])!.quotaSlot!.refundedAt).toBeTruthy();
    expect((await call(s, 'alice', `/api/reports/${ids[4]}/cancel`, 'POST', {})).status).toBe(409); // no second refund
    expect((await post(s, 'alice')).status).toBe(201);
  });
  it('a cancel on a later day refunds only the week it was counted in', async () => {
    const s = memStore();
    at('2026-10-14T14:00:00Z');
    const { id } = await (await post(s, 'bob')).json() as any;
    at('2026-10-15T14:00:00Z');
    await post(s, 'bob');
    await call(s, 'bob', `/api/reports/${id}/cancel`, 'POST', {});
    expect((await (await call(s, 'bob', '/api/me')).json() as any).quota).toMatchObject({ dayUsed: 1, weekUsed: 1 });
  });
  it('a cancel in a later week changes nothing', async () => {
    const s = memStore();
    at('2026-10-16T14:00:00Z');
    const slot = (await checkQuota(s.store, { uid: 'u', email: 'x@example.com', ip: null })) as any;
    at('2026-10-19T14:00:00Z');
    await checkQuota(s.store, { uid: 'u', email: 'x@example.com', ip: null });
    await refundQuota(s.store, slot.slot);
    expect(await quotaFor(s.store, 'u', 'x@example.com')).toMatchObject({ dayUsed: 1, weekUsed: 1 });
  });
});

describe('GET /api/me quota', () => {
  it('has the documented shape', async () => {
    const s = memStore();
    at('2026-10-16T14:00:00Z');
    await post(s, 'bob');
    const me = await (await call(s, 'bob', '/api/me')).json() as any;
    expect(me.quota).toEqual({
      dayUsed: 1, dayLimit: 5, weekUsed: 1, weekLimit: 15,
      dayResetsAt: '2026-10-17T04:00:00.000Z', weekResetsAt: '2026-10-19T04:00:00.000Z',
      nextAllowedAt: '2026-10-16T14:01:00.000Z',
    });
  });
  it('a fresh account starts at zero with nextAllowedAt null', async () => {
    const s = memStore();
    at('2026-10-16T14:00:00Z');
    const me = await (await call(s, 'alice', '/api/me')).json() as any;
    expect(me.quota).toMatchObject({ dayUsed: 0, weekUsed: 0, dayLimit: 5, weekLimit: 15, nextAllowedAt: null });
  });
});

describe('old pacing records (deploy switch-over)', () => {
  it('a same-UTC-day legacy count carries into today and this week; the gap carries; an older one is dropped', async () => {
    const s = memStore();
    at('2026-10-16T14:00:00Z');
    await s.store.setMeta('pace_u_bob_example_com', { last: Date.parse('2026-10-16T13:59:30Z'), day: '2026-10-16', count: 3 });
    const q = await quotaFor(s.store, 'uid_bob', 'bob@example.com');
    expect(q).toMatchObject({ dayUsed: 3, weekUsed: 3, nextAllowedAt: '2026-10-16T14:00:30.000Z' });
    await s.store.setMeta('pace_u_bob_example_com', { last: Date.parse('2026-10-15T13:00:00Z'), day: '2026-10-15', count: 5 });
    expect(await quotaFor(s.store, 'uid_bob', 'bob@example.com')).toMatchObject({ dayUsed: 0, weekUsed: 0, nextAllowedAt: null });
    expect((await post(s, 'bob')).status).toBe(201);
    expect(s.meta.get('pace_u_bob_example_com')).toMatchObject({ v: 2, day: '2026-10-16', dayCount: 1, week: '2026-10-12', weekCount: 1 });
  });
  it('normalize never yields a negative or NaN count', () => {
    const r = _test.normalize({ day: new Date().toISOString().slice(0, 10), count: 'x' as any }, Date.now());
    expect(r.dayCount).toBe(0); expect(r.last).toBe(0);
  });
});

describe('no raised tier in the admin API', () => {
  it('POST /api/admin/users/:uid/quota does not exist and the user projection has no quotaRaised', async () => {
    const s = memStore();
    await call(s, 'bob', '/api/me');
    const r = await call(s, 'admin', '/api/admin/users/uid_bob/quota', 'POST', { raised: true });
    expect(r.status).toBe(404);
    expect((s.users.get('uid_bob') as any).quotaRaised).toBeUndefined();
    expect(s.events.some((e) => e.kind === 'admin.quota')).toBe(false);
    expect((await (await call(s, 'admin', '/api/admin/users/uid_bob')).json() as any).quotaRaised).toBeUndefined();
  });
});
