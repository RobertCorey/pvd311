import { describe, expect, it, vi, beforeEach } from 'vitest';
import { weekSummary, medianDays, handleWeek, weekDigestEmail, weekDigestPush, weekPostAdminEmail, runWeekDigest, resetWeekCache, resolveWindow, readerHoods, addDays, daysBetween, isYmd, deltaText, dayInNewYork, ARCHIVE_DAYS, ARCHIVE_LOAD_LIMIT, MAX_LOAD_DAYS, NOTABLE_RES_MAX, NOTABLE_N, PLACES_MAX, WEEK_OUTCOMES, YOUR_HOODS_N, type WeekSummary, type WeekWindow } from '../src/week.js';
import { resetStreetCache, LOAD_LIMIT } from '../src/street.js';
import { hoodOf, hoodSlug, NEIGHBORHOODS, NEIGHBORHOOD_NAMES } from '../../shared/neighborhoods.js';
import { weekPostMarkdown, OUTCOME_LABELS_EN, GROUP_LABELS_EN } from '../../shared/weekPost.js';
import en from '../../app/src/i18n/strings.en.json';
import { inferKind, toText } from '../src/emaillog.js';
import { MAX_PLAINTEXT } from '../src/push.js';
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
    // The current week also says which dated link it is, and that it ends now.
    expect(s).toMatchObject({ untilDate: '2026-10-25', prevUntil: '2026-10-18', nextUntil: null, current: true });
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
      { name: 'College Hill', slug: 'college-hill', n: 2, open: 1, closed: 1, medianCloseDays: 2 },
      { name: 'Elmhurst', slug: 'elmhurst', n: 1, open: 1, closed: 0, medianCloseDays: null },
    ]);
    expect(s.neighborhoods.map((h) => h.n).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('takes an injected hoodOf', () => {
    const s = weekSummary([row('a')], { now: NOW, hoodOf: () => 'Testville' });
    expect(s.neighborhoods).toEqual([{ name: 'Testville', slug: 'testville', n: 1, open: 1, closed: 0, medianCloseDays: null }]);
  });

  it("each neighborhood's medianCloseDays is the median over ITS closes this week with both times known, rounded like the city's; null without one", () => {
    const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
    const rows = [
      closedRow('ch-1d', 2, 1),                                                    // College Hill: 1 day
      closedRow('ch-3d', 4, 1),                                                    // 3 days
      row('ch-40h', { createdAt: hoursAgo(80), firstSeenAt: hoursAgo(80), status: 'Resolved', detail: { resolutionDate: hoursAgo(40), resolution: 'Done.' } }), // 1.667 days
      row('ch-open'),
      row('elm-open', { ...ELMHURST }),
      closedRow('elm-undated', 5, 1, { ...ELMHURST, createdAt: null }),           // a close with no created time: no duration
      closedRow('elm-old', 12, 9, { ...ELMHURST }),                                // closed last week: not one of this week's closes
    ];
    const s = weekSummary(rows, { now: NOW });
    expect(s.neighborhoods).toEqual([
      { name: 'College Hill', slug: 'college-hill', n: 4, open: 1, closed: 3, medianCloseDays: 1.7 },
      { name: 'Elmhurst', slug: 'elmhurst', n: 2, open: 1, closed: 1, medianCloseDays: null },
    ]);
    // Every dated close is College Hill's, so the city median is the same number by the same rounding.
    expect(s.medianCloseDays).toBe(1.7);
    // Two hoods, two medians, neither the city's: College Hill [1, 2] → 1.5, Elmhurst [4] → 4, the city [1, 2, 4] → 2.
    const split = weekSummary([closedRow('a', 2, 1), closedRow('b', 3, 1), closedRow('c', 5, 1, { ...ELMHURST })], { now: NOW });
    expect(split.neighborhoods.map((h) => [h.name, h.medianCloseDays])).toEqual([['College Hill', 1.5], ['Elmhurst', 4]]);
    expect(split.medianCloseDays).toBe(2);
    // An unlocated close counts for the city's median and joins no hood.
    const loose = weekSummary([closedRow('a', 2, 1), closedRow('far', 11, 1, { lat: null, lng: null })], { now: NOW });
    expect(loose.neighborhoods).toEqual([{ name: 'College Hill', slug: 'college-hill', n: 1, open: 0, closed: 1, medianCloseDays: 1 }]);
    expect(loose.medianCloseDays).toBe(5.5);
  });

  it('medianDays: the shared 1-dp rounding (half up), null for none', () => {
    expect(medianDays([])).toBeNull();
    expect(medianDays([2])).toBe(2);
    expect(medianDays([1, 2.25])).toBe(1.6);           // 1.625
    expect(medianDays([1, 1.5, 40 / 24])).toBe(1.5);
    expect(medianDays([10, 1, 3])).toBe(3);           // unsorted input
    expect(medianDays([0.04, 0.06])).toBe(0.1);       // 0.05
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
    expect(j).toMatchObject({ days: 7, total: 2, open: 1, closed: 1, located: 2, prev: { total: 2, closed: 0 }, since: daysAgo(7), until: new Date(NOW).toISOString(), at: new Date(NOW).toISOString(), untilDate: '2026-10-25', prevUntil: '2026-10-18', nextUntil: null, current: true });
    expect(Object.keys(j).sort()).toEqual(['at', 'busiestDay', 'closed', 'current', 'days', 'located', 'medianCloseDays', 'neighborhoods', 'nextUntil', 'notable', 'open', 'outcomes', 'prev', 'prevUntil', 'since', 'topTypes', 'total', 'until', 'untilDate'].sort());
    const r2 = await handleWeek(url, s, NOW + 60_000);
    expect(((await r2.json()) as WeekSummary).at).toBe(new Date(NOW).toISOString());   // served from the isolate cache
    expect((s.listCityCasesSince as any).mock.calls).toHaveLength(1);
    // The load reaches back 14 days + the 60-day close lookback (a case opened in August and closed this week still counts).
    const since = (s.listCityCasesSince as any).mock.calls[0][0] as string;
    expect(since).toBe(new Date(NOW - 74 * 86_400_000).toISOString().slice(0, 10));
    expect((s.listCityCasesSince as any).mock.calls[0][1]).toBe(LOAD_LIMIT);
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

describe('dated weeks — ?until=YYYY-MM-DD (New York calendar days)', () => {
  const iso = (s: string) => new Date(Date.parse(s)).toISOString();

  it('calendar helpers: addDays / daysBetween / isYmd', () => {
    expect(addDays('2026-10-25', -7)).toBe('2026-10-18');
    expect(addDays('2026-10-25', -56)).toBe('2026-08-30');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04');
    expect(daysBetween('2026-10-25', '2026-08-30')).toBe(56);
    expect(daysBetween('2026-10-25', '2026-10-25')).toBe(0);
    expect(isYmd('2026-10-18')).toBe(true);
    for (const bad of ['2026-02-30', '2026-10-1', '20261018', 'garbage', '2026-13-01', '', '2026-10-18T00:00:00Z']) expect(isYmd(bad), bad).toBe(false);
  });

  it('resolveWindow: omitted, empty or today → the current week ending now, with the dated form beside it', () => {
    for (const until of [null, undefined, '', '2026-10-25']) {
      const w = resolveWindow(until, NOW) as WeekWindow;
      expect(w).toMatchObject({ untilDate: '2026-10-25', current: true, prevUntil: '2026-10-18', nextUntil: null, daysBack: 0, since: NOW - 7 * 86_400_000, until: NOW, untilX: Number.POSITIVE_INFINITY, prevSince: NOW - 14 * 86_400_000 });
    }
  });

  it('resolveWindow: a past date is 00:00 of untilDate − 6 → 23:59:59.999 of untilDate, New York; prev/next step by 7 days', () => {
    const w = resolveWindow('2026-10-18', NOW) as WeekWindow;
    expect(w).toMatchObject({ untilDate: '2026-10-18', current: false, prevUntil: '2026-10-11', nextUntil: '2026-10-25', daysBack: 7 });
    expect(new Date(w.since).toISOString()).toBe('2026-10-12T04:00:00.000Z');       // Mon Oct 12 00:00 EDT
    expect(new Date(w.untilX).toISOString()).toBe('2026-10-19T04:00:00.000Z');      // Mon Oct 19 00:00 EDT (exclusive)
    expect(new Date(w.until).toISOString()).toBe('2026-10-19T03:59:59.999Z');       // Sun Oct 18 23:59:59.999 EDT
    expect(new Date(w.prevSince).toISOString()).toBe('2026-10-05T04:00:00.000Z');
    expect(w.untilX - w.since).toBe(7 * 86_400_000);
  });

  it('resolveWindow across DST: the week that falls back is 169 h, the one that springs forward 167 h — still 7 calendar days', () => {
    // DST ends Sun Nov 1 2026 02:00 → the week Nov 1–7 starts in EDT and ends in EST.
    const fall = resolveWindow('2026-11-07', Date.parse('2026-11-10T12:00:00Z')) as WeekWindow;
    expect(new Date(fall.since).toISOString()).toBe('2026-11-01T04:00:00.000Z');    // 00:00 EDT
    expect(new Date(fall.until).toISOString()).toBe('2026-11-08T04:59:59.999Z');    // 23:59:59.999 EST
    expect(fall.untilX - fall.since).toBe(169 * 3_600_000);
    expect(dayInNewYork(fall.since)).toBe('2026-11-01'); expect(dayInNewYork(fall.until)).toBe('2026-11-07');
    // DST starts Sun Mar 8 2026 02:00 → the week Mar 8–14 is an hour short.
    const spring = resolveWindow('2026-03-14', Date.parse('2026-03-20T12:00:00Z')) as WeekWindow;
    expect(new Date(spring.since).toISOString()).toBe('2026-03-08T05:00:00.000Z');  // 00:00 EST
    expect(new Date(spring.until).toISOString()).toBe('2026-03-15T03:59:59.999Z');  // 23:59:59.999 EDT
    expect(spring.untilX - spring.since).toBe(167 * 3_600_000);
    expect(dayInNewYork(spring.since)).toBe('2026-03-08'); expect(dayInNewYork(spring.until)).toBe('2026-03-14');
  });

  it('resolveWindow: the archive floor is 56 days back from today (NY); prevUntil is null there; older → too_old', () => {
    expect(ARCHIVE_DAYS).toBe(56);
    const floor = resolveWindow('2026-08-30', NOW) as WeekWindow;
    expect(floor).toMatchObject({ untilDate: '2026-08-30', current: false, prevUntil: null, nextUntil: '2026-09-06', daysBack: 56 });
    expect(resolveWindow('2026-08-29', NOW)).toBe('too_old');
    expect(resolveWindow('2025-10-25', NOW)).toBe('too_old');
    // One step above the floor still has a previous week.
    expect((resolveWindow('2026-09-06', NOW) as WeekWindow).prevUntil).toBe('2026-08-30');
  });

  it('resolveWindow: a malformed or future date is invalid_until — "today" is New York\'s, not UTC\'s', () => {
    for (const bad of ['2026-10-26', '2027-01-01', 'garbage', '2026-02-30', '2026-10-1', '20261018', 'null']) expect(resolveWindow(bad, NOW), bad).toBe('invalid_until');
    // 02:00Z on Oct 26 is still Sunday Oct 25 22:00 in Providence: Oct 26 is a future date, Oct 25 the current week.
    const late = Date.parse('2026-10-26T02:00:00Z');
    expect(resolveWindow('2026-10-26', late)).toBe('invalid_until');
    expect(resolveWindow('2026-10-25', late)).toMatchObject({ untilDate: '2026-10-25', current: true });
    expect(resolveWindow(null, late)).toMatchObject({ untilDate: '2026-10-25', current: true, prevUntil: '2026-10-18' });
    expect(resolveWindow('2026-10-24', late)).toMatchObject({ untilDate: '2026-10-24', current: false, nextUntil: null }); // Oct 31 would be after today
  });

  it('weekSummary(until): membership ends at the NY day end; a case created in the week and closed after it was open then; prev by the same calendar rule', () => {
    const rows = [
      row('early', { createdAt: '2026-10-12T04:00:00Z' }),                       // Mon Oct 12 00:00 EDT — first instant in
      row('before', { createdAt: '2026-10-12T03:59:59Z' }),                      // Sun Oct 11 23:59:59 EDT — last week
      row('late', { createdAt: '2026-10-19T03:30:00Z' }),                        // Sun Oct 18 23:30 EDT — in
      row('after', { createdAt: '2026-10-19T04:00:00Z' }),                       // Mon Oct 19 00:00 EDT — the next week
      row('closed-in', { createdAt: '2026-10-01T12:00:00Z', status: 'Resolved', detail: { resolutionDate: '2026-10-15T15:00:00Z', resolution: 'Filled.' } }),
      row('closed-after', { createdAt: '2026-10-14T15:00:00Z', status: 'Resolved', detail: { resolutionDate: '2026-10-20T15:00:00Z', resolution: 'Later.' } }),
      row('prev-closed', { createdAt: '2026-10-06T12:00:00Z', status: 'Closed', detail: { resolutionDate: '2026-10-09T12:00:00Z', resolution: 'Done.' } }),
    ];
    const s = weekSummary(rows, { now: NOW, until: '2026-10-18' });
    expect(s).toMatchObject({
      days: 7, since: '2026-10-12T04:00:00.000Z', until: '2026-10-19T03:59:59.999Z', at: new Date(NOW).toISOString(),
      untilDate: '2026-10-18', prevUntil: '2026-10-11', nextUntil: '2026-10-25', current: false,
      total: 4, open: 3, closed: 1, located: 4, prev: { total: 2, closed: 1 },
    });
    expect(s.notable.map((n) => n.id)).toEqual(['closed-in']);
    // Neighborhood rows split by the same window rule: 'closed-after' (status Resolved today) was open that week.
    expect(s.neighborhoods).toEqual([{ name: 'College Hill', slug: 'college-hill', n: 4, open: 3, closed: 1, medianCloseDays: 14.1 }]);
    expect(s.notable[0].closedAt).toBe(iso('2026-10-15T15:00:00Z'));
    expect(Object.values(s.outcomes).reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.medianCloseDays).toBe(14.1);
    expect(s.topTypes).toEqual([{ caseType: 'Pothole', category: 'pothole', n: 4, prevN: 2 }]);
    // busiestDay only counts creations inside the window; a three-way tie goes to the latest NY day.
    expect(s.busiestDay).toEqual({ date: '2026-10-18', n: 1 });
    // The same rows seen from the current week (Oct 18 12:00Z → now): 'late', 'after' and the Oct 20 close are this
    // week's and closed-after is closed now; last week by the 168-h rule holds early, before, closed-in, closed-after.
    const cur = weekSummary(rows, { now: NOW });
    expect(cur).toMatchObject({ total: 3, open: 2, closed: 1, prev: { total: 4, closed: 1 } });
    expect(cur.notable.map((n) => n.id)).toEqual(['closed-after']);
  });

  it('weekSummary(until) with today\'s date is the current week; an invalid date throws its code', () => {
    const a = weekSummary([row('a')], { now: NOW, until: '2026-10-25' });
    const b = weekSummary([row('a')], { now: NOW });
    expect(a).toEqual(b);
    expect(a.current).toBe(true);
    expect(() => weekSummary([], { now: NOW, until: 'nope' })).toThrow('invalid_until');
    expect(() => weekSummary([], { now: NOW, until: '2026-01-01' })).toThrow('too_old');
  });

  describe('GET /api/week?until=', () => {
    beforeEach(() => { resetStreetCache(); resetWeekCache(); });
    const store = (rows: Record<string, unknown>[]) => ({ listCityCasesSince: vi.fn(async () => rows) } as unknown as Store);
    const get = (s: Store, q: string, now = NOW) => handleWeek(new URL(`https://api.test/api/week${q}`), s, now);
    const sinceArg = (s: Store, i: number) => (s.listCityCasesSince as any).mock.calls[i][0] as string;
    const sinceDays = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

    it('a dated week: 200 with the dated fields, loaded over the whole 70-day archive window with the archive row limit', async () => {
      const s = store([row('a', { createdAt: '2026-10-15T12:00:00Z' }), row('b')]);
      const r = await get(s, '?until=2026-10-18');
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('public, max-age=300');
      const j = await r.json() as WeekSummary;
      expect(j).toMatchObject({ untilDate: '2026-10-18', prevUntil: '2026-10-11', nextUntil: '2026-10-25', current: false, total: 1, since: '2026-10-12T04:00:00.000Z', until: '2026-10-19T03:59:59.999Z' });
      expect(sinceArg(s, 0)).toBe(sinceDays(MAX_LOAD_DAYS + 60));
      expect((s.listCityCasesSince as any).mock.calls[0][1]).toBe(ARCHIVE_LOAD_LIMIT);
      expect(ARCHIVE_LOAD_LIMIT).toBe(2 * LOAD_LIMIT);
    });

    it('caches per untilDate: bare and ?until=<today> share the "now" entry; every past week shares ONE archive read, each summary reused within 5 minutes', async () => {
      const s = store([row('a')]);
      await get(s, '');
      await get(s, '?until=2026-10-25');
      expect((s.listCityCasesSince as any).mock.calls).toHaveLength(1);
      expect(((await (await get(s, '?until=2026-10-25')).json()) as WeekSummary).current).toBe(true);
      await get(s, '?until=2026-10-18');
      expect((s.listCityCasesSince as any).mock.calls).toHaveLength(2);
      const again = await get(s, '?until=2026-10-18', NOW + 60_000);
      expect(((await again.json()) as WeekSummary).at).toBe(new Date(NOW).toISOString());
      expect((s.listCityCasesSince as any).mock.calls).toHaveLength(2);
      // Browsing back through the whole archive: the other seven weeks are served from the same loadCases entry.
      for (const d of ['2026-10-11', '2026-10-04', '2026-09-27', '2026-09-20', '2026-09-13', '2026-09-06', '2026-08-30']) {
        expect((await get(s, `?until=${d}`)).status, d).toBe(200);
      }
      expect((s.listCityCasesSince as any).mock.calls).toHaveLength(2);
      expect((s.listCityCasesSince as any).mock.calls[1]).toEqual([sinceDays(MAX_LOAD_DAYS + 60), ARCHIVE_LOAD_LIMIT]);
      // After the TTL a dated week rebuilds like the current one.
      resetStreetCache();
      const fresh = await get(s, '?until=2026-10-18', NOW + 5 * 60_000);
      expect(((await fresh.json()) as WeekSummary).at).toBe(new Date(NOW + 5 * 60_000).toISOString());
      expect((s.listCityCasesSince as any).mock.calls).toHaveLength(3);
    });

    it('the current entry turns over at New York midnight: a minute into Monday it is Monday\'s week, not a cached Sunday marked current', async () => {
      const s = store([row('a')]);
      const lateSunday = Date.parse('2026-10-26T03:59:00Z');   // Sun Oct 25 23:59 EDT
      const earlyMonday = Date.parse('2026-10-26T04:01:00Z');  // Mon Oct 26 00:01 EDT, inside the 5-minute TTL
      expect(((await (await get(s, '', lateSunday)).json()) as WeekSummary)).toMatchObject({ untilDate: '2026-10-25', current: true, nextUntil: null });
      expect(((await (await get(s, '', earlyMonday)).json()) as WeekSummary)).toMatchObject({ untilDate: '2026-10-26', prevUntil: '2026-10-19', current: true, nextUntil: null });
      // And Sunday's dated link now resolves as a past, full-day week (its own entry).
      expect(((await (await get(s, '?until=2026-10-25', earlyMonday)).json()) as WeekSummary)).toMatchObject({ untilDate: '2026-10-25', current: false, nextUntil: null, until: '2026-10-26T03:59:59.999Z' });  // Nov 1 is still ahead
    });

    it('the floor week loads 70 days (+60 lookback); beyond it 400 too_old; a malformed or future date 400 invalid_until', async () => {
      const s = store([row('a')]);
      const r = await get(s, '?until=2026-08-30');
      expect(r.status).toBe(200);
      expect(((await r.json()) as WeekSummary)).toMatchObject({ untilDate: '2026-08-30', prevUntil: null, nextUntil: '2026-09-06', current: false });
      expect(MAX_LOAD_DAYS).toBe(70);
      expect(sinceArg(s, 0)).toBe(sinceDays(70 + 60));
      for (const [q, error] of [['?until=2026-08-29', 'too_old'], ['?until=2026-10-26', 'invalid_until'], ['?until=nope', 'invalid_until'], ['?until=2026-02-30', 'invalid_until']] as const) {
        const bad = await get(s, q);
        expect(bad.status, q).toBe(400);
        expect(bad.headers.get('content-type')).toBe('application/json');
        expect(await bad.json()).toEqual({ error });
      }
      expect((s.listCityCasesSince as any).mock.calls).toHaveLength(1);  // errors never read
    });
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
    // "See the whole week" is the dated link (stable next month); the opt-out line points at Account → Updates.
    expect(m.html).toContain('<a href="https://fixmypvd.org/week?until=2026-10-25">See the whole week</a>');
    expect(m.html).toContain('You asked for this every Monday on FixMyPVD. Change or stop these emails under <a href="https://fixmypvd.org/account/updates">Account → Updates</a>.');
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

  it("Rob's post mail: the lead, the exact shared Markdown in a pre-wrap <pre>, the dated 'Copy it from the week page' link, the footer; kind admin_digest", () => {
    const s = summary();
    const md = weekPostMarkdown(s, { base: 'https://fixmypvd.org' });
    expect(md.split('\n\n').slice(0, 2)).toEqual(['**This week in Providence (Oct 18 – Oct 25)**', '5 requests to 311 (+1 vs last week), 2 closed, median 4 days to close.']);
    expect(md).toContain('- Pothole, 12 Angell St (College Hill): "Filled & compacted."');
    const m = weekPostAdminEmail(s, { base: 'https://fixmypvd.org/' });
    expect(m.subject).toBe('Your r/providence post for this week');
    expect(m.html).toContain('<p style="margin:0 0 1em">Last week in Providence (Oct 18 – Oct 25) — 5 requests, 2 closed — as a ready post for r/providence; paste it as is or trim.</p>');
    // The Markdown is HTML-escaped inside the <pre> (so "&" survives the mail client) and comes back verbatim as the
    // plain-text part / email-log text — the bytes /week's "Copy as post" copies.
    expect(m.html).toContain('<pre style="white-space:pre-wrap;');
    expect(m.html).toContain('Filled &amp; compacted.');
    expect(toText(m.html)).toContain(md);
    expect(m.html).toContain('<a href="https://fixmypvd.org/week?until=2026-10-25">Copy it from the week page</a>');
    expect(m.html).toContain('not affiliated with the City of Providence');
    expect(m.html).not.toContain('https://fixmypvd.org//');
    // mailer.alert prefixes the subject; the email log files it with the daily digest, not as an alert.
    expect(inferKind(`[FixMyPVD] ${m.subject}`, ['rob@fixmypvd.org'], { NOTIFY_EMAIL: 'rob@fixmypvd.org' })).toBe('admin_digest');
    expect(inferKind('[FixMyPVD] Circuit breaker tripped', ['rob@fixmypvd.org'], { NOTIFY_EMAIL: 'rob@fixmypvd.org' })).toBe('admin_alert');
  });

  it("the post's inlined English labels are the app dictionary's (the mail and the button must say the same thing)", () => {
    const dict = en as Record<string, string>;
    for (const [k, v] of Object.entries(OUTCOME_LABELS_EN)) expect(v, `week.outcome.${k}`).toBe(dict[`week.outcome.${k}`]);
    for (const [k, v] of Object.entries(GROUP_LABELS_EN)) expect(v, `street.g.${k}`).toBe(dict[`street.g.${k}`]);
    expect(Object.keys(OUTCOME_LABELS_EN).sort()).toEqual([...WEEK_OUTCOMES].sort());
  });
});

describe('"Your neighborhoods" — the Monday mail and push, per reader (2026-10-27)', () => {
  // Points verified against the rings (see the hoodOf test): India Point Park, City Hall, Warwick (outside every ring).
  const FOX_POINT = { lat: 41.8170, lng: -71.3930 };
  const DOWNTOWN = { lat: 41.8240, lng: -71.4128 };
  const WARWICK = { lat: 41.70, lng: -71.40 };
  const place = (id: string, p: { lat: number | null; lng: number | null }) => ({ id, label: id, address: `${id} St`, lat: p.lat, lng: p.lng });
  // College Hill: 3 requests, closes of 4 and 2 days → median 3. Elmhurst: 2 closes of 5 and 8 days → 6.5.
  // Downtown: 1 open request, no median. Fox Point: nothing. The city: [4, 2, 5, 8] → 4.5.
  const rows = () => [
    row('ch-open'),
    closedRow('ch-4d', 5, 1),
    closedRow('ch-2d', 3, 1),
    closedRow('elm-5d', 6, 1, { ...ELMHURST }),
    closedRow('elm-8d', 9, 1, { ...ELMHURST }),
    row('dt-open', { ...DOWNTOWN }),
  ];
  const summary = () => weekSummary(rows(), { now: NOW });
  const BASE = 'https://fixmypvd.org/';

  it('readerHoods: placed addresses in saved order, once each, the first 5 placed only, a place outside every ring left out', () => {
    expect(readerHoods([
      place('unplaced', { lat: null, lng: null }),
      place('home', FOX_POINT), place('work', COLLEGE_HILL), place('gym', { lat: 41.8263, lng: -71.4031 }), // College Hill again
      place('warwick', WARWICK), place('mom', ELMHURST),
      place('sixth', DOWNTOWN),                                       // the 6th placed address: past PLACES_MAX
    ])).toEqual(['Fox Point', 'College Hill', 'Elmhurst']);
    expect(PLACES_MAX).toBe(5);
    expect(readerHoods([place('away', WARWICK)])).toEqual([]);
    expect(readerHoods([])).toEqual([]);
    expect(readerHoods(undefined)).toEqual([]);
    expect(readerHoods([null, place('home', FOX_POINT)] as never)).toEqual(['Fox Point']);   // a damaged doc never throws the run
    expect(readerHoods({} as never)).toEqual([]);
    expect(readerHoods([place('x', COLLEGE_HILL)], () => 'Testville')).toEqual(['Testville']);
  });

  it('a reader without hoods gets exactly the mail everyone got before — byte for byte', () => {
    const GOLDEN = `<h2 style="margin:0 0 .2em">This week in Providence</h2><p style="color:#666;margin:0 0 1em">Oct 18 – Oct 25, from Providence 311's public list.</p>`
      + `<p style="font-size:1.1em;margin:0"><b>5</b> requests (+1 vs last week) · <b>2</b> closed (-1 vs last week)</p>`
      + `<h3 style="margin:1.2em 0 .3em">Most reported</h3><ul style="padding-left:1.2em;margin:0"><li style="margin:0 0 8px"><b>Pothole</b> · 3 (last week 4)</li><li style="margin:0 0 8px"><b>Street Light Out</b> · 2 (last week 0)</li></ul>`
      + `<h3 style="margin:1.2em 0 .3em">Busiest neighborhoods</h3><ul style="padding-left:1.2em;margin:0"><li style="margin:0 0 8px"><b>College Hill</b> · 3 requests, 1 closed</li><li style="margin:0 0 8px"><b>Elmhurst</b> · 2 requests, 1 closed</li></ul>`
      + `<h3 style="margin:1.2em 0 .3em">Closed this week, in the city's words</h3><ul style="padding-left:1.2em;margin:0"><li style="margin:0 0 8px"><b>Pothole</b> · 12 Angell St, College Hill · Resolved (closed Sat, Oct 24)<div style="color:#555;margin:2px 0 0 1em;white-space:pre-wrap">Filled &amp; compacted.</div></li><li style="margin:0 0 8px"><b>Street Light Out</b> · 1 Eaton St, Elmhurst · Resolved (closed Fri, Oct 23)<div style="color:#555;margin:2px 0 0 1em;white-space:pre-wrap">Bulb replaced</div></li></ul>`
      + `<p style="margin:1.2em 0 0"><a href="https://fixmypvd.org/week?until=2026-10-25">See the whole week</a></p>`
      + `<p style="color:#888;margin-top:2em">You asked for this every Monday on FixMyPVD. Change or stop these emails under <a href="https://fixmypvd.org/account/updates">Account → Updates</a>. FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
    const s = weekSummary([
      row('p1', { createdAt: daysAgo(1), firstSeenAt: daysAgo(1) }),
      row('p2', { createdAt: daysAgo(2), firstSeenAt: daysAgo(2) }),
      row('sl', { caseType: 'Street Light Out', category: 'street_light', ...ELMHURST }),
      closedRow('fixed', 5, 1, { street: '12 Angell St', detail: { resolutionDate: daysAgo(1), resolution: 'Filled & compacted.' } }),
      closedRow('bulb', 6, 2, { caseType: 'Street Light Out', category: 'street_light', street: '1 Eaton St', ...ELMHURST, detail: { resolutionDate: daysAgo(2), resolution: 'Bulb replaced' } }),
      row('prev-1', { createdAt: daysAgo(9), firstSeenAt: daysAgo(9) }),
      closedRow('prev-closed', 12, 9), closedRow('prev-closed-2', 12, 10), closedRow('prev-closed-3', 12, 11),
    ], { now: NOW });
    // The HTML as weekDigestEmail built it before this change (captured from the previous code), and the push body.
    expect(weekDigestEmail(s, { base: BASE }).html).toBe(GOLDEN);
    expect(weekDigestEmail(s, { base: BASE, hoods: [] }).html).toBe(GOLDEN);
    expect(weekDigestPush(s, { base: BASE }).body).toBe('5 requests · 2 closed');
    expect(weekDigestPush(s, { base: BASE, hoods: [] })).toEqual(weekDigestPush(s, { base: BASE }));
  });

  it('two hoods, one quiet: a line each in saved order, linked to /street?n=<slug>, right under the headline; the comparison for the one with a median', () => {
    const s = summary();
    expect(s.medianCloseDays).toBe(4.5);
    const m = weekDigestEmail(s, { base: BASE, hoods: ['Fox Point', 'College Hill'] });
    expect(m.subject).toBe(weekDigestEmail(s, { base: BASE }).subject);
    expect(m.html).toContain('<h3 style="margin:1.2em 0 .3em">Your neighborhoods</h3><ul style="padding-left:1.2em;margin:0">'
      + '<li style="margin:0 0 8px"><a href="https://fixmypvd.org/street?n=fox-point"><b>Fox Point</b></a>: nothing this week</li>'
      + '<li style="margin:0 0 8px"><a href="https://fixmypvd.org/street?n=college-hill"><b>College Hill</b></a>: 3 requests, 2 closed · median 3 days</li></ul>'
      + `<p style="margin:.4em 0 0">Closed requests in College Hill took a median 3 days — the city's was 4.5.</p>`);
    // Right after the headline stats, before every shared section; no UTM (the mail's other links carry none).
    const at = (t: string) => m.html.indexOf(t);
    expect(at('closed (')).toBeLessThan(at('Your neighborhoods'));
    expect(at('Your neighborhoods')).toBeLessThan(at('Most reported'));
    expect(m.html).not.toContain('utm_');
    // The rest of the mail is the shared one, untouched.
    expect(m.html.replace(/<h3 style="margin:1.2em 0 .3em">Your neighborhoods<\/h3>.*?the city's was 4\.5\.<\/p>/, '')).toBe(weekDigestEmail(s, { base: BASE }).html);
    // The plain-text part (emaillog toText, what the mailer sends as text) reads line by line.
    expect(toText(m.html)).toContain('vs last week)\nYour neighborhoods\nFox Point: nothing this week\nCollege Hill: 3 requests, 2 closed · median 3 days\n'
      + "Closed requests in College Hill took a median 3 days — the city's was 4.5.\nMost reported\n");
  });

  it('the comparison is the first listed hood WITH a median (not the first hood), only when the city has one, and none when no listed hood has one', () => {
    const s = summary();
    const m = weekDigestEmail(s, { base: BASE, hoods: ['Downtown', 'Elmhurst', 'College Hill'] });
    expect(m.html).toContain('<b>Downtown</b></a>: 1 request, 0 closed</li>');          // no dated close: no median written
    expect(m.html).toContain('<b>Elmhurst</b></a>: 2 requests, 2 closed · median 6.5 days</li>');
    expect(m.html).toContain("Closed requests in Elmhurst took a median 6.5 days — the city's was 4.5.");
    expect(m.html).not.toContain('Closed requests in College Hill');
    expect(m.html.match(/Closed requests in/g)).toHaveLength(1);
    expect(weekDigestEmail(s, { base: BASE, hoods: ['Downtown', 'Fox Point'] }).html).not.toContain('Closed requests in');
    expect(weekDigestEmail({ ...s, medianCloseDays: null }, { base: BASE, hoods: ['College Hill'] }).html).not.toContain('Closed requests in');
    // One hood: the heading is singular; a 1-day median says "1 day".
    const one = weekDigestEmail(weekSummary([closedRow('a', 2, 1)], { now: NOW }), { base: BASE, hoods: ['College Hill'] }).html;
    expect(one).toContain('>Your neighborhood</h3>');
    expect(one).toContain('<b>College Hill</b></a>: 1 request, 1 closed · median 1 day</li>');
    expect(one).toContain("took a median 1 day — the city's was 1.");
  });

  it('at most 3 hoods, the first 3 in saved order', () => {
    expect(YOUR_HOODS_N).toBe(3);
    const m = weekDigestEmail(summary(), { base: BASE, hoods: ['Fox Point', 'Downtown', 'Elmhurst', 'College Hill', 'Wayland'] });
    const yours = m.html.slice(m.html.indexOf('Your neighborhoods'), m.html.indexOf('Most reported'));
    expect([...yours.matchAll(/<b>([^<]+)<\/b><\/a>/g)].map((x) => x[1])).toEqual(['Fox Point', 'Downtown', 'Elmhurst']);
    expect(yours).not.toContain('College Hill');
    expect(yours).toContain('Closed requests in Elmhurst');
  });

  it('hood names are HTML-escaped in the line, the link and the comparison; the slug is URL-encoded', () => {
    const odd = 'Fox & <Point> "Q"';
    const s = weekSummary([closedRow('a', 3, 1)], { now: NOW, hoodOf: () => odd });
    const m = weekDigestEmail(s, { base: BASE, hoods: [odd] });
    expect(m.html).toContain('<a href="https://fixmypvd.org/street?n=fox-%26-%3Cpoint%3E-%22q%22"><b>Fox &amp; &lt;Point&gt; &quot;Q&quot;</b></a>: 1 request, 1 closed · median 2 days</li>');
    expect(m.html).toContain("Closed requests in Fox &amp; &lt;Point&gt; &quot;Q&quot; took a median 2 days — the city's was 2.");
    expect(m.html).not.toContain('<Point>');
    expect(toText(m.html)).toContain('Fox & <Point> "Q": 1 request, 1 closed · median 2 days\n');
  });

  it('push: the first listed hood with activity rides along briefly; quiet hoods, hoods past the 3rd, or none → the body as before', () => {
    const s = summary();
    const plain = weekDigestPush(s, { base: BASE });
    expect(plain).toEqual({ title: 'This week in Providence', body: '6 requests · 4 closed', url: 'https://fixmypvd.org/week?until=2026-10-25', tag: 'week' });
    expect(weekDigestPush(s, { base: BASE, hoods: ['Fox Point', 'College Hill'] })).toEqual({ ...plain, body: '6 requests · 4 closed · College Hill: 3 requests, median 3 d' });
    expect(weekDigestPush(s, { base: BASE, hoods: ['Downtown', 'Elmhurst'] }).body).toBe('6 requests · 4 closed · Downtown: 1 request');
    expect(weekDigestPush(s, { base: BASE, hoods: ['Fox Point'] })).toEqual(plain);
    expect(weekDigestPush(s, { base: BASE, hoods: ['Fox Point', 'Wayland', 'Hope', 'College Hill'] })).toEqual(plain); // the mail's 3 only
    // The longest name with four-digit counts: still one short line, far inside one push record.
    const big: WeekSummary = { ...s, total: 9999, closed: 9999, neighborhoods: [{ name: 'Upper South Providence', slug: 'upper-south-providence', n: 9999, open: 0, closed: 9999, medianCloseDays: 12.5 }] };
    const p = weekDigestPush(big, { base: BASE, hoods: ['Upper South Providence'] });
    expect(p.body).toBe('9999 requests · 9999 closed · Upper South Providence: 9999 requests, median 12.5 d');
    expect(p.body.length).toBeLessThanOrEqual(90);
    expect(new TextEncoder().encode(JSON.stringify(p)).length).toBeLessThan(MAX_PLAINTEXT);
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
    const alerts: { subject: string; html: string; kind?: string }[] = [];
    const store = {
      listWeekDigestUsers: vi.fn(async () => users),
      listCityCasesSince: vi.fn(async () => rows),
      setMeta: vi.fn(async () => {}), addEvent: vi.fn(async () => {}),
    } as unknown as Store;
    const mailer = {
      sendTo: vi.fn(async (to: string, subject: string, html: string, o?: { kind?: string }) => { sent.push({ to, subject, html, kind: o?.kind }); }),
      alert: vi.fn(async (subject: string, html: string, o?: { kind?: string }) => { alerts.push({ subject, html, kind: o?.kind }); }),
    } as unknown as Mailer;
    return { store, mailer, sent, alerts };
  }
  beforeEach(() => { resetStreetCache(); resetWeekCache(); });

  it('mails each verified opted-in account once, kind week_digest, for the calendar week ending yesterday (NY), and skips the unverified or address-less', async () => {
    const users = [
      user(),
      user({ uid: 'u2', email: 'two@example.com' }),
      user({ uid: 'u3', email: 'x@example.com', emailVerified: false }),
      user({ uid: 'u4', email: null }),
      user({ uid: 'u5', email: 'off@example.com', prefs: { emailUpdates: true, weekDigest: false } }), // a stale query hit
    ];
    const rows = [row('a'), closedRow('b', 4, 1)];
    const d = deps(users, rows);
    expect(await runWeekDigest(env, d.store, d.mailer, { now: NOW })).toEqual({ users: 5, mailed: 2, pushed: 0, adminMailed: true });
    expect(d.sent.map((m) => m.to)).toEqual(['me@example.com', 'two@example.com']);
    expect(d.sent[0]).toMatchObject({ subject: 'This week in Providence: 2 requests, 1 closed', kind: 'week_digest' });
    // NOW is Sunday Oct 25: the mail is the week ending Saturday Oct 24 (00:00 Oct 18 → 23:59:59.999 Oct 24 EDT) and links it.
    expect(d.sent[0].html).toContain('Oct 18 – Oct 24, from Providence 311');
    expect(d.sent[0].html).toContain('<a href="https://fixmypvd.org/week?until=2026-10-24">See the whole week</a>');
    expect((d.store.listCityCasesSince as any).mock.calls).toHaveLength(1);
    expect((d.store.setMeta as any).mock.calls[0]).toEqual(['weekDigest', { at: new Date(NOW).toISOString(), users: 5, mailed: 2, pushed: 0, total: 2, adminMailed: true }]);
    // Rob's post: ONE admin mail after the residents', with the exact shared Markdown for the mailed week and its dated link.
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0]).toMatchObject({ subject: 'Your r/providence post for this week', kind: 'admin_digest' });
    const md = weekPostMarkdown(weekSummary(rows, { now: NOW, until: '2026-10-24' }), { base: 'https://fixmypvd.org' });
    expect(md).toContain('**This week in Providence (Oct 18 – Oct 24)**');
    expect(md).toContain('https://fixmypvd.org/week?until=2026-10-24');
    expect(toText(d.alerts[0].html)).toContain(md);
    expect(d.alerts[0].html).toContain('<a href="https://fixmypvd.org/week?until=2026-10-24">Copy it from the week page</a>');
    expect((d.mailer.alert as any).mock.invocationCallOrder[0]).toBeGreaterThan((d.mailer.sendTo as any).mock.invocationCallOrder[1]);
    expect((d.store.addEvent as any).mock.calls[0][0]).toMatchObject({ kind: 'week.digest', data: { users: 5, mailed: 2, pushed: 0, total: 2, adminMailed: true } });
  });

  it('from the Monday 11:00 UTC cron the mail is Mon–Sun of last week, and its dated link reproduces the mailed numbers on Tuesday', async () => {
    const monday = Date.parse('2026-10-26T11:00:00Z');   // the runDaily cron: Mon Oct 26 07:00 EDT
    const rows = [
      row('mon-early', { createdAt: '2026-10-19T04:30:00Z' }),                 // Mon Oct 19 00:30 EDT — in the calendar week
      row('sun-late', { createdAt: '2026-10-26T03:30:00Z' }),                  // Sun Oct 25 23:30 EDT — in
      row('today', { createdAt: '2026-10-26T08:00:00Z' }),                     // Mon Oct 26 04:00 EDT — before the cron, but this week's
      row('last-week', { createdAt: '2026-10-19T03:00:00Z' }),                 // Sun Oct 18 23:00 EDT — the week before
      closedRow('fixed', 10, 2, { detail: { resolutionDate: '2026-10-23T15:00:00Z', resolution: 'Filled.' } }),
      closedRow('closed-today', 9, 0, { detail: { resolutionDate: '2026-10-26T09:00:00Z', resolution: 'Later.' } }), // created Oct 16 → prev; closed Mon → open in the mailed week
    ];
    const d = deps([user()], rows);
    expect(await runWeekDigest(env, d.store, d.mailer, { now: monday })).toEqual({ users: 1, mailed: 1, pushed: 0, adminMailed: true });
    expect(d.sent[0].subject).toBe('This week in Providence: 3 requests, 1 closed');
    expect(d.sent[0].html).toContain('Oct 19 – Oct 25, from Providence 311');
    expect(d.sent[0].html).toContain('<a href="https://fixmypvd.org/week?until=2026-10-25">See the whole week</a>');
    // Rob's post is the same Mon–Sun week, titled by its calendar days and linked by its Sunday.
    expect(toText(d.alerts[0].html)).toContain('**This week in Providence (Oct 19 – Oct 25)**\n\n3 requests to 311 (');
    expect(d.alerts[0].html).toContain('<a href="https://fixmypvd.org/week?until=2026-10-25">Copy it from the week page</a>');
    // The link, opened on Tuesday afternoon, is the same week with the same numbers.
    const tuesday = Date.parse('2026-10-27T19:00:00Z');
    const page = await (await handleWeek(new URL('https://api.test/api/week?until=2026-10-25'), d.store, tuesday)).json() as WeekSummary;
    expect(page).toMatchObject({ untilDate: '2026-10-25', current: false, total: 3, closed: 1, open: 2, since: '2026-10-19T04:00:00.000Z', until: '2026-10-26T03:59:59.999Z' });
    expect(page.notable.map((n) => n.id)).toEqual(['fixed']);
  });

  it("sends nothing — not Rob's post either — when the week had no cases", async () => {
    const quiet = deps([user()], [row('old', { createdAt: daysAgo(40), firstSeenAt: daysAgo(40) })]);
    expect(await runWeekDigest(env, quiet.store, quiet.mailer, { now: NOW })).toEqual({ users: 1, mailed: 0, pushed: 0, adminMailed: false });
    expect(quiet.sent).toHaveLength(0);
    expect(quiet.alerts).toHaveLength(0);
    expect((quiet.store.addEvent as any).mock.calls[0][0]).toMatchObject({ data: { total: 0, adminMailed: false } });
    expect((quiet.store.addEvent as any).mock.calls[0][0].msg).toContain('no cases');
  });

  it("with nobody opted in the week is still read once and Rob's post still goes — exactly one admin mail", async () => {
    const nobody = deps([], [row('a')]);
    expect(await runWeekDigest(env, nobody.store, nobody.mailer, { now: NOW })).toEqual({ users: 0, mailed: 0, pushed: 0, adminMailed: true });
    expect((nobody.store.listCityCasesSince as any).mock.calls).toHaveLength(1);
    expect(nobody.sent).toHaveLength(0);
    expect(nobody.alerts).toHaveLength(1);
    expect(nobody.alerts[0]).toMatchObject({ subject: 'Your r/providence post for this week', kind: 'admin_digest' });
    expect(toText(nobody.alerts[0].html)).toContain('1 request to 311 (+1 vs last week), 0 closed.');
    // Opted-in but unverified / no address: no resident mail, still the one post.
    const unverified = deps([user({ emailVerified: false }), user({ uid: 'u4', email: null })], [row('a')]);
    expect(await runWeekDigest(env, unverified.store, unverified.mailer, { now: NOW })).toEqual({ users: 2, mailed: 0, pushed: 0, adminMailed: true });
    expect(unverified.alerts).toHaveLength(1);
  });

  it('"Your neighborhoods" per reader, from the user docs the run already read: two places in two hoods (one quiet) get the block; a place outside every ring, or none, get the shared mail byte for byte', async () => {
    const place = (id: string, lat: number | null, lng: number | null) => ({ id, label: id, address: `${id} St`, lat, lng });
    const users = [
      user({ uid: 'two', email: 'two@example.com', addresses: [place('unplaced', null, null), place('home', 41.8170, -71.3930), place('work', COLLEGE_HILL.lat, COLLEGE_HILL.lng)] }),
      user({ uid: 'away', email: 'away@example.com', addresses: [place('cottage', 41.70, -71.40)] }),   // Warwick
      user({ uid: 'none', email: 'none@example.com' }),
    ];
    // College Hill: 2 requests, a 3-day close; Elmhurst: a 5-day close; the city's median 4. Fox Point: nothing.
    const rows = [row('a'), closedRow('b', 4, 1), closedRow('c', 6, 1, { ...ELMHURST })];
    const d = deps(users, rows);
    const getUser = vi.fn(async () => null);
    (d.store as unknown as Record<string, unknown>).getUser = getUser;
    expect(await runWeekDigest(env, d.store, d.mailer, { now: NOW })).toEqual({ users: 3, mailed: 3, pushed: 0, adminMailed: true });
    const shared = weekDigestEmail(weekSummary(rows, { now: NOW, until: '2026-10-24' }), { base: 'https://fixmypvd.org' });
    const to = Object.fromEntries(d.sent.map((m) => [m.to, m]));
    expect(to['none@example.com'].html).toBe(shared.html);
    expect(to['away@example.com'].html).toBe(shared.html);
    expect(to['two@example.com'].subject).toBe(shared.subject);
    expect(to['two@example.com'].html).toContain('<h3 style="margin:1.2em 0 .3em">Your neighborhoods</h3><ul style="padding-left:1.2em;margin:0">'
      + '<li style="margin:0 0 8px"><a href="https://fixmypvd.org/street?n=fox-point"><b>Fox Point</b></a>: nothing this week</li>'
      + '<li style="margin:0 0 8px"><a href="https://fixmypvd.org/street?n=college-hill"><b>College Hill</b></a>: 2 requests, 1 closed · median 3 days</li></ul>'
      + `<p style="margin:.4em 0 0">Closed requests in College Hill took a median 3 days — the city's was 4.</p>`);
    // No read per recipient: the one users query and the one cases read, nothing else.
    expect(getUser).not.toHaveBeenCalled();
    expect((d.store.listWeekDigestUsers as any).mock.calls).toHaveLength(1);
    expect((d.store.listCityCasesSince as any).mock.calls).toHaveLength(1);
  });
});
