// Field fill rates + distributions behind DATA_REPORT.md. `node scripts/profile.ts > data/profile.md`
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = join(import.meta.dirname, '..', 'data');
const db = new DatabaseSync(join(DATA, 'parcels.sqlite'), { readOnly: true });
const all = (sql: string) => db.prepare(sql).all() as Record<string, any>[];
const RES = `taxClass IN ('1','2','23','04-05U','03-610','03-11+','04-610','04-11+')`;

function table(title: string, rows: Record<string, any>[]) {
  console.log(`\n### ${title}\n`);
  if (!rows.length) return console.log('(none)');
  const cols = Object.keys(rows[0]);
  console.log(`| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${cols.map((c) => String(r[c] ?? '∅').replace(/\|/g, '/')).join(' | ')} |`);
}

const manifest = JSON.parse(readFileSync(join(DATA, 'raw', 'manifest.json'), 'utf8'));
table('Sources', Object.entries(manifest).map(([k, v]: any) => ({ source: k, rows: v.rows, fetched: v.fetchedAt.slice(0, 10), url: v.url })));

const fields: [string, string][] = [
  ['levyCode (owner-occupancy tax rate)', `levyCode IS NOT NULL AND levyCode <> ''`],
  ['ownerOccupiedTaxRate set (OO/NOO)', `ownerOccupiedTaxRate IS NOT NULL`],
  ['owner', `owner <> ''`],
  ['mailingStreet', `mailingStreet IS NOT NULL`],
  ['mailingIsProperty computable', `mailingIsProperty IS NOT NULL`],
  ['neighborhood', `neighborhood IS NOT NULL`],
  ['lat/lng', `lat IS NOT NULL`],
  ['CAMA matched', `camaMatched = 1`],
  ['units (CAMA NumUnits > 0)', `units IS NOT NULL`],
  ['yearBuilt (CAMA > 0)', `yearBuilt IS NOT NULL`],
  ['useCode (CAMA)', `useCode IS NOT NULL`],
  ['lastSaleDate (CAMA)', `lastSaleDate IS NOT NULL`],
];
const fill = (where: string) =>
  fields.map(([name, cond]) => {
    const r = all(`SELECT COUNT(*) n, SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) k FROM parcels WHERE ${where}`)[0];
    return { field: name, filled: r.k, of: r.n, pct: ((100 * r.k) / r.n).toFixed(1) + '%' };
  });
table('Fill rates — all parcels', fill('1=1'));
table('Fill rates — residential classes (1, 2-5 fam, condo, combo, apt)', fill(RES));

table('Tax class × levy code', all(`SELECT taxClass, taxClassDesc, levyCode, COALESCE(levyCode2,'') levyCode2, COUNT(*) parcels, SUM(units) units FROM parcels GROUP BY 1,2,3,4 ORDER BY parcels DESC`));
table('Units by tax class (CAMA NumUnits)', all(`SELECT taxClassDesc, COUNT(*) parcels, SUM(units IS NULL) no_units, SUM(units) units, MAX(units) max FROM parcels GROUP BY 1 ORDER BY units DESC`));
table('2-5 Family: CAMA unit count', all(`SELECT COALESCE(units,'missing/0') units, COUNT(*) parcels, SUM(ownerOccupiedTaxRate=1) owner_occ_rate, SUM(ownerOccupiedTaxRate=0) non_owner_occ_rate FROM parcels WHERE taxClass='2' GROUP BY 1 ORDER BY 1`));
table('Single family: CAMA unit count', all(`SELECT COALESCE(units,'missing/0') units, COUNT(*) parcels FROM parcels WHERE taxClass='1' GROUP BY 1 ORDER BY 1`));
table('Combo (mixed-use) ≤5 units: CAMA unit count', all(`SELECT COALESCE(units,'missing/0') units, COUNT(*) parcels, SUM(levyCode2 LIKE 'OO%') oo2, SUM(levyCode2 LIKE 'NOO%') noo2 FROM parcels WHERE taxClass='04-05U' GROUP BY 1 ORDER BY 1`));

table('Owner-occupied tax rate vs mailing address vs owner type (classes 1, 2, 23)', all(`
  SELECT taxClassDesc, CASE ownerOccupiedTaxRate WHEN 1 THEN 'OO rate' ELSE 'NOO rate' END rate,
         CASE mailingIsProperty WHEN 1 THEN 'mail = property' WHEN 0 THEN 'mail elsewhere' ELSE 'unparseable' END mailing,
         ownerKind, COUNT(*) parcels
  FROM parcels WHERE taxClass IN ('1','2','23') GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`));
