/**
 * portal.sim.test.ts — the REAL WorkerPortal driver, end-to-end, against the local
 * Power-Pages-shaped simulator (worker/test/sim/server.ts) with a real local Chromium.
 * Zero traffic to 311.providenceri.gov: PORTAL_BASE_URL points at 127.0.0.1.
 *
 * The seam: @cloudflare/playwright.launch() connects over a Browser Rendering binding and its
 * bundled playwright-core cannot spawn a local browser, so we mock the module and route launch()
 * to a real Playwright Chromium resolved from the repo (see ./sim/browser.ts). Everything else —
 * ensureLoggedIn, fillStep1 (incl. honeypot + case-type modal), fillStep2, fillStep3
 * (dumpControls/setControl/scout), submit, extractCaseId, readMyRequests/parseRow, canary — is
 * the production code path unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Route the driver's `launch(env.BROWSER)` to a real local Chromium. The holder is populated in
// beforeAll; launch() is only invoked once tests run, so the null-at-hoist-time value is fine.
const h = vi.hoisted(() => ({ chromium: null as any }));
vi.mock('@cloudflare/playwright', () => ({
  launch: async () => h.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
}));

import { createPortal } from '../src/portal';
import { loadRealChromium } from './sim/browser';
import { startSim, type Sim } from './sim/server';
import { makeEnv, memAuthStore, makeReport } from './sim/harness';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let sim: Sim;
let source: string;

beforeAll(async () => {
  const loaded = await loadRealChromium();
  h.chromium = loaded.chromium;
  source = loaded.source;
  sim = await startSim();
});
afterAll(async () => { await sim?.close(); });
beforeEach(() => { sim.reset(); });

describe('portal simulator — happy path', () => {
  it('resolves a real Playwright from the repo (documents the seam)', () => {
    expect(source).toMatch(/node_modules\/playwright(-core)?\/index\.js$/);
  });

  it('logs in, runs the full wizard, and returns a confirmed PVD case id (scout NOT called — all controls mapped)', async () => {
    const scout = vi.fn(); // spy: pothole's only Step-3 control (cop_size) is statically mapped
    const auth = memAuthStore();
    const portal = createPortal(makeEnv(sim.url), { auth, scout });
    await portal.launch();
    const drafts: any[] = [];
    const res = await portal.submitReport(makeReport(), { mode: 'live', onDraft: async (d) => { drafts.push(d); } });
    await portal.close();

    expect(res.mode).toBe('live');
    expect(res.caseId).toMatch(/^PVD2026-\d{5}$/);
    expect(res.caseIdConfirmed).toBe(true); // matched OUR draft's row in the grid, left Draft
    expect(scout).not.toHaveBeenCalled();
    // Drafts were persisted after Step 1 (step 2) and Step 2 (step 3); the PVD is read off the draft
    // (Edit-Request input#title) so each carries the assigned case id.
    expect(drafts.some((d) => d.step === 2)).toBe(true);
    expect(drafts.some((d) => d.step === 3)).toBe(true);
    expect(drafts.find((d) => d.step === 2)?.entityId).toBeTruthy();
    expect(drafts.find((d) => d.step === 3)?.caseId).toMatch(/^PVD2026-\d{5}$/);

    const s = sim.snapshot();
    expect(s.casesCreated).toBe(1);
    expect(s.submitPosts).toBe(1);
    expect(s.signInPosts).toBe(1);
    // Our draft row converted to Submitted and now carries the returned PVD number.
    expect(s.cases.find((c) => c.pvd === res.caseId)).toMatchObject({ status: 'Submitted' });
  });

  it('check-before-create: a retry whose draft already converted returns alreadyFiled without re-running the wizard', async () => {
    // First: a clean submit produces a Submitted grid row with a real PVD number.
    const p1 = createPortal(makeEnv(sim.url), { auth: memAuthStore(), scout: vi.fn() });
    await p1.launch();
    const first = await p1.submitReport(makeReport(), { mode: 'live' });
    await p1.close();
    const caseId = first.caseId!;
    const before = sim.snapshot();
    expect(before.casesCreated).toBe(1);

    // Then: a retry carrying that draft's caseId sees it already filed (non-Draft) and short-circuits.
    const p2 = createPortal(makeEnv(sim.url), { auth: memAuthStore(), scout: vi.fn() });
    await p2.launch();
    const retry = await p2.submitReport(
      makeReport({ portalDraft: { url: `${sim.url}/my-requests/New-Request/?stepid=step3&id=x`, entityId: 'x', step: 3, savedAt: new Date().toISOString(), caseId } as any }),
      { mode: 'live' },
    );
    await p2.close();

    expect(retry.alreadyFiled).toBe(true);
    expect(retry.caseId).toBe(caseId);
    const after = sim.snapshot();
    expect(after.casesCreated).toBe(1); // no new case
    expect(after.submitPosts).toBe(before.submitPosts); // no wizard, no submit
    expect(after.step1Posts).toBe(before.step1Posts);
  });

  it('draft-resume: a persisted Step-3 draft resumes without re-running Step 1/2, reusing the login', async () => {
    const auth = memAuthStore();
    const report = makeReport();

    // Pass 1: inspect mode drives the wizard to Step 3 (creating the draft entity) but never submits.
    const p1 = createPortal(makeEnv(sim.url), { auth, scout: vi.fn() });
    await p1.launch();
    const drafts: any[] = [];
    const r1 = await p1.submitReport(report, { mode: 'inspect', onDraft: async (d) => { drafts.push(d); } });
    await p1.close();

    expect(r1.mode).toBe('inspect');
    const step3Draft = drafts.find((d) => d.step === 3 && d.entityId);
    expect(step3Draft?.entityId).toBeTruthy();
    expect(step3Draft?.caseId).toMatch(/^PVD2026-\d{5}$/); // PVD read off the draft before any submit
    let s = sim.snapshot();
    expect(s.step1Posts).toBe(1);
    expect(s.step2Posts).toBe(1);
    expect(s.submitPosts).toBe(0); // inspect stops before Submit
    expect(s.signInPosts).toBe(1);

    // Pass 2: a new driver instance resumes from the persisted draft and submits.
    const p2 = createPortal(makeEnv(sim.url), { auth, scout: vi.fn() });
    await p2.launch();
    const r2 = await p2.submitReport({ ...report, portalDraft: step3Draft } as any, { mode: 'live' });
    await p2.close();

    expect(r2.caseId).toMatch(/^PVD2026-\d{5}$/);
    expect(r2.alreadyFiled).toBeFalsy(); // the draft was still Draft, so it genuinely resumed + submitted
    s = sim.snapshot();
    expect(s.step1Posts).toBe(1); // unchanged — resume skipped Step 1
    expect(s.step2Posts).toBe(1); // unchanged — resume skipped Step 2
    expect(s.submitPosts).toBe(1);
    expect(s.casesCreated).toBe(1);
    expect(s.signInPosts).toBe(1); // login reused via persisted storageState, not repeated
    expect(auth.peek()).toBeTruthy();
  });

  it('readMyRequests parses the grid: the Draft row (no PVD; keyed by GUID) and the converted (Submitted) row', async () => {
    const portal = createPortal(makeEnv(sim.url), { auth: memAuthStore(), scout: vi.fn() });
    await portal.launch();
    await portal.ensureLoggedIn();
    const rows = await portal.readMyRequests();
    await portal.close();

    expect(rows.length).toBeGreaterThanOrEqual(3);
    // The Draft row renders no PVD number → parseRow yields no case id → the driver keys it by its GUID.
    const draft = rows.find((r) => r.status === 'Draft');
    expect(draft).toBeTruthy();
    expect(draft!.caseId).toBeNull();
    expect(draft!.entityId).toBe('seed-draft-0001');
    // The numbered rows parse by case id.
    const byId = Object.fromEntries(rows.filter((r) => r.caseId).map((r) => [r.caseId, r]));
    expect(byId['PVD2026-00099']).toMatchObject({ status: 'Submitted', street: '22 Oak St' });
    expect(byId['PVD2026-00098']).toMatchObject({ status: 'Assigned' });
  });

  it('canary passes against the fresh contract and is non-mutating (no submit, no wizard advance)', async () => {
    const portal = createPortal(makeEnv(sim.url), { auth: memAuthStore(), scout: vi.fn() });
    await portal.launch();
    const c = await portal.canary();
    await portal.close();

    expect(c.ok).toBe(true);
    expect(c.missing).toEqual([]);
    expect(c.notes.join(' ')).toMatch(/lookup modal: \d+ rows/);

    const s = sim.snapshot();
    expect(s.submitPosts).toBe(0);
    expect(s.casesCreated).toBe(0);
    expect(s.step1Posts).toBe(0); // canary never clicks Next
  });

  it('scout fills an unmapped control (noise → cop_noisesource) and the value is applied on submit', async () => {
    const scout = vi.fn(async () => ({ values: { cop_noisesource: 'Residence' }, confidence: 0.9, notes: 'residential complaint' }));
    const report = makeReport({ category: 'noise', extra: null, photo: null });
    const portal = createPortal(makeEnv(sim.url), { auth: memAuthStore(), scout });
    await portal.launch();
    const res = await portal.submitReport(report, { mode: 'live' });
    await portal.close();

    expect(scout).toHaveBeenCalledTimes(1);
    const call = scout.mock.calls[0][0];
    expect(call.controls.map((c: any) => c.id)).toContain('cop_noisesource');
    expect(call.caseTypeName).toBe('Noise or Sound Disturbances');
    expect(res.caseId).toMatch(/^PVD2026-\d{5}$/);
    expect(sim.snapshot().casesCreated).toBe(1);
  });

  it('exposes the /_sim control endpoints over HTTP', async () => {
    const reset = await (await fetch(`${sim.url}/_sim/reset`)).json();
    expect(reset.ok).toBe(true);
    await fetch(`${sim.url}/_sim/mutate?name=submit-500`);
    const st = await (await fetch(`${sim.url}/_sim/state`)).json();
    expect(st.mutations).toContain('submit-500');
    expect(st).toMatchObject({ submitPosts: 0, casesCreated: 0 });
    sim.reset();
  });
});
