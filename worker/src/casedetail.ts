/**
 * casedetail.ts — snapshot the portal's per-case detail modal (form fields + comment/email timeline)
 * onto the report, and diff it over time.
 *
 * Why raw: the modal is the only place the city's routing decisions show up (the dispatch emails
 * "PVD 311 → RI Energy", their internal PVD311:nnnnnnn ticket ids, later replies). We do not yet know
 * which parts will matter, so the whole thing is kept (capped) and every change is logged as an event
 * (`watcher.detail_changed`, with the new notes' senders + a preview). Nothing here is shown in the app;
 * /admin's raw JSON has it.
 *
 * Cadence (engine.ts): the watcher captures on first sighting and whenever the grid status changes
 * (≤ DETAIL_PER_WATCH per run); runDaily refreshes open (non-terminal) cases oldest-checked first
 * (≤ DETAIL_PER_DAY). Cost is bounded by the open set, not by lifetime volume. Read-only against
 * the portal: readCaseDetail never clicks Submit / Add comment / Upload.
 */

import type { CaseDetailRaw, Portal, ReportDoc, Store } from './contracts.js';
import type { PortalCaseDetail, PortalCaseNote, PortalRouting } from '../../shared/types.js';
import { logEvent } from './health.js';

export const DETAIL_PER_WATCH = 10;
export const DETAIL_PER_DAY = 30;
export const DETAIL_NOTE_CAP = 40;
export const DETAIL_TEXT_CAP = 6_000;

