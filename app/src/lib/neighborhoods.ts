/** Providence's 25 official neighborhoods, first-class in the UI ("Fox Point · 3 open").
 *  Point-in-polygon over simplified city GIS rings; the data module is lazy so it never hits the main bundle. */
let data: Promise<Record<string, [number, number][][]>> | null = null;
const load = () => (data ??= import('./neighborhoods.data').then((m) => m.NEIGHBORHOODS));

function inRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Neighborhood name for a point inside Providence, or null (outside / data not loaded yet). */
export async function neighborhoodAt(lat: number, lng: number): Promise<string | null> {
  const nb = await load();
  for (const [name, rings] of Object.entries(nb)) for (const r of rings) if (inRing(lng, lat, r)) return name;
  return null;
}

/** Batch helper for lists: resolves each item once, in order. */
export async function neighborhoodsFor(points: { lat: number; lng: number }[]): Promise<(string | null)[]> {
  const nb = await load();
  return points.map(({ lat, lng }) => {
    for (const [name, rings] of Object.entries(nb)) for (const r of rings) if (inRing(lng, lat, r)) return name;
    return null;
  });
}

/** Short display form for tight rows ("Upper South Providence" → "Upper S. Providence"). */
export const shortNeighborhood = (n: string) => n.replace('South Providence', 'S. Providence');
