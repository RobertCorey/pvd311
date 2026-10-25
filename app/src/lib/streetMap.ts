/** Pure helpers for the map-first /street page (spec: .claude/street-map-spec.md, 2026-10-25).
 *  One GET /api/street/map load → every count, filter, bbox, cluster, distance and URL here is computed in the
 *  browser from that array. No React, no Leaflet: `clusterGrid` takes a `project(lat, lng) → {x, y}` so MapView passes
 *  `map.project(...)` and the unit spec passes a linear scale. The wire types mirror worker/src/street.ts (MapFeed). */
import { GROUP_ORDER } from '@shared/categories';
import { groupOf, type GroupKey } from './categories';
import { PVD_BOUNDS } from './geo';
import { hoodFromSlug, hoodSlug, NEIGHBORHOOD_NAMES } from './neighborhoods';

/* ── Wire format (GET /api/street/map) ─────────────────────────────────────────────────────────── */

/** One case as transmitted: [id, t, s, createdMin, closedMin, lat, lng, street, res]. */
export type MapItem = [
  id: string, t: number, s: number, createdMin: number, closedMin: number,
  lat: number | null, lng: number | null, street: string, res: string | 0,
];
export interface MapFeed {
  v: 1; days: number; at: string; total: number; located: number; truncated: boolean;
  /** index = t → [city caseType, category key] */
  types: [string, string][];
  /** index = s */
  statuses: string[];
  items: MapItem[];
}

/** One decoded case — what every component on the page reads. */
export interface MapCase {
  id: string; caseType: string; category: string; group: GroupKey | 'other'; status: string; open: boolean;
  createdAt: string | null; closedAt: string | null; street: string; resolution: string | null;
  lat: number | null; lng: number | null;
}
export interface StreetMap { days: number; at: string; total: number; located: number; truncated: boolean; cases: MapCase[] }

/** A status in this set is "closed"; everything else (including unknown strings) is open. Same set as the worker. */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(['Resolved', 'Closed', 'Cancelled', 'Merged']);

const minToIso = (min: number): string | null => (Number.isFinite(min) && min > 0 ? new Date(min * 60_000).toISOString() : null);

/** Tuples → cases: minutes → ISO, `res || null`, open from CLOSED_STATUSES, `group = groupOf(category) ?? 'other'`.
 *  A bad type/status index degrades to '' rather than throwing (one odd row must not blank the page). Array order kept. */
export function decodeFeed(feed: MapFeed): StreetMap {
  const types = feed.types ?? [], statuses = feed.statuses ?? [];
  const cases: MapCase[] = (feed.items ?? []).map(([id, t, s, createdMin, closedMin, lat, lng, street, res]) => {
    const [caseType, category] = types[t] ?? ['', 'unsure'];
    const status = statuses[s] ?? '';
    const located = typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
    return {
      id: String(id), caseType, category, group: groupOf(category) ?? 'other', status, open: !CLOSED_STATUSES.has(status),
      createdAt: minToIso(createdMin), closedAt: minToIso(closedMin), street: street || '',
      resolution: typeof res === 'string' && res ? res : null, lat: located ? lat : null, lng: located ? lng : null,
    };
  });
  return { days: feed.days, at: feed.at, total: feed.total, located: feed.located, truncated: !!feed.truncated, cases };
}

/** GET /api/street/case/:guid — one case as an object (worker/src/street.ts StreetCaseView; the /my list's row shape). */
export interface StreetCaseWire {
  id: string; caseType: string; category: string; street: string; status: string; open?: boolean;
  createdAt: string | null; closedAt: string | null; resolution: string | null; lat: number | null; lng: number | null; updatedAt?: string | null;
}

