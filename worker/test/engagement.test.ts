import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  countAccounts, weekDigestRun, streetDigestRun, pickEvents, pickMails, maskEmail, buildEngagement, engagement, resetEngagementCache,
  ENGAGEMENT_SCAN, ENGAGEMENT_TTL_MS, RECENT_EVENTS, RECENT_MAILS, EVENT_SCAN, MAIL_SCAN, ENGAGEMENT_EVENT_KINDS, ENGAGEMENT_MAIL_KINDS,
} from '../src/engagement';
import { handleAdmin } from '../src/adminapi';
import type { Env, Store, UserDoc, PushSub } from '../src/contracts';
import type { EmailRecord } from '../src/emaillog';

// GET /api/admin/engagement — who is subscribed to what, for the admin Engagement tab (2026-10-26).

const NOW = Date.parse('2026-10-26T13:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const user = (uid: string, o: Partial<UserDoc> = {}): UserDoc => ({
  uid, email: `${uid}@example.com`, emailVerified: true, displayName: null, provider: 'google.com',
  createdAt: '2026-10-01T00:00:00.000Z', lastSeenAt: at(60), prefs: { emailUpdates: true }, addresses: [], following: [], ...o,
});
const sub = (endpoint: string): PushSub => ({ endpoint: `https://push.example/${endpoint}`, p256dh: 'p', auth: 'a', ua: null, createdAt: at(1000) });

/** Six accounts with mixed prefs, subscriptions and follows (plus the malformed shapes a doc can carry). */
const USERS: UserDoc[] = [
  user('u1', { push: [sub('a'), sub('b')], prefs: { emailUpdates: true, streetWatch: true, watchGroups: ['streets', 'trash'] } }),
  user('u2', { push: [sub('c')], cityFollowing: ['g1', 'g2'], prefs: { emailUpdates: true, weekDigest: true } }),
  user('u3', { cityFollowing: ['g2', 'g3'], prefs: { emailUpdates: true, streetDigest: true, watchGroups: [] } }),
  user('u4', { push: [] }),
  // Malformed: push entries without keys, a string pref, unknown group names, a follow list of non-strings — none count.
  user('u5', { push: [{} as unknown as PushSub, 'x' as unknown as PushSub], cityFollowing: [42 as unknown as string, ''], prefs: { emailUpdates: true, streetDigest: 'yes' as unknown as boolean, watchGroups: ['bogus'] } }),
  user('u6', { prefs: { emailUpdates: false, streetDigest: true, weekDigest: true, streetWatch: true, watchGroups: ['other'] } }),
];

const E = (id: string, o: Partial<EmailRecord> = {}): EmailRecord => ({
  id, at: at(10), dir: 'out', kind: 'status', from: 'updates@fixmypvd.org', to: ['owner@example.com'], addrs: ['updates@fixmypvd.org', 'owner@example.com'],
  subject: 'The city assigned your request (PVD2026-1)', text: 'the body, never on the tab', status: 'sent', source: 'live', lastEvent: 'delivered', ...o,
});
const ev = (id: string, kind: string, minutesAgo: number, data: Record<string, unknown> | null = null) => ({ id, at: at(minutesAgo), level: 'info', kind, msg: `${kind} happened`, reportId: null, data });

const META: Record<string, unknown> = {
  weekDigest: { at: at(6 * 60), users: 5, mailed: 2, pushed: 1, total: 312, adminMailed: true },
  streetDigest: { at: at(6 * 60 + 5), users: 3, mailed: 1, pushed: 2 },
  watchOvernight: { items: [{ uid: 'u1', caseId: 'c1' }, { uid: 'u6', caseId: 'c1' }, { bad: true }], since: at(300), at: at(30) },
  vapid: { publicKey: 'BPUBLIC', privateJwk: { kty: 'EC', crv: 'P-256', d: 'SECRET_D', x: 'x', y: 'y' }, createdAt: '2026-10-26T01:02:03.000Z' },
};