table('NOO rate + mailing = property + person owner, by last sale year', all(`
  SELECT CASE WHEN lastSaleDate IS NULL THEN 'unknown' WHEN lastSaleDate < '2024-01-01' THEN 'before 2024' ELSE substr(lastSaleDate,1,4) END sold,
         COUNT(*) parcels FROM parcels WHERE taxClass IN ('1','2') AND ownerOccupiedTaxRate=0 AND mailingIsProperty=1 AND ownerKind='person' GROUP BY 1`));
table('OO rate by owner type (classes 1, 2, 23)', all(`SELECT ownerKind, SUM(ownerOccupiedTaxRate=1) oo, SUM(ownerOccupiedTaxRate=0) noo FROM parcels WHERE taxClass IN ('1','2','23') GROUP BY 1`));

{
  const prev = new Map(JSON.parse(readFileSync(join(DATA, 'raw', 'taxroll2025.json'), 'utf8')).map((r: any) => [r.tax_map, String(r.levy_code_1 ?? '')]));
  const flips: Record<string, number> = {};
  for (const r of all(`SELECT id, levyCode FROM parcels WHERE taxClass IN ('1','2','23')`)) {
    const before = prev.get(r.id) as string | undefined;
    const b = before === undefined ? 'no FY2025 row' : /^OO/.test(before) ? 'OO' : /^NO/.test(before) ? 'NOO' : before;
    const key = `FY2025 ${b} → FY2026 ${/^OO/.test(r.levyCode) ? 'OO' : 'NOO'}`;
    flips[key] = (flips[key] ?? 0) + 1;
  }
  table('Owner-occupied flag, FY2025 roll → FY2026 roll (classes 1, 2, 23)', Object.entries(flips).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ change: k, parcels: v })));
}
table('Year built (residential classes)', all(`
  SELECT CASE WHEN yearBuilt IS NULL THEN 'missing' WHEN yearBuilt < 1900 THEN '<1900' WHEN yearBuilt < 1950 THEN '1900–1949'
              WHEN yearBuilt < 2000 THEN '1950–1999' WHEN yearBuilt < 2010 THEN '2000–2009' WHEN yearBuilt < 2016 THEN '2010–2015'
              ELSE '2016+' END built, COUNT(*) parcels, SUM(units) units FROM parcels WHERE ${RES} GROUP BY 1 ORDER BY 1`));
table('Year built 2014+ by year (all classes with units)', all(`SELECT yearBuilt, COUNT(*) parcels, SUM(units) units FROM parcels WHERE yearBuilt >= 2014 AND units > 0 GROUP BY 1 ORDER BY 1`));
table('Most common year-built values (decade rounding)', all(`SELECT yearBuilt, COUNT(*) parcels FROM parcels WHERE ${RES} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`));

table('Condos: units per plat-lot (building)', all(`
  SELECT CASE WHEN condoBuildingUnits <= 3 THEN condoBuildingUnits || '' WHEN condoBuildingUnits <= 5 THEN '4–5' WHEN condoBuildingUnits <= 10 THEN '6–10'
              WHEN condoBuildingUnits <= 50 THEN '11–50' ELSE '51+' END building_units,
         COUNT(*) condo_parcels, SUM(ownerOccupiedTaxRate=1) oo_rate, SUM(ownerOccupiedTaxRate=0) noo_rate FROM parcels WHERE taxClass='23' GROUP BY 1 ORDER BY MIN(condoBuildingUnits)`));
table('Condos: CAMA unit count per condo parcel', all(`SELECT COALESCE(units,'missing/0') units, COUNT(*) FROM parcels WHERE taxClass='23' GROUP BY 1`));

table('Affordable-housing signals', all(`SELECT affordableSignals, COUNT(*) parcels, SUM(units) units FROM parcels WHERE affordableSignals <> '[]' GROUP BY 1 ORDER BY 2 DESC`));
table('Owner portfolio (residential, normalized owner name)', all(`
  SELECT ownerKind, CASE WHEN ownerOtherResidentialParcels = 0 THEN '0' WHEN ownerOtherResidentialParcels = 1 THEN '1' WHEN ownerOtherResidentialParcels <= 4 THEN '2–4' ELSE '5+' END others,
         COUNT(*) parcels FROM parcels WHERE ${RES} GROUP BY 1,2 ORDER BY 1,2`));

table('Example rows', all(`SELECT id, address, taxClassDesc, levyCode, units, yearBuilt, ownerKind, mailingIsProperty, neighborhood FROM parcels WHERE id IN (
  SELECT id FROM parcels WHERE taxClass='2' AND units=3 LIMIT 2) OR id IN (SELECT id FROM parcels WHERE taxClass='23' LIMIT 2)
  OR id IN (SELECT id FROM parcels WHERE taxClass='03-11+' LIMIT 1) OR id IN (SELECT id FROM parcels WHERE levyCode='8LAW' LIMIT 1)
  OR id IN (SELECT id FROM parcels WHERE taxClass='83' AND units > 0 LIMIT 1)`));