/** A single-case response → MapCase, with the same defaults as decodeFeed (`open` from the status, '' for blanks). */
export function decodeCase(w: Partial<StreetCaseWire>): MapCase {
  const status = typeof w.status === 'string' ? w.status : '';
  const category = typeof w.category === 'string' && w.category ? w.category : 'unsure';
  const located = typeof w.lat === 'number' && typeof w.lng === 'number' && Number.isFinite(w.lat) && Number.isFinite(w.lng);
  return {
    id: String(w.id ?? ''), caseType: typeof w.caseType === 'string' ? w.caseType : '', category, group: groupOf(category) ?? 'other', status, open: !CLOSED_STATUSES.has(status),
    createdAt: typeof w.createdAt === 'string' ? w.createdAt : null, closedAt: typeof w.closedAt === 'string' ? w.closedAt : null,
    street: typeof w.street === 'string' ? w.street : '', resolution: typeof w.resolution === 'string' && w.resolution ? w.resolution : null,
    lat: located ? (w.lat as number) : null, lng: located ? (w.lng as number) : null,
  };
}

/* ── Geometry ──────────────────────────────────────────────────────────────────────────────────── */

export interface LatLng { lat: number; lng: number }
export interface Bounds { south: number; west: number; north: number; east: number }

export const CITY_BOUNDS: Bounds = { south: PVD_BOUNDS.minLat, west: PVD_BOUNDS.minLng, north: PVD_BOUNDS.maxLat, east: PVD_BOUNDS.maxLng };

/** Great-circle distance in metres (haversine). */
export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000; const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat); const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Rounded metres from a point to a located case; null for an unlocated one. */
export function distanceM(c: MapCase, p: LatLng): number | null {
  return c.lat == null || c.lng == null ? null : Math.round(metersBetween(p.lat, p.lng, c.lat, c.lng));
}

/** Located and inside the box (inclusive). Unlocated cases are never in any bounds. */
export function inBounds(c: MapCase, b: Bounds): boolean {
  return c.lat != null && c.lng != null && c.lat >= b.south && c.lat <= b.north && c.lng >= b.west && c.lng <= b.east;
}

/** Grow a box by a fraction of its size on every side (Leaflet's `pad`, without Leaflet). */
export function padBounds(b: Bounds, frac: number): Bounds {
  const dLat = (b.north - b.south) * frac, dLng = (b.east - b.west) * frac;
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLng, east: b.east + dLng };
}

/** Bounding box of the located cases (or any lat/lng list); null when none has coordinates. */
export function boundsOf(points: { lat: number | null; lng: number | null }[]): Bounds | null {
  let b: Bounds | null = null;
  for (const p of points) {
    if (p.lat == null || p.lng == null) continue;
    if (!b) b = { south: p.lat, north: p.lat, west: p.lng, east: p.lng };
    else { if (p.lat < b.south) b.south = p.lat; if (p.lat > b.north) b.north = p.lat; if (p.lng < b.west) b.west = p.lng; if (p.lng > b.east) b.east = p.lng; }
  }
  return b;
}

/* ── Filters ───────────────────────────────────────────────────────────────────────────────────── */

export type Window = 7 | 30 | 90;
export interface Filters { g: GroupKey | 'other' | null; s: 'open' | 'closed' | null; d: Window }
export const DEFAULT_FILTERS: Filters = { g: null, s: null, d: 30 };
export const DAY_MS = 86_400_000;

