/**
 * notify.ts — who gets a reporter-facing status email for a report, and what the city-status email says.
 *   reporterEmail (unless the owning account turned email updates off)
 *   + followerUids → users/{uid}.email when that account's prefs.emailUpdates is on
 * De-duplicated, lowercase. Never throws (a broken user doc just drops that recipient).
 */
import type { ReportDoc, Store, Mailer } from './contracts.js';

export async function recipientsFor(store: Store, report: ReportDoc, opts: { excludeOwner?: boolean } = {}): Promise<string[]> {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => { if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) out.add(e.toLowerCase()); };
  try {
    let ownerOptedOut = false;
    if (report.ownerUid && !opts.excludeOwner) {
      const owner = await store.getUser(report.ownerUid).catch(() => null);
      ownerOptedOut = owner?.prefs?.emailUpdates === false;
    }
    if (!ownerOptedOut && !opts.excludeOwner) add(report.reporterEmail);
    const ownerEmail = opts.excludeOwner ? report.reporterEmail?.toLowerCase() ?? null : null;
    for (const uid of (report.followerUids ?? []).slice(0, 200)) {
      if (uid === report.ownerUid) continue;
      const u = await store.getUser(uid).catch(() => null);
      if (u?.email && u.prefs?.emailUpdates !== false && u.email.toLowerCase() !== ownerEmail) add(u.email);
    }
  } catch (e) {
    console.error('[notify] recipients failed', e);
  }
  return [...out];
}

/** Send one reporter-facing email to everyone who should hear about this report. Gated inside mailer.sendTo. */
export async function notifyReport(store: Store, mailer: Mailer, report: ReportDoc, subject: string, html: string, opts?: { replyTo?: string; excludeOwner?: boolean }): Promise<number> {
  const to = await recipientsFor(store, report, { excludeOwner: opts?.excludeOwner });
  for (const addr of to) await mailer.sendTo(addr, subject, html, opts?.replyTo ? { replyTo: opts.replyTo } : undefined);
  return to.length;
}

/**
 * Our own words for a city status change. Neutral on purpose: the city's "Resolved" often means it handed
 * the case to another department, not that the problem is fixed (PVD2026-90091, 2026-10-16), so we only say
 * what the city did to the request. The city's status name and its Resolution Message are quoted, never parsed.
 */
const STATUS_PHRASE: Record<string, string> = {
  Submitted: 'The city received your request',
  Assigned: 'The city assigned your request',
  'In Progress': 'The city marked your request in progress',
  'Department Responded': 'A city department responded to your request',
  Resolved: 'The city closed your request',
  Closed: 'The city closed your request',
  Completed: 'The city closed your request',
  Cancelled: 'The city cancelled your request',
  Canceled: 'The city cancelled your request',
  Merged: 'The city merged your request with another one',
};
export const statusPhrase = (status: string): string => STATUS_PHRASE[status] ?? 'The city updated your request';

/** Subject + HTML for the watcher's "city status changed" email. `resolution` = the city's Resolution Message, verbatim. */
export function statusChangeEmail(o: { category: string; address: string; caseId: string; status: string; trackUrl: string; resolution: string | null }): { subject: string; html: string } {
  const phrase = statusPhrase(o.status);
  const note = o.resolution
    ? `<p style="margin-bottom:4px">The city's note:</p><blockquote style="margin:0 0 1em;padding:8px 12px;border-left:3px solid #ccc;white-space:pre-wrap">${esc(o.resolution)}</blockquote>`
    : '';
  const html = `<p>${esc(phrase)}: your ${esc(o.category.replace(/_/g, ' '))} report at ${esc(o.address)} (city case <b>${esc(o.caseId)}</b>).</p>`
    + `<p>City status: <b>${esc(o.status)}</b></p>${note}`
    + `<p><a href="${esc(o.trackUrl)}">Track it here</a>.</p><p style="color:#888">FixMyPVD is an independent project, not affiliated with the City of Providence. Reply to stop updates.</p>`;
  return { subject: `${phrase} (${o.caseId})`, html };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
