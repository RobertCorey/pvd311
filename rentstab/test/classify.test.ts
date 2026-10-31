import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.ts';
import { loadRules, type Rules } from '../src/rules.ts';
import type { Parcel } from '../src/types.ts';

const RULES = loadRules(join(import.meta.dirname, '..', 'rules', 'ordinance-2026-04.yaml'));

/** Default: a 3-family, non-owner-occupied, person-owned, mail elsewhere, built 1920 — plain covered. */
function parcel(over: Partial<Parcel> = {}): Parcel {
  return {
    id: '001-0001-0000', address: '10 Test St', neighborhood: 'Elmhurst', lat: 41.83, lng: -71.43,
    taxClass: '2', taxClassDesc: '2-5 Family', levyCode: 'NOO2-5', levyCode2: null, ownerOccupiedTaxRate: false,
    owner: 'Jane Q Smith', ownerKind: 'person', ownerKey: 'person:jane smith', mailingStreet: '99 Elsewhere Rd',
    mailingCity: 'Cranston RI  02920', mailingIsProperty: false, totalAssessment: 400000, totalExempt: 0,
    camaMatched: true, units: 3, yearBuilt: 1920, useCode: '02', useDesc: '2-5 Family', numBuildings: 1,
    bedrooms: 6, bathrooms: 3, lastSaleDate: '2015-06-01', condoBuildingUnits: null,
    ownerOtherResidentialParcels: 0, ownerOtherResidential: [], ownerNameAmbiguous: false, ownerPortfolioUnits: 3,
    homeParcelId: null, homeParcelAddress: null, homeParcelOwnerOccupied: null, homeParcelSameOwner: null,
    newUnitsPermit: null, razePermitDate: null, permitCostSince2019: 0, manual: null,
    affordableSignals: [],
    ...over,
  };
}
const oo = (over: Partial<Parcel> = {}) => parcel({ levyCode: 'OO2-5', ownerOccupiedTaxRate: true, mailingIsProperty: true, mailingStreet: '10 Test St', mailingCity: 'Providence RI  02908', ...over });
const run = (over: Partial<Parcel> = {}, rules: Rules = RULES) => classify(parcel(over), rules);

describe('result shape', () => {
  it('always returns one of the four statuses, a reason, and the section that decided', () => {
    for (const p of [parcel(), oo(), parcel({ taxClass: '13', taxClassDesc: 'Residential Vacant Land', units: null })]) {
      const r = classify(p, RULES);
      expect(RULES.statuses).toContain(r.status);
      expect(r.reasons.length).toBeGreaterThanOrEqual(2);
      expect(r.reasons[1]).toMatch(/^Rule: Sec\. 13-/);
      expect(Array.isArray(r.confidence_notes)).toBe(true);
    }
  });
  it('every YAML rule cites a section and uses a known test', () => {
    for (const r of RULES.rules) expect(r.section).toMatch(r.enabled === false ? /not in the April 2026 ordinance/ : /Sec\. 13-/);
    const broken = structuredClone(RULES);
    broken.rules[0].test = 'no_such_test';
    expect(() => classify(parcel(), broken)).toThrow(/unknown test/);
  });
});