const parseMs = (iso: string | null): number | null => { if (!iso) return null; const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** Newest of created / closed, in ms; null when neither parses (the server already vouched for the row). */
export function activityMs(c: MapCase): number | null {
  const a = parseMs(c.createdAt), b = parseMs(c.closedAt);
  return a == null ? b : b == null ? a : Math.max(a, b);
}

/** Activity within the last `d` days. "This week" is cut client-side from the 30-day load, so this runs on every
 *  render; a case without any parseable date stays in (the worker included it for a reason). */
export function inWindow(c: MapCase, d: Window, nowMs: number): boolean {
  const t = activityMs(c);
  return t == null || t >= nowMs - d * DAY_MS;
}

const matchStatus = (c: MapCase, s: Filters['s']) => s == null || (s === 'open' ? c.open : !c.open);
const matchGroup = (c: MapCase, g: Filters['g']) => g == null || c.group === g;

/** Window + status + group, keeping the feed's newest-activity-first order. */
export function applyFilters(cases: MapCase[], f: Filters, nowMs: number): MapCase[] {
  return cases.filter((c) => inWindow(c, f.d, nowMs) && matchStatus(c, f.s) && matchGroup(c, f.g));
}

export interface FacetCounts {
  /** Open / closed in view with the status dimension released (group + window applied). */
  open: number; closed: number;
  /** The "All" chip: group released, status + window applied. */
  all: number;
  /** Per group, status + window applied — zero-count groups are present (chips stay enabled). */
  groups: Record<GroupKey, number>;
  /** Every filter applied: what the view actually shows. */
  total: number;
}

/** "What you would get" counts over the visible band (`viewBounds`; null = the whole set, unlocated included), each
 *  chip's own dimension released and the other filters applied — so a chip never reads 0 when tapping it would show something. */
export function facetCounts(cases: MapCase[], viewBounds: Bounds | null, f: Filters, nowMs: number): FacetCounts {
  const groups = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<GroupKey, number>;
  let open = 0, closed = 0, all = 0, total = 0;
  for (const c of cases) {
    if (!inWindow(c, f.d, nowMs)) continue;
    if (viewBounds && !inBounds(c, viewBounds)) continue;
    const okS = matchStatus(c, f.s), okG = matchGroup(c, f.g);
    if (okG) { if (c.open) open++; else closed++; }
    if (okS) { all++; groups[c.group as GroupKey] = (groups[c.group as GroupKey] ?? 0) + 1; }
    if (okS && okG) total++;
  }
  return { open, closed, all, groups, total };
}

/* ── Summary line, top types, neighborhood counts ──────────────────────────────────────────────── */

export type Summary =
  | { kind: 'city'; total: number; open: number; closed: number; located: number; unplaced: number; days: Window }
  | { kind: 'view'; n: number; open: number; closed: number };

/** Inputs for the subtitle. `view` null → t('street.summary.city') over the whole filtered set (unlocated included)
 *  with `unplaced` for t('street.unplaced'); a box → t('street.summary.view') over the cases inside it. */
export function summaryOf(filtered: MapCase[], view: Bounds | null, days: Window): Summary {
  let open = 0, closed = 0, located = 0, n = 0;
  for (const c of filtered) {
    if (view && !inBounds(c, view)) continue;
    n++; if (c.open) open++; else closed++;
    if (c.lat != null && c.lng != null) located++;
  }
  return view ? { kind: 'view', n, open, closed } : { kind: 'city', total: n, open, closed, located, unplaced: n - located, days };
}

export interface TypeCount { caseType: string; category: string; group: GroupKey | 'other'; n: number }

/** The busiest city case types (ties: first seen in the feed wins — the feed is newest first). */
export function topTypes(cases: MapCase[], limit = 3): TypeCount[] {
  const m = new Map<string, TypeCount>();
  for (const c of cases) {
    const key = c.caseType || c.category;
    const e = m.get(key);
    if (e) e.n++; else m.set(key, { caseType: c.caseType, category: c.category, group: c.group, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n).slice(0, limit);
}

export interface HoodCount { name: string; n: number }

/** Cases per neighborhood over `names` (all 25 by default, zeros kept), count desc then name. `hoodOf` is the caller's
 *  memoised lookup (id → name), built once per feed with hoodOfSync. */
export function hoodCounts(cases: MapCase[], hoodOf: (c: MapCase) => string | null | undefined, names: readonly string[] = NEIGHBORHOOD_NAMES): HoodCount[] {
  const m = new Map<string, number>(names.map((n) => [n, 0]));
  for (const c of cases) { const h = hoodOf(c); if (h && m.has(h)) m.set(h, (m.get(h) ?? 0) + 1); }
  return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/* ── Sorting ───────────────────────────────────────────────────────────────────────────────────── */

/** With a point set: open first, then nearest; unlocated cases last in each half. Stable, returns a new array. */
export function sortForPoint(cases: MapCase[], p: LatLng): MapCase[] {
  const dist = new Map<string, number>();
  for (const c of cases) dist.set(c.id, c.lat == null || c.lng == null ? Infinity : metersBetween(p.lat, p.lng, c.lat, c.lng));
  return [...cases].sort((a, b) => Number(b.open) - Number(a.open) || (dist.get(a.id) ?? Infinity) - (dist.get(b.id) ?? Infinity));
}

/** Newest activity first (the feed order; use after a sort by distance is undone). */
export function sortByActivity(cases: MapCase[]): MapCase[] {
  return [...cases].sort((a, b) => (activityMs(b) ?? 0) - (activityMs(a) ?? 0));
}

/* ── Clustering ────────────────────────────────────────────────────────────────────────────────── */

export interface ClusterPoint { id: string; lat: number; lng: number; open: boolean }
export interface Cluster {
  /** Stable within a frame; stacks keep `s:<lat>,<lng>` across zooms, grid cells are `g<zoom>:<cell>:<cx>,<cy>`. MapView prefixes `k:`. */
  key: string; lat: number; lng: number; n: number; open: number; ids: string[];
  /** Every member shares one 5-dp coordinate — one cluster at every zoom, never split by zooming. */
  stack: boolean;
}
export interface ClusterResult {
  clusters: Cluster[];
  /** Case ids drawn as their own pin. */
  singles: string[];
  /** The cell size actually used (56, or grown 1.5× up to 3 times by the adaptive cap). */
  cell: number;
  /** True when grid clustering ran (zoom < 15, or dense at 15–17); false when only stacks clustered — the caller feeds
   *  `!clustered` back as `forcePins` on the next filter change (hysteresis). */
  clustered: boolean;
}
export interface ClusterOpts {
  /** Grid cell in CSS px (56). */
  cell?: number;
  /** Max singletons before the cell grows (250). Also the density threshold under hysteresis. */
  cap?: number;
  /** Points in drawBounds above which 15–17 cluster anyway (200). */
  dense?: number;
  /** Hysteresis: pins are showing at this zoom, so re-cluster only above `cap` (250) rather than `dense` (200). */
  forcePins?: boolean;
}

/** Same spot to 5 dp (≈1 m): street-only addresses geocode to one centroid, so these must stay one marker. */
export const stackKey = (lat: number, lng: number): string => `${lat.toFixed(5)},${lng.toFixed(5)}`;

/** Grid clustering over the filtered located cases inside drawBounds. Rule: cluster when zoom < 15, or when the
 *  draw set is dense (> 200 points, > 250 once pins are showing) up to zoom 17; at zoom ≥ 18 only stacks cluster.
 *  Groups by 5-dp stack key first, buckets groups by floor(px/cell); a bucket with ≥ 2 points is a cluster at the
 *  members' mean, with 1 point a pin. Adaptive cap: > 250 singletons → cell × 1.5 and rebucket, at most 3 times. */
export function clusterGrid(points: ClusterPoint[], project: (lat: number, lng: number) => { x: number; y: number }, zoom: number, opts: ClusterOpts = {}): ClusterResult {
  const cell0 = opts.cell ?? 56, cap = opts.cap ?? 250, dense = opts.dense ?? 200;
  if (points.length === 0) return { clusters: [], singles: [], cell: cell0, clustered: false };

  // 1) stacks: identical 5-dp coordinates are one unit at every zoom
  const groups = new Map<string, ClusterPoint[]>();
  for (const p of points) { const k = stackKey(p.lat, p.lng); const g = groups.get(k); if (g) g.push(p); else groups.set(k, [p]); }
  const units = [...groups.entries()];

  const mk = (key: string, members: ClusterPoint[], stack: boolean): Cluster => {
    let lat = 0, lng = 0, open = 0;
    for (const m of members) { lat += m.lat; lng += m.lng; if (m.open) open++; }
    // a stack sits exactly on its shared coordinate (a float mean of equal values can drift by 1e-14)
    const at = stack ? members[0] : { lat: lat / members.length, lng: lng / members.length };
    return { key, lat: at.lat, lng: at.lng, n: members.length, open, ids: members.map((m) => m.id), stack };
  };

  const threshold = opts.forcePins ? cap : dense;
  const clustered = zoom < 15 || (zoom < 18 && points.length > threshold);
  if (!clustered) {
    const clusters: Cluster[] = [], singles: string[] = [];
    for (const [k, g] of units) { if (g.length > 1) clusters.push(mk(`s:${k}`, g, true)); else singles.push(g[0].id); }
    return { clusters, singles, cell: cell0, clustered: false };
  }

  // 2) grid: bucket each unit by its projected pixel; grow the cell while too many singletons remain
  const projected = units.map(([k, g]) => ({ k, g, ...project(g[0].lat, g[0].lng) }));
  let cell = cell0;
  for (let attempt = 0; ; attempt++) {
    const buckets = new Map<string, { cx: number; cy: number; units: typeof projected }>();
    for (const u of projected) {
      const cx = Math.floor(u.x / cell), cy = Math.floor(u.y / cell), bk = `${cx},${cy}`;
      const b = buckets.get(bk); if (b) b.units.push(u); else buckets.set(bk, { cx, cy, units: [u] });
    }
    const clusters: Cluster[] = [], singles: string[] = [];
    for (const b of buckets.values()) {
      if (b.units.length === 1) {
        const [u] = b.units;
        if (u.g.length > 1) clusters.push(mk(`s:${u.k}`, u.g, true)); else singles.push(u.g[0].id);
      } else {
        clusters.push(mk(`g${zoom}:${cell}:${b.cx},${b.cy}`, b.units.flatMap((u) => u.g), false));
      }
    }
    if (singles.length <= cap || attempt >= 3) return { clusters, singles, cell, clustered: true };
    cell *= 1.5;
  }
}

/* ── URL state ─────────────────────────────────────────────────────────────────────────────────── */

export interface StreetUrlState {
  /** Home point (`lat`, `lng`, 5 dp) and its label `q`. */
  lat: number | null; lng: number | null; q: string;
  /** Map view `c=<lat>,<lng>` (4 dp) + `z=<int>`; both or neither. */
  center: LatLng | null; zoom: number | null;
  /** Neighborhood NAME (the URL carries its slug under `n`); null when absent or not one of the 25. */
  hood: string | null;
  g: GroupKey | null; s: 'open' | 'closed' | null; d: Window;
  /** `case=<cityGuid>` */
  caseId: string | null;
}
export const EMPTY_URL_STATE: StreetUrlState = { lat: null, lng: null, q: '', center: null, zoom: null, hood: null, g: null, s: null, d: 30, caseId: null };

const num = (v: string | null): number | null => { if (v == null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const validLatLng = (lat: number | null, lng: number | null): lat is number => lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const isGroup = (v: string | null): v is GroupKey => v != null && (GROUP_ORDER as string[]).includes(v);

/** Read /street's query string. Unknown or malformed values fall back to the default (and are dropped on the next write). */
export function parseStreetUrl(params: URLSearchParams): StreetUrlState {
  const lat = num(params.get('lat')), lng = num(params.get('lng'));
  const hasPoint = validLatLng(lat, lng);
  const cParts = (params.get('c') ?? '').split(',');
  const cLat = cParts.length === 2 ? num(cParts[0]) : null, cLng = cParts.length === 2 ? num(cParts[1]) : null;
  const zRaw = num(params.get('z'));
  const hasView = validLatLng(cLat, cLng) && zRaw != null && Number.isInteger(zRaw) && zRaw >= 0 && zRaw <= 22;
  const s = params.get('s'), g = params.get('g'), d = params.get('d');
  const caseId = (params.get('case') ?? '').trim();
  return {
    lat: hasPoint ? lat : null, lng: hasPoint ? (lng as number) : null, q: hasPoint ? (params.get('q') ?? '') : '',
    center: hasView ? { lat: cLat as number, lng: cLng as number } : null, zoom: hasView ? zRaw : null,
    hood: hoodFromSlug(params.get('n')),
    g: isGroup(g) ? g : null, s: s === 'open' || s === 'closed' ? s : null, d: d === '7' ? 7 : d === '90' ? 90 : 30,
    caseId: caseId && caseId.length <= 64 ? caseId : null,
  };
}

/** Write the query string, defaults omitted so canonical links stay short: lat, lng, q, c, z, n, g, s, d, case. */
export function writeStreetUrl(state: Partial<StreetUrlState>): URLSearchParams {
  const st = { ...EMPTY_URL_STATE, ...state };
  const p = new URLSearchParams();
  if (validLatLng(st.lat, st.lng)) {
    p.set('lat', st.lat.toFixed(5)); p.set('lng', (st.lng as number).toFixed(5));
    if (st.q) p.set('q', st.q);
  }
  if (st.center && st.zoom != null && Number.isFinite(st.zoom)) { p.set('c', `${st.center.lat.toFixed(4)},${st.center.lng.toFixed(4)}`); p.set('z', String(Math.round(st.zoom))); }
  if (st.hood) p.set('n', hoodSlug(st.hood));
  if (st.g && isGroup(st.g)) p.set('g', st.g);
  if (st.s === 'open' || st.s === 'closed') p.set('s', st.s);
  if (st.d === 7 || st.d === 90) p.set('d', String(st.d));
  if (st.caseId) p.set('case', st.caseId);
  return p;
}

export interface DefaultViewContext {
  /** The home point → default is z16 centred on it. */
  point?: LatLng | null;
  /** The selected case's coordinates → default is z17 on it. */
  caseAt?: LatLng | null;
  /** The view the map settled on after a programmatic fit (the city fit, or the hood's ringBounds fit), as captured on
   *  that fit's moveend. */
  fitted?: { center: LatLng; zoom: number } | null;
}

/** True when the current view equals one of the derived defaults (so `c`/`z` stay out of the URL): the fit the page
 *  made itself, z16 within `tolM` of the point, or z17 within `tolM` of the selected case. */
export function isDefaultView(view: { center: LatLng; zoom: number }, ctx: DefaultViewContext, tolM = 30): boolean {
  const near = (p: LatLng) => metersBetween(view.center.lat, view.center.lng, p.lat, p.lng) <= tolM;
  if (ctx.fitted && Math.round(ctx.fitted.zoom) === Math.round(view.zoom) && near(ctx.fitted.center)) return true;
  if (ctx.point && Math.round(view.zoom) === 16 && near(ctx.point)) return true;
  if (ctx.caseAt && Math.round(view.zoom) === 17 && near(ctx.caseAt)) return true;
  return false;
}

/* ── Time ──────────────────────────────────────────────────────────────────────────────────────── */

/** Whole 24-hour days since `iso`: 'today' | 'yesterday' | n (≥ 2); null when the date is missing or unparseable.
 *  The caller maps to t('street.ago.today' | 'street.ago.yesterday' | 'street.ago.days', {n}). */
export function ago(iso: string | null | undefined, nowMs: number): 'today' | 'yesterday' | number | null {
  const t = parseMs(iso ?? null);
  if (t == null) return null;
  const days = Math.max(0, Math.floor((nowMs - t) / DAY_MS));
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : days;
}
