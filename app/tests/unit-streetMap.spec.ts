import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addDays, ago, applyFilters, boundsOf, CITY_BOUNDS, clampRange, clusterGrid, DAY_MS, decodeCase, decodeFeed, defaultRange, distanceM, EMPTY_URL_STATE, facetCounts, feedDays,
  inBounds, inWindow, isDefaultView, isYmd, likelyOwnCase, metersBetween, nyDayStart, nyYmd, OWN_CASE_M, padBounds, parseStreetUrl, placeActivity, rangeBounds, sortForPoint, SPIDER_MAX,
  spiderOffsets, stackKey, streetKey, streetSearch, summaryOf, topTypes, windowTest, writeStreetUrl, type DateRange, type MapCase, type MapFeed, type StreetUrlState, type Window,
} from '../src/lib/streetMap';
import { hoodFromSlug, hoodOfSync, hoodSlug, loadNeighborhoods, neighborhoodAt, NEIGHBORHOOD_NAMES, ringBounds } from '../src/lib/neighborhoods';
import { INSTALL_FROM_VISIT, INSTALL_SNOOZE_MS, isNewSince, newCutoff, newestCreated, newSince, SINCE_MIN_MS, sinceCutoff, sinceWhen, WHILE_DAYS } from '../src/lib/streetVisit';
import { hoodOf, hoodSlug as sharedHoodSlug, NEIGHBORHOODS, NEIGHBORHOOD_NAMES as SHARED_NAMES, ringBounds as sharedRingBounds } from '../../shared/neighborhoods';

// Pure-module unit tests for the /street map page: no browser, no page fixture — Playwright's runner imports the TS
// source directly. Kept beside the browser specs because the app has no vitest.

const NOW = Date.parse('2026-10-25T17:00:00.000Z');
const minsAgo = (days: number) => Math.floor((NOW - days * 86_400_000) / 60_000);
const isoAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const FEED: MapFeed = {
  v: 1, days: 30, at: '2026-10-25T17:00:00.000Z', total: 5, located: 4, truncated: false,
  types: [['Pothole', 'pothole'], ['Street Light Out', 'street_light'], ['Mystery', 'zzz_not_a_category'], ['Something', 'unsure']],
  statuses: ['Submitted', 'Assigned', 'In Progress', 'Department Responded', 'Resolved', 'Closed', 'Cancelled', 'Merged', 'Weird'],
  items: [
    ['c1', 0, 1, minsAgo(3), 0, 41.8283, -71.4006, '10 Angell St', 0],
    ['c2', 1, 4, minsAgo(9), minsAgo(1), 41.8284, -71.4007, '22 Thayer St', 'Bulb replaced.'],
    ['c3', 2, 8, minsAgo(0), 0, 41.8282, -71.4005, '481 Angell St', 0],
    ['c4', 3, 6, minsAgo(20), minsAgo(12), null, null, '', 'Dup.'],
    ['c5', 0, 5, minsAgo(45), minsAgo(2), 41.8300, -71.4100, '5 Hope St', 0],
  ],
};
const DECODED = decodeFeed(FEED);
const byId = (id: string) => DECODED.cases.find((c) => c.id === id)!;

function mkCase(o: Partial<MapCase> & { id: string }): MapCase {
  return { caseType: 'Pothole', category: 'pothole', group: 'streets', status: 'Submitted', open: true, createdAt: isoAgo(1), closedAt: null, street: '1 Main St', resolution: null, lat: 41.82, lng: -71.41, ...o };
}

test.describe('decodeCase', () => {
  test('a GET /api/street/case body → MapCase with decodeFeed\'s defaults', () => {
    expect(decodeCase({ id: 'g1', caseType: 'Sidewalk', category: 'sidewalk_repair', street: '5 Elm St', status: 'Resolved', createdAt: '2026-06-01T12:00:00.000Z', closedAt: '2026-10-19T00:00:00.000Z', resolution: 'Repaired.', lat: 41.83, lng: -71.41, updatedAt: '2026-10-20T09:00:00.000Z' }))
      .toEqual({ id: 'g1', caseType: 'Sidewalk', category: 'sidewalk_repair', group: 'streets', status: 'Resolved', open: false, createdAt: '2026-06-01T12:00:00.000Z', closedAt: '2026-10-19T00:00:00.000Z', street: '5 Elm St', resolution: 'Repaired.', lat: 41.83, lng: -71.41 });
    // Blanks and an unplaced case degrade like a feed row; an odd category lands in 'other'.
    expect(decodeCase({ id: 'g2', status: 'Assigned', category: 'mystery', lat: null, lng: 1 } as never))
      .toMatchObject({ caseType: '', category: 'mystery', group: 'other', open: true, street: '', resolution: null, lat: null, lng: null, createdAt: null, closedAt: null });
  });
});

