// Policy-builder controls ⇄ rules. A Policy is the handful of choices a person can make; applyPolicy writes them onto
// a copy of the YAML rules, so the classifier never learns about the controls.
import type { Rules } from './rules.ts';

export interface Policy {
  effectiveDate: string; // YYYY-MM-DD
  ownerOccupied: { on: boolean; maxUnits: number; adu: boolean };
  additionalProperty: { on: boolean; maxUnits: number; trustsExcluded: boolean };
  newConstruction: { on: boolean; years: number; lookbackYears: number | null };
  affordable: boolean;
  smallBuilding: { on: boolean; maxUnits: number };
  singleFamilyCondo: boolean;
  smallPortfolio: { on: boolean; maxUnits: number };
}

export interface Preset { id: string; label: string; description: string; policy: DeepPartial<Policy> }
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | T[K] : T[K] };

const rule = (rules: Rules, id: string) => {
  const r = rules.rules.find((x) => x.id === id);
  if (!r) throw new Error(`policy: rules file has no rule "${id}"`);
  return r;
};
const on = (r: { enabled?: boolean }) => r.enabled !== false;

/** The policy the rules file encodes (the April 2026 text). */
export function policyFromRules(rules: Rules): Policy {
  const oo = rule(rules, 'owner_occupied_small_building');
  const ap = rule(rules, 'one_additional_property');
  const nc = rule(rules, 'new_construction');
  const sb = rule(rules, 'small_building_exemption');
  const sp = rule(rules, 'small_portfolio_exemption');
  return {
    effectiveDate: rules.assumed_effective_date,
    ownerOccupied: { on: on(oo), maxUnits: Number(oo.max_units), adu: Number(oo.adu_allowance ?? 0) > 0 },
    additionalProperty: { on: on(ap), maxUnits: Number(ap.max_units), trustsExcluded: (ap.excluded_owner_kinds as string[]).includes('trust') },
    newConstruction: { on: on(nc), years: Number(nc.exemption_years), lookbackYears: nc.lookback_years == null ? null : Number(nc.lookback_years) },
    affordable: on(rule(rules, 'public_and_subsidized_housing')),
    smallBuilding: { on: on(sb), maxUnits: Number(sb.max_units) },
    singleFamilyCondo: on(rule(rules, 'single_family_condo_exemption')),
    smallPortfolio: { on: on(sp), maxUnits: Number(sp.max_portfolio_units) },
  };
}

export function mergePolicy(base: Policy, patch: DeepPartial<Policy>): Policy {
  const out: any = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  }
  return out as Policy;
}

export function applyPolicy(base: Rules, p: Policy): Rules {
  const rules = structuredClone(base);
  rules.assumed_effective_date = p.effectiveDate;
  const set = (id: string, patch: Record<string, unknown>) => Object.assign(rule(rules, id), patch);
  set('owner_occupied_small_building', { enabled: p.ownerOccupied.on, max_units: p.ownerOccupied.maxUnits, adu_allowance: p.ownerOccupied.adu ? 1 : 0 });
  set('owner_may_live_here', { enabled: p.ownerOccupied.on, max_units: p.ownerOccupied.maxUnits });
  set('one_additional_property', {
    enabled: p.additionalProperty.on, max_units: p.additionalProperty.maxUnits,
    excluded_owner_kinds: p.additionalProperty.trustsExcluded ? ['entity', 'trust'] : ['entity'],
  });
  set('new_construction', { enabled: p.newConstruction.on, exemption_years: p.newConstruction.years, lookback_years: p.newConstruction.lookbackYears });
  set('new_construction_permit', { enabled: p.newConstruction.on });
  set('public_and_subsidized_housing', { enabled: p.affordable });
  set('affordable_partial_or_nearby', { enabled: p.affordable });
  set('small_building_exemption', { enabled: p.smallBuilding.on, max_units: p.smallBuilding.maxUnits });
  set('single_family_condo_exemption', { enabled: p.singleFamilyCondo });
  set('small_portfolio_exemption', { enabled: p.smallPortfolio.on, max_portfolio_units: p.smallPortfolio.maxUnits });
  return rules;
}