describe('not a residential rental', () => {
  it('vacant land, with a note about possible new buildings', () => {
    const r = run({ taxClass: '13', taxClassDesc: 'Residential Vacant Land', levyCode: 'NO01', ownerOccupiedTaxRate: false, units: null, yearBuilt: null });
    expect(r.status).toBe('not_residential_rental');
    expect(r.confidence_notes.join(' ')).toMatch(/new construction/);
  });
  it('commercial parcel with no units', () => {
    expect(run({ taxClass: '6', taxClassDesc: 'Commercial II', levyCode: 'C01', ownerOccupiedTaxRate: null, units: null }).status).toBe('not_residential_rental');
  });
  it('hotel by entity owner name → transient lodging', () => {
    const r = run({ taxClass: '6', taxClassDesc: 'Commercial II', levyCode: 'C01', ownerOccupiedTaxRate: null, units: 292, owner: 'Weybosset Hotel LLC', ownerKind: 'entity' });
    expect(r.status).toBe('not_residential_rental');
    expect(r.rule).toBe('transient_lodging');
    expect(r.section).toContain('13-78(d)');
  });
  it('a person whose name matches the hotel pattern is not a hotel', () => {
    expect(run({ owner: 'Lionel Hampton', ownerKind: 'person' }).rule).not.toBe('transient_lodging');
  });
  it('owner-occupied single-family = the owner\'s home, no rental unit', () => {
    const r = classify(oo({ taxClass: '1', taxClassDesc: 'Single Family', levyCode: 'OO01', units: 1 }), RULES);
    expect(r.status).toBe('not_residential_rental');
    expect(r.rule).toBe('owner_own_home');
  });
  it('owner-occupied condo unit = the owner\'s home', () => {
    expect(classify(oo({ taxClass: '23', taxClassDesc: 'Residential Condo', levyCode: 'OO01', units: null }), RULES).status).toBe('not_residential_rental');
  });
  it('deeded condo parking/storage unit is not a dwelling', () => {
    const r = run({ id: '026-0367-S424', taxClass: '23', taxClassDesc: 'Residential Condo', levyCode: 'NO01', units: null, yearBuilt: null, bedrooms: 0, bathrooms: 0 });
    expect(r.status).toBe('not_residential_rental');
    expect(r.reasons[0]).toMatch(/parking/);
  });
  it('a numbered condo unit with a missing unit count is still a home', () => {
    expect(run({ id: '003-0204-1201', taxClass: '23', taxClassDesc: 'Residential Condo', levyCode: 'NO01', units: null }).status).toBe('likely_covered');
  });
  it('small commercial "units" with no bedrooms or bathrooms are storefronts', () => {
    const r = run({ taxClass: '6', taxClassDesc: 'Commercial II', levyCode: 'C01', ownerOccupiedTaxRate: null, units: 2, bedrooms: 0, bathrooms: 0, ownerKind: 'entity', owner: 'Shops LLC' });
    expect(r.status).toBe('not_residential_rental');
    expect(r.rule).toBe('tax_stabilization_or_commercial_units');
  });
});

describe('regulated affordable housing — Sec. 13-78(i), (j)', () => {
  it('8LAW low-income assessment → likely exempt, labelled', () => {
    const r = run({ taxClass: '12', taxClassDesc: 'Miscellaneous', levyCode: '8LAW', ownerOccupiedTaxRate: null, units: 40, affordableSignals: ['8law'], ownerKind: 'entity' });
    expect(r.status).toBe('likely_exempt');
    expect(r.reasons[0]).toMatch(/8% low-income housing tax assessment/);
    expect(r.confidence_notes.join(' ')).toMatch(/Voucher tenants in private housing are covered/);
  });
  it('housing-authority owner is enough, even without a list match', () => {
    expect(run({ owner: 'Housing Authority City of Providence', ownerKind: 'entity', taxClass: '78', taxClassDesc: 'Municipal', levyCode: 'E01', ownerOccupiedTaxRate: null, units: 2 }).status).toBe('likely_exempt');
  });
  it('LIHTC project with only some restricted units → can\'t tell', () => {
    expect(run({ taxClass: '03-11+', taxClassDesc: 'apt 11+ units', levyCode: 'C11', ownerOccupiedTaxRate: null, units: 60, affordableSignals: ['lihtc_partial'] }).status).toBe('cant_tell');
  });
  it('a subsidy list match only by proximity → can\'t tell', () => {
    const r = run({ taxClass: '03-11+', taxClassDesc: 'apt 11+ units', levyCode: 'C11', ownerOccupiedTaxRate: null, units: 60, affordableSignals: ['hud_assisted_nearby'] });
    expect(r.status).toBe('cant_tell');
    expect(r.reasons[0]).toMatch(/nearby address/);
  });
});

