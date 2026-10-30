/**
 * offgrid.test.ts — tracked cases past My Requests' 12-row window (2026-10-30).
 *
 * Live: the grid returns only its newest 12 rows (and calls the scan complete), so 6 of our 17 cases froze —
 * PVD2026-90092 still "Assigned" though the city resolved it — and reconcile flagged them "missing" every run, holding
 * /admin's System sync light red for 14 days. The watcher now takes their status from the detail read's search row,
 * catches each one's backlog up silently once, and mails later moves as usual; reconcile treats the grid as a window.
 *
 * runWatcher end to end with stubbed store / portal / mailer / push (module mocks, as emaillog.test.ts does): no browser,
 * no city traffic, no Firestore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ store: null as any, portal: null as any, mailer: null as any }));
vi.mock('@cloudflare/playwright', () => ({ launch: vi.fn() }));
vi.mock('../src/firestore', async (orig) => ({ ...(await orig<typeof import('../src/firestore')>()), createStore: () => h.store, createAuthStore: () => ({}) }));
vi.mock('../src/portal', async (orig) => ({ ...(await orig<typeof import('../src/portal')>()), createPortal: () => h.portal }));
vi.mock('../src/email', async (orig) => ({ ...(await orig<typeof import('../src/email')>()), createMailer: () => h.mailer }));
vi.mock('../src/push', async (orig) => ({ ...(await orig<typeof import('../src/push')>()), pushOwner: vi.fn(async () => ({ users: 1, sent: 1 })) }));

import { runWatcher } from '../src/engine';
import { handleAdmin } from '../src/adminapi';
import { buildDetail } from '../src/casedetail';
import { pushOwner } from '../src/push';
import type { CaseDetailRaw, Env, ReportDoc } from '../src/contracts';

const env = { APP_NAME: 'FixMyPVD', APP_BASE_URL: 'https://fixmypvd.org', RECONCILE_ENABLED: '1', ADMIN_EMAILS: 'rob@example.com' } as unknown as Env;
const admin = { uid: 'u', email: 'rob@example.com', emailVerified: true, name: null, provider: 'google.com' };
const raw: CaseDetailRaw = { fields: { title: { label: 'Case Title', value: 'PVD2026 Report Street Light Issue', readonly: true } }, notes: [] };

const rep = (caseId: string, portalStatus: string): ReportDoc => ({
  id: `r-${caseId.slice(-5)}`, status: 'submitted', portalCaseId: caseId, portalStatus,
  portalStatusHistory: [{ status: portalStatus, at: '2026-10-16T12:00:00.000Z' }],
  portalDetail: buildDetail(raw), portalDetailCheckedAt: '2026-10-29T00:00:00.000Z',
  category: 'street_light', address: '25 Dorrance St', lat: null, lng: null, description: null, photo: null, timestamp: null,
  reporterName: null, reporterEmail: 'owner@example.com', ownerUid: 'owner', statusDetail: null, statusUpdatedAt: null,
} as ReportDoc);

const GRID = ['PVD2026-90110', 'PVD2026-90111']; // the newest cases: still in the grid
const gridRow = (caseId: string) => ({ caseId, entityId: null, status: 'Assigned', street: '25 Dorrance St', createdOn: '10/28/2026 9:00 AM' });
let reports: ReportDoc[];
let events: any[];
let meta: Record<string, any>;
let city: Record<string, string>; // the city's status, as each case's search row shows it

beforeEach(() => {
  vi.clearAllMocks();
  reports = [...GRID.map((c) => rep(c, 'Assigned')), rep('PVD2026-90089', 'Submitted'), rep('PVD2026-90092', 'Assigned')];
  events = []; meta = {};
  city = { 'PVD2026-90089': 'In Progress', 'PVD2026-90092': 'Resolved' };
  const byId = (id: string) => reports.find((r) => r.id === id);
  h.store = {
    // Fresh copies, like Firestore: a patch never changes a report object the watcher already holds.
    listSubmittedWithCaseId: vi.fn(async () => structuredClone(reports.filter((r) => r.status === 'submitted' && r.portalCaseId))),
    fetchReport: vi.fn(async (id: string) => (byId(id) ? structuredClone(byId(id)) : null)),
    patchReport: vi.fn(async (id: string, f: Record<string, unknown>) => { const r = byId(id); if (r) Object.assign(r, f); }),
    findSubmittedUnconfirmed: vi.fn(async () => []), findByStatus: vi.fn(async () => []),
    getUser: vi.fn(async (uid: string) => ({ uid, email: 'owner@example.com', prefs: {} })),
    getMeta: vi.fn(async (k: string) => meta[k] ?? null),
    setMeta: vi.fn(async (k: string, v: Record<string, unknown>) => { meta[k] = { ...(meta[k] ?? {}), ...v }; }),
    addEvent: vi.fn(async (e: unknown) => { events.push(e); }),
    countByStatus: vi.fn(async () => 0), countUsers: vi.fn(async () => 0), recentEvents: vi.fn(async () => []),
  };
  h.portal = {
    launch: vi.fn(async () => {}), ensureLoggedIn: vi.fn(async () => {}), close: vi.fn(async () => {}),
    // Live shape: the window only, and the scan still says complete.
    readMyRequestsPaged: vi.fn(async () => ({ rows: GRID.map(gridRow), complete: true })),
    readCaseDetail: vi.fn(async (caseId: string) => ({ ...raw, rowStatus: city[caseId] })),
  };
  h.mailer = { send: vi.fn(async () => 'm'), sendTo: vi.fn(async () => 'm'), alert: vi.fn(async () => {}) };
});

const report = (caseId: string) => reports.find((r) => r.portalCaseId === caseId)!;
const statusEvents = () => events.filter((e) => e.kind === 'watcher.status');

describe('cases past the 12-row grid', () => {
  it('get their CASE status from the search row; the first catch-up (the backlog) is silent — no mail, no push, no alert', async () => {
    await runWatcher(env);

    expect(h.portal.readCaseDetail.mock.calls.map((c: string[]) => c[0]).sort()).toEqual(['PVD2026-90089', 'PVD2026-90092']);
    expect(report('PVD2026-90089')).toMatchObject({ portalStatus: 'In Progress', portalStatusLiveAt: expect.any(String) });
    expect(report('PVD2026-90110').portalStatusLiveAt).toEqual(expect.any(String)); // seen in the grid: it has no backlog
    expect(report('PVD2026-90092').portalStatus).toBe('Resolved');
    expect(report('PVD2026-90092').portalStatusHistory?.map((x) => x.status)).toEqual(['Assigned', 'Resolved']);
    expect(statusEvents().map((e) => [e.data.caseId, e.data.from, e.data.to, e.data.via, e.data.silent])).toEqual([
      ['PVD2026-90089', 'Submitted', 'In Progress', 'detail', true],
      ['PVD2026-90092', 'Assigned', 'Resolved', 'detail', true],
    ]);
    expect(h.mailer.sendTo).not.toHaveBeenCalled();
    expect(h.mailer.alert).not.toHaveBeenCalled();
    expect(pushOwner).not.toHaveBeenCalled();
    expect(meta.health_watcher.lastDetail).toBe('4 tracked, 2 rows, 2 past them, 2 changes, detail 2 read/0 changed');
  });

  it('a later move off the grid mails and pushes as usual; a closed case is not re-read', async () => {
    await runWatcher(env); // the backlog, silent
    city['PVD2026-90089'] = 'Resolved';
    vi.clearAllMocks();
    await runWatcher(env);

    expect(h.portal.readCaseDetail.mock.calls.map((c: string[]) => c[0])).toEqual(['PVD2026-90089']); // 90092 is Resolved now
    expect(report('PVD2026-90089').portalStatus).toBe('Resolved');
    expect(statusEvents().at(-1).data).toMatchObject({ caseId: 'PVD2026-90089', from: 'In Progress', to: 'Resolved', via: 'detail', silent: false });
    expect(h.mailer.sendTo).toHaveBeenCalledTimes(1);
    expect(h.mailer.sendTo.mock.calls[0].slice(0, 2)).toEqual(['owner@example.com', 'The city closed your request (PVD2026-90089)']);
    expect(h.mailer.sendTo.mock.calls[0][3]).toMatchObject({ kind: 'status', reportId: 'r-90089' });
    expect(pushOwner).toHaveBeenCalledTimes(1);
  });

  it('the same status on the first read only sets the marker, so the next real move is not swallowed', async () => {
    city['PVD2026-90089'] = 'Submitted';
    await runWatcher(env);
    expect(report('PVD2026-90089')).toMatchObject({ portalStatus: 'Submitted', portalStatusLiveAt: expect.any(String) });
    expect(statusEvents().map((e) => e.data.caseId)).toEqual(['PVD2026-90092']);

    city['PVD2026-90089'] = 'Assigned';
    await runWatcher(env);
    expect(h.mailer.sendTo).toHaveBeenCalledTimes(1);
    expect(h.mailer.sendTo.mock.calls[0][1]).toBe('The city assigned your request (PVD2026-90089)');
  });

  it('reconcile no longer calls them missing, and /admin\'s System sync light is green', async () => {
    meta.reconcile = { at: '2026-10-30T00:00:00Z', adopted: [], stranded: [], missing: ['PVD2026-90089', 'PVD2026-90092'], scanned: 2, complete: true, error: null }; // the 14 red days
    await runWatcher(env);
    expect(meta.reconcile).toMatchObject({ missing: [], scanned: 2, complete: true, error: null });
    expect(events.some((e) => e.kind === 'reconcile.missing')).toBe(false);

    const req = new Request('https://api.test/api/admin/health');
    const body = (await (await handleAdmin(req, new URL(req.url), env, h.store, admin)).json()) as any;
    expect(body.sync.reconcile.missing).toBe(0);
    expect(body.sync.status).toBe('ok');
  });

  it('one the search cannot find at any age twice running is missing (one slow search is not), until a read finds it', async () => {
    h.portal.readCaseDetail.mockImplementation(async (caseId: string) => (caseId === 'PVD2026-90089' ? null : { ...raw, rowStatus: city[caseId] }));
    await runWatcher(env);
    expect(report('PVD2026-90089').portalSearchMisses).toBe(1);
    expect(meta.reconcile.missing).toEqual([]); // the light stays green on a single miss
    await runWatcher(env);
    expect(report('PVD2026-90089').portalSearchMisses).toBe(2);
    expect(meta.reconcile.missing).toEqual(['PVD2026-90089']);

    h.portal.readCaseDetail.mockImplementation(async (caseId: string) => ({ ...raw, rowStatus: city[caseId] }));
    await runWatcher(env);
    expect(report('PVD2026-90089').portalSearchMisses).toBeNull();
    expect(meta.reconcile.missing).toEqual([]);
  });

  it('a case seen in the grid that drops past the window has no backlog: its first search-row move mails', async () => {
    await runWatcher(env); // PVD2026-90110 is in the grid: seen live
    vi.clearAllMocks();
    // A newer filing pushes 90110 out of the window, and the city closes it meanwhile.
    h.portal.readMyRequestsPaged.mockImplementation(async () => ({ rows: [gridRow('PVD2026-90111')], complete: true }));
    city['PVD2026-90110'] = 'Resolved';
    await runWatcher(env);

    expect(statusEvents().at(-1).data).toMatchObject({ caseId: 'PVD2026-90110', from: 'Assigned', to: 'Resolved', via: 'detail', silent: false });
    expect(h.mailer.sendTo.mock.calls.map((c: unknown[]) => c[1])).toEqual(['The city closed your request (PVD2026-90110)']);
    expect(pushOwner).toHaveBeenCalledTimes(1);
  });

  it('off-grid reads that keep failing do not hold the rotation: a failed read counts as checked', async () => {
    reports.push(rep('PVD2026-90094', 'Assigned'));
    city['PVD2026-90094'] = 'Resolved';
    h.portal.readCaseDetail.mockImplementation(async (caseId: string) => {
      if (caseId !== 'PVD2026-90094') throw new Error(`${caseId}: the case-detail modal did not load`);
      return { ...raw, rowStatus: city[caseId] };
    });
    await runWatcher(env); // 90089 + 90092 take both slots and fail
    await runWatcher(env); // 90094 is least-recently-checked now

    expect(report('PVD2026-90094').portalStatus).toBe('Resolved');
    expect(events.filter((e) => e.kind === 'watcher.detail_failed').map((e) => [e.data.caseId, e.data.reason])).toEqual([
      ['PVD2026-90089', 'off_grid'], ['PVD2026-90092', 'off_grid'], ['PVD2026-90089', 'off_grid'],
    ]);
  });
});