function fakeStore(o: Partial<Record<keyof Store, unknown>> = {}): Store {
  return {
    listUsers: vi.fn(async () => USERS),
    countUsers: vi.fn(async () => 6),
    listStreetDigestUsers: vi.fn(async () => USERS.filter((u) => u.prefs.streetDigest === true)),
    listWeekDigestUsers: vi.fn(async () => USERS.filter((u) => u.prefs.weekDigest === true)),
    listStreetWatchUsers: vi.fn(async () => USERS.filter((u) => u.prefs.streetWatch === true)),
    getMeta: vi.fn(async (id: string) => META[id] ?? null),
    recentEvents: vi.fn(async () => [
      ev('e1', 'watch.pushed', 5, { cases: 3, users: 2, hits: 1, pushed: 2, skippedOwn: 0, held: 0, accounts: 1 }),
      ev('e2', 'tick.reaped', 6),
      ev('e3', 'push.sent', 7, { source: 'street_watch', users: 1, sent: 2 }),
      ev('e4', 'report.created', 8),
      ev('e5', 'week.digest', 6 * 60, { users: 5, mailed: 2, pushed: 1, total: 312, adminMailed: true }),
      ev('e6', 'street.digest', 6 * 60 + 5, { users: 3, mailed: 1, pushed: 2 }),
      ev('e7', 'watch.held', 10 * 60, { hits: 2, accounts: 2 }),
      ev('e8', 'watch.morning', 6 * 60 + 30, { pushed: 2, pushedTo: 2 }),
    ]),
    listEmails: vi.fn(async () => [
      E('m1', { kind: 'week_digest', subject: 'This week in Providence: 312 requests, 140 closed', at: at(6 * 60) }),
      E('m2', { kind: 'status' }),
      E('m3', { kind: 'admin_digest', to: ['rob@fixmypvd.org'], subject: '[FixMyPVD] Your r/providence post for this week', at: at(6 * 60 - 1) }),
      E('m4', { kind: 'street_digest', subject: 'Your street this week', at: at(6 * 60 + 5), status: 'failed', lastEvent: null, error: 'bounced' }),
      E('m5', { kind: 'city_follow', subject: 'The city closed a case you follow', at: at(2 * 24 * 60) }),
      E('m6', { kind: 'signin_link' }),
    ]),
    ...o,
  } as unknown as Store;
}

beforeEach(() => { resetEngagementCache(); vi.restoreAllMocks(); });

describe('countAccounts (pure, over the users scan)', () => {
  it('counts push, follows, the three opt-ins and narrowed selections from a mixed fixture; malformed shapes do not count', () => {
    const c = countAccounts(USERS, { total: 6 });
    expect(c).toEqual({
      total: 6, scanned: 6, truncated: false,
      withPush: 2, pushDevices: 3,
      follows: { accounts: 2, cases: 3 },          // u2 (g1, g2) + u3 (g2, g3) → three distinct cases
      streetDigest: 2, weekDigest: 2, streetWatch: 2,
      watchGroupsSet: 2,                            // u1 (two groups) + u6 (one); u3's [] and u5's ['bogus'] are "everything"
    });
  });
  it('scanned / truncated / total: truncated when the scan filled its window; total is countUsers but never below scanned', () => {
    expect(countAccounts(USERS, { total: 40, limit: 6 })).toMatchObject({ total: 40, scanned: 6, truncated: true });
    expect(countAccounts(USERS, { total: 40, limit: 7 })).toMatchObject({ total: 40, scanned: 6, truncated: false });
    expect(countAccounts(USERS, { total: 3 })).toMatchObject({ total: 6, scanned: 6 });        // a stale count reads as the scan
    expect(countAccounts(USERS, { total: null })).toMatchObject({ total: 6 });                 // the count failed
    expect(countAccounts(USERS, { total: Number.NaN })).toMatchObject({ total: 6 });
    expect(ENGAGEMENT_SCAN).toBe(500);
  });
  it('an empty scan is all zeros and not truncated', () => {
    expect(countAccounts([], { total: 0 })).toEqual({ total: 0, scanned: 0, truncated: false, withPush: 0, pushDevices: 0, follows: { accounts: 0, cases: 0 }, streetDigest: 0, weekDigest: 0, streetWatch: 0, watchGroupsSet: 0 });
  });
});

