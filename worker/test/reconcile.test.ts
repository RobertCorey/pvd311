/**
 * reconcile.test.ts — the watcher's reconcile pass (engine.runReconcile), with a stubbed store + portal.
 *
 * Covers the four behaviours alice specified: ADOPT a ref-marked row we don't know as submitted,
 * list STRANDED Drafts, flag MISSING case numbers, stay IDEMPOTENT across ticks, and NEVER write 'failed'.
 * No city traffic and no real browser: engine.ts value-imports `launch` from @cloudflare/playwright
 * (which can't load in node), so that module is mocked to nothing — runReconcile only touches the
 * injected store + portal.readMyRequests().
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@cloudflare/playwright', () => ({ launch: vi.fn() }));

import { runReconcile } from '../src/engine';
import type { Store, ReportDoc, Portal } from '../src/contracts';
import type { MyRequestRow } from '../src/portal';

const ts = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0, toDate: () => new Date(iso) });
const daysAgoIso = (n: number) => new Date(Date.now() - n * 24 * 3_600_000).toISOString();

const report = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  id: 'rep-' + Math.random().toString(36).slice(2, 10),
  timestamp: ts('2026-08-20T12:00:00Z') as any,
  category: 'pothole', address: '25 Dorrance St', lat: 41.82, lng: -71.41,
  description: null, photo: null, reporterName: null, reporterEmail: null,
  status: 'failed', statusDetail: null, portalCaseId: null,
  statusUpdatedAt: ts('2026-08-20T12:05:00Z') as any,
  ...over,
} as ReportDoc);

const row = (over: Partial<MyRequestRow> = {}): MyRequestRow => ({
  caseId: null, entityId: null, status: '', street: '', createdOn: '', ...over,
});

/** Stateful store stub: findByStatus/listSubmittedWithCaseId read the array, updateReportStatus/patchReport mutate it, meta round-trips. */
function makeStore(reports: ReportDoc[]) {
  const events: { kind: string; level: string; msg: string; reportId?: string | null; data?: unknown }[] = [];
  const meta: Record<string, any> = {};
  const store: Partial<Store> = {
    findByStatus: vi.fn(async (status) => reports.filter((r) => r.status === status)),
    listSubmittedWithCaseId: vi.fn(async () => reports.filter((r) => r.status === 'submitted' && r.portalCaseId != null)),
    updateReportStatus: vi.fn(async (id, status, detail, caseId) => {
      const r = reports.find((x) => x.id === id); if (!r) return;
      r.status = status; r.statusDetail = detail ?? null;
      if (caseId) r.portalCaseId = caseId;
      if (status === 'submitted') r.portalDraft = null;
    }),
    patchReport: vi.fn(async (id, fields) => { const r = reports.find((x) => x.id === id); if (r) Object.assign(r, fields); }),
    getMeta: vi.fn(async (doc) => meta[doc] ?? null),
    setMeta: vi.fn(async (doc, data) => { meta[doc] = { ...(meta[doc] ?? {}), ...data }; }), // Firestore field-merge: array fields replace wholesale
    addEvent: vi.fn(async (ev) => { events.push(ev as any); }),
  };
  return { store: store as Store, events, meta };
}

const makePortal = (rows: MyRequestRow[]): Portal => ({ readMyRequests: vi.fn(async () => rows) } as unknown as Portal);

describe('reconcile: adopt', () => {
  it('adopts a report whose captured number is live (non-Draft) in My Requests', async () => {
    const r = report({ id: 'rep-adopt', status: 'failed', portalCaseIdCandidate: 'PVD2026-100' });
    const { store, events } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-100', status: 'Assigned', street: '25 Dorrance St' })]));

    expect(r.status).toBe('submitted');
    expect(r.portalCaseId).toBe('PVD2026-100');
    expect(r.caseIdPending).toBe(false);
    expect((r as any).portalStatus).toBe('Assigned');
    expect((r as any).review?.by).toBe('reconcile');
    expect(s.adopted).toEqual(['PVD2026-100']); // arrays of PVD numbers; health block derives counts + ids from these
    expect(s.error).toBeNull();
    expect(events.some((e) => e.kind === 'reconcile.adopted' && e.reportId === 'rep-adopt')).toBe(true);
  });

  it('adopts by the draft-bookkeeping caseId when no separate candidate was recorded', async () => {
    const r = report({ id: 'rep-adopt2', status: 'failed', portalDraft: { url: 'u', entityId: 'g', step: 3, savedAt: daysAgoIso(1), caseId: 'PVD2026-101' } });
    const { store } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-101', status: 'Submitted' })]));
    expect(r.status).toBe('submitted');
    expect(s.adopted).toEqual(['PVD2026-101']);
  });

  it('does NOT adopt a reporter-cancelled report even if its case is live on the portal', async () => {
    const r = report({ id: 'rep-cancel', status: 'rejected', cancelledByReporter: true, portalCaseIdCandidate: 'PVD2026-111' });
    const { store } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-111', status: 'Assigned' })]));
    expect(r.status).toBe('rejected');
    expect(s.adopted).toEqual([]);
  });
});

