/** Providence's 25 official neighborhoods, first-class in the UI ("Fox Point · 3 open").
 *  Point-in-polygon over simplified city GIS rings. The rings live once, in shared/neighborhoods.ts (the Worker's
 *  GET /api/week and street watch import them eagerly); the app loads that module lazily so the ~8 KB chunk never
 *  hits the main bundle. The /street map page (2026-10-25) also needs the table synchronously once loaded:
 *  `loadNeighborhoods()` hands it over, `hoodOfSync` classifies ~1,200 cases in one pass, `ringBounds` fits a hood,
 *  and the slug helpers back `?n=`.
 *
 *  Nothing here imports shared/neighborhoods statically, on purpose: its NEIGHBORHOOD_NAMES is Object.keys(NEIGHBORHOODS)
 *  and its hoodOf index is built at module load, so a static import inlines the rings into this chunk and turns the
 *  import() below into a no-op (Rolldown: INEFFECTIVE_DYNAMIC_IMPORT; measured 2026-10-26: streetMap chunk 8.4 → 16.4 KB).
 *  The five-line helpers below (hoodSlug, ringBounds, the ray cast) therefore stay as copies of the shared ones;
 *  tests/unit-streetMap.spec.ts asserts they agree with the shared module on the real rings. */

import type { NeighborhoodTable, Rings } from '@shared/neighborhoods';
export type { NeighborhoodTable, Rings };

let data: Promise<NeighborhoodTable> | null = null;
const load = () => (data ??= import('@shared/neighborhoods').then((m) => m.NEIGHBORHOODS));

/** The 25 names, in the shared module's order. Static here so `hoodFromSlug` and the URL parser work before the
 *  rings have loaded (see the header for why they are not imported); the unit spec asserts this list equals the
 *  shared module's keys. */
export const NEIGHBORHOOD_NAMES: readonly string[] = [
  'Manton', 'Hope', 'Valley', 'Federal Hill', 'Wayland', 'Olneyville', 'Smith Hill', 'Upper South Providence', 'Hartford',
  'Reservoir', 'Elmwood', 'College Hill', 'Downtown', 'Silver Lake', 'Fox Point', 'Charles', 'Mount Hope',
  'Lower South Providence', 'South Elmwood', 'West End', 'Elmhurst', 'Wanskuck', 'Mount Pleasant', 'Washington Park', 'Blackstone',
];

/** The rings table (the shared module, loaded once). */
export function loadNeighborhoods(): Promise<NeighborhoodTable> { return load(); }

function inRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Per-table index: each hood with its rings and their bounding box, built once (the table is a module constant). */
interface HoodEntry { name: string; rings: Rings; box: { south: number; west: number; north: number; east: number } }
const indexes = new WeakMap<NeighborhoodTable, HoodEntry[]>();
function indexOf(nb: NeighborhoodTable): HoodEntry[] {
  let idx = indexes.get(nb);
  if (!idx) { idx = Object.entries(nb).map(([name, rings]) => ({ name, rings, box: ringBounds(rings) })); indexes.set(nb, idx); }
  return idx;
}

/** Neighborhood name for a point, over an already-loaded table; null when outside every ring. A bounding-box test
 *  rejects most hoods before the ray cast (~1,200 cases classify in ~1 ms instead of ~20 ms on a desktop core). */
export function hoodOfSync(nb: NeighborhoodTable, lat: number, lng: number): string | null {
  for (const h of indexOf(nb)) {
    const b = h.box;
    if (lat < b.south || lat > b.north || lng < b.west || lng > b.east) continue;
    for (const r of h.rings) if (inRing(lng, lat, r)) return h.name;
  }
  return null;
}

/** Neighborhood name for a point inside Providence, or null (outside / data not loaded yet). */
export async function neighborhoodAt(lat: number, lng: number): Promise<string | null> {
  return hoodOfSync(await load(), lat, lng);
}

/** Bounding box of a hood's rings ([lng, lat] input → south/west/north/east). Same as shared's ringBounds. */
export function ringBounds(rings: Rings): { south: number; west: number; north: number; east: number } {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const ring of rings) for (const [lng, lat] of ring) {
    if (lat < south) south = lat; if (lat > north) north = lat;
    if (lng < west) west = lng; if (lng > east) east = lng;
  }
  return { south, west, north, east };
}

/** URL slug for `?n=`: lower-case, runs of whitespace → '-' ("Upper South Providence" → "upper-south-providence").
 *  Same as shared's hoodSlug (the Worker's /week slugs must match the app's). */
export const hoodSlug = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, '-');

/** The hood name for a slug (case-insensitive), or null when it is not one of the 25. */
export function hoodFromSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const s = slug.trim().toLowerCase();
  return NEIGHBORHOOD_NAMES.find((n) => hoodSlug(n) === s) ?? null;
}
