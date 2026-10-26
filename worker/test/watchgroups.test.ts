import { describe, expect, it } from 'vitest';
import { caseGroup, groupAllowed, isGroupKey, parseWatchGroups, watchGroupsOf, MAX_WATCH_GROUPS } from '../src/watchgroups.js';
import { CATEGORIES, GROUP_ORDER } from '../../shared/categories.js';

const ALL = ['trash', 'streets', 'traffic', 'trees', 'property', 'lights', 'nuisance', 'water', 'animals', 'other'];

describe('caseGroup', () => {
  it('reads the registry: pothole → streets, missed_trash → trash, street_light → lights, graffiti → property, tree → trees', () => {
    expect(caseGroup({ category: 'pothole' })).toBe('streets');
    expect(caseGroup({ category: 'missed_trash' })).toBe('trash');
    expect(caseGroup({ category: 'street_light' })).toBe('lights');
    expect(caseGroup({ category: 'graffiti' })).toBe('property');
    expect(caseGroup({ category: 'tree' })).toBe('trees');
  });

  it('"unsure", an unknown key, a missing or non-string category and an inherited object key are all "other"', () => {
    expect(caseGroup({ category: 'unsure' })).toBe('other');
    expect(caseGroup({ category: 'never_heard_of_it' })).toBe('other');
    expect(caseGroup({})).toBe('other');
    expect(caseGroup({ category: 7 })).toBe('other');
    expect(caseGroup({ category: 'constructor' })).toBe('other');
    expect(caseGroup({ category: 'toString' })).toBe('other');
  });

  it('every registry category maps to one of the ten groups, so the chip row covers the whole feed', () => {
    for (const [key, cfg] of Object.entries(CATEGORIES)) expect(GROUP_ORDER, key).toContain(cfg.group);
    expect(GROUP_ORDER).toEqual(ALL);
    expect(MAX_WATCH_GROUPS).toBe(10);
  });
});

describe('parseWatchGroups (what PATCH /api/me stores)', () => {
  it('null / undefined / [] are everything', () => {
    expect(parseWatchGroups(null)).toEqual([]);
    expect(parseWatchGroups(undefined)).toEqual([]);
    expect(parseWatchGroups([])).toEqual([]);
  });

  it('keeps known keys only, dedupes, and orders them like the picker (GROUP_ORDER)', () => {
    expect(parseWatchGroups(['streets', 'trash', 'streets'])).toEqual(['trash', 'streets']);
    expect(parseWatchGroups(['other', 'animals', 'bogus', 7, null, {}, 'TRASH', ' trash'])).toEqual(['animals', 'other']);
    expect(parseWatchGroups([...ALL].reverse())).toEqual(ALL);
    expect(parseWatchGroups([...ALL, ...ALL, ...ALL])).toHaveLength(MAX_WATCH_GROUPS);
  });

  it('anything that is not an array is invalid (null → the route 400s)', () => {
    expect(parseWatchGroups('streets')).toBeNull();
    expect(parseWatchGroups(1)).toBeNull();
    expect(parseWatchGroups({ streets: true })).toBeNull();
    expect(parseWatchGroups(true)).toBeNull();
  });

  it('isGroupKey is exact', () => {
    expect(ALL.every(isGroupKey)).toBe(true);
    expect(isGroupKey('Streets')).toBe(false);
    expect(isGroupKey('')).toBe(false);
    expect(isGroupKey(undefined)).toBe(false);
  });
});

describe('watchGroupsOf / groupAllowed', () => {
  const u = (watchGroups?: unknown) => ({ prefs: { emailUpdates: true, ...(watchGroups === undefined ? {} : { watchGroups }) } }) as never;

  it('no prefs, no key, [] or a corrupt stored value all read as everything and allow every group', () => {
    for (const user of [null, undefined, {}, { prefs: null }, u(), u([]), u('streets'), u(42)]) {
      expect(watchGroupsOf(user as never)).toEqual([]);
      expect(groupAllowed(user as never, { category: 'pothole' })).toBe(true);
      expect(groupAllowed(user as never, { category: 'unsure' })).toBe(true);
      expect(groupAllowed(user as never, {})).toBe(true);
    }
  });

  it('a selection allows exactly its groups; "other" is the only way to hear about an unmapped type', () => {
    const streets = u(['streets']);
    expect(groupAllowed(streets, { category: 'pothole' })).toBe(true);
    expect(groupAllowed(streets, { category: 'sidewalk_repair' })).toBe(true);
    expect(groupAllowed(streets, { category: 'missed_trash' })).toBe(false);
    expect(groupAllowed(streets, { category: 'unsure' })).toBe(false);
    expect(groupAllowed(streets, {})).toBe(false);
    const other = u(['other']);
    expect(groupAllowed(other, { category: 'unsure' })).toBe(true);
    expect(groupAllowed(other, { category: 'pothole' })).toBe(false);
    expect(watchGroupsOf(u(['trash', 'bogus', 'trash', 'lights']))).toEqual(['trash', 'lights']); // the stored value is read through the same cleaner
  });
});
