// Download every public source the classifier uses into data/raw/ (gitignored).
// One command rebuilds from scratch: `npm run rebuild` (fetch → build-db → citywide).
// No keys needed. Sources and why each matters are in DATA_REPORT.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = join(import.meta.dirname, '..', 'data', 'raw');
const SOCRATA = 'https://data.providenceri.gov';
const ARCGIS = 'https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services'; // City of Providence GIS
const HUD = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services'; // HUD eGIS open data

type Source =
  | { name: string; kind: 'socrata'; id: string; select?: string }
  | { name: string; kind: 'arcgis'; service: string; layer?: number; geometry?: boolean; base?: string; where?: string; fields?: string; order?: string };

export const SOURCES: Source[] = [
  // FY2026 roll (assessment date 12/31/2024, billed Jul 2025). Owner-occupancy levy codes, class, owner + mailing address.
  { name: 'taxroll2026', kind: 'socrata', id: 'p9dd-mw2m', select: '*, :@computed_region_ueqj_g33x, :@computed_region_asue_2ipu' },
  // Prior-year roll, only to measure how often the owner-occupied flag changes year to year (DATA_REPORT.md).
  { name: 'taxroll2025', kind: 'socrata', id: '6ub4-iebe', select: 'tax_map, levy_code_1, class' },
  // Neighborhood polygons the roll's computed region column points into (names only).
  { name: 'neighborhoods', kind: 'socrata', id: 'ueqj-g33x', select: '_feature_id, lname' },
  // City GIS parcels joined to the assessor's CAMA extract: unit count, year built, use code.
  { name: 'cama', kind: 'arcgis', service: 'Parcels_with_CAMA' },
  // Providence Housing Authority sites (public housing → regulated affordable).
  { name: 'pha', kind: 'arcgis', service: 'Providence_Housing_Authority', geometry: true, order: 'ObjectId' },
  // HUD: LIHTC projects, project-based assisted multifamily, public housing buildings (regulated affordable).
  { name: 'hud_lihtc', kind: 'arcgis', base: HUD, service: 'LIHTC', where: "PROJ_CTY='PROVIDENCE' AND PROJ_ST='RI'",
    fields: 'HUD_ID,PROJECT,PROJ_ADD,STD_ADDR,N_UNITS,LI_UNITS,YR_PIS,LAT,LON' },
  { name: 'hud_multifamily', kind: 'arcgis', base: HUD, service: 'MULTIFAMILY_PROPERTIES_ASSISTED', where: "PLACED_BASE_CITY_NAME_TEXT='Providence' AND STD_ST='RI'",
    fields: 'PROPERTY_ID,PROPERTY_NAME_TEXT,ADDRESS_LINE1_TEXT,STD_ADDR,TOTAL_UNIT_COUNT,TOTAL_ASSISTED_UNIT_COUNT,PROPERTY_CATEGORY_NAME,EXPIRATION_DATE1,LAT,LON' },
  { name: 'hud_public_housing', kind: 'arcgis', base: HUD, service: 'Public_Housing_Buildings', where: "PARTICIPANT_CODE='RI001'",
    fields: 'NATIONAL_BLDG_ID,PROJECT_NAME,BUILDING_NAME,STD_ADDR,TOTAL_UNITS,BUILDING_TYPE_CODE,LAT,LON' },
];

async function getJson(url: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function fetchSocrata(s: Extract<Source, { kind: 'socrata' }>): Promise<any[]> {
  const rows: any[] = [];
  const page = 50000;
  for (let offset = 0; ; offset += page) {
    const q = new URLSearchParams({ $limit: String(page), $offset: String(offset), $order: ':id' });
    if (s.select) q.set('$select', s.select);
    const batch = await getJson(`${SOCRATA}/resource/${s.id}.json?${q}`);
    rows.push(...batch);
    if (batch.length < page) return rows;
  }
}

async function fetchArcgis(s: Extract<Source, { kind: 'arcgis' }>): Promise<any[]> {
  const base = `${s.base ?? ARCGIS}/${s.service}/FeatureServer/${s.layer ?? 0}/query`;
  const rows: any[] = [];
  const page = 2000;
  for (let offset = 0; ; offset += page) {
    const q = new URLSearchParams({
      where: s.where ?? '1=1', outFields: s.fields ?? '*', returnGeometry: String(!!s.geometry), outSR: '4326',
      orderByFields: s.order ?? 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(page), f: 'json',
    });
    const body = await getJson(`${base}?${q}`);
    if (body.error) throw new Error(`${s.service}: ${JSON.stringify(body.error)}`);
    rows.push(...body.features.map((f: any) => (s.geometry ? { ...f.attributes, _geometry: f.geometry } : f.attributes)));
    if (!body.exceededTransferLimit && body.features.length < page) return rows;
  }
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  const manifest: Record<string, { rows: number; fetchedAt: string; url: string }> = {};
  for (const s of SOURCES) {
    const rows = s.kind === 'socrata' ? await fetchSocrata(s) : await fetchArcgis(s);
    writeFileSync(join(RAW, `${s.name}.json`), JSON.stringify(rows));
    manifest[s.name] = {
      rows: rows.length,
      fetchedAt: new Date().toISOString(),
      url: s.kind === 'socrata' ? `${SOCRATA}/d/${s.id}` : `${s.base ?? ARCGIS}/${s.service}/FeatureServer/${s.layer ?? 0}`,
    };
    console.log(`${s.name}: ${rows.length} rows`);
  }
  writeFileSync(join(RAW, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

if (import.meta.main) await main();
