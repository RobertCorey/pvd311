// Build the map into tool/dist/: data.json (parcels + rules + neighborhoods), basemap.json, fonts/, app.js, index.html.
// `npm run build-tool` (needs data/parcels.sqlite from `npm run rebuild`). Serve with `npm run serve`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { parse } from 'yaml';
import { loadParcels } from '../src/db.ts';
import { loadRules } from '../src/rules.ts';
import type { Parcel } from '../src/types.ts';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'tool', 'dist');
const MAPLIBRE = '4.7.1';
const FONTS = { 'NotoSans-Regular': 'Noto%20Sans%20Regular', 'NotoSans-Medium': 'Noto%20Sans%20Medium' };

// Columns the classifier reads (plus id/address/neighborhood/lat/lng for display). Person and trust owner names, mailing
// addresses and the addresses of an owner's other parcels stay out: the page needs flags, not dossiers.
export const COLS = ['id', 'address', 'neighborhood', 'lat', 'lng', 'taxClass', 'taxClassDesc', 'levyCode', 'levyCode2',
  'ownerOccupiedTaxRate', 'owner', 'ownerKind', 'mailingIsProperty', 'camaMatched', 'units', 'yearBuilt', 'bedrooms',
  'bathrooms', 'lastSaleDate', 'ownerOther', 'ownerNameAmbiguous', 'ownerPortfolioUnits', 'homeParcel',
  'homeParcelOwnerOccupied', 'newUnitsPermit', 'razePermitDate', 'affordableSignals'] as const;

const b = (v: boolean | null) => (v == null ? null : v ? 1 : 0);
const r5 = (v: number | null) => (v == null ? null : Math.round(v * 1e5) / 1e5);

function row(p: Parcel): unknown[] {
  const v: Record<(typeof COLS)[number], unknown> = {
    id: p.id, address: p.address, neighborhood: p.neighborhood, lat: r5(p.lat), lng: r5(p.lng), taxClass: p.taxClass,
    taxClassDesc: p.taxClassDesc, levyCode: p.levyCode, levyCode2: p.levyCode2, ownerOccupiedTaxRate: b(p.ownerOccupiedTaxRate),
    owner: p.ownerKind === 'entity' ? p.owner : '', ownerKind: p.ownerKind, mailingIsProperty: b(p.mailingIsProperty),
    camaMatched: b(p.camaMatched), units: p.units, yearBuilt: p.yearBuilt, bedrooms: p.bedrooms, bathrooms: p.bathrooms,
    lastSaleDate: p.lastSaleDate && p.lastSaleDate >= '2024-01-01' ? p.lastSaleDate : null, ownerOther: p.ownerOtherResidential.map((o) => b(o.ownerOccupied)),
    ownerNameAmbiguous: b(p.ownerNameAmbiguous), ownerPortfolioUnits: p.ownerPortfolioUnits, homeParcel: b(p.homeParcelId != null),
    homeParcelOwnerOccupied: b(p.homeParcelOwnerOccupied), newUnitsPermit: p.newUnitsPermit, razePermitDate: p.razePermitDate,
    affordableSignals: p.affordableSignals,
  };
  return COLS.map((c) => v[c]);
}

// Low-cardinality text columns become indexes into a per-column dictionary (the payload drops by ~40%).
export const DICT_COLS = ['neighborhood', 'taxClass', 'taxClassDesc', 'levyCode', 'levyCode2', 'ownerKind'] as const;
function encode(rows: unknown[][]) {
  const dict: Record<string, unknown[]> = {};
  for (const c of DICT_COLS) {
    const i = COLS.indexOf(c);
    const values = [...new Set(rows.map((r) => r[i]))];
    const index = new Map(values.map((v, n) => [v, n]));
    dict[c] = values;
    for (const r of rows) r[i] = index.get(r[i]);
  }
  return { dict, rows };
}

