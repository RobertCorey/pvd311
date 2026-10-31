// Normalize data/raw/*.json into data/parcels.sqlite (table `parcels`, one row per tax-roll parcel).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mailingStreetAndCity, ownerKey, ownerKind, parseAddress, sameAddress, type StreetAddress } from '../src/normalize.ts';
import { readCsv } from '../src/csv.ts';
import { excelDate } from '../src/xlsx.ts';
import { inGeometry, lotIndex } from '../src/geo.ts';
import { newUnitsByParcel, permitKind, permitUnits, type Permit } from '../src/permits.ts';
import type { Parcel } from '../src/types.ts';

const DATA = join(import.meta.dirname, '..', 'data');
const raw = (name: string): any[] => JSON.parse(readFileSync(join(DATA, 'raw', `${name}.json`), 'utf8'));

const RESIDENTIAL_CLASSES = new Set(['1', '2', '23', '04-05U', '03-610', '03-11+', '04-610', '04-11+']);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const pos = (v: unknown): number | null => { const n = num(v); return n && n > 0 ? n : null; };

function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dy = (aLat - bLat) * 111_320;
  const dx = (aLng - bLng) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export function buildParcels(): Parcel[] {
  const roll = raw('taxroll2026');
  const hoods = new Map(raw('neighborhoods').map((h) => [String(h._feature_id), h.lname as string]));
  const cama = new Map<string, any>();
  for (const c of raw('cama')) if (c.PROPID && !cama.has(c.PROPID)) cama.set(c.PROPID, c); // duplicate rows = multipart polygons, identical attributes

  const centroids = new Map<string, { x: number; y: number }>();
  for (const c of raw('cama_centroids')) if (c.PROPID && c._centroid && !centroids.has(c.PROPID)) centroids.set(c.PROPID, c._centroid);
  const parcels: Parcel[] = roll.map((r) => {
    const c = cama.get(r.tax_map);
    const mail = mailingStreetAndCity([r.mailing_2, r.mailing_3, r.mailing_4, r.mailing_5]);
    const levy: string = r.levy_code_1 ?? '';
    const ooRate = /^OO/.test(levy) ? true : /^NOO?/.test(levy) ? false : null;
    const sale = num(c?.SaleDate);
    // Prefer the lot's center; fall back to the roll's geocoded point (which sits on the street).
    const ctr = centroids.get(r.tax_map);
    const pt = ctr ? [ctr.x, ctr.y] : r.property_location?.coordinates;
    const prop = parseAddress(r.formated_address);
    const mailAddr = parseAddress(mail.street);
    return {
      id: r.tax_map,
      address: r.formated_address ?? '',
      neighborhood: hoods.get(String(r[':@computed_region_ueqj_g33x'])) ?? null,
      tract: null,
      lat: pt ? pt[1] : null,
      lng: pt ? pt[0] : null,
      taxClass: r.class ?? '',
      taxClassDesc: r.class_descrip ?? '',
      levyCode: levy,
      levyCode2: r.levy_code_2 ?? null,
      ownerOccupiedTaxRate: ooRate,
      owner: r.owner ?? '',
      ownerKind: ownerKind(r.owner),
      ownerKey: ownerKey(r.owner),
      mailingStreet: mail.street,
      mailingCity: mail.city,
      mailingIsProperty: prop && mailAddr ? sameAddress(prop, mailAddr) && /providence/i.test(mail.city ?? '') : null,
      totalAssessment: num(r.total_assmt),
      totalExempt: num(r.total_exempt),
      camaMatched: !!c,
      units: pos(c?.NumUnits),
      yearBuilt: pos(c?.YearBuilt),
      useCode: c?.MuniUseCode ?? null,
      useDesc: c?.MuniUseCodeDesc ?? null,
      numBuildings: num(c?.NumBldgs),
      bedrooms: num(c?.NumBedRooms),
      bathrooms: num(c?.NumBathrooms),
      lastSaleDate: sale ? new Date(sale).toISOString().slice(0, 10) : null,
      condoBuildingUnits: null,
      ownerOtherResidentialParcels: 0,
      ownerOtherResidential: [],
      ownerNameAmbiguous: false,
      ownerPortfolioUnits: 0,
      homeParcelId: null,
      homeParcelAddress: null,
      homeParcelOwnerOccupied: null,
      homeParcelSameOwner: null,
      newUnitsPermit: null,
      manual: null,
      razePermitDate: null,
      permitCostSince2019: 0,
      affordableSignals: levy === '8LAW' ? ['8law'] : [],
    } satisfies Parcel;
  });

  // Condo buildings: condo units sharing a plat-lot.
  const condoCount = new Map<string, number>();
  const plotOf = (id: string) => id.split('-').slice(0, 2).join('-');
  for (const p of parcels) if (p.taxClass === '23') condoCount.set(plotOf(p.id), (condoCount.get(plotOf(p.id)) ?? 0) + 1);
  for (const p of parcels) if (p.taxClass === '23') p.condoBuildingUnits = condoCount.get(plotOf(p.id)) ?? null;

  // Owner portfolios (residential parcels only), keyed on the normalized owner name.
  const byOwner = new Map<string, Parcel[]>();
  for (const p of parcels) {
    if (!p.ownerKey || !RESIDENTIAL_CLASSES.has(p.taxClass)) continue;
    (byOwner.get(p.ownerKey) ?? byOwner.set(p.ownerKey, []).get(p.ownerKey)!).push(p);
  }
  for (const list of byOwner.values()) {
    // A person has one principal residence: two owner-occupied parcels under one name means two people.
    const ambiguous = !list[0].ownerKey!.startsWith('entity:') && list.filter((q) => q.ownerOccupiedTaxRate).length >= 2;
    const portfolio = list.reduce((a, q) => a + (q.units ?? (['1', '23'].includes(q.taxClass) ? 1 : 0)), 0);
    for (const p of list) {
      p.ownerNameAmbiguous = ambiguous;
      p.ownerPortfolioUnits = portfolio;
      p.ownerOtherResidential = list.filter((q) => q !== p).map((q) => ({ id: q.id, address: q.address, ownerOccupied: q.ownerOccupiedTaxRate }));
      p.ownerOtherResidentialParcels = p.ownerOtherResidential.length;
    }
  }

  for (const p of parcels) if (!p.ownerPortfolioUnits) p.ownerPortfolioUnits = p.units ?? (['1', '23'].includes(p.taxClass) ? 1 : 0);

  // The owner's likely home: a different Providence residential parcel at the owner's mailing address.
  const resByStreet = new Map<string, { p: Parcel; a: StreetAddress }[]>();
  for (const p of parcels) {
    const a = parseAddress(p.address);
    if (a && RESIDENTIAL_CLASSES.has(p.taxClass)) (resByStreet.get(a.street) ?? resByStreet.set(a.street, []).get(a.street)!).push({ p, a });
  }
  for (const p of parcels) {
    if (!RESIDENTIAL_CLASSES.has(p.taxClass) || p.mailingIsProperty || !/providence/i.test(p.mailingCity ?? '')) continue;
    const m = parseAddress(p.mailingStreet);
    if (!m) continue;
    const hits = (resByStreet.get(m.street) ?? []).filter((x) => x.p !== p && sameAddress(x.a, m));
    // Prefer an owner-occupied match (condo buildings share a street address across many unit parcels).
    const home = hits.find((x) => x.p.ownerOccupiedTaxRate && x.p.ownerKey === p.ownerKey) ?? hits.find((x) => x.p.ownerOccupiedTaxRate) ?? hits[0];
    if (!home) continue;
    p.homeParcelId = home.p.id;
    p.homeParcelAddress = home.p.address;
    p.homeParcelOwnerOccupied = home.p.ownerOccupiedTaxRate;
    p.homeParcelSameOwner = !!p.ownerKey && p.ownerKey === home.p.ownerKey;
  }

  // Housing-authority owners.
  for (const p of parcels) if (/housing authority|dept of housing/i.test(p.owner)) p.affordableSignals.push('housing_authority_owner');

  // Affordable-housing lists: match by address (street + overlapping number range), else the nearest multifamily-sized
  // parcel point within 40 m (5+ units, apartment/8LAW/TSA/commercial class). Small houses next door must not inherit a
  // neighbour's subsidy; housing-authority-owned houses are already caught by owner name.
  const parsed = parcels.map((p) => ({ p, a: parseAddress(p.address) }));
  const byStreet = new Map<string, { p: Parcel; a: StreetAddress }[]>();
  for (const x of parsed) if (x.a) (byStreet.get(x.a.street) ?? byStreet.set(x.a.street, []).get(x.a.street)!).push(x as any);
  const tag = (signal: string, addr: string | null, lat: number | null, lng: number | null) => {
    const a = parseAddress(addr);
    const hits = a ? (byStreet.get(a.street) ?? []).filter((x) => sameAddress(x.a, a)) : [];
    if (hits.length) { for (const h of hits) if (!h.p.affordableSignals.includes(signal)) h.p.affordableSignals.push(signal); return 'address'; }
    if (lat == null || lng == null) return 'none';
    let best: Parcel | null = null; let bestD = 40;
    for (const p of parcels) {
      if (p.lat == null || p.lng == null) continue;
      if (!((p.units ?? 0) >= 5 || /^(03|04-(610|11))|^(12|83|6)$/.test(p.taxClass))) continue;
      const d = metres(lat, lng, p.lat, p.lng);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { const s = `${signal}_nearby`; if (!best.affordableSignals.includes(s)) best.affordableSignals.push(s); return 'nearby'; }
    return 'none';
  };
  const matchStats: Record<string, Record<string, number>> = {};
  const count = (src: string, how: string) => ((matchStats[src] ??= {})[how] = (matchStats[src][how] ?? 0) + 1);
  // Projects where only some units are income-restricted get a *_partial signal (the rest of the building is covered).
  for (const r of raw('hud_lihtc')) {
    const partial = num(r.LI_UNITS) != null && num(r.N_UNITS) != null && num(r.LI_UNITS)! < num(r.N_UNITS)!;
    count('hud_lihtc', tag(partial ? 'lihtc_partial' : 'lihtc', r.STD_ADDR?.trim() || r.PROJ_ADD, r.LAT, r.LON));
  }
  for (const r of raw('hud_multifamily')) {
    const partial = num(r.TOTAL_ASSISTED_UNIT_COUNT) != null && num(r.TOTAL_UNIT_COUNT) != null && num(r.TOTAL_ASSISTED_UNIT_COUNT)! < num(r.TOTAL_UNIT_COUNT)!;
    count('hud_multifamily', tag(partial ? 'hud_assisted_partial' : 'hud_assisted', r.STD_ADDR?.trim() || r.ADDRESS_LINE1_TEXT, r.LAT, r.LON));
  }
  for (const r of raw('hud_public_housing')) count('hud_public_housing', tag('public_housing', r.STD_ADDR?.trim(), r.LAT, r.LON));
  for (const r of raw('pha')) count('pha', tag('pha_site', r.Street_Name, r._geometry?.y ?? null, r._geometry?.x ?? null));
  console.log('affordable-list matches:', JSON.stringify(matchStats));

  // Hand-researched labels for big ambiguous buildings (committed, with sources). A researched apartment count
  // replaces the assessor's (which can be hotel rooms, beds or storefronts).
  const manualPath = join(import.meta.dirname, '..', 'manual', 'big-buildings.csv');
  if (existsSync(manualPath)) {
    let applied = 0;
    for (const m of readCsv(readFileSync(manualPath, 'utf8'))) {
      const p = parcels.find((x) => x.id === m.id);
      if (!p) continue;
      const units = m.residential_units ? Number(String(m.residential_units).replace(/[^0-9]/g, '')) || null : null;
      const opened = m.residential_opened ? Number(String(m.residential_opened).match(/\d{4}/)?.[0]) || null : null;
      p.manual = { use: m.use, name: m.name ?? '', residentialUnits: units, opened, conversion: /^y/i.test(m.conversion ?? ''), confidence: m.confidence ?? 'low', sources: m.sources ?? '' };
      if (units != null && m.confidence !== 'low') p.units = units;
      applied++;
    }
    console.log(`manual labels applied: ${applied}`);
  }

  // Census tract for each parcel (point in tract outline).
  const tractShapes = existsSync(join(DATA, 'raw', 'acs_tract_shapes.json')) ? (JSON.parse(readFileSync(join(DATA, 'raw', 'acs_tract_shapes.json'), 'utf8')).features as any[]) : [];
  for (const p of parcels) {
    if (p.lat == null || p.lng == null) continue;
    p.tract = tractShapes.find((f) => inGeometry(f.geometry, p.lng!, p.lat!))?.properties.geoid ?? null;
  }
  console.log(`parcels with a census tract: ${parcels.filter((p) => p.tract).length}/${parcels.length}`);

  // Building permits → normalized table + per-parcel new-units evidence. The 2016–2026 export has addresses only:
  // match them to the roll's addresses, then to the state's E-911 address points (which fall inside a lot).
  const permits = loadPermits(new Set(parcels.map((p) => p.id)), addressMatcher(parcels));
  const byId = new Map(parcels.map((p) => [p.id, p]));
  const plotOfId = (id: string) => id.split('-').slice(0, 2).join('-');
  const byPlot = new Map<string, Parcel[]>();
  for (const p of parcels) (byPlot.get(plotOfId(p.id)) ?? byPlot.set(plotOfId(p.id), []).get(plotOfId(p.id))!).push(p);
  // A permit filed on a lot whose parcels are condo units applies to each unit parcel on that lot.
  const targets = (pid: string) => byId.has(pid) ? [byId.get(pid)!] : (byPlot.get(plotOfId(pid)) ?? []);
  for (const [pid, ev] of newUnitsByParcel(permits)) for (const p of targets(pid)) if (!p.newUnitsPermit || ev.issued > p.newUnitsPermit.issued) p.newUnitsPermit = ev;
  for (const pm of permits) {
    if (!pm.parcelId || !pm.issued) continue;
    for (const p of targets(pm.parcelId)) {
      if (pm.kind === 'raze' && (!p.razePermitDate || pm.issued > p.razePermitDate)) p.razePermitDate = pm.issued;
      if (/building permit/i.test(pm.type) && pm.issued >= '2019-01-01' && byId.has(pm.parcelId)) p.permitCostSince2019 += pm.cost ?? 0;
    }
  }
  const kinds: Record<string, number> = {};
  for (const pm of permits) kinds[pm.kind] = (kinds[pm.kind] ?? 0) + 1;
  console.log(`permits: ${permits.length} (${JSON.stringify(kinds)}); parcels with new-units evidence: ${parcels.filter((p) => p.newUnitsPermit).length}`);
  lastPermits = permits;
  return parcels;
}

let lastPermits: Permit[] = [];

const isoDay = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? null : d.toISOString().slice(0, 10);
};

