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

/** Point → indexes of the lots containing it (grid-bucketed bounding boxes, then ray casting on the outer ring). */
export function lotIndex(rings: (number[][][] | null)[]) {
  const CELL = 0.002, grid = new Map<string, number[]>();
  const boxes = rings.map((r) => {
    if (!r) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  });
  boxes.forEach((bx, i) => {
    if (!bx) return;
    for (let gx = Math.floor(bx[0] / CELL); gx <= Math.floor(bx[2] / CELL); gx++)
      for (let gy = Math.floor(bx[1] / CELL); gy <= Math.floor(bx[3] / CELL); gy++) {
        const k = `${gx},${gy}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
  });
  return (x: number, y: number): number[] => {
    const cands = grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? [];
    return cands.filter((i) => { const b = boxes[i]!; return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inRing(rings[i]![0], x, y); });
  };
}
