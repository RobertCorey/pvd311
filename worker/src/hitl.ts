/**
 * Human-in-the-loop review + trust ramp (Worker port).
 *
 * Modes (env.HITL_MODE):
 *   review — every report needs a tap before it goes to the city (launch mode)
 *   ramp   — a category needs taps until TRUST_RAMP_N of its reports were approved+submitted, then auto-approves
 *   auto   — nothing waits for a human (goal state; the agent scout still handles unmapped fields)
 *
 * Approvals arrive as signed HTTP GETs to /hitl/approve|reject (see index.ts) — no polling.
 */
import type { Env, Mailer, ReportDoc, Store } from './contracts.js';
import { CATEGORIES } from '../../shared/categories.js';
import { actionUrl } from './email.js';
import { accountTrusted } from './me.js';

/** Trust-ramp threshold (env override optional; matches Node config default). */
function trustRampN(env: Env): number {
  const raw = (env as unknown as { TRUST_RAMP_N?: string }).TRUST_RAMP_N;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/** Decide whether this report can go straight to the portal. */
export async function needsHumanApproval(store: Store, env: Env, report: ReportDoc): Promise<boolean> {
  if (report.approvedAt) return false;
  const mode = env.HITL_MODE;
  if (mode === 'auto') return false;
  if (mode === 'review') return true;
  // ramp: per ACCOUNT — the first ACCOUNT_TRUST_N reports of an account are reviewed; after that, a clean
  // history (0 rejected — or admin `trusted`) auto-approves. Accounts are mandatory, so every report has an owner;
  // an ownerless legacy row falls back to the per-category ramp.
  if (report.ownerUid) return !(await accountTrusted(store, report.ownerUid, accountTrustN(env)).catch(() => false));
  const n = trustRampN(env);
  const submitted = await store.countSubmittedByCategory(report.category, n);
  return submitted < n;
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
    report.photo && /^https?:/.test(report.photo) ? `<p><a href="${report.photo}">photo</a></p>` : '',
    `<p><a href="${approveUrl}" style="padding:10px 16px;background:#1E7B45;color:#fff;border-radius:6px;text-decoration:none">Approve &amp; submit</a>`
      + `&nbsp;&nbsp;<a href="${rejectUrl}" style="padding:10px 16px;background:#B3261E;color:#fff;border-radius:6px;text-decoration:none">Reject</a></p>`,
    `<p style="color:#888">ref ${esc(report.id)}</p>`,
  ].filter(Boolean).join('');

  let emailed = false;
  try {
    await mailer.send(`[PVD311] Review: ${cat?.label ?? report.category} @ ${report.address}`, html);
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
}

export async function reject(store: Store, id: string, by: string): Promise<void> {
  const rep = await store.fetchReport(id);
  const now = new Date().toISOString();
  await store.updateReportStatus(id, 'rejected', `Rejected by ${by}`);
  await store.patchReport(id, {
    review: { ...(rep?.review ?? {}), decision: 'rejected', by, decidedAt: now },
  });
  console.log(`[hitl] ${id} rejected by ${by}`);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
