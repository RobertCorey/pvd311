import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { diffCaseTypes, caseTypesChanged, summarizeCaseTypes, caseTypesHtml } from '../src/casetypes';
import { CATEGORIES, GROUP_CATCH_ALL, GROUP_ORDER } from '../../shared/categories';

const census = JSON.parse(readFileSync(new URL('../../scripts/case-type-census-2026-08-21.json', import.meta.url), 'utf8')) as { caseTypes: { id: string; name: string }[] };
const live = census.caseTypes.map((t) => ({ id: t.id, name: t.name.trim() }));

describe('registry integrity (shared/categories.ts)', () => {
  const entries = Object.entries(CATEGORIES);
  it('every GUID is unique and exists in the Aug-21 census', () => {
    const ids = entries.map(([, c]) => c.portalCaseTypeGuid);
    expect(new Set(ids).size).toBe(ids.length);
    const censusIds = new Set(live.map((t) => t.id));
    for (const [key, c] of entries) expect(censusIds.has(c.portalCaseTypeGuid), `${key} GUID not in census`).toBe(true);
  });
  it('every entry has a valid group; catch-alls exist; the wildcard search term is non-trivial', () => {
    for (const [key, c] of entries) {
      expect(GROUP_ORDER, `${key} group`).toContain(c.group);
      expect(c.portalSearchTerm.replace(/\*/g, '').length, `${key} search term`).toBeGreaterThan(3);
    }
    for (const k of Object.values(GROUP_CATCH_ALL)) expect(CATEGORIES[k!]).toBeDefined();
    expect(CATEGORIES.unsure.group).toBe('other');
  });
  it('siblings under one object share the facet question and have distinct answers, in one group', () => {
    const byObject = new Map<string, [string, (typeof CATEGORIES)[string]][]>();
    for (const e of entries) { const o = e[1].object ?? e[0]; byObject.set(o, [...(byObject.get(o) ?? []), e]); }
    for (const [object, sibs] of byObject) {
      if (sibs.length === 1) { expect(sibs[0][1].facet, `${object}: lone type must not carry a facet`).toBeUndefined(); continue; }
      const qs = new Set(sibs.map(([, c]) => c.facet?.q));
      expect(qs.size, `${object}: one facet question`).toBe(1);
      expect([...qs][0], `${object}: facet present`).toBeTruthy();
      const as = sibs.map(([, c]) => c.facet!.a);
      expect(new Set(as).size, `${object}: distinct answers`).toBe(as.length);
      expect(new Set(sibs.map(([, c]) => c.group)).size, `${object}: one group`).toBe(1);
    }
  });
  it('covers the dedicated streetlight-pole type (PVD2026-89374 was misfiled without it)', () => {
    expect(CATEGORIES.streetlight_pole.portalCaseTypeName).toBe('Report a Leaning City Streetlight Pole');
    expect(CATEGORIES.streetlight_pole.group).toBe('lights');
  });
  it('maps every reportable census type (the leftovers are inquiries, not street problems)', () => {
    const mapped = new Set(entries.map(([, c]) => c.portalCaseTypeGuid));
    const unmapped = live.filter((t) => !mapped.has(t.id)).map((t) => t.name);
    expect(unmapped.length).toBeLessThanOrEqual(40);
    for (const n of ['Pothole Report', 'Report a Leaning City Streetlight Pole', 'Graffiti in a Park', 'Fire Hydrant Issue', 'Sinkhole Concern']) expect(unmapped).not.toContain(n);
  });
});

describe('diffCaseTypes', () => {
  it('baseline (no previous snapshot) reports only registry drift', () => {
    const d = diffCaseTypes(null, live);
    expect(d.added).toEqual([]); expect(d.removed).toEqual([]); expect(d.renamed).toEqual([]);
    expect(d.registryMissing).toEqual([]);
    // The city renamed the "unsure" type after the census; the registry carries the NEW name, so against the
    // Aug-21 list it reads as stale — exactly the signal the census is for.
    expect(d.registryRenamed.map((r) => r.key)).toEqual(['unsure']);
    expect(caseTypesChanged(d)).toBe(false);
  });
  it('detects added, removed and renamed types against the previous snapshot', () => {
    const prev = live;
    const next = live.filter((t) => t.name !== 'Repair Existing Guardrail')
      .map((t) => (t.name === 'Pothole Report' ? { ...t, name: 'Pothole or Road Hole Report' } : t))
      .concat([{ id: '00000000-0000-0000-0000-000000000001', name: 'Report a Broken Bench' }]);
    const d = diffCaseTypes(prev, next);
    expect(d.added.map((t) => t.name)).toEqual(['Report a Broken Bench']);
    expect(d.removed.map((t) => t.name)).toEqual(['Repair Existing Guardrail']);
    expect(d.renamed).toEqual([{ id: CATEGORIES.pothole.portalCaseTypeGuid, from: 'Pothole Report', to: 'Pothole or Road Hole Report' }]);
    expect(d.registryMissing.map((r) => r.key)).toEqual(['guardrail']);
    expect(d.registryRenamed.map((r) => r.key).sort()).toEqual(['pothole', 'unsure']);
    expect(caseTypesChanged(d)).toBe(true);
    expect(summarizeCaseTypes(d)).toBe('1 added, 1 removed, 1 renamed, 1 registry GUIDs missing, 2 registry names stale');
    const html = caseTypesHtml(d, (s) => s);
    expect(html).toContain('Report a Broken Bench');
    expect(html).toContain('guardrail: Repair Existing Guardrail');
  });
  it('whitespace-only name differences are not renames', () => {
    const d = diffCaseTypes(live, live.map((t) => ({ ...t, name: `  ${t.name}  ` })));
    expect(d.renamed).toEqual([]);
  });
});