describe('the Monday cards and the recent lists (pure)', () => {
  it('weekDigestRun / streetDigestRun read the meta docs the jobs write and are null without a run', () => {
    expect(weekDigestRun(META.weekDigest)).toEqual({ at: at(6 * 60), users: 5, mailed: 2, pushed: 1, total: 312, adminMailed: true });
    expect(streetDigestRun(META.streetDigest)).toEqual({ at: at(6 * 60 + 5), users: 3, mailed: 1, pushed: 2 });
    expect(weekDigestRun(null)).toBeNull();
    expect(weekDigestRun({})).toBeNull();
    expect(streetDigestRun('x')).toBeNull();
    // Numbers are coerced defensively; adminMailed is strictly true.
    expect(weekDigestRun({ at: at(1), users: '5', adminMailed: 'yes' })).toEqual({ at: at(1), users: 0, mailed: 0, pushed: 0, total: 0, adminMailed: false });
  });
  it('pickEvents keeps only the six feature kinds, newest first, capped', () => {
    const many = Array.from({ length: 60 }, (_, i) => ev(`x${i}`, i % 2 ? 'push.sent' : 'tick.reaped', i));
    const picked = pickEvents([...many].reverse());
    expect(picked).toHaveLength(30);
    expect(picked.every((e) => e.kind === 'push.sent')).toBe(true);
    expect(picked[0].id).toBe('x1');
    expect(pickEvents(Array.from({ length: 100 }, (_, i) => ev(`y${i}`, 'watch.pushed', i)))).toHaveLength(RECENT_EVENTS);
    expect([...ENGAGEMENT_EVENT_KINDS]).toEqual(['week.digest', 'street.digest', 'watch.pushed', 'watch.held', 'watch.morning', 'push.sent']);
  });
  it('maskEmail keeps the first character and the domain', () => {
    expect(maskEmail('rob@fixmypvd.org')).toBe('r***@fixmypvd.org');
    expect(maskEmail('  Owner@Example.com ')).toBe('O***@Example.com');
    expect(maskEmail('a@b.c')).toBe('a***@b.c');
    expect(maskEmail('@weird')).toBe('***@weird');
    expect(maskEmail('noat')).toBe('n***');
    expect(maskEmail('')).toBe('***');
  });
  it('pickMails keeps the four digest kinds as table rows (no body, recipients masked), newest first, capped', () => {
    const rows = pickMails([E('a', { kind: 'week_digest', at: at(5) }), E('b', { kind: 'filed' }), E('c', { kind: 'city_follow', at: at(2), to: ['owner@example.com', 'second@example.org'] }), E('d', { kind: 'signin_link' })]);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a']);
    expect(rows[0]).toEqual({ id: 'c', at: at(2), kind: 'city_follow', to: 'o***@example.com, s***@example.org', subject: 'The city assigned your request (PVD2026-1)', status: 'sent' });
    expect(Object.keys(rows[1])).toEqual(['id', 'at', 'kind', 'to', 'subject', 'status']);
    const json = JSON.stringify(rows);
    expect(json).not.toContain('never on the tab');
    expect(json).not.toContain('owner@');
    expect(pickMails(Array.from({ length: 50 }, (_, i) => E(`m${i}`, { kind: 'street_digest', at: at(i) })))).toHaveLength(RECENT_MAILS);
    expect([...ENGAGEMENT_MAIL_KINDS]).toEqual(['week_digest', 'street_digest', 'city_follow', 'admin_digest']);
  });
});

