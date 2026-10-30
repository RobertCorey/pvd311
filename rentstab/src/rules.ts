import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type Status = 'likely_covered' | 'likely_exempt' | 'cant_tell' | 'not_residential_rental';

export interface Rule {
  id: string;
  test: string;
  label?: string; // short name for summaries
  enabled?: boolean; // false = skipped (alternative designs, or a policy-builder switch)
  section: string;
  quote?: string;
  status?: Status;
  reason?: string;
  note?: string;
  [param: string]: unknown;
}

export interface Rules {
  id: string;
  title: string;
  assumed_effective_date: string;
  statuses: Status[];
  data: {
    owner_occupied_levy_codes: string[];
    non_owner_occupied_levy_codes: string[];
    small_residential_classes: Record<string, string>;
    apartment_classes: Record<string, string>;
    levy_code_2_classes: string[];
    condo_class: string;
    condo_accessory_unit_pattern: string;
    single_family_class: string;
    affordable_classes: Record<string, string>;
    tax_stabilization_classes: Record<string, string>;
    commercial_classes: Record<string, string>;
    institution_classes: Record<string, { name: string; status: Status }>;
    government_classes: string[];
    not_residential_classes: Record<string, string>;
    hotel_owner_pattern: string;
    cooperative_owner_pattern: string;
    housing_authority_owner_pattern: string;
    affordable_signals_strong: string[];
    affordable_signals_partial: string[];
    affordable_signals_weak: string[];
  };
  rules: Rule[];
  data_notes: Record<'units_assumed_one' | 'sold_after_roll' | 'roll_assessment_date' | 'no_cama' | 'assessor_units' | 'rarer_exemptions' | 'unknown_class', string>;
  not_evaluable: { section: string; name: string; note?: string }[];
  disclaimer: string;
}

export function loadRules(path: string): Rules {
  const rules = parse(readFileSync(path, 'utf8')) as Rules;
  // YAML keys like 1 and 23 must stay strings so they compare against roll CLASS values.
  for (const key of ['small_residential_classes', 'apartment_classes', 'affordable_classes', 'tax_stabilization_classes',
    'commercial_classes', 'institution_classes', 'not_residential_classes'] as const) {
    rules.data[key] = Object.fromEntries(Object.entries(rules.data[key] as object).map(([k, v]) => [String(k), v])) as any;
  }
  rules.data.government_classes = rules.data.government_classes.map(String);
  rules.data.levy_code_2_classes = rules.data.levy_code_2_classes.map(String);
  rules.data.condo_class = String(rules.data.condo_class);
  rules.data.single_family_class = String(rules.data.single_family_class);
  rules.assumed_effective_date = String(rules.assumed_effective_date);
  for (const r of rules.rules) if (r.status && !rules.statuses.includes(r.status)) throw new Error(`rule ${r.id}: unknown status ${r.status}`);
  return rules;
}
