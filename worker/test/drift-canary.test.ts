/**
 * drift-canary.test.ts — engine-level tests for runDriftCanary (no browser, no portal):
 *   - a fake Portal returns raw control dumps; a fake Store captures events + health.
 *   - proves: identical dump → no canary.drift; a drift → one canary.drift with the field-level delta;
 *     no reusable draft → skipped, non-mutating (dumpControlsAt never called).
 * Plus a sync guard that the committed goldens JSON equals the runtime barrel golden-controls.ts.
 */
import { describe, it, expect, vi } from 'vitest';
// engine.ts → portal.ts imports @cloudflare/playwright (cloudflare:workers, unresolvable under Node).
// These tests use a FAKE Portal, so stub the module to make the import graph load.
vi.mock('@cloudflare/playwright', () => ({ launch: async () => { throw new Error('unused in drift-canary tests'); } }));
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runDriftCanary, reusableDraftUrls } from '../src/engine';
import { GOLDEN_CONTROLS } from '../src/golden-controls';
import type { GoldenSnapshot } from '../src/drift';
import type { Env, Mailer, Portal, Store } from '../src/contracts';
import type { PortalControl } from '../src/scout';

const HERE = dirname(fileURLToPath(import.meta.url));

const env = { DRIFT_CANARY_ENABLED: '1' } as unknown as Env;

// One-golden fixture so tests don't depend on the full launch set.
const pothole: GoldenSnapshot = {
  category: 'pothole',
  caseTypeName: 'Pothole Report',
  source: 'sim',
  capturedAt: null,
  controls: [
    { id: 'cop_size', label: 'Approximate size of the pothole', kind: 'select', required: false, options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] },
  ],
};
const GOLDENS = { pothole };

// Raw dump matching the golden (what collectStep3Controls would return).
const rawMatch: PortalControl[] = [
  { id: 'cop_size', label: 'Approximate size of the pothole', tag: 'select', type: 'select-one', required: false, options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] },
];

interface Ev { level: string; kind: string; msg: string; data?: Record<string, unknown> | null }
function fakes(over: { raw?: PortalControl[] | null; draftUrls?: Record<string, string> } = {}) {
  const events: Ev[] = [];
  const alerts: string[] = [];
  const health: { ok: string[]; err: string[] } = { ok: [], err: [] };
  const store = {
    addEvent: vi.fn(async (e: Ev) => { events.push(e); }),
    getMeta: vi.fn(async () => null),
    setMeta: vi.fn(async () => {}),
  } as unknown as Store;
  const mailer = { alert: vi.fn(async (subject: string) => { alerts.push(subject); }) } as unknown as Mailer;
  const dumpControlsAt = vi.fn(async (_url: string) => (over.raw === undefined ? rawMatch : over.raw));
  const portal = { dumpControlsAt } as unknown as Portal;
  const draftUrls = async () => over.draftUrls ?? { pothole: 'https://portal/my-requests/New-Request/?stepid=step3&id=guid-1' };
  return { store, mailer, portal, dumpControlsAt, events, alerts, health, draftUrls };
}

describe('runDriftCanary', () => {
  it('identical dump → no drift event, health OK', async () => {
    const f = fakes();
    const res = await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS, draftUrls: f.draftUrls });
    expect(res).toMatchObject({ drifted: [], checked: ['pothole'] });
    expect(f.events.some((e) => e.kind === 'canary.drift')).toBe(false);
    expect(f.alerts).toHaveLength(0);
  });

  it('added required control → one canary.drift with the field-level delta + an alert', async () => {
    const raw: PortalControl[] = [
      ...rawMatch,
      { id: 'cop_unexpected', label: 'Unexpected new required field', tag: 'select', type: 'select-one', required: true, options: ['Alpha', 'Beta'] },
    ];
    const f = fakes({ raw });
    const res = await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS, draftUrls: f.draftUrls });
    expect(res.drifted).toEqual(['pothole']);
    const drift = f.events.find((e) => e.kind === 'canary.drift');
    expect(drift?.level).toBe('error');
    const delta = drift?.data?.delta as any;
    expect(delta.added).toHaveLength(1);
    expect(delta.added[0]).toMatchObject({ id: 'cop_unexpected', required: true });
    expect(f.alerts).toEqual(['Portal control drift']);
  });

  it('renamed control → canary.drift reports a rename, not add+remove', async () => {
    const raw: PortalControl[] = [{ ...rawMatch[0], id: 'cop_size_v2' }];
    const f = fakes({ raw });
    await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS, draftUrls: f.draftUrls });
    const delta = f.events.find((e) => e.kind === 'canary.drift')?.data?.delta as any;
    expect(delta.renamed).toEqual([{ from: 'cop_size', to: 'cop_size_v2', label: pothole.controls[0].label, kind: 'select' }]);
    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
  });

  it('no reusable draft → skipped and NON-mutating (dumpControlsAt never called, no drift event)', async () => {
    const f = fakes({ draftUrls: {} });
    const res = await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS, draftUrls: f.draftUrls });
    expect(res).toMatchObject({ drifted: [], checked: [], skipped: ['pothole'] });
    expect(f.dumpControlsAt).not.toHaveBeenCalled();
    expect(f.events.some((e) => e.kind === 'canary.drift')).toBe(false);
    expect(f.events.some((e) => e.kind === 'canary.drift_skipped')).toBe(true);
  });

  it('draft no longer resumes (dump returns null) → skipped, not treated as drift', async () => {
    const f = fakes({ raw: null });
    const res = await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS, draftUrls: f.draftUrls });
    expect(res.skipped).toEqual(['pothole']);
    expect(res.checked).toHaveLength(0);
    expect(f.events.some((e) => e.kind === 'canary.drift')).toBe(false);
  });
});

describe('reusableDraftUrls', () => {
  it('picks a Step-3 draft URL per category from parked reports, ignoring non-Step-3 drafts', async () => {
    const mk = (over: any) => ({ id: 'r' + Math.random(), category: 'pothole', portalDraft: null, ...over });
    const store = {
      findByStatus: vi.fn(async (status: string) =>
        status === 'awaiting_review'
          ? [mk({ category: 'pothole', portalDraft: { step: 2, url: 'u-step2' } }), mk({ category: 'pothole', portalDraft: { step: 3, url: 'u-step3' } })]
          : []),
      findSubmittedUnconfirmed: vi.fn(async () => [mk({ category: 'noise', portalDraft: { step: 3, url: 'u-noise' } })]),
    } as unknown as Store;
    const urls = await reusableDraftUrls(store, ['pothole', 'noise', 'bins_carts']);
    expect(urls).toEqual({ pothole: 'u-step3', noise: 'u-noise' }); // step-2 draft ignored; bins_carts absent
  });
});

describe('golden JSON ↔ runtime barrel are in sync', () => {
  it('every barrel entry equals its committed test/golden/<category>.json', () => {
    for (const [category, snap] of Object.entries(GOLDEN_CONTROLS)) {
      const json = JSON.parse(readFileSync(resolve(HERE, 'golden', `${category}.json`), 'utf8'));
      expect(json).toEqual(snap);
    }
  });
});
