import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUP_ORDER } from '@shared/categories';
import { caseAge, caseTimeline, decodeCase, decodeCaseDetail, fullAddressLine, isNewCase, metersBetween, NEARBY_M, NEARBY_MAX, nearbyCases, NEW_CASE_MS, nyDaysBetween, type CaseDetail, type MapCase } from '../src/lib/streetMap';
import { caseMarker, casePinHtml, casePinKey, clusterMarker, glyphSvg, GROUP_GLYPHS, homeMarker, pinGroup } from '../src/lib/mapMarkers';

// Pure-module unit tests for the case page, the pin glyphs and the map key (2026-10-27): no browser, no page fixture.

const NOW = Date.parse('2026-10-27T17:00:00.000Z'); // 1 PM in Providence
const isoAgo = (days: number, extraMs = 0) => new Date(NOW - days * 86_400_000 + extraMs).toISOString();

function mkCase(o: Partial<MapCase> = {}): MapCase {
  return { id: 'c1', caseType: 'Pothole', category: 'pothole', group: 'streets', status: 'Assigned', open: true, createdAt: isoAgo(5), closedAt: null, street: '10 Angell St', resolution: null, lat: 41.82, lng: -71.41, ...o };
}
const TL = (o: Partial<CaseDetail['timeline']> = {}): CaseDetail['timeline'] => ({ reported: null, received: null, routed: null, workCompleted: null, resolved: null, ...o });
const detail = (o: Partial<CaseDetail> = {}): CaseDetail => ({ address: null, timeline: TL(), answers: [], statusHistory: [], ...o });

test.describe('decodeCaseDetail', () => {
  test('the worker\'s shape decodes as is', () => {
    const w = {
      address: '10 Example St, Providence, RI, 02908, USA',
      timeline: { reported: '2026-10-16T12:58:01.000Z', received: '2026-10-16T12:58:18.000Z', routed: '2026-10-16T12:58:33.000Z', workCompleted: null, resolved: '2026-10-22T14:45:00.000Z' },
      answers: [{ label: 'Type of Property', value: "Residential (someone else's property)" }, { label: 'Is Property Abandoned', value: 'Yes' }],
      statusHistory: [{ status: 'Submitted', at: '2026-10-16T13:00:00.000Z' }, { status: 'Resolved', at: '2026-10-22T15:00:00.000Z' }],
    };
    expect(decodeCaseDetail(w)).toEqual(w);
  });
  test('absent or not an object → null (the card shows its basic facts only)', () => {
    for (const w of [undefined, null, 'x', 3, [], true]) expect(decodeCaseDetail(w), String(w)).toBeNull();
  });
  test('defensive: bad dates → null, blank / non-string answers dropped (never "label: "), unknown keys ignored, strings trimmed', () => {
    const d = decodeCaseDetail({
      address: '  ', extra: 1,
      timeline: { reported: 'yesterday', received: 12, routed: '2026-10-16T12:58:33.000Z', workCompleted: '', resolved: null },
      answers: [{ label: 'A', value: '' }, { label: '', value: 'x' }, { label: 'B', value: true }, null, 'x', { label: ' C ', value: ' <b>v</b> ' }],
      statusHistory: [{ status: 'Assigned', at: 'nope' }, { status: '', at: '2026-10-16T12:58:33.000Z' }, { status: 'Assigned', at: '2026-10-17T10:00:00.000Z' }],
    })!;
    expect(d.address).toBeNull();
    expect(d.timeline).toEqual(TL({ routed: '2026-10-16T12:58:33.000Z' }));
    expect(d.answers).toEqual([{ label: 'C', value: '<b>v</b>' }]); // kept as text — the page renders it as a text node
    expect(d.statusHistory).toEqual([{ status: 'Assigned', at: '2026-10-17T10:00:00.000Z' }]);
  });
  test('a case body\'s `detail` rides along on decodeCase\'s wire type without changing the decoded case', () => {
    const w = { id: 'g1', caseType: 'Pothole', category: 'pothole', street: '1 A St', status: 'Assigned', createdAt: isoAgo(1), closedAt: null, resolution: null, lat: 41.82, lng: -71.41, detail: { address: 'x' } };
    expect(decodeCase(w)).not.toHaveProperty('detail');
    expect(decodeCaseDetail(w.detail)?.address).toBe('x');
  });
});