/** FNV-1a 32-bit over the parts that mean "something changed"; hex. Pure, deterministic. */
export function hashDetail(fields: PortalCaseDetail['fields'], notes: PortalCaseNote[]): string {
  const material = JSON.stringify([
    Object.keys(fields).sort().map((k) => [k, fields[k].value]),
    notes.map((n) => [n.modifiedOn, n.from, n.to, n.text, n.attachments]),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function buildDetail(raw: CaseDetailRaw, now = new Date()): PortalCaseDetail {
  const notes = raw.notes.slice(0, DETAIL_NOTE_CAP).map((n) => ({ ...n, text: n.text.slice(0, DETAIL_TEXT_CAP) }));
  const detail: PortalCaseDetail = { capturedAt: now.toISOString(), hash: hashDetail(raw.fields, notes), fields: raw.fields, notes };
  if (raw.notes.length > DETAIL_NOTE_CAP) detail.truncated = true;
  return detail;
}

const noteKey = (n: PortalCaseNote) => `${n.modifiedOn ?? ''}|${n.from}|${n.to ?? ''}|${n.text.slice(0, 200)}`;

/** Notes present in `next` but not in `prev` (by time+sender+text), plus field ids whose value changed. */
export function diffDetail(prev: PortalCaseDetail | null | undefined, next: PortalCaseDetail): { newNotes: PortalCaseNote[]; changedFields: string[] } {
  const seen = new Set((prev?.notes ?? []).map(noteKey));
  const newNotes = next.notes.filter((n) => !seen.has(noteKey(n)));
  const changedFields = Object.keys(next.fields).filter((k) => (prev?.fields?.[k]?.value ?? null) !== next.fields[k].value);
  return { newNotes, changedFields };
}

/** Is this note one of ours (the portal account) rather than the city's? */
export function isOwnNote(n: PortalCaseNote, selfName: string): boolean {
  const self = selfName.toLowerCase();
  return !!self && n.from.toLowerCase().includes(self);
}

/**
 * Routing = the city's dispatches, as the timeline shows them: a note from "PVD 311" to some party
 * that is not us. Fallback for older renderings: the email body's "Dear <X> Team,". Oldest first.
 */
export function deriveRouting(notes: PortalCaseNote[], selfName: string): PortalRouting[] {
  const self = selfName.toLowerCase();
  const out: PortalRouting[] = [];
  const seen = new Set<string>();
  for (const n of [...notes].reverse()) {
    let dept: string | null = null;
    if (/^pvd\s*311$/i.test(n.from.trim()) && n.to && !(self && n.to.toLowerCase().includes(self))) dept = n.to.trim();
    if (!dept) {
      const m = n.text.match(/\bDear\s+(.+?)\s+Team\b/i);
      if (m && !(self && m[1].toLowerCase().includes(self))) dept = m[1].trim();
    }
    if (!dept) continue;
    const ticket = n.text.match(/PVD311:(\d+)/i)?.[0] ?? null;
    const key = `${dept.toLowerCase()}|${ticket ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dept, at: n.modifiedOn ?? null, ticket });
  }
  return out;
}

export interface CaptureOptions { max: number; selfName: string; reason: 'first' | 'status_change' | 'daily'; now?: () => Date }
export interface CaptureSummary { checked: number; changed: number; unavailable: number; failed: number }

/** Portal must already be launched + logged in. Non-fatal per case; never throws for one bad modal. */
export async function captureCaseDetails(store: Store, portal: Portal, reports: ReportDoc[], opts: CaptureOptions): Promise<CaptureSummary> {
  const sum: CaptureSummary = { checked: 0, changed: 0, unavailable: 0, failed: 0 };
  const now = opts.now ?? (() => new Date());
  for (const report of reports.slice(0, opts.max)) {
    const caseId = report.portalCaseId;
    if (!caseId) continue;
    sum.checked++;
    const at = now().toISOString();
    let raw: CaseDetailRaw | null;
    try {
      raw = await portal.readCaseDetail(caseId);
    } catch (e) {
      sum.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[detail] ${caseId} failed: ${msg}`);
      await logEvent(store, { level: 'warn', kind: 'watcher.detail_failed', msg: `${caseId}: ${msg}`, reportId: report.id, data: { caseId, reason: opts.reason } });
      continue;
    }
    if (!raw) {
      sum.unavailable++;
      await store.patchReport(report.id, { portalDetailCheckedAt: at });
      await logEvent(store, { level: 'warn', kind: 'watcher.detail_unavailable', msg: `${caseId}: not found in My Requests`, reportId: report.id, data: { caseId, reason: opts.reason } });
      continue;
    }
    const next = buildDetail(raw, now());
    const prev = report.portalDetail ?? null;
    if (prev && prev.hash === next.hash) {
      await store.patchReport(report.id, { portalDetailCheckedAt: at });
      continue;
    }
    const { newNotes, changedFields } = diffDetail(prev, next);
    const routing = deriveRouting(next.notes, opts.selfName);
    const prevRouting = report.portalRouting ?? [];
    const newDepts = routing.filter((r) => !prevRouting.some((p) => p.dept === r.dept && p.ticket === r.ticket)).map((r) => r.dept);
    await store.patchReport(report.id, { portalDetail: next, portalDetailCheckedAt: at, portalRouting: routing });
    sum.changed++;
    const cityNotes = newNotes.filter((n) => !isOwnNote(n, opts.selfName));
    const preview = newNotes.slice(0, 5).map((n) => ({ from: n.from, to: n.to, at: n.modifiedOn, text: n.text.slice(0, 160), attachments: n.attachments.length }));
    const what = prev
      ? `${newNotes.length} new note${newNotes.length === 1 ? '' : 's'}${changedFields.length ? `, ${changedFields.length} field${changedFields.length === 1 ? '' : 's'} changed` : ''}`
      : `first snapshot: ${next.notes.length} note${next.notes.length === 1 ? '' : 's'}`;
    await logEvent(store, {
      level: prev && cityNotes.length ? 'warn' : 'info',
      kind: prev ? 'watcher.detail_changed' : 'watcher.detail_captured',
      msg: `${caseId}: ${what}${newDepts.length ? ` — routed to ${newDepts.join(', ')}` : ''}`,
      reportId: report.id,
      data: { caseId, reason: opts.reason, newNotes: preview, changedFields, routing, newDepts, hash: next.hash },
    });
  }
  return sum;
}

/** Which tracked reports the watcher should (re)read this run: status changed now, or never captured. */
export function pickWatchTargets(tracked: ReportDoc[], changedIds: Set<string>): ReportDoc[] {
  return tracked.filter((r) => r.portalCaseId && (changedIds.has(r.id) || !r.portalDetail));
}

/** Which reports the daily job refreshes: open (non-terminal) cases, least-recently-checked first. */
export function pickDailyTargets(tracked: ReportDoc[], isTerminal: (status: string) => boolean): ReportDoc[] {
  return tracked
    .filter((r) => r.portalCaseId && !isTerminal(r.portalStatus ?? ''))
    .sort((a, b) => (a.portalDetailCheckedAt ?? '').localeCompare(b.portalDetailCheckedAt ?? ''));
}
