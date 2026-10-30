// Normalize data/raw/*.json into data/parcels.sqlite (table `parcels`, one row per tax-roll parcel).
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mailingStreetAndCity, ownerKey, ownerKind, parseAddress, sameAddress, type StreetAddress } from '../src/normalize.ts';
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

  const parcels: Parcel[] = roll.map((r) => {
    const c = cama.get(r.tax_map);
    const mail = mailingStreetAndCity([r.mailing_2, r.mailing_3, r.mailing_4, r.mailing_5]);
    const levy: string = r.levy_code_1 ?? '';
    const ooRate = /^OO/.test(levy) ? true : /^NOO?/.test(levy) ? false : null;
    const sale = num(c?.SaleDate);
    const pt = r.property_location?.coordinates;
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
      homeParcelId: null,
      homeParcelAddress: null,
      homeParcelOwnerOccupied: null,
      homeParcelSameOwner: null,
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
    for (const p of list) {
      p.ownerOtherResidential = list.filter((q) => q !== p).map((q) => ({ id: q.id, address: q.address, ownerOccupied: q.ownerOccupiedTaxRate }));
      p.ownerOtherResidentialParcels = p.ownerOtherResidential.length;
    }
  }

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
  return parcels;
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
      return Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v;
    }));
  }
  db.exec('COMMIT');
  db.exec('CREATE INDEX parcels_address ON parcels(address)');
  db.close();
  console.log(`parcels: ${parcels.length} → ${file}`);
}

if (import.meta.main) main();
