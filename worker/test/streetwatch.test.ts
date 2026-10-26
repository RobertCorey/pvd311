import { describe, expect, it, vi, beforeEach } from 'vitest';

// push.ts is exercised by its own suite; here pushAll is a spy so the tests see exactly what the watch hands it.
vi.mock('../src/push.js', async (orig) => ({
  ...(await orig<typeof import('../src/push.js')>()),
  ensureVapid: vi.fn(async () => ({ publicKey: 'pub', privateJwk: { kty: 'EC' } })),
  pushAll: vi.fn(async () => 1),
}));

import { pushAll, ensureVapid } from '../src/push.js';
import {
  matchWatchers, streetWatchPush, watchable, ownCaseIds, runStreetWatch, WATCH_RADIUS_M, WATCH_MAX_AGE_MS, type WatchCase,
  nyHour, isQuietHour, isMorningWindow, isSyncFlushHour, mergeOvernight, parseOvernight, morningPush, runWatchMorning, OVERNIGHT_CAP, OVERNIGHT_META, MORNING_MAX_AGE_MS, type OvernightItem,
} from '../src/streetwatch.js';
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

const env = { APP_BASE_URL: 'https://fixmypvd.org' } as Env;
/** users + their reports + a meta map (getMeta/setMeta merge like Firestore's patch); every call is a spy. */
function memStore(users: UserDoc[], reports: Record<string, ReportDoc[]> = {}, meta: Record<string, Record<string, unknown>> = {}) {
  const events: Record<string, unknown>[] = [];
  const store = {
    listStreetWatchUsers: vi.fn(async () => users),
    getUser: vi.fn(async (uid: string) => users.find((u) => u.uid === uid) ?? null),
    findReportsByOwner: vi.fn(async (uid: string) => reports[uid] ?? []),
    addEvent: vi.fn(async (ev: Record<string, unknown>) => { events.push(ev); }),
    getMeta: vi.fn(async (k: string) => meta[k] ?? null),
    setMeta: vi.fn(async (k: string, v: Record<string, unknown>) => { meta[k] = { ...(meta[k] ?? {}), ...v }; }),
  } as unknown as Store;
  return { store, events, meta };
}
const resetPush = () => { vi.mocked(pushAll).mockClear(); vi.mocked(pushAll).mockImplementation(async () => 1); vi.mocked(ensureVapid).mockClear(); };

describe('runStreetWatch', () => {
  beforeEach(resetPush);

  it('pushes once per hit through pushAll with the shared VAPID keys, and logs watch.pushed + push.sent with counts', async () => {
    const a = user('a'); const b = user('b', { push: [sub(2), sub(3)] }); const far = user('far', { addresses: [addr('f', 'Far', 41.84, -71.41)] });
    const s = memStore([a, b, far]);
    vi.mocked(pushAll).mockImplementation(async (_s, u) => (u.uid === 'b' ? 2 : 1));
    const r = await runStreetWatch(env, s.store, { newCases: [kase('c1'), kase('c2', { caseType: 'Street Light Out' })], now: NOW });
    expect(r).toEqual({ cases: 2, users: 3, hits: 4, pushed: 6, skippedOwn: 0, held: 0 });
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
    expect(r).toEqual({ cases: 0, users: 0, hits: 0, pushed: 0, skippedOwn: 0, held: 0 });
    expect(s.store.listStreetWatchUsers).not.toHaveBeenCalled();
    expect(pushAll).not.toHaveBeenCalled();
    expect(s.events).toHaveLength(0);
    // Users read, nobody in range: still no push, no log.
    const quiet = memStore([user('far', { addresses: [addr('f', 'Far', 41.84, -71.41)] })]);
    expect(await runStreetWatch(env, quiet.store, { newCases: [kase('c')], now: NOW })).toEqual({ cases: 1, users: 1, hits: 0, pushed: 0, skippedOwn: 0, held: 0 });
    expect(quiet.events).toHaveLength(0);
  });

  it('skips the account\'s own just-filed report (its portal GUID on one of their reports) and counts it', async () => {
    const guid = 'AB400112-05c8-f111-a3d0-001dd804b975';
    const s = memStore([user('me'), user('neighbor')], { me: [{ id: 'r1', portalEntityId: guid.toLowerCase() } as unknown as ReportDoc] });
    const r = await runStreetWatch(env, s.store, { newCases: [kase(guid), kase('other')], now: NOW });
    expect(r).toEqual({ cases: 2, users: 2, hits: 3, pushed: 3, skippedOwn: 1, held: 0 });
    expect(vi.mocked(pushAll).mock.calls.map(([, u, p]) => `${u.uid}:${p.tag}`)).toEqual([`neighbor:watch:${guid}`, 'me:watch:other', 'neighbor:watch:other']);
  });

  it('never throws into the sync: a users query that fails, a reports read that fails, a pushAll that throws', async () => {
    const down = { listStreetWatchUsers: vi.fn(async () => { throw new Error('firestore down'); }), addEvent: vi.fn(async () => {}) } as unknown as Store;
    expect(await runStreetWatch(env, down, { newCases: [kase('c')], now: NOW })).toEqual({ cases: 1, users: 0, hits: 0, pushed: 0, skippedOwn: 0, held: 0 });

    const s = memStore([user('a'), user('b')]);
    (s.store.findReportsByOwner as any).mockImplementation(async () => { throw new Error('reports down'); }); // → the hit is kept, not dropped
    vi.mocked(pushAll).mockImplementationOnce(async () => { throw new Error('boom'); });
    const r = await runStreetWatch(env, s.store, { newCases: [kase('c')], now: NOW });
    expect(r).toEqual({ cases: 1, users: 2, hits: 2, pushed: 1, skippedOwn: 0, held: 0 });
    expect(pushAll).toHaveBeenCalledTimes(2);

    vi.mocked(ensureVapid).mockImplementationOnce(async () => { throw new Error('no vapid'); });
    const t = memStore([user('a')]);
    expect(await runStreetWatch(env, t.store, { newCases: [kase('c')], now: NOW })).toMatchObject({ hits: 1, pushed: 0 });
  });
});

