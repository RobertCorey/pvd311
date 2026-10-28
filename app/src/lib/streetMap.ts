/** Pure helpers for the map-first /street page (spec: .claude/street-map-spec.md, 2026-10-25).
 *  One GET /api/street/map load → every count, filter, bbox, cluster, distance and URL here is computed in the
 *  browser from that array. No React, no Leaflet: `clusterGrid` takes a `project(lat, lng) → {x, y}` so MapView passes
 *  `map.project(...)` and the unit spec passes a linear scale. The wire types mirror worker/src/street.ts (MapFeed). */
import { GROUP_ORDER } from '@shared/categories';
import { groupOf, type GroupKey } from './categories';
import { inCityLimit, PVD_BOUNDS } from './geo';
import { hoodFromSlug, hoodSlug } from './neighborhoods';

/* ── Wire format (GET /api/street/map) ─────────────────────────────────────────────────────────── */

/** One case as transmitted: [id, t, s, createdMin, closedMin, lat, lng, street, res]. */
export type MapItem = [
  id: string, t: number, s: number, createdMin: number, closedMin: number,
  lat: number | null, lng: number | null, street: string, res: string | 0,
];
export interface MapFeed {
  v: 1; days: number; at: string; total: number; located: number; truncated: boolean;
  /** The New York day of the first case the Worker holds, or null when the read reaches further back (an older Worker
   *  leaves it out). */
  firstDay?: string | null;
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
/** `firstDay`: when we started reading the city's list (2026-10-10), if the loaded window reaches back to it — a window
 *  that starts before it is labelled "since <day>" (2026-10-28 audit: 30 and 90 days read the same 546). */
export interface StreetMap { days: number; at: string; total: number; located: number; truncated: boolean; firstDay: string | null; cases: MapCase[] }

/** A status in this set is "closed"; everything else (including unknown strings) is open. Same set as the worker. */
export const CLOSED_STATUSES: ReadonlySet<string> = new Set(['Resolved', 'Closed', 'Cancelled', 'Merged']);

const minToIso = (min: number): string | null => (Number.isFinite(min) && min > 0 ? new Date(min * 60_000).toISOString() : null);

/** Tuples → cases: minutes → ISO, `res || null`, open from CLOSED_STATUSES, `group = groupOf(category) ?? 'other'`.
 *  A bad type/status index degrades to '' rather than throwing (one odd row must not blank the page). Array order kept. */
/** A coordinate pair the map can show. One geocoded past the city margin (the Worker accepts anything in Rhode Island)
 *  is treated as unplaced — listed with "not on the map yet" — because the map cannot pan there (MapView keepInCity). */
function isPlaced(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && inCityLimit(lat, lng);
}

export function decodeFeed(feed: MapFeed): StreetMap {
  const types = feed.types ?? [], statuses = feed.statuses ?? [];
  const cases: MapCase[] = (feed.items ?? []).map(([id, t, s, createdMin, closedMin, lat, lng, street, res]) => {
    const [caseType, category] = types[t] ?? ['', 'unsure'];
    const status = statuses[s] ?? '';
    const located = isPlaced(lat, lng);
    return {
      id: String(id), caseType, category, group: groupOf(category) ?? 'other', status, open: !CLOSED_STATUSES.has(status),
      createdAt: minToIso(createdMin), closedAt: minToIso(closedMin), street: street || '',
      resolution: typeof res === 'string' && res ? res : null, lat: located ? lat : null, lng: located ? lng : null,
    };
  });
  return { days: feed.days, at: feed.at, total: feed.total, located: feed.located, truncated: !!feed.truncated, firstDay: isYmd(feed.firstDay) ? feed.firstDay : null, cases };
}

/** GET /api/street/case/:guid — one case as an object (worker/src/street.ts StreetCaseView; the /my list's row shape),
 *  plus the optional `detail` the pin overlay reads (decodeCaseDetail). */
export interface StreetCaseWire {
  id: string; caseType: string; category: string; street: string; status: string; open?: boolean;
  createdAt: string | null; closedAt: string | null; resolution: string | null; lat: number | null; lng: number | null; updatedAt?: string | null;
  detail?: unknown;
}

/** A single-case response → MapCase, with the same defaults as decodeFeed (`open` from the status, '' for blanks). */
export function decodeCase(w: Partial<StreetCaseWire>): MapCase {
  const status = typeof w.status === 'string' ? w.status : '';
  const category = typeof w.category === 'string' && w.category ? w.category : 'unsure';
  const located = isPlaced(w.lat, w.lng);
  return {
    id: String(w.id ?? ''), caseType: typeof w.caseType === 'string' ? w.caseType : '', category, group: groupOf(category) ?? 'other', status, open: !CLOSED_STATUSES.has(status),
    createdAt: typeof w.createdAt === 'string' ? w.createdAt : null, closedAt: typeof w.closedAt === 'string' ? w.closedAt : null,
    street: typeof w.street === 'string' ? w.street : '', resolution: typeof w.resolution === 'string' && w.resolution ? w.resolution : null,
    lat: located ? (w.lat as number) : null, lng: located ? (w.lng as number) : null,
  };
}

/* ── Case detail (the pin overlay, 2026-10-27) ─────────────────────────────────────────────────── */

/** ISO dates from the city's own form: `reported` = createdAt; the rest = receivedOn / routedOn / workCompletedOn /
 *  resolutionDate (the worker falls back to the close it watched for `resolved`). */
export interface CaseTimeline { reported: string | null; received: string | null; routed: string | null; workCompleted: string | null; resolved: string | null }
/** `detail` of GET /api/street/case/:guid (worker/src/street.ts streetCaseDetail) — omitted until the sync has read the
 *  case's detail form. Every value is a plain string; the page renders them as text, never as HTML. */
export interface CaseDetail {
  /** The city's full address ("10 Example St, Providence, RI, 02908, USA"). */
  address: string | null;
  timeline: CaseTimeline;
  /** The city-question answers in the form's order (plates and names already left out by the worker). */
  answers: { label: string; value: string }[];
  /** Each status the sync saw and when, oldest first (decoded, not shown yet). */
  statusHistory: { status: string; at: string }[];
}
export type TimelineStep = keyof CaseTimeline;
export const TIMELINE_STEPS: readonly TimelineStep[] = ['reported', 'received', 'routed', 'workCompleted', 'resolved'];

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isoStr = (v: unknown): string | null => { const s = str(v); return s && Number.isFinite(Date.parse(s)) ? s : null; };

/** The wire's `detail` → CaseDetail, or null when it is absent or not an object. Defensive like decodeCase: a bad date
 *  is null, an answer without a label or a value is dropped (never shown as "label: "), unknown keys are ignored. */
export function decodeCaseDetail(w: unknown): CaseDetail | null {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const d = w as Record<string, unknown>;
  const tl = (d.timeline && typeof d.timeline === 'object' ? d.timeline : {}) as Record<string, unknown>;
  const timeline = Object.fromEntries(TIMELINE_STEPS.map((k) => [k, isoStr(tl[k])])) as unknown as CaseTimeline;
  const answers = (Array.isArray(d.answers) ? d.answers : []).flatMap((a) => {
    const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const label = str(x.label), value = str(x.value);
    return label && value ? [{ label, value }] : [];
  });
  const statusHistory = (Array.isArray(d.statusHistory) ? d.statusHistory : []).flatMap((h) => {
    const x = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
    const status = str(x.status), at = isoStr(x.at);
    return status && at ? [{ status, at }] : [];
  });
  return { address: str(d.address), timeline, answers, statusHistory };
}

/** The steps the overlay's timeline lists, oldest first — only those with a date (the city's form can date "received"
 *  after "sent to the department": sorted by date, not by the usual order, which only breaks ties). `resolved` only
 *  for a case that is closed now (a reopened case keeps its old resolution date on the form), with `days` = calendar
 *  days after it was reported (nyDaysBetween). `reported` falls back to the case's createdAt. */
export function caseTimeline(c: MapCase, detail: CaseDetail): { step: TimelineStep; at: string; days?: number }[] {
  const at: CaseTimeline = { ...detail.timeline, reported: detail.timeline.reported ?? c.createdAt };
  const created = parseMs(at.reported);
  const out: { step: TimelineStep; at: string; days?: number }[] = [];
  for (const step of TIMELINE_STEPS) {
    const iso = at[step];
    if (!iso || parseMs(iso) == null || (step === 'resolved' && c.open)) continue;
    if (step === 'resolved' && created != null) out.push({ step, at: iso, days: nyDaysBetween(created, parseMs(iso) as number) });
    else out.push({ step, at: iso });
  }
  return out.sort((a, b) => (parseMs(a.at) as number) - (parseMs(b.at) as number)); // stable: equal dates keep lifecycle order
}

/** The city's full address when it says more than the street the card already shows — a different first line (a house
 *  number the street field lacks, another spelling). '…, USA' is dropped. null when it adds nothing or is missing. */
export function fullAddressLine(street: string, address: string | null | undefined): string | null {
  const a = (address ?? '').trim().replace(/,?\s*USA$/i, '').trim();
  if (!a) return null;
  return streetKey(a) === streetKey(street) ? null : a;
}

/** Open: calendar days since it was reported; closed: calendar days from report to close (nyDaysBetween). null
 *  without the dates. */
export function caseAge(c: MapCase, nowMs: number): { open: boolean; days: number } | null {
  const created = parseMs(c.createdAt);
  if (created == null) return null;
  if (c.open) return { open: true, days: nyDaysBetween(created, nowMs) };
  const closed = parseMs(c.closedAt);
  return closed == null ? null : { open: false, days: nyDaysBetween(created, closed) };
}

/** "Oct 24" (the year too when it is not `nowMs`'s), in Providence's time; '' when it will not parse. The case page's
 *  dates and the phone's pin preview. */
export function caseDay(iso: string | null | undefined, nowMs: number, locale: string): string {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return '';
  const sameYear = new Date(ms).getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: 'America/New_York' });
}

