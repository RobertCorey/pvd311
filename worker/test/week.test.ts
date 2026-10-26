import { describe, expect, it, vi, beforeEach } from 'vitest';
import { weekSummary, handleWeek, weekDigestEmail, runWeekDigest, resetWeekCache, deltaText, dayInNewYork, NOTABLE_RES_MAX, NOTABLE_N, WEEK_OUTCOMES, type WeekSummary } from '../src/week.js';
import { resetStreetCache } from '../src/street.js';
import { hoodOf, hoodSlug, NEIGHBORHOODS, NEIGHBORHOOD_NAMES } from '../../shared/neighborhoods.js';
import { inferKind } from '../src/emaillog.js';
import type { Env, Mailer, Store, UserDoc } from '../src/contracts.js';

// Sunday 2026-10-25 12:00 UTC (08:00 EDT): "this week" = Oct 18 12:00Z → now, "last week" = Oct 11 → Oct 18.
const NOW = Date.parse('2026-10-25T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// Real Providence points, verified against the rings: Brown's main green (College Hill), Providence College (Elmhurst).
const COLLEGE_HILL = { lat: 41.8262, lng: -71.4032 };
const ELMHURST = { lat: 41.8440, lng: -71.4380 };

const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status: 'Assigned',
  createdAt: daysAgo(3), firstSeenAt: daysAgo(3), ...COLLEGE_HILL, ...o,
});
const closedRow = (id: string, createdDaysAgo: number, closedDaysAgo: number, o: Record<string, unknown> = {}) =>
  row(id, { createdAt: daysAgo(createdDaysAgo), firstSeenAt: daysAgo(createdDaysAgo), status: 'Resolved', detail: { resolutionDate: daysAgo(closedDaysAgo), resolution: 'Filled.' }, ...o });

describe('shared/neighborhoods hoodOf', () => {
  it('names the hood for a point inside its ring and null for the bay or another city', () => {
    expect(hoodOf(41.8170, -71.3930)).toBe('Fox Point');     // India Point Park
    expect(hoodOf(COLLEGE_HILL.lat, COLLEGE_HILL.lng)).toBe('College Hill');
    expect(hoodOf(ELMHURST.lat, ELMHURST.lng)).toBe('Elmhurst');
    expect(hoodOf(41.8240, -71.4128)).toBe('Downtown');      // City Hall
    expect(hoodOf(41.79, -71.36)).toBeNull();                 // the bay, east of Washington Park
    expect(hoodOf(41.70, -71.40)).toBeNull();                 // Warwick
    expect(hoodOf(Number.NaN, -71.40)).toBeNull();
  });
  it('carries the app\'s 25 hoods verbatim and slugs the same way', () => {
    expect(NEIGHBORHOOD_NAMES).toHaveLength(25);
    expect(Object.keys(NEIGHBORHOODS)).toEqual(NEIGHBORHOOD_NAMES);
    expect(NEIGHBORHOOD_NAMES).toContain('Upper South Providence');
    expect(hoodSlug('Upper South Providence')).toBe('upper-south-providence');
    expect(hoodSlug(' Fox  Point ')).toBe('fox-point');
  });
});