/** Basemap as GeoJSON from the city's own layers (the artifact host can't load outside tiles). */
function basemap(hoods: ReturnType<typeof neighborhoods>) {
  const raw = (n: string) => JSON.parse(readFileSync(join(ROOT, 'data', 'raw', `${n}.json`), 'utf8')) as any[];
  const rd = (ring: number[][]) => ring.map(([x, y]) => [r5(x), r5(y)]);
  const lines = (rows: any[], props: (r: any) => object) => rows.filter((r) => r._geometry?.paths).map((r) => ({
    type: 'Feature', properties: props(r), geometry: { type: 'MultiLineString', coordinates: r._geometry.paths.map(rd) },
  }));
  const polys = (rows: any[], props: (r: any) => object) => rows.filter((r) => r._geometry?.rings).map((r) => ({
    type: 'Feature', properties: props(r), geometry: { type: 'Polygon', coordinates: r._geometry.rings.map(rd) },
  }));
  const title = (n: string) => n.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(St|Ave|Rd|Blvd|Pl|Ct|Ln|Dr|Ter|Sq|Pkwy|Hwy)\b/g, (m) => m);
  const centroid = (poly: (number | null)[][][]) => { let x = 0, y = 0; for (const [a, b] of poly[0]) { x += a ?? 0; y += b ?? 0; } return [r5(x / poly[0].length), r5(y / poly[0].length)]; };
  return {
    roads: { type: 'FeatureCollection', features: lines(raw('basemap_roads'), (r) => ({ name: r.Name ? title(r.Name) : '' })) },
    major: { type: 'FeatureCollection', features: lines(raw('basemap_streets'), (r) => ({ name: r.NAME ? title(r.NAME) : '' })) },
    parks: { type: 'FeatureCollection', features: polys(raw('basemap_parks'), (r) => ({ name: r.PARKNAME ?? '' })) },
    water: { type: 'FeatureCollection', features: polys(raw('basemap_water'), () => ({})) },
    hoods: { type: 'FeatureCollection', features: hoods.map((h) => ({ type: 'Feature', properties: { name: h.name }, geometry: { type: 'MultiPolygon', coordinates: h.polygons } })) },
    hoodLabels: { type: 'FeatureCollection', features: hoods.map((h) => {
      const biggest = h.polygons.reduce((a, b) => (b[0].length > a[0].length ? b : a));
      return { type: 'Feature', properties: { name: h.name.toUpperCase() }, geometry: { type: 'Point', coordinates: centroid(biggest) } };
    }) },
  };
}

function neighborhoods() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'neighborhoods.json'), 'utf8')) as any[];
  const round = (ring: number[][]) => ring.map(([x, y]) => [r5(x), r5(y)]);
  return raw.map((n) => ({ name: n.lname as string, polygons: (n.the_geom.coordinates as number[][][][]).map((poly) => poly.map(round)) }));
}

async function main() {
  mkdirSync(DIST, { recursive: true });
  const parcels = loadParcels();
  const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'manifest.json'), 'utf8'));
  const data = {
    generated: new Date().toISOString().slice(0, 10),
    fetched: manifest.taxroll2026?.fetchedAt?.slice(0, 10),
    rules: loadRules(join(ROOT, 'rules', 'ordinance-2026-04.yaml')),
    presets: parse(readFileSync(join(ROOT, 'rules', 'presets.yaml'), 'utf8')),
    acs: { label: 'ACS 2020–2024 5-year', housingUnits: 79423, renterOccupied: 41896, vacantForRent: 3436 },
    neighborhoods: neighborhoods(),
    cols: COLS,
    ...encode(parcels.map(row)),
  };
  writeFileSync(join(DIST, 'data.json'), JSON.stringify(data));
  writeFileSync(join(DIST, 'basemap.json'), JSON.stringify(basemap(data.neighborhoods)));
  for (const [name, remote] of Object.entries(FONTS)) {
    mkdirSync(join(DIST, 'fonts', name), { recursive: true });
    const buf = Buffer.from(await (await fetch(`https://protomaps.github.io/basemaps-assets/fonts/${remote}/0-255.pbf`)).arrayBuffer());
    // Glyph PBFs ship under a .woff name: the artifact host only serves standard web types, and MapLibre reads raw bytes.
    writeFileSync(join(DIST, 'fonts', name, '0-255.woff'), buf);
  }

  await build({
    entryPoints: [join(ROOT, 'tool', 'main.ts')], bundle: true, format: 'iife', target: 'es2020', minify: true,
    outfile: join(DIST, 'app.js'), logLevel: 'warning',
  });

  // MapLibre's script loads from cdnjs; its stylesheet must be inlined (the artifact CSP allows no external CSS).
  const css = await (await fetch(`https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/${MAPLIBRE}/maplibre-gl.min.css`)).text();
  const html = readFileSync(join(ROOT, 'tool', 'index.html'), 'utf8').replace('/*MAPLIBRE_CSS*/', css);
  writeFileSync(join(DIST, 'index.html'), html);
  const kb = (f: string) => Math.round(readFileSync(join(DIST, f)).length / 1024);
  console.log(`tool/dist: data.json ${kb('data.json')} KB · basemap.json ${kb('basemap.json')} KB · app.js ${kb('app.js')} KB · index.html ${kb('index.html')} KB · ${parcels.length} parcels`);
}

if (import.meta.main) await main();
