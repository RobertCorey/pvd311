/**
 * Human-in-the-loop review + trust ramp (Worker port).
 *
 * Modes (env.HITL_MODE):
 *   review — every report needs a tap before it goes to the city (launch mode)
 *   ramp   — a new account's report waits for a tap only when it looks off (flagged, "Not sure", or nearly empty);
 *            after ACCOUNT_TRUST_N filed with a clean history it auto-approves; any rejection → every report reviewed
 *            unless an admin marks the account `trusted`
 *   auto   — nothing waits for a human (goal state; unanswered city questions are left blank)
 *
 * Approvals arrive as signed HTTP GETs to /hitl/approve|reject (see index.ts) — no polling.
 */
import type { Env, Mailer, ReportDoc, Store } from './contracts.js';
import { CATEGORIES } from '../../shared/categories.js';
import { actionUrl } from './email.js';
import { moderate } from './moderation.js';
import { logEvent } from './health.js';
import { accountStanding } from './me.js';

/** Decide whether this report can go straight to the portal. */
export async function needsHumanApproval(store: Store, env: Env, report: ReportDoc): Promise<boolean> {
  if (report.approvedAt) return false;
  const mode = env.HITL_MODE;
  if (mode === 'review') return true;
  // Server-side moderation, once per report — the client's intake flags are advisory (a client can omit them).
  // Any flag forces human review regardless of trust or mode.
  const flags = await ensureModerated(store, env, report);
  if (flags.length) return true;
  if (mode === 'auto') return false;
  // ramp: per ACCOUNT. Accounts are mandatory, so every report has an owner. Trusted (admin `trusted`, or
  // ACCOUNT_TRUST_N filed with 0 rejected) → auto. Any rejection is the brake: every report of that account waits for
  // a person, as before. A new clean account → held only when the report looks off (2026-10-30, below).
  if (!report.ownerUid) return true;
  const standing = await accountStanding(store, report.ownerUid, accountTrustN(env)).catch(() => null);
  if (standing === 'trusted') return false;
  if (standing !== 'new') return true; // 'rejected', or the lookup failed → reviewed
  return looksOff(report);
}

/** A new account's report that a person should read first. Until 2026-10-30 every first report waited: 12 in 15 days,
 *  0 rejected, median wait 1.46 h, 5 of 11 parked 8+ h overnight. The one junk one ("PEMA": "Not sure", 4 chars, no
 *  photo) passed moderation, so the catch-all category and a near-empty report without a photo are held on their own. */
function looksOff(report: ReportDoc): boolean {
  return report.category === 'unsure' || ((report.description ?? '').trim().length < 10 && !report.photo);
}

/** Run moderation server-side if it hasn't run yet; merge with client flags; persist. Fails SAFE: a model error (after one retry) → treat as flagged. */
async function ensureModerated(store: Store, env: Env, report: ReportDoc): Promise<string[]> {
  const client = report.intakeFlags ?? [];
  if (report.moderatedAt) return client;
  let merged: string[];
  const input = { category: report.category, description: report.description ?? '', address: report.address, extra: report.extra ?? {}, hasPhoto: !!report.photo };
  try {
    // One immediate retry before the fail-safe (2026-10-30): the only server "flag" in the first 15 days was this
    // fallback after a one-off Anthropic 403, which parked a clean report. The SDK already retries 429/5xx/network.
    const m = await moderate(env, input, store).catch((e) => {
      console.warn('[hitl] moderation failed; retrying once:', e instanceof Error ? e.message : e);
      return moderate(env, input, store);
    });
    merged = [...new Set([...client, ...m.flags])];
  } catch (e) {
    console.error('[hitl] moderation failed; forcing review:', e);
    merged = [...new Set([...client, 'spam'])]; // conservative: unknown → reviewed, not auto-filed
  }
  await store.patchReport(report.id, { intakeFlags: merged.length ? (merged as ReportDoc['intakeFlags']) : null, moderatedAt: new Date().toISOString() }).catch(() => {});
  report.intakeFlags = merged.length ? (merged as ReportDoc['intakeFlags']) : null;
  return merged;
}

