import { describe, expect, it, vi, beforeEach } from 'vitest';
import { nearbyCases, handleStreet, handleStreetCity, handleStreetMap, cityOverview, mapFeed, snapDays, resetStreetCache, streetDigestEmail, runStreetDigest, streetUrl, LOAD_LIMIT, KNOWN_STATUSES, type MapItem } from '../src/street.js';
import type { Env, Mailer, Store, UserDoc } from '../src/contracts.js';

// Angell St / Thayer St corner (41.8282, -71.4005) as "home"; cases are placed by hand around it.
const HOME = { lat: 41.8282, lng: -71.4005 };
const NOW = Date.parse('2026-10-25T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status: 'Assigned',
  createdAt: daysAgo(3), firstSeenAt: daysAgo(3), lat: 41.8283, lng: -71.4006, ...o,
});

describe('nearbyCases', () => {
  it('keeps cases inside the radius that were created or closed inside the window, newest activity first', () => {
    const rows = [
      row('new-near'),
      row('far', { lat: 41.84, lng: -71.41 }),                                     // ~1.5 km away
      row('old-open', { createdAt: daysAgo(45), firstSeenAt: daysAgo(45) }),      // created before the window, still open
      row('old-closed-this-week', { createdAt: daysAgo(45), firstSeenAt: daysAgo(45), status: 'Resolved', detail: { resolutionDate: daysAgo(1), resolution: 'Filled.' } }),
      row('no-geo', { lat: null, lng: null }),
      row('draft', { status: 'Draft' }),
    ];
    const got = nearbyCases(rows, { ...HOME, radiusM: 300, days: 30, now: NOW });
    expect(got.map((c) => c.id)).toEqual(['old-closed-this-week', 'new-near']);
    expect(got[0]).toMatchObject({ open: false, closedAt: daysAgo(1), resolution: 'Filled.', distanceM: expect.any(Number) });
    expect(got[1]).toMatchObject({ open: true, closedAt: null, resolution: null });
    expect(got[1].distanceM).toBeLessThan(20);
  });

  it('dates a close we watched (statusSeen) when the city gave no resolution date', () => {
    const rows = [row('watched', { status: 'Resolved', statusSeen: { Assigned: daysAgo(3), Resolved: daysAgo(2) } })];
    expect(nearbyCases(rows, { ...HOME, radiusM: 300, days: 30, now: NOW })[0].closedAt).toBe(daysAgo(2));
  });
});

const env = { APP_BASE_URL: 'https://fixmypvd.org' } as Env;

describe('GET /api/street', () => {
  beforeEach(() => resetStreetCache());
  const store = (rows: Record<string, unknown>[]) => ({ listCityCasesSince: vi.fn(async () => rows) } as unknown as Store);

  it('rejects points outside Rhode Island and clamps radius / days', async () => {
    const s = store([row('a')]);
    expect((await handleStreet(new URL('https://api.test/api/street?lat=40.7&lng=-74'), s)).status).toBe(400);
    const r = await handleStreet(new URL(`https://api.test/api/street?lat=${HOME.lat}&lng=${HOME.lng}&radiusM=99999&days=0`), s);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('max-age=300');
    const j = await r.json() as { items: unknown[]; radiusM: number; days: number };
    expect(j).toMatchObject({ radiusM: 1000, days: 30 });
    expect(j.items).toHaveLength(1);
  });

  it('reads Firestore once per window and serves the next call from memory', async () => {
    const s = store([row('a')]);
    const url = new URL(`https://api.test/api/street?lat=${HOME.lat}&lng=${HOME.lng}`);
    await handleStreet(url, s); await handleStreet(url, s);
    expect((s.listCityCasesSince as any).mock.calls).toHaveLength(1);
    // The load window reaches back past the asked-for days so a case closed this month but opened in August still shows.
    const since = (s.listCityCasesSince as any).mock.calls[0][0] as string;
    expect(Date.parse(since)).toBeLessThan(Date.now() - 80 * 86_400_000);
  });
});