// ── Quiet hours + morning catch-up ─────────────────────────────────────────────────────

describe('New York clock (nyHour / isQuietHour / isMorningWindow)', () => {
  // UTC instants worked out by hand: EDT = UTC−4 (2026-10-26; DST ends Nov 1 2026), EST = UTC−5 (2026-12-10).
  const EDT = { '21:59': '2026-10-27T01:59:00Z', '22:00': '2026-10-27T02:00:00Z', '06:59': '2026-10-26T10:59:00Z', '07:00': '2026-10-26T11:00:00Z' };
  const EST = { '21:59': '2026-12-11T02:59:00Z', '22:00': '2026-12-11T03:00:00Z', '06:59': '2026-12-10T11:59:00Z', '07:00': '2026-12-10T12:00:00Z' };

  it('nyHour follows the zone, not the cron: 11:00 UTC is 7 in EDT and 6 in EST; midnight is 0, not 24', () => {
    expect(nyHour(Date.parse('2026-10-26T11:00:00Z'))).toBe(7);
    expect(nyHour(Date.parse('2026-12-10T11:00:00Z'))).toBe(6);
    expect(nyHour(Date.parse('2026-10-27T04:00:00Z'))).toBe(0);  // 00:00 EDT
    expect(nyHour(Date.parse('2026-12-11T05:00:00Z'))).toBe(0);  // 00:00 EST
    expect(nyHour(Date.parse('2026-10-27T03:59:59Z'))).toBe(23); // 23:59:59 EDT
  });

  for (const [zone, t] of [['EDT', EDT], ['EST', EST]] as const) {
    it(`isQuietHour on an ${zone} date: 21:59 no, 22:00 yes, 06:59 yes, 07:00 no`, () => {
      expect([nyHour(Date.parse(t['21:59'])), nyHour(Date.parse(t['22:00'])), nyHour(Date.parse(t['06:59'])), nyHour(Date.parse(t['07:00']))]).toEqual([21, 22, 6, 7]); // the fixtures really are those ET clocks
      expect(isQuietHour(Date.parse(t['21:59']))).toBe(false);
      expect(isQuietHour(Date.parse(t['22:00']))).toBe(true);
      expect(isQuietHour(Date.parse(t['06:59']))).toBe(true);
      expect(isQuietHour(Date.parse(t['07:00']))).toBe(false);
    });
  }

  it('isMorningWindow is [05:00, 09:00) ET: the 11:00 UTC daily is inside in both EDT and EST, a midday manual run is not', () => {
    expect(isMorningWindow(Date.parse('2026-10-26T08:59:00Z'))).toBe(false); // 04:59 EDT
    expect(isMorningWindow(Date.parse('2026-10-26T09:00:00Z'))).toBe(true);  // 05:00 EDT
    expect(isMorningWindow(Date.parse('2026-10-26T11:00:00Z'))).toBe(true);  // 07:00 EDT — the cron
    expect(isMorningWindow(Date.parse('2026-12-10T11:00:00Z'))).toBe(true);  // 06:00 EST — the same cron
    expect(isMorningWindow(Date.parse('2026-10-26T12:59:00Z'))).toBe(true);  // 08:59 EDT
    expect(isMorningWindow(Date.parse('2026-10-26T13:00:00Z'))).toBe(false); // 09:00 EDT
    expect(isMorningWindow(NOW)).toBe(false);                                 // 11:00 EDT — a manual /admin/daily
  });

  it('isSyncFlushHour is [07:00, 09:00) ET — the first awake syncs flush the record; the 06:xx EST syncs (still quiet) and the 09:00 sync do not', () => {
    expect(isSyncFlushHour(Date.parse('2026-12-10T11:30:05Z'))).toBe(false); // 06:30 EST — quiet
    expect(isSyncFlushHour(Date.parse('2026-12-10T12:00:05Z'))).toBe(true);  // 07:00 EST
    expect(isSyncFlushHour(Date.parse('2026-10-26T11:00:05Z'))).toBe(true);  // 07:00 EDT
    expect(isSyncFlushHour(Date.parse('2026-10-26T12:30:00Z'))).toBe(true);  // 08:30 EDT — slack for an evicted cron
    expect(isSyncFlushHour(Date.parse('2026-10-26T13:00:00Z'))).toBe(false); // 09:00 EDT
    expect(isSyncFlushHour(NOW)).toBe(false);
  });

  it('the stale rule is derived: 2 h watch window + 22:00 → 09:00 = 13 h, so every case a 22:00 sync may hold survives a 07:00 EDT morning', () => {
    expect(MORNING_MAX_AGE_MS).toBe(13 * 3_600_000);
  });
});