test.describe('caseTimeline', () => {
  test('lifecycle order, only the steps with a date; an open case never shows a close (a reopened case keeps its old resolution date)', () => {
    const d = detail({ timeline: TL({ reported: isoAgo(5), routed: isoAgo(4), workCompleted: isoAgo(1), resolved: isoAgo(1) }) });
    expect(caseTimeline(mkCase(), d).map((s) => s.step)).toEqual(['reported', 'routed', 'workCompleted']);
  });
  test('a closed case: the close step carries calendar days (Providence\'s) after it was reported; same date → 0', () => {
    const c = mkCase({ open: false, status: 'Resolved', createdAt: isoAgo(9), closedAt: isoAgo(1) });
    const steps = caseTimeline(c, detail({ timeline: TL({ reported: isoAgo(9), received: isoAgo(9, 60_000), resolved: isoAgo(1, -3_600_000) }) }));
    expect(steps.map((s) => s.step)).toEqual(['reported', 'received', 'resolved']);
    expect(steps[2].days).toBe(8); // Oct 18 1 PM → Oct 26 noon: 7 days 23 h, but 8 dates apart
    expect(steps.filter((s) => s.days != null)).toHaveLength(1);
    const same = caseTimeline(c, detail({ timeline: TL({ reported: isoAgo(2), resolved: isoAgo(2, 3_600_000) }) }));
    expect(same[1]).toMatchObject({ step: 'resolved', days: 0 });
    // Reported 8:30 PM Oct 16, closed 10 AM Oct 17 (13.5 h): the row shows Oct 17, so it is 1 day — never "the same day".
    const evening = caseTimeline(c, detail({ timeline: TL({ reported: '2026-10-17T00:30:00.000Z', resolved: '2026-10-17T14:00:00.000Z' }) }));
    expect(evening[1]).toMatchObject({ step: 'resolved', days: 1 });
  });
  test('reported falls back to the case\'s createdAt; unparseable dates are skipped', () => {
    const c = mkCase({ createdAt: isoAgo(3) });
    const steps = caseTimeline(c, detail({ timeline: TL({ received: 'not a date' as unknown as string, routed: isoAgo(2) }) }));
    expect(steps).toEqual([{ step: 'reported', at: isoAgo(3) }, { step: 'routed', at: isoAgo(2) }]);
  });
});

test.describe('fullAddressLine', () => {
  test('null when its first line is the street the card already shows (any case or punctuation); ", USA" dropped otherwise', () => {
    expect(fullAddressLine('10 Example St', '10 EXAMPLE ST, Providence, RI, 02908, USA')).toBeNull();
    expect(fullAddressLine('10 Example St', '10 Example St.')).toBeNull();
    expect(fullAddressLine('Example St', '12 Example St, Providence, RI, 02908, USA')).toBe('12 Example St, Providence, RI, 02908');
    expect(fullAddressLine('', '5 Elm St, Providence, RI')).toBe('5 Elm St, Providence, RI');
  });
  test('missing or blank → null', () => {
    for (const a of [null, undefined, '', '  ', ', USA']) expect(fullAddressLine('10 Example St', a), String(a)).toBeNull();
  });
});