/** An instant's year / month / day in Providence's time (the card prints its dates in America/New_York). */
const NY_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' });
/** Calendar days from `a` to `b` (ms) on Providence's calendar, never negative: 8:30 PM Oct 16 → 10 AM Oct 17 is 1,
 *  9 AM → 11 PM the same date is 0. Elapsed 24-hour periods would print "closed the same day" next to two different
 *  dates (2026-10-27 review); this way "same day" / "N days" always match the dates the card shows. */
export function nyDaysBetween(a: number, b: number): number {
  const day = (ms: number) => {
    const p = Object.fromEntries(NY_DATE.formatToParts(ms).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS;
  };
  return Math.max(0, day(b) - day(a));
}

/** A pin's halo (Rob, 2026-10-27: pins should say more than open/closed): open and reported in the last 48 hours. */
export const NEW_CASE_MS = 48 * 60 * 60_000;
export function isNewCase(c: Pick<MapCase, 'open' | 'createdAt'>, nowMs: number): boolean {
  const t = parseMs(c.createdAt);
  return c.open && t != null && nowMs - t <= NEW_CASE_MS;
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

/** The case page's "Nearby" (2026-10-27): up to `limit` other located cases within `radiusM` of `c` from the loaded
 *  feed, nearest first (ties: newest activity first), each with its rounded distance from `c`. [] for an unlocated case. */
export const NEARBY_M = 150;
export const NEARBY_MAX = 5;
export function nearbyCases(cases: MapCase[], c: MapCase, radiusM = NEARBY_M, limit = NEARBY_MAX): { c: MapCase; m: number }[] {
  if (c.lat == null || c.lng == null) return [];
  const out: { c: MapCase; m: number; d: number }[] = [];
  for (const x of cases) {
    if (x.id === c.id || x.lat == null || x.lng == null) continue;
    const d = metersBetween(c.lat, c.lng, x.lat, x.lng);
    if (d <= radiusM) out.push({ c: x, m: Math.round(d), d });
  }
  out.sort((a, b) => a.d - b.d || (activityMs(b.c) ?? 0) - (activityMs(a.c) ?? 0));
  return out.slice(0, limit).map(({ c: x, m }) => ({ c: x, m }));
}

/** The resident's own filed report, once the city sync has picked it up, sits in the city's list like any other case
 *  (cityCases are keyed by the portal's incident GUID; a report carries only the PVD case number, so nothing links the
 *  two on the wire). "Near this request" must not call it an *other* request, so the one row that is most likely the
 *  report itself is dropped: same category, created within OWN_CASE_WINDOW_MS of the report (the submission queue can
 *  hold a report for hours), and either within OWN_CASE_M of the report's pin or on the report's own street line — the
 *  city's point is its street *geocoded*, not our pin, so a pure distance test would miss most of them. Only the closest
 *  candidate goes: a report is one case. Exact linking needs the Worker to send the incident GUID in ReportView. */
export const OWN_CASE_M = 60;
export const OWN_CASE_WINDOW_MS = 48 * 60 * 60_000;

/** '120 Benefit St, Providence, RI' → '120 benefit st'; the city's '120 BENEFIT ST' → the same. */
export const streetKey = (s: string): string => s.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface OwnCaseReport { category: string; createdAt: string | null; lat: number; lng: number; address: string }

/** The id of the case in `cases` that is most likely `report` itself, or null (see OWN_CASE_M). `distanceM` on a case
 *  (the Worker's own) is preferred over a computed one. */
export function likelyOwnCase(cases: (MapCase & { distanceM?: number | null })[], report: OwnCaseReport): string | null {
  const at = parseMs(report.createdAt);
  if (at == null) return null;
  const street = streetKey(report.address);
  let best: { id: string; d: number } | null = null;
  for (const c of cases) {
    if (c.category !== report.category) continue;
    const created = parseMs(c.createdAt);
    if (created == null || Math.abs(created - at) > OWN_CASE_WINDOW_MS) continue;
    const d = typeof c.distanceM === 'number' ? c.distanceM : distanceM(c, report);
    const sameStreet = street !== '' && streetKey(c.street) === street;
    if (!sameStreet && (d == null || d > OWN_CASE_M)) continue;
    const rank = d ?? OWN_CASE_M;
    if (!best || rank < best.d) best = { id: c.id, d: rank };
  }
  return best?.id ?? null;
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

/** A preset window in days; 1 = the last 24 hours. */
export type Window = 1 | 7 | 30 | 90;
/** A custom range of Providence calendar days ("YYYY-MM-DD", from ≤ to): activity from From 00:00 to To 23:59:59. */
export interface DateRange { from: string; to: string }
export interface Filters {
  /** The picked type groups, in GROUP_ORDER order; [] = every type. */
  g: GroupKey[];
  s: 'open' | 'closed' | null;
  /** The preset window; ignored while `range` is set. */
  d: Window;
  /** "Custom range…"; null = the preset `d`. */
  range: DateRange | null;
}
export const DEFAULT_FILTERS: Filters = { g: [], s: null, d: 30, range: null };
export const DAY_MS = 86_400_000;

const parseMs = (iso: string | null): number | null => { if (!iso) return null; const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

/** Newest of created / closed, in ms; null when neither parses (the server already vouched for the row). */
export function activityMs(c: MapCase): number | null {
  const a = parseMs(c.createdAt), b = parseMs(c.closedAt);
  return a == null ? b : b == null ? a : Math.max(a, b);
}

/** Activity within the last `d` days. "Last 24 hours" and "7 days" are cut client-side from the 30-day load, so this
 *  runs on every render; a case without any parseable date stays in (the worker included it for a reason). */
export function inWindow(c: MapCase, d: Window, nowMs: number): boolean {
  const t = activityMs(c);
  return t == null || t >= nowMs - d * DAY_MS;
}

/** The filters' window as a test, bounds computed once: the preset (inWindow), or the custom range — reported or closed
 *  between From 00:00 and To 23:59:59 Providence time (a case reported before From and closed in it counts, like a
 *  close counts for a preset). A case without any parseable date stays in, as above. */
export function windowTest(f: Pick<Filters, 'd' | 'range'>, nowMs: number): (c: MapCase) => boolean {
  if (!f.range) { const d = f.d; return (c) => inWindow(c, d, nowMs); }
  const a = nyDayStart(f.range.from), b = nyDayStart(addDays(f.range.to, 1));
  const within = (t: number | null) => t != null && t >= a && t < b;
  return (c) => {
    const cr = parseMs(c.createdAt), cl = parseMs(c.closedAt);
    return (cr == null && cl == null) || within(cr) || within(cl);
  };
}

const matchStatus = (c: MapCase, s: Filters['s']) => s == null || (s === 'open' ? c.open : !c.open);
const matchGroup = (c: MapCase, g: Filters['g']) => g.length === 0 || g.includes(c.group);

/** Window + status + groups (any of them), keeping the feed's newest-activity-first order. */
export function applyFilters(cases: MapCase[], f: Filters, nowMs: number): MapCase[] {
  const inW = windowTest(f, nowMs);
  return cases.filter((c) => inW(c) && matchStatus(c, f.s) && matchGroup(c, f.g));
}

export interface FacetCounts {
  /** Open / closed in view with the status dimension released (groups + window applied). */
  open: number; closed: number;
  /** "All types": groups released, status + window applied. */
  all: number;
  /** Per group, status + window applied — zero-count groups are present (every box stays enabled). With groups picked
   *  the union of theirs is the sum of these (a case is in one group). */
  groups: Record<GroupKey, number>;
  /** Every filter applied: what the view actually shows. */
  total: number;
}

/** "What you would get" counts over the visible band (`viewBounds`; null = the whole set, unlocated included), each
 *  control's own dimension released and the other filters applied — so a choice never reads 0 when picking it would show something. */
export function facetCounts(cases: MapCase[], viewBounds: Bounds | null, f: Filters, nowMs: number): FacetCounts {
  const groups = Object.fromEntries(GROUP_ORDER.map((g) => [g, 0])) as Record<GroupKey, number>;
  const inW = windowTest(f, nowMs);
  let open = 0, closed = 0, all = 0, total = 0;
  for (const c of cases) {
    if (!inW(c)) continue;
    if (viewBounds && !inBounds(c, viewBounds)) continue;
    const okS = matchStatus(c, f.s), okG = matchGroup(c, f.g);
    if (okG) { if (c.open) open++; else closed++; }
    if (okS) { all++; groups[c.group] = (groups[c.group] ?? 0) + 1; }
    if (okS && okG) total++;
  }
  return { open, closed, all, groups, total };
}

/* ── Providence calendar days (the custom range) ───────────────────────────────────────────────── */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day written "YYYY-MM-DD" (what a date input's value and the URL's from / to carry). */
export function isYmd(s: string | null | undefined): s is string {
  const m = YMD_RE.exec(s ?? '');
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}
const ymdParts = (ymd: string): [number, number, number] => { const m = YMD_RE.exec(ymd) as RegExpExecArray; return [Number(m[1]), Number(m[2]), Number(m[3])]; };
/** `ymd` moved by `n` calendar days. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** The Providence calendar day an instant falls on. */
export function nyYmd(ms: number): string {
  const p = Object.fromEntries(NY_DATE.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
const NY_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
/** The instant a Providence calendar day starts (00:00 America/New_York). The clocks change at 2 AM, so midnight has the
 *  offset 05:00 UTC has (00:00 EST / 01:00 EDT). */
export function nyDayStart(ymd: string): number {
  const [y, m, d] = ymdParts(ymd);
  const guess = Date.UTC(y, m - 1, d, 5);
  const p = Object.fromEntries(NY_CLOCK.formatToParts(guess).map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Date.UTC(y, m - 1, d) - (wall - guess);
}

/** How far back "Custom range…" reaches: From ≥ today − 89, so the 90-day load always covers From 00:00. */
export const RANGE_BACK_DAYS = 89;
/** The date inputs' bounds (min = today − 89, max = today) and "Custom range…"'s first pick: the last 7 days, today
 *  included — seven dates, as "7 days" and /week count them. */
export function rangeBounds(nowMs: number): { min: string; max: string } {
  const max = nyYmd(nowMs);
  return { min: addDays(max, -RANGE_BACK_DAYS), max };
}
export function defaultRange(nowMs: number): DateRange {
  const to = nyYmd(nowMs);
  return { from: addDays(to, -6), to };
}
/** A range held to rangeBounds: From raised to today − 89, To lowered to today; null when nothing of it is left (wholly
 *  before or after them). A shared link keeps its dates while the bounds move on, and days before today − 89 are past
 *  what the 90-day load covers — they would read as "nothing reported". The same object back when nothing moved. */
export function clampRange(r: DateRange | null, nowMs: number): DateRange | null {
  if (!r) return null;
  const { min, max } = rangeBounds(nowMs);
  if (r.from >= min && r.to <= max) return r;
  const from = r.from < min ? min : r.from, to = r.to > max ? max : r.to;
  return from <= to ? { from, to } : null;
}

/** The server window to load (worker/src/street.ts snapDays: 7, 30 or 90 days back from now): 30 for the last 24 hours,
 *  7 days and 30 days (the shorter two are cut from it client-side), 90 for 90 days; a custom range → the smallest
 *  that reaches back to From 00:00. */
export function feedDays(f: Pick<Filters, 'd' | 'range'>, nowMs: number): 7 | 30 | 90 {
  if (!f.range) return f.d === 90 ? 90 : 30;
  const back = (nowMs - nyDayStart(f.range.from)) / DAY_MS;
  return back <= 7 ? 7 : back <= 30 ? 30 : 90;
}

/* ── Summary line, top groups ──────────────────────────────────────────────────────────────────── */

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

export interface GroupCount { group: GroupKey; n: number }

/** "Most reported": the busiest type groups among `cases` — the unit the Type filter picks, so a chip's count is what
 *  it shows (2026-10-28 audit: a type-named chip opened its whole group). Ties: GROUP_ORDER. */
export function topGroups(cases: MapCase[], limit = 3): GroupCount[] {
  const m = new Map<GroupKey, number>();
  for (const c of cases) m.set(c.group, (m.get(c.group) ?? 0) + 1);
  return [...m].map(([group, n]) => ({ group, n })).sort((a, b) => b.n - a.n || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)).slice(0, limit);
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

/* ── Fanned stacks (Rob, 2026-10-27: "impossible to zoom in far enough to get individual pins") ──────────────── */

/** A stack of up to this many is drawn as its own pins from street zoom (MapView SPIDER_ZOOM); a bigger one stays a
 *  disc whose tap lists its cases. */
export const SPIDER_MAX = 12;
/** Px between neighbouring pin anchors; the circle's smallest radius; how far a case pin's head stands above its tip
 *  (lib/mapMarkers caseMarker: the open pin's head is centred 20 px up, r ≈ 11 with its paper outline). */
const SPIDER_GAP = 30, SPIDER_MIN_R = 22, PIN_HEAD_RISE = 20;

/** Screen-pixel offsets (y down) from a stack's shared point to each member's pin anchor, in member order: one circle
 *  whose radius keeps SPIDER_GAP between neighbours (never under SPIDER_MIN_R, so two sit side by side), turned so its
 *  widest gap is straight down — a pin hangs above its anchor, so none then covers the centre dot. A slot below the dot
 *  drops a further PIN_HEAD_RISE so its head, not its tip, sits on the circle: the legs run under the pins, and a lower
 *  head left at the dot's height hid the legs to the side pins (a 4- or 5-stack's lost theirs end to end) — now every
 *  leg clears every other member's head. [] outside 2–SPIDER_MAX. Pixels, not degrees: the caller converts at the zoom
 *  it draws (MapView: map.project / unproject). */
export function spiderOffsets(n: number): { x: number; y: number }[] {
  if (!Number.isInteger(n) || n < 2 || n > SPIDER_MAX) return [];
  const r = Math.max(SPIDER_MIN_R, SPIDER_GAP / (2 * Math.sin(Math.PI / n)));
  return Array.from({ length: n }, (_, i) => {
    const a = Math.PI / 2 + Math.PI / n + (i * 2 * Math.PI) / n, y = r * Math.sin(a);
    return { x: r * Math.cos(a), y: y > 1e-6 ? y + PIN_HEAD_RISE : y }; // 1e-6: a side slot's sin(π) is not "below"
  });
}

/* ── URL state ─────────────────────────────────────────────────────────────────────────────────── */

export interface StreetUrlState {
  /** Home point (`lat`, `lng`, 5 dp) and its label `q`. */
  lat: number | null; lng: number | null; q: string;
  /** Map view `c=<lat>,<lng>` (4 dp) + `z=<int>`; both or neither. */
  center: LatLng | null; zoom: number | null;
  /** Neighborhood NAME (the URL carries its slug under `n`); null when absent or not one of the 25. */
  hood: string | null;
  /** `g=trash,streets` (GROUP_ORDER order; /week's single `g=trash` is a list of one). */
  g: GroupKey[]; s: 'open' | 'closed' | null; d: Window;
  /** `from=YYYY-MM-DD&to=YYYY-MM-DD` (no `d`): "Custom range…". */
  range: DateRange | null;
  /** `case=<cityGuid>` */
  caseId: string | null;
}
export const EMPTY_URL_STATE: StreetUrlState = { lat: null, lng: null, q: '', center: null, zoom: null, hood: null, g: [], s: null, d: 30, range: null, caseId: null };

const num = (v: string | null): number | null => { if (v == null || v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const validLatLng = (lat: number | null, lng: number | null): lat is number => lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
/** Known groups only, each once, in GROUP_ORDER order — so one selection always writes one URL. */
const groupList = (gs: readonly string[]): GroupKey[] => GROUP_ORDER.filter((k) => gs.includes(k));

/** Read /street's query string. Unknown or malformed values fall back to the default (and are dropped on the next write). */
export function parseStreetUrl(params: URLSearchParams): StreetUrlState {
  const lat = num(params.get('lat')), lng = num(params.get('lng'));
  const hasPoint = validLatLng(lat, lng);
  const cParts = (params.get('c') ?? '').split(',');
  const cLat = cParts.length === 2 ? num(cParts[0]) : null, cLng = cParts.length === 2 ? num(cParts[1]) : null;
  const zRaw = num(params.get('z'));
  const hasView = validLatLng(cLat, cLng) && zRaw != null && Number.isInteger(zRaw) && zRaw >= 0 && zRaw <= 22;
  const s = params.get('s'), d = params.get('d'), from = params.get('from'), to = params.get('to');
  const caseId = (params.get('case') ?? '').trim();
  return {
    lat: hasPoint ? lat : null, lng: hasPoint ? (lng as number) : null, q: hasPoint ? (params.get('q') ?? '') : '',
    center: hasView ? { lat: cLat as number, lng: cLng as number } : null, zoom: hasView ? zRaw : null,
    hood: hoodFromSlug(params.get('n')),
    g: groupList((params.get('g') ?? '').split(',')), s: s === 'open' || s === 'closed' ? s : null,
    d: d === '1' ? 1 : d === '7' ? 7 : d === '90' ? 90 : 30,
    range: isYmd(from) && isYmd(to) && from <= to ? { from, to } : null,
    caseId: caseId && caseId.length <= 64 ? caseId : null,
  };
}

/** Write the query string, defaults omitted so canonical links stay short: lat, lng, q, c, z, n, g, s, d | from + to, case. */
export function writeStreetUrl(state: Partial<StreetUrlState>): URLSearchParams {
  const st = { ...EMPTY_URL_STATE, ...state };
  const p = new URLSearchParams();
  if (validLatLng(st.lat, st.lng)) {
    p.set('lat', st.lat.toFixed(5)); p.set('lng', (st.lng as number).toFixed(5));
    if (st.q) p.set('q', st.q);
  }
  if (st.center && st.zoom != null && Number.isFinite(st.zoom)) { p.set('c', `${st.center.lat.toFixed(4)},${st.center.lng.toFixed(4)}`); p.set('z', String(Math.round(st.zoom))); }
  if (st.hood) p.set('n', hoodSlug(st.hood));
  const g = groupList(st.g ?? []);
  if (g.length) p.set('g', g.join(','));
  if (st.s === 'open' || st.s === 'closed') p.set('s', st.s);
  const r = st.range;
  if (r && isYmd(r.from) && isYmd(r.to) && r.from <= r.to) { p.set('from', r.from); p.set('to', r.to); }
  else if (st.d === 1 || st.d === 7 || st.d === 90) p.set('d', String(st.d));
  if (st.caseId) p.set('case', st.caseId);
  return p;
}

/** "Report something here": the report screen with the place filled in — Report.tsx reads `lat`, `lng` and `q` (the
 *  address; left out when there is none to show). Without a place, the plain report screen. */
export function reportHref(p: LatLng | null, q: string): string {
  if (!p) return '/';
  const s = new URLSearchParams({ lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) });
  if (q) s.set('q', q);
  return `/?${s}`;
}

/** writeStreetUrl as the address bar's query (no `?`): g's commas stay literal (`g=trash,streets`); everything else as
 *  URLSearchParams encodes it. */
export function streetSearch(state: Partial<StreetUrlState>): string {
  return writeStreetUrl(state).toString().replace(/(^|&)g=([^&]*)/, (_, a: string, v: string) => `${a}g=${v.replace(/%2C/gi, ',')}`);
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

/* ── "Your places this week" (the /street landing, signed in) ───────────────────────────────────── */

export interface PlaceActivity {
  /** Located cases created within the window. */
  created: number;
  /** Located cases closed (closedAt within the window, status closed). A case can count in both. */
  closed: number;
}

/** The last `days` days within `radiusM` of `p`, from the loaded feed — no request. An unlocated case or one without a
 *  parseable date never counts; a case whose closedAt is set but whose status is open (reopened) is not a close. */
export function placeActivity(cases: MapCase[], p: LatLng, nowMs: number, radiusM = 300, days = 7): PlaceActivity {
  const since = nowMs - days * DAY_MS;
  let created = 0, closed = 0;
  for (const c of cases) {
    if (c.lat == null || c.lng == null) continue;
    const a = parseMs(c.createdAt), b = parseMs(c.closedAt);
    const isNew = a != null && a >= since, isClosed = !c.open && b != null && b >= since;
    if (!isNew && !isClosed) continue;
    if (metersBetween(p.lat, p.lng, c.lat, c.lng) > radiusM) continue;
    if (isNew) created++;
    if (isClosed) closed++;
  }
  return { created, closed };
}
