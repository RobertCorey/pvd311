/**
 * Human-in-the-loop review + trust ramp.
 *
 * Modes (HITL_MODE):
 *   review — every report needs a tap before it goes to the city (launch mode)
 *   ramp   — a category needs taps until TRUST_RAMP_N of its reports were approved+submitted, then it auto-approves
 *   auto   — nothing waits for a human (goal state; the agent scout still handles unmapped fields)
 *
 * Approvals arrive as Telegram inline-button presses; the dashboard can also approve/reject.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { config } from './config.js';
import { getDb, updateReportStatus, invalidateCache } from './firestore.js';
import { CATEGORIES, type Report } from '../../shared/types.js';
import * as tg from './telegram.js';

export type HitlMode = 'review' | 'ramp' | 'auto';

type R = Report & { id: string };

/** Decide whether this report can go straight to the portal. */
export async function needsHumanApproval(report: R): Promise<boolean> {
  if (report.approvedAt) return false;
  const mode = config.hitlMode;
  if (mode === 'auto') return false;
  if (mode === 'review') return true;
  // ramp: count this category's approved+submitted history
  const snap = await getDb().collection('reports')
    .where('category', '==', report.category)
    .where('status', '==', 'submitted')
    .limit(config.trustRampN).get();
  return snap.size < config.trustRampN;
}

/** Park a report for review and ping the phone. */
export async function requestReview(report: R): Promise<void> {
  const cat = CATEGORIES[report.category];
  const caption = [
    `<b>${escape(cat?.label ?? report.category)}</b> → ${escape(cat?.portalCaseTypeName ?? '')}`,
    escape(report.address),
    report.description ? `“${escape(report.description.slice(0, 300))}”` : '<i>(no description)</i>',
    report.extra && Object.keys(report.extra).length ? `<code>${escape(JSON.stringify(report.extra))}</code>` : '',
    `<i>ref ${report.id}</i>`,
  ].filter(Boolean).join('\n');
  const buttons = [[{ text: '✅ Approve', callback_data: `approve:${report.id}` }, { text: '❌ Reject', callback_data: `reject:${report.id}` }]];

  let messageId: number | null = null;
  if (tg.telegramEnabled()) {
    try {
      messageId = report.photo && /^https?:/.test(report.photo)
        ? await tg.sendPhoto(report.photo, caption, buttons)
        : await tg.sendMessage(caption, buttons);
    } catch (e) {
      console.error('[hitl] Telegram send failed (report stays in review queue):', e);
    }
  }
  await getDb().collection('reports').doc(report.id).update({
    status: 'awaiting_review',
    statusDetail: messageId ? 'Sent to phone for approval' : 'Awaiting approval (dashboard)',
    statusUpdatedAt: FieldValue.serverTimestamp(),
    review: { requestedAt: new Date().toISOString(), telegramMessageId: messageId, mode: config.hitlMode },
  });
  invalidateCache();
  console.log(`[hitl] ${report.id} awaiting review${messageId ? ` (tg msg ${messageId})` : ''}`);
}

export async function approve(reportId: string, by: string): Promise<void> {
  await getDb().collection('reports').doc(reportId).update({
    status: 'pending',
    statusDetail: `Approved by ${by}`,
    statusUpdatedAt: FieldValue.serverTimestamp(),
    approvedAt: new Date().toISOString(),
    'review.decision': 'approved', 'review.by': by, 'review.decidedAt': new Date().toISOString(),
  });
  invalidateCache();
}

export async function reject(reportId: string, by: string): Promise<void> {
  await updateReportStatus(reportId, 'rejected', `Rejected by ${by}`);
  await getDb().collection('reports').doc(reportId).update({
    'review.decision': 'rejected', 'review.by': by, 'review.decidedAt': new Date().toISOString(),
  });
  invalidateCache();
}

// ── Telegram callback polling ───────────────────────────────

let offset = 0;
let offsetLoaded = false;

async function loadOffset(): Promise<void> {
  if (offsetLoaded) return;
  const doc = await getDb().collection('meta').doc('telegram').get().catch(() => null);
  offset = (doc?.data()?.['offset'] as number) || 0;
  offsetLoaded = true;
}

/** Drain pending button presses. Call from the engine's poll tick. */
export async function processCallbacks(): Promise<void> {
  if (!tg.telegramEnabled()) return;
  await loadOffset();
  const updates = await tg.getCallbacks(offset).catch((e: unknown) => { console.error('[hitl] getUpdates failed:', e); return []; });
  for (const u of updates) {
    offset = u.updateId + 1;
    if (String(u.fromId) !== String(config.telegramChatId)) { await tg.answerCallback(u.callbackId, 'Not authorized'); continue; }
    const [action, reportId] = u.data.split(':');
    try {
      if (action === 'approve') { await approve(reportId, 'telegram'); await tg.answerCallback(u.callbackId, 'Approved — submitting'); await tg.editButtons(u.messageId, [[{ text: '✅ Approved', callback_data: 'noop' }]]); }
      else if (action === 'reject') { await reject(reportId, 'telegram'); await tg.answerCallback(u.callbackId, 'Rejected'); await tg.editButtons(u.messageId, [[{ text: '❌ Rejected', callback_data: 'noop' }]]); }
      else await tg.answerCallback(u.callbackId);
    } catch (e) {
      console.error(`[hitl] callback ${u.data} failed:`, e);
      await tg.answerCallback(u.callbackId, 'Error — see dashboard');
    }
  }
  if (updates.length) {
    await getDb().collection('meta').doc('telegram').set({ offset }, { merge: true }).catch(() => {});
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