const rawIf = (name: string): any[] => (existsSync(join(DATA, 'raw', `${name}.json`)) ? raw(name) : []);
const money = (v: string | undefined) => (v ? Number(v.replace(/[$,\s]/g, '')) || null : null);

function writeSignals(db: DatabaseSync, parcels: Parcel[]) {
  const match = addressMatcher(parcels);
  const ids = new Set(parcels.map((p) => p.id));
  const byPlatLot = (plat: string, lot: string) => {
    if (!/^\d+$/.test(plat) || !/^\d+$/.test(lot)) return null;
    const id = `${plat.padStart(3, '0')}-${lot.padStart(4, '0')}-0000`;
    return ids.has(id) ? id : null;
  };
  const table = (name: string, cols: string[], rows: unknown[][]) => {
    db.exec(`CREATE TABLE ${name} (${cols.map((c) => `"${c}"`).join(', ')})`);
    const ins = db.prepare(`INSERT INTO ${name} VALUES (${cols.map(() => '?').join(', ')})`);
    db.exec('BEGIN'); for (const r of rows) ins.run(...(r as any[])); db.exec('COMMIT');
    const matched = rows.filter((r) => r[cols.indexOf('parcelId')]).length;
    db.exec(`CREATE INDEX ${name}_parcel ON ${name}(parcelId)`);
    console.log(`${name}: ${rows.length} rows, ${matched} matched to a parcel`);
  };

  // RIDOH rental registry has no town column: keep rows whose address matches a Providence parcel or street address.
  table('rental_registry', ['address', 'units', 'lead_status', 'pre1978', 'exempt', 'parcelId'],
    rawIf('ridoh_rental_registry').map((r) => [r['Street Address'], Number(r['Number of Units']) || null, r['License Advisory'], r['Built Before 1978'], r['Is Exempt'], match(r['Street Address'] ?? '')])
      .filter((r) => r[5]));
  const strRows = rawIf('str_state_roster').filter((r) => /providence/i.test(r['STR City'] ?? '') && !/north|east/i.test(r['STR City'] ?? ''));
  table('str_registrations', ['license_no', 'status', 'effective', 'expires', 'address', 'unit', 'zip', 'parcelId'],
    strRows.map((r) => [r['License No.'], r['License Status'], isoDay(r['Effective Date']), isoDay(r['Expiration Date']), r['STR Address 1'], r['STR Address 2'], r['STR Zip Code'], match(r['STR Address 1'] ?? '')]));
  table('str_city_permits', ['record', 'type', 'submitted', 'address', 'status', 'parcelId'],
    rawIf('str_city_permits').map((r) => [r['Record #'], r['Record Type'], isoDay(r['Date Submitted']), r.Address, r['Record Status'], match(r.Address ?? '')]));
  // Airbnb coordinates are jittered ~150 m: join through the state registration number instead.
  // Registration numbers appear as "RE.0206009.STR", "RE 0206009-STR, expiry date: …": compare the digits only.
  // Old 5-digit numbers (registrations that lapsed in 2025) have no active roster entry and stay unmatched.
  const regDigits = (x: unknown) => String(x ?? '').match(/RE[ .]?(\d+)/i)?.[1] ?? '';
  const regParcel = new Map(strRows.map((r) => [regDigits(r['License No.']), match(r['STR Address 1'] ?? '')]));
  table('airbnb_listings', ['id', 'room_type', 'price', 'min_nights', 'reviews_ltm', 'availability_365', 'license', 'lat', 'lng', 'parcelId'],
    rawIf('airbnb_listings').filter((r) => r.neighbourhood === 'Providence').map((r) => {
      const lic = String(r.license ?? '').trim();
      return [r.id, r.room_type, money(r.price), Number(r.minimum_nights) || null, Number(r.number_of_reviews_ltm) || 0, Number(r.availability_365) || 0, lic || null, Number(r.latitude), Number(r.longitude), regParcel.get(regDigits(lic)) ?? null];
    }));
  table('housing_court_cases', ['case_no', 'address', 'filed', 'closed', 'receivership', 'final_judgment', 'amount', 'parcelId'],
    rawIf('housing_court_cases').map((r) => {
      const address = [r['Prop.#'], r['Property St']].filter(Boolean).join(' ');
      return [r['CASE NO.'], address, excelDate(r['DATE FILED']), excelDate(r.CLOSED), r.RCVR || null, excelDate(r['FINAL JUDGMENT']), money(r.AMOUNT),
        byPlatLot(r.PLAT, r.LOT) ?? match(address)];
    }));
  // Active code-enforcement cases (owner names dropped at download). Mbl is plat-lot-unit.
  table('code_cases_active', ['record', 'occupancy', 'submitted', 'last_activity', 'status', 'address', 'parcelId'],
    rawIf('code_cases_active').map((r) => {
      const mbl = String(r.Mbl ?? '').trim().toUpperCase();
      return [r['Record #'], r['Occupancy Type'], excelDate(r['Date Submitted']) ?? isoDay(r['Date Submitted']), excelDate(r['Last Record Activity']) ?? isoDay(r['Last Record Activity']),
        r['Record Status'], r.Address, ids.has(mbl) ? mbl : match(r.Address ?? '')];
    }));
  // Lead certificates: one row per address and era (current RIDOH / legacy HRC), matched by street address.
  table('lead_certificates', ['address', 'zip', 'year_built', 'units', 'certificates', 'last_letter', 'era', 'parcelId'],
    rawIf('lead_certificates').map((r) => {
      const address = [r.StrNum, r.StrName, r.StrType].filter(Boolean).join(' ');
      const last = typeof r.last === 'number' ? new Date(r.last).toISOString().slice(0, 10) : null;
      return [address, r.Zip, r.YearBuilt ?? null, r.units ?? null, r.certs ?? null, last && last >= '1990' && last <= '2027-12-31' ? last : null, r.era, match(address)];
    }));
  // Vacant/abandoned registry: street numbers are partly redacted in the release, so join on plat/lot.
  table('vacant_registry', ['address', 'plat', 'lot', 'parcelId'],
    rawIf('vacant_registry').filter((r) => r.ADDRESS || r.PLAT).map((r) => [r.ADDRESS, r.PLAT, r.LOT, byPlatLot(String(r.PLAT ?? ''), String(r.LOT ?? '')) ?? match(r.ADDRESS ?? '')]));
  const taxPath = join(import.meta.dirname, '..', 'manual', 'tax-sale-2026.csv');
  const tax = existsSync(taxPath) ? readCsv(readFileSync(taxPath, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n')) : [];
  table('tax_sale_2026', ['parcelId', 'location', 'face_value', 'total', 'sold'],
    tax.map((r) => [ids.has(r['Parcel Number']) ? r['Parcel Number'] : match(r['Parcel Location'] ?? ''), r['Parcel Location'], money(r['Face Value']), money(r.Total), isoDay(r['Date Purchased'])]));

  // One row per parcel with every signal it has (materialized from grouped joins; the map and analysis read this).
  db.exec(`CREATE TABLE parcel_signals AS
    SELECT p.id AS parcelId,
      rr.units AS registered_rental_units, COALESCE(sr.n, 0) AS str_registrations, COALESCE(sp.n, 0) AS str_city_permits,
      COALESCE(ab.n, 0) AS airbnb_listings, COALESCE(hc.n, 0) AS housing_court_cases, hc.last AS last_housing_court_case,
      COALESCE(ts.n, 0) AS tax_sale_2026, COALESCE(vr.n, 0) AS vacant_registry, COALESCE(cc.n, 0) AS code_cases_active,
      lc.last AS lead_cert_last_letter, lc.units AS lead_cert_units
    FROM parcels p
    LEFT JOIN (SELECT parcelId, SUM(units) units FROM rental_registry GROUP BY parcelId) rr ON rr.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM str_registrations GROUP BY parcelId) sr ON sr.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM str_city_permits GROUP BY parcelId) sp ON sp.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM airbnb_listings GROUP BY parcelId) ab ON ab.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n, MAX(filed) last FROM housing_court_cases GROUP BY parcelId) hc ON hc.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM tax_sale_2026 GROUP BY parcelId) ts ON ts.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM vacant_registry GROUP BY parcelId) vr ON vr.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM code_cases_active GROUP BY parcelId) cc ON cc.parcelId = p.id
    LEFT JOIN (SELECT parcelId, MAX(last_letter) last, MAX(units) units FROM lead_certificates GROUP BY parcelId) lc ON lc.parcelId = p.id`);
  db.exec('CREATE UNIQUE INDEX parcel_signals_id ON parcel_signals(parcelId)');
}

/** Street address → parcel id: the roll's own addresses first, then E-911 address points located inside a lot. */
function addressMatcher(parcels: Parcel[]): (address: string) => string | null {
  const byStreet = new Map<string, { a: StreetAddress; id: string }[]>();
  const put = (street: string, v: { a: StreetAddress; id: string }) => (byStreet.get(street) ?? byStreet.set(street, []).get(street)!).push(v);
  for (const p of parcels) { const a = parseAddress(p.address); if (a) put(a.street, { a, id: p.id }); }
  const shapesPath = join(DATA, 'raw', 'parcel_shapes.json'), pointsPath = join(DATA, 'raw', 'address_points.json');
  if (existsSync(shapesPath) && existsSync(pointsPath)) {
    const shapes = new Map<string, number[][][]>();
    for (const r of raw('parcel_shapes')) if (r.PROPID && r._geometry?.rings && !shapes.has(r.PROPID)) shapes.set(r.PROPID, r._geometry.rings);
    const lotOf = lotIndex(parcels.map((p) => shapes.get(p.id) ?? null));
    for (const pt of raw('address_points')) {
      if (!pt._geometry || !pt.addrnum || !pt.fullname) continue;
      const a = parseAddress(`${pt.addrnum} ${pt.fullname}`);
      const lots = lotOf(pt._geometry.x, pt._geometry.y);
      if (a && lots.length) put(a.street, { a, id: parcels[lots[0]].id });
    }
  }
  return (address: string) => {
    const a = parseAddress(address.split(',')[0]);
    if (!a) return null;
    return (byStreet.get(a.street) ?? []).find((x) => sameAddress(x.a, a))?.id ?? null;
  };
}

/** All permit extracts, normalized and de-duplicated on record number (the newest extract wins for a record). */
export function loadPermits(parcelIds: Set<string>, matchAddress: (address: string) => string | null = () => null): Permit[] {
  const byRecord = new Map<string, Permit>();
  const add = (p: Omit<Permit, 'kind' | 'units'>) => {
    const full: Permit = { ...p, kind: permitKind(p), units: permitUnits(p.description) };
    byRecord.set(p.id, full);
  };
  const pid = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
    return /^\d{3}-\d{4}-\w{4}$/.test(s) ? s : null;
  };
  for (const r of raw('permits_2016_2020')) {
    add({ id: r.permitnum, source: 'socrata_2016_2020', parcelId: pid(r.pin), type: r.permittype ?? '', permitClass: r.permitclass ?? null,
      workClass: r.workclass ?? null, description: r.description ?? '', cost: num(r.estprojectcost), issued: isoDay(r.issueddate),
      completed: isoDay(r.completeddate), status: r.statuscurrent ?? null, address: r.originaladdress1 ?? null });
  }
  for (const r of raw('permits_2019_2024')) {
    add({ id: r.Record__, source: 'arcgis_2019_2024', parcelId: pid(r.Mbl), type: r.Record_Type ?? '', permitClass: r.Structure_Type ?? null,
      workClass: null, description: r.Description_of_Work ?? '', cost: num(r.Project_Cost), issued: isoDay(r.Permit_License_Issued_Date),
      completed: null, status: r.Record_Status ?? null, address: r.Address ?? null });
  }
  // The 2016–2026 OpenGov export: structured improvement type and dwelling-unit count beat reading descriptions.
  const exportPath = join(DATA, 'raw', 'permits_2016_2026.csv');
  if (existsSync(exportPath)) {
    for (const r of readCsv(readFileSync(exportPath, 'utf8').replace(/^\uFEFF/, ''))) {
      const description = [r['Description of Work'], r['Approved Permit Language']].filter(Boolean).join(' — ');
      const improvement = (r['Type of Improvement'] ?? '').trim();
      const units = Number(r['Number of Dwelling Units']) || null;
      const base = { id: r['Record #'], source: 'opengov_export_2026' as const, parcelId: matchAddress(r.Address ?? ''), type: r['Record Type'] ?? '',
        permitClass: (r['Structure Type'] ?? '').trim() || null, workClass: improvement || null, description,
        cost: null as number | null, issued: isoDay(r['Permit/License Issued Date']), completed: null, status: r['Record Status'] ?? null, address: r.Address ?? null };
      const prior = byRecord.get(base.id);
      let kind = permitKind(base);
      if (/^New (Principal )?Structure/i.test(improvement) && units && !/shed|garage|accessory|deck/i.test(description)) kind = /residence hall|dormitor/i.test(description) ? 'dorm' : 'new_residential';
      else if (/^Change of Use/i.test(improvement) && units) kind = 'conversion';
      byRecord.set(base.id, { ...base, parcelId: base.parcelId ?? prior?.parcelId ?? null, cost: prior?.cost ?? null, kind, units: units ?? permitUnits(description) });
    }
  }
  const out = [...byRecord.values()];
  const matched = out.filter((p) => p.parcelId && parcelIds.has(p.parcelId)).length;
  console.log(`permits matched to a roll parcel id: ${matched}/${out.length}`);
  return out;
}

function main() {
  const parcels = buildParcels();
  const file = join(DATA, 'parcels.sqlite');
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  const cols = Object.keys(parcels[0]);
  db.exec(`CREATE TABLE parcels (${cols.map((c) => `"${c}"`).join(', ')}, PRIMARY KEY (id))`);
  const ins = db.prepare(`INSERT INTO parcels VALUES (${cols.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  for (const p of parcels) {
    ins.run(...cols.map((c) => {
      const v = (p as any)[c];
      return Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v;
    }));
  }
  db.exec('COMMIT');
  db.exec('CREATE INDEX parcels_address ON parcels(address)');
  const pcols = ['id', 'source', 'parcelId', 'type', 'permitClass', 'workClass', 'description', 'cost', 'issued', 'completed', 'status', 'address', 'kind', 'units'] as const;
  db.exec(`CREATE TABLE permits (${pcols.map((c) => `"${c}"`).join(', ')}, PRIMARY KEY (id))`);
  const pins = db.prepare(`INSERT INTO permits VALUES (${pcols.map(() => '?').join(', ')})`);
  db.exec('BEGIN');
  for (const pm of lastPermits) pins.run(...pcols.map((c) => (pm as any)[c] ?? null));
  db.exec('COMMIT');
  db.exec('CREATE INDEX permits_parcel ON permits(parcelId)');
  // Eviction filings per tract-month (Eviction Lab ETS) — Providence city tracts only.
  const etsPath = join(DATA, 'raw', 'evictions_tracts.csv');
  if (existsSync(etsPath)) {
    db.exec('CREATE TABLE evictions_tract_month (geoid, month, filings, baseline_avg, racial_majority, PRIMARY KEY (geoid, month))');
    const ins = db.prepare('INSERT OR REPLACE INTO evictions_tract_month VALUES (?,?,?,?,?)');
    let n = 0;
    // The file covers all of Providence County; keep the city's tracts (the ACS tract outlines).
    const cityTracts = new Set((existsSync(join(DATA, 'raw', 'acs_tract_shapes.json')) ? JSON.parse(readFileSync(join(DATA, 'raw', 'acs_tract_shapes.json'), 'utf8')).features : []).map((f: any) => f.properties.geoid));
    for (const r of readCsv(readFileSync(etsPath, 'utf8'))) {
      if (r.type !== 'Census Tract' || !cityTracts.has(`14000US${r.GEOID}`)) continue;
      const [mm, yyyy] = r.month.split('/');
      ins.run(`14000US${r.GEOID}`, `${yyyy}-${mm}`, Number(r.filings_2020) || 0, Number(r.filings_avg_prepandemic_baseline) || null, r.racial_majority || null);
      n++;
    }
    console.log(`eviction tract-months: ${n}`);
  }
  // Zillow asking-rent index for Providence (city) and its ZIPs, long format.
  db.exec('CREATE TABLE zori_month (region, region_type, month, rent, PRIMARY KEY (region, month))');
  const zins = db.prepare('INSERT OR REPLACE INTO zori_month VALUES (?,?,?,?)');
  for (const [file, keep] of [['zori_city', (r: Record<string, string>) => r.RegionName === 'Providence' && r.State === 'RI'],
    ['zori_zip', (r: Record<string, string>) => r.State === 'RI' && /^029(0[3-9])$/.test(r.RegionName)]] as const) {
    const path = join(DATA, 'raw', `${file}.csv`);
    if (!existsSync(path)) continue;
    for (const r of readCsv(readFileSync(path, 'utf8'))) {
      if (!keep(r)) continue;
      for (const [k, v] of Object.entries(r)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v) zins.run(r.RegionName, r.RegionType, k.slice(0, 7), Math.round(Number(v)));
    }
  }

  // Released datasets (rental registry, short-term rentals, housing court, tax sale), each joined to a parcel.
  writeSignals(db, parcels);

  // Owner-occupied tax rate per parcel per roll year, FY2016 and FY2020–FY2026 (assessment dates a year earlier).
  // FY2021–23 had a single residential code; there the homestead exemption (≥30% of assessed value) marks owner-occupants.
  // Checked on FY2022: 95% of parcels owner-occupied in both FY2020 and FY2024 carry it, 98% of parcels investor-owned in
  // both carry no exemption, and ~99% of parcels with it were owner-occupied on both sides. method = 'levy' | 'homestead'.
  db.exec('CREATE TABLE owner_occupancy_history (parcelId, roll_year, owner_occupied, method, PRIMARY KEY (parcelId, roll_year))');
  {
    const ins = db.prepare('INSERT OR REPLACE INTO owner_occupancy_history VALUES (?,?,?,?)');
    const ids = new Set(parcels.map((p) => p.id));
    db.exec('BEGIN');
    for (const p of parcels) if (p.ownerOccupiedTaxRate != null) ins.run(p.id, 2026, p.ownerOccupiedTaxRate ? 1 : 0, 'levy');
    const levyYears = [[2025, 'taxroll2025', 'tax_map', 'levy_code_1'], [2024, 'taxroll2024', 'tax_map', 'levy_code_1'], [2020, 'taxroll2020', 'tax_map', 'levy_code_1'],
      [2019, 'taxroll2019', 'plat_lot_unit', 'levy_code'], [2018, 'taxroll2018', 'plat_lot_unit', 'levy_code'], [2017, 'taxroll2017', 'plat_lot_unit', 'levy_code'],
      [2016, 'taxroll2016', 'plat_lot_unit', 'levy_code'], [2015, 'taxroll2015', 'plat_lot_unit', 'levy_code'], [2014, 'taxroll2014', 'plat_lot_unit', 'levy_code'],
      [2013, 'taxroll2013', 'plat_lot_unit', 'levy_code']] as const;
    for (const [year, file, idCol, levyCol] of levyYears) {
      for (const r of rawIf(file)) {
        const id = String(r[idCol] ?? '').trim();
        const levy = String(r[levyCol] ?? '');
        if (!ids.has(id) || !/^(OO|NO)/.test(levy)) continue;
        ins.run(id, year, /^OO/.test(levy) ? 1 : 0, 'levy');
      }
    }
    for (const [year, file] of [[2021, 'taxroll2021_values'], [2022, 'taxroll2022_values'], [2023, 'taxroll2023_values']] as const) {
      for (const r of rawIf(file)) {
        const id = String(r.tax_map ?? '').trim();
        const assessed = Number(r.total_assmt), exempt = Number(r.total_exempt) || 0;
        if (!ids.has(id) || r.levy_code_1 !== 'R01' || !(assessed > 0)) continue;
        ins.run(id, year, exempt / assessed >= 0.3 ? 1 : 0, 'homestead');
      }
    }
    db.exec('COMMIT');
  }
  // HUD Small Area FMRs for Providence ZIPs.
  db.exec('CREATE TABLE safmr_fy27 (zip PRIMARY KEY, br0, br1, br2, br3, br4)');
  {
    const ins = db.prepare('INSERT OR REPLACE INTO safmr_fy27 VALUES (?,?,?,?,?,?)');
    for (const r of rawIf('hud_safmr_fy27')) {
      const zip = String(r['ZIP Code']).padStart(5, '0');
      if (!/^029(0[2-9]|1[0-2])$/.test(zip)) continue;
      ins.run(zip, ...['SAFMR 0BR', 'SAFMR 1BR', 'SAFMR 2BR', 'SAFMR 3BR', 'SAFMR 4BR'].map((k) => Number(r[k]) || null));
    }
  }

  // ACS tract table: one row per Providence tract, the few measures a coverage-equity comparison needs.
  const acsPath = join(DATA, 'raw', 'acs_tracts.json');
  if (existsSync(acsPath)) {
    const acs = JSON.parse(readFileSync(acsPath, 'utf8'));
    const shapes = existsSync(join(DATA, 'raw', 'acs_tract_shapes.json')) ? JSON.parse(readFileSync(join(DATA, 'raw', 'acs_tract_shapes.json'), 'utf8')).features as any[] : [];
    const nameOf = new Map(shapes.map((f) => [f.properties.geoid, f.properties.name]));
    db.exec(`CREATE TABLE tracts (geoid PRIMARY KEY, name, households, renter_households, median_income, renter_median_income,
      white_nh_share, black_nh_share, hispanic_share, asian_nh_share, median_gross_rent, rent_burden_median_pct, release, hcv_households)`);
    const ins = db.prepare('INSERT INTO tracts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const hcv = new Map(rawIf('hud_vouchers_tract').map((r) => [`14000US${r.GEOID}`, r.HCV_PUBLIC ?? null]));
    for (const [geoid, t] of Object.entries(acs.data) as [string, any][]) {
      const e = (table: string, col: string) => t[table]?.estimate?.[col] ?? null;
      const pop = e('B03002', 'B03002001');
      const share = (col: string) => (pop ? Math.round((1000 * (e('B03002', col) ?? 0)) / pop) / 1000 : null);
      ins.run(geoid, nameOf.get(geoid) ?? null, e('B25003', 'B25003001'), e('B25003', 'B25003003'), e('B19013', 'B19013001'), e('B25119', 'B25119003'),
        share('B03002003'), share('B03002004'), share('B03002012'), share('B03002006'), e('B25064', 'B25064001'), e('B25071', 'B25071001'), acs.release?.name ?? null,
        hcv.get(geoid) ?? null);
    }
  }
  db.close();
  console.log(`parcels: ${parcels.length} → ${file}`);
}

if (import.meta.main) main();