describe('runStreetWatch in quiet hours', () => {
  const QUIET = Date.parse('2026-10-27T06:00:00Z'); // 02:00 EDT
  const QUIET_ISO = new Date(QUIET).toISOString();
  const ago = (m: number) => new Date(QUIET - m * 60_000).toISOString();
  const q = (id: string, o: Partial<WatchCase> = {}) => kase(id, { createdAt: ago(20), ...o });
  const blank = (uid: string, caseId: string): OvernightItem => ({ uid, caseId, label: 'Home', body: '', url: '', at: '', caseType: '', street: '', createdAt: null, near: { address: '', lat: null, lng: null } });
  beforeEach(resetPush);

  it('pushes nothing and holds every hit in meta/watchOvernight — one item per account × case, the push\'s own words — logging watch.held', async () => {
    const s = memStore([user('a'), user('b', { push: [sub(2), sub(3)] }), user('far', { addresses: [addr('f', 'Far', 41.84, -71.41)] })]);
    const r = await runStreetWatch(env, s.store, { newCases: [q('c1'), q('c2', { caseType: 'Street Light Out' })], now: QUIET });
    expect(r).toEqual({ cases: 2, users: 3, hits: 4, pushed: 0, skippedOwn: 0, held: 4 });
    expect(pushAll).not.toHaveBeenCalled();
    expect(ensureVapid).not.toHaveBeenCalled();
    const rec = s.meta[OVERNIGHT_META];
    expect(rec).toMatchObject({ since: QUIET_ISO, at: QUIET_ISO });
    const items = rec.items as OvernightItem[];
    expect(items.map((i) => `${i.uid}:${i.caseId}`)).toEqual(['a:c1', 'b:c1', 'a:c2', 'b:c2']);
    expect(items[0]).toEqual({
      uid: 'a', caseId: 'c1', label: 'Home', body: 'Pothole · 10 Angell St · College Hill', url: 'https://fixmypvd.org/street?case=c1&lat=41.83000&lng=-71.40050', at: QUIET_ISO,
      caseType: 'Pothole', street: '10 Angell St', createdAt: ago(20), near: { address: 'a1 Angell St', lat: HOME.lat, lng: HOME.lng },
    });
    expect(items[2].body).toBe('Street Light Out · 10 Angell St · College Hill');
    expect(s.events.map((e) => e.kind)).toEqual(['watch.held']); // no watch.pushed, no push.sent
    expect(s.events[0]).toMatchObject({ level: 'info', data: { cases: 2, users: 3, hits: 4, pushed: 0, skippedOwn: 0, held: 4, accounts: 2 } });
  });

  it('appends to the night\'s record without repeating a pair, keeps `since`; the own-report skip and the 2-hour rule still apply at record time', async () => {
    const held: OvernightItem = { ...blank('a', 'c1'), body: 'recorded earlier', url: 'u', at: ago(60), caseType: 'Pothole', street: '10 Angell St', createdAt: ago(70), near: { address: 'a1 Angell St', lat: HOME.lat, lng: HOME.lng } };
    const s = memStore([user('a'), user('me')], { me: [{ id: 'r1', portalEntityId: 'c2' } as unknown as ReportDoc] }, { [OVERNIGHT_META]: { items: [held], since: ago(60), at: ago(60) } });
    const r = await runStreetWatch(env, s.store, { newCases: [q('c1'), q('c2'), q('old', { createdAt: ago(121) })], now: QUIET });
    expect(r).toEqual({ cases: 2, users: 2, hits: 3, pushed: 0, skippedOwn: 1, held: 2 }); // a:c1 (already held), me:c1, a:c2 — me:c2 is their own filing
    const items = s.meta[OVERNIGHT_META].items as OvernightItem[];
    expect(items.map((i) => `${i.uid}:${i.caseId}`)).toEqual(['a:c1', 'me:c1', 'a:c2']);
    expect(items[0]).toEqual(held); // the first record of a pair wins
    expect(s.meta[OVERNIGHT_META]).toMatchObject({ since: ago(60), at: QUIET_ISO });
    expect(pushAll).not.toHaveBeenCalled();
  });

  it('nothing watchable (all older than two hours): no users read, no record written', async () => {
    const s = memStore([user('a')]);
    expect(await runStreetWatch(env, s.store, { newCases: [q('old', { createdAt: ago(130) }), q('nogeo', { lat: null, lng: null })], now: QUIET })).toEqual({ cases: 0, users: 0, hits: 0, pushed: 0, skippedOwn: 0, held: 0 });
    expect(s.store.listStreetWatchUsers).not.toHaveBeenCalled();
    expect(s.store.setMeta).not.toHaveBeenCalled();
    expect(s.events).toHaveLength(0);
  });

  it('a full record (200 items) still reports what the run held: `held` counts this run\'s new pairs, not the length delta', async () => {
    const existing = Array.from({ length: OVERNIGHT_CAP }, (_, i) => ({ ...blank('u', `c${i}`), createdAt: ago(10) }));
    const s = memStore([user('a'), user('b')], {}, { [OVERNIGHT_META]: { items: existing, since: ago(60), at: ago(30) } });
    const r = await runStreetWatch(env, s.store, { newCases: [q('new')], now: QUIET });
    expect(r).toEqual({ cases: 1, users: 2, hits: 2, pushed: 0, skippedOwn: 0, held: 2 });
    const items = s.meta[OVERNIGHT_META].items as OvernightItem[];
    expect(items).toHaveLength(OVERNIGHT_CAP);
    expect(items.slice(-2).map((i) => `${i.uid}:${i.caseId}`)).toEqual(['a:new', 'b:new']);
    expect(items[0].caseId).toBe('c2'); // the two oldest fell off
    expect(s.events[0]).toMatchObject({ kind: 'watch.held', data: { held: 2 } });
  });

  it('mergeOvernight keeps the newest 200 (the oldest fall off); parseOvernight keeps only items with a uid and caseId and coerces the rest', () => {
    const existing = Array.from({ length: OVERNIGHT_CAP - 1 }, (_, i) => blank('u', `c${i}`));
    const merged = mergeOvernight(existing, [blank('u', 'c0'), blank('u', 'new1'), blank('u', 'new2')]);
    expect(merged).toHaveLength(OVERNIGHT_CAP);
    expect(merged[0].caseId).toBe('c1');
    expect(merged.slice(-2).map((i) => i.caseId)).toEqual(['new1', 'new2']);
    expect(mergeOvernight([], [blank('u', 'c'), blank('u', 'c')])).toHaveLength(1);
    expect(parseOvernight({ items: [blank('u', 'c1'), { uid: 'u' }, null, 'x', { uid: 'v', caseId: 'c', label: 7, near: { lat: 'no', lng: 1 } }] })).toEqual([
      blank('u', 'c1'),
      { uid: 'v', caseId: 'c', label: '', body: '', url: '', at: '', caseType: '', street: '', createdAt: null, near: { address: '', lat: null, lng: 1 } },
    ]);
    expect(parseOvernight(null)).toEqual([]);
    expect(parseOvernight({ items: 'nope' })).toEqual([]);
  });

  it('21:59 ET is not quiet (pushes, writes no record); 22:00 ET is — on an EDT and an EST date', async () => {
    for (const [awake, asleep] of [['2026-10-27T01:59:00Z', '2026-10-27T02:00:00Z'], ['2026-12-11T02:59:00Z', '2026-12-11T03:00:00Z']]) {
      resetPush();
      const a = memStore([user('a')]);
      const tA = Date.parse(awake);
      expect(await runStreetWatch(env, a.store, { newCases: [kase('c', { createdAt: new Date(tA - 60_000).toISOString() })], now: tA })).toEqual({ cases: 1, users: 1, hits: 1, pushed: 1, skippedOwn: 0, held: 0 });
      expect(pushAll).toHaveBeenCalledTimes(1);
      expect(a.store.setMeta).not.toHaveBeenCalled();
      expect(a.events.map((e) => e.kind)).toEqual(['watch.pushed', 'push.sent']);

      const b = memStore([user('a')]);
      const tB = Date.parse(asleep);
      expect(await runStreetWatch(env, b.store, { newCases: [kase('c', { createdAt: new Date(tB - 60_000).toISOString() })], now: tB })).toEqual({ cases: 1, users: 1, hits: 1, pushed: 0, skippedOwn: 0, held: 1 });
      expect(pushAll).toHaveBeenCalledTimes(1); // still the one from the awake run
      expect(b.meta[OVERNIGHT_META].items).toHaveLength(1);
    }
  });

  it('never throws into the sync: a record read or write that fails holds nothing and pushes nothing', async () => {
    const w = memStore([user('a')]);
    (w.store.setMeta as any).mockImplementation(async () => { throw new Error('write failed'); });
    expect(await runStreetWatch(env, w.store, { newCases: [q('c')], now: QUIET })).toEqual({ cases: 1, users: 1, hits: 1, pushed: 0, skippedOwn: 0, held: 0 });
    const r = memStore([user('a')]);
    (r.store.getMeta as any).mockImplementation(async () => { throw new Error('read failed'); });
    expect(await runStreetWatch(env, r.store, { newCases: [q('c')], now: QUIET })).toEqual({ cases: 1, users: 1, hits: 1, pushed: 0, skippedOwn: 0, held: 0 });
    expect(r.store.setMeta).not.toHaveBeenCalled(); // a blind write could wipe the night's record
    expect(pushAll).not.toHaveBeenCalled();
  });
});

