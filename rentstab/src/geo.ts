// Point-in-polygon helpers shared by the build scripts (GeoJSON-style [lng, lat] rings).

export function inRing(ring: number[][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Inside a polygon (outer ring, minus holes). */
export function inPolygon(rings: number[][][], x: number, y: number): boolean {
  return inRing(rings[0], x, y) && !rings.slice(1).some((h) => inRing(h, x, y));
}

/** Inside a GeoJSON Polygon or MultiPolygon geometry. */
export function inGeometry(g: { type: string; coordinates: any }, x: number, y: number): boolean {
  if (g.type === 'Polygon') return inPolygon(g.coordinates, x, y);
  if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).some((p) => inPolygon(p, x, y));
  return false;
}