describe('other categorical exemptions', () => {
  it('cooperative by owner name → can\'t tell', () => {
    expect(run({ owner: 'Elm Street Housing Cooperative Inc', ownerKind: 'entity', taxClass: '03-11+', taxClassDesc: 'apt 11+ units', levyCode: 'C11', ownerOccupiedTaxRate: null, units: 20 }).rule).toBe('cooperative');
  });
  it('university (school class) housing → can\'t tell (dorm vs. ordinary lease)', () => {
    const r = run({ taxClass: '79', taxClassDesc: 'School', levyCode: 'E01', ownerOccupiedTaxRate: null, units: 219, owner: 'BROWN UNIVERSITY', ownerKind: 'entity' });
    expect(r.status).toBe('cant_tell');
    expect(r.section).toContain('13-78(a)');
  });
  it('hospital-class residence → likely exempt (institution status comes from YAML)', () => {
    expect(run({ taxClass: '75', taxClassDesc: 'Hospital', levyCode: 'E01', ownerOccupiedTaxRate: null, units: 1, ownerKind: 'entity' }).status).toBe('likely_exempt');
  });
  it('government-owned with units → can\'t tell', () => {
    expect(run({ taxClass: '80', taxClassDesc: 'State', levyCode: 'E01', ownerOccupiedTaxRate: null, units: 12, ownerKind: 'entity', owner: 'State of Rhode Island' }).status).toBe('cant_tell');
  });
  it('tax-stabilization parcel with many units → can\'t tell', () => {
    expect(run({ taxClass: '83', taxClassDesc: '44-3-9 Stb', levyCode: 'TSA', ownerOccupiedTaxRate: null, units: 200, ownerKind: 'entity', owner: 'Mill Lofts LLC', yearBuilt: 1900 }).status).toBe('cant_tell');
  });
});

describe('new construction — Sec. 13-78(m), assumed effective 2027-04-15 → look-back to 2022', () => {
  const apt = { taxClass: '03-11+', taxClassDesc: 'apt 11+ units', levyCode: 'C11', ownerOccupiedTaxRate: null, units: 40, ownerKind: 'entity' as const, owner: 'New Build LLC' };
  it('built inside the look-back → likely exempt', () => {
    const r = run({ ...apt, yearBuilt: 2024 });
    expect(r.status).toBe('likely_exempt');
    expect(r.reasons[0]).toMatch(/built 2024/);
    expect(r.confidence_notes.join(' ')).toMatch(/20 years/);
  });
  it('built in the boundary year → can\'t tell', () => {
    const r = run({ ...apt, yearBuilt: 2022 });
    expect(r.status).toBe('cant_tell');
    expect(r.reasons[0]).toMatch(/2022-04-15/);
  });
  it('built before the look-back → not eligible, falls through to covered', () => {
    expect(run({ ...apt, yearBuilt: 2021 }).status).toBe('likely_covered');
  });
  it('the look-back moves with the assumed effective date (YAML)', () => {
    const later = structuredClone(RULES);
    later.assumed_effective_date = '2029-01-01'; // look-back starts 2024-01-01: all of 2024 is inside
    expect(run({ ...apt, yearBuilt: 2024 }, later).status).toBe('likely_exempt');
    expect(run({ ...apt, yearBuilt: 2023 }, later).status).toBe('likely_covered');
  });
});

describe('new-building permits — Sec. 13-78(m), stand-in for CO dates', () => {
  const vacant = { taxClass: '13', taxClassDesc: 'Residential Vacant Land', levyCode: 'NO01', units: null, yearBuilt: null };
  const permit = (issued: string, kind: 'new_residential' | 'conversion' = 'new_residential', units: number | null = 176) =>
    ({ kind, issued, units, record: 'BLDG-23-1', description: 'Construction of a new 5 story building inclusive of 176 residential units' });
  it('lot that was vacant in 2024 with a 2023 new-building permit → likely exempt (CO can\'t predate the permit)', () => {
    const r = run({ ...vacant, newUnitsPermit: permit('2023-11-21') });
    expect(r.status).toBe('likely_exempt');
    expect(r.reasons[0]).toMatch(/176-unit building issued 2023-11/);
  });
  it('permit issued shortly before the look-back start → can\'t tell', () => {
    expect(run({ ...vacant, newUnitsPermit: permit('2021-06-01') }).status).toBe('cant_tell');
  });
  it('a pre-look-back permit defers to the assessor\'s year built when it shows the new building', () => {
    expect(run({ yearBuilt: 2020, newUnitsPermit: permit('2019-08-01', 'new_residential', 3) }).rule).not.toBe('new_construction_permit');
  });
  it('old permits are ignored', () => {
    expect(run({ ...vacant, newUnitsPermit: permit('2017-06-01') }).status).toBe('not_residential_rental');
  });
  it('new building beside an older one on the same lot → can\'t tell', () => {
    const r = run({ yearBuilt: 1920, newUnitsPermit: permit('2023-03-01', 'new_residential', 7) });
    expect(r.status).toBe('cant_tell');
    expect(r.reasons[0]).toMatch(/older units on the lot would not/);
  });
  it('…unless the old building was razed first', () => {
    expect(run({ yearBuilt: 1920, razePermitDate: '2022-09-01', newUnitsPermit: permit('2023-03-01', 'new_residential', 2) }).status).toBe('likely_exempt');
  });
  it('conversion permits → can\'t tell', () => {
    expect(run({ taxClass: '6', taxClassDesc: 'Commercial II', levyCode: 'C01', ownerOccupiedTaxRate: null, units: 11, newUnitsPermit: permit('2023-01-01', 'conversion', 11) }).status).toBe('cant_tell');
  });
});

