import { describe, it, expect, vi, beforeEach } from 'vitest';

// The ramp's hold rule (hitl.ts needsHumanApproval, 2026-10-30): a new clean account's report waits for a person only
// when it looks off. The model is swapped for a mock so each case controls what moderation says (or that it throws).
const moderate = vi.fn();
vi.mock('../src/moderation', () => ({ moderate: (...a: unknown[]) => moderate(...a) }));

import { needsHumanApproval } from '../src/hitl';
import type { Env, ReportDoc, Store, UserDoc } from '../src/contracts';

const clean = { flags: [], polishedDescription: null, note: null, model: 'claude-opus-5' };
const report = (o: Partial<ReportDoc> = {}): ReportDoc => ({
  id: 'rep-new', ownerUid: 'uid_a', category: 'pothole', address: '12 Angell St', lat: 41.8282, lng: -71.4005,
  description: 'Deep pothole in the right lane, eastbound', photo: 'https://img.test/p.jpg', status: 'pending', timestamp: null, ...o,
} as ReportDoc);
const owned = (status: string, o: Partial<ReportDoc> = {}) => report({ id: `rep-${status}-${Math.random()}`, status: status as ReportDoc['status'], ...o });

function memStore(mine: ReportDoc[] = [], user: Partial<UserDoc> | null = null, opts: { lookupFails?: boolean } = {}) {
  const patches: Record<string, unknown>[] = [];
  const store = {
    patchReport: vi.fn(async (_id: string, f: Record<string, unknown>) => { patches.push(f); }),
    getUser: async () => (opts.lookupFails ? Promise.reject(new Error('firestore down')) : user),
    findReportsByOwner: async () => mine,
  };
  return { store: store as unknown as Store, patches };
}
const env = (mode: Env['HITL_MODE'] = 'ramp') => ({ HITL_MODE: mode, ACCOUNT_TRUST_N: '1' }) as unknown as Env;

beforeEach(() => { moderate.mockReset(); moderate.mockResolvedValue(clean); });

describe('needsHumanApproval — ramp, new account', () => {
  it('a clean first report files on its own', async () => {
    const s = memStore();
    expect(await needsHumanApproval(s.store, env(), report())).toBe(false);
    expect(moderate).toHaveBeenCalledTimes(1);
    expect(s.patches[0]).toMatchObject({ intakeFlags: null });
  });

  it('holds "Not sure" (unsure), even with a photo and a full description', async () => {
    expect(await needsHumanApproval(memStore().store, env(), report({ category: 'unsure' }))).toBe(true);
  });

  it('holds a near-empty report with no photo (the "PEMA" case, trimmed)', async () => {
    expect(await needsHumanApproval(memStore().store, env(), report({ description: '   PEMA   ', photo: null, category: 'public_safety' }))).toBe(true);
    expect(await needsHumanApproval(memStore().store, env(), report({ description: null, photo: null, category: 'public_safety' }))).toBe(true);
    expect(await needsHumanApproval(memStore().store, env(), report({ description: 'Pothole!!', photo: null }))).toBe(true); // 9 chars
  });

  it('a short description is fine with a photo, and 10 characters is enough without one', async () => {
    expect(await needsHumanApproval(memStore().store, env(), report({ description: 'pothole' }))).toBe(false);
    expect(await needsHumanApproval(memStore().store, env(), report({ description: 'Pothole!!!', photo: null }))).toBe(false);
  });

  it('holds what moderation flags', async () => {
    moderate.mockResolvedValue({ ...clean, flags: ['not_311'] });
    const s = memStore();
    expect(await needsHumanApproval(s.store, env(), report())).toBe(true);
    expect(s.patches[0]).toMatchObject({ intakeFlags: ['not_311'] });
  });

  it('retries moderation once; a success on the retry files it', async () => {
    moderate.mockRejectedValueOnce(new Error('403 forbidden'));
    const s = memStore();
    expect(await needsHumanApproval(s.store, env(), report())).toBe(false);
    expect(moderate).toHaveBeenCalledTimes(2);
    expect(s.patches[0]).toMatchObject({ intakeFlags: null });
  });

  it('two failures in a row → the fail-safe sends it to review', async () => {
    moderate.mockRejectedValue(new Error('403 forbidden'));
    const s = memStore();
    expect(await needsHumanApproval(s.store, env(), report())).toBe(true);
    expect(moderate).toHaveBeenCalledTimes(2);
    expect(s.patches[0]).toMatchObject({ intakeFlags: ['spam'] });
  });

  it('moderation runs once per report: an already-moderated report reuses its stored flags', async () => {
    expect(await needsHumanApproval(memStore().store, env(), report({ moderatedAt: '2026-10-30T12:00:00.000Z', intakeFlags: null }))).toBe(false);
    expect(await needsHumanApproval(memStore().store, env(), report({ moderatedAt: '2026-10-30T12:00:00.000Z', intakeFlags: ['spam'] }))).toBe(true);
    expect(moderate).not.toHaveBeenCalled();
  });

  it('a report with no owner, or an account lookup that fails, is reviewed', async () => {
    expect(await needsHumanApproval(memStore().store, env(), report({ ownerUid: null }))).toBe(true);
    expect(await needsHumanApproval(memStore([], null, { lookupFails: true }).store, env(), report())).toBe(true);
  });
});

describe('needsHumanApproval — ramp, the rejected-history brake and trust', () => {
  it('an account with any rejected or auto-rejected report gets every report reviewed, clean ones too', async () => {
    expect(await needsHumanApproval(memStore([owned('rejected')]).store, env(), report())).toBe(true);
    expect(await needsHumanApproval(memStore([owned('auto-rejected')]).store, env(), report())).toBe(true);
    expect(await needsHumanApproval(memStore([owned('submitted'), owned('submitted'), owned('rejected')]).store, env(), report())).toBe(true);
  });

  it('a report the reporter cancelled is not a rejection', async () => {
    expect(await needsHumanApproval(memStore([owned('rejected', { cancelledByReporter: true })]).store, env(), report())).toBe(false);
  });

  it('a trusted account (ACCOUNT_TRUST_N filed clean, or the admin flag) files even a "Not sure" report', async () => {
    expect(await needsHumanApproval(memStore([owned('submitted')]).store, env(), report({ category: 'unsure', description: 'x', photo: null }))).toBe(false);
    expect(await needsHumanApproval(memStore([owned('rejected')], { trusted: true }).store, env(), report({ category: 'unsure' }))).toBe(false);
  });

  it('moderation flags still hold a trusted account', async () => {
    moderate.mockResolvedValue({ ...clean, flags: ['abuse'] });
    expect(await needsHumanApproval(memStore([], { trusted: true }).store, env(), report())).toBe(true);
  });
});

describe('needsHumanApproval — other modes unchanged', () => {
  it('review holds everything without calling the model; an approved report never waits', async () => {
    expect(await needsHumanApproval(memStore([owned('submitted')], { trusted: true }).store, env('review'), report())).toBe(true);
    expect(await needsHumanApproval(memStore().store, env('review'), report({ approvedAt: '2026-10-30T12:00:00.000Z' }))).toBe(false);
    expect(moderate).not.toHaveBeenCalled();
  });

  it('auto files a new account\'s "Not sure" report; only a flag holds it', async () => {
    expect(await needsHumanApproval(memStore().store, env('auto'), report({ category: 'unsure', description: 'x', photo: null }))).toBe(false);
    moderate.mockResolvedValue({ ...clean, flags: ['emergency'] });
    expect(await needsHumanApproval(memStore().store, env('auto'), report())).toBe(true);
  });
});
