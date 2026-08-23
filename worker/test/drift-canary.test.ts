/**
 * drift-canary.test.ts — engine-level tests for the two flagged drift paths (no browser, no portal):
 *   - recordControls (shared): identical dump → no event; drift → canary.drift with delta + meta write
 *     + alert; no golden → controls_seen sighting.
 *   - runDriftCanary (nightly path a): self-seeds meta/canaryDraft, resumes the designated record via
 *     the fake portal, diffs vs golden; can't-resume → skipped (warn), non-mutating.
 * Plus a sync guard that the committed goldens JSON equals the runtime barrel golden-controls.ts.
 */
import { describe, it, expect, vi } from 'vitest';
// engine.ts → portal.ts imports @cloudflare/playwright (cloudflare:workers, unresolvable under Node).
// These tests use a FAKE Portal, so stub the module to make the import graph load.
vi.mock('@cloudflare/playwright', () => ({ launch: async () => { throw new Error('unused in drift-canary tests'); } }));
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runDriftCanary, recordControls } from '../src/engine';
import { GOLDEN_CONTROLS } from '../src/golden-controls';
import type { GoldenSnapshot } from '../src/drift';
import type { Env, Mailer, Portal, Store } from '../src/contracts';
import type { PortalControl } from '../src/scout';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = { DRIFT_CANARY_ENABLED: '1' } as unknown as Env;

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
const rawMatch: PortalControl[] = [
  { id: 'cop_size', label: 'Approximate size of the pothole', tag: 'select', type: 'select-one', required: false, options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] },
];

interface Ev { level: string; kind: string; msg: string; data?: Record<string, unknown> | null }
function fakes(over: { raw?: PortalControl[] | null; canaryMeta?: unknown } = {}) {
  const events: Ev[] = [];
  const alerts: string[] = [];
  const meta: Record<string, unknown> = {};
  const store = {
    addEvent: vi.fn(async (e: Ev) => { events.push(e); }),
    getMeta: vi.fn(async (id: string) => (id === 'canaryDraft' ? (over.canaryMeta ?? null) : meta[id] ?? null)),
    setMeta: vi.fn(async (id: string, data: Record<string, unknown>) => { meta[id] = { ...(meta[id] as object), ...data }; }),
  } as unknown as Store;
  const mailer = { alert: vi.fn(async (subject: string) => { alerts.push(subject); }) } as unknown as Mailer;
  const resumeAndDumpControls = vi.fn(async (_entityId: string) => (over.raw === undefined ? rawMatch : over.raw));
  const portal = { resumeAndDumpControls } as unknown as Portal;
  return { store, mailer, portal, resumeAndDumpControls, events, alerts, meta };
}

describe('recordControls', () => {
  it('identical controls → no drift, no event, but still snapshots meta/controls_<cat>', async () => {
    const f = fakes();
    const res = await recordControls(f.store, f.mailer, 'pothole', rawMatch, 'submit', GOLDENS);
    expect(res.drift).toBe(false);
    expect(f.events.some((e) => e.kind === 'canary.drift')).toBe(false);
    expect(f.alerts).toHaveLength(0);
    expect((f.meta['controls_pothole'] as any).controls).toHaveLength(1);
    expect((f.meta['controls_pothole'] as any).source).toBe('submit');
  });

  it('drift → canary.drift (error, with delta) + alert + meta snapshot', async () => {
    const raw: PortalControl[] = [
      ...rawMatch,
      { id: 'cop_unexpected', label: 'Unexpected new required field', tag: 'select', type: 'select-one', required: true, options: ['Alpha', 'Beta'] },
    ];
    const f = fakes();
    const res = await recordControls(f.store, f.mailer, 'pothole', raw, 'submit', GOLDENS);
    expect(res.drift).toBe(true);
    const drift = f.events.find((e) => e.kind === 'canary.drift');
    expect(drift?.level).toBe('error');
    const delta = drift?.data?.delta as any;
    expect(delta.added).toHaveLength(1);
    expect(delta.added[0]).toMatchObject({ id: 'cop_unexpected', required: true });
    expect(f.alerts).toEqual(['Portal control drift']);
  });

  it('renamed control → rename in the delta, not add+remove', async () => {
    const raw: PortalControl[] = [{ ...rawMatch[0], id: 'cop_size_v2' }];
    const f = fakes();
    await recordControls(f.store, f.mailer, 'pothole', raw, 'submit', GOLDENS);
    const delta = f.events.find((e) => e.kind === 'canary.drift')?.data?.delta as any;
    expect(delta.renamed).toEqual([{ from: 'cop_size', to: 'cop_size_v2', label: pothole.controls[0].label, kind: 'select' }]);
    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
  });

  it('no golden for the category → records a controls_seen sighting, no drift', async () => {
    const f = fakes();
    const res = await recordControls(f.store, f.mailer, 'graffiti', rawMatch, 'submit', GOLDENS);
    expect(res.drift).toBe(false);
    expect(f.events.some((e) => e.kind === 'canary.controls_seen')).toBe(true);
    expect(f.meta['controls_graffiti']).toBeTruthy();
  });
});

describe('runDriftCanary (nightly designated draft)', () => {
  it('self-seeds meta/canaryDraft, resumes it, no drift → health OK', async () => {
    const f = fakes();
    const res = await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS });
    expect(res).toEqual({ checked: true, drift: false });
    // seeded the designated Pothole record and resumed exactly it
    expect((f.meta['canaryDraft'] as any).entityId).toBe('6892301e-939e-f111-a3d0-001dd8111525');
    expect(f.resumeAndDumpControls).toHaveBeenCalledWith('6892301e-939e-f111-a3d0-001dd8111525');
    expect(f.events.some((e) => e.kind === 'canary.drift')).toBe(false);
  });

  it('honors an existing meta/canaryDraft (entityId + category)', async () => {
    const f = fakes({ canaryMeta: { entityId: 'other-guid', category: 'pothole' } });
    await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS });
    expect(f.resumeAndDumpControls).toHaveBeenCalledWith('other-guid');
  });

  it('drift on the designated draft → canary.drift + returns drift', async () => {
    const raw: PortalControl[] = [{ ...rawMatch[0], required: true }];
    const f = fakes({ raw });
    const res = await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS });
    expect(res).toEqual({ checked: true, drift: true });
    expect(f.events.find((e) => e.kind === 'canary.drift')?.data?.source).toBe('canary-draft');
  });

  it('record can not be resumed (null) → skipped (warn), non-mutating, no drift event', async () => {
    const f = fakes({ raw: null });
    const res = await runDriftCanary(env, { store: f.store, mailer: f.mailer, portal: f.portal, goldens: GOLDENS });
    expect(res).toEqual({ checked: false, drift: false });
    expect(f.events.some((e) => e.kind === 'canary.drift')).toBe(false);
    expect(f.events.some((e) => e.kind === 'canary.drift_skipped')).toBe(true);
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
