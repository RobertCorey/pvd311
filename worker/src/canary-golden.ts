/**
 * canary-golden.ts — two-tier golden resolution for the drift canary.
 *
 * The committed goldens (worker/test/golden/*.json → GOLDEN_CONTROLS) are SIM-generated, so the very
 * first LIVE dump must NOT be diffed against them — it would raise a false drift. Instead:
 *   - The effective golden for a category is a LIVE snapshot in meta/golden_<category> when present,
 *     else the committed sim golden, else nothing.
 *   - The first live dump for a category whose effective golden is sim/absent is MINTED as the live
 *     baseline (no drift, no alert). From then on only live-vs-live is diffed.
 *
 * meta/golden_<category> shape: { at, source:'live', controls, cleared:false } (a baseline)
 *                            or { at, cleared:true }                          (re-baseline: clear).
 * A doc with cleared:true (or no controls array) is treated as absent → the next live dump re-mints.
 */
import type { Store } from './contracts.js';
import type { GoldenControl, GoldenSnapshot } from './drift.js';
import { GOLDEN_CONTROLS } from './golden-controls.js';

export interface LiveGoldenDoc { at?: string; source?: 'live'; controls?: GoldenControl[]; cleared?: boolean }
export interface EffectiveGolden { controls: GoldenControl[]; source: 'live' | 'sim'; at: string | null }

const goldenKey = (category: string) => `golden_${category}`;

/** The live baseline for a category, or null if none/cleared. */
export async function readLiveGolden(store: Store, category: string): Promise<EffectiveGolden | null> {
  const doc = await store.getMeta<LiveGoldenDoc>(goldenKey(category)).catch(() => null);
  if (!doc || doc.cleared || !Array.isArray(doc.controls)) return null;
  return { controls: doc.controls, source: 'live', at: doc.at ?? null };
}

/** Effective golden: the live baseline first, then the committed sim golden, else null. */
export async function getEffectiveGolden(
  store: Store,
  category: string,
  goldens: Record<string, GoldenSnapshot> = GOLDEN_CONTROLS,
): Promise<EffectiveGolden | null> {
  const live = await readLiveGolden(store, category);
  if (live) return live;
  const sim = goldens[category];
  if (sim) return { controls: sim.controls, source: 'sim', at: sim.capturedAt };
  return null;
}

/** Write/replace the live baseline for a category from a fresh (already-normalized) dump. */
export async function writeLiveGolden(store: Store, category: string, controls: GoldenControl[]): Promise<void> {
  await store.setMeta(goldenKey(category), { at: new Date().toISOString(), source: 'live', controls, cleared: false });
}

/**
 * Deliberate admin re-baseline. With `controls`, replaces the live baseline from that dump; without,
 * CLEARS the live baseline so the next live dump re-mints from the committed sim golden. alice wires
 * the admin route (e.g. POST /api/admin/canary/golden/:category/rebaseline) to this.
 */
export async function rebaselineGolden(store: Store, category: string, controls?: GoldenControl[]): Promise<void> {
  if (controls !== undefined) {
    await store.setMeta(goldenKey(category), { at: new Date().toISOString(), source: 'live', controls, cleared: false });
  } else {
    await store.setMeta(goldenKey(category), { at: new Date().toISOString(), cleared: true });
  }
}

export interface CanaryCategoryStatus {
  category: string;
  goldenSource: 'live' | 'sim' | null;
  goldenAt: string | null;
  lastLiveAt: string | null;
  drifted: boolean;
}

/**
 * Per-category golden status for /api/admin/health: which baseline is in effect (live vs the sim
 * fallback vs none), when it was captured, when a live dump was last seen, and whether the last dump
 * drifted. alice adds this to the health payload as `canary: { categories: [...] }`.
 */
export async function canaryGoldenStatus(
  store: Store,
  goldens: Record<string, GoldenSnapshot> = GOLDEN_CONTROLS,
): Promise<{ categories: CanaryCategoryStatus[] }> {
  const cats = Object.keys(goldens);
  const categories = await Promise.all(
    cats.map(async (category): Promise<CanaryCategoryStatus> => {
      const eff = await getEffectiveGolden(store, category, goldens);
      const last = await store.getMeta<{ at?: string; drifted?: boolean }>(`controls_${category}`).catch(() => null);
      return {
        category,
        goldenSource: eff?.source ?? null,
        goldenAt: eff?.at ?? null,
        lastLiveAt: last?.at ?? null,
        drifted: !!last?.drifted,
      };
    }),
  );
  return { categories };
}
