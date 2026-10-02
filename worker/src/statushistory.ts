/**
 * statushistory.ts — the city's status trail for one case: every Status Reason the watcher saw, oldest first.
 * Pure (no Cloudflare imports) so the unit suite can cover it. The Track timeline renders one row per entry.
 */
import type { ReportDoc } from './contracts.js';

/** The city's status trail, oldest first, capped — one entry per change the watcher saw. Pure. */
export const STATUS_HISTORY_CAP = 20;
export function appendStatusHistory(prev: ReportDoc['portalStatusHistory'], status: string, at: Date): { status: string; at: string }[] {
  const list = [...(prev ?? [])];
  if (list[list.length - 1]?.status !== status) list.push({ status, at: at.toISOString() });
  return list.slice(-STATUS_HISTORY_CAP);
}