describe('researched building labels', () => {
  const big = { taxClass: '6', taxClassDesc: 'Commercial II', levyCode: 'C01', ownerOccupiedTaxRate: null, units: 350, ownerKind: 'entity' as const, owner: 'CJUF III MJH PROVIDENCE LLC', yearBuilt: 1975 };
  const label = (use: string, extra: object = {}) => ({ use, name: 'Test Place', residentialUnits: null, opened: null, conversion: false, confidence: 'high', sources: 'https://x', ...extra });
  it('a hotel label settles a big commercial parcel', () => {
    const r = run({ ...big, manual: label('hotel') });
    expect(r.status).toBe('not_residential_rental');
    expect(r.rule).toBe('researched_building');
  });
  it('market apartments that opened inside the look-back are new construction', () => {
    expect(run({ ...big, manual: label('apartments_market', { opened: 2024, residentialUnits: 176 }) }).status).toBe('likely_exempt');
    expect(run({ ...big, manual: label('apartments_market', { opened: 2015 }) }).status).toBe('likely_covered');
  });
  it('low-confidence labels are ignored', () => {
    expect(run({ ...big, manual: label('hotel', { confidence: 'low' }) }).rule).not.toBe('researched_building');
  });
});

describe('owner-occupied 1–4 units — Sec. 13-78(n) ¶1', () => {
  it('3 units on the owner-occupied rate → likely exempt, with the brief\'s reason format', () => {
    const r = classify(oo({ units: 3, yearBuilt: 1910 }), RULES);
    expect(r.status).toBe('likely_exempt');
    expect(r.reasons[0]).toBe('3 units · built 1910 · owner-occupied tax rate on file → likely exempt (owner-occupied 1–4 units)');
  });
  it('4 units → likely exempt (the final text says 1–4; the January draft said 1–3)', () => {
    expect(classify(oo({ units: 4 }), RULES).status).toBe('likely_exempt');
  });
  it('5 units → can\'t tell (only if one is an ADU)', () => {
    const r = classify(oo({ units: 5 }), RULES);
    expect(r.status).toBe('cant_tell');
    expect(r.reasons[0]).toMatch(/accessory dwelling unit/);
  });
  it('6 units → covered even with the owner living there', () => {
    const r = classify(oo({ units: 6 }), RULES);
    expect(r.status).toBe('likely_covered');
    expect(r.reasons[0]).toMatch(/covers 1–4 units/);
  });
  it('unit count missing → can\'t tell', () => {
    expect(classify(oo({ units: null }), RULES).status).toBe('cant_tell');
  });
  it('mixed-use parcel reads owner-occupancy from the second levy code', () => {
    const r = run({ taxClass: '04-05U', taxClassDesc: 'combo 5 units', levyCode: 'C01', levyCode2: 'OO2-5', ownerOccupiedTaxRate: null, units: 3 });
    expect(r.status).toBe('likely_exempt');
  });
  it('rules come from YAML: lowering max_units to 3 makes the 4-family covered', () => {
    const jan = structuredClone(RULES);
    jan.rules.find((x) => x.id === 'owner_occupied_small_building')!.max_units = 3;
    jan.rules.find((x) => x.id === 'owner_occupied_small_building')!.adu_allowance = 0;
    expect(classify(oo({ units: 4 }), jan).status).toBe('likely_covered');
  });
});

describe('owner may live here without the tax status', () => {
  it('non-owner rate but the owner\'s mail goes to the property → can\'t tell', () => {
    const r = run({ mailingIsProperty: true });
    expect(r.status).toBe('cant_tell');
    expect(r.rule).toBe('owner_may_live_here');
  });
  it('…but not for an LLC owner', () => {
    expect(run({ mailingIsProperty: true, ownerKind: 'entity', owner: '10 Test LLC' }).status).toBe('likely_covered');
  });
  it('…and not for a building over 4 units', () => {
    expect(run({ mailingIsProperty: true, units: 6 }).status).toBe('likely_covered');
  });
});