describe('reconcile: stranded drafts', () => {
  it('lists a stale Draft (>24h) tied to a failed report as stranded, without touching its status', async () => {
    const r = report({ id: 'rep-strand', status: 'failed', portalDraft: { url: 'u', entityId: 'guid-1', step: 3, savedAt: daysAgoIso(3), caseId: 'PVD2026-200' } });
    const { store, events } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-200', status: 'Draft' })]));

    expect(s.stranded).toEqual(['PVD2026-200']);
    expect(r.status).toBe('failed'); // untouched — reconcile never mutates a stranded report
    expect(store.updateReportStatus).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'reconcile.stranded')).toBe(true);
  });

  it('does NOT strand a Draft younger than 24h', async () => {
    const r = report({ id: 'rep-fresh', status: 'failed', portalDraft: { url: 'u', entityId: 'g', step: 3, savedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), caseId: 'PVD2026-201' } });
    const { store } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-201', status: 'Draft' })]));
    expect(s.stranded).toEqual([]);
  });

  it('does NOT strand a Draft whose report is still pending/processing (only failed/rejected count)', async () => {
    const r = report({ id: 'rep-await', status: 'awaiting_review', portalDraft: { url: 'u', entityId: 'g', step: 3, savedAt: daysAgoIso(3), caseId: 'PVD2026-202' } });
    const { store } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-202', status: 'Draft' })]));
    expect(s.stranded).toEqual([]);
  });
});

describe('reconcile: missing', () => {
  it('flags a submitted case whose number vanished from My Requests', async () => {
    const r = report({ id: 'rep-missing', status: 'submitted', portalCaseId: 'PVD2026-300', portalStatus: 'Assigned' });
    const { store, events } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-999', status: 'Assigned' })])); // some other row: scanned > 0

    expect(s.missing).toEqual(['PVD2026-300']);
    expect(r.status).toBe('submitted'); // untouched
    expect(store.updateReportStatus).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'reconcile.missing')).toBe(true);
  });

  it('does NOT flag missing on a 0-row scrape — a transient empty grid is not "everything vanished"', async () => {
    const r = report({ id: 'rep-x', status: 'submitted', portalCaseId: 'PVD2026-300' });
    const { store, events } = makeStore([r]);
    const s = await runReconcile(store, makePortal([]));
    expect(s.scanned).toBe(0);
    expect(s.missing).toEqual([]);
    expect(s.error).toBeNull();
    expect(events.some((e) => e.kind === 'reconcile.empty_scan')).toBe(true);
    expect(events.some((e) => e.kind === 'reconcile.missing')).toBe(false);
  });

  it('does NOT flag a submitted case that is still present in the grid', async () => {
    const r = report({ id: 'rep-present', status: 'submitted', portalCaseId: 'PVD2026-301' });
    const { store } = makeStore([r]);
    const s = await runReconcile(store, makePortal([row({ caseId: 'PVD2026-301', status: 'Assigned' })]));
    expect(s.missing).toEqual([]);
  });
});

describe('reconcile: safety + idempotency', () => {
  const mixed = () => [
    report({ id: 'a', status: 'failed', portalDraft: { url: 'u', entityId: 'g', step: 3, savedAt: daysAgoIso(3), caseId: 'PVD2026-1' } }), // stranded
    report({ id: 'b', status: 'submitted', portalCaseId: 'PVD2026-2' }),                                                                  // missing
    report({ id: 'c', status: 'failed', portalCaseIdCandidate: 'PVD2026-3' }),                                                            // adopt
  ];
  const portalRows = () => [row({ caseId: 'PVD2026-1', status: 'Draft' }), row({ caseId: 'PVD2026-3', status: 'Assigned' })];

  it('NEVER writes status "failed" — not on adopt, stranded, or missing', async () => {
    const { store } = makeStore(mixed());
    await runReconcile(store, makePortal(portalRows()));
    const calls = (store.updateReportStatus as any).mock.calls as any[][];
    expect(calls.every((c) => c[1] !== 'failed')).toBe(true);
    expect(calls.map((c) => c[1])).toEqual(['submitted']); // the one write is the adopt
  });

  it('is idempotent across ticks: a second identical pass makes no new writes and no new events', async () => {
    const reports = mixed();
    const { store, events } = makeStore(reports);
    const portal = makePortal(portalRows());

    const s1 = await runReconcile(store, portal);
    expect(s1.adopted).toEqual(['PVD2026-3']);
    expect(s1.stranded).toEqual(['PVD2026-1']);
    expect(s1.missing).toEqual(['PVD2026-2']);
    const writesAfter1 = (store.updateReportStatus as any).mock.calls.length;
    const eventsAfter1 = events.length;

    const s2 = await runReconcile(store, portal);
    expect(s2.adopted).toEqual([]);                                    // 'c' is now submitted → no longer a candidate
    expect((store.updateReportStatus as any).mock.calls.length).toBe(writesAfter1); // no new status writes
    expect(events.length).toBe(eventsAfter1);                          // stranded/missing already recorded last tick
    expect(s2.stranded).toEqual(['PVD2026-1']);                        // summary still reflects current state
    expect(s2.missing).toEqual(['PVD2026-2']);
  });
});
