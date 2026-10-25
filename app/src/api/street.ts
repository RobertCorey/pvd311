// "My street": the city's public cases (worker/src/street.ts).
// 2026-10-25 — the map-first page reads ONE feed, GET /api/street/map (every case of the window as columnar tuples),
// decoded and cached here for 5 minutes per window so filter taps, pans and tab returns never refetch.
// The decoder and wire types live in lib/streetMap.ts (pure, unit-tested) and are re-exported from here.
import { apiFetch, parseError, withTimeout } from './client';
import { decodeFeed, type MapFeed, type StreetMap } from '../lib/streetMap';

export { CLOSED_STATUSES, decodeFeed } from '../lib/streetMap';
export type { MapCase, MapFeed, MapItem, StreetMap } from '../lib/streetMap';

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

/** Tests / sign-out: forget every cached window. */
export function resetStreetMapCache(): void { mapCache.clear(); mapInflight.clear(); }

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