describe('citywide overview', () => {
  beforeEach(() => resetStreetCache());
  it('counts the week, ranks case types, lists the newest activity, and does not need coordinates', () => {
    const rows = [
      row('a', { lat: null, lng: null }),
      row('b', { caseType: 'Pothole' }),
      row('c', { caseType: 'Street Light Out', status: 'Resolved', detail: { resolutionDate: daysAgo(1), resolution: 'Fixed' } }),
      row('old', { createdAt: daysAgo(20) }),
      row('draft', { status: 'Draft' }),
    ];
    const o = cityOverview(rows, { days: 7, now: NOW, latestN: 2 });
    expect(o).toMatchObject({ days: 7, total: 3, open: 2, closed: 1, located: 2 });
    expect(o.topTypes).toEqual([{ caseType: 'Pothole', category: 'pothole', n: 2 }, { caseType: 'Street Light Out', category: 'pothole', n: 1 }]);
    expect(o.latest.map((c) => c.id)).toEqual(['c', 'a']);
    expect(o.latest[0]).toMatchObject({ open: false, resolution: 'Fixed' });
    expect(o.latest[0]).not.toHaveProperty('distanceM');
  });
  it('GET /api/street/city defaults to 7 days and is cacheable', async () => {
    const s = { listCityCasesSince: vi.fn(async () => [row('a')]) } as unknown as Store;
    const r = await handleStreetCity(new URL('https://api.test/api/street/city'), s);
    expect(r.headers.get('cache-control')).toContain('max-age=300');
    expect(await r.json()).toMatchObject({ days: 7, total: 1 });
  });
});

describe('weekly digest', () => {
  const user = (o: Partial<UserDoc> = {}): UserDoc => ({
    uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', createdAt: daysAgo(30), lastSeenAt: daysAgo(1),
    prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a1', label: 'Home', address: '12 Angell St', lat: HOME.lat, lng: HOME.lng }], following: [], ...o,
  });
  function deps(users: UserDoc[], rows: Record<string, unknown>[]) {
    const sent: { to: string; subject: string; html: string; kind?: string }[] = [];
    const patched: Record<string, unknown>[] = [];
    const store = {
      listStreetDigestUsers: vi.fn(async () => users),
      listCityCasesSince: vi.fn(async () => rows),
      patchUser: vi.fn(async (_uid: string, f: Record<string, unknown>) => { patched.push(f); }),
      setMeta: vi.fn(async () => {}), addEvent: vi.fn(async () => {}),
    } as unknown as Store;
    const mailer = { sendTo: vi.fn(async (to: string, subject: string, html: string, o?: { kind?: string }) => { sent.push({ to, subject, html, kind: o?.kind }); }) } as unknown as Mailer;
    return { store, mailer, sent, patched };
  }
  beforeEach(() => resetStreetCache());

  it('mails one summary per account with activity near a saved address, and nothing when the week was quiet', async () => {
    const rows = [row('p1'), row('p2', { caseType: 'Street Light Out', status: 'Resolved', detail: { resolutionDate: daysAgo(2), resolution: 'Bulb replaced' } })];
    const quiet = user({ uid: 'u2', email: 'far@example.com', addresses: [{ id: 'b', label: 'Work', address: '1 Far Away Rd', lat: 41.84, lng: -71.41 }] });
    const unverified = user({ uid: 'u3', email: 'x@example.com', emailVerified: false });
    const d = deps([user(), quiet, unverified], rows);
    const r = await runStreetDigest(env, d.store, d.mailer, { now: NOW });
    expect(r).toEqual({ users: 3, mailed: 1 });
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toMatchObject({ to: 'me@example.com', subject: 'This week near Home: 2 new, 1 closed', kind: 'street_digest' });
    expect(d.sent[0].html).toContain('Street Light Out');
    expect(d.sent[0].html).toContain('Bulb replaced');
    expect(d.sent[0].html).toContain(streetUrl('https://fixmypvd.org', { lat: HOME.lat, lng: HOME.lng, address: '12 Angell St' }).replace(/&/g, '&amp;'));
    expect(d.sent[0].html).toContain('/account');
    // The off switch lives on the street page's digest card (Account only manages addresses): the footer links the first section's URL for it.
    expect(d.sent[0].html).toMatch(/turn it off with "Turn off" under <a href="https:\/\/fixmypvd\.org\/street\?lat=[^"]+">Hear about this street every week<\/a>/);
  });

  it('geocodes a saved address that has no coordinates yet and stores them on the account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ location: { x: HOME.lng, y: HOME.lat }, score: 100 }] })));
    const d = deps([user({ addresses: [{ id: 'a1', label: 'Home', address: '12 Angell St', lat: null, lng: null }] })], [row('p1')]);
    (d.store as any).getMeta = vi.fn(async () => null);
    try {
      expect(await runStreetDigest(env, d.store, d.mailer, { now: NOW })).toEqual({ users: 1, mailed: 1 });
      expect(d.patched[0]).toEqual({ addresses: [{ id: 'a1', label: 'Home', address: '12 Angell St', lat: HOME.lat, lng: HOME.lng }] });
    } finally { vi.unstubAllGlobals(); }
  });

  it('the email names several addresses when more than one had activity', () => {
    const items = nearbyCases([row('p1')], { ...HOME, radiusM: 300, days: 7, now: NOW });
    const m = streetDigestEmail([
      { label: 'Home', address: '12 Angell St', url: 'https://x/1', items },
      { label: 'Work', address: '1 Dorrance St', url: 'https://x/2', items },
    ], { base: 'https://fixmypvd.org', since: daysAgo(7) });
    expect(m.subject).toBe('This week near 2 of your addresses: 2 new, 0 closed');
    expect(m.html).toContain('https://x/2');
  });
});

