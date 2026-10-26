import { describe, expect, it, vi, beforeEach } from 'vitest';

// push.ts is exercised by its own suite; here pushAll is a spy so the tests see exactly what the watch hands it.
vi.mock('../src/push.js', async (orig) => ({
  ...(await orig<typeof import('../src/push.js')>()),
  ensureVapid: vi.fn(async () => ({ publicKey: 'pub', privateJwk: { kty: 'EC' } })),
  pushAll: vi.fn(async () => 1),
}));

import { pushAll, ensureVapid } from '../src/push.js';
import { matchWatchers, streetWatchPush, watchable, ownCaseIds, runStreetWatch, WATCH_RADIUS_M, WATCH_MAX_AGE_MS, type WatchCase } from '../src/streetwatch.js';
import { hoodOf } from '../../shared/neighborhoods.js';
import type { Env, PushSub, ReportDoc, Store, UserDoc } from '../src/contracts.js';

// Angell St / Thayer St corner (College Hill) as "home"; cases placed by hand around it. 0.001° of latitude ≈ 111 m.
const HOME = { lat: 41.8282, lng: -71.4005 };
const NOW = Date.parse('2026-10-26T15:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const OPTS = { now: NOW, radiusM: WATCH_RADIUS_M, maxAgeMs: WATCH_MAX_AGE_MS };

const sub = (n: number): PushSub => ({ endpoint: `https://push.test/${n}`, p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg', ua: 'test', createdAt: '2026-10-01T00:00:00.000Z' });
const addr = (id: string, label: string, lat: number | null, lng: number | null) => ({ id, label, address: `${id} Angell St`, lat, lng });
const user = (uid: string, o: Partial<UserDoc> = {}): UserDoc => ({
  uid, email: `${uid}@example.com`, emailVerified: true, displayName: null, provider: 'google', createdAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z',
  prefs: { emailUpdates: true, streetWatch: true }, addresses: [addr('a1', 'Home', HOME.lat, HOME.lng)], following: [], push: [sub(1)], ...o,
});
const kase = (id: string, o: Partial<WatchCase> = {}): WatchCase => ({ id, caseType: 'Pothole', street: '10 Angell St', status: 'Submitted', createdAt: minutesAgo(20), lat: 41.8300, lng: HOME.lng, ...o }); // ≈ 200 m north of home

describe('matchWatchers', () => {
  it('hits a located case inside 300 m of a saved address and not one outside', () => {
    const hits = matchWatchers([kase('near'), kase('far', { lat: 41.8320 })], [user('u')], OPTS); // far ≈ 420 m
    expect(hits.map((h) => h.case.id)).toEqual(['near']);
    expect(hits[0]).toMatchObject({ address: { id: 'a1', label: 'Home' }, user: { uid: 'u' } });
    expect(hits[0].distanceM).toBeGreaterThan(150);
    expect(hits[0].distanceM).toBeLessThan(250);
  });

  it('two saved addresses in range give ONE hit, named by the nearest one', () => {
    const u = user('u', { addresses: [addr('a1', 'Home', HOME.lat, HOME.lng), addr('a2', 'Work', 41.8295, HOME.lng)] }); // work ≈ 55 m from the case
    const hits = matchWatchers([kase('c')], [u], OPTS);
    expect(hits).toHaveLength(1);
    expect(hits[0].address.label).toBe('Work');
    expect(hits[0].distanceM).toBeLessThan(80);
  });

  it('an unlocated case, an old case, a draft or a case without a created time match nobody', () => {
    const cases = [
      kase('nogeo', { lat: null, lng: null }),
      kase('old', { createdAt: minutesAgo(121) }),
      kase('draft', { status: 'Draft' }),
      kase('undated', { createdAt: null }),
      kase('justintime', { createdAt: minutesAgo(119) }),
    ];
    expect(matchWatchers(cases, [user('u')], OPTS).map((h) => h.case.id)).toEqual(['justintime']);
    expect(watchable(kase('x', { createdAt: '2026-10-26T14:50:00' }), { now: NOW, maxAgeMs: WATCH_MAX_AGE_MS })).toBe(true); // a bare ISO is read as UTC, like the feed does
  });

  it('accounts without a subscription, without the pref, or with an address lacking coordinates get nothing; one hit per account even if listed twice', () => {
    const nosub = user('nosub', { push: [] });
    const off = user('off', { prefs: { emailUpdates: true, streetWatch: false } });
    const stale = user('stale', { prefs: { emailUpdates: true } }); // a stale query hit: no pref at all
    const nocoords = user('nocoords', { addresses: [addr('a1', 'Home', null, null)] });
    const ok = user('ok');
    const hits = matchWatchers([kase('c')], [nosub, off, stale, nocoords, ok, ok], OPTS);
    expect(hits.map((h) => h.user.uid)).toEqual(['ok']);
  });

  it('several cases × several accounts: case order, then account order, one per pair', () => {
    const a = user('a'); const b = user('b', { addresses: [addr('b1', 'Shop', 41.8300, HOME.lng)] });
    const hits = matchWatchers([kase('c1'), kase('c2', { lat: 41.8302 })], [a, b], OPTS);
    expect(hits.map((h) => `${h.user.uid}:${h.case.id}`)).toEqual(['a:c1', 'b:c1', 'a:c2', 'b:c2']);
  });
});

describe('streetWatchPush', () => {
  it('names the saved address label, the case type, street and neighborhood, opens the card, tags per case', () => {
    expect(hoodOf(41.8300, HOME.lng)).toBe('College Hill'); // the fixture point really is on College Hill
    const [hit] = matchWatchers([kase('abc-123')], [user('u')], OPTS);
    expect(streetWatchPush(hit, 'https://fixmypvd.org/')).toEqual({
      title: 'New near Home',
      body: 'Pothole · 10 Angell St · College Hill',
      url: 'https://fixmypvd.org/street?case=abc-123&lat=41.83000&lng=-71.40050',
      tag: 'watch:abc-123',
    });
  });

  it('falls back to the address when the label is blank, leaves out a blank street and an unknown neighborhood', () => {
    const north = { lat: 41.9, lng: -71.4 }; // outside every ring
    const u = user('u', { addresses: [{ id: 'z', label: '  ', address: '1 Far North Rd', lat: north.lat, lng: north.lng }] });
    const [hit] = matchWatchers([kase('c', { street: '', ...north })], [u], OPTS);
    expect(streetWatchPush(hit, 'https://fixmypvd.org')).toEqual({ title: 'New near 1 Far North Rd', body: 'Pothole', url: 'https://fixmypvd.org/street?case=c&lat=41.90000&lng=-71.40000', tag: 'watch:c' });
  });
});

describe('ownCaseIds', () => {
  it('collects the portal GUIDs from filed reports and drafts, lower-cased', () => {
    const reports = [
      { id: 'r1', portalEntityId: 'AB400112-05C8-F111-A3D0-001DD804B975' },
      { id: 'r2', portalDraft: { url: 'u', entityId: 'f8c0745a-04c8-f111-aaae-001dd8038269', step: 3, savedAt: 'x' } },
      { id: 'r3', portalDraft: { url: 'u', entityId: null, step: 2, savedAt: 'x' } },
      { id: 'r4' },
    ] as unknown as ReportDoc[];
    expect([...ownCaseIds(reports)].sort()).toEqual(['ab400112-05c8-f111-a3d0-001dd804b975', 'f8c0745a-04c8-f111-aaae-001dd8038269']);
  });
});

describe('runStreetWatch', () => {
  const env = { APP_BASE_URL: 'https://fixmypvd.org' } as Env;
  function memStore(users: UserDoc[], reports: Record<string, ReportDoc[]> = {}) {
    const events: Record<string, unknown>[] = [];
    const store = {
      listStreetWatchUsers: vi.fn(async () => users),
      findReportsByOwner: vi.fn(async (uid: string) => reports[uid] ?? []),
      addEvent: vi.fn(async (ev: Record<string, unknown>) => { events.push(ev); }),
      getMeta: vi.fn(async () => null), setMeta: vi.fn(async () => {}),
    } as unknown as Store;
    return { store, events };
  }
  beforeEach(() => { vi.mocked(pushAll).mockClear(); vi.mocked(pushAll).mockImplementation(async () => 1); vi.mocked(ensureVapid).mockClear(); });

  it('pushes once per hit through pushAll with the shared VAPID keys, and logs watch.pushed + push.sent with counts', async () => {
    const a = user('a'); const b = user('b', { push: [sub(2), sub(3)] }); const far = user('far', { addresses: [addr('f', 'Far', 41.84, -71.41)] });
    const s = memStore([a, b, far]);
    vi.mocked(pushAll).mockImplementation(async (_s, u) => (u.uid === 'b' ? 2 : 1));
    const r = await runStreetWatch(env, s.store, { newCases: [kase('c1'), kase('c2', { caseType: 'Street Light Out' })], now: NOW });
    expect(r).toEqual({ cases: 2, users: 3, hits: 4, pushed: 6, skippedOwn: 0 });
    expect(vi.mocked(pushAll)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(ensureVapid)).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(pushAll).mock.calls.map(([, u, p, k]) => ({ uid: u.uid, title: p.title, body: p.body, tag: p.tag, keys: !!k }));
    expect(calls).toEqual([
      { uid: 'a', title: 'New near Home', body: 'Pothole · 10 Angell St · College Hill', tag: 'watch:c1', keys: true },
      { uid: 'b', title: 'New near Home', body: 'Pothole · 10 Angell St · College Hill', tag: 'watch:c1', keys: true },
      { uid: 'a', title: 'New near Home', body: 'Street Light Out · 10 Angell St · College Hill', tag: 'watch:c2', keys: true },
      { uid: 'b', title: 'New near Home', body: 'Street Light Out · 10 Angell St · College Hill', tag: 'watch:c2', keys: true },
    ]);
    expect(s.events.find((e) => e.kind === 'watch.pushed')).toMatchObject({ level: 'info', data: { cases: 2, users: 3, hits: 4, pushed: 6, accounts: 2 } });
    expect(s.events.find((e) => e.kind === 'push.sent')).toMatchObject({ data: { source: 'street_watch', users: 2, sent: 6 } });
    expect((s.store.findReportsByOwner as any).mock.calls.map((c: any[]) => c[0])).toEqual(['a', 'b']); // one own-report read per account with a hit
  });

  it('reads no users when the run added nothing watchable (unlocated or older than two hours), and logs nothing', async () => {
    const s = memStore([user('a')]);
    const r = await runStreetWatch(env, s.store, { newCases: [kase('old', { createdAt: minutesAgo(180) }), kase('nogeo', { lat: null, lng: null })], now: NOW });
    expect(r).toEqual({ cases: 0, users: 0, hits: 0, pushed: 0, skippedOwn: 0 });
    expect(s.store.listStreetWatchUsers).not.toHaveBeenCalled();
    expect(pushAll).not.toHaveBeenCalled();
    expect(s.events).toHaveLength(0);
    // Users read, nobody in range: still no push, no log.
    const quiet = memStore([user('far', { addresses: [addr('f', 'Far', 41.84, -71.41)] })]);
    expect(await runStreetWatch(env, quiet.store, { newCases: [kase('c')], now: NOW })).toEqual({ cases: 1, users: 1, hits: 0, pushed: 0, skippedOwn: 0 });
    expect(quiet.events).toHaveLength(0);
  });

  it('skips the account\'s own just-filed report (its portal GUID on one of their reports) and counts it', async () => {
    const guid = 'AB400112-05c8-f111-a3d0-001dd804b975';
    const s = memStore([user('me'), user('neighbor')], { me: [{ id: 'r1', portalEntityId: guid.toLowerCase() } as unknown as ReportDoc] });
    const r = await runStreetWatch(env, s.store, { newCases: [kase(guid), kase('other')], now: NOW });
    expect(r).toEqual({ cases: 2, users: 2, hits: 3, pushed: 3, skippedOwn: 1 });
    expect(vi.mocked(pushAll).mock.calls.map(([, u, p]) => `${u.uid}:${p.tag}`)).toEqual([`neighbor:watch:${guid}`, 'me:watch:other', 'neighbor:watch:other']);
  });

  it('never throws into the sync: a users query that fails, a reports read that fails, a pushAll that throws', async () => {
    const down = { listStreetWatchUsers: vi.fn(async () => { throw new Error('firestore down'); }), addEvent: vi.fn(async () => {}) } as unknown as Store;
    expect(await runStreetWatch(env, down, { newCases: [kase('c')], now: NOW })).toEqual({ cases: 1, users: 0, hits: 0, pushed: 0, skippedOwn: 0 });

    const s = memStore([user('a'), user('b')]);
    (s.store.findReportsByOwner as any).mockImplementation(async () => { throw new Error('reports down'); }); // → the hit is kept, not dropped
    vi.mocked(pushAll).mockImplementationOnce(async () => { throw new Error('boom'); });
    const r = await runStreetWatch(env, s.store, { newCases: [kase('c')], now: NOW });
    expect(r).toEqual({ cases: 1, users: 2, hits: 2, pushed: 1, skippedOwn: 0 });
    expect(pushAll).toHaveBeenCalledTimes(2);

    vi.mocked(ensureVapid).mockImplementationOnce(async () => { throw new Error('no vapid'); });
    const t = memStore([user('a')]);
    expect(await runStreetWatch(env, t.store, { newCases: [kase('c')], now: NOW })).toMatchObject({ hits: 1, pushed: 0 });
  });
});
