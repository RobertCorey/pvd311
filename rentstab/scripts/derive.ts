// Derived tables for the map and analysis, written into data/parcels.sqlite after build-db:
//   parcel_status        — every parcel's result under the April 2026 rules, with homes by category
//   owner_groups,
//   parcel_owner_group   — landlord portfolios: owners linked by a shared mailing address or identical name
//   ownership_changes    — owner changes between consecutive rolls FY2013–FY2026, with buyer/seller kind
//   new_housing_by_year  — dwelling units in new-building and conversion permits, by year issued
//   parcel_zoning        — base zoning district at each lot's centroid
//   tract_summary, neighborhood_summary, tract_profile (view) — homes by result next to area measures
// Local analysis tables: individuals' names stay in the local database only; anything published shows entities, never people.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classify } from '../src/classify.ts';
import { DB_PATH, loadParcels } from '../src/db.ts';
import { inRing } from '../src/geo.ts';
import { ownerKey, ownerKind, parseAddress } from '../src/normalize.ts';
import { loadRules } from '../src/rules.ts';
import type { Parcel } from '../src/types.ts';
import { housingMix } from '../src/units.ts';

const ROOT = join(import.meta.dirname, '..');
const raw = (name: string): any[] => JSON.parse(readFileSync(join(ROOT, 'data', 'raw', `${name}.json`), 'utf8'));