describe('one additional property — Sec. 13-78(n) ¶2', () => {
  const home = [{ id: '002-0002-0000', address: '5 Home St', ownerOccupied: true }];
  it('owner\'s only other Providence parcel is owner-occupied → can\'t tell (low-confidence match, must be claimed)', () => {
    const r = run({ ownerOtherResidential: home, ownerOtherResidentialParcels: 1 });
    expect(r.status).toBe('cant_tell');
    expect(r.reasons[0]).toMatch(/same name/);
    expect(r.reasons[0]).not.toMatch(/5 Home St/); // no other-home addresses in reasons
    expect(r.confidence_notes.join(' ')).toMatch(/low confidence/);
  });
  it('a trust owner still qualifies (trusts were dropped from the excluded list)', () => {
    expect(run({ ownerKind: 'trust', owner: 'Jane Smith Trustee', ownerOtherResidential: home, ownerOtherResidentialParcels: 1 }).status).toBe('cant_tell');
  });
  it('an LLC owner does not', () => {
    expect(run({ ownerKind: 'entity', owner: 'Smith Holdings LLC', ownerOtherResidential: home, ownerOtherResidentialParcels: 1 }).status).toBe('likely_covered');
  });
  it('the other parcel is not owner-occupied → covered', () => {
    expect(run({ ownerOtherResidential: [{ ...home[0], ownerOccupied: false }], ownerOtherResidentialParcels: 1 }).status).toBe('likely_covered');
  });
  it('owner holds 3+ residential parcels → not eligible, covered with a note', () => {
    const r = run({ ownerOtherResidential: [...home, { id: 'x', address: '7 Other St', ownerOccupied: false }], ownerOtherResidentialParcels: 2 });
    expect(r.status).toBe('likely_covered');
    expect(r.confidence_notes.join(' ')).toMatch(/matches 2 other Providence residential parcels/);
  });
  it('a name shared by several owner-occupants is ignored (no "too many", no name match)', () => {
    const many = [...home, { id: 'x', address: '7 Other St', ownerOccupied: true }, { id: 'y', address: '9 Third St', ownerOccupied: false }];
    const r = run({ ownerNameAmbiguous: true, ownerOtherResidential: many, ownerOtherResidentialParcels: 3 });
    expect(r.status).toBe('likely_covered');
    expect(r.confidence_notes.join(' ')).toMatch(/name matching is skipped/);
    expect(r.confidence_notes.join(' ')).not.toMatch(/more than the 2 properties/);
  });
  it('matched by the owner\'s mailing address instead of the name', () => {
    const r = run({ homeParcelId: '002-0002-0000', homeParcelAddress: '5 Home St', homeParcelOwnerOccupied: true, homeParcelSameOwner: false });
    expect(r.status).toBe('cant_tell');
    expect(r.reasons[0]).toMatch(/owner mails tax bills there/);
  });
  it('the additional property must have ≤4 units', () => {
    expect(run({ units: 6, taxClass: '2', ownerOtherResidential: home, ownerOtherResidentialParcels: 1 }).status).toBe('likely_covered');
  });
});