describe('weekSummary', () => {
  it('counts this week and last week by latest activity: totals, open/closed, located, prev', () => {
    const rows = [
      row('open-1', { createdAt: daysAgo(1), firstSeenAt: daysAgo(1) }),
      row('open-2', { createdAt: daysAgo(2), firstSeenAt: daysAgo(2) }),
      row('open-3', { createdAt: daysAgo(6), firstSeenAt: daysAgo(6), lat: null, lng: null }),
      closedRow('closed-quick', 2, 1),
      closedRow('closed-old-case', 45, 2),                                   // created in August, closed this week → this week
      row('prev-open-1', { createdAt: daysAgo(9), firstSeenAt: daysAgo(9) }),
      row('prev-open-2', { createdAt: daysAgo(10), firstSeenAt: daysAgo(10) }),
      closedRow('prev-closed', 12, 9),
      row('older-open', { createdAt: daysAgo(20), firstSeenAt: daysAgo(20) }), // neither week
      row('draft', { status: 'Draft' }),
      row('DRAFT-caps', { status: 'DRAFT', createdAt: daysAgo(1) }),
    ];
    const s = weekSummary(rows, { now: NOW });
    expect(s).toMatchObject({ days: 7, since: daysAgo(7), until: new Date(NOW).toISOString(), at: new Date(NOW).toISOString(), total: 5, open: 3, closed: 2, located: 4, prev: { total: 3, closed: 1 } });
  });

  it('a case created 10 days ago and closed 2 days ago is in both weeks — a new request last week, a close this week (prev uses the same rule)', () => {
    const s = weekSummary([closedRow('spanning', 10, 2)], { now: NOW });
    expect(s).toMatchObject({ total: 1, open: 0, closed: 1, prev: { total: 1, closed: 0 } });
    expect(s.topTypes).toEqual([{ caseType: 'Pothole', category: 'pothole', n: 1, prevN: 1 }]);
    // Its creation day is outside the week, so it does not make a "busiest day" either.
    expect(s.busiestDay).toBeNull();
    // Last week's numbers are what the endpoint said a week ago: the case as it stood then (open, 3 days old), evaluated then.
    const then = weekSummary([row('spanning', { createdAt: daysAgo(10), firstSeenAt: daysAgo(10) })], { now: NOW - 7 * 86_400_000 });
    expect({ total: then.total, closed: then.closed }).toEqual(s.prev);
  });

  it('prev.closed: a close dated last week, or a closed case without a known close time created last week', () => {
    const rows = [
      closedRow('closed-then', 12, 9),
      row('closed-undated', { createdAt: daysAgo(9), firstSeenAt: daysAgo(9), status: 'Closed' }),
      closedRow('created-then-closed-now', 9, 1),
      row('open-then', { createdAt: daysAgo(8), firstSeenAt: daysAgo(8) }),
    ];
    const s = weekSummary(rows, { now: NOW });
    expect(s.prev).toEqual({ total: 4, closed: 2 });
    expect(s).toMatchObject({ total: 1, closed: 1 });
  });

  it('ranks the top 6 case types this week with last week\'s count beside each', () => {
    const rows: Record<string, unknown>[] = [];
    const types = ['Pothole', 'Street Light Out', 'Missed Trash', 'Graffiti', 'Sidewalk', 'Tree', 'Abandoned Vehicle', 'Noise'];
    types.forEach((caseType, i) => {
      for (let k = 0; k < types.length - i; k++) rows.push(row(`${caseType}-${k}`, { caseType, category: `cat${i}`, createdAt: daysAgo(1), firstSeenAt: daysAgo(1) }));
    });
    rows.push(row('prev-pothole', { createdAt: daysAgo(9), firstSeenAt: daysAgo(9) }));
    rows.push(row('prev-pothole-2', { createdAt: daysAgo(13), firstSeenAt: daysAgo(13) }));
    rows.push(row('prev-noise-ignored', { caseType: 'Noise', createdAt: daysAgo(9), firstSeenAt: daysAgo(9) }));
    const s = weekSummary(rows, { now: NOW });
    expect(s.topTypes).toHaveLength(6);
    expect(s.topTypes.map((t) => [t.caseType, t.n, t.prevN])).toEqual([
      ['Pothole', 8, 2], ['Street Light Out', 7, 0], ['Missed Trash', 6, 0], ['Graffiti', 5, 0], ['Sidewalk', 4, 0], ['Tree', 3, 0],
    ]);
    expect(s.topTypes[0].category).toBe('cat0');
    expect(s.prev.total).toBe(3);
  });

  it('groups located cases by neighborhood over the real rings, n desc; unlocated cases count but join no hood', () => {
    const rows = [
      row('ch-open'),
      closedRow('ch-closed', 3, 1),
      row('elm-open', { ...ELMHURST }),
      row('no-geo', { lat: null, lng: null }),
      row('bay', { lat: 41.79, lng: -71.36 }),
    ];
    const s = weekSummary(rows, { now: NOW });
    expect(s).toMatchObject({ total: 5, located: 4 });
    expect(s.neighborhoods).toEqual([
      { name: 'College Hill', slug: 'college-hill', n: 2, open: 1, closed: 1 },
      { name: 'Elmhurst', slug: 'elmhurst', n: 1, open: 1, closed: 0 },
    ]);
    expect(s.neighborhoods.map((h) => h.n).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('takes an injected hoodOf', () => {
    const s = weekSummary([row('a')], { now: NOW, hoodOf: () => 'Testville' });
    expect(s.neighborhoods).toEqual([{ name: 'Testville', slug: 'testville', n: 1, open: 1, closed: 0 }]);
  });

  it('classifies this week\'s closes by what closing meant', () => {
    const res = (id: string, resolution: string, o: Record<string, unknown> = {}) => closedRow(id, 5, 1, { detail: { resolutionDate: daysAgo(1), resolution }, ...o });
    const rows = [
      res('work', 'Pothole filled.'),
      res('work2', 'Bulb replaced'),
      res('enf', 'Citation issued to the owner.'),
      res('ref', 'Referred to RIDOT — state road.'),
      res('log', 'Logged into the system as CODE-26-1449.'),
      res('info', 'Information emailed to the resident.'),
      res('none', ''),
      res('nar', 'NAR'),
      res('cancel', 'Duplicate', { status: 'Cancelled' }),
      res('merged', 'Filled.', { status: 'Merged' }),
      row('open-not-counted'),
      res('prev-week', 'Filled.', { detail: { resolutionDate: daysAgo(9), resolution: 'Filled.' }, createdAt: daysAgo(12), firstSeenAt: daysAgo(12) }),
    ];
    const s = weekSummary(rows, { now: NOW });
    expect(s.outcomes).toEqual({ work_done: 2, enforcement: 1, referred: 1, logged_elsewhere: 1, info_only: 1, no_action: 2, cancelled: 2 });
    expect(Object.keys(s.outcomes)).toEqual([...WEEK_OUTCOMES]);
    expect(Object.values(s.outcomes).reduce((a, b) => a + b, 0)).toBe(s.closed);
  });

  it('medianCloseDays is the cityinsights-style median over closes with both times known', () => {
    const rows = [
      closedRow('d1', 2, 1),      // 1 day
      closedRow('d3', 4, 1),      // 3 days
      closedRow('d10', 11, 1),    // 10 days
      closedRow('no-created', 5, 1, { createdAt: null }),
      row('open'),
    ];
    expect(weekSummary(rows, { now: NOW }).medianCloseDays).toBe(3);
    expect(weekSummary([closedRow('a', 2, 1), closedRow('b', 3, 1)], { now: NOW }).medianCloseDays).toBe(1.5);
    expect(weekSummary([row('open')], { now: NOW }).medianCloseDays).toBeNull();
  });

  it('notable = this week\'s closes with a Resolution Message, newest close first, ≤ 12, the note cut to 240 chars', () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 14; i++) rows.push(closedRow(`c${i}`, 20, 0.5 + i * 0.4, { detail: { resolutionDate: daysAgo(0.5 + i * 0.4), resolution: `Done ${i}` } }));
    rows.push(closedRow('long', 3, 0.1, { street: ' 5 Elm St ', detail: { resolutionDate: daysAgo(0.1), resolution: 'x'.repeat(400) } }));
    rows.push(closedRow('blank', 3, 0.2, { detail: { resolutionDate: daysAgo(0.2), resolution: '   ' } }));
    rows.push(closedRow('none', 3, 0.3, { detail: { resolutionDate: daysAgo(0.3) } }));
    rows.push(closedRow('last-week', 12, 8, { detail: { resolutionDate: daysAgo(8), resolution: 'Old news' } }));
    rows.push(row('open', { detail: { resolution: 'Should not appear' } }));
    const s = weekSummary(rows, { now: NOW });
    expect(s.notable).toHaveLength(NOTABLE_N);
    expect(NOTABLE_N).toBe(12);
    expect(s.notable.map((n) => n.id)).toEqual(['long', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
    expect(s.notable[0]).toEqual({
      id: 'long', caseType: 'Pothole', category: 'pothole', street: ' 5 Elm St ', neighborhood: 'College Hill', status: 'Resolved',
      closedAt: daysAgo(0.1), resolution: 'x'.repeat(NOTABLE_RES_MAX), lat: COLLEGE_HILL.lat, lng: COLLEGE_HILL.lng,
    });
    expect(NOTABLE_RES_MAX).toBe(240);
    expect(s.notable.some((n) => n.id === 'blank' || n.id === 'none' || n.id === 'last-week' || n.id === 'open')).toBe(false);
  });

  it('notable carries null coordinates / neighborhood for an unlocated close and dates a watched close', () => {
    const rows = [row('w', { lat: null, lng: null, street: '', createdAt: daysAgo(10), firstSeenAt: daysAgo(10), status: 'Closed', statusSeen: { Assigned: daysAgo(10), Closed: daysAgo(2) }, detail: { resolution: 'Swept.' } })];
    const s = weekSummary(rows, { now: NOW });
    expect(s.notable).toEqual([{ id: 'w', caseType: 'Pothole', category: 'pothole', street: '', neighborhood: null, status: 'Closed', closedAt: daysAgo(2), resolution: 'Swept.', lat: null, lng: null }]);
    expect(s.located).toBe(0);
    expect(s.neighborhoods).toEqual([]);
  });

  it('busiestDay groups new cases by their New York calendar day, not UTC', () => {
    // 03:30Z on Oct 24 is still Oct 23 in Providence (EDT, UTC−4); 12:00Z is Oct 24.
    const rows = [
      row('a', { createdAt: '2026-10-24T03:30:00Z' }),
      row('b', { createdAt: '2026-10-24T03:45:00Z' }),
      row('c', { createdAt: '2026-10-24T12:00:00Z' }),
      closedRow('old-close', 45, 1),                       // created in August — a close this week is not a new case
    ];
    const s = weekSummary(rows, { now: NOW });
    expect(s.busiestDay).toEqual({ date: '2026-10-23', n: 2 });
    expect(dayInNewYork(Date.parse('2026-10-24T03:30:00Z'))).toBe('2026-10-23');
    expect(dayInNewYork(Date.parse('2026-01-15T04:30:00Z'))).toBe('2026-01-14'); // EST, UTC−5
    // Ties go to the more recent day.
    expect(weekSummary([row('x', { createdAt: '2026-10-22T15:00:00Z' }), row('y', { createdAt: '2026-10-24T15:00:00Z' })], { now: NOW }).busiestDay).toEqual({ date: '2026-10-24', n: 1 });
  });

  it('is empty but well-formed when nothing happened', () => {
    const s = weekSummary([row('old', { createdAt: daysAgo(40), firstSeenAt: daysAgo(40) }), row('draft', { status: 'Draft' })], { now: NOW });
    expect(s).toMatchObject({ total: 0, open: 0, closed: 0, located: 0, prev: { total: 0, closed: 0 }, topTypes: [], neighborhoods: [], medianCloseDays: null, notable: [], busiestDay: null });
    expect(s.outcomes).toEqual({ work_done: 0, enforcement: 0, referred: 0, logged_elsewhere: 0, info_only: 0, no_action: 0, cancelled: 0 });
  });
});

describe('GET /api/week', () => {
  beforeEach(() => { resetStreetCache(); resetWeekCache(); });
  const store = (rows: Record<string, unknown>[]) => ({ listCityCasesSince: vi.fn(async () => rows) } as unknown as Store);

  it('answers the contract shape with a 5-minute public cache header, from one Firestore read for two calls', async () => {
    const s = store([row('a'), closedRow('b', 10, 2), row('prev', { createdAt: daysAgo(9), firstSeenAt: daysAgo(9) })]);
    const url = new URL('https://api.test/api/week');
    const r = await handleWeek(url, s, NOW);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    const j = await r.json() as WeekSummary;
    expect(j).toMatchObject({ days: 7, total: 2, open: 1, closed: 1, located: 2, prev: { total: 2, closed: 0 }, since: daysAgo(7), until: new Date(NOW).toISOString(), at: new Date(NOW).toISOString() });
    expect(Object.keys(j).sort()).toEqual(['at', 'busiestDay', 'closed', 'days', 'located', 'medianCloseDays', 'neighborhoods', 'notable', 'open', 'outcomes', 'prev', 'since', 'topTypes', 'total', 'until'].sort());
    const r2 = await handleWeek(url, s, NOW + 60_000);
    expect(((await r2.json()) as WeekSummary).at).toBe(new Date(NOW).toISOString());   // served from the isolate cache
    expect((s.listCityCasesSince as any).mock.calls).toHaveLength(1);
    // The load reaches back 14 days + the 60-day close lookback (a case opened in August and closed this week still counts).
    const since = (s.listCityCasesSince as any).mock.calls[0][0] as string;
    expect(since).toBe(new Date(NOW - 74 * 86_400_000).toISOString().slice(0, 10));
  });

  it('rebuilds after five minutes', async () => {
    const s = store([row('a')]);
    await handleWeek(new URL('https://api.test/api/week'), s, NOW);
    resetStreetCache();
    const r = await handleWeek(new URL('https://api.test/api/week'), s, NOW + 5 * 60_000);
    expect(((await r.json()) as WeekSummary).at).toBe(new Date(NOW + 5 * 60_000).toISOString());
    expect((s.listCityCasesSince as any).mock.calls).toHaveLength(2);
  });
});

describe('the Monday mail', () => {
  const summary = (): WeekSummary => weekSummary([
    row('p1', { createdAt: daysAgo(1), firstSeenAt: daysAgo(1) }),
    row('p2', { createdAt: daysAgo(2), firstSeenAt: daysAgo(2) }),
    row('sl', { caseType: 'Street Light Out', category: 'street_light', ...ELMHURST }),
    closedRow('fixed', 5, 1, { street: '12 Angell St', detail: { resolutionDate: daysAgo(1), resolution: 'Filled & compacted.' } }),
    closedRow('bulb', 6, 2, { caseType: 'Street Light Out', category: 'street_light', street: '1 Eaton St', ...ELMHURST, detail: { resolutionDate: daysAgo(2), resolution: 'Bulb replaced' } }),
    row('prev-1', { createdAt: daysAgo(9), firstSeenAt: daysAgo(9) }),
    closedRow('prev-closed', 12, 9),
    closedRow('prev-closed-2', 12, 10),
    closedRow('prev-closed-3', 12, 11),
  ], { now: NOW });

  it('deltaText words the week-over-week change', () => {
    expect(deltaText(12, 10)).toBe('+2 vs last week');
    expect(deltaText(7, 10)).toBe('-3 vs last week');
    expect(deltaText(5, 5)).toBe('same as last week');
  });

  it('subject + body: headline numbers with deltas, top 3 types, 3 busiest hoods, 3 notable closes, the links, the opt-out line', () => {
    const s = summary();
    expect(s).toMatchObject({ total: 5, closed: 2, prev: { total: 4, closed: 3 } });
    const m = weekDigestEmail(s, { base: 'https://fixmypvd.org/' });
    expect(m.subject).toBe('This week in Providence: 5 requests, 2 closed');
    expect(m.html).toContain('<b>5</b> requests (+1 vs last week)');
    expect(m.html).toContain('<b>2</b> closed (-1 vs last week)');
    expect(m.html).toContain('Oct 18 – Oct 25');
    expect(m.html).toContain('<b>Pothole</b> · 3 (last week 4)');
    expect(m.html).toContain('<b>Street Light Out</b> · 2 (last week 0)');
    expect(m.html).toContain('<b>College Hill</b> · 3 requests, 1 closed');
    expect(m.html).toContain('<b>Elmhurst</b> · 2 requests, 1 closed');
    expect(m.html).toContain('<b>Pothole</b> · 12 Angell St, College Hill · Resolved (closed');
    expect(m.html).toContain('Filled &amp; compacted.');
    expect(m.html).toContain('Bulb replaced');
    expect(m.html).toContain('<a href="https://fixmypvd.org/week">See the whole week</a>');
    expect(m.html).toContain('You asked for this every Monday on FixMyPVD — turn it off on <a href="https://fixmypvd.org/week">the week page</a> or under <a href="https://fixmypvd.org/account">Account</a>.');
    expect(m.html).toContain('not affiliated with the City of Providence');
    expect(m.html).not.toContain('https://fixmypvd.org//');
    expect(inferKind(m.subject, ['r@example.com'], { NOTIFY_EMAIL: 'rob@fixmypvd.org' })).toBe('week_digest');
    expect(inferKind('This week near Home: 2 new, 1 closed', ['r@example.com'], { NOTIFY_EMAIL: 'rob@fixmypvd.org' })).toBe('street_digest');
  });

  it('leaves out sections the week has nothing for', () => {
    const m = weekDigestEmail(weekSummary([row('only', { lat: null, lng: null })], { now: NOW }), { base: 'https://fixmypvd.org' });
    expect(m.subject).toBe('This week in Providence: 1 request, 0 closed');
    expect(m.html).toContain('<b>1</b> request (+1 vs last week)');
    expect(m.html).toContain('Most reported');
    expect(m.html).not.toContain('Busiest neighborhoods');
    expect(m.html).not.toContain("in the city's words");
  });
});

describe('runWeekDigest', () => {
  const env = { APP_BASE_URL: 'https://fixmypvd.org' } as Env;
  const user = (o: Partial<UserDoc> = {}): UserDoc => ({
    uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', createdAt: daysAgo(30), lastSeenAt: daysAgo(1),
    prefs: { emailUpdates: true, weekDigest: true }, addresses: [], following: [], ...o,
  });
  function deps(users: UserDoc[], rows: Record<string, unknown>[]) {
    const sent: { to: string; subject: string; html: string; kind?: string }[] = [];
    const store = {
      listWeekDigestUsers: vi.fn(async () => users),
      listCityCasesSince: vi.fn(async () => rows),
      setMeta: vi.fn(async () => {}), addEvent: vi.fn(async () => {}),
    } as unknown as Store;
    const mailer = { sendTo: vi.fn(async (to: string, subject: string, html: string, o?: { kind?: string }) => { sent.push({ to, subject, html, kind: o?.kind }); }) } as unknown as Mailer;
    return { store, mailer, sent };
  }
  beforeEach(() => { resetStreetCache(); resetWeekCache(); });

  it('mails each verified opted-in account once, kind week_digest, and skips the unverified or address-less', async () => {
    const users = [
      user(),
      user({ uid: 'u2', email: 'two@example.com' }),
      user({ uid: 'u3', email: 'x@example.com', emailVerified: false }),
      user({ uid: 'u4', email: null }),
      user({ uid: 'u5', email: 'off@example.com', prefs: { emailUpdates: true, weekDigest: false } }), // a stale query hit
    ];
    const d = deps(users, [row('a'), closedRow('b', 4, 1)]);
    expect(await runWeekDigest(env, d.store, d.mailer, { now: NOW })).toEqual({ users: 5, mailed: 2 });
    expect(d.sent.map((m) => m.to)).toEqual(['me@example.com', 'two@example.com']);
    expect(d.sent[0]).toMatchObject({ subject: 'This week in Providence: 2 requests, 1 closed', kind: 'week_digest' });
    expect(d.sent[0].html).toContain('https://fixmypvd.org/week');
    expect((d.store.listCityCasesSince as any).mock.calls).toHaveLength(1);
    expect((d.store.setMeta as any).mock.calls[0]).toEqual(['weekDigest', { at: new Date(NOW).toISOString(), users: 5, mailed: 2, total: 2 }]);
  });

  it('sends nothing when the week had no cases, and reads nothing when nobody opted in', async () => {
    const quiet = deps([user()], [row('old', { createdAt: daysAgo(40), firstSeenAt: daysAgo(40) })]);
    expect(await runWeekDigest(env, quiet.store, quiet.mailer, { now: NOW })).toEqual({ users: 1, mailed: 0 });
    expect(quiet.sent).toHaveLength(0);
    expect((quiet.store.addEvent as any).mock.calls[0][0].msg).toContain('no cases');
    const nobody = deps([], [row('a')]);
    expect(await runWeekDigest(env, nobody.store, nobody.mailer, { now: NOW })).toEqual({ users: 0, mailed: 0 });
    expect((nobody.store.listCityCasesSince as any).mock.calls).toHaveLength(0);
  });
});
