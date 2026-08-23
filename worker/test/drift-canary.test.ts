/**
 * drift-canary.test.ts — engine-level tests for the two-tier drift paths (no browser, no portal):
 *   - recordControls: sim baseline → MINT (no drift); live baseline → live-vs-live diff.
 *   - runDriftCanary (nightly): self-seeds meta/canaryDraft, resumes via the fake portal, mints on the
 *     first live dump, drifts once a live baseline exists, skips (warn) when it can't resume.
 * Plus a golden JSON ↔ runtime barrel sync guard.
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
  category: 'pothole', caseTypeName: 'Pothole Report', source: 'sim', capturedAt: '2026-08-23T00:00:00.000Z',
  controls: [{ id: 'cop_size', label: 'Approximate size of the pothole', kind: 'select', required: false, options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] }],
};
const GOLDENS = { pothole };
const rawMatch: PortalControl[] = [
  { id: 'cop_size', label: 'Approximate size of the pothole', tag: 'select', type: 'select-one', required: false, options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] },
];

interface Ev { level: string; kind: string; msg: string; data?: Record<string, unknown> | null }
function memStore(seed: Record<string, any> = {}) {
  const meta: Record<string, any> = { ...seed };
  const events: Ev[] = [];
  const store = {
    addEvent: vi.fn(async (e: Ev) => { events.push(e); }),
    getMeta: vi.fn(async (id: string) => (id in meta ? meta[id] : null)),
    setMeta: vi.fn(async (id: string, data: Record<string, unknown>) => { meta[id] = { ...(meta[id] ?? {}), ...data }; }),
  } as unknown as Store;
  return { store, meta, events };
}
function memMailer() {
  const alerts: string[] = [];
  return { mailer: { alert: vi.fn(async (s: string) => { alerts.push(s); }) } as unknown as Mailer, alerts };
}
/** A live baseline seed for meta/golden_<cat> from a sim snapshot's controls. */
const liveGolden = (snap: GoldenSnapshot) => ({ at: '2026-08-23T00:00:00.000Z', source: 'live', controls: snap.controls, cleared: false });

describe('recordControls (two-tier)', () => {
  it('sim baseline + first live dump → MINT (no drift, no alert); writes meta/golden_ as live', async () => {
    const { store, meta, events } = memStore();
    const { mailer, alerts } = memMailer();
    const res = await recordControls(store, mailer, 'pothole', rawMatch, 'submit', GOLDENS);
    expect(res).toMatchObject({ drift: false, minted: true });
    expect(events.some((e) => e.kind === 'canary.golden_minted')).toBe(true);
    expect(events.some((e) => e.kind === 'canary.drift')).toBe(false);
    expect(alerts).toHaveLength(0);
    expect(meta['golden_pothole']).toMatchObject({ source: 'live', cleared: false });
    expect(meta['golden_pothole'].controls).toHaveLength(1);
    expect(meta['controls_pothole']).toMatchObject({ source: 'submit', drifted: false });
  });

  it('mints even when the first live dump DIFFERS from the sim golden (never a sim-vs-live drift)', async () => {
    const { store, events } = memStore();
    const { mailer, alerts } = memMailer();
    const raw = [...rawMatch, { id: 'cop_extra', label: 'Extra', tag: 'input', type: 'text', required: true } as PortalControl];
    const res = await recordControls(store, mailer, 'pothole', raw, 'submit', GOLDENS);
    expect(res.minted).toBe(true);
    expect(events.find((e) => e.kind === 'canary.golden_minted')?.data?.priorSource).toBe('sim');
    expect(alerts).toHaveLength(0);
  });

  it('live baseline present + differing dump → live-vs-live DRIFT (canary.drift + alert)', async () => {
    const { store, events } = memStore({ golden_pothole: liveGolden(pothole) });
    const { mailer, alerts } = memMailer();
    const raw = [...rawMatch, { id: 'cop_unexpected', label: 'Unexpected new required field', tag: 'select', type: 'select-one', required: true, options: ['Alpha', 'Beta'] } as PortalControl];
    const res = await recordControls(store, mailer, 'pothole', raw, 'submit', GOLDENS);
    expect(res.drift).toBe(true);
    const drift = events.find((e) => e.kind === 'canary.drift');
    expect(drift?.level).toBe('error');
    expect((drift?.data?.delta as any).added[0]).toMatchObject({ id: 'cop_unexpected', required: true });
    expect(alerts).toEqual(['Portal control drift']);
    expect(store.setMeta).toHaveBeenCalledWith('controls_pothole', expect.objectContaining({ drifted: true }));
  });

  it('live baseline present + identical dump → no drift', async () => {
    const { store, events } = memStore({ golden_pothole: liveGolden(pothole) });
    const { mailer, alerts } = memMailer();
    const res = await recordControls(store, mailer, 'pothole', rawMatch, 'submit', GOLDENS);
    expect(res.drift).toBe(false);
    expect(events.some((e) => e.kind === 'canary.drift')).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it('unmapped category (no sim golden) + first dump → mint', async () => {
    const { store, events } = memStore();
    const { mailer } = memMailer();
    const res = await recordControls(store, mailer, 'graffiti', rawMatch, 'submit', GOLDENS);
    expect(res.minted).toBe(true);
    expect(events.find((e) => e.kind === 'canary.golden_minted')?.data?.priorSource).toBe(null);
  });
});

describe('runDriftCanary (nightly designated draft, two-tier)', () => {
  it('first run: self-seeds meta/canaryDraft, resumes it, MINTS (no drift)', async () => {
    const { store, meta, events } = memStore();
    const { mailer } = memMailer();
    const resume = vi.fn(async () => rawMatch);
    const portal = { resumeAndDumpControls: resume } as unknown as Portal;
    const res = await runDriftCanary(env, { store, mailer, portal, goldens: GOLDENS });
    expect(res).toEqual({ checked: true, drift: false });
    expect(meta['canaryDraft'].entityId).toBe('6892301e-939e-f111-a3d0-001dd8111525');
    expect(resume).toHaveBeenCalledWith('6892301e-939e-f111-a3d0-001dd8111525');
    expect(events.some((e) => e.kind === 'canary.golden_minted')).toBe(true);
    expect(events.some((e) => e.kind === 'canary.drift')).toBe(false);
  });

  it('with a live baseline already set, a drifting dump → canary.drift', async () => {
    const { store, events } = memStore({ golden_pothole: liveGolden(pothole) });
    const { mailer } = memMailer();
    const raw = [{ ...rawMatch[0], required: true }];
    const portal = { resumeAndDumpControls: vi.fn(async () => raw) } as unknown as Portal;
    const res = await runDriftCanary(env, { store, mailer, portal, goldens: GOLDENS });
    expect(res).toEqual({ checked: true, drift: true });
    expect(events.find((e) => e.kind === 'canary.drift')?.data?.source).toBe('canary-draft');
  });

  it('record can not be resumed (null) → skipped (warn), non-mutating, no drift', async () => {
    const { store, events } = memStore();
    const { mailer } = memMailer();
    const portal = { resumeAndDumpControls: vi.fn(async () => null) } as unknown as Portal;
    const res = await runDriftCanary(env, { store, mailer, portal, goldens: GOLDENS });
    expect(res).toEqual({ checked: false, drift: false });
    expect(events.some((e) => e.kind === 'canary.drift')).toBe(false);
    expect(events.some((e) => e.kind === 'canary.drift_skipped')).toBe(true);
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
