import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classify } from '../src/classify.ts';
import { applyPolicy, mergePolicy, policyFromRules, type Preset } from '../src/policy.ts';
import { loadRules } from '../src/rules.ts';

const ROOT = join(import.meta.dirname, '..');
const RULES = loadRules(join(ROOT, 'rules', 'ordinance-2026-04.yaml'));
const PRESETS = parse(readFileSync(join(ROOT, 'rules', 'presets.yaml'), 'utf8')) as Preset[];

describe('policy ⇄ rules', () => {
  it('the default policy reproduces the rules file exactly', () => {
    const p = policyFromRules(RULES);
    expect(p.ownerOccupied).toEqual({ on: true, maxUnits: 4, adu: true });
    expect(p.newConstruction).toEqual({ on: true, years: 10, lookbackYears: 5 });
    expect(p.smallBuilding.on).toBe(false);
    const norm = (r: typeof RULES) => ({ ...r, rules: r.rules.map((x) => ({ ...x, enabled: x.enabled !== false })) });
    expect(norm(applyPolicy(RULES, p))).toEqual(norm(RULES));
  });
  it('the first preset is the as-passed ordinance with no overrides', () => {
    expect(PRESETS[0].id).toBe('april_2026');
    expect(PRESETS[0].policy).toEqual({});
  });
  it('the January preset changes the thresholds it names and nothing else', () => {
    const jan = mergePolicy(policyFromRules(RULES), PRESETS.find((x) => x.id === 'january_2026_draft')!.policy);
    expect(jan.ownerOccupied).toEqual({ on: true, maxUnits: 3, adu: false });
    expect(jan.additionalProperty.trustsExcluded).toBe(true);
    expect(jan.newConstruction).toEqual({ on: true, years: 15, lookbackYears: null });
    expect(jan.affordable).toBe(true);
    const rules = applyPolicy(RULES, jan);
    expect(rules.rules.find((r) => r.id === 'one_additional_property')!.excluded_owner_kinds).toEqual(['entity', 'trust']);
  });
  it('a policy edit flows through to classification', () => {
    const base = policyFromRules(RULES);
    const parcel: any = {
      id: '1-1-0', address: '1 A St', neighborhood: null, lat: 0, lng: 0, taxClass: '2', taxClassDesc: '2-5 Family', levyCode: 'NOO2-5',
      levyCode2: null, ownerOccupiedTaxRate: false, owner: '', ownerKind: 'person', mailingIsProperty: false, camaMatched: true, units: 3,
      yearBuilt: 1920, bedrooms: 6, bathrooms: 3, lastSaleDate: null, ownerOtherResidential: [], ownerNameAmbiguous: false,
      ownerPortfolioUnits: 3, homeParcelId: null, homeParcelOwnerOccupied: null, newUnitsPermit: null, razePermitDate: null, affordableSignals: [],
    };
    expect(classify(parcel, applyPolicy(RULES, base)).status).toBe('likely_covered');
    expect(classify(parcel, applyPolicy(RULES, mergePolicy(base, { smallBuilding: { on: true, maxUnits: 3 } }))).status).toBe('likely_exempt');
    expect(classify(parcel, applyPolicy(RULES, mergePolicy(base, { smallPortfolio: { on: true, maxUnits: 2 } }))).status).toBe('likely_covered');
  });
});
