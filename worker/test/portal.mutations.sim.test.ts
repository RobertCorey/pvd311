/**
 * portal.mutations.sim.test.ts — the drift/chaos suite.
 *
 * For each way the portal could quietly change under us, the REAL driver must fail LOUD — throw a
 * typed NEEDS_MAPPING / NEEDS_REVIEW / validation error, time out, or return an unconfirmed (null)
 * case id — and NEVER report a green submit. The invariant checked in every case is
 * `casesCreated === 0`: the sim recorded no successfully-created city case.
 *
 * Runs the same mocked-launch + real-Chromium seam as portal.sim.test.ts. The mutations that surface
 * an unexpected control lean on the REAL scout with an empty ANTHROPIC_API_KEY, which fails closed as
 * NEEDS_MAPPING with zero network — exactly what production does when drift outruns the static map and
 * no scout key is configured.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ chromium: null as any }));
vi.mock('@cloudflare/playwright', () => ({
  launch: async () => h.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
}));

import { createPortal } from '../src/portal';
import type { SubmitResult } from '../src/contracts';
import { loadRealChromium } from './sim/browser';
import { startSim, type Sim } from './sim/server';
import { makeEnv, memAuthStore, makeReport } from './sim/harness';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let sim: Sim;

beforeAll(async () => { h.chromium = (await loadRealChromium()).chromium; sim = await startSim(); });
afterAll(async () => { await sim?.close(); });
beforeEach(() => { sim.reset(); });

/**
 * Drive one live submit end-to-end with no injected scout (so the REAL scout runs). Returns whichever
 * of {result, error} happened.
 *
 * Note on the read-before-close: the driver arms a navigation-wait promise just before clicking Submit
 * (`waitForFunction(location.href !== before)`, portal.ts). On a validation/timeout failure that promise
 * is left pending and would reject with a benign Playwright "Target closed" the moment we close the
 * browser — surfacing as an unhandled rejection. Driving one grid read first changes the page URL, so
 * that wait FULFILLS instead of being abandoned. (This is a real driver-side dangling-promise on the
 * failure path — noted for the driver owner — not a test artifact.)
 */
async function runMutation(report = makeReport()): Promise<{ result?: SubmitResult; error?: Error }> {
  const portal = createPortal(makeEnv(sim.url), { auth: memAuthStore() }); // real scout, empty ANTHROPIC_API_KEY
  await portal.launch();
  let result: SubmitResult | undefined;
  let error: Error | undefined;
  try {
    result = await portal.submitReport(report, { mode: 'live' });
  } catch (e) {
    error = e as Error;
  }
  await portal.readMyRequests().catch(() => {});
  await portal.close();
  return { result, error };
}

describe('portal simulator — mutation / drift suite (must fail loud, never a green submit)', () => {
  it('rename a Step-3 control id → unmapped control → NEEDS_MAPPING (scout fails closed, no key)', async () => {
    sim.mutate('rename-control', { from: 'cop_size', to: 'cop_size_renamed' });
    const { error } = await runMutation(makeReport({ category: 'pothole' }));
    expect(error?.message).toMatch(/NEEDS_MAPPING/);
    const s = sim.snapshot();
    expect(s.casesCreated).toBe(0);
    expect(s.submitPosts).toBe(0); // never reached Submit
  });

  it('add an unseen required Step-3 control → NEEDS_MAPPING', async () => {
    sim.mutate('add-required');
    const { error } = await runMutation(makeReport({ category: 'pothole' }));
    expect(error?.message).toMatch(/NEEDS_MAPPING/);
    const s = sim.snapshot();
    expect(s.casesCreated).toBe(0);
    expect(s.submitPosts).toBe(0);
  });

  it('relabel a radio option so the mapped value no longer matches → NEEDS_REVIEW', async () => {
    // bins_carts cop_cartrequesttype defaults to "Other"; the portal renames that option to "Different".
    sim.mutate('change-label', { from: 'Other', to: 'Different' });
    const { error } = await runMutation(makeReport({ category: 'bins_carts', extra: null, photo: null }));
    expect(error?.message).toMatch(/NEEDS_REVIEW/);
    const s = sim.snapshot();
    expect(s.casesCreated).toBe(0);
    expect(s.submitPosts).toBe(0);
  });

  it('drop the Submit (#NextButton) on Step 3 → the driver times out, never a silent success', async () => {
    sim.mutate('drop-next');
    const { error } = await runMutation(makeReport({ category: 'pothole' }));
    expect(error?.message).toMatch(/Timeout|NextButton/i);
    const s = sim.snapshot();
    expect(s.casesCreated).toBe(0);
    expect(s.submitPosts).toBe(0);
  });

  it('500 the submit postback → validation-failure path, not a green submit', async () => {
    sim.mutate('submit-500');
    const { error } = await runMutation(makeReport({ category: 'pothole' }));
    expect(error?.message).toMatch(/validation failed/i);
    const s = sim.snapshot();
    expect(s.casesCreated).toBe(0);
    expect(s.submitPosts).toBe(1); // the click reached the server, but no case was created
  });

  it('submit but the draft never converts (duplicate/no-op) → caseId undefined & unconfirmed, not a green submit', async () => {
    sim.mutate('dup-case');
    const { result, error } = await runMutation(makeReport({ category: 'pothole' }));
    expect(error).toBeUndefined();
    // The draft's row stayed Draft, so extractCaseId's exact-match confirm fails → no fabricated id.
    expect(result?.caseId).toBeUndefined();
    expect(result?.caseIdConfirmed).toBe(false);
    const s = sim.snapshot();
    expect(s.casesCreated).toBe(0); // sim converted no real case
    expect(s.submitPosts).toBe(1);
  });

  it('the sim saw ZERO created cases across the whole suite state after a reset', async () => {
    sim.reset();
    expect(sim.snapshot().casesCreated).toBe(0);
    expect(sim.snapshot().mutations).toEqual([]);
  });
});