test.describe('decodeFeed', () => {
  test('tuples → cases: minutes to ISO, res || null, open from the CLOSED set, group fallback other', () => {
    expect(DECODED.cases.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']); // array order kept
    expect(DECODED).toMatchObject({ days: 30, total: 5, located: 4, truncated: false, at: FEED.at });
    const c1 = byId('c1');
    expect(c1).toMatchObject({ caseType: 'Pothole', category: 'pothole', group: 'streets', status: 'Assigned', open: true, street: '10 Angell St', resolution: null, lat: 41.8283, lng: -71.4006, closedAt: null });
    expect(Date.parse(c1.createdAt!)).toBe(minsAgo(3) * 60_000);
    const c2 = byId('c2');
    expect(c2).toMatchObject({ group: 'lights', status: 'Resolved', open: false, resolution: 'Bulb replaced.' });
    expect(c2.closedAt).toBe(new Date(minsAgo(1) * 60_000).toISOString());
    expect(byId('c3')).toMatchObject({ group: 'other', status: 'Weird', open: true });         // unknown category + unknown status
    expect(byId('c4')).toMatchObject({ group: 'other', status: 'Cancelled', open: false, lat: null, lng: null, street: '', resolution: 'Dup.' }); // 'unsure' → other
    expect(byId('c5')).toMatchObject({ status: 'Closed', open: false });
  });

  test('a bad type/status index degrades instead of throwing', () => {
    const d = decodeFeed({ ...FEED, items: [['x', 99, 99, 0, 0, 1, 2, 'S', 0]] });
    expect(d.cases[0]).toMatchObject({ caseType: '', category: 'unsure', group: 'other', status: '', open: true, createdAt: null, closedAt: null });
  });
});

test.describe('filters', () => {
  test('inWindow cuts "this week" and "24 hours" client-side; closing counts as activity', () => {
    expect(inWindow(byId('c3'), 1, NOW)).toBe(true);    // reported now
    expect(inWindow(byId('c1'), 1, NOW)).toBe(false);   // 3 days ago
    expect(inWindow(byId('c2'), 1, NOW)).toBe(true);    // closed exactly 24 h ago (to the minute) — the edge is in
    expect(inWindow(mkCase({ id: 'h', createdAt: isoAgo(5), closedAt: new Date(NOW - DAY_MS - 60_000).toISOString() }), 1, NOW)).toBe(false);
    expect(inWindow(byId('c1'), 7, NOW)).toBe(true);
    expect(inWindow(byId('c4'), 7, NOW)).toBe(false);   // created 20 d, closed 12 d ago
    expect(inWindow(byId('c4'), 30, NOW)).toBe(true);
    expect(inWindow(byId('c5'), 7, NOW)).toBe(true);    // created 45 d ago but closed 2 d ago
    expect(inWindow(mkCase({ id: 'nodate', createdAt: null }), 7, NOW)).toBe(true); // unparseable → kept
  });

  test('applyFilters: window, status, groups (any of them); order preserved', () => {
    const f = (g: ('streets' | 'lights' | 'other')[], s: 'open' | 'closed' | null, d: Window, range: DateRange | null = null) => applyFilters(DECODED.cases, { g, s, d, range }, NOW).map((c) => c.id);
    expect(f([], null, 30)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(f([], null, 7)).toEqual(['c1', 'c2', 'c3', 'c5']);
    expect(f([], null, 1)).toEqual(['c2', 'c3']);
    expect(f([], 'open', 30)).toEqual(['c1', 'c3']);
    expect(f([], 'closed', 7)).toEqual(['c2', 'c5']);
    expect(f(['streets'], null, 30)).toEqual(['c1', 'c5']);
    expect(f(['lights'], 'open', 30)).toEqual([]);
    // Several groups: their union.
    expect(f(['streets', 'lights'], null, 30)).toEqual(['c1', 'c2', 'c5']);
    expect(f(['lights', 'other'], 'closed', 30)).toEqual(['c2', 'c4']);
    // A range wins over the preset.
    expect(f([], null, 7, { from: '2026-10-10', to: '2026-10-15' })).toEqual(['c4']);
  });

  test('a custom range: reported or closed between From 00:00 and To 23:59:59 Providence time; no date stays in', () => {
    // NOW = Oct 25, 1 PM EDT: c1 reported Oct 22; c2 reported Oct 16, closed Oct 24; c3 reported Oct 25; c4 reported
    // Oct 5, closed Oct 13; c5 reported Sep 10, closed Oct 23.
    const ids = (from: string, to: string) => DECODED.cases.filter(windowTest({ d: 30, range: { from, to } }, NOW)).map((c) => c.id);
    expect(ids('2026-10-22', '2026-10-22')).toEqual(['c1']);
    expect(ids('2026-10-23', '2026-10-24')).toEqual(['c2', 'c5']);       // by their closes
    expect(ids('2026-09-10', '2026-09-10')).toEqual(['c5']);              // by its report (closed after the range)
    expect(ids('2026-10-17', '2026-10-21')).toEqual([]);                  // c2 open across it — nothing happened then
    expect(ids('2026-09-01', '2026-10-25')).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    // The day's edges are Providence's midnights (EDT: 04:00 UTC).
    const at = (iso: string) => mkCase({ id: iso, createdAt: iso });
    const oct22 = windowTest({ d: 30, range: { from: '2026-10-22', to: '2026-10-22' } }, NOW);
    expect(oct22(at('2026-10-22T04:00:00.000Z'))).toBe(true);   // 00:00 Oct 22
    expect(oct22(at('2026-10-22T03:59:59.000Z'))).toBe(false);  // 23:59:59 Oct 21
    expect(oct22(at('2026-10-23T03:59:59.000Z'))).toBe(true);   // 23:59:59 Oct 22
    expect(oct22(at('2026-10-23T04:00:00.000Z'))).toBe(false);  // 00:00 Oct 23
    expect(oct22(mkCase({ id: 'nodate', createdAt: null }))).toBe(true);
    // Without a range the preset applies.
    expect(DECODED.cases.filter(windowTest({ d: 7, range: null }, NOW)).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c5']);
  });

  test('Providence calendar days: today, midnight (EST and EDT, both change days), day arithmetic, validity, the inputs\' bounds', () => {
    expect(nyYmd(Date.parse('2026-10-26T03:59:00.000Z'))).toBe('2026-10-25');
    expect(nyYmd(Date.parse('2026-10-26T04:00:00.000Z'))).toBe('2026-10-26');
    expect(nyYmd(Date.parse('2026-12-02T04:59:00.000Z'))).toBe('2026-12-01');
    expect(new Date(nyDayStart('2026-10-25')).toISOString()).toBe('2026-10-25T04:00:00.000Z');
    expect(new Date(nyDayStart('2026-12-01')).toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(new Date(nyDayStart('2026-03-08')).toISOString()).toBe('2026-03-08T05:00:00.000Z'); // clocks spring forward at 2 AM
    expect(new Date(nyDayStart('2026-11-01')).toISOString()).toBe('2026-11-01T04:00:00.000Z'); // and fall back at 2 AM
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(isYmd('2024-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2026-2-3', '2026-10-25T00:00', '', null, undefined]) expect(isYmd(bad), String(bad)).toBe(false);
    expect(rangeBounds(NOW)).toEqual({ min: '2026-07-28', max: '2026-10-25' });   // today − 89 … today
    expect(defaultRange(NOW)).toEqual({ from: '2026-10-18', to: '2026-10-25' });  // the last 7 days
  });

  test('feedDays: 30 for 24 hours / this week / 30 days, 90 for 90; a range → the smallest server window (7 / 30 / 90) that reaches From 00:00', () => {
    for (const d of [1, 7, 30] as const) expect(feedDays({ d, range: null }, NOW)).toBe(30);
    expect(feedDays({ d: 90, range: null }, NOW)).toBe(90);
    const back = (from: string) => feedDays({ d: 30, range: { from, to: '2026-10-25' } }, NOW);
    expect(back('2026-10-25')).toBe(7);
    expect(back('2026-10-19')).toBe(7);    // 00:00 Oct 19 is 6.5 days back
    expect(back('2026-10-18')).toBe(30);   // 7.5 days back: past the 7-day set
    expect(back('2026-09-26')).toBe(30);
    expect(back('2026-09-25')).toBe(90);   // 30.5 days back
    expect(back(rangeBounds(NOW).min)).toBe(90);
  });

  test('clampRange: a range from a link is held to the inputs\' bounds (Jul 28 … Oct 25 here) — From raised, To lowered; nothing left → null', () => {
    const inside = { from: '2026-10-01', to: '2026-10-15' };
    expect(clampRange(inside, NOW)).toBe(inside); // untouched: the same object
    expect(clampRange({ from: '2026-07-28', to: '2026-10-25' }, NOW)).toEqual({ from: '2026-07-28', to: '2026-10-25' });
    // Partly before them: the first days were never loaded (a 90-day feed), so From starts at today − 89.
    expect(clampRange({ from: '2026-07-16', to: '2026-08-15' }, NOW)).toEqual({ from: '2026-07-28', to: '2026-08-15' });
    expect(clampRange({ from: '2026-07-01', to: '2026-07-28' }, NOW)).toEqual({ from: '2026-07-28', to: '2026-07-28' });
    // Past today: To is today.
    expect(clampRange({ from: '2026-10-20', to: '2026-11-02' }, NOW)).toEqual({ from: '2026-10-20', to: '2026-10-25' });
    // Wholly outside: no range (the preset applies) — an Oct 1–15 link opened in February, or one in the future.
    expect(clampRange({ from: '2026-07-01', to: '2026-07-27' }, NOW)).toBeNull();
    expect(clampRange({ from: '2026-10-01', to: '2026-10-15' }, Date.parse('2027-02-10T17:00:00.000Z'))).toBeNull();
    expect(clampRange({ from: '2026-10-01', to: '2026-10-15' }, Date.parse('2027-01-10T17:00:00.000Z'))).toEqual({ from: '2026-10-13', to: '2026-10-15' });
    expect(clampRange({ from: '2026-10-26', to: '2026-10-30' }, NOW)).toBeNull();
    expect(clampRange(null, NOW)).toBeNull();
  });

  test('facetCounts releases each control\'s own dimension', () => {
    const all = facetCounts(DECODED.cases, null, { g: [], s: null, d: 30, range: null }, NOW);
    expect(all).toMatchObject({ open: 2, closed: 3, all: 5, total: 5 });
    expect(all.groups).toMatchObject({ streets: 2, lights: 1, other: 2, trash: 0 });
    // s=open: the Closed chip still counts the closed cases (status released); groups honour the status filter
    const open = facetCounts(DECODED.cases, null, { g: [], s: 'open', d: 30, range: null }, NOW);
    expect(open).toMatchObject({ open: 2, closed: 3, all: 2, total: 2 });
    expect(open.groups).toMatchObject({ streets: 1, other: 1, lights: 0 });
    // g=lights: open/closed count only lights, All counts everything (group released)
    const lights = facetCounts(DECODED.cases, null, { g: ['lights'], s: null, d: 30, range: null }, NOW);
    expect(lights).toMatchObject({ open: 0, closed: 1, all: 5, total: 1 });
    // several groups: open/closed and total count their union; each group's own count is unchanged
    const two = facetCounts(DECODED.cases, null, { g: ['streets', 'lights'], s: null, d: 30, range: null }, NOW);
    expect(two).toMatchObject({ open: 1, closed: 2, all: 5, total: 3 });
    expect(two.groups).toMatchObject({ streets: 2, lights: 1, other: 2 });
    // a window applies to every count — a preset or a range
    expect(facetCounts(DECODED.cases, null, { g: [], s: null, d: 7, range: null }, NOW)).toMatchObject({ all: 4, total: 4, closed: 2 });
    expect(facetCounts(DECODED.cases, null, { g: [], s: null, d: 30, range: { from: '2026-10-23', to: '2026-10-24' } }, NOW)).toMatchObject({ all: 2, total: 2, open: 0, closed: 2 });
    // bounds: the unlocated c4 never counts; c5 is outside this tight box
    const box = { south: 41.828, north: 41.8285, west: -71.401, east: -71.400 };
    expect(facetCounts(DECODED.cases, box, { g: [], s: null, d: 30, range: null }, NOW)).toMatchObject({ open: 2, closed: 1, all: 3, total: 3 });
  });

  test('summaryOf: city mode counts the unplaced, view mode counts the box', () => {
    expect(summaryOf(DECODED.cases, null, 30)).toEqual({ kind: 'city', total: 5, open: 2, closed: 3, located: 4, unplaced: 1, days: 30 });
    expect(summaryOf(DECODED.cases, { south: 41.828, north: 41.8285, west: -71.401, east: -71.400 }, 30)).toEqual({ kind: 'view', n: 3, open: 2, closed: 1 });
  });

  test('topTypes', () => {
    expect(topTypes(DECODED.cases, 2)).toEqual([{ caseType: 'Pothole', category: 'pothole', group: 'streets', n: 2 }, { caseType: 'Street Light Out', category: 'street_light', group: 'lights', n: 1 }]);
  });
});

test.describe('geometry + sorting', () => {
  test('metersBetween, distanceM, inBounds, padBounds, boundsOf', () => {
    expect(metersBetween(41.8282, -71.4005, 41.8282, -71.4005)).toBe(0);
    expect(Math.round(metersBetween(41.8282, -71.4005, 41.8291, -71.4005))).toBe(100); // 0.0009° lat ≈ 100 m
    expect(distanceM(byId('c1'), { lat: 41.8282, lng: -71.4005 })).toBe(14);
    expect(distanceM(byId('c4'), { lat: 41.8282, lng: -71.4005 })).toBeNull();
    expect(inBounds(byId('c1'), CITY_BOUNDS)).toBe(true);
    expect(inBounds(byId('c4'), CITY_BOUNDS)).toBe(false);
    expect(padBounds({ south: 0, north: 10, west: 0, east: 20 }, 0.05)).toEqual({ south: -0.5, north: 10.5, west: -1, east: 21 });
    expect(boundsOf(DECODED.cases)).toEqual({ south: 41.8282, north: 41.83, west: -71.41, east: -71.4005 });
    expect(boundsOf([byId('c4')])).toBeNull();
  });

  test('sortForPoint: open first, then nearest, unlocated last', () => {
    const p = { lat: 41.8282, lng: -71.4005 };
    expect(sortForPoint(DECODED.cases, p).map((c) => c.id)).toEqual(['c3', 'c1', 'c2', 'c5', 'c4']);
    expect(DECODED.cases.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']); // input untouched
  });

  test('ago', () => {
    expect(ago(isoAgo(0), NOW)).toBe('today');
    expect(ago(new Date(NOW - 3_600_000).toISOString(), NOW)).toBe('today');
    expect(ago(isoAgo(1), NOW)).toBe('yesterday');
    expect(ago(isoAgo(9), NOW)).toBe(9);
    expect(ago(null, NOW)).toBeNull();
    expect(ago('garbage', NOW)).toBeNull();
    expect(ago(new Date(NOW + 60_000).toISOString(), NOW)).toBe('today'); // clock skew never goes negative
  });
});

test.describe('clusterGrid', () => {
  // A linear "projection": px per degree at a zoom. Web Mercator at Providence is ~0.47 m/px at z18; this stand-in
  // is 2^zoom px per degree so cells merge or split exactly as zoom moves, which is all the algorithm cares about.
  const projAt = (zoom: number) => (lat: number, lng: number) => ({ x: lng * 2 ** zoom, y: -lat * 2 ** zoom });
  const pt = (id: string, lat: number, lng: number, open = true) => ({ id, lat, lng, open });

  test('a stack of six at one coordinate stays one cluster at zoom 18 and lists its members', () => {
    const pts = Array.from({ length: 6 }, (_, i) => pt(`s${i}`, 41.8282, -71.4005, i % 2 === 0));
    const r = clusterGrid([...pts, pt('lone', 41.8300, -71.4100)], projAt(18), 18);
    expect(r.clustered).toBe(false);
    expect(r.singles).toEqual(['lone']);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]).toMatchObject({ key: `s:${stackKey(41.8282, -71.4005)}`, n: 6, open: 3, stack: true, lat: 41.8282, lng: -71.4005 });
    expect(r.clusters[0].ids.sort()).toEqual(pts.map((p) => p.id).sort());
    // 5-dp key: 1e-6 apart is the same spot, 1e-4 is not
    expect(stackKey(41.828201, -71.4005)).toBe(stackKey(41.8282, -71.4005));
    expect(stackKey(41.8283, -71.4005)).not.toBe(stackKey(41.8282, -71.4005));
  });

  test('cells merge at zoom 12 and split at zoom 18', () => {
    const pts = [pt('a', 41.8282, -71.4005), pt('b', 41.8290, -71.4010), pt('c', 41.8500, -71.4400)];
    const low = clusterGrid(pts, projAt(12), 12);
    expect(low.clustered).toBe(true);
    expect(low.clusters).toHaveLength(1);
    expect(low.clusters[0]).toMatchObject({ n: 2, stack: false });
    expect(low.clusters[0].ids.sort()).toEqual(['a', 'b']);
    expect(low.clusters[0].key).toMatch(/^g12:56:-?\d+,-?\d+$/);
    expect(low.clusters[0].lat).toBeCloseTo(41.8286, 4);
    expect(low.singles).toEqual(['c']);
    const high = clusterGrid(pts, projAt(18), 18);
    expect(high.clusters).toEqual([]);
    expect(high.singles.sort()).toEqual(['a', 'b', 'c']);
  });

  test('zoom < 15 clusters even when sparse; zoom 15–17 clusters only when dense, with hysteresis', () => {
    const sparse = [pt('a', 41.80, -71.40), pt('b', 41.85, -71.45)];
    expect(clusterGrid(sparse, projAt(14), 14)).toMatchObject({ clustered: true, clusters: [], singles: ['a', 'b'] });
    expect(clusterGrid(sparse, projAt(15), 15)).toMatchObject({ clustered: false, singles: ['a', 'b'] });
    // 220 scattered points: dense (> 200) → clustered at z16; with pins already showing (forcePins) 220 ≤ 250 keeps pins
    const many = (n: number) => Array.from({ length: n }, (_, i) => pt(`p${i}`, 41.78 + (i % 20) * 0.004, -71.47 + Math.floor(i / 20) * 0.004));
    expect(clusterGrid(many(220), projAt(16), 16).clustered).toBe(true);
    expect(clusterGrid(many(220), projAt(16), 16, { forcePins: true }).clustered).toBe(false);
    expect(clusterGrid(many(260), projAt(16), 16, { forcePins: true }).clustered).toBe(true);
    expect(clusterGrid(many(260), projAt(18), 18).clustered).toBe(false); // ≥ 18 only stacks
    expect(clusterGrid([], projAt(12), 12)).toEqual({ clusters: [], singles: [], cell: 56, clustered: false });
  });

  test('adaptive cap grows the cell when more than 250 singletons remain', () => {
    // 24 × 25 grid; at this scale neighbours sit 60 px apart → every point alone in a 56 px cell
    const scale = 60 / 0.001;
    const pts = Array.from({ length: 600 }, (_, i) => pt(`p${i}`, 41.78 + (i % 24) * 0.001, -71.47 + Math.floor(i / 24) * 0.001));
    const r = clusterGrid(pts, (lat, lng) => ({ x: lng * scale, y: -lat * scale }), 15);
    expect(r.clustered).toBe(true);
    expect(r.cell).toBeGreaterThan(56);
    expect(r.singles.length).toBeLessThanOrEqual(250);
    expect(r.singles.length + r.clusters.reduce((n, c) => n + c.n, 0)).toBe(600); // nothing lost
    const fixed = clusterGrid(pts, (lat, lng) => ({ x: lng * scale, y: -lat * scale }), 15, { cap: 10_000 });
    expect(fixed.cell).toBe(56);
    expect(fixed.singles).toHaveLength(600);
  });

  test('a stack inside a grid cell merges with its neighbours but keeps the stack flag when alone', () => {
    const stack = [pt('s1', 41.8282, -71.4005), pt('s2', 41.8282, -71.4005)];
    const alone = clusterGrid(stack, projAt(12), 12);
    expect(alone.clusters[0]).toMatchObject({ n: 2, stack: true });
    const mixed = clusterGrid([...stack, pt('n', 41.8283, -71.4006)], projAt(12), 12);
    expect(mixed.clusters[0]).toMatchObject({ n: 3, stack: false });
  });
});

test.describe('spiderOffsets', () => {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  test('2–12 at one spot: one anchor per member, ≥ 26 px apart and ≥ 22 px off the spot; two side by side; one circle with neighbours ≥ 30 px apart — the slots above the dot on it, those below 20 px further down (their heads on it); nothing outside 2–12', () => {
    expect(SPIDER_MAX).toBe(12);
    for (let n = 2; n <= SPIDER_MAX; n++) {
      const o = spiderOffsets(n);
      expect(o).toHaveLength(n);
      for (const [i, a] of o.entries()) {
        expect(Math.hypot(a.x, a.y), `n=${n} #${i}`).toBeGreaterThanOrEqual(22 - 1e-9);
        for (const b of o.slice(i + 1)) expect(dist(a, b), `n=${n}`).toBeGreaterThanOrEqual(26);
      }
      expect(spiderOffsets(n)).toEqual(o); // deterministic: the same slots on every redraw
    }
    const [l, r] = spiderOffsets(2);
    expect([l.x, l.y, r.x, r.y].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([-22, 0, 22, 0]);
    for (let n = 3; n <= SPIDER_MAX; n++) {
      const o = spiderOffsets(n);
      const radii = o.map((p) => Math.hypot(p.x, p.y > 1e-9 ? p.y - 20 : p.y));
      expect(Math.max(...radii) - Math.min(...radii), `n=${n} one circle`).toBeLessThan(1e-9);
      expect(radii[0]).toBeCloseTo(Math.max(22, 30 / (2 * Math.sin(Math.PI / n))), 9);
      for (let i = 0; i < n; i++) expect(dist(o[i], o[(i + 1) % n]), `n=${n} neighbours`).toBeGreaterThanOrEqual(30 - 1e-9);
      // symmetric about the vertical through the spot
      const xs = o.map((p) => Math.round(p.x * 1e6)).sort((a, b) => a - b);
      expect(xs.map((x) => x + 0)).toEqual([...xs].reverse().map((x) => -x + 0));
      expect(Math.max(...o.map((p) => Math.hypot(p.x, p.y)))).toBeLessThan(80); // twelve: within ~80 px of the spot
    }
    for (const n of [-1, 0, 1, 13, 40, 2.5, NaN]) expect(spiderOffsets(n)).toEqual([]);
  });

  test('every leg shows: the legs run under the pins, so none passes within 12 px of another member\'s head (centred 20 px above its tip, r ≈ 11 with its outline) — on the plain circle a 4-stack\'s upper legs and a 5-stack\'s side legs ran under the lower pins\' heads', () => {
    const fromSegment = (p: { x: number; y: number }, b: { x: number; y: number }) => {
      const t = Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / (b.x * b.x + b.y * b.y)));
      return Math.hypot(p.x - t * b.x, p.y - t * b.y);
    };
    for (let n = 2; n <= SPIDER_MAX; n++) {
      const o = spiderOffsets(n);
      for (const [i, tip] of o.entries()) {
        for (const [j, other] of o.entries()) {
          if (j === i) continue;
          const head = { x: other.x, y: other.y - 20 };
          expect(fromSegment(head, tip), `n=${n}: the leg to #${i} (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)}) by #${j}'s head`).toBeGreaterThanOrEqual(12);
        }
      }
    }
  });

  test('a pin hangs above its anchor, so no slot puts one over the centre dot: the head (r ≈ 10, 21 px above the tip) and the taper to the tip stay clear of the dot (r 3.5)', () => {
    const coversSpot = (p: { x: number; y: number }) => {
      const up = p.y; // the spot is this many px above the pin's tip
      if (up <= 0) return false;
      return Math.hypot(p.x, up - 21) < 10 + 3.5 || (up < 21 && Math.abs(p.x) < (10 * up) / 21 + 3.5);
    };
    for (let n = 2; n <= SPIDER_MAX; n++) {
      for (const p of spiderOffsets(n)) expect(coversSpot(p), `n=${n} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).toBe(false);
    }
  });
});

test.describe('url state', () => {
  test('writeStreetUrl omits defaults; parse(write(state)) round-trips', () => {
    expect(writeStreetUrl(EMPTY_URL_STATE).toString()).toBe('');
    expect(writeStreetUrl({ d: 30, s: null, g: [], range: null }).toString()).toBe('');
    const full: StreetUrlState = { lat: 41.8282, lng: -71.4005, q: '481 Angell St', center: { lat: 41.82834, lng: -71.40061 }, zoom: 17, hood: 'Upper South Providence', g: ['streets'], s: 'open', d: 90, range: null, caseId: 'c1' };
    const p = writeStreetUrl(full);
    expect(p.toString()).toBe('lat=41.82820&lng=-71.40050&q=481+Angell+St&c=41.8283%2C-71.4006&z=17&n=upper-south-providence&g=streets&s=open&d=90&case=c1');
    expect(parseStreetUrl(p)).toEqual({ ...full, center: { lat: 41.8283, lng: -71.4006 } });
    // the digest email's link, unchanged contract
    expect(parseStreetUrl(new URLSearchParams('lat=41.82820&lng=-71.40050&q=481%20Angell%20St'))).toEqual({ ...EMPTY_URL_STATE, lat: 41.8282, lng: -71.4005, q: '481 Angell St' });
    expect(writeStreetUrl({ lat: 41.8282, lng: -71.4005, q: '481 Angell St' }).toString()).toBe('lat=41.82820&lng=-71.40050&q=481+Angell+St');
    expect(writeStreetUrl({ d: 7 }).toString()).toBe('d=7');
    expect(writeStreetUrl({ s: 'closed', g: ['trash'] }).toString()).toBe('g=trash&s=closed');
  });

  test('filters v2 in the URL: d=1 for 24 hours; several groups as g=a,b in GROUP_ORDER (the address bar keeps the commas); a custom range as from=&to= with no d; malformed ones dropped', () => {
    expect(writeStreetUrl({ d: 1 }).toString()).toBe('d=1');
    expect(parseStreetUrl(new URLSearchParams('d=1')).d).toBe(1);
    // Groups: canonical order, unknown and repeated dropped; the old single g= is a list of one.
    expect(streetSearch({ g: ['streets', 'trash'] })).toBe('g=trash,streets');
    expect(writeStreetUrl({ g: ['streets', 'trash'] }).get('g')).toBe('trash,streets');
    expect(parseStreetUrl(new URLSearchParams('g=trash,streets')).g).toEqual(['trash', 'streets']);
    expect(parseStreetUrl(new URLSearchParams('g=trash%2Cstreets')).g).toEqual(['trash', 'streets']);
    expect(parseStreetUrl(new URLSearchParams('g=streets,nope,trash,streets')).g).toEqual(['trash', 'streets']);
    expect(parseStreetUrl(new URLSearchParams('g=trash')).g).toEqual(['trash']);
    expect(parseStreetUrl(new URLSearchParams('g=,')).g).toEqual([]);
    // Only g's commas are spelled out; the view's c= stays as URLSearchParams writes it.
    expect(streetSearch({ center: { lat: 41.8283, lng: -71.4006 }, zoom: 16, g: ['trash', 'water'], q: 'a,b', lat: 41.8282, lng: -71.4005 })).toBe('lat=41.82820&lng=-71.40050&q=a%2Cb&c=41.8283%2C-71.4006&z=16&g=trash,water');
    // A range: from + to, no d (it wins over any preset).
    const range = { from: '2026-10-01', to: '2026-10-15' };
    expect(writeStreetUrl({ range, d: 7 }).toString()).toBe('from=2026-10-01&to=2026-10-15');
    expect(parseStreetUrl(new URLSearchParams('from=2026-10-01&to=2026-10-15'))).toMatchObject({ range, d: 30 });
    expect(parseStreetUrl(new URLSearchParams('from=2026-10-15&to=2026-10-15')).range).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    for (const bad of ['from=2026-10-15&to=2026-10-01', 'from=2026-10-01', 'to=2026-10-01', 'from=2026-02-30&to=2026-03-02', 'from=10/01/2026&to=10/15/2026']) {
      expect(parseStreetUrl(new URLSearchParams(bad)).range, bad).toBeNull();
    }
    expect(writeStreetUrl({ range: { from: '2026-10-15', to: '2026-10-01' }, d: 7 }).toString()).toBe('d=7'); // never writes a backwards range
    const full: StreetUrlState = { ...EMPTY_URL_STATE, lat: 41.8282, lng: -71.4005, q: 'x', g: ['trash', 'lights', 'other'], s: 'closed', d: 30, range, caseId: 'c9' };
    expect(parseStreetUrl(new URLSearchParams(streetSearch(full)))).toEqual(full);
  });

  test('old filter links map onto the one-choice Show: no s (both statuses on) → All, s=open → Open, s=closed → Closed; g / d as before', () => {
    // The chip rail could never turn both statuses off, so every link it wrote is one of these three.
    expect(parseStreetUrl(new URLSearchParams('lat=41.82820&lng=-71.40050')).s).toBeNull();
    expect(parseStreetUrl(new URLSearchParams('s=open')).s).toBe('open');
    expect(parseStreetUrl(new URLSearchParams('s=closed')).s).toBe('closed');
    expect(parseStreetUrl(new URLSearchParams('s=both')).s).toBeNull();
    expect(parseStreetUrl(new URLSearchParams('g=trash&d=7'))).toMatchObject({ g: ['trash'], d: 7, s: null });
    expect(parseStreetUrl(new URLSearchParams('g=other')).g).toEqual(['other']); // /week's "Most reported" → Other
    // All writes nothing, so a cleared view's link is the bare page.
    expect(writeStreetUrl({ s: null, g: [], d: 30, range: null }).toString()).toBe('');
  });

  test('parseStreetUrl drops unknown or malformed values', () => {
    const st = parseStreetUrl(new URLSearchParams('lat=abc&lng=-71.4&q=x&c=41.8&z=16&n=narnia&g=nope&s=maybe&d=15&from=x&to=y&case='));
    expect(st).toEqual(EMPTY_URL_STATE);
    expect(parseStreetUrl(new URLSearchParams('c=41.8283,-71.4006')).center).toBeNull();      // z missing → no view
    expect(parseStreetUrl(new URLSearchParams('c=41.8283,-71.4006&z=16.5')).zoom).toBeNull(); // integer zoom only
    expect(parseStreetUrl(new URLSearchParams('lat=91&lng=0')).lat).toBeNull();
    expect(parseStreetUrl(new URLSearchParams('n=Fox-Point&d=7&s=closed')).hood).toBe('Fox Point');
    expect(parseStreetUrl(new URLSearchParams('n=Fox-Point&d=7&s=closed')).d).toBe(7);
    expect(writeStreetUrl(parseStreetUrl(new URLSearchParams('g=nope&d=15'))).toString()).toBe('');
  });

  test('isDefaultView: the fit, z16 at the point, z17 at the case', () => {
    const point = { lat: 41.8282, lng: -71.4005 };
    expect(isDefaultView({ center: point, zoom: 16 }, { point })).toBe(true);
    expect(isDefaultView({ center: { lat: 41.82825, lng: -71.4005 }, zoom: 16 }, { point })).toBe(true);   // ~6 m
    expect(isDefaultView({ center: { lat: 41.8290, lng: -71.4005 }, zoom: 16 }, { point })).toBe(false);   // ~90 m
    expect(isDefaultView({ center: point, zoom: 15 }, { point })).toBe(false);
    expect(isDefaultView({ center: point, zoom: 17 }, { caseAt: point })).toBe(true);
    expect(isDefaultView({ center: point, zoom: 17 }, { point })).toBe(false);
    const fitted = { center: { lat: 41.8215, lng: -71.4215 }, zoom: 12 };
    expect(isDefaultView(fitted, { fitted })).toBe(true);
    expect(isDefaultView({ center: fitted.center, zoom: 13 }, { fitted })).toBe(false);
    expect(isDefaultView({ center: point, zoom: 12 }, {})).toBe(false);
  });
});

test.describe('neighborhoods', () => {
  test('NEIGHBORHOOD_NAMES matches the shared rings (one copy, lazily loaded); slugs round-trip', async () => {
    const nb = await loadNeighborhoods();
    expect(nb).toBe(NEIGHBORHOODS);                           // the shared module's own object, not a copy
    expect(Object.keys(nb)).toEqual([...NEIGHBORHOOD_NAMES]);
    expect([...SHARED_NAMES]).toEqual([...NEIGHBORHOOD_NAMES]); // the app's static list (kept so ?n= parses before the rings load)
    expect(NEIGHBORHOOD_NAMES).toHaveLength(25);
    expect(hoodSlug('Upper South Providence')).toBe('upper-south-providence');
    expect(hoodSlug('Fox Point')).toBe('fox-point');
    for (const n of NEIGHBORHOOD_NAMES) expect(hoodFromSlug(hoodSlug(n))).toBe(n);
    expect(new Set(NEIGHBORHOOD_NAMES.map(hoodSlug)).size).toBe(25);
    expect(hoodFromSlug('FOX-POINT')).toBe('Fox Point');
    expect(hoodFromSlug('narnia')).toBeNull();
    expect(hoodFromSlug(null)).toBeNull();
  });

  test('hoodOfSync and ringBounds against real rings', async () => {
    const nb = await loadNeighborhoods();
    expect(hoodOfSync(nb, 41.8262, -71.4032)).toBe('College Hill');  // Brown's main green
    expect(hoodOfSync(nb, 41.8240, -71.4128)).toBe('Downtown');      // City Hall
    expect(hoodOfSync(nb, 41.8170, -71.3930)).toBe('Fox Point');     // India Point Park
    expect(hoodOfSync(nb, 41.70, -71.40)).toBeNull();                // Warwick
    const b = ringBounds(nb['Downtown']);
    expect(b.south).toBeLessThan(41.8240); expect(b.north).toBeGreaterThan(41.8240);
    expect(b.west).toBeLessThan(-71.4128); expect(b.east).toBeGreaterThan(-71.4128);
    expect(b.north - b.south).toBeLessThan(0.05);
    expect(ringBounds([[[-71.5, 41.8], [-71.4, 41.9], [-71.45, 41.7]]])).toEqual({ south: 41.7, north: 41.9, west: -71.5, east: -71.4 });
  });

  test('the app\'s resolver agrees with the Worker\'s hoodOf; the copied helpers equal the shared ones', async () => {
    const nb = await loadNeighborhoods();
    const points: [number, number, string | null][] = [
      [41.8170, -71.3930, 'Fox Point'],   // India Point Park
      [41.8430, -71.4380, 'Elmhurst'],    // Providence College
      [41.8000, -71.3650, null],          // the bay off Fields Point
    ];
    for (const [lat, lng, want] of points) {
      expect(hoodOfSync(nb, lat, lng)).toBe(want);
      expect(await neighborhoodAt(lat, lng)).toBe(want);
      expect(hoodOf(lat, lng)).toBe(want);
    }
    for (const n of NEIGHBORHOOD_NAMES) {
      expect(hoodSlug(n)).toBe(sharedHoodSlug(n));
      expect(ringBounds(nb[n])).toEqual(sharedRingBounds(nb[n]));
    }
  });
});

test('i18n parity: every street.*, my.cityFollowing.*, admin.email.kind.*, admin.engagement.*, week.*, track.near.*, watch.*, home.* and account.summary.* key exists in both languages', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (f: string) => JSON.parse(readFileSync(resolve(here, '../src/i18n', f), 'utf8')) as Record<string, string>;
  const en = read('strings.en.json'), es = read('strings.es.json');
  const ours = (k: string) => k.startsWith('street.') || k.startsWith('my.cityFollowing.') || k.startsWith('admin.email.kind.') || k.startsWith('admin.engagement.') || k.startsWith('admin.tab.engagement') || k.startsWith('admin.tabsub.engagement') || k.startsWith('week.') || k.startsWith('track.near.') || k.startsWith('watch.') || k.startsWith('home.') || k.startsWith('account.summary.');
  const enKeys = Object.keys(en).filter(ours);
  const esKeys = Object.keys(es).filter(ours);
  expect(enKeys.length).toBeGreaterThan(0);
  expect(enKeys.filter((k) => !(k in es))).toEqual([]);
  expect(esKeys.filter((k) => !(k in en))).toEqual([]);
  for (const k of enKeys) { expect(typeof en[k], k).toBe('string'); expect(es[k].length, k).toBeGreaterThan(0); }
  // The /street filters (components/StreetFilters.tsx): Show / When / Type, All, All types, Clear (visible) + its full
  // name, the Type dialog's Done and "+n", the custom range's group + From / To — translated (Spanish "Todas" for the
  // requests, "Todos los tipos" for the types).
  expect(enKeys.filter((k) => k.startsWith('street.filter.')).sort()).toEqual([
    'street.filter.all', 'street.filter.allTypes', 'street.filter.clear', 'street.filter.clearShort', 'street.filter.done', 'street.filter.from', 'street.filter.range',
    'street.filter.show', 'street.filter.to', 'street.filter.type', 'street.filter.typesMore', 'street.filter.when',
  ]);
  for (const k of ['street.filter.all', 'street.filter.allTypes', 'street.filter.clear', 'street.filter.clearShort', 'street.filter.done', 'street.filter.from', 'street.filter.range', 'street.filter.show', 'street.filter.to', 'street.filter.type', 'street.filter.when']) expect(es[k], k).not.toBe(en[k]);
  expect(es['street.filter.all']).toBe('Todas');
  // The windows: the When options, the summary's tail and the empty states' words — translated, placeholders agreeing.
  expect(enKeys.filter((k) => k.startsWith('street.days.')).sort()).toEqual(['street.days.1', 'street.days.30', 'street.days.7', 'street.days.90', 'street.days.custom']);
  for (const k of ['street.days.1', 'street.days.7', 'street.days.custom', 'street.window.day', 'street.window.days', 'street.when.day', 'street.when.days', 'street.when.range', 'street.when.date', 'street.summary.city', 'street.nothing', 'street.nothing.plain', 'street.none']) {
    expect(es[k], k).not.toBe(en[k]);
    expect((es[k].match(/\{[a-zA-Z]+\}/g) ?? []).sort(), k).toEqual((en[k].match(/\{[a-zA-Z]+\}/g) ?? []).sort());
  }
  for (const k of ['street.nothing', 'street.nothing.plain', 'street.none']) for (const d of [en, es]) expect(d[k], k).toContain('{when}');
  for (const d of [en, es]) expect(d['street.summary.city']).toContain('{window}');
  // Gone with the "Jump to a neighborhood…" select (Rob, 2026-10-27).
  for (const d of [en, es]) expect(d['street.hood.jump']).toBeUndefined();
  // The street-watch row's six keys plus the "Only tell me about" rail's four (components/WatchGroups.tsx), and the
  // Spanish is a translation, not the English copied over.
  expect(enKeys.filter((k) => k.startsWith('watch.')).sort()).toEqual(['watch.body', 'watch.error', 'watch.groups.all', 'watch.groups.error', 'watch.groups.hint', 'watch.groups.title', 'watch.needsPush', 'watch.noPushHere', 'watch.on', 'watch.title']);
  for (const k of ['watch.title', 'watch.body', 'watch.needsPush', 'watch.noPushHere', 'watch.on', 'watch.groups.title', 'watch.groups.all', 'watch.groups.hint']) expect(es[k], k).not.toBe(en[k]);
  // The home strip's four keys (components/HomeWeekStrip.tsx), translated, with the line's two placeholders in both.
  expect(enKeys.filter((k) => k.startsWith('home.week.')).sort()).toEqual(['home.week.line', 'home.week.map', 'home.week.quiet', 'home.week.week']);
  for (const k of ['home.week.line', 'home.week.quiet', 'home.week.map', 'home.week.week']) expect(es[k], k).not.toBe(en[k]);
  for (const d of [en, es]) { expect(d['home.week.line']).toContain('{total}'); expect(d['home.week.line']).toContain('{closed}'); }  // The Engagement tab (screens/AdminEngagement.tsx): the rail label + sub, seven tile labels, translated; the placeholders agree.
  expect(es['admin.tab.engagement']).toBe('Participación');
  for (const k of ['admin.tab.engagement', 'admin.tabsub.engagement', 'admin.engagement.what', 'admin.engagement.empty', 'admin.engagement.neverRan', 'admin.engagement.sum.week']) expect(es[k], k).not.toBe(en[k]);
  expect(enKeys.filter((k) => /^admin\.engagement\.tile\.[a-zA-Z]+$/.test(k) && !k.endsWith('What')).sort()).toEqual(['accounts', 'follows', 'groups', 'push', 'query', 'streetDigest', 'streetWatch', 'weekDigest'].map((k) => `admin.engagement.tile.${k}`)); // seven tiles + the query cross-check line
  const holes = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
  for (const k of enKeys.filter((k) => k.startsWith('admin.engagement.'))) expect(holes(es[k]), k).toEqual(holes(en[k]));
  // The Updates summary (lib/updatesSummary.ts): 21 keys, every one translated except the "+N" tail, the {link} slot and
  // {n} agree, and every sentence key keeps its {link} slot (the component splits on it).
  const sum = enKeys.filter((k) => k.startsWith('account.summary.'));
  expect(sum).toHaveLength(21);
  for (const k of sum) { expect(holes(es[k]), k).toEqual(holes(en[k])); if (k !== 'account.summary.groups.more') expect(es[k], k).not.toBe(en[k]); }
  for (const k of ['account.summary.reports', 'account.summary.street', 'account.summary.street.none', 'account.summary.week', 'account.summary.watch.here', 'account.summary.watch.other', 'account.summary.watch.other.one', 'account.summary.watch.none', 'account.summary.groups']) for (const d of [en, es]) expect(d[k].split('{link}'), k).toHaveLength(2);
  for (const k of ['account.summary.reports.link', 'account.summary.street.link', 'account.summary.watch.other']) for (const d of [en, es]) expect(d[k], k).toContain('{n}');
});

// ── likelyOwnCase: the report itself in the city's list (TrackNear drops it from "Near this request") ──
test('likelyOwnCase: same category + same day + (within OWN_CASE_M or the same street line) → the closest one; otherwise null', () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const base: MapCase = { id: 'x', caseType: 'Pothole', category: 'pothole', group: 'streets', status: 'Received', open: true, createdAt: iso(60_000), closedAt: null, street: '120 BENEFIT ST', resolution: null, lat: 41.8268, lng: -71.4053 };
  const report = { category: 'pothole', createdAt: iso(3_600_000), lat: 41.8268, lng: -71.4053, address: '120 Benefit St, Providence, RI' };
  expect(streetKey('120 Benefit St, Providence, RI')).toBe('120 benefit st');
  expect(streetKey(' 120  BENEFIT ST. ')).toBe('120 benefit st');
  // The city's geocode sits 20 m off the pin: the pin test catches it.
  const near = { ...base, id: 'near', lat: 41.82695, lng: -71.40545, street: 'BENEFIT ST' };
  expect(likelyOwnCase([near], report)).toBe('near');
  // 150 m off but the report's own street line: the street test catches it.
  const far = { ...base, id: 'far', lat: 41.828, lng: -71.4045 };
  expect(likelyOwnCase([far], report)).toBe('far');
  // 150 m off on another street → not ours.
  expect(likelyOwnCase([{ ...far, street: '30 MEETING ST' }], report)).toBeNull();
  // Another category, or filed three days earlier, is never ours even at 0 m.
  expect(likelyOwnCase([{ ...base, category: 'graffiti' }], report)).toBeNull();
  expect(likelyOwnCase([{ ...base, createdAt: iso(3 * 86_400_000) }], report)).toBeNull();
  // Two candidates: only the closest goes (a report is one case). The Worker's distanceM wins over the computed one.
  expect(likelyOwnCase([{ ...far, id: 'a' }, { ...near, id: 'b' }], report)).toBe('b');
  expect(likelyOwnCase([{ ...far, id: 'a', distanceM: 3 }, { ...near, id: 'b', distanceM: 20 }], report)).toBe('a');
  // No report date, or an unlocated case on another street: nothing to match on.
  expect(likelyOwnCase([near], { ...report, createdAt: null })).toBeNull();
  expect(likelyOwnCase([{ ...base, lat: null, lng: null, street: 'ELSEWHERE' }], report)).toBeNull();
  expect(likelyOwnCase([{ ...base, lat: null, lng: null }], report)).toBe('x'); // unlocated but our street line
  expect(OWN_CASE_M).toBe(60);
});

// ── placeActivity: "Your places this week" on the /street landing — 7-day counts within 300 m, from the loaded feed ──
test.describe('placeActivity', () => {
  const HOME = { lat: 41.8283, lng: -71.4006 }; // c1's spot: c1 (open, 3 d) and c3 (open, today) are new, c2 (closed yesterday) is a close

  test('created and closed within the window and the radius; unlocated and far cases never count', () => {
    // c4 has no coordinates; c5 is ≈ 800 m away (created 45 d ago, closed 2 d ago).
    expect(placeActivity(DECODED.cases, HOME, NOW)).toEqual({ created: 2, closed: 1 });
    expect(placeActivity(DECODED.cases, HOME, NOW, 1000)).toEqual({ created: 2, closed: 2 });
    expect(placeActivity(DECODED.cases, { lat: 41.9, lng: -71.5 }, NOW)).toEqual({ created: 0, closed: 0 });
    expect(placeActivity([], HOME, NOW)).toEqual({ created: 0, closed: 0 });
  });

  test('the window cuts by createdAt for "new" and by closedAt for "closed", independently', () => {
    expect(placeActivity(DECODED.cases, HOME, NOW, 300, 2)).toEqual({ created: 1, closed: 1 });   // c3 today; c2 closed yesterday
    expect(placeActivity(DECODED.cases, HOME, NOW, 300, 0.5)).toEqual({ created: 1, closed: 0 }); // c2's close is a full day old
    expect(placeActivity(DECODED.cases, HOME, NOW, 300, 30)).toEqual({ created: 3, closed: 1 });  // c2 created 9 d ago joins "new"
  });

  test('a case can be both new and closed; an open case with a closedAt is not a close; unparseable dates do not count', () => {
    const both = mkCase({ id: 'b', open: false, status: 'Resolved', createdAt: isoAgo(2), closedAt: isoAgo(1), lat: HOME.lat, lng: HOME.lng });
    expect(placeActivity([both], HOME, NOW)).toEqual({ created: 1, closed: 1 });
    const reopened = mkCase({ id: 'r', open: true, createdAt: isoAgo(20), closedAt: isoAgo(1), lat: HOME.lat, lng: HOME.lng });
    expect(placeActivity([reopened], HOME, NOW)).toEqual({ created: 0, closed: 0 });
    const undated = mkCase({ id: 'u', createdAt: null, closedAt: null, lat: HOME.lat, lng: HOME.lng });
    expect(placeActivity([undated], HOME, NOW)).toEqual({ created: 0, closed: 0 });
    expect(placeActivity([mkCase({ id: 'g', createdAt: 'garbage', lat: HOME.lat, lng: HOME.lng })], HOME, NOW)).toEqual({ created: 0, closed: 0 });
    // Exactly on the radius counts; one metre past it does not (≈ 300 m north of HOME is 0.0027° of latitude).
    const edge = (dLat: number) => placeActivity([mkCase({ id: 'e', lat: HOME.lat + dLat, lng: HOME.lng })], HOME, NOW).created;
    expect(edge(0.00269)).toBe(1);
    expect(edge(0.00272)).toBe(0);
  });
});

test('streetVisit: sinceCutoff needs a previous visit at least an hour old; isNewSince/newSince count createdAt strictly after it (closing is not new, an unparseable date never is); sinceWhen phrases; the nudge constants', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  expect(sinceCutoff(null, now)).toBeNull();
  expect(sinceCutoff(now - SINCE_MIN_MS + 1, now)).toBeNull();
  expect(sinceCutoff(now - SINCE_MIN_MS, now)).toBe(now - SINCE_MIN_MS);
  expect(sinceCutoff(now + 60_000, now)).toBeNull(); // a clock that went backwards: nothing to compare
  const iso = (ms: number) => new Date(ms).toISOString();
  const mk = (createdAt: string | null, closedAt: string | null = null): MapCase => ({ id: 'x', caseType: 'Pothole', category: 'pothole', group: 'streets', status: 'Submitted', open: true, createdAt, closedAt, street: '', resolution: null, lat: null, lng: null });
  const cut = now - 2 * DAY_MS;
  expect(isNewSince(mk(iso(cut + 1)), cut)).toBe(true);
  expect(isNewSince(mk(iso(cut)), cut)).toBe(false);
  expect(isNewSince({ ...mk(iso(cut - 1), iso(now)), open: false, status: 'Resolved' }, cut)).toBe(false); // closed since: not "new"
  expect(isNewSince(mk(null), cut)).toBe(false);
  expect(isNewSince(mk('garbage'), cut)).toBe(false);
  expect(isNewSince(mk(iso(now)), null)).toBe(false);
  expect(newSince([mk(iso(now)), mk(iso(cut - DAY_MS)), mk(iso(cut + 60_000)), mk(null)], cut)).toBe(2);
  expect(sinceWhen(now - 3 * 60 * 60_000, now)).toBe('today');
  expect(sinceWhen(now - DAY_MS, now)).toBe('yesterday');
  expect(sinceWhen(now - 2.5 * DAY_MS, now)).toEqual({ days: 2 });
  expect(sinceWhen(now - (WHILE_DAYS - 1) * DAY_MS, now)).toEqual({ days: WHILE_DAYS - 1 });
  expect(sinceWhen(now - WHILE_DAYS * DAY_MS, now)).toBe('while');
  expect(sinceWhen(now - 400 * DAY_MS, now)).toBe('while');
  expect(INSTALL_SNOOZE_MS).toBe(30 * DAY_MS);
  expect(INSTALL_FROM_VISIT).toBe(2);
});

test('streetVisit: newestCreated is the latest parseable createdAt; newCutoff is the newest case the visit saw, capped at the visit, the visit itself without one, null without a visit', () => {
  const mk = (createdAt: string | null) => ({ ...DECODED.cases[0], createdAt });
  expect(newestCreated([])).toBeNull();
  expect(newestCreated([mk(null), mk('nope')])).toBeNull();
  expect(newestCreated([mk('2026-10-20T10:00:00.000Z'), mk(null), mk('2026-10-21T09:00:00.000Z')])).toBe(Date.parse('2026-10-21T09:00:00.000Z'));
  expect(newCutoff(null, 5)).toBeNull();
  expect(newCutoff(1000, null)).toBe(1000);
  expect(newCutoff(1000, 400)).toBe(400);
  expect(newCutoff(1000, 4000)).toBe(1000); // a clock-skewed case newer than the visit never pushes the cutoff past it
});

test('decode: a case geocoded past the city margin is unplaced (the map cannot pan there); one just over the line is kept', () => {
  const feed: MapFeed = { ...FEED, items: [
    ['far', 0, 0, 29_000_000, 0, 41.70, -71.42, 'Warwick Ave', 0],
    ['edge', 0, 0, 29_000_000, 0, 41.874, -71.428, 'Florence St', 0],
  ] };
  const [far, edge] = decodeFeed(feed).cases;
  expect([far.lat, far.lng]).toEqual([null, null]);
  expect([edge.lat, edge.lng]).toEqual([41.874, -71.428]);
  expect(decodeCase({ id: 'x', lat: 42.0, lng: -71.4 }).lat).toBeNull();
});