describe('alternative designs (off by default)', () => {
  const on = (id: string, patch: object = {}) => {
    const r = structuredClone(RULES);
    Object.assign(r.rules.find((x) => x.id === id)!, { enabled: true, ...patch });
    return r;
  };
  it('are off in the as-passed rules', () => {
    expect(run({ taxClass: '1', taxClassDesc: 'Single Family', levyCode: 'NO01', units: 1 }).status).toBe('likely_covered');
  });
  it('small-building exemption exempts a non-owner-occupied 3-family', () => {
    const r = run({}, on('small_building_exemption'));
    expect(r.status).toBe('likely_exempt');
    expect(r.reasons[0]).toMatch(/4 or fewer units/);
  });
  it('single-family / condo exemption', () => {
    expect(run({ taxClass: '23', taxClassDesc: 'Residential Condo', levyCode: 'NO01', units: 1 }, on('single_family_condo_exemption')).status).toBe('likely_exempt');
  });
  it('small-portfolio exemption counts the owner\'s units, and can\'t tell for shared names', () => {
    const rules = on('small_portfolio_exemption', { max_portfolio_units: 4 });
    expect(run({ ownerPortfolioUnits: 3 }, rules).status).toBe('likely_exempt');
    expect(run({ ownerPortfolioUnits: 9 }, rules).status).toBe('likely_covered');
    expect(run({ ownerPortfolioUnits: 3, ownerNameAmbiguous: true }, rules).status).toBe('cant_tell');
  });
  it('switching off an exemption makes it stop applying, but the owner\'s own home stays not-a-rental', () => {
    const rules = structuredClone(RULES);
    rules.rules.find((x) => x.id === 'owner_occupied_small_building')!.enabled = false;
    expect(classify(oo({ units: 3 }), rules).status).toBe('likely_covered');
    expect(classify(oo({ taxClass: '1', taxClassDesc: 'Single Family', levyCode: 'OO01', units: 1 }), rules).status).toBe('not_residential_rental');
  });
  it('no look-back limit + 15-year exemption (January draft) reaches a 2014 building', () => {
    const rules = structuredClone(RULES);
    Object.assign(rules.rules.find((x) => x.id === 'new_construction')!, { exemption_years: 15, lookback_years: null });
    const apt = { taxClass: '03-11+', taxClassDesc: 'apt 11+ units', levyCode: 'C11', ownerOccupiedTaxRate: null, units: 40, ownerKind: 'entity' as const, owner: 'X LLC' };
    expect(run({ ...apt, yearBuilt: 2014 }, rules).status).toBe('likely_exempt');
    expect(run({ ...apt, yearBuilt: 2014 }).status).toBe('likely_covered');
  });
});

describe('covered by default — Sec. 13-70(c)', () => {
  it('non-owner-occupied 3-family → likely covered with reasons tied to fields', () => {
    const r = run();
    expect(r.status).toBe('likely_covered');
    expect(r.reasons[0]).toBe('3 units · built 1920 · non-owner-occupied tax rate · owner mails tax bills elsewhere → likely covered');
  });
  it('LLC-owned house mailed to itself stays covered but carries the open question', () => {
    const r = run({ taxClass: '1', taxClassDesc: 'Single Family', levyCode: 'NO01', units: 1, ownerKind: 'entity', owner: 'JEJ Construction LLC', mailingIsProperty: true });
    expect(r.status).toBe('likely_covered');
    expect(r.confidence_notes.join(' ')).toMatch(/LLC member living here/);
  });
  it('rented single-family is covered, noted as "only if actually rented"', () => {
    const r = run({ taxClass: '1', taxClassDesc: 'Single Family', levyCode: 'NO01', units: 1 });
    expect(r.status).toBe('likely_covered');
    expect(r.confidence_notes.join(' ')).toMatch(/only if actually rented/);
  });
  it('old apartment building carries the adaptive-reuse caveat', () => {
    const r = run({ taxClass: '03-11+', taxClassDesc: 'apt 11+ units', levyCode: 'C11', ownerOccupiedTaxRate: null, units: 30, yearBuilt: 1900, ownerKind: 'entity', owner: 'Mill LLC' });
    expect(r.status).toBe('likely_covered');
    expect(r.confidence_notes.join(' ')).toMatch(/converting a non-residential building/);
  });
  it('year built missing → can\'t tell (can\'t rule out new construction)', () => {
    expect(run({ yearBuilt: null }).status).toBe('cant_tell');
  });
  it('2-5 family with no unit count → can\'t tell', () => {
    expect(run({ units: null }).status).toBe('cant_tell');
  });
});

describe('data caveats', () => {
  it('a sale after the roll\'s assessment date is flagged', () => {
    expect(classify(oo({ lastSaleDate: '2025-03-01' }), RULES).confidence_notes.join(' ')).toMatch(/Sold 2025-03-01/);
  });
  it('no assessor record is flagged', () => {
    expect(run({ camaMatched: false, units: null, yearBuilt: null }).confidence_notes.join(' ')).toMatch(/No assessor building record/);
  });
  it('an unknown tax class → can\'t tell', () => {
    const r = run({ taxClass: '99', taxClassDesc: 'Mystery', levyCode: 'X', ownerOccupiedTaxRate: null, units: 3 });
    expect(r.status).toBe('cant_tell');
  });
});