describe('buildEngagement', () => {
  it('assembles the shape from one users scan, the three equality queries, four meta docs, the event stream and the email log', async () => {
    const store = fakeStore();
    const r = await buildEngagement(store, NOW);
    expect(r.at).toBe(new Date(NOW).toISOString());
    expect(r.accounts).toEqual({
      total: 6, scanned: 6, truncated: false, withPush: 2, pushDevices: 3, follows: { accounts: 2, cases: 3 },
      streetDigest: 2, weekDigest: 2, streetWatch: 2, watchGroupsSet: 2,
      queried: { streetDigest: 2, weekDigest: 2, streetWatch: 2 },
    });
    expect(r.overnightHeld).toBe(2);                                     // the malformed item is ignored
    expect(r.vapidSince).toBe('2026-10-26T01:02:03.000Z');
    expect(r.lastWeekDigest).toEqual({ at: at(6 * 60), users: 5, mailed: 2, pushed: 1, total: 312, adminMailed: true });
    expect(r.lastStreetDigest).toEqual({ at: at(6 * 60 + 5), users: 3, mailed: 1, pushed: 2 });
    expect(r.recent.events.map((e) => e.id)).toEqual(['e1', 'e3', 'e5', 'e6', 'e8', 'e7']);
    expect(r.recent.events[0]).toEqual({ id: 'e1', at: at(5), level: 'info', kind: 'watch.pushed', msg: 'watch.pushed happened', reportId: null, data: { cases: 3, users: 2, hits: 1, pushed: 2, skippedOwn: 0, held: 0, accounts: 1 } });
    expect(r.recent.mails.map((m) => m.id)).toEqual(['m3', 'm1', 'm4', 'm5']);
    expect(r.recent.mails[0]).toMatchObject({ kind: 'admin_digest', to: 'r***@fixmypvd.org', subject: '[FixMyPVD] Your r/providence post for this week' });
    expect(r.recent.mails[2]).toMatchObject({ kind: 'street_digest', status: 'failed', to: 'o***@example.com' });
    // One scan of the configured size, the cross-check queries capped the same way, the two windows as documented.
    expect(store.listUsers).toHaveBeenCalledTimes(1);
    expect(store.listUsers).toHaveBeenCalledWith({ limit: ENGAGEMENT_SCAN });
    expect(store.listStreetDigestUsers).toHaveBeenCalledWith(ENGAGEMENT_SCAN);
    expect(store.recentEvents).toHaveBeenCalledWith(EVENT_SCAN);
    expect(store.listEmails).toHaveBeenCalledWith({ limit: MAIL_SCAN });
  });
  it('the VAPID key pair never leaves — only its date', async () => {
    const body = JSON.stringify(await buildEngagement(fakeStore(), NOW));
    expect(body).not.toContain('SECRET_D');
    expect(body).not.toContain('privateJwk');
    expect(body).not.toContain('BPUBLIC');
  });
  it('truncated: a scan that fills its window says so; the cross-check counts stand on their own', async () => {
    const many = Array.from({ length: ENGAGEMENT_SCAN }, (_, i) => user(`u${i}`, { prefs: { emailUpdates: true, weekDigest: i < 10 } }));
    const store = fakeStore({ listUsers: vi.fn(async () => many), countUsers: vi.fn(async () => 1234), listWeekDigestUsers: vi.fn(async () => many.slice(0, 17)) });
    const r = await buildEngagement(store, NOW);
    expect(r.accounts).toMatchObject({ total: 1234, scanned: 500, truncated: true, weekDigest: 10, queried: { weekDigest: 17 } });
  });
  it('empty state: no accounts, no runs, nothing held, push never used, no events or mails', async () => {
    const store = fakeStore({
      listUsers: vi.fn(async () => []), countUsers: vi.fn(async () => 0), listStreetDigestUsers: vi.fn(async () => []), listWeekDigestUsers: vi.fn(async () => []), listStreetWatchUsers: vi.fn(async () => []),
      getMeta: vi.fn(async () => null), recentEvents: vi.fn(async () => []), listEmails: vi.fn(async () => []),
    });
    expect(await buildEngagement(store, NOW)).toEqual({
      at: new Date(NOW).toISOString(),
      accounts: { total: 0, scanned: 0, truncated: false, withPush: 0, pushDevices: 0, follows: { accounts: 0, cases: 0 }, streetDigest: 0, weekDigest: 0, streetWatch: 0, watchGroupsSet: 0, queried: { streetDigest: 0, weekDigest: 0, streetWatch: 0 } },
      overnightHeld: 0, vapidSince: null, lastWeekDigest: null, lastStreetDigest: null, recent: { events: [], mails: [] },
    });
  });
  it('fails soft: every read throwing still answers, with zeros, nulls and the cross-check marked unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = vi.fn(async () => { throw new Error('firestore 503'); });
    const store = fakeStore({ listUsers: boom, countUsers: boom, listStreetDigestUsers: boom, listWeekDigestUsers: boom, listStreetWatchUsers: boom, getMeta: boom, recentEvents: boom, listEmails: boom });
    const r = await buildEngagement(store, NOW);
    expect(r.accounts).toMatchObject({ total: 0, scanned: 0, truncated: false, queried: null });
    expect(r).toMatchObject({ overnightHeld: 0, vapidSince: null, lastWeekDigest: null, lastStreetDigest: null, recent: { events: [], mails: [] } });
    // One query down leaves the others' numbers in place but the cross-check block null (it is all-or-nothing).
    const one = await buildEngagement(fakeStore({ listWeekDigestUsers: boom }), NOW);
    expect(one.accounts).toMatchObject({ total: 6, weekDigest: 2, queried: null });
  });
});

