/**
 * notify.ts — who gets a reporter-facing status email for a report.
 *   reporterEmail (unless the owning account turned email updates off)
 *   + followers (anonymous follow-by-email)
 *   + followerUids → users/{uid}.email when that account's prefs.emailUpdates is on
 * De-duplicated, lowercase. Never throws (a broken user doc just drops that recipient).
 */
import type { ReportDoc, Store, Mailer } from './contracts.js';

export async function recipientsFor(store: Store, report: ReportDoc): Promise<string[]> {
  const out = new Set<string>();
  const add = (e: string | null | undefined) => { if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) out.add(e.toLowerCase()); };
  try {
    let ownerOptedOut = false;
    if (report.ownerUid) {
      const owner = await store.getUser(report.ownerUid).catch(() => null);
      ownerOptedOut = owner?.prefs?.emailUpdates === false;
    }
    if (!ownerOptedOut) add(report.reporterEmail);
    for (const e of report.followers ?? []) add(e);
    for (const uid of (report.followerUids ?? []).slice(0, 200)) {
      if (uid === report.ownerUid) continue;
      const u = await store.getUser(uid).catch(() => null);
      if (u?.email && u.prefs?.emailUpdates !== false) add(u.email);
    }
  } catch (e) {
    console.error('[notify] recipients failed', e);
  }
  return [...out];
}

/** Send one reporter-facing email to everyone who should hear about this report. Gated inside mailer.sendTo. */
export async function notifyReport(store: Store, mailer: Mailer, report: ReportDoc, subject: string, html: string): Promise<number> {
  const to = await recipientsFor(store, report);
  for (const addr of to) await mailer.sendTo(addr, subject, html);
  return to.length;
}