/** Per-account trust threshold for HITL_MODE="ramp" (env ACCOUNT_TRUST_N, default 3). */
function accountTrustN(env: Env): number {
  const raw = (env as unknown as { ACCOUNT_TRUST_N?: string }).ACCOUNT_TRUST_N;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/** Park a report for review and email Rob signed approve/reject links. */
export async function requestReview(
  store: Store,
  mailer: Mailer,
  env: Env,
  report: ReportDoc,
  baseUrl: string,
): Promise<void> {
  const cat = CATEGORIES[report.category];
  const approveUrl = await actionUrl(baseUrl, env.HITL_SECRET, 'approve', report.id);
  const rejectUrl = await actionUrl(baseUrl, env.HITL_SECRET, 'reject', report.id);

  const html = [
    `<p><b>${esc(cat?.label ?? report.category)}</b> &rarr; ${esc(cat?.portalCaseTypeName ?? '')}</p>`,
    `<p>${esc(report.address)}</p>`,
    report.description ? `<blockquote>${esc(report.description.slice(0, 600))}</blockquote>` : '<p><i>(no description)</i></p>',
    report.extra && Object.keys(report.extra).length ? `<p><code>${esc(JSON.stringify(report.extra))}</code></p>` : '',
    report.intakeFlags && report.intakeFlags.length
      ? `<p style="color:#B3261E"><b>Intake flags:</b> ${esc(report.intakeFlags.join(', '))}</p>` : '',
    report.descriptionOriginal && report.descriptionOriginal !== report.description
      ? `<p style="color:#666"><i>Original wording:</i> ${esc(report.descriptionOriginal.slice(0, 400))}</p>` : '',
    `<p style="color:#666">Reporter: ${esc(report.reporterEmail ?? '(no email)')}</p>`,
    report.photo && /^https?:/.test(report.photo) ? `<p><a href="${report.photo}">photo</a></p>` : '',
    `<p><a href="${approveUrl}" style="padding:10px 16px;background:#1E7B45;color:#fff;border-radius:6px;text-decoration:none">Approve &amp; submit</a>`
      + `&nbsp;&nbsp;<a href="${rejectUrl}" style="padding:10px 16px;background:#B3261E;color:#fff;border-radius:6px;text-decoration:none">Reject</a></p>`,
    `<p style="color:#888">ref ${esc(report.id)}</p>`,
  ].filter(Boolean).join('');

  let emailed = false;
  try {
    await mailer.send(`[FixMyPVD] Review: ${cat?.label ?? report.category} @ ${report.address}`, html, { kind: 'admin_review', reportId: report.id });
    emailed = true;
  } catch (e) {
    console.error('[hitl] email send failed (report stays in review queue):', e);
  }

  await store.updateReportStatus(
    report.id,
    'awaiting_review',
    emailed ? 'Emailed for approval' : 'Awaiting approval (dashboard)',
  );
  await store.patchReport(report.id, {
    review: { requestedAt: new Date().toISOString(), emailed, mode: env.HITL_MODE },
  });
  console.log(`[hitl] ${report.id} awaiting review${emailed ? ' (emailed)' : ''}`);
}

/** Approve → back to pending so the next tick submits it. Preserves the draft (updateReportStatus only clears it on 'submitted'). */
export async function approve(store: Store, id: string, by: string): Promise<void> {
  const rep = await store.fetchReport(id);
  const now = new Date().toISOString();
  await store.updateReportStatus(id, 'pending', `Approved by ${by}`);
  await store.patchReport(id, {
    approvedAt: now,
    review: { ...(rep?.review ?? {}), decision: 'approved', by, decidedAt: now },
  });
  console.log(`[hitl] ${id} approved by ${by}`);
  await logEvent(store, { level: 'info', kind: 'hitl.approved', msg: `Approved by ${by}`, reportId: id });
}

export interface RejectOpts { reason?: string | null; mailer?: Mailer; env?: Env }

/** Reject → 'rejected'. With a mailer, the reporter gets one short, kind email (optional reason from the reviewer). */
export async function reject(store: Store, id: string, by: string, opts: RejectOpts = {}): Promise<void> {
  const rep = await store.fetchReport(id);
  const now = new Date().toISOString();
  const reason = (opts.reason ?? '').trim().slice(0, 400) || null;
  await store.updateReportStatus(id, 'rejected', `Rejected by ${by}${reason ? `: ${reason}` : ''}`);
  await store.patchReport(id, {
    review: { ...(rep?.review ?? {}), decision: 'rejected', by, decidedAt: now, ...(reason ? { reason } : {}) },
  });
  console.log(`[hitl] ${id} rejected by ${by}`);
  await logEvent(store, { level: 'warn', kind: 'hitl.rejected', msg: `Rejected by ${by}${reason ? `: ${reason}` : ''}`, reportId: id });
  if (opts.mailer && rep?.reporterEmail) {
    const cat = CATEGORIES[rep.category]?.label ?? rep.category;
    const base = (opts.env?.APP_BASE_URL ?? 'https://fixmypvd.org').replace(/\/+$/, '');
    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:0 auto;padding:1.5rem 1rem;color:#1b1b1b">`
      + `<p style="font-size:1.05rem">We didn't send your <b>${esc(cat)}</b> report at <b>${esc(rep.address)}</b> to Providence 311.</p>`
      + (reason ? `<p><b>Why:</b> ${esc(reason)}</p>` : `<p>Usually this means it didn't look like something the city's 311 handles, it was already reported, or it was missing the details the city needs (a photo and a specific address).</p>`)
      + `<p>If we got this wrong, please report it again with a photo and the exact location — a person reviews these, and we'd rather see it twice than miss it.</p>`
      + `<p><a href="${base}/r/${encodeURIComponent(id)}" style="color:#E8622C">Your report</a> · <a href="${base}/" style="color:#E8622C">Report again</a></p>`
      + `<p style="color:#999;font-size:.8rem;margin-top:2rem">FixMyPVD is an independent community project, not affiliated with the City of Providence.</p></div>`;
    await opts.mailer.sendTo(rep.reporterEmail, `[FixMyPVD] We didn't send your ${cat} report`, html, { kind: 'not_sent', reportId: id }).catch((e) => console.error('[hitl] reject email failed:', e));
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
