/**
 * casedetail.test.ts — the routing-trail snapshot (casedetail.ts) with a stubbed store + portal.
 * No browser, no city traffic: portal.readCaseDetail is a vi.fn returning canned modal dumps.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildDetail, captureCaseDetails, deriveRouting, diffDetail, hashDetail, pickDailyTargets, pickWatchTargets } from '../src/casedetail';
import { TERMINAL_PORTAL_STATUS, type CaseDetailRaw, type Portal, type ReportDoc, type Store } from '../src/contracts';

const dispatch = (dept: string, ticket: string, at = '9/29/2026 11:27 AM') => ({
  postedOn: 'a day ago', modifiedOn: at, from: 'PVD 311', to: dept, createdBy: null, attachments: [] as string[],
  text: `India St | PVD2026-89374 Downed Wire PVD311:${ticket} Dear ${dept} Team, PVD311 received the service request below: Request Type: Downed Wire`,
});
const ack = { postedOn: 'a day ago', modifiedOn: '9/29/2026 11:26 AM', from: 'PVD 311', to: 'FixMyPVD fixmypvd.org', createdBy: null, attachments: [] as string[], text: 'THIS IS AN AUTOMATED SYSTEM MESSAGE FROM PVD311. Your service request has been received.' };
const fields = { title: { label: 'Case Title', value: 'PVD2026-89374 Downed Wire', readonly: true }, description: { label: 'Description', value: 'Exact location: …', readonly: false } };
const raw1: CaseDetailRaw = { fields, notes: [dispatch('RI Energy', '0287190'), dispatch('Verizon', '0287189'), ack] };

function makeReport(over: Partial<ReportDoc> = {}): ReportDoc {
  return { id: 'r1', status: 'submitted', portalCaseId: 'PVD2026-89374', portalStatus: 'Assigned', category: 'downed_wire', address: 'India St', lat: null, lng: null, description: null, photo: null, timestamp: null, reporterName: null, reporterEmail: null, statusDetail: null, ...over } as ReportDoc;
}
function makeStore(reports: ReportDoc[]) {
  const events: { kind: string; level: string; msg: string; reportId?: string | null; data?: any }[] = [];
  const store: Partial<Store> = {
    patchReport: vi.fn(async (id, f) => { const r = reports.find((x) => x.id === id); if (r) Object.assign(r, f); }),
    addEvent: vi.fn(async (ev) => { events.push(ev as any); }),
  };
  return { store: store as Store, events };
}
const portalWith = (impl: (caseId: string) => Promise<CaseDetailRaw | null>) => ({ readCaseDetail: vi.fn(impl) } as unknown as Portal);
const opts = { max: 10, selfName: 'FixMyPVD', reason: 'first' as const, now: () => new Date('2026-09-30T20:00:00Z') };

describe('pure helpers', () => {
  it('hash is stable and changes with content', () => {
    const d = buildDetail(raw1);
    expect(d.hash).toBe(hashDetail(raw1.fields, raw1.notes));
    expect(buildDetail({ ...raw1, notes: [...raw1.notes, ack] }).hash).not.toBe(d.hash);
    expect(buildDetail({ ...raw1, fields: { ...fields, description: { ...fields.description, value: 'edited' } } }).hash).not.toBe(d.hash);
  });
  it('deriveRouting: PVD 311 → <dept> notes, oldest first, never us, with the ticket id', () => {
    expect(deriveRouting(raw1.notes, 'FixMyPVD')).toEqual([
      { dept: 'Verizon', at: '9/29/2026 11:27 AM', ticket: 'PVD311:0287189' },
      { dept: 'RI Energy', at: '9/29/2026 11:27 AM', ticket: 'PVD311:0287190' },
    ]);
  });
  it('deriveRouting falls back to "Dear <X> Team" when the sender arrow is missing', () => {
    const n = { ...dispatch('DPW', '0000001'), from: 'PVD311 Constituent Services', to: null };
    expect(deriveRouting([n], 'FixMyPVD')).toEqual([{ dept: 'DPW', at: n.modifiedOn, ticket: 'PVD311:0000001' }]);
  });
  it('diffDetail reports new notes and changed fields only', () => {
    const prev = buildDetail(raw1);
    const next = buildDetail({ fields: { ...fields, description: { ...fields.description, value: 'edited' } }, notes: [dispatch('DPW', '0300000', '10/1/2026 9:00 AM'), ...raw1.notes] });
    const d = diffDetail(prev, next);
    expect(d.newNotes.map((n) => n.to)).toEqual(['DPW']);
    expect(d.changedFields).toEqual(['description']);
  });
  it('caps notes and text', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...ack, modifiedOn: `n${i}`, text: 'x'.repeat(10_000) }));
    const d = buildDetail({ fields, notes: many });
    expect(d.notes.length).toBe(40);
    expect(d.truncated).toBe(true);
    expect(d.notes[0].text.length).toBe(6_000);
  });
  it('target pickers', () => {
    const a = makeReport({ id: 'a' });
    const b = makeReport({ id: 'b', portalDetail: buildDetail(raw1), portalDetailCheckedAt: '2026-09-29T00:00:00Z' });
    const c = makeReport({ id: 'c', portalStatus: 'Resolved', portalDetail: buildDetail(raw1), portalDetailCheckedAt: '2026-09-01T00:00:00Z' });
    const d = makeReport({ id: 'd', portalDetail: buildDetail(raw1), portalDetailCheckedAt: null });
    expect(pickWatchTargets([a, b, c], new Set(['c'])).map((r) => r.id)).toEqual(['a', 'c']);
    expect(pickDailyTargets([a, b, c, d], (s) => TERMINAL_PORTAL_STATUS.test(s)).map((r) => r.id)).toEqual(['a', 'd', 'b']);
  });
});

describe('captureCaseDetails', () => {
  it('first snapshot: stores detail + routing, logs detail_captured', async () => {
    const r = makeReport();
    const { store, events } = makeStore([r]);
    const sum = await captureCaseDetails(store, portalWith(async () => raw1), [r], opts);
    expect(sum).toEqual({ checked: 1, changed: 1, unavailable: 0, failed: 0 });
    expect(r.portalDetail?.notes.length).toBe(3);
    expect(r.portalDetail?.capturedAt).toBe('2026-09-30T20:00:00.000Z');
    expect(r.portalRouting?.map((x) => x.dept)).toEqual(['Verizon', 'RI Energy']);
    expect(r.portalDetailCheckedAt).toBe('2026-09-30T20:00:00.000Z');
    expect(events.map((e) => e.kind)).toEqual(['watcher.detail_captured']);
    expect(events[0].msg).toContain('routed to Verizon, RI Energy');
  });
  it('unchanged: only bumps checkedAt, no event, no rewrite', async () => {
    const r = makeReport({ portalDetail: buildDetail(raw1), portalRouting: deriveRouting(raw1.notes, 'FixMyPVD'), portalDetailCheckedAt: '2026-09-29T00:00:00Z' });
    const { store, events } = makeStore([r]);
    const sum = await captureCaseDetails(store, portalWith(async () => raw1), [r], opts);
    expect(sum.changed).toBe(0);
    expect(events).toEqual([]);
    expect(store.patchReport).toHaveBeenCalledWith('r1', { portalDetailCheckedAt: '2026-09-30T20:00:00.000Z' });
  });
  it('new city note: detail_changed at warn level names the new department', async () => {
    const r = makeReport({ portalDetail: buildDetail(raw1), portalRouting: deriveRouting(raw1.notes, 'FixMyPVD') });
    const { store, events } = makeStore([r]);
    const raw2 = { ...raw1, notes: [dispatch('DPW', '0300000', '10/1/2026 9:00 AM'), ...raw1.notes] };
    const sum = await captureCaseDetails(store, portalWith(async () => raw2), [r], { ...opts, reason: 'daily' });
    expect(sum.changed).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'watcher.detail_changed', level: 'warn' });
    expect(events[0].data.newDepts).toEqual(['DPW']);
    expect(events[0].data.newNotes[0]).toMatchObject({ from: 'PVD 311', to: 'DPW' });
    expect(r.portalRouting?.length).toBe(3);
  });
  it('our own comment changes the snapshot at info level', async () => {
    const r = makeReport({ portalDetail: buildDetail(raw1), portalRouting: deriveRouting(raw1.notes, 'FixMyPVD') });
    const { store, events } = makeStore([r]);
    const mine = { ...ack, from: 'FixMyPVD fixmypvd.org', to: 'Corinne Robbins', modifiedOn: '9/30/2026 4:34 PM', text: '' };
    await captureCaseDetails(store, portalWith(async () => ({ ...raw1, notes: [mine, ...raw1.notes] })), [r], opts);
    expect(events[0]).toMatchObject({ kind: 'watcher.detail_changed', level: 'info' });
    expect(r.portalRouting?.length).toBe(2);
  });
  it('missing row → detail_unavailable + checkedAt; throw → detail_failed; both non-fatal; max respected', async () => {
    const a = makeReport({ id: 'a', portalCaseId: 'PVD2026-1' });
    const b = makeReport({ id: 'b', portalCaseId: 'PVD2026-2' });
    const c = makeReport({ id: 'c', portalCaseId: 'PVD2026-3' });
    const { store, events } = makeStore([a, b, c]);
    const portal = portalWith(async (id) => { if (id === 'PVD2026-1') return null; throw new Error('modal timeout'); });
    const sum = await captureCaseDetails(store, portal, [a, b, c], { ...opts, max: 2 });
    expect(sum).toEqual({ checked: 2, changed: 0, unavailable: 1, failed: 1 });
    expect(a.portalDetailCheckedAt).toBeTruthy();
    expect(events.map((e) => e.kind)).toEqual(['watcher.detail_unavailable', 'watcher.detail_failed']);
    expect((portal.readCaseDetail as any).mock.calls.length).toBe(2);
  });
});