describe('mapFeed', () => {
  const minutes = (iso: string) => Math.floor(Date.parse(iso) / 60_000);

  it('keeps non-Draft cases created or closed in the window, dates closes from resolutionDate or statusSeen, newest activity first', () => {
    const rows = [
      row('new-open'),
      row('old-open', { createdAt: daysAgo(45), firstSeenAt: daysAgo(45) }),                       // out of window, still open → dropped
      row('old-closed-yesterday', { createdAt: daysAgo(45), firstSeenAt: daysAgo(45), status: 'Resolved', detail: { resolutionDate: daysAgo(1), resolution: 'Filled.' } }),
      row('watched-close', { createdAt: daysAgo(10), firstSeenAt: daysAgo(10), status: 'Closed', statusSeen: { Assigned: daysAgo(10), Closed: daysAgo(2) } }),
      row('draft', { status: 'Draft' }),
      row('DRAFT-caps', { status: 'DRAFT' }),
    ];
    const f = mapFeed(rows, { days: 30, now: NOW });
    expect(f.items.map((i) => i[0])).toEqual(['old-closed-yesterday', 'watched-close', 'new-open']);
    const byId = Object.fromEntries(f.items.map((i) => [i[0], i])) as Record<string, MapItem>;
    expect(byId['old-closed-yesterday'][3]).toBe(minutes(daysAgo(45)));   // createdMin
    expect(byId['old-closed-yesterday'][4]).toBe(minutes(daysAgo(1)));    // closedMin from detail.resolutionDate
    expect(byId['watched-close'][4]).toBe(minutes(daysAgo(2)));           // closedMin from the statusSeen close we watched
    expect(byId['new-open'][4]).toBe(0);                                  // open → 0
    expect(f).toMatchObject({ v: 1, days: 30, at: new Date(NOW).toISOString(), total: 3, located: 3, truncated: false });
  });

  it('keeps unlocated rows (counted in total, not located), rounds coords to 5 dp, uses the exact tuple column order', () => {
    const rows = [
      row('placed', { lat: 41.828349999, lng: -71.400612345, street: '10 Angell St', status: 'Resolved', detail: { resolutionDate: daysAgo(1), resolution: '  Bulb replaced.  ' } }),
      row('unplaced', { lat: null, lng: null, street: '', caseType: 'Street Light Out', category: 'street_light' }),
      row('half-geo', { lat: 41.8, lng: undefined }),
    ];
    const f = mapFeed(rows, { days: 30, now: NOW });
    expect(f.total).toBe(3);
    expect(f.located).toBe(1);
    const placed = f.items.find((i) => i[0] === 'placed')!;
    expect(placed).toEqual(['placed', 0, f.statuses.indexOf('Resolved'), minutes(daysAgo(3)), minutes(daysAgo(1)), 41.82835, -71.40061, '10 Angell St', 'Bulb replaced.']);
    const unplaced = f.items.find((i) => i[0] === 'unplaced')!;
    expect(unplaced.slice(1)).toEqual([1, f.statuses.indexOf('Assigned'), minutes(daysAgo(3)), 0, null, null, '', 0]);
    expect(f.items.find((i) => i[0] === 'half-geo')!.slice(5, 7)).toEqual([null, null]);
  });

  it('builds the types table by caseType (first-seen category wins, unsure when absent) and seeds statuses with the eight known values', () => {
    const rows = [
      row('a', { caseType: 'Pothole', category: 'pothole' }),
      row('b', { caseType: 'Pothole', category: 'sidewalk' }),              // same caseType, different category → first wins
      row('c', { caseType: 'Mystery', category: undefined, status: 'Weird State' }),
      row('d', { caseType: 'Street Light Out', category: 'street_light', status: 'Resolved', detail: { resolutionDate: daysAgo(1) } }),
      row('e', { caseType: 'Mystery', category: '', status: 'Weird State' }),
    ];
    const f = mapFeed(rows, { days: 30, now: NOW });
    expect(f.types).toEqual([['Pothole', 'pothole'], ['Mystery', 'unsure'], ['Street Light Out', 'street_light']]);
    expect(f.statuses).toEqual([...KNOWN_STATUSES, 'Weird State']);
    expect(f.statuses.slice(0, 8)).toEqual(['Submitted', 'Assigned', 'In Progress', 'Department Responded', 'Resolved', 'Closed', 'Cancelled', 'Merged']);
    const byId = Object.fromEntries(f.items.map((i) => [i[0], i])) as Record<string, MapItem>;
    expect([byId.a[1], byId.b[1], byId.c[1], byId.d[1], byId.e[1]]).toEqual([0, 0, 1, 2, 1]);
    expect([byId.a[2], byId.c[2], byId.d[2], byId.e[2]]).toEqual([1, 8, 4, 8]);
  });

  it('cuts the resolution to 300 chars, sends 0 when absent or blank, and passes truncated through', () => {
    const long = 'x'.repeat(450);
    const rows = [
      row('long', { status: 'Resolved', detail: { resolutionDate: daysAgo(1), resolution: long } }),
      row('blank', { status: 'Resolved', detail: { resolutionDate: daysAgo(1), resolution: '   ' } }),
      row('none', { status: 'Resolved', detail: { resolutionDate: daysAgo(1) } }),
      row('open'),
    ];
    const f = mapFeed(rows, { days: 30, now: NOW, truncated: true });
    const res = (id: string) => f.items.find((i) => i[0] === id)![8];
    expect(res('long')).toBe('x'.repeat(300));
    expect(res('blank')).toBe(0);
    expect(res('none')).toBe(0);
    expect(res('open')).toBe(0);
    expect(f.truncated).toBe(true);
    expect(mapFeed(rows, { days: 30, now: NOW }).truncated).toBe(false);
  });

  it('is empty but well-formed when nothing is in the window', () => {
    const f = mapFeed([row('old', { createdAt: daysAgo(40) })], { days: 7, now: NOW });
    expect(f).toMatchObject({ v: 1, days: 7, total: 0, located: 0, types: [], items: [] });
    expect(f.statuses).toEqual([...KNOWN_STATUSES]);
  });
});