function insertAll(db: DatabaseSync, table: string, cols: string[], rows: unknown[][], key?: string) {
  db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(`CREATE TABLE ${table} (${cols.map((c) => `"${c}"`).join(', ')}${key ? `, PRIMARY KEY (${key})` : ''})`);
  const ins = db.prepare(`INSERT INTO ${table} VALUES (${cols.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  for (const r of rows) ins.run(...(r as any[]));
  db.exec('COMMIT');
  console.log(`${table}: ${rows.length} rows`);
}

/** Mailing address as a grouping key: "123 main st|providence" or "po box 4021|02940". */
function mailKey(p: Parcel): string | null {
  const street = (p.mailingStreet ?? '').toLowerCase();
  const city = (p.mailingCity ?? '').toLowerCase();
  const zip = city.match(/\d{5}/)?.[0] ?? '';
  const box = street.match(/p\.?\s*o\.?\s*box\s*(\d+)/);
  if (box) return `po box ${box[1]}|${zip}`;
  const a = parseAddress(street);
  return a ? `${a.lo} ${a.street}|${city.replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] ?? ''}` : null;
}

function main() {
  const rules = loadRules(join(ROOT, 'rules', 'ordinance-2026-04.yaml'));
  const parcels = loadParcels();
  const db = new DatabaseSync(DB_PATH);

  // 1. Each parcel's result.
  const results = parcels.map((p) => ({ p, c: classify(p, rules) }));
  const mixes = results.map(({ p, c }) => housingMix(p, c, rules));
  insertAll(db, 'parcel_status', ['parcelId', 'status', 'rule', 'reason', 'homes', 'owned', 'controlled', 'market', 'subsidized', 'unclear'],
    results.map(({ p, c }, i) => [p.id, c.status, c.rule, c.reasons[0], mixes[i].units, mixes[i].owned, mixes[i].controlled, mixes[i].market, mixes[i].subsidized, mixes[i].unclear]), 'parcelId');

  // 2. Landlord portfolios over non-owner-occupied residential parcels with homes: union owners that share a mailing
  //    address or an identical normalized name (LLCs with different names but one office address end up together).
  const rentalIdx = results.map((r, i) => i).filter((i) => mixes[i].units > 0 && results[i].p.ownerOccupiedTaxRate !== true);
  const parent = new Map<number, number>();
  const find = (x: number): number => { while (parent.get(x)! !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const i of rentalIdx) parent.set(i, i);
  const firstBy = new Map<string, number>();
  for (const i of rentalIdx) {
    const p = results[i].p;
    // Shared names only link entities and trusts; common personal names would join strangers.
    const keys = [mailKey(p) && `m:${mailKey(p)}`, p.ownerKind !== 'person' && p.ownerKey ? `n:${p.ownerKey}` : null].filter(Boolean) as string[];
    for (const k of keys) { const f = firstBy.get(k); if (f === undefined) firstBy.set(k, i); else union(i, f); }
  }
  const groups = new Map<number, number[]>();
  for (const i of rentalIdx) { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(i); }
  const groupRows: unknown[][] = [], memberRows: unknown[][] = [];
  let gid = 0;
  for (const members of [...groups.values()].sort((a, b) => b.length - a.length)) {
    gid++;
    const ps = members.map((i) => results[i].p);
    const entities = [...new Set(ps.filter((p) => p.ownerKind === 'entity').map((p) => p.owner))];
    const sum = (k: 'units' | 'controlled' | 'market' | 'unclear' | 'subsidized') => members.reduce((a, i) => a + mixes[i][k], 0);
    groupRows.push([gid, members.length, sum('units'), sum('controlled'), sum('market'), sum('subsidized'), sum('unclear'),
      entities.length, ps.filter((p) => p.ownerKind !== 'entity').length, entities.slice(0, 5).join('; ')]);
    for (const p of ps) memberRows.push([p.id, gid]);
  }
  insertAll(db, 'owner_groups', ['groupId', 'parcels', 'homes', 'controlled', 'market', 'subsidized', 'unclear', 'entity_parcels', 'non_entity_parcels', 'sample_entities'], groupRows, 'groupId');
  insertAll(db, 'parcel_owner_group', ['parcelId', 'groupId'], memberRows, 'parcelId');

  // 3. Ownership changes between consecutive rolls (owner name keys differ), FY2021 → FY2026.
  const ownerByYear = new Map<number, Map<string, { key: string | null; kind: string }>>();
  const nameOf = (r: any) => (r.company?.trim() || r.owner_company?.trim() || [r.first_name ?? r.owner_first_name, r.last_name ?? r.owner_last_name].filter(Boolean).join(' '));
  for (const y of [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]) {
    const m = new Map<string, { key: string | null; kind: string }>();
    for (const r of raw(`taxroll${y}`)) { const n = nameOf(r); m.set(String(r.tax_map ?? r.plat_lot_unit).trim(), { key: ownerKey(n), kind: ownerKind(n) }); }
    ownerByYear.set(y, m);
  }
  ownerByYear.set(2026, new Map(parcels.map((p) => [p.id, { key: p.ownerKey, kind: p.ownerKind }])));
  const residential = new Set(parcels.filter((p, i) => mixes[i].units > 0).map((p) => p.id));
  const changes: unknown[][] = [];
  for (let y = 2014; y <= 2026; y++) {
    const before = ownerByYear.get(y - 1)!, after = ownerByYear.get(y)!;
    for (const [id, a] of after) {
      const b = before.get(id);
      if (!b || !a.key || !b.key || a.key === b.key || !residential.has(id)) continue;
      // Name fields changed shape in FY2014 (one field → first/last) and FY2017 (company field added): only pairs inside
      // the FY2017+ format compare cleanly.
      changes.push([id, y, b.kind, a.kind, y >= 2018 ? 1 : 0]);
    }
  }
  insertAll(db, 'ownership_changes', ['parcelId', 'roll_year', 'seller_kind', 'buyer_kind', 'comparable'], changes);
  db.exec('CREATE INDEX ownership_changes_parcel ON ownership_changes (parcelId)');

  // 4. New housing supply from permits.
  const supply = db.prepare(`SELECT substr(issued, 1, 4) AS year, kind, COUNT(*) AS permits, SUM(COALESCE(units, 0)) AS units
    FROM permits WHERE kind IN ('new_residential', 'conversion') AND issued IS NOT NULL GROUP BY 1, 2 ORDER BY 1`).all() as any[];
  insertAll(db, 'new_housing_by_year', ['year', 'kind', 'permits', 'units'], supply.map((r) => [r.year, r.kind, r.permits, r.units]));
  // 5. Base zoning district at each lot's centroid. Esri rings mix outer rings and holes, so a point is inside when an odd
  //    number of a zone's rings contain it.
  const zones = raw('zoning').map((z) => {
    const rings: number[][][] = z._geometry?.rings ?? [], pts = rings.flat();
    return { code: z.Code, district: z.District, rings,
      box: [Math.min(...pts.map((c) => c[0])), Math.min(...pts.map((c) => c[1])), Math.max(...pts.map((c) => c[0])), Math.max(...pts.map((c) => c[1]))] };
  });
  const zoneAt = (x: number, y: number) => zones.find((z) => x >= z.box[0] && x <= z.box[2] && y >= z.box[1] && y <= z.box[3]
    && z.rings.filter((r) => inRing(r, x, y)).length % 2 === 1);
  insertAll(db, 'parcel_zoning', ['parcelId', 'zone', 'district'], parcels.flatMap((p) => {
    const z = p.lat != null && p.lng != null ? zoneAt(p.lng, p.lat) : undefined;
    return z ? [[p.id, z.code, z.district]] : [];
  }), 'parcelId');

  // 6. Area summaries (tract and neighborhood): homes by result next to the other area measures. Data prep only.
  for (const [table, col] of [['tract_summary', 'tract'], ['neighborhood_summary', 'neighborhood']] as const) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(`CREATE TABLE ${table} AS
      SELECT p.${col} AS area,
        SUM(s.homes) AS homes, SUM(s.owned) AS owned, SUM(s.controlled) AS controlled, SUM(s.market) AS market,
        SUM(s.subsidized) AS subsidized, SUM(s.unclear) AS unclear,
        SUM(g.str_registrations) AS str_registrations, SUM(g.housing_court_cases) AS housing_court_cases,
        SUM(g.code_cases_active) AS code_cases_active, SUM(g.lead_cert_last_letter IS NOT NULL) AS parcels_with_lead_cert,
        SUM(COALESCE(g.registered_rental_units, 0)) AS registered_rental_units,
        SUM(COALESCE(nu.units, 0)) AS new_units_permitted_since_2022
      FROM parcels p JOIN parcel_status s ON s.parcelId = p.id JOIN parcel_signals g ON g.parcelId = p.id
      LEFT JOIN (SELECT parcelId, SUM(COALESCE(units, 0)) units FROM permits WHERE kind IN ('new_residential', 'conversion') AND issued >= '2022-01-01' GROUP BY parcelId) nu ON nu.parcelId = p.id
      WHERE p.${col} IS NOT NULL GROUP BY p.${col}`);
  }
  // Tract-only measures from the Census, Eviction Lab and HUD.
  db.exec(`DROP VIEW IF EXISTS tract_profile`);
  db.exec(`CREATE VIEW tract_profile AS
    SELECT t.*, s.homes, s.owned, s.controlled, s.market, s.subsidized, s.unclear, s.str_registrations, s.housing_court_cases,
      s.code_cases_active, s.parcels_with_lead_cert, s.registered_rental_units, s.new_units_permitted_since_2022,
      (SELECT SUM(filings) FROM evictions_tract_month e WHERE e.geoid = t.geoid
        AND e.month > (SELECT strftime('%Y-%m', date(MAX(month) || '-01', '-12 months')) FROM evictions_tract_month)) AS eviction_filings_last_12mo
    FROM tracts t LEFT JOIN tract_summary s ON s.area = t.geoid`);
  console.log(`tract_summary: ${(db.prepare('SELECT COUNT(*) n FROM tract_summary').get() as any).n} tracts · neighborhood_summary: ${(db.prepare('SELECT COUNT(*) n FROM neighborhood_summary').get() as any).n} neighborhoods · tract_profile view`);
  db.close();
}

if (import.meta.main) main();
