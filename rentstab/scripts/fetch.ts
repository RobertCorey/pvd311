// Download every public source the classifier uses into data/raw/ (gitignored).
// One command rebuilds from scratch: `npm run rebuild` (fetch → build-db → citywide).
// No keys needed. Sources and why each matters are in DATA_REPORT.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = join(import.meta.dirname, '..', 'data', 'raw');
const SOCRATA = 'https://data.providenceri.gov';
const ARCGIS = 'https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services'; // City of Providence GIS
const HUD = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services'; // HUD eGIS open data
const RIGIS = 'https://services2.arcgis.com/S8zZg9pg23JUEexQ/arcgis/rest/services'; // RIGIS (URI) statewide layers

type Source =
  | { name: string; kind: 'socrata'; id: string; select?: string }
  | { name: string; kind: 'json'; url: string }
  | { name: string; kind: 'csv'; url: string; browserUA?: boolean }
  | { name: string; kind: 'arcgis'; service: string; layer?: number; geometry?: boolean; base?: string; where?: string; fields?: string; order?: string;
      /** Douglas-Peucker tolerance in degrees (outSR 4326) — basemap layers only. */ simplify?: number; centroid?: boolean };

export const SOURCES: Source[] = [
  // FY2026 roll (assessment date 12/31/2024, billed Jul 2025). Owner-occupancy levy codes, class, owner + mailing address.
  { name: 'taxroll2026', kind: 'socrata', id: 'p9dd-mw2m', select: '*, :@computed_region_ueqj_g33x, :@computed_region_asue_2ipu' },
  // Prior-year roll, only to measure how often the owner-occupied flag changes year to year (DATA_REPORT.md).
  { name: 'taxroll2025', kind: 'socrata', id: '6ub4-iebe', select: 'tax_map, levy_code_1, class' },
  // Older rolls: owner-occupied flag history (an owner who held the OO rate in recent years and still owns the place
  // very likely still lives there, even if the certification lapsed).
  { name: 'taxroll2024', kind: 'socrata', id: 'xvti-7dtw', select: 'tax_map, levy_code_1, first_name, last_name, company' },
  { name: 'taxroll2023', kind: 'socrata', id: 'fd8d-n74v', select: 'tax_map, levy_code_1, first_name, last_name, company' },
  { name: 'taxroll2022', kind: 'socrata', id: 'c3q4-f95q', select: 'tax_map, levy_code_1, first_name, last_name, company' },
  { name: 'taxroll2021', kind: 'socrata', id: 'fawc-z8zq', select: 'tax_map, levy_code_1, owner_first_name, owner_last_name, owner_company' },
  // Neighborhood polygons the roll's computed region column points into (names + outlines for the map).
  { name: 'neighborhoods', kind: 'socrata', id: 'ueqj-g33x', select: '_feature_id, lname, the_geom' },
  // City GIS parcels joined to the assessor's CAMA extract: unit count, year built, use code.
  { name: 'cama', kind: 'arcgis', service: 'Parcels_with_CAMA' },
  // Lot centers (the roll's points sit on the street, where the address was geocoded): dots are drawn here.
  { name: 'cama_centroids', kind: 'arcgis', service: 'Parcels_with_CAMA', fields: 'PROPID', centroid: true },
  // Providence Housing Authority sites (public housing → regulated affordable).
  { name: 'pha', kind: 'arcgis', service: 'Providence_Housing_Authority', geometry: true, order: 'ObjectId' },
  // Building permits. Socrata "2009-2018" actually holds Dec 2016 – Jan 2020; the ArcGIS map holds Jan 2019 – Mar 2024.
  // No certificate-of-occupancy records in either; new-building / conversion permits stand in for CO dates.
  { name: 'permits_2016_2020', kind: 'socrata', id: 'ufmm-rbej',
    select: 'permitnum, permittype, permitclass, workclass, pin, originaladdress1, description, estprojectcost, issueddate, completeddate, statuscurrent, proposeduse, totalsqft' },
  { name: 'permits_2019_2024', kind: 'arcgis', service: 'Interactive_Permitting_Map_(BETA)', order: 'ObjectId',
    fields: 'Record__,Record_Type,Date_Submitted,Permit_License_Issued_Date,Address,Mbl,Record_Status,Project_Cost,Description_of_Work,Structure_Type,Occupancy_Type' },
  // Basemap layers for the map (the artifact host allows no outside tiles): named streets, parks, water parcels.
  { name: 'basemap_streets', kind: 'arcgis', service: 'Labelled_Streets', geometry: true, fields: 'NAME,SUM_ROADCLASS,MAX_ROADTYPE', simplify: 0.00002 },
  { name: 'basemap_roads', kind: 'arcgis', service: 'City_Maintained_Roads', geometry: true, fields: 'Name,Funcitonal', simplify: 0.00001 },
  // Lot outlines (simplified) — the map shades lots with no homes on record.
  { name: 'parcel_shapes', kind: 'arcgis', service: 'Parcels_with_CAMA', geometry: true, fields: 'PROPID', simplify: 0.000008 },
  // Every street address (state E-911 points): a lot like 280 Waterman St also holds 209–221 Medway St.
  { name: 'address_points', kind: 'arcgis', base: RIGIS, service: 'FACILITY_AddressPoints_E911domains', layer: 5, geometry: true,
    where: "municipality='PROVIDENCE' AND addrnum IS NOT NULL", fields: 'addrnum,addrnumsuf,fullname,pointtype' },
  // Building footprints (city GIS), colored by their lot's result at street zoom.
  { name: 'building_shapes', kind: 'arcgis', service: 'Buildings_layer', geometry: true, fields: 'OBJECTID', simplify: 0.000005 },
  { name: 'basemap_parks', kind: 'arcgis', service: 'Parks_And_Open_Space', geometry: true, fields: 'PARKNAME,ACRES', simplify: 0.00002 },
  { name: 'basemap_water', kind: 'arcgis', service: 'Parcels_with_CAMA', geometry: true, where: "POLY_TYPE='WATER'", fields: 'OBJECTID', simplify: 0.00002 },
  // Census tracts (ACS 2020–2024 5-year via Census Reporter, no key): income overall and for renters, race/ethnicity,
  // tenure, median gross rent, rent burden — plus tract outlines. For who-is-covered comparisons by area.
  { name: 'acs_tracts', kind: 'json', url: 'https://api.censusreporter.org/1.0/data/show/latest?table_ids=B19013,B25119,B03002,B25003,B25064,B25071&geo_ids=140|16000US4459000' },
  { name: 'acs_tract_shapes', kind: 'json', url: 'https://api.censusreporter.org/1.0/geo/show/tiger2023?geo_ids=140|16000US4459000' },
  // Eviction filings by tract and month, Jan 2020 → now (Eviction Lab ETS; data from RIHousing / the courts).
  // Their CDN refuses non-browser user agents for this public CSV.
  { name: 'evictions_tracts', kind: 'csv', url: 'https://evictionlab.org/uploads/providence_monthly_2020_2021.csv', browserUA: true },
  // Zillow Observed Rent Index (asking rents), monthly: city and ZIP files (we keep the Providence rows).
  { name: 'zori_city', kind: 'csv', url: 'https://files.zillowstatic.com/research/public_csvs/zori/City_zori_uc_sfrcondomfr_sm_month.csv' },
  { name: 'zori_zip', kind: 'csv', url: 'https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv' },
  // All building permits Dec 2016 → 2026-09-15: the city's OpenGov export, released publicly in response to records
  // request 26-2355 (providenceri.nextrequest.com). Has "Type of Improvement" and "Number of Dwelling Units"; no parcel id.
  { name: 'permits_2016_2026', kind: 'csv', url: 'https://providenceri.nextrequest.com/documents/70401717/download' },
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
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'pvd-rentstab/0.1 (Providence rent-stabilization data spike; fixmypvd.org)' } });
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
  // Advance by what came back: some layers cap pages below 2000 (maxRecordCount 1000) and flag exceededTransferLimit.
  for (let offset = 0; ; ) {
    const q = new URLSearchParams({
      where: s.where ?? '1=1', outFields: s.fields ?? '*', returnGeometry: String(!!s.geometry), outSR: '4326',
      orderByFields: s.order ?? 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(page), f: 'json',
    });
    if (s.simplify) { q.set('maxAllowableOffset', String(s.simplify)); q.set('geometryPrecision', '6'); }
    if (s.centroid) q.set('returnCentroid', 'true');
    const body = await getJson(`${base}?${q}`);
    if (body.error) throw new Error(`${s.service}: ${JSON.stringify(body.error)}`);
    rows.push(...body.features.map((f: any) => ({ ...f.attributes, ...(s.geometry ? { _geometry: f.geometry } : {}), ...(s.centroid ? { _centroid: f.centroid } : {}) })));
    offset += body.features.length;
    if (!body.features.length || (!body.exceededTransferLimit && body.features.length < page)) return rows;
  }
}

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
async function getText(url: string, browserUA = false): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': browserUA ? BROWSER_UA : 'pvd-rentstab/0.1 (Providence rent-stabilization data spike; fixmypvd.org)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  // ONLY=name,name refetches a subset and keeps the rest of the manifest.
  const only = process.env.ONLY?.split(',').map((x) => x.trim());
  const manifestPath = join(RAW, 'manifest.json');
  const manifest: Record<string, { rows: number; fetchedAt: string; url: string }> =
    only && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  for (const s of SOURCES) {
    if (only && !only.includes(s.name)) continue;
    if (s.kind === 'csv') {
      const text = await getText(s.url, s.browserUA);
      if (!/^[^<]/.test(text) || !text.includes(',')) throw new Error(`${s.name}: expected CSV, got ${text.slice(0, 80)}`);
      writeFileSync(join(RAW, `${s.name}.csv`), text);
      manifest[s.name] = { rows: text.split('\n').length - 2, fetchedAt: new Date().toISOString(), url: s.url };
      console.log(`${s.name}: ${manifest[s.name].rows} rows`);
      continue;
    }
    const rows = s.kind === 'socrata' ? await fetchSocrata(s) : s.kind === 'json' ? await getJson(s.url) : await fetchArcgis(s);
    writeFileSync(join(RAW, `${s.name}.json`), JSON.stringify(rows));
    manifest[s.name] = {
      rows: Array.isArray(rows) ? rows.length : Object.keys(rows.data ?? rows.features ?? {}).length,
      fetchedAt: new Date().toISOString(),
      url: s.kind === 'socrata' ? `${SOCRATA}/d/${s.id}` : s.kind === 'json' ? s.url : `${s.base ?? ARCGIS}/${s.service}/FeatureServer/${s.layer ?? 0}`,
    };
    console.log(`${s.name}: ${manifest[s.name].rows} rows`);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

if (import.meta.main) await main();
