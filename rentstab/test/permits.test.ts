import { describe, expect, it } from 'vitest';
import { permitKind, permitUnits } from '../src/permits.ts';

const bp = (description: string, cost = 200000, permitClass: string | null = null, workClass: string | null = null) =>
  permitKind({ type: 'Building Permit', permitClass, workClass, description, cost });

describe('permitKind', () => {
  it('new residential buildings', () => {
    expect(bp('Constrution of a new 5 story building inclusive of 176 residential units & common spaces.', 30281500)).toBe('new_residential');
    expect(bp('Construct a New 2 family on Lot 415.', 150000, 'Residential - New')).toBe('new_residential');
    expect(bp('NEW SINGLE FAMILY HOME', 180000)).toBe('new_residential');
  });
  it('remodels, garages and small jobs are not new construction', () => {
    expect(bp('Two new bathrooms for 3rd floor (one on each apartments)', 8000)).toBe('other');
    expect(bp('Backyard personal garage', 5000, 'Residential - New', 'New Structure')).toBe('other');
    expect(bp('Moderate renovations to 101 apartment units, kitchen counters, painting', 50000)).toBe('other');
  });
  it('conversions of nonresidential space; unit-count shuffles are not', () => {
    expect(bp('Convert floors 2 and 3 from offices into 11 new residential units')).toBe('conversion');
    expect(bp('Full renovation to construct 23 apartments.')).toBe('conversion');
    expect(bp('Convert 3 apartments to two apartments, Remove bar in the basement.')).toBe('other');
  });
  it('dorms and raze permits are their own kinds', () => {
    expect(bp('New 6 Story Residence Hall, Brick Facade, 100+ Suites')).toBe('dorm');
    expect(permitKind({ type: 'Raze Building Permit', permitClass: null, workClass: null, description: 'raze garage', cost: 1 })).toBe('raze');
  });
});

describe('permitUnits', () => {
  it('reads unit counts from descriptions', () => {
    expect(permitUnits('inclusive of 176 residential units')).toBe(176);
    expect(permitUnits('Construct new 8 unit modular town house')).toBe(8);
    expect(permitUnits('NEW TWO FAMILY DWELLING')).toBe(2);
    expect(permitUnits('Full renovation to four (4) units')).toBe(4);
    expect(permitUnits('New roof')).toBeNull();
  });
});
