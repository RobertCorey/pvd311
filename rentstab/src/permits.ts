// Building permits → per-parcel evidence of new dwelling units (new buildings, conversions of nonresidential space).
// Stands in for certificate-of-occupancy dates, which aren't published: a CO can't predate the building permit.

export type PermitKind = 'new_residential' | 'conversion' | 'dorm' | 'raze' | 'other';

export interface Permit {
  id: string;
  source: 'socrata_2016_2020' | 'arcgis_2019_2024' | 'opengov_export_2026';
  parcelId: string | null; // plat-lot-unit as on the tax roll
  type: string; // "Building Permit", "Raze Building Permit", …
  permitClass: string | null; // Socrata permitclass / ArcGIS Structure_Type
  workClass: string | null;
  description: string;
  cost: number | null;
  issued: string | null; // ISO date
  completed: string | null;
  status: string | null;
  address: string | null;
  kind: PermitKind;
  units: number | null; // dwelling units the description says it creates
}

const NUM: Record<string, number> = { single: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const DWELLING = String.raw`(single[- ]?family|one[- ]?family|two[- ]?family|three[- ]?family|four[- ]?family|multi[- ]?family|\d+[- ]?family|dwellings?|residential|apartments?|condo\w*|town ?house\w*|row ?house\w*|units?)`;
const NEW_RES = new RegExp(String.raw`\b(new|construct\w*|erect\w*|build)\b[^.;]{0,60}?\b` + DWELLING + String.raw`\b`, 'i');
// Work that mentions "new … unit/apartment" without creating a dwelling.
const NOT_NEW = /\b(deck|porch|garage|shed|roof\w*|basement|attic|addition|accessory|adu|in-law|stair\w*|fence|pool|sign\w*|kitchen\w*|bath\w*|window\w*|siding|solar|foundation only|demo\w*|raze|interior|fit[- ]?out|tenant|sprinkler\w*|alarm\w*|boiler|furnace|hvac|electrical|plumbing|antenna\w*|elevator|repair\w*|replace\w*)\b/i;
const CONVERSION = /\b(convert\w*|conversion|change (of )?use|adaptive reuse|renovat\w*|modify|rehabilitat\w*|redevelop\w*)\b[^.;]{0,80}?\b(into|to|including|with)\b[^.;]{0,30}?\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(\(\d+\)\s*)?(new\s+)?(residential\s+|apartment\s+|dwelling\s+|loft\s+)?(units|apartments|dwelling units|lofts)\b/i;
// Unit-count changes inside an existing residential building aren't new construction (Sec. 13-69).
const UNIT_SHUFFLE = /\b(apartments?|units?|family)\s+(in)?to\s+(\d+|two|three|four|five|six|one)\s+(apartments?|units?|family)\b|\b(\d+|two|three|four|five|six)\s+(apartments?|units?)\s+to\b/i;
const FROM_NONRES = /\b(office|mill|warehouse|commercial|school|church|industrial|manufactur\w*|retail|store|factory|garage|hotel|bank|hospital|dormitor\w*|patient|vacant)\b/i;
const DORM = /residence hall|dormitor|student housing|\bbeds?\b.*\bresidence\b/i;

export function permitUnits(desc: string): number | null {
  const d = desc.toLowerCase();
  const m = d.match(/\b(\d{1,4})\s*(\(\d+\)\s*)?(new\s+)?(residential\s+|apartment\s+|dwelling\s+)?(units|apartments|dwelling units|lofts)\b/)
    ?? d.match(/\b(\d{1,2})[- ]?(family|unit)\b/);
  if (m) return Number(m[1]);
  const w = d.match(/\b(single|one|two|three|four|five|six|seven|eight|nine|ten|twelve)[- ](family|unit|apartment|dwelling unit)s?\b/)
    ?? d.match(/\b(single|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(\(\d+\)\s+)?(residential |dwelling )?(units|apartments)\b/);
  return w ? NUM[w[1]] : null;
}

export function permitKind(p: Pick<Permit, 'type' | 'permitClass' | 'workClass' | 'description' | 'cost'>): PermitKind {
  const d = p.description ?? '';
  if (/raze/i.test(p.type)) return 'raze';
  if (!/building permit/i.test(p.type)) return 'other';
  if (DORM.test(d)) return 'dorm';
  // Converting existing space ("convert offices into 11 new residential units") is never a new building.
  const convertVerb = /\b(convert\w*|conversion|change (of )?use|adaptive reuse)\b/i.test(d);
  if (convertVerb && CONVERSION.test(d) && !UNIT_SHUFFLE.test(d)) return 'conversion';
  const classSaysNew = /new structure|^new$/i.test(p.workClass ?? '') || /residential[- ]+new|new construction/i.test(p.permitClass ?? '');
  const descSaysNew = NEW_RES.test(d);
  if ((classSaysNew || descSaysNew) && !NOT_NEW.test(d) && (descSaysNew || /family|dwelling|resid/i.test(`${p.permitClass} ${d}`))) {
    // "Full renovation to construct 23 apartments" works inside an existing building: a conversion at best.
    if (/\b(renovat\w*|rehab\w*|existing building|gut)\b/i.test(d)) return 'conversion';
    if ((p.cost ?? 0) >= 40000 || permitUnits(d) != null) return 'new_residential';
  }
  if (CONVERSION.test(d) && !UNIT_SHUFFLE.test(d) && (FROM_NONRES.test(d) || /\b(convert\w*|conversion|change (of )?use|adaptive reuse)\b/i.test(d))) {
    return 'conversion';
  }
  return 'other';
}

export interface NewUnitsEvidence {
  kind: 'new_residential' | 'conversion';
  issued: string;
  units: number | null;
  record: string;
  description: string;
}

/** Latest dated new-building or conversion permit per parcel (units = max stated across that project's permits). */
export function newUnitsByParcel(permits: Permit[]): Map<string, NewUnitsEvidence> {
  const out = new Map<string, NewUnitsEvidence>();
  for (const p of permits) {
    if (!p.parcelId || !p.issued || (p.kind !== 'new_residential' && p.kind !== 'conversion')) continue;
    const prev = out.get(p.parcelId);
    if (!prev || p.issued > prev.issued) {
      out.set(p.parcelId, { kind: p.kind, issued: p.issued, units: Math.max(p.units ?? 0, prev && prev.issued >= shiftYears(p.issued, -2) ? prev.units ?? 0 : 0) || null, record: p.id, description: p.description.slice(0, 200) });
    } else if (prev.issued <= shiftYears(p.issued, 2) && (p.units ?? 0) > (prev.units ?? 0)) {
      prev.units = p.units;
    }
  }
  return out;
}

export function shiftYears(iso: string, years: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
