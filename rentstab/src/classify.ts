// classify(parcel, rules) → { status, reasons[], confidence_notes[] }
// Pure: no I/O. Every threshold, code list, pattern, status and message comes from the rules YAML; this file only knows
// how to evaluate each `test:` name. Bias: when the data can't support a confident answer, return cant_tell.
import type { Rule, Rules, Status } from './rules.ts';
import type { Parcel } from './types.ts';

export interface Classification {
  status: Status;
  reasons: string[];
  confidence_notes: string[];
  rule: string; // id of the rule that decided
  section: string;
}

interface Ctx {
  p: Parcel;
  rules: Rules;
  units: number | null; // usable unit count (single-family / condo parcels default to 1)
  oo: boolean | null; // owner-occupied tax rate
  vars: Record<string, string>;
  notes: string[];
}

type Verdict = { status: Status; reason: string; note?: string } | null;
type Test = (c: Ctx, r: Rule) => Verdict;

const has = (map: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(map, k);
const isSmallRes = (c: Ctx) => has(c.rules.data.small_residential_classes, c.p.taxClass);
const isApartment = (c: Ctx) => has(c.rules.data.apartment_classes, c.p.taxClass);
const re = (pattern: string) => new RegExp(pattern, 'i');

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function signalsOf(c: Ctx): string[] {
  const s = [...c.p.affordableSignals];
  if (re(c.rules.data.housing_authority_owner_pattern).test(c.p.owner) && !s.includes('housing_authority_owner')) s.push('housing_authority_owner');
  if (has(c.rules.data.affordable_classes, c.p.taxClass) && !s.includes('8law')) s.push('8law');
  return s;
}

function effectiveDates(rules: Rules) {
  const eff = new Date(rules.assumed_effective_date + 'T00:00:00Z');
  const lookbackYears = Number(rules.rules.find((r) => r.test === 'new_construction')?.lookback_years ?? 5);
  const lookback = new Date(eff);
  lookback.setUTCFullYear(eff.getUTCFullYear() - lookbackYears);
  return { eff, lookback };
}

const TESTS: Record<string, Test> = {
  not_residential_class(c, r) {
    const d = c.rules.data;
    if (has(d.not_residential_classes, c.p.taxClass)) {
      if (/vacant/i.test(c.p.taxClassDesc)) c.notes.push(r.note_vacant as string);
      return { status: r.status!, reason: fill(r.reason!, c.vars) };
    }
    // Any other non-residential class with no dwelling units recorded.
    if (!isSmallRes(c) && !isApartment(c) && !has(d.affordable_classes, c.p.taxClass) && !c.p.units) {
      return { status: r.status!, reason: fill(r.reason!, c.vars) };
    }
    return null;
  },

  hotel_owner(c, r) {
    if (c.p.ownerKind !== 'entity' || !re(c.rules.data.hotel_owner_pattern).test(c.p.owner)) return null;
    return { status: r.status!, reason: fill(r.reason!, c.vars), note: r.note };
  },

  affordable_strong(c, r) {
    const strong = signalsOf(c).filter((s) => c.rules.data.affordable_signals_strong.includes(s));
    if (!strong.length) return null;
    const labels = (r.signal_labels ?? {}) as Record<string, string>;
    return { status: r.status!, reason: fill(r.reason!, { ...c.vars, signals: strong.map((s) => labels[s] ?? s).join('; ') }), note: r.note };
  },

  affordable_weak(c, r) {
    const d = c.rules.data;
    const weak = signalsOf(c).filter((s) => d.affordable_signals_partial.includes(s) || d.affordable_signals_weak.includes(s));
    if (!weak.length) return null;
    const pretty = weak.map((s) => s.replace(/_nearby$/, ' (nearby address)').replace(/_partial/, ' (only some units restricted)').replace(/_/g, ' '));
    return { status: r.status!, reason: fill(r.reason!, { ...c.vars, signals: pretty.join('; ') }) };
  },

  cooperative_owner(c, r) {
    if (!re(c.rules.data.cooperative_owner_pattern).test(c.p.owner)) return null;
    return { status: r.status!, reason: fill(r.reason!, c.vars) };
  },

  institution_class(c, r) {
    const inst = c.rules.data.institution_classes[c.p.taxClass];
    if (!inst) return null;
    return { status: inst.status, reason: fill(r.reason!, c.vars) };
  },

  government_class(c, r) {
    if (!c.rules.data.government_classes.includes(c.p.taxClass)) return null;
    return { status: r.status!, reason: fill(r.reason!, c.vars) };
  },

  new_construction(c, r) {
    const yb = c.p.yearBuilt;
    if (yb == null) return null;
    const { eff, lookback } = effectiveDates(c.rules);
    const vars = { ...c.vars, effectiveYear: String(eff.getUTCFullYear()), lookbackDate: lookback.toISOString().slice(0, 10) };
    const note = `${r.note} If built to prevailing-wage + apprenticeship standards the exemption runs 20 years instead of 10. Does not apply inside a College Student Residential Overlay District.`;
    if (yb > lookback.getUTCFullYear()) return { status: r.status_inside_window as Status, reason: fill(r.reason_inside as string, vars), note };
    if (yb === lookback.getUTCFullYear()) return { status: r.status_boundary_year as Status, reason: fill(r.reason_boundary as string, vars), note };
    return null;
  },

  tsa_or_commercial_with_units(c, r) {
    const d = c.rules.data;
    if (!(has(d.tax_stabilization_classes, c.p.taxClass) || has(d.commercial_classes, c.p.taxClass))) return null;
    if (!c.p.units) return null;
    if (c.p.units <= Number(r.max_units_storefront) && !c.p.bedrooms && !c.p.bathrooms) {
      return { status: r.status_storefront as Status, reason: fill(r.reason_storefront as string, c.vars), note: r.note_storefront as string };
    }
    return { status: r.status!, reason: fill(r.reason!, c.vars) };
  },

  owner_occupied_small(c, r) {
    if (!isSmallRes(c) || c.oo !== true) return null;
    const max = Number(r.max_units), adu = Number(r.adu_allowance ?? 0);
    if (c.units == null) return { status: 'cant_tell', reason: fill(r.reason_units_missing as string, c.vars), note: r.note };
    if (c.units === 1) return { status: r.status_single_unit_owner_home as Status, reason: fill(r.reason_single_unit_owner_home as string, c.vars), note: r.note };
    if (c.units <= max) return { status: r.status!, reason: fill(r.reason!, c.vars), note: r.note };
    if (c.units <= max + adu) return { status: 'cant_tell', reason: fill(r.reason_adu as string, c.vars), note: r.note };
    return null; // owner-occupied but too big: falls through to covered
  },

  owner_mailing_is_property(c, r) {
    if (!isSmallRes(c) || c.oo !== false || c.p.mailingIsProperty !== true) return null;
    if (c.p.ownerKind === 'entity' || c.units == null || c.units > Number(r.max_units)) return null;
    return { status: r.status!, reason: fill(r.reason!, c.vars), note: r.note };
  },

  additional_property(c, r) {
    if (!isSmallRes(c) || c.oo !== false) return null;
    if ((r.excluded_owner_kinds as string[]).includes(c.p.ownerKind)) return null;
    if (c.units == null || c.units > Number(r.max_units)) return null;
    const others = c.p.ownerOtherResidential;
    const maxOthers = Number(r.max_total_properties) - 1;
    if (others.length > maxOthers) {
      c.notes.push(fill(r.note_too_many as string, { ...c.vars, count: String(others.length) }));
      return null;
    }
    const byName = others.length === 1 && others[0].ownerOccupied ? others[0] : null;
    const byMail = c.p.homeParcelId && c.p.homeParcelOwnerOccupied ? { id: c.p.homeParcelId, address: c.p.homeParcelAddress ?? '' } : null;
    const home = byName ?? byMail;
    if (!home) return null;
    const how = byName && byMail && byName.id === byMail.id ? 'same name and mailing address' : byName ? 'same name' : 'owner mails tax bills there';
    return { status: r.status_if_match as Status, reason: fill(r.reason_if_match as string, { ...c.vars, homeAddress: `${home.address}; ${how}` }), note: r.note };
  },

  residential_rental(c, r) {
    const d = c.rules.data;
    if (!(isSmallRes(c) || isApartment(c) || has(d.affordable_classes, c.p.taxClass))) return null;
    if (c.units == null && !isApartment(c)) return { status: 'cant_tell', reason: fill(r.reason_units_missing as string, c.vars) };
    if (c.p.yearBuilt == null) return { status: 'cant_tell', reason: fill(r.reason_year_missing as string, c.vars) };
    const why = fill(
      (isApartment(c) ? r.why_apartment : c.oo === true ? r.why_owner_occupied_large : c.p.ownerKind === 'entity' ? r.why_entity : r.why_default) as string,
      c.vars,
    );
    if (c.p.taxClass === d.single_family_class || c.p.taxClass === d.condo_class) c.notes.push(r.note_single_unit as string);
    if (isApartment(c) && c.p.yearBuilt < 1950) c.notes.push(r.note_old_apartments as string);
    return { status: r.status!, reason: fill(r.reason!, { ...c.vars, why }) };
  },
};

export function classify(p: Parcel, rules: Rules): Classification {
  const d = rules.data;
  const levy = d.levy_code_2_classes.includes(p.taxClass) && p.levyCode2 ? p.levyCode2 : p.levyCode;
  const oo = d.owner_occupied_levy_codes.includes(levy) ? true : d.non_owner_occupied_levy_codes.includes(levy) ? false : null;
  const oneUnitClass = p.taxClass === d.single_family_class || p.taxClass === d.condo_class;
  const units = p.units ?? (oneUnitClass ? 1 : null);
  const notes: string[] = [];
  if (p.units == null && oneUnitClass) notes.push(d_notes(rules).units_assumed_one);

  const c: Ctx = {
    p, rules, units, oo, notes,
    vars: {
      classDesc: p.taxClassDesc,
      owner: p.owner,
      units: units == null ? '?' : String(units),
      unitsText: units == null ? 'unit count unknown' : `${units} unit${units === 1 ? '' : 's'}`,
      yearBuilt: p.yearBuilt == null ? '?' : String(p.yearBuilt),
      builtText: p.yearBuilt == null ? 'year built unknown' : `built ${p.yearBuilt}`,
    },
  };

  for (const rule of rules.rules) {
    const test = TESTS[rule.test];
    if (!test) throw new Error(`rules: unknown test "${rule.test}" (rule ${rule.id})`);
    const v = test(c, rule);
    if (!v) continue;
    const confidence = [...(v.note ? [v.note] : []), ...notes, ...dataNotes(p, v.status, rules)];
    return { status: v.status, reasons: [v.reason, `Rule: ${rule.section}`], confidence_notes: confidence, rule: rule.id, section: rule.section };
  }
  return {
    status: 'cant_tell', reasons: [fill(rules.data_notes.unknown_class, { ...c.vars, taxClass: p.taxClass })],
    confidence_notes: [...notes, ...dataNotes(p, 'cant_tell', rules)], rule: 'none', section: '',
  };
}

const d_notes = (rules: Rules) => rules.data_notes;

/** Caveats about the data itself, attached to every result they apply to. */
function dataNotes(p: Parcel, status: Status, rules: Rules): string[] {
  const t = rules.data_notes;
  const n: string[] = [];
  if (p.lastSaleDate && p.lastSaleDate >= t.roll_assessment_date) n.push(fill(t.sold_after_roll, { saleDate: p.lastSaleDate }));
  if (!p.camaMatched) n.push(t.no_cama);
  if (status === 'likely_covered' || status === 'likely_exempt') n.push(t.assessor_units);
  if (status === 'likely_covered') n.push(t.rarer_exemptions);
  return n;
}