describe('runWatchMorning', () => {
  const MORNING = Date.parse('2026-10-26T11:00:00Z'); // the daily cron: 07:00 EDT
  const MORNING_ISO = new Date(MORNING).toISOString();
  const hoursBefore = (h: number) => new Date(MORNING - h * 3_600_000).toISOString();
  const MAX_H = MORNING_MAX_AGE_MS / 3_600_000; // 13
  const item = (uid: string, caseId: string, o: Partial<OvernightItem> = {}): OvernightItem => ({
    uid, caseId, label: 'Home', body: 'Pothole · 10 Angell St · College Hill', url: `https://fixmypvd.org/street?case=${caseId}&lat=41.83000&lng=-71.40050`, at: hoursBefore(4),
    caseType: 'Pothole', street: '10 Angell St', createdAt: hoursBefore(4), near: { address: 'a1 Angell St', lat: HOME.lat, lng: HOME.lng }, ...o,
  });
  const record = (items: OvernightItem[]) => ({ [OVERNIGHT_META]: { items, since: hoursBefore(8), at: hoursBefore(1) } });
  const EMPTY = { ran: true, items: 0, stale: 0, accounts: 0, skippedOff: 0, pushedTo: 0, pushed: 0 };
  beforeEach(resetPush);

  it('one push per account — one item names its case and opens its card, several open the first address and list two, mixed labels say "your places"; stale items and accounts that turned the watch off, lost push or are gone get nothing; the record is cleared', async () => {
    const items = [
      item('a', 'c1'),
      item('a', 'stale', { createdAt: hoursBefore(MAX_H + 1) }),
      item('b', 'c2'), item('b', 'c3', { caseType: 'Graffiti', street: '12 Thayer St' }),
      item('c', 'c4'), item('c', 'c5', { label: 'Work', caseType: 'Street Light Out', street: '', near: { address: '5 Main St', lat: 41.83, lng: -71.41 } }), item('c', 'c6', { caseType: 'Missed Trash' }),
      item('off', 'c7'), item('nopush', 'c8'), item('gone', 'c9'),
    ];
    const s = memStore([user('a'), user('b'), user('c'), user('off', { prefs: { emailUpdates: true, streetWatch: false } }), user('nopush', { push: [] })], {}, record(items));
    const r = await runWatchMorning(env, s.store, { now: MORNING });
    expect(r).toEqual({ ran: true, items: 10, stale: 1, accounts: 6, skippedOff: 3, pushedTo: 3, pushed: 3 });
    expect(vi.mocked(pushAll).mock.calls.map(([, u, p, k]) => ({ uid: u.uid, keys: !!k, ...p }))).toEqual([
      { uid: 'a', keys: true, title: 'Overnight near Home', body: '1 new request: Pothole · 10 Angell St', url: 'https://fixmypvd.org/street?case=c1&lat=41.83000&lng=-71.40050', tag: 'watch:morning' },
      { uid: 'b', keys: true, title: 'Overnight near Home', body: '2 new requests near your places: Pothole · 10 Angell St · Graffiti · 12 Thayer St', url: 'https://fixmypvd.org/street?lat=41.82820&lng=-71.40050&q=a1%20Angell%20St', tag: 'watch:morning' },
      { uid: 'c', keys: true, title: 'Overnight near your places', body: '3 new requests near your places: Pothole · 10 Angell St · Street Light Out', url: 'https://fixmypvd.org/street?lat=41.82820&lng=-71.40050&q=a1%20Angell%20St', tag: 'watch:morning' },
    ]);
    expect(vi.mocked(ensureVapid)).toHaveBeenCalledTimes(1);
    expect((s.store.getUser as any).mock.calls.map((c: any[]) => c[0])).toEqual(['a', 'b', 'c', 'off', 'nopush', 'gone']);
    expect(s.meta[OVERNIGHT_META]).toMatchObject({ items: [], since: null, at: MORNING_ISO, clearedAt: MORNING_ISO });
    expect(s.events.map((e) => e.kind)).toEqual(['watch.morning', 'push.sent']);
    expect(s.events[0]).toMatchObject({ level: 'info', data: { ran: true, items: 10, stale: 1, accounts: 6, skippedOff: 3, pushedTo: 3, pushed: 3 } });
    expect(s.events[1]).toMatchObject({ data: { source: 'street_watch', users: 3, sent: 3, morning: true } });
  });

  it('morningPush: several items whose first address has no coordinates open plain /street (trailing slash on the base is fine); a blank label falls back to "your places"', () => {
    const items = [item('a', 'c1', { near: { address: 'x', lat: null, lng: null } }), item('a', 'c2', { street: '' })];
    expect(morningPush(items, 'https://fixmypvd.org/')).toEqual({ title: 'Overnight near Home', body: '2 new requests near your places: Pothole · 10 Angell St · Pothole', url: 'https://fixmypvd.org/street', tag: 'watch:morning' });
    expect(morningPush([items[1]], 'https://fixmypvd.org/')).toEqual({ title: 'Overnight near Home', body: '1 new request: Pothole', url: items[1].url, tag: 'watch:morning' });
    expect(morningPush([item('a', 'c', { label: '  ' })], 'b').title).toBe('Overnight near your places');
  });

  it('outside 05:00–09:00 ET (a manual run) nothing is read, pushed or written and the record is kept; the 06:00 EST cron and a 05:00 run are inside', async () => {
    for (const t of [NOW, Date.parse('2026-10-26T13:00:00Z') /* 09:00 EDT */, Date.parse('2026-10-26T08:59:00Z') /* 04:59 EDT */]) {
      const s = memStore([user('a')], {}, record([item('a', 'c1')]));
      expect(await runWatchMorning(env, s.store, { now: t })).toEqual({ ...EMPTY, ran: false });
      expect(s.store.getMeta).not.toHaveBeenCalled();
      expect(s.store.setMeta).not.toHaveBeenCalled();
      expect(s.meta[OVERNIGHT_META].items).toHaveLength(1);
      expect(s.events).toHaveLength(0);
    }
    expect(pushAll).not.toHaveBeenCalled();
    for (const t of [Date.parse('2026-12-10T11:00:00Z') /* 06:00 EST — the cron */, Date.parse('2026-10-26T09:00:00Z') /* 05:00 EDT */]) {
      const s = memStore([user('a')], {}, record([item('a', 'c1', { createdAt: new Date(t - 3_600_000).toISOString() })]));
      expect(await runWatchMorning(env, s.store, { now: t })).toEqual({ ...EMPTY, items: 1, accounts: 1, pushedTo: 1, pushed: 1 });
      expect(s.meta[OVERNIGHT_META].items).toEqual([]);
    }
  });

  it('an empty or missing record: nothing written, nothing logged; all-stale: dropped, cleared, logged', async () => {
    const none = memStore([user('a')]);
    expect(await runWatchMorning(env, none.store, { now: MORNING })).toEqual(EMPTY);
    expect(none.store.setMeta).not.toHaveBeenCalled();
    const empty = memStore([user('a')], {}, { [OVERNIGHT_META]: { items: [], since: null } });
    expect(await runWatchMorning(env, empty.store, { now: MORNING })).toEqual(EMPTY);
    expect(empty.store.setMeta).not.toHaveBeenCalled();
    expect([...none.events, ...empty.events]).toHaveLength(0);
    const stale = memStore([user('a')], {}, record([item('a', 'c1', { createdAt: hoursBefore(MAX_H + 0.01) }), item('a', 'undated', { createdAt: null })]));
    expect(await runWatchMorning(env, stale.store, { now: MORNING })).toEqual({ ...EMPTY, items: 2, stale: 2 });
    expect(pushAll).not.toHaveBeenCalled();
    expect(stale.store.getUser).not.toHaveBeenCalled();
    expect(stale.meta[OVERNIGHT_META].items).toEqual([]);
    expect(stale.events.map((e) => e.kind)).toEqual(['watch.morning']); // push.sent needs a reached account
    // exactly the limit is still fresh; a record resurrected a day later is not
    const edge = memStore([user('a')], {}, record([item('a', 'c1', { createdAt: hoursBefore(MAX_H) }), item('a', 'yesterday', { createdAt: hoursBefore(24) })]));
    expect(await runWatchMorning(env, edge.store, { now: MORNING })).toMatchObject({ items: 2, stale: 1, pushed: 1 });
    expect(vi.mocked(pushAll).mock.calls[0][2].body).toBe('1 new request: Pothole · 10 Angell St');
  });

  it('EDT, the realistic night: a case created 20:30 ET is held by the 22:00 sync (1 h 30 m old) and PUSHED by the 07:00 EDT morning, not dropped as stale', async () => {
    const created = '2026-10-27T00:30:00Z';      // 20:30 EDT
    const sync = Date.parse('2026-10-27T02:00:05Z');   // 22:00:05 EDT — the first quiet sync
    const morning = Date.parse('2026-10-27T11:00:05Z'); // 07:00:05 EDT — the daily
    const s = memStore([user('a')]);
    expect(await runStreetWatch(env, s.store, { newCases: [kase('c', { createdAt: created })], now: sync })).toEqual({ cases: 1, users: 1, hits: 1, pushed: 0, skippedOwn: 0, held: 1 });
    expect(pushAll).not.toHaveBeenCalled();
    const r = await runWatchMorning(env, s.store, { now: morning });
    expect(r).toEqual({ ...EMPTY, items: 1, stale: 0, accounts: 1, pushedTo: 1, pushed: 1 });
    expect(vi.mocked(pushAll).mock.calls.map(([, u, p]) => ({ uid: u.uid, title: p.title, body: p.body }))).toEqual([{ uid: 'a', title: 'Overnight near Home', body: '1 new request: Pothole · 10 Angell St' }]);
    expect(s.meta[OVERNIGHT_META].items).toEqual([]);
  });

  it('EST: the 06:00 and 06:30 ET syncs hold (the 11:00 UTC daily is still quiet); the 07:00 sync flushes ONE "Overnight near Home" push before its own live push and clears the record', async () => {
    const s = memStore([user('a')]);
    const at = (iso: string) => Date.parse(iso);
    const c = (id: string, t: string, o: Partial<WatchCase> = {}) => kase(id, { createdAt: new Date(at(t) - 10 * 60_000).toISOString(), ...o });
    // 06:00 EST: the 11:00 UTC daily is inside the 05–09 morning window, runs first and finds nothing; the sync that follows is in quiet hours and holds.
    expect(await runWatchMorning(env, s.store, { now: at('2026-12-10T11:00:00Z') })).toEqual(EMPTY);
    expect(await runStreetWatch(env, s.store, { newCases: [c('six', '2026-12-10T11:00:05Z')], now: at('2026-12-10T11:00:05Z') })).toEqual({ cases: 1, users: 1, hits: 1, pushed: 0, skippedOwn: 0, held: 1 });
    expect(await runStreetWatch(env, s.store, { newCases: [c('halfpast', '2026-12-10T11:30:05Z', { caseType: 'Graffiti' })], now: at('2026-12-10T11:30:05Z') })).toEqual({ cases: 1, users: 1, hits: 1, pushed: 0, skippedOwn: 0, held: 1 });
    expect(pushAll).not.toHaveBeenCalled();
    expect(s.meta[OVERNIGHT_META].items).toHaveLength(2);
    // 07:00 EST: the first awake sync flushes the record, then pushes its own live hit.
    const seven = at('2026-12-10T12:00:05Z');
    const r = await runStreetWatch(env, s.store, { newCases: [c('live', '2026-12-10T12:00:05Z', { caseType: 'Street Light Out' })], now: seven });
    expect(r).toEqual({ cases: 1, users: 1, hits: 1, pushed: 1, skippedOwn: 0, held: 0, morning: { ran: true, items: 2, stale: 0, accounts: 1, skippedOff: 0, pushedTo: 1, pushed: 1 } });
    expect(vi.mocked(pushAll).mock.calls.map(([, u, p]) => ({ uid: u.uid, title: p.title, body: p.body, tag: p.tag }))).toEqual([
      { uid: 'a', title: 'Overnight near Home', body: '2 new requests near your places: Pothole · 10 Angell St · Graffiti · 10 Angell St', tag: 'watch:morning' },
      { uid: 'a', title: 'New near Home', body: 'Street Light Out · 10 Angell St · College Hill', tag: 'watch:live' },
    ]);
    expect(s.meta[OVERNIGHT_META]).toMatchObject({ items: [], since: null, clearedAt: new Date(seven).toISOString() });
    expect(s.events.map((e) => e.kind)).toEqual(['watch.held', 'watch.held', 'watch.morning', 'push.sent', 'watch.pushed', 'push.sent']);
    // 07:30: the record is empty — one read, nothing written, nothing pushed, and a run with nothing new still returns the (empty) catch-up.
    resetPush();
    (s.store.setMeta as any).mockClear();
    expect(await runStreetWatch(env, s.store, { newCases: [], now: at('2026-12-10T12:30:05Z') })).toEqual({ cases: 0, users: 0, hits: 0, pushed: 0, skippedOwn: 0, held: 0, morning: EMPTY });
    expect(s.store.setMeta).not.toHaveBeenCalled();
    expect(pushAll).not.toHaveBeenCalled();
    // 09:00 ET with a record: a sync does not flush (outside the window) and the record is kept for the daily / next morning.
    const late = memStore([user('a')], {}, record([item('a', 'c1')]));
    expect(await runStreetWatch(env, late.store, { newCases: [], now: at('2026-10-26T13:00:00Z') })).toEqual({ cases: 0, users: 0, hits: 0, pushed: 0, skippedOwn: 0, held: 0 });
    expect(late.store.getMeta).not.toHaveBeenCalled();
    expect(late.meta[OVERNIGHT_META].items).toHaveLength(1);
  });

  it('clearing re-reads the record: an item a sync held while the catch-up was pushing stays for the next morning', async () => {
    const s = memStore([user('a'), user('b')], {}, record([item('a', 'c1')]));
    (s.store.getMeta as any)
      .mockImplementationOnce(async () => s.meta[OVERNIGHT_META])
      .mockImplementationOnce(async () => ({ items: [item('a', 'c1'), item('b', 'c9')], since: hoursBefore(8) }));
    expect(await runWatchMorning(env, s.store, { now: MORNING })).toEqual({ ...EMPTY, items: 1, accounts: 1, pushedTo: 1, pushed: 1 });
    expect(s.meta[OVERNIGHT_META]).toMatchObject({ since: hoursBefore(8), items: [expect.objectContaining({ uid: 'b', caseId: 'c9' })], clearedAt: MORNING_ISO });
    expect(vi.mocked(pushAll).mock.calls.map(([, u]) => u.uid)).toEqual(['a']);
  });

  it('never throws: a record read that fails keeps the record; a user read or a push that throws moves on; a clear that fails is swallowed', async () => {
    const a = memStore([user('a')], {}, record([item('a', 'c1')]));
    (a.store.getMeta as any).mockImplementationOnce(async () => { throw new Error('down'); });
    expect(await runWatchMorning(env, a.store, { now: MORNING })).toEqual(EMPTY);
    expect(a.store.setMeta).not.toHaveBeenCalled();
    expect(a.meta[OVERNIGHT_META].items).toHaveLength(1);

    const b = memStore([user('a'), user('b')], {}, record([item('a', 'c1'), item('b', 'c2')]));
    (b.store.getUser as any).mockImplementationOnce(async () => { throw new Error('users down'); });
    vi.mocked(pushAll).mockImplementationOnce(async () => { throw new Error('boom'); });
    expect(await runWatchMorning(env, b.store, { now: MORNING })).toEqual({ ...EMPTY, items: 2, accounts: 2 });
    expect(b.meta[OVERNIGHT_META].items).toEqual([]);

    const c = memStore([user('a')], {}, record([item('a', 'c1')]));
    (c.store.setMeta as any).mockImplementation(async () => { throw new Error('write failed'); });
    expect(await runWatchMorning(env, c.store, { now: MORNING })).toEqual({ ...EMPTY, items: 1, accounts: 1, pushedTo: 1, pushed: 1 });

    vi.mocked(ensureVapid).mockImplementationOnce(async () => { throw new Error('no vapid'); });
    const d = memStore([user('a')], {}, record([item('a', 'c1')]));
    expect(await runWatchMorning(env, d.store, { now: MORNING })).toEqual({ ...EMPTY, items: 1, accounts: 1 });
    expect(d.meta[OVERNIGHT_META].items).toEqual([]);
  });
});
