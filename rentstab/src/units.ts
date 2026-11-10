// Unit accounting shared by the citywide report and the policy tool.
import type { Classification } from './classify.ts';
import { notBuiltYet } from './permits.ts';
import type { Rules } from './rules.ts';
import type { Parcel } from './types.ts';

/** How a parcel's dwelling units split across the housing stock. Sums to `units`. */
export interface Mix { units: number; owned: number; controlled: number; market: number; subsidized: number; unclear: number }
export const MIX_KEYS = ['owned', 'controlled', 'market', 'subsidized', 'unclear'] as const;

const SUBSIDY_RULES = new Set(['public_and_subsidized_housing']);

export function dwellingUnits(p: Parcel, c: Classification, rules: Rules): number {
  const d = rules.data;
  if (c.status === 'not_residential_rental' && c.rule !== 'owner_own_home') return p.units ?? 0;
  const oneUnitClass = p.taxClass === d.single_family_class || p.taxClass === d.condo_class;
  // Lots built on after the 2024 assessor extract: take the unit count from the new-building permit, once the permit
  // is closed. A permit that is still open (or stopped) is a building under construction, not homes.
  return p.units ?? (c.rule === 'new_construction_permit' ? (notBuiltYet(p) ? 0 : p.newUnitsPermit?.units ?? 0) : oneUnitClass ? 1 : 0);
}

export function housingMix(p: Parcel, c: Classification, rules: Rules): Mix {
  const d = rules.data;
  const units = dwellingUnits(p, c, rules);
  const m: Mix = { units, owned: 0, controlled: 0, market: 0, subsidized: 0, unclear: 0 };
  if (!units) return m;
  if (c.rule === 'transient_lodging' || (c.status === 'not_residential_rental' && c.rule !== 'owner_own_home')) {
    m.units = 0; // hotel rooms and storefront "units" aren't housing
    return m;
  }
  const levy = d.levy_code_2_classes.includes(p.taxClass) && p.levyCode2 ? p.levyCode2 : p.levyCode;
  const ownerHere = d.owner_occupied_levy_codes.includes(levy) ? 1 : 0;
  if (c.status === 'cant_tell') { m.unclear = units; return m; }
  m.owned = Math.min(ownerHere, units);
  const rest = units - m.owned;
  if (c.status === 'likely_covered') m.controlled = rest;
  else if (c.status === 'likely_exempt') SUBSIDY_RULES.has(c.rule) ? (m.subsidized = rest) : (m.market = rest);
  else m.owned = units; // owner's own home
  return m;
}

/** Rental units for the fiscal-note comparison: the owner's own unit isn't a rental; "owner may live here" gives a range. */
export function unitCounts(p: Parcel, c: Classification, rules: Rules): { units: number; rental: number; rentalIfOwnerAbsent: number } {
  if (c.status === 'not_residential_rental') return { units: p.units ?? 0, rental: 0, rentalIfOwnerAbsent: 0 };
  const units = dwellingUnits(p, c, rules);
  const d = rules.data;
  const levy = d.levy_code_2_classes.includes(p.taxClass) && p.levyCode2 ? p.levyCode2 : p.levyCode;
  const rental = Math.max(0, units - (d.owner_occupied_levy_codes.includes(levy) ? 1 : 0));
  const maybeOwner = c.rule === 'owner_may_live_here' ? 1 : 0;
  return { units, rental: Math.max(0, rental - maybeOwner), rentalIfOwnerAbsent: rental };
}