describe('engagement cache (60 s per isolate)', () => {
  it('builds once within the TTL, shares one in-flight build, rebuilds after it', async () => {
    const store = fakeStore();
    const [a, b] = await Promise.all([engagement(store, NOW), engagement(store, NOW + 1)]);
    expect(a).toBe(b);
    expect(await engagement(store, NOW + ENGAGEMENT_TTL_MS - 1)).toBe(a);
    expect(store.listUsers).toHaveBeenCalledTimes(1);
    const c = await engagement(store, NOW + ENGAGEMENT_TTL_MS);
    expect(c).not.toBe(a);
    expect(c.at).toBe(new Date(NOW + ENGAGEMENT_TTL_MS).toISOString());
    expect(store.listUsers).toHaveBeenCalledTimes(2);
    resetEngagementCache();
    await engagement(store, NOW + ENGAGEMENT_TTL_MS + 1);
    expect(store.listUsers).toHaveBeenCalledTimes(3);
  });
  it('a soft-failed build is cached for its minute like any other (no retry storm); the scan runs again after the TTL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = fakeStore({ listUsers: vi.fn(async () => { throw new Error('down'); }) });
    const r1 = await engagement(store, NOW);
    expect(r1.accounts.scanned).toBe(0);
    // The soft failure IS the response for this minute — it is cached like any other build (no retry storm); after the TTL the scan runs again.
    await engagement(store, NOW + ENGAGEMENT_TTL_MS);
    expect(store.listUsers).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/admin/engagement', () => {
  const env = { ADMIN_EMAILS: 'rob@example.com', NOTIFY_EMAIL: 'rob@fixmypvd.org', APP_BASE_URL: 'https://fixmypvd.org' } as unknown as Env;
  const admin = { uid: 'u', email: 'rob@example.com', emailVerified: true, name: null, provider: 'google.com' };
  it('answers the admin with the assembled body, no-store', async () => {
    const req = new Request('https://api.test/api/admin/engagement');
    const resp = await handleAdmin(req, new URL(req.url), env, fakeStore(), admin);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('cache-control')).toBe('no-store');
    const body = (await resp.json()) as { at: string; accounts: { total: number; withPush: number; queried: unknown }; lastWeekDigest: { adminMailed: boolean }; recent: { events: unknown[]; mails: unknown[] } };
    expect(body.accounts).toMatchObject({ total: 6, withPush: 2, queried: { streetWatch: 2 } });
    expect(body.lastWeekDigest.adminMailed).toBe(true);
    expect(body.recent.events).toHaveLength(6);
    expect(body.recent.mails).toHaveLength(4);
  });
  it('admin only: a non-admin Google account is refused, an email-link account for the admin address too', async () => {
    const req = new Request('https://api.test/api/admin/engagement');
    expect((await handleAdmin(req, new URL(req.url), env, {} as Store, { ...admin, email: 'x@example.com' })).status).toBe(403);
    expect((await handleAdmin(req, new URL(req.url), env, {} as Store, { ...admin, provider: 'password' })).status).toBe(403);
    expect((await handleAdmin(req, new URL(req.url), env, {} as Store, null)).status).toBe(401);
  });
});
