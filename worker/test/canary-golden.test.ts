/**
 * canary-golden.test.ts — the two-tier golden module (pure, no browser) + an end-to-end lifecycle
 * through recordControls: sim fallback → mint on first live dump → live-vs-live drift → rebaseline
 * clears → next dump re-mints.
 */
import { describe, it, expect, vi } from 'vitest';
vi.mock('@cloudflare/playwright', () => ({ launch: async () => { throw new Error('unused'); } }));
import { getEffectiveGolden, readLiveGolden, writeLiveGolden, rebaselineGolden, canaryGoldenStatus } from '../src/canary-golden';
import { recordControls } from '../src/engine';
import type { GoldenControl, GoldenSnapshot } from '../src/drift';
import type { Mailer, Store } from '../src/contracts';
import type { PortalControl } from '../src/scout';

const sim: GoldenSnapshot = {
  category: 'pothole', caseTypeName: 'Pothole Report', source: 'sim', capturedAt: '2026-08-23T00:00:00.000Z',
  controls: [{ id: 'cop_size', label: 'Size', kind: 'select', required: false, options: ['Small', 'Large'] }],
};
const GOLDENS = { pothole: sim };
const controls = (over: Partial<GoldenControl> = {}): GoldenControl[] => [{ id: 'cop_size', label: 'Size', kind: 'select', required: false, options: ['Small', 'Large'], ...over }];
const raw = (over: Partial<PortalControl> = {}): PortalControl[] => [{ id: 'cop_size', label: 'Size', tag: 'select', type: 'select-one', required: false, options: ['Small', 'Large'], ...over }];

function memStore(seed: Record<string, any> = {}) {
  const meta: Record<string, any> = { ...seed };
  const events: any[] = [];
  const store = {
    addEvent: vi.fn(async (e: any) => { events.push(e); }),
    getMeta: vi.fn(async (id: string) => (id in meta ? meta[id] : null)),
    setMeta: vi.fn(async (id: string, data: Record<string, unknown>) => { meta[id] = { ...(meta[id] ?? {}), ...data }; }),
  } as unknown as Store;
  return { store, meta, events };
}
const mailer = { alert: vi.fn(async () => {}) } as unknown as Mailer;

describe('getEffectiveGolden precedence', () => {
  it('live baseline wins over the sim golden', async () => {
    const { store } = memStore({ golden_pothole: { at: 't', source: 'live', controls: controls({ label: 'LIVE' }), cleared: false } });
    const eff = await getEffectiveGolden(store, 'pothole', GOLDENS);
    expect(eff).toMatchObject({ source: 'live' });
    expect(eff!.controls[0].label).toBe('LIVE');
  });
  it('falls back to the sim golden when no live baseline', async () => {
    const { store } = memStore();
    const eff = await getEffectiveGolden(store, 'pothole', GOLDENS);
    expect(eff).toMatchObject({ source: 'sim', at: '2026-08-23T00:00:00.000Z' });
  });
  it('a cleared live doc is treated as absent → sim fallback', async () => {
    const { store } = memStore({ golden_pothole: { at: 't', cleared: true } });
    expect((await getEffectiveGolden(store, 'pothole', GOLDENS))!.source).toBe('sim');
    expect(await readLiveGolden(store, 'pothole')).toBeNull();
  });
  it('null when neither live nor sim exists', async () => {
    const { store } = memStore();
    expect(await getEffectiveGolden(store, 'unknown_cat', GOLDENS)).toBeNull();
  });
});

describe('writeLiveGolden / rebaselineGolden', () => {
  it('writeLiveGolden makes the effective golden live', async () => {
    const { store } = memStore();
    await writeLiveGolden(store, 'pothole', controls());
    expect((await getEffectiveGolden(store, 'pothole', GOLDENS))!.source).toBe('live');
  });
  it('rebaselineGolden(controls) replaces the live baseline', async () => {
    const { store } = memStore({ golden_pothole: { source: 'live', controls: controls(), cleared: false } });
    await rebaselineGolden(store, 'pothole', controls({ label: 'NEW' }));
    expect((await readLiveGolden(store, 'pothole'))!.controls[0].label).toBe('NEW');
  });
  it('rebaselineGolden() with no controls CLEARS → sim fallback until re-mint', async () => {
    const { store } = memStore({ golden_pothole: { source: 'live', controls: controls(), cleared: false } });
    await rebaselineGolden(store, 'pothole');
    expect((await getEffectiveGolden(store, 'pothole', GOLDENS))!.source).toBe('sim');
  });
});

describe('canaryGoldenStatus', () => {
  it('reports effective source, timestamps, and last-dump drift per golden category', async () => {
    const { store } = memStore({
      golden_pothole: { at: 'g1', source: 'live', controls: controls(), cleared: false },
      controls_pothole: { at: 'c1', drifted: true },
    });
    const { categories } = await canaryGoldenStatus(store, GOLDENS);
    expect(categories).toEqual([{ category: 'pothole', goldenSource: 'live', goldenAt: 'g1', lastLiveAt: 'c1', drifted: true }]);
  });
  it('shows sim source and no last-dump before any live dump', async () => {
    const { store } = memStore();
    const { categories } = await canaryGoldenStatus(store, GOLDENS);
    expect(categories[0]).toMatchObject({ goldenSource: 'sim', lastLiveAt: null, drifted: false });
  });
});

describe('lifecycle: sim fallback → mint → live drift → rebaseline → re-mint', () => {
  it('runs the full two-tier lifecycle through recordControls', async () => {
    const { store, meta, events } = memStore();

    // 1. First live dump over the sim baseline → MINT, no drift.
    const r1 = await recordControls(store, mailer, 'pothole', raw(), 'submit', GOLDENS);
    expect(r1).toMatchObject({ minted: true, drift: false });
    expect(meta['golden_pothole'].source).toBe('live');
    expect(events.filter((e) => e.kind === 'canary.golden_minted')).toHaveLength(1);

    // 2. A later dump that differs from the LIVE baseline → drift.
    const r2 = await recordControls(store, mailer, 'pothole', raw({ required: true }), 'submit', GOLDENS);
    expect(r2.drift).toBe(true);
    expect(events.filter((e) => e.kind === 'canary.drift')).toHaveLength(1);

    // 3. Admin rebaseline (clear) → the live baseline is gone; effective is sim again.
    await rebaselineGolden(store, 'pothole');
    expect((await getEffectiveGolden(store, 'pothole', GOLDENS))!.source).toBe('sim');

    // 4. Next live dump RE-MINTS (no drift), even though it differs from the sim golden.
    const r4 = await recordControls(store, mailer, 'pothole', raw({ required: true }), 'submit', GOLDENS);
    expect(r4).toMatchObject({ minted: true, drift: false });
    expect(meta['golden_pothole']).toMatchObject({ source: 'live', cleared: false });
    expect(events.filter((e) => e.kind === 'canary.golden_minted')).toHaveLength(2);
  });
});
