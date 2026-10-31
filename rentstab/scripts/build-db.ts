// Normalize data/raw/*.json into data/parcels.sqlite (table `parcels`, one row per tax-roll parcel).
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mailingStreetAndCity, ownerKey, ownerKind, parseAddress, sameAddress, type StreetAddress } from '../src/normalize.ts';
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

  // Building permits → normalized table + per-parcel new-units evidence.
  const permits = loadPermits(new Set(parcels.map((p) => p.id)));
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

/** Both permit extracts, normalized and de-duplicated on record number (the 2019 overlap prefers the newer ArcGIS copy). */
export function loadPermits(parcelIds: Set<string>): Permit[] {
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
  db.close();
  console.log(`parcels: ${parcels.length} → ${file}`);
}

if (import.meta.main) main();