test.describe('caseAge + isNewCase', () => {
  test('open: calendar days since reported; closed: calendar days from report to close; null without the dates', () => {
    expect(caseAge(mkCase({ createdAt: isoAgo(3, -60_000) }), NOW)).toEqual({ open: true, days: 3 });
    expect(caseAge(mkCase({ createdAt: '2026-10-27T03:30:00.000Z' }), NOW)).toEqual({ open: true, days: 1 }); // 11:30 PM yesterday
    expect(caseAge(mkCase({ createdAt: isoAgo(0, -60_000) }), NOW)).toEqual({ open: true, days: 0 });
    expect(caseAge(mkCase({ open: false, createdAt: isoAgo(9), closedAt: isoAgo(1) }), NOW)).toEqual({ open: false, days: 8 });
    expect(caseAge(mkCase({ open: false, createdAt: isoAgo(9), closedAt: null }), NOW)).toBeNull();
    expect(caseAge(mkCase({ createdAt: null }), NOW)).toBeNull();
    expect(caseAge(mkCase({ createdAt: isoAgo(-1) }), NOW)).toEqual({ open: true, days: 0 }); // a clock a little ahead: never negative
  });
  test('the day count matches the dates the card prints in Providence: evening → next morning is 1, morning → late evening is 0', () => {
    // 8:30 PM Oct 16 → 10 AM Oct 17 in New York: 13.5 h, but "Reported Oct 16 · closed after 1 day", not "the same day".
    expect(caseAge(mkCase({ open: false, createdAt: '2026-10-17T00:30:00.000Z', closedAt: '2026-10-17T14:00:00.000Z' }), NOW)).toEqual({ open: false, days: 1 });
    // 9 AM Oct 16 → 8 AM Oct 18: 47 h, two dates apart.
    expect(caseAge(mkCase({ open: false, createdAt: '2026-10-16T13:00:00.000Z', closedAt: '2026-10-18T12:00:00.000Z' }), NOW)).toEqual({ open: false, days: 2 });
    // 8 AM → 11 PM Oct 16 (03:00Z the next UTC day): the same New York date.
    expect(caseAge(mkCase({ open: false, createdAt: '2026-10-16T12:00:00.000Z', closedAt: '2026-10-17T03:00:00.000Z' }), NOW)).toEqual({ open: false, days: 0 });
    // Across the clock change (Nov 1, 2026): still whole dates.
    expect(nyDaysBetween(Date.parse('2026-10-31T12:00:00.000Z'), Date.parse('2026-11-02T12:00:00.000Z'))).toBe(2);
    expect(nyDaysBetween(Date.parse('2026-11-02T12:00:00.000Z'), Date.parse('2026-10-31T12:00:00.000Z'))).toBe(0);
  });
  test('new = open and reported within the last 48 h', () => {
    expect(NEW_CASE_MS).toBe(48 * 3_600_000);
    expect(isNewCase(mkCase({ createdAt: isoAgo(0) }), NOW)).toBe(true);
    expect(isNewCase(mkCase({ createdAt: isoAgo(2) }), NOW)).toBe(true);
    expect(isNewCase(mkCase({ createdAt: isoAgo(2, -60_000) }), NOW)).toBe(false);
    expect(isNewCase(mkCase({ createdAt: isoAgo(0), open: false }), NOW)).toBe(false);
    expect(isNewCase(mkCase({ createdAt: null }), NOW)).toBe(false);
  });
});

