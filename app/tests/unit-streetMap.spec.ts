import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ago, applyFilters, boundsOf, CITY_BOUNDS, clusterGrid, decodeCase, decodeFeed, distanceM, EMPTY_URL_STATE, facetCounts, hoodCounts,
  inBounds, inWindow, isDefaultView, metersBetween, padBounds, parseStreetUrl, sortForPoint, stackKey, summaryOf, topTypes,
  writeStreetUrl, type MapCase, type MapFeed, type StreetUrlState,
} from '../src/lib/streetMap';
import { hoodFromSlug, hoodOfSync, hoodSlug, loadNeighborhoods, NEIGHBORHOOD_NAMES, ringBounds } from '../src/lib/neighborhoods';

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
  test('inWindow cuts "this week" client-side; closing counts as activity', () => {
    expect(inWindow(byId('c1'), 7, NOW)).toBe(true);
    expect(inWindow(byId('c4'), 7, NOW)).toBe(false);   // created 20 d, closed 12 d ago
    expect(inWindow(byId('c4'), 30, NOW)).toBe(true);
    expect(inWindow(byId('c5'), 7, NOW)).toBe(true);    // created 45 d ago but closed 2 d ago
    expect(inWindow(mkCase({ id: 'nodate', createdAt: null }), 7, NOW)).toBe(true); // unparseable → kept
  });

  test('applyFilters: window, status, group; order preserved', () => {
    const f = (g: 'streets' | 'lights' | null, s: 'open' | 'closed' | null, d: 7 | 30 | 90) => applyFilters(DECODED.cases, { g, s, d }, NOW).map((c) => c.id);
    expect(f(null, null, 30)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(f(null, null, 7)).toEqual(['c1', 'c2', 'c3', 'c5']);
    expect(f(null, 'open', 30)).toEqual(['c1', 'c3']);
    expect(f(null, 'closed', 7)).toEqual(['c2', 'c5']);
    expect(f('streets', null, 30)).toEqual(['c1', 'c5']);
    expect(f('lights', 'open', 30)).toEqual([]);
  });

  test('facetCounts releases each chip\'s own dimension', () => {
    const all = facetCounts(DECODED.cases, null, { g: null, s: null, d: 30 }, NOW);
    expect(all).toMatchObject({ open: 2, closed: 3, all: 5, total: 5 });
    expect(all.groups).toMatchObject({ streets: 2, lights: 1, other: 2, trash: 0 });
    // s=open: the Closed chip still counts the closed cases (status released); groups honour the status filter
    const open = facetCounts(DECODED.cases, null, { g: null, s: 'open', d: 30 }, NOW);
    expect(open).toMatchObject({ open: 2, closed: 3, all: 2, total: 2 });
    expect(open.groups).toMatchObject({ streets: 1, other: 1, lights: 0 });
    // g=lights: open/closed count only lights, All counts everything (group released)
    const lights = facetCounts(DECODED.cases, null, { g: 'lights', s: null, d: 30 }, NOW);
    expect(lights).toMatchObject({ open: 0, closed: 1, all: 5, total: 1 });
    // a window applies to every count
    expect(facetCounts(DECODED.cases, null, { g: null, s: null, d: 7 }, NOW)).toMatchObject({ all: 4, total: 4, closed: 2 });
    // bounds: the unlocated c4 never counts; c5 is outside this tight box
    const box = { south: 41.828, north: 41.8285, west: -71.401, east: -71.400 };
    expect(facetCounts(DECODED.cases, box, { g: null, s: null, d: 30 }, NOW)).toMatchObject({ open: 2, closed: 1, all: 3, total: 3 });
  });

  test('summaryOf: city mode counts the unplaced, view mode counts the box', () => {
    expect(summaryOf(DECODED.cases, null, 30)).toEqual({ kind: 'city', total: 5, open: 2, closed: 3, located: 4, unplaced: 1, days: 30 });
    expect(summaryOf(DECODED.cases, { south: 41.828, north: 41.8285, west: -71.401, east: -71.400 }, 30)).toEqual({ kind: 'view', n: 3, open: 2, closed: 1 });
  });

  test('topTypes and hoodCounts', () => {
    expect(topTypes(DECODED.cases, 2)).toEqual([{ caseType: 'Pothole', category: 'pothole', group: 'streets', n: 2 }, { caseType: 'Street Light Out', category: 'street_light', group: 'lights', n: 1 }]);
    const hc = hoodCounts(DECODED.cases, (c) => (c.id === 'c5' ? 'Hope' : c.lat != null ? 'College Hill' : null), ['Fox Point', 'Hope', 'College Hill']);
    expect(hc).toEqual([{ name: 'College Hill', n: 3 }, { name: 'Hope', n: 1 }, { name: 'Fox Point', n: 0 }]);
    expect(hoodCounts([], () => null)).toHaveLength(25); // all 25 by default, zeros kept
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

test.describe('url state', () => {
  test('writeStreetUrl omits defaults; parse(write(state)) round-trips', () => {
    expect(writeStreetUrl(EMPTY_URL_STATE).toString()).toBe('');
    expect(writeStreetUrl({ d: 30, s: null, g: null }).toString()).toBe('');
    const full: StreetUrlState = { lat: 41.8282, lng: -71.4005, q: '481 Angell St', center: { lat: 41.82834, lng: -71.40061 }, zoom: 17, hood: 'Upper South Providence', g: 'streets', s: 'open', d: 90, caseId: 'c1' };
    const p = writeStreetUrl(full);
    expect(p.toString()).toBe('lat=41.82820&lng=-71.40050&q=481+Angell+St&c=41.8283%2C-71.4006&z=17&n=upper-south-providence&g=streets&s=open&d=90&case=c1');
    expect(parseStreetUrl(p)).toEqual({ ...full, center: { lat: 41.8283, lng: -71.4006 } });
    // the digest email's link, unchanged contract
    expect(parseStreetUrl(new URLSearchParams('lat=41.82820&lng=-71.40050&q=481%20Angell%20St'))).toEqual({ ...EMPTY_URL_STATE, lat: 41.8282, lng: -71.4005, q: '481 Angell St' });
    expect(writeStreetUrl({ lat: 41.8282, lng: -71.4005, q: '481 Angell St' }).toString()).toBe('lat=41.82820&lng=-71.40050&q=481+Angell+St');
    expect(writeStreetUrl({ d: 7 }).toString()).toBe('d=7');
    expect(writeStreetUrl({ s: 'closed', g: 'trash' }).toString()).toBe('g=trash&s=closed');
  });

  test('parseStreetUrl drops unknown or malformed values', () => {
    const st = parseStreetUrl(new URLSearchParams('lat=abc&lng=-71.4&q=x&c=41.8&z=16&n=narnia&g=nope&s=maybe&d=15&case='));
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
  test('NEIGHBORHOOD_NAMES matches the data module; slugs round-trip', async () => {
    const nb = await loadNeighborhoods();
    expect(Object.keys(nb)).toEqual([...NEIGHBORHOOD_NAMES]);
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
});

test('i18n parity: every street.*, my.cityFollowing.* and admin.email.kind.* key exists in both languages', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (f: string) => JSON.parse(readFileSync(resolve(here, '../src/i18n', f), 'utf8')) as Record<string, string>;
  const en = read('strings.en.json'), es = read('strings.es.json');
  const ours = (k: string) => k.startsWith('street.') || k.startsWith('my.cityFollowing.') || k.startsWith('admin.email.kind.');
  const enKeys = Object.keys(en).filter(ours);
  const esKeys = Object.keys(es).filter(ours);
  expect(enKeys.length).toBeGreaterThan(0);
  expect(enKeys.filter((k) => !(k in es))).toEqual([]);
  expect(esKeys.filter((k) => !(k in en))).toEqual([]);
  for (const k of enKeys) { expect(typeof en[k], k).toBe('string'); expect(es[k].length, k).toBeGreaterThan(0); }
});
