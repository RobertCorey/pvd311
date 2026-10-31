// Normalize data/raw/*.json into data/parcels.sqlite (table `parcels`, one row per tax-roll parcel).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mailingStreetAndCity, markSuffixSensitive, ownerKey, ownerKind, parseAddress, sameAddress, streetsWithSeveralSuffixes, type StreetAddress } from '../src/normalize.ts';
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
  // Street names that exist under two suffixes (Washington St / Ave): there, address matching must respect the suffix.
  const severalSuffixes = streetsWithSeveralSuffixes(rawIf('address_points').map((p) => String(p.fullname ?? '')).filter(Boolean));
  markSuffixSensitive(severalSuffixes);
  console.log(`street names under several suffixes: ${severalSuffixes.length}`);
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
  // Each list's project size, kept per parcel and source so 8%-law placeholders ("1 unit" for a 354-unit tower) can be fixed below.
  const listed = new Map<Parcel, Map<string, number>>();
  const tag = (signal: string, addr: string | null, lat: number | null, lng: number | null, units: number | null = null, source = signal) => {
    const note = (p: Parcel) => {
      if (!units) return;
      const m = listed.get(p) ?? listed.set(p, new Map()).get(p)!;
      m.set(source, source === 'public_housing' ? (m.get(source) ?? 0) + units : Math.max(m.get(source) ?? 0, units));
    };
    const a = parseAddress(addr);
    const hits = a ? (byStreet.get(a.street) ?? []).filter((x) => sameAddress(x.a, a)) : [];
    if (hits.length) {
      for (const h of hits) if (!h.p.affordableSignals.includes(signal)) h.p.affordableSignals.push(signal);
      note(hits[0].p); // one parcel per project, so a project matched across a number range isn't counted twice
      return 'address';
    }
    if (lat == null || lng == null) return 'none';
    let best: Parcel | null = null; let bestD = 40;
    for (const p of parcels) {
      if (p.lat == null || p.lng == null) continue;
      if (!((p.units ?? 0) >= 5 || /^(03|04-(610|11))|^(12|83|6)$/.test(p.taxClass))) continue;
      const d = metres(lat, lng, p.lat, p.lng);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { const s = `${signal}_nearby`; if (!best.affordableSignals.includes(s)) best.affordableSignals.push(s); note(best); return 'nearby'; }
    return 'none';
  };
  const matchStats: Record<string, Record<string, number>> = {};
  const count = (src: string, how: string) => ((matchStats[src] ??= {})[how] = (matchStats[src][how] ?? 0) + 1);
  // Projects where only some units are income-restricted get a *_partial signal (the rest of the building is covered).
  for (const r of raw('hud_lihtc')) {
    const partial = num(r.LI_UNITS) != null && num(r.N_UNITS) != null && num(r.LI_UNITS)! < num(r.N_UNITS)!;
    count('hud_lihtc', tag(partial ? 'lihtc_partial' : 'lihtc', r.STD_ADDR?.trim() || r.PROJ_ADD, r.LAT, r.LON, num(r.N_UNITS), 'lihtc'));
  }
  for (const r of raw('hud_multifamily')) {
    const partial = num(r.TOTAL_ASSISTED_UNIT_COUNT) != null && num(r.TOTAL_UNIT_COUNT) != null && num(r.TOTAL_ASSISTED_UNIT_COUNT)! < num(r.TOTAL_UNIT_COUNT)!;
    count('hud_multifamily', tag(partial ? 'hud_assisted_partial' : 'hud_assisted', r.STD_ADDR?.trim() || r.ADDRESS_LINE1_TEXT, r.LAT, r.LON, num(r.TOTAL_UNIT_COUNT), 'hud_assisted'));
  }
  for (const r of raw('hud_public_housing')) count('hud_public_housing', tag('public_housing', r.STD_ADDR?.trim(), r.LAT, r.LON, num(r.TOTAL_UNITS)));
  for (const r of raw('pha')) count('pha', tag('pha_site', r.Street_Name, r._geometry?.y ?? null, r._geometry?.x ?? null));
  console.log('affordable-list matches:', JSON.stringify(matchStats));
  // HUD's full multifamily property list (monthly) has no coordinates: match its first door through roll + E-911 addresses.
  {
    // Its active contracts give the assisted share, so a matched parcel gets the same signal as the HUD map layer's.
    const matchAddr = addressMatcher(parcels), byId = new Map(parcels.map((p) => [p.id, p]));
    const assisted = new Map<string, number>();
    for (const c of rawIf('hud_mf_contracts')) if (c.tracs_status_name === 'Active') assisted.set(c.property_id, (assisted.get(c.property_id) ?? 0) + (num(c.assisted_units_count) ?? 0));
    for (const r of rawIf('hud_mf_properties')) {
      if (!/^providence$/i.test(String(r.city_name_text ?? '').trim())) continue;
      const p = byId.get(matchAddr(firstDoor(String(r.address_line1_text ?? ''))) ?? '');
      const n = num(r.property_total_unit_count), a = assisted.get(r.property_id) ?? 0;
      if (!p) { count('hud_mf_properties', 'none'); continue; }
      count('hud_mf_properties', 'address');
      if (n) { const m = listed.get(p) ?? listed.set(p, new Map()).get(p)!; m.set('hud_mf', Math.max(m.get('hud_mf') ?? 0, n)); }
      const signal = a > 0 && n != null && a < n ? 'hud_assisted_partial' : a > 0 ? 'hud_assisted' : null;
      if (signal && !p.affordableSignals.some((s) => s.startsWith('hud_assisted') && !s.endsWith('_nearby'))) p.affordableSignals.push(signal);
    }
    console.log('hud_mf_properties matches:', JSON.stringify(matchStats.hud_mf_properties));
  }
  // 8%-law parcels (class 12) often carry a placeholder unit count in CAMA. HUD lists give project sizes, but scattered-site
  // projects (Barbara Jordan I: 81 lots; EPN: 54 sites citywide) already count most units lot by lot, and one project can match
  // different lots in different lists. So per owner: the 8%-law lots together get at most the largest listed project, and any
  // shortfall goes to the lot that list matched. (An owner with two separate listed projects is undercounted, never doubled.)
  const lawByOwner = new Map<string, Parcel[]>();
  for (const p of parcels) if (p.levyCode === '8LAW') { const k = p.ownerKey ?? p.id; (lawByOwner.get(k) ?? lawByOwner.set(k, []).get(k)!).push(p); }
  const best = new Map<string, { p: Parcel; n: number }>();
  for (const [p, bySource] of listed) {
    if (p.levyCode !== '8LAW') continue;
    const k = p.ownerKey ?? p.id, n = Math.max(...bySource.values());
    if (n > (best.get(k)?.n ?? 0)) best.set(k, { p, n });
  }
  let fixed = 0, added = 0;
  for (const [k, { p, n }] of best) {
    const have = lawByOwner.get(k)!.reduce((sum, q) => sum + (q.units ?? 0), 0);
    if (n <= have) continue;
    p.units = (p.units ?? 0) + n - have; added += n - have; fixed++;
  }
  console.log(`8%-law unit counts from HUD lists: ${fixed} parcels, +${added} units`);

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

  // HUD-assisted multifamily properties (Section 8, 202/811 and others) with each rental-assistance contract's expiration date.
  // A property is matched to one parcel by its street address, even where its buildings span several lots.
  const mfProps = rawIf('hud_mf_properties').filter((r) => /^providence$/i.test(String(r.city_name_text ?? '').trim()));
  const mfParcel = new Map(mfProps.map((r) => [r.property_id, match(firstDoor(String(r.address_line1_text ?? '')))]));
  table('hud_mf_properties', ['property_id', 'name', 'address', 'zip', 'units', 'category', 'financing', 'is_202_811', 'assisted_living', 'parcelId'],
    mfProps.map((r) => [r.property_id, r.property_name_text, r.address_line1_text.replace(/\s+/g, ' '), r.zip_code, Number(r.property_total_unit_count) || null,
      r.property_category_name, r.primary_financing_type || null, r.is_202_811_ind, r.is_assisted_living_ind, mfParcel.get(r.property_id) ?? null]));
  table('hud_mf_contracts', ['contract_number', 'property_id', 'program', 'program_group', 'status', 'effective', 'expires', 'current_term_expires',
    'term_months', 'assisted_units', 'rent_to_fmr', 'parcelId'],
    rawIf('hud_mf_contracts').filter((r) => mfParcel.has(r.property_id)).map((r) => [r.contract_number, r.property_id, r.program_type_name, r.program_type_group_name,
      r.tracs_status_name, excelDate(r.tracs_effective_date), excelDate(r.tracs_overall_expiration_date), excelDate(r.tracs_current_expiration_date),
      Number(r.contract_term_months_qty) || null, Number(r.assisted_units_count) || null, Number(r.rent_to_FMR_ratio) || null, mfParcel.get(r.property_id) ?? null]));

  // City 311 cases (FixMyPVD's public feed of the city's case grid): matched by the street address the city shows. Cases with
  // a street but no door number stay unmatched. Times in the feed are minutes since 1970.
  {
    // fetch.ts stores the feed accumulated and resolved (case type and status names, not indices).
    const feed = rawIf('city_cases_fixmypvd') as any;
    const iso = (min: number) => (min ? new Date(min * 60_000).toISOString() : null);
    const housing = /housing|building code|no heat|vacant private|rodent/i;
    table('city_cases', ['guid', 'case_type', 'category', 'status', 'created', 'closed', 'address', 'housing', 'parcelId'],
      (feed?.items ?? []).map((c: any) => [c.guid, c.caseType, c.category, c.status, iso(c.createdMin), iso(c.closedMin), c.street,
        housing.test(c.caseType ?? '') ? 1 : 0, /^\d/.test(c.street ?? '') ? match(c.street) : null]));
  }

  // The assessor's 2024 valid sales (the revaluation's sales file), joined on PROPID.
  const msDay = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toISOString().slice(0, 10) : null);
  table('sales_2024', ['sale_date', 'price', 'units', 'validity', 'instrument', 'building_type', 'land_use', 'assessed', 'year_built', 'quality', 'condition', 'finished_area', 'address', 'parcelId'],
    rawIf('sales_2024').map((r) => [msDay(r.Sale_Date), num(r.Sale_Price), num(r.NumUnits), r.N_A_L__Code, r.Instrument_Type, r.Building_Type, r.Primary_LUC,
      num(r.Total_Assessed_Value), num(r.YearBuilt), r.Quality, r.Condition, num(r.Total_Finished_Area), r.ParcAddress, ids.has(String(r.PROPID).trim()) ? String(r.PROPID).trim() : null]));
  // Code-enforcement records 2013–2024 (city ArcGIS snapshot): plat-lot-unit when it is on the roll, else the address.
  table('code_cases_history', ['record', 'address', 'status', 'first_inspection', 'complaint_type', 'violations_found', 'condemnation', 'building_type',
    'nov1_issued', 'nov2_issued', 'condemnation_issued', 'parcelId'],
    rawIf('code_cases_history').map((r) => [r.Record__, r.Address, r.Record_Status, msDay(r.Date_of_First_Inspection), r.Complaint_Type, r.Violations_Found_,
      r.Condemnation, r.Building_Type, msDay(r.Date_1NOV_Issued), msDay(r.Date_2NOV_Issued), msDay(r.Date_Condemnation_Issued),
      ids.has(String(r.Mbl ?? '').trim()) ? String(r.Mbl).trim() : match(String(r.Address ?? ''))]));
  // Providence Water lead service lines (private side): a line runs from the curb to the house, so it belongs to the lot
  // that one of its ends falls in (the house end when both do).
  {
    const shapes = new Map<string, number[][][]>();
    for (const r of rawIf('parcel_shapes')) if (r.PROPID && r._geometry?.rings && !shapes.has(r.PROPID)) shapes.set(r.PROPID, r._geometry.rings);
    const lotOf = lotIndex(parcels.map((p) => shapes.get(p.id) ?? null));
    table('lead_service_lines', ['location_id', 'priv_side', 'grant_eligible', 'parcelId'], rawIf('lead_service_lines').map((r) => {
      const path: number[][] = r._geometry?.paths?.[0] ?? [];
      const ends = [path[path.length - 1], path[0]].filter(Boolean);
      const hit = ends.map((e) => lotOf(e[0], e[1])).find((l) => l.length);
      return [r.LOCATIONID, r.PRIV_SIDE_?.trim() || null, r.GrantEligibility, hit ? parcels[hit[0]].id : null];
    }));
  }

  // FEMA flood areas (2019 city layers): the 1% (100-year) list, then the wider 1%-or-0.2% list for the rest.
  {
    const toId = (x: unknown) => { const m = String(x ?? '').trim().match(/^(\d{3})(\d{4})(\w{4})$/); return m && ids.has(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null; };
    const zone = new Map<string, string>();
    for (const r of rawIf('flood_parcels_1pct')) { const id = toId(r.MAP_PAR_ID); if (id) zone.set(id, '1%'); }
    for (const r of rawIf('flood_parcels_02pct')) { const id = toId(r.MAP_PAR_ID); if (id && !zone.has(id)) zone.set(id, '0.2%'); }
    table('flood_zone', ['parcelId', 'zone'], [...zone]);
  }

  // Sales history from the assessor's 2013 and 2019 extracts (APRA 20-209): up to six sales per parcel each, de-duplicated.
  // Price 0 marks a non-arm's-length transfer; `qualified` is the assessor's Q/U. Lots only (the extracts carry no condo unit).
  {
    const seen = new Set<string>(), rows: unknown[][] = [];
    for (const file of ['sales_history_2019', 'sales_history_2013']) for (const r of rawIf(file)) {
      const id = `${String(r.Map).trim().padStart(3, '0')}-${String(r.Lot).trim().padStart(4, '0')}-0000`;
      for (let i = 1; i <= 6; i++) {
        const date = excelDate(r[`SALE DATE ${i}`] ?? ''), price = num(r[`SALE PRICE ${i}`]);
        if (!date || (date === '2012-07-07' && !price)) continue; // 14,813 unpriced records share 2012-07-07: a conversion placeholder
        const key = `${id}|${date}|${price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push([date, price, r[`SALE CODE ${i}`] || null, r[`QUALIFIED ${i}`] || null, r[`IMPROVED ${i}`] || null, `${r['STREET NUM']} ${r['STREET NAME']}`.trim(), ids.has(id) ? id : null]);
      }
    }
    table('sales_history', ['sale_date', 'price', 'sale_code', 'qualified', 'improved', 'address', 'parcelId'], rows);
  }
  // Code cases with lead-hazard violations, active and released (APRA 22-1323, 2022).
  // The house number sits in the "Number" column; "Address" is the street.
  table('lead_violations_2022', ['status', 'house_number', 'address', 'complaint_date', 'complaint_reason', 'inspection_date', 'nov1_issued', 'violations', 'lead_added', 'released', 'parcelId'],
    [...rawIf('lead_violations_2022'), ...rawIf('lead_violations_2022_released')].map((r) => [r.Status, r.Number, `${r.Number ?? ''} ${r.Address ?? ''}`.trim(), excelDate(r['Complaint Date'] ?? ''),
      r['Complaint Reason'] || null, excelDate(r['Inspection Date'] ?? ''), excelDate(r['1st NOV Issue Date'] ?? ''), num(r['# Violations (1st)']), r['Lead Added'] || null,
      excelDate(r['1st NOV Release Date'] ?? ''), match(`${r.Number ?? ''} ${r.Address ?? ''}`)]));

  // RIDOH's suspected unregistered rentals (2025-05-01): Providence rows carry "PROV M:10 L:104 U:3" → 010-0104-0003.
  table('ridoh_suspected_rentals', ['address', 'zip', 'parcelId'], rawIf('ridoh_suspected_rentals').flatMap((r) => {
    const m = String(r.alt_parcel_id ?? '').match(/^PROV M:(\d+) L:(\d+)(?: U:(\w+))?/);
    if (!m) return [];
    const id = `${m[1].padStart(3, '0')}-${m[2].padStart(4, '0')}-${(m[3] ?? '0').padStart(4, '0')}`;
    return [[r.street_address, r.zip_code, ids.has(id) ? id : match(String(r.street_address ?? ''))]];
  }));

  // HUD LIHTC projects with their tax-credit clocks: 15-year compliance and 30-year extended use counted from the year placed
  // in service (the federal minimums; many Rhode Island deals carry longer restrictions, which only NHPD or RIHousing list).
  table('lihtc_projects', ['hud_id', 'project', 'address', 'units', 'li_units', 'year_placed_in_service', 'compliance_ends', 'extended_use_ends', 'parcelId'],
    rawIf('hud_lihtc').map((r) => {
      const y = num(r.YR_PIS) && num(r.YR_PIS)! > 1980 && num(r.YR_PIS)! < 2100 ? num(r.YR_PIS)! : null;
      return [r.HUD_ID, r.PROJECT, r.STD_ADDR?.trim() || r.PROJ_ADD, num(r.N_UNITS), num(r.LI_UNITS), y, y ? y + 15 : null, y ? y + 30 : null, match(String(r.STD_ADDR?.trim() || r.PROJ_ADD || ''))];
    }));

  // One row per parcel with every signal it has (materialized from grouped joins; the map and analysis read this).
  db.exec(`CREATE TABLE parcel_signals AS
    SELECT p.id AS parcelId,
      rr.units AS registered_rental_units, COALESCE(sr.n, 0) AS str_registrations, COALESCE(sp.n, 0) AS str_city_permits,
      COALESCE(ab.n, 0) AS airbnb_listings, COALESCE(hc.n, 0) AS housing_court_cases, hc.last AS last_housing_court_case,
      COALESCE(ts.n, 0) AS tax_sale_2026, COALESCE(vr.n, 0) AS vacant_registry, COALESCE(cc.n, 0) AS code_cases_active,
      lc.last AS lead_cert_last_letter, lc.units AS lead_cert_units, mf.units AS hud_assisted_units, mf.expires AS hud_contract_expires,
      COALESCE(c3.n, 0) AS city_cases, COALESCE(c3.housing, 0) AS city_cases_housing,
      COALESCE(ch.n, 0) AS code_cases_2013_2024, COALESCE(ls.n, 0) AS lead_service_lines, sa.price AS sale_2024_price, sa.sale_date AS sale_2024_date, fz.zone AS flood_zone,
      COALESCE(lv.n, 0) AS lead_violations_2022, sh.last_date AS last_arms_length_sale, sh.n AS arms_length_sales_since_2000,
      CASE WHEN sus.parcelId IS NULL THEN 0 ELSE 1 END AS ridoh_suspected_rental
    FROM parcels p
    LEFT JOIN (SELECT parcelId, SUM(units) units FROM rental_registry GROUP BY parcelId) rr ON rr.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM str_registrations GROUP BY parcelId) sr ON sr.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM str_city_permits GROUP BY parcelId) sp ON sp.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM airbnb_listings GROUP BY parcelId) ab ON ab.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n, MAX(filed) last FROM housing_court_cases GROUP BY parcelId) hc ON hc.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM tax_sale_2026 GROUP BY parcelId) ts ON ts.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM vacant_registry GROUP BY parcelId) vr ON vr.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM code_cases_active GROUP BY parcelId) cc ON cc.parcelId = p.id
    LEFT JOIN (SELECT parcelId, MAX(last_letter) last, MAX(units) units FROM lead_certificates GROUP BY parcelId) lc ON lc.parcelId = p.id
    LEFT JOIN (SELECT parcelId, SUM(assisted_units) units, MIN(expires) expires FROM hud_mf_contracts WHERE status = 'Active' GROUP BY parcelId) mf ON mf.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n, SUM(housing) housing FROM city_cases GROUP BY parcelId) c3 ON c3.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM code_cases_history GROUP BY parcelId) ch ON ch.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM lead_service_lines GROUP BY parcelId) ls ON ls.parcelId = p.id
    LEFT JOIN (SELECT parcelId, MAX(price) price, MAX(sale_date) sale_date FROM sales_2024 GROUP BY parcelId) sa ON sa.parcelId = p.id
    LEFT JOIN flood_zone fz ON fz.parcelId = p.id
    LEFT JOIN (SELECT parcelId, COUNT(*) n FROM lead_violations_2022 GROUP BY parcelId) lv ON lv.parcelId = p.id
    LEFT JOIN (SELECT parcelId, MAX(sale_date) last_date, COUNT(*) n FROM sales_history WHERE price > 1000 AND sale_date >= '2000-01-01' GROUP BY parcelId) sh ON sh.parcelId = p.id
    LEFT JOIN (SELECT DISTINCT parcelId FROM ridoh_suspected_rentals WHERE parcelId IS NOT NULL) sus ON sus.parcelId = p.id`);
  db.exec('CREATE UNIQUE INDEX parcel_signals_id ON parcel_signals(parcelId)');
}

// HUD addresses come as lists ("201,205-207,211-213 Thurbers Ave", "861 A, B BROAD ST", "FOUR CATHEDRAL SQUARE"): match the first door.
function firstDoor(address: string): string {
  const words: Record<string, string> = { ONE: '1', TWO: '2', THREE: '3', FOUR: '4', FIVE: '5', SIX: '6', SEVEN: '7', EIGHT: '8', NINE: '9', TEN: '10' };
  const tokens = address.replace(/,/g, ' , ').trim().split(/\s+/).map((t) => words[t.toUpperCase()] ?? t);
  const street = tokens.findIndex((t, i) => i > 0 && /^[A-Za-z]{2,}/.test(t));
  const num = tokens[0]?.match(/^\d+/)?.[0];
  return num && street > 0 ? `${num} ${tokens.slice(street).join(' ')}` : address;
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
  // Zillow asking-rent index (ZORI) and home value index (ZHVI) for Providence (city) and its ZIPs, long format.
  const isCity = (r: Record<string, string>) => r.RegionName === 'Providence' && r.State === 'RI';
  const isZip = (r: Record<string, string>) => r.State === 'RI' && /^029(0[3-9])$/.test(r.RegionName);
  for (const [table, col, files] of [['zori_month', 'rent', ['zori_city', 'zori_zip']], ['zhvi_month', 'value', ['zhvi_city', 'zhvi_zip']]] as const) {
    db.exec(`CREATE TABLE ${table} (region, region_type, month, ${col}, PRIMARY KEY (region, month))`);
    const zins = db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?,?,?,?)`);
    for (const file of files) {
      const path = join(DATA, 'raw', `${file}.csv`);
      if (!existsSync(path)) continue;
      for (const r of readCsv(readFileSync(path, 'utf8'))) {
        if (!(file.endsWith('city') ? isCity(r) : isZip(r))) continue;
        for (const [k, v] of Object.entries(r)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v) zins.run(r.RegionName, r.RegionType, k.slice(0, 7), Math.round(Number(v)));
      }
    }
  }

  // FHFA tract house price index (annual, 2020 tracts). FHFA suppresses tracts with too few repeat sales: 22 of the city's 42 have it.
  db.exec('CREATE TABLE fhfa_hpi_tract (geoid, year, hpi, annual_change, hpi2000, PRIMARY KEY (geoid, year))');
  {
    const path = join(DATA, 'raw', 'fhfa_hpi_tract.csv');
    const ins = db.prepare('INSERT OR REPLACE INTO fhfa_hpi_tract VALUES (?,?,?,?,?)');
    if (existsSync(path)) for (const r of readCsv(readFileSync(path, 'utf8')))
      ins.run(`14000US${r.tract}`, Number(r.year), Number(r.hpi) || null, r.annual_change === '' ? null : Number(r.annual_change), r.hpi2000 === '' ? null : Number(r.hpi2000));
  }

  // Released datasets (rental registry, short-term rentals, housing court, tax sale), each joined to a parcel.
  writeSignals(db, parcels);

  // Owner-occupied tax rate per parcel per roll year, FY2002–FY2026 (assessment dates a year earlier).
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
    // FY2002–FY2012: the pre-2013 homestead exemption, method 'exemption_pre2013'. Its size changed: owner-occupants hold
    // ≥20% of assessed value in FY2002–03 and ≥45% from FY2004 (a ~30% band in FY2004–09 is mostly not owner-occupied).
    // Checked against FY2013's levy code: FY2012 holders are 99% owner-occupied a year later, FY2004–11 holders only 76–81%
    // two to nine years later, and the holder count drops 18% in FY2012. The list looks purged around FY2012, so earlier
    // years overstate owner-occupancy: use them per parcel as evidence, not as a citywide trend.
    for (let year = 2002; year <= 2012; year++) {
      const cut = year <= 2003 ? 0.2 : 0.45;
      for (const r of rawIf(`taxroll${year}`)) {
        const id = String(r.plat_lot_unit ?? '').trim();
        const assessed = Number(r.total_assessment), exempt = Number(r.total_exemption) || 0;
        if (!ids.has(id) || r.levy_code !== 'R01' || !(assessed > 0)) continue;
        ins.run(id, year, exempt / assessed >= cut ? 1 : 0, 'exemption_pre2013');
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

  // RIHousing dashboards (Tableau). Rent survey: 2-bedroom rent including utilities, 2025 dollars, CoStar (large buildings).
  // Evictions tracker: statewide by month (court data) and cases per renter household by ZIP (about the last 12 months).
  {
    const money = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return String(v ?? '').trim() && Number.isFinite(n) ? n : null; };
    const month = (v: unknown) => { const d = new Date(`1 ${v}`); return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
    const rows = (sheet: Record<string, any[]> | undefined) => {
      if (!sheet) return [] as Record<string, any>[];
      const keys = Object.keys(sheet), n = Math.max(0, ...keys.map((k) => sheet[k].length));
      return Array.from({ length: n }, (_, i) => Object.fromEntries(keys.map((k) => [k, sheet[k][i]])));
    };
    const rent = (rawIf('rihousing_rent_survey') as any)?.RentSurveyDashboard ?? {};
    const towns = new Map<string, { y2020: number | null; y2025: number | null }>();
    for (const r of rows(rent.Municipal)) {
      const t = towns.get(r.Municipality1) ?? towns.set(r.Municipality1, { y2020: null, y2025: null }).get(r.Municipality1)!;
      if (r['Measure Names'] === '2020') t.y2020 = money(r['Measure Values']); else if (r['Measure Names'] === '2025') t.y2025 = money(r['Measure Values']);
    }
    db.exec('CREATE TABLE rihousing_rent_town (town PRIMARY KEY, rent_2bd_2020, rent_2bd_2025)');
    const insT = db.prepare('INSERT INTO rihousing_rent_town VALUES (?,?,?)');
    for (const [town, t] of towns) insT.run(town, t.y2020, t.y2025);

    const ev = (rawIf('rihousing_evictions') as any) ?? {};
    const p1 = ev.EvictionsDashboardpage1 ?? {}, p2 = ev.EvictionsDashboardpage2 ?? {};
    const byMonth = new Map<string, Record<string, number | null>>();
    const put = (m: string | null, k: string, v: number | null) => { if (m) (byMonth.get(m) ?? byMonth.set(m, {}).get(m)!)[k] = v; };
    for (const r of rows(p1['Number of Eviction Filings by Type'])) {
      const t = r['Eviction Type1'] === '%all%' ? 'filings' : r['Eviction Type1'] === 'Non-Payment' ? 'filings_nonpayment' : 'filings_other';
      put(month(r['MONTH(Filing Date1)']), t, r['CNTD(Case Number)']);
    }
    for (const r of rows(p1['Hearings by Month (9+20 Day) [Alt]'])) {
      const m = month(r['MONTH(Hearing Date)']); if (!m) continue;
      put(m, 'hearings', (byMonth.get(m)?.hearings ?? 0) + (r['CNTD(Case Number)'] ?? 0));
    }
    for (const r of rows(p1['Judgements by Month'])) put(month(r['MONTH(Hearing Date (Pending Removed))']), 'judgments', r['CNTD(Case Number)']);
    for (const r of rows(p2['Median Monthly Monetary Award'])) {
      const m = month(r['MONTH(Hearing Date (Pending Removed))']);
      put(m, 'median_award', r['MEDIAN(Award Amount1)']); put(m, 'award_cases', r['CNTD(Case Number)']);
    }
    const cols = ['filings', 'filings_nonpayment', 'filings_other', 'hearings', 'judgments', 'median_award', 'award_cases'];
    db.exec(`CREATE TABLE rihousing_evictions_month (month PRIMARY KEY, ${cols.join(', ')})`);
    const insM = db.prepare(`INSERT INTO rihousing_evictions_month VALUES (?, ${cols.map(() => '?').join(', ')})`);
    for (const [m, v] of [...byMonth].sort()) insM.run(m, ...cols.map((c) => v[c] ?? null));
    db.exec('CREATE TABLE rihousing_evictions_zip (zip PRIMARY KEY, town, cases, cases_per_renter_household)');
    const insZ = db.prepare('INSERT OR REPLACE INTO rihousing_evictions_zip VALUES (?,?,?,?)');
    for (const r of rows(p2['Cases by Rent Pop Map'])) insZ.run(r['Zip Code'], r['Zip Code City/Town'], r['AGG(Number of Cases)'], r['AGG(Cases / Rent Pop)']);
    db.exec('CREATE TABLE rihousing_judgments_year (year, judgment_type, cases, awards_total, PRIMARY KEY (year, judgment_type))');
    const insY = db.prepare('INSERT OR REPLACE INTO rihousing_judgments_year VALUES (?,?,?,?)');
    for (const r of rows(p2['Total Judgments and Awards'])) insY.run(r['YEAR(Hearing Date (Pending Removed))'], r['Money/Possession Judgement'] === '%all%' ? 'all' : r['Money/Possession Judgement'], r['CNTD(Case Number)'], r['SUM(Award Amount1)']);
  }

  // Earlier ACS 5-year releases (2010–14 and 2015–19), 2010 tracts: the city's tracts are codes below 003800. `same_tract_2020`
  // marks tracts whose code didn't change in 2020; seven were split (000100 → 000101 + 000102, …) and compare only as a sum.
  {
    db.exec(`CREATE TABLE acs_tract_history (geoid, year, households, renter_households, median_income, renter_median_income, white_nh_share,
      black_nh_share, hispanic_share, asian_nh_share, median_gross_rent, rent_burden_median_pct, same_tract_2020, PRIMARY KEY (geoid, year))`);
    const cur = new Set((db.prepare('SELECT geoid FROM tracts').all() as any[]).map((r) => r.geoid));
    const ins = db.prepare('INSERT INTO acs_tract_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const year of [2014, 2019]) for (const r of rawIf(`acs_tracts_${year}`)) {
      if (!(Number(String(r.geoid).slice(12)) < 3800)) continue;
      const share = (v: number | null) => (r.pop ? Math.round((1000 * (v ?? 0)) / r.pop) / 1000 : null);
      ins.run(r.geoid, year, r.households, r.renter_households, r.median_income, r.renter_median_income, share(r.white_nh), share(r.black_nh), share(r.hispanic),
        share(r.asian_nh), r.median_gross_rent, r.rent_burden_median_pct, cur.has(r.geoid) ? 1 : 0);
    }
  }

  // Census Building Permits Survey for Providence, 1980–2025: units authorized by building size, as the city reported them.
  db.exec('CREATE TABLE bps_units_year (year PRIMARY KEY, units_1, units_2, units_3_4, units_5_plus, bldgs_5_plus, value_total)');
  {
    const ins = db.prepare('INSERT INTO bps_units_year VALUES (?,?,?,?,?,?,?)');
    for (const r of rawIf('bps_providence')) ins.run(r.year, r.units_1, r.units_2, r.units_3_4, r.units_5_plus, r.bldgs_5_plus, r.value_total);
  }

  // HUD CHAS 2018–2022 Table 8 for the city's tracts: households by tenure × income band (% of HUD area median family income)
  // × housing cost burden. Long format; 'all' marks a subtotal.
  {
    const chas = rawIf('chas_t8') as any;
    const city = new Set((db.prepare('SELECT geoid FROM tracts').all() as any[]).map((r) => r.geoid));
    const band = (t: string) => t === 'All' ? 'all' : /less than or equal to 30%/.test(t) ? '0-30' : /greater than 30% but less than or equal to 50%/.test(t) ? '30-50'
      : /greater than 50% but less than or equal to 80%/.test(t) ? '50-80' : /greater than 80% but less than or equal to 100%/.test(t) ? '80-100' : /greater than 100%/.test(t) ? '100+' : t;
    const burden = (t: string) => t === 'All' ? 'all' : /not computed/.test(t) ? 'not computed' : /less than or equal to 30%/.test(t) ? '<=30%'
      : /greater than 30% but less than or equal to 50%/.test(t) ? '30-50%' : /greater than 50%/.test(t) ? '>50%' : t;
    db.exec('CREATE TABLE chas_tract_burden (geoid, tenure, income_band, cost_burden, households, PRIMARY KEY (geoid, tenure, income_band, cost_burden))');
    const ins = db.prepare('INSERT OR REPLACE INTO chas_tract_burden VALUES (?,?,?,?,?)');
    for (const r of chas?.rows ?? []) {
      const geoid = `14000US${r.st}${r.cnty}${r.tract}`;
      if (!city.has(geoid)) continue;
      for (const [col, [type, tenure, income, cost, facilities]] of Object.entries<string[]>(chas.labels)) {
        if (type !== 'Subtotal' || facilities !== 'All' || !/^(Owner|Renter)/.test(tenure)) continue;
        ins.run(geoid, tenure.startsWith('Renter') ? 'renter' : 'owner', band(income), burden(cost), Number(r[col]) || 0);
      }
    }
  }

  // HMDA originated loans 2018–2024 in the city's tracts (anonymized public records), plus a tract-year summary of home
  // purchases: how many, the investor share (occupancy 3), 2–4-unit and 5+ purchases, and the median property value.
  {
    const city = new Set((db.prepare('SELECT geoid FROM tracts').all() as any[]).map((r) => r.geoid));
    db.exec('CREATE TABLE hmda_loans (year, geoid, purpose, occupancy, units, loan_amount, property_value, income, business)');
    const ins = db.prepare('INSERT INTO hmda_loans VALUES (?,?,?,?,?,?,?,?,?)');
    const purchases = new Map<string, { n: number; investor: number; second: number; units2to4: number; units5: number; values: number[] }>();
    db.exec('BEGIN');
    for (let y = 2018; y <= 2024; y++) for (const r of rawIf(`hmda_${y}`)) {
      const geoid = `14000US${r.census_tract}`;
      if (!city.has(geoid)) continue;
      const units = r.total_units, value = num(r.property_value);
      ins.run(y, geoid, num(r.loan_purpose), num(r.occupancy_type), units, num(r.loan_amount), value, num(r.income), num(r.business_or_commercial_purpose));
      if (r.loan_purpose !== '1') continue;
      const k = `${geoid}|${y}`, t = purchases.get(k) ?? purchases.set(k, { n: 0, investor: 0, second: 0, units2to4: 0, units5: 0, values: [] }).get(k)!;
      t.n++; if (r.occupancy_type === '3') t.investor++; if (r.occupancy_type === '2') t.second++;
      if (/^[234]$/.test(units)) t.units2to4++; else if (units && units !== '1') t.units5++;
      if (value) t.values.push(value);
    }
    db.exec('COMMIT');
    db.exec('CREATE TABLE hmda_purchases_tract_year (geoid, year, purchases, investor, second_home, investor_share, units_2_4, units_5_plus, median_property_value, PRIMARY KEY (geoid, year))');
    const insP = db.prepare('INSERT INTO hmda_purchases_tract_year VALUES (?,?,?,?,?,?,?,?,?)');
    for (const [k, t] of purchases) {
      const [geoid, year] = k.split('|'), v = t.values.sort((a, b) => a - b);
      insP.run(geoid, Number(year), t.n, t.investor, t.second, Math.round((1000 * t.investor) / t.n) / 1000, t.units2to4, t.units5, v.length ? v[Math.floor(v.length / 2)] : null);
    }
  }

  // HUD Picture of Subsidized Households 2025: one row per city tract × program. Suppressed cells (-1, -4) → NULL.
  {
    const cols = ['total_units', 'total_occupied', 'pct_occupied', 'people_total', 'rent_per_month', 'spending_per_month', 'hh_income',
      'pct_lt80_median', 'pct_lt50_median', 'pct_lt30_median', 'pct_age62plus', 'pct_disabled_all', 'pct_female_head_child', 'pct_minority',
      'pct_black_nonhsp', 'pct_hispanic', 'pct_white_nothsp', 'months_waiting', 'months_from_movein', 'pct_overhoused'];
    db.exec(`CREATE TABLE hud_psh_tract (geoid, program, sub_program, ${cols.join(', ')}, as_of, PRIMARY KEY (geoid, program, sub_program))`);
    const city = new Set(acsPath && existsSync(acsPath) ? (db.prepare('SELECT geoid FROM tracts').all() as any[]).map((r) => r.geoid) : []);
    const ins = db.prepare(`INSERT OR REPLACE INTO hud_psh_tract VALUES (${['?', '?', '?', ...cols.map(() => '?'), '?'].join(', ')})`);
    for (const r of rawIf('hud_psh_tract_2025')) {
      const geoid = `14000US${r.code}`;
      if (!city.has(geoid)) continue;
      ins.run(geoid, r.program_label, r.sub_program, ...cols.map((c) => { const v = Number(r[c]); return r[c] === '' || r[c] === 'NA' || v < 0 ? null : v; }), r.Quarter);
    }
  }
  db.close();
  console.log(`parcels: ${parcels.length} → ${file}`);
}

if (import.meta.main) main();