test.describe('nearbyCases (the case page\'s Nearby)', () => {
  /** A case `m` metres north of 41.82, -71.41 (1° of latitude ≈ 111,195 m on the haversine sphere). */
  const north = (id: string, m: number, o: Partial<MapCase> = {}) => mkCase({ id, lat: 41.82 + m / 111_195, lng: -71.41, ...o });
  test('150 m and five by default: the others within the radius (inclusive), nearest first, each with its rounded distance from the case', () => {
    expect(NEARBY_M).toBe(150);
    expect(NEARBY_MAX).toBe(5);
    const me = north('me', 0);
    const got = nearbyCases([north('far', 151), north('b', 80), me, north('a', 12.4), north('edge', 149.6)], me);
    expect(got.map((x) => [x.c.id, x.m])).toEqual([['a', 12], ['b', 80], ['edge', 150]]);
    expect(Math.abs(metersBetween(41.82, -71.41, got[2].c.lat!, got[2].c.lng!) - 149.6)).toBeLessThan(0.01);
  });
  test('never the case itself or an unlocated case; at most `limit`, and ties (a stack at one spot) newest activity first', () => {
    const me = north('me', 0);
    const stack = Array.from({ length: 8 }, (_, i) => north(`s${i}`, 30, { createdAt: isoAgo(i + 1) }));
    const got = nearbyCases([me, north('me', 0), mkCase({ id: 'u', lat: null, lng: null }), ...stack.slice().reverse()], me);
    expect(got.map((x) => x.c.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(got.every((x) => x.m === 30)).toBe(true);
    expect(nearbyCases(stack, me, 150, 2).map((x) => x.c.id)).toEqual(['s0', 's1']);
    expect(nearbyCases(stack, me, 20)).toEqual([]);
  });
  test('an unlocated case has no neighbours', () => {
    expect(nearbyCases([north('a', 5)], mkCase({ id: 'x', lat: null, lng: null }))).toEqual([]);
  });
});

test.describe('pin markup (lib/mapMarkers)', () => {
  test('every picker group has its own glyph, path-only, white, in the head of the pin', () => {
    expect(Object.keys(GROUP_GLYPHS).sort()).toEqual([...GROUP_ORDER].sort());
    const sigs = GROUP_ORDER.map((g) => JSON.stringify(GROUP_GLYPHS[g]));
    expect(new Set(sigs).size).toBe(GROUP_ORDER.length);
    for (const g of GROUP_ORDER) {
      const svg = glyphSvg(g);
      expect(svg, g).toMatch(/^<g class="map-pin-glyph" transform="translate\(6 4\.2\)" style="[^"]*stroke:#fff/);
      expect(svg.replace(/<\/?g\b[^>]*>|<path\b[^>]*\/>/g, ''), g).toBe(''); // nothing but <path>s inside the group
    }
  });
  test('an unknown group draws "other"; the pin carries data-group and the glyph after the two-ink teardrop', () => {
    expect(pinGroup('zzz')).toBe('other');
    expect(pinGroup(null)).toBe('other');
    expect(glyphSvg('zzz')).toBe(glyphSvg('other'));
    const html = casePinHtml('water', true);
    expect(html).toContain('data-group="water"');
    expect(html.indexOf('map-pin-glyph')).toBeGreaterThan(html.lastIndexOf('fill:var(--ember)'));
    expect(casePinHtml('water', false)).toContain('fill:var(--muted)');
  });
  test('the halo span is drawn only for a new open case; the footprint is the old one (26×32 open, 22×27 closed)', () => {
    expect(casePinHtml('trash', true, true)).toContain('map-pin-halo');
    expect(casePinHtml('trash', true, false)).not.toContain('map-pin-halo');
    expect(casePinHtml('trash', false, true)).not.toContain('map-pin-halo');
    expect(caseMarker('trash', true)).toMatchObject({ className: 'map-pin map-case', size: [26, 32], anchor: [13, 31] });
    expect(caseMarker('trash', false, true)).toMatchObject({ className: 'map-pin map-case map-pin--closed', size: [22, 27], anchor: [11, 26] });
    expect(caseMarker('trash', true, true).className).toBe('map-pin map-case map-case--new');
  });
  test('one icon per (group, open, new): the cache key ignores "new" on a closed pin, so 10 groups give 30 icons at most', () => {
    const keys = new Set<string>();
    for (const g of [...GROUP_ORDER, 'zzz']) for (const open of [true, false]) for (const isNew of [true, false]) keys.add(casePinKey(g, open, isNew));
    expect(keys.size).toBe(30);
    expect(casePinKey('trash', false, true)).toBe(casePinKey('trash', false, false));
    expect(casePinKey('zzz', true)).toBe(casePinKey('other', true));
  });
  test('cluster and home markers keep their classes and boxes', () => {
    expect(clusterMarker(8, 0.625)).toMatchObject({ className: 'map-cluster map-cluster--s', size: [52, 52], anchor: [26, 26] });
    expect(clusterMarker(8, 0.625).html).toContain('--share:225deg');
    expect(clusterMarker(120, 0).className).toBe('map-cluster map-cluster--l');
    expect(homeMarker()).toMatchObject({ className: 'map-pin map-home', size: [32, 40], anchor: [16, 38] });
  });
});

test('i18n: the case page\'s and the map key\'s strings are translated, with the same placeholders, singulars included', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (f: string) => JSON.parse(readFileSync(resolve(here, '../src/i18n', f), 'utf8')) as Record<string, string>;
  const en = read('strings.en.json'), es = read('strings.es.json');
  const keys = Object.keys(en).filter((k) => k.startsWith('street.case.') || k.startsWith('street.key'));
  expect(keys.length).toBe(39);
  const holes = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
  for (const k of keys) {
    expect(es[k], k).toBeTruthy();
    expect(es[k], k).not.toBe(en[k]);
    expect(holes(es[k]), k).toEqual(holes(en[k]));
  }
  for (const k of ['open', 'closed', 'cluster', 'stack', 'type', 'new', 'home', 'ring']) expect(en[`street.key.${k}`], k).toBeTruthy();
  for (const k of ['reported', 'received', 'routed', 'workCompleted', 'resolved']) expect(en[`street.case.step.${k}`], k).toBeTruthy();
  // The case page: top bar, stat row (singular included), tiles, sections; the Follow toggle's short label and its line.
  for (const k of ['back', 'map', 'stat.open', 'stat.closed', 'stat.closedAfter', 'stat.days', 'stat.days.one', 'stat.today', 'stat.sameDay', 'stat.reported', 'stat.from', 'stat.hood', 'tile.group', 'tile.status', 'note', 'nearby', 'nearby.hint', 'nearby.none']) expect(en[`street.case.${k}`], k).toBeTruthy();
  for (const k of ['street.follow.short', 'street.follow.mails', 'street.meters']) { expect(en[k], k).toBeTruthy(); expect(es[k], k).toBeTruthy(); }
  expect(es['street.follow.short']).toBe('Seguir');
  // Gone with the in-sheet case card.
  for (const k of ['street.detail.back', 'street.case.address', 'street.case.reportedOn', 'street.case.openDays', 'street.follow.on', 'street.follow.off']) { expect(en[k], k).toBeUndefined(); expect(es[k], k).toBeUndefined(); }
});
