// "My street": the city's public cases (worker/src/street.ts).
// 2026-10-25 — the map-first page reads ONE feed, GET /api/street/map (every case of the window as columnar tuples),
// decoded and cached here for 5 minutes per window so filter taps, pans and tab returns never refetch.
// The decoder and wire types live in lib/streetMap.ts (pure, unit-tested) and are re-exported from here.
import { apiFetch, parseError, withTimeout } from './client';
import { decodeCase, decodeCaseDetail, decodeFeed, metersBetween, type CaseDetail, type MapCase, type MapFeed, type StreetCaseWire, type StreetMap } from '../lib/streetMap';

export { CLOSED_STATUSES, decodeCase, decodeFeed } from '../lib/streetMap';
export type { CaseDetail, MapCase, MapFeed, MapItem, StreetCaseWire, StreetMap } from '../lib/streetMap';

/** The windows the page fetches; "This week" (7) is cut client-side from the 30-day set. */
export type MapDays = 30 | 90;

const MAP_TTL_MS = 5 * 60_000;
const mapCache = new Map<MapDays, { at: number; data: StreetMap }>();
const mapInflight = new Map<MapDays, Promise<StreetMap>>();

/** The whole window's cases, decoded. Cached per `days` for 5 minutes (concurrent calls share one request). A failed
 *  refresh rejects and leaves the previous entry in place — callers keep their last good set (the "as of" line). */
export function getStreetMap(days: MapDays = 30): Promise<StreetMap> {
  const hit = mapCache.get(days);
  if (hit && Date.now() - hit.at < MAP_TTL_MS) return Promise.resolve(hit.data);
  const pending = mapInflight.get(days);
  if (pending) return pending;
  const p = fetchStreetMap(days)
    .then((data) => { mapCache.set(days, { at: Date.now(), data }); return data; })
    .finally(() => { mapInflight.delete(days); });
  mapInflight.set(days, p);
  return p;
}

/** The cached set for a window, fresh or stale, without fetching (e.g. the 90-day count on "Look back 90 days"). */
export function peekStreetMap(days: MapDays): StreetMap | null { return mapCache.get(days)?.data ?? null; }

/** Tests / sign-out: forget every cached window (and every case read by itself). */
export function resetStreetMapCache(): void { mapCache.clear(); mapInflight.clear(); caseCache.clear(); }

async function fetchStreetMap(days: MapDays): Promise<StreetMap> {
  const t = withTimeout(20_000);
  try {
    const resp = await apiFetch(`/api/street/map?days=${days}`, { signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    const feed = (await resp.json()) as Partial<MapFeed>;
    if (!feed || feed.v !== 1 || !Array.isArray(feed.items)) throw new Error('street_map_bad_feed');
    return decodeFeed(feed as MapFeed);
  } finally { t.done(); }
}

/** One case read by itself: the row plus the city form's `detail` (null until the sync has read it). */
export interface StreetCaseFull { c: MapCase; detail: CaseDetail | null }

/** GET /api/street/case/:guid, once per id for 5 minutes: the pin overlay (every case it opens) and the stale deep-link
 *  lookup share it, so a deep link costs one request. `value` is set once it settles so the overlay can render a cached
 *  answer in the same frame; a failure is dropped from the cache (the next open asks again). */
const caseCache = new Map<string, { at: number; p: Promise<StreetCaseFull | null>; value?: StreetCaseFull | null }>();

export function getStreetCaseFull(id: string): Promise<StreetCaseFull | null> {
  const hit = caseCache.get(id);
  if (hit && Date.now() - hit.at < MAP_TTL_MS) return hit.p;
  const entry: { at: number; p: Promise<StreetCaseFull | null>; value?: StreetCaseFull | null } = { at: Date.now(), p: fetchStreetCase(id) };
  entry.p.then((v) => { entry.value = v; }, () => { if (caseCache.get(id) === entry) caseCache.delete(id); });
  caseCache.set(id, entry);
  return entry.p;
}

/** The settled answer for `id`, without fetching: undefined while unknown or in flight, null for a gone case. */
export function peekStreetCase(id: string): StreetCaseFull | null | undefined {
  const hit = caseCache.get(id);
  return hit && Date.now() - hit.at < MAP_TTL_MS ? hit.value : undefined;
}

/** One case by GUID for a `?case=` deep link older than the loaded window — the follow mail's "See it on the map", a
 *  /my row. null when the city's record is gone (404); rejects on any other failure. */
export async function getStreetCase(id: string): Promise<MapCase | null> {
  return (await getStreetCaseFull(id))?.c ?? null;
}

async function fetchStreetCase(id: string): Promise<StreetCaseFull | null> {
  const t = withTimeout(15_000);
  try {
    const resp = await apiFetch(`/api/street/case/${encodeURIComponent(id)}`, { signal: t.signal });
    if (resp.status === 404) return null;
    if (!resp.ok) throw await parseError(resp);
    const w = (await resp.json()) as Partial<StreetCaseWire>;
    if (!w || typeof w.id !== 'string') throw new Error('street_case_bad_body');
    return { c: decodeCase(w), detail: decodeCaseDetail(w.detail) };
  } finally { t.done(); }
}

/** One of the city's cases near a point (GET /api/street): a MapCase plus its distance from the point in metres. */
export type NearbyCase = MapCase & { distanceM: number };
export interface Nearby { items: NearbyCase[]; radiusM: number; days: number }

/** The city's cases within `radiusM` of a point whose creation or close falls inside the last `days`, newest activity
 *  first (worker/src/street.ts nearbyCases) — the tracking page's "Near this request" card. Rejects on any failure; the
 *  caller decides what a failed card looks like. The wire's own distanceM is kept; a row without one gets it computed. */
export async function getNearby(lat: number, lng: number, radiusM = 300, days = 30): Promise<Nearby> {
  const t = withTimeout(10_000);
  try {
    const q = new URLSearchParams({ lat: String(lat), lng: String(lng), radiusM: String(radiusM), days: String(days) });
    const resp = await apiFetch(`/api/street?${q}`, { signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    const body = (await resp.json()) as Partial<{ items: (Partial<StreetCaseWire> & { distanceM?: unknown })[]; radiusM: number; days: number }>;
    if (!body || !Array.isArray(body.items)) throw new Error('street_nearby_bad_body');
    const items: NearbyCase[] = body.items.map((w) => {
      const c = decodeCase(w);
      const d = typeof w.distanceM === 'number' && Number.isFinite(w.distanceM) ? Math.round(w.distanceM)
        : c.lat != null && c.lng != null ? Math.round(metersBetween(lat, lng, c.lat, c.lng)) : 0;
      return { ...c, distanceM: d };
    });
    return { items, radiusM: typeof body.radiusM === 'number' ? body.radiusM : radiusM, days: typeof body.days === 'number' ? body.days : days };
  } finally { t.done(); }
}
