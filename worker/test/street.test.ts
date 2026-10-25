import { describe, expect, it, vi, beforeEach } from 'vitest';
import { nearbyCases, handleStreet, resetStreetCache, streetDigestEmail, runStreetDigest, streetUrl } from '../src/street.js';
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
