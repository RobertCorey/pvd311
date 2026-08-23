import { describe, it, expect } from 'vitest';
import {
  controlKind,
  normalizeControl,
  normalizeControls,
  diffControls,
  hasDrift,
  driftFieldCount,
  summarizeDrift,
  type GoldenControl,
} from '../src/drift';
import type { PortalControl } from '../src/scout';

// ── helpers ──────────────────────────────────────────────────────────────────
const g = (over: Partial<GoldenControl> = {}): GoldenControl => ({
  id: 'cop_size',
  label: 'Approximate size of the pothole',
  kind: 'select',
  required: false,
  options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'],
  ...over,
});

describe('controlKind / normalizeControl', () => {
  it('collapses tag+type into a single kind', () => {
    expect(controlKind({ tag: 'select', type: 'select-one' })).toBe('select');
    expect(controlKind({ tag: 'textarea', type: null })).toBe('textarea');
    expect(controlKind({ tag: 'input', type: 'radio' })).toBe('radio');
    expect(controlKind({ tag: 'input', type: 'checkbox' })).toBe('checkbox');
    expect(controlKind({ tag: 'input', type: 'text' })).toBe('text');
  });

  it('normalizes label whitespace, drops the "Select" placeholder + dupes, keeps required', () => {
    const raw: PortalControl = {
      id: 'cop_size',
      label: '  Approximate   size ',
      tag: 'select',
      type: 'select-one',
      required: true,
      options: ['Select', 'Small', 'Small', '', ' Large '],
    };
    expect(normalizeControl(raw)).toEqual({
      id: 'cop_size',
      label: 'Approximate size',
      kind: 'select',
      required: true,
      options: ['Small', 'Large'],
    });
  });

  it('text/textarea controls carry no options array', () => {
    const raw: PortalControl = { id: 'cop_vehicledetails', label: 'Vehicle details', tag: 'input', type: 'text', required: false };
    expect(normalizeControl(raw).options).toBeUndefined();
  });

  it('sorts normalized controls by id (stable storage order)', () => {
    const raw: PortalControl[] = [
      { id: 'cop_z', label: 'Z', tag: 'input', type: 'text', required: false },
      { id: 'cop_a', label: 'A', tag: 'input', type: 'text', required: false },
    ];
    expect(normalizeControls(raw).map((c) => c.id)).toEqual(['cop_a', 'cop_z']);
  });
});

describe('diffControls', () => {
  it('identical golden and live → no drift, no event', () => {
    const golden = [g()];
    const live = [g()];
    const d = diffControls(golden, live);
    expect(hasDrift(d)).toBe(false);
    expect(driftFieldCount(d)).toBe(0);
    expect(d).toEqual({ added: [], removed: [], renamed: [], requiredChanged: [], labelChanged: [], optionsChanged: [] });
  });

  it('is ordering-insensitive: a reordered-but-identical list is not drift', () => {
    const a = g({ id: 'cop_a', label: 'A', kind: 'text', required: false, options: undefined });
    const b = g({ id: 'cop_b', label: 'B', kind: 'text', required: false, options: undefined });
    const golden = [a, b];
    const live = [b, a]; // reversed control order
    expect(hasDrift(diffControls(golden, live))).toBe(false);
  });

  it('option list reordered but same set → not drift', () => {
    const golden = [g({ options: ['Small', 'Medium', 'Large', 'Unknown'] })];
    const live = [g({ options: ['Unknown', 'Large', 'Medium', 'Small'] })];
    expect(hasDrift(diffControls(golden, live))).toBe(false);
  });

  it('added required control → reported as added, flagged required', () => {
    const golden = [g()];
    const live = [g(), g({ id: 'cop_unexpected', label: 'Unexpected new required field', required: true, options: ['Alpha', 'Beta'] })];
    const d = diffControls(golden, live);
    expect(hasDrift(d)).toBe(true);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]).toMatchObject({ id: 'cop_unexpected', required: true });
    expect(d.removed).toHaveLength(0);
    expect(d.renamed).toHaveLength(0);
    expect(summarizeDrift('pothole', d)).toContain('incl. required');
  });

  it('removed control → reported as removed (not renamed)', () => {
    const golden = [g(), g({ id: 'cop_extra', label: 'Extra', kind: 'text', required: false, options: undefined })];
    const live = [g()];
    const d = diffControls(golden, live);
    expect(d.removed.map((c) => c.id)).toEqual(['cop_extra']);
    expect(d.added).toHaveLength(0);
    expect(d.renamed).toHaveLength(0);
  });

  it('renamed id with the same label+kind → one rename, not add+remove', () => {
    const golden = [g({ id: 'cop_size' })];
    const live = [g({ id: 'cop_size_renamed' })]; // same label, same kind, same options
    const d = diffControls(golden, live);
    expect(d.renamed).toEqual([{ from: 'cop_size', to: 'cop_size_renamed', label: g().label, kind: 'select' }]);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it('id change WITH a different label is an add+remove, not a rename', () => {
    const golden = [g({ id: 'cop_size', label: 'Size' })];
    const live = [g({ id: 'cop_other', label: 'Something else entirely' })];
    const d = diffControls(golden, live);
    expect(d.renamed).toHaveLength(0);
    expect(d.removed.map((c) => c.id)).toEqual(['cop_size']);
    expect(d.added.map((c) => c.id)).toEqual(['cop_other']);
  });

  it('option change on the same id → optionsChanged with added/removed sets', () => {
    const golden = [g({ options: ['Small', 'Medium', 'Large', 'Unknown'] })];
    const live = [g({ options: ['Small', 'Medium', 'Extra Large', 'Unknown'] })];
    const d = diffControls(golden, live);
    expect(d.optionsChanged).toHaveLength(1);
    expect(d.optionsChanged[0]).toMatchObject({ id: 'cop_size', added: ['Extra Large'], removed: ['Large'] });
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it('required flip on the same id → requiredChanged', () => {
    const golden = [g({ required: false })];
    const live = [g({ required: true })];
    const d = diffControls(golden, live);
    expect(d.requiredChanged).toEqual([{ id: 'cop_size', label: g().label, from: false, to: true }]);
  });

  it('label change on the same id → labelChanged (a relabel is drift too)', () => {
    const golden = [g({ label: 'Other' })];
    const live = [g({ label: 'Different' })];
    const d = diffControls(golden, live);
    expect(d.labelChanged).toEqual([{ id: 'cop_size', from: 'Other', to: 'Different' }]);
  });

  it('empty golden vs empty live (missed_trash: no extra controls) → no drift', () => {
    expect(hasDrift(diffControls([], []))).toBe(false);
  });

  it('combines multiple drift kinds in one delta', () => {
    const golden = [
      g({ id: 'cop_size' }),
      g({ id: 'cop_gone', label: 'Gone', kind: 'text', required: false, options: undefined }),
    ];
    const live = [
      g({ id: 'cop_size', required: true }), // required flip
      g({ id: 'cop_new', label: 'Brand new', kind: 'text', required: true, options: undefined }), // add
    ];
    const d = diffControls(golden, live);
    expect(driftFieldCount(d)).toBe(3); // 1 required-changed + 1 removed + 1 added
    expect(d.requiredChanged).toHaveLength(1);
    expect(d.removed.map((c) => c.id)).toEqual(['cop_gone']);
    expect(d.added.map((c) => c.id)).toEqual(['cop_new']);
  });
});
