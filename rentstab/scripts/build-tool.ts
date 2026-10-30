// Build the policy tool into tool/dist/: data.json (parcels + rules + presets + neighborhoods), app.js, index.html.
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
const LEAFLET = '1.9.4';

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

function neighborhoods() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'raw', 'neighborhoods.json'), 'utf8')) as any[];
  const round = (ring: number[][]) => ring.filter((_, i) => i % 2 === 0 || i === ring.length - 1).map(([x, y]) => [r5(x), r5(y)]);
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

  await build({
    entryPoints: [join(ROOT, 'tool', 'main.ts')], bundle: true, format: 'iife', target: 'es2020', minify: true,
    outfile: join(DIST, 'app.js'), logLevel: 'warning',
  });

  // Leaflet's script loads from cdnjs; its stylesheet must be inlined (the artifact CSP allows no external CSS).
  const css = await (await fetch(`https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET}/leaflet.min.css`)).text();
  const html = readFileSync(join(ROOT, 'tool', 'index.html'), 'utf8').replace('/*LEAFLET_CSS*/', css.replace(/url\([^)]*\)/g, 'none'));
  writeFileSync(join(DIST, 'index.html'), html);
  const kb = (f: string) => Math.round(readFileSync(join(DIST, f)).length / 1024);
  console.log(`tool/dist: data.json ${kb('data.json')} KB · app.js ${kb('app.js')} KB · index.html ${kb('index.html')} KB · ${parcels.length} parcels`);
}

if (import.meta.main) await main();