describe('GET /api/street/map', () => {
  beforeEach(() => resetStreetCache());
  const store = (rows: Record<string, unknown>[]) => ({ listCityCasesSince: vi.fn(async () => rows) } as unknown as Store);

  it('snaps days so the caches hit', () => {
    expect(snapDays(null)).toBe(30);
    expect(snapDays('')).toBe(30);
    expect(snapDays('3')).toBe(7);
    expect(snapDays('7')).toBe(7);
    expect(snapDays('12')).toBe(30);
    expect(snapDays('30')).toBe(30);
    expect(snapDays('31')).toBe(90);
    expect(snapDays('400')).toBe(90);
    expect(snapDays('abc')).toBe(30);
    expect(snapDays('0')).toBe(30);
    expect(snapDays('-5')).toBe(30);
  });

  it('returns v:1 with the snapped window and a 5-minute public cache header', async () => {
    const s = store([row('a'), row('b', { lat: null, lng: null })]);
    const r = await handleStreetMap(new URL('https://api.test/api/street/map?days=12'), s);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    const j = await r.json() as { v: number; days: number; total: number; located: number; truncated: boolean; items: MapItem[] };
    expect(j).toMatchObject({ v: 1, days: 30, total: 2, located: 1, truncated: false });
    expect(j.items).toHaveLength(2);
    expect(j.items[0]).toHaveLength(9);
  });

  it('shares one listCityCasesSince read across two map calls and a following /api/street call for the same window', async () => {
    const s = store([row('a')]);
    await handleStreetMap(new URL('https://api.test/api/street/map'), s);
    await handleStreetMap(new URL('https://api.test/api/street/map?days=30'), s);
    await handleStreet(new URL(`https://api.test/api/street?lat=${HOME.lat}&lng=${HOME.lng}`), s);
    expect((s.listCityCasesSince as any).mock.calls).toHaveLength(1);
    // 90 days is a different window → its own read.
    await handleStreetMap(new URL('https://api.test/api/street/map?days=90'), s);
    expect((s.listCityCasesSince as any).mock.calls).toHaveLength(2);
    expect((s.listCityCasesSince as any).mock.calls[1][1]).toBe(LOAD_LIMIT);
  });

  it('reports truncated:true when the store returns a full page of rows', async () => {
    const full = Array.from({ length: LOAD_LIMIT }, (_, i) => row(`r${i}`));
    expect(LOAD_LIMIT).toBe(3000);
    const r = await handleStreetMap(new URL('https://api.test/api/street/map?days=90'), store(full));
    const j = await r.json() as { truncated: boolean; total: number };
    expect(j.truncated).toBe(true);
    expect(j.total).toBe(3000);
    resetStreetCache();                                         // same window → would otherwise be served from the isolate cache
    const r2 = await handleStreetMap(new URL('https://api.test/api/street/map?days=90'), store(full.slice(0, 2999)));
    expect(((await r2.json()) as { truncated: boolean }).truncated).toBe(false);
  });
});
