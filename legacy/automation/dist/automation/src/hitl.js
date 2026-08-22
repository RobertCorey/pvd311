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
import { CATEGORIES } from '../../shared/types.js';
import * as tg from './telegram.js';
import { emailEnabled, sendEmail, actionUrl } from './email.js';
/** Decide whether this report can go straight to the portal. */
export async function needsHumanApproval(report) {
    if (report.approvedAt)
        return false;
    const mode = config.hitlMode;
    if (mode === 'auto')
        return false;
    if (mode === 'review')
        return true;
    // ramp: count this category's approved+submitted history
    const snap = await getDb().collection('reports')
        .where('category', '==', report.category)
        .where('status', '==', 'submitted')
        .limit(config.trustRampN).get();
    return snap.size < config.trustRampN;
}
/** Park a report for review and ping the phone. */
export async function requestReview(report) {
    const cat = CATEGORIES[report.category];
    const caption = [
        `<b>${escape(cat?.label ?? report.category)}</b> → ${escape(cat?.portalCaseTypeName ?? '')}`,
        escape(report.address),
        report.description ? `“${escape(report.description.slice(0, 300))}”` : '<i>(no description)</i>',
        report.extra && Object.keys(report.extra).length ? `<code>${escape(JSON.stringify(report.extra))}</code>` : '',
        `<i>ref ${report.id}</i>`,
    ].filter(Boolean).join('\n');
    const buttons = [[{ text: '✅ Approve', callback_data: `approve:${report.id}` }, { text: '❌ Reject', callback_data: `reject:${report.id}` }]];
    let messageId = null;
    let emailed = false;
    if (emailEnabled()) {
        try {
            const html = [
                `<p><b>${escape(cat?.label ?? report.category)}</b> → ${escape(cat?.portalCaseTypeName ?? '')}</p>`,
                `<p>${escape(report.address)}</p>`,
                report.description ? `<blockquote>${escape(report.description.slice(0, 600))}</blockquote>` : '<p><i>(no description)</i></p>',
                report.extra && Object.keys(report.extra).length ? `<p><code>${escape(JSON.stringify(report.extra))}</code></p>` : '',
                report.photo && /^https?:/.test(report.photo) ? `<p><a href="${report.photo}">photo</a></p>` : '',
                `<p><a href="${actionUrl('approve', report.id)}" style="padding:10px 16px;background:#1E7B45;color:#fff;border-radius:6px;text-decoration:none">✅ Approve &amp; submit</a>&nbsp;&nbsp;<a href="${actionUrl('reject', report.id)}" style="padding:10px 16px;background:#B3261E;color:#fff;border-radius:6px;text-decoration:none">❌ Reject</a></p>`,
                `<p style="color:#888">ref ${report.id}</p>`,
            ].join('');
            await sendEmail(`[PVD311] Review: ${cat?.label ?? report.category} @ ${report.address}`, html);
            emailed = true;
        }
        catch (e) {
            console.error('[hitl] email send failed (report stays in review queue):', e);
        }
    }
    if (!emailed && tg.telegramEnabled()) {
        try {
            messageId = report.photo && /^https?:/.test(report.photo)
                ? await tg.sendPhoto(report.photo, caption, buttons)
                : await tg.sendMessage(caption, buttons);
        }
        catch (e) {
            console.error('[hitl] Telegram send failed (report stays in review queue):', e);
        }
    }
    await getDb().collection('reports').doc(report.id).update({
        status: 'awaiting_review',
        statusDetail: emailed ? 'Emailed for approval' : messageId ? 'Sent to phone for approval' : 'Awaiting approval (dashboard)',
        statusUpdatedAt: FieldValue.serverTimestamp(),
        review: { requestedAt: new Date().toISOString(), telegramMessageId: messageId, emailed, mode: config.hitlMode },
    });
    invalidateCache();
    console.log(`[hitl] ${report.id} awaiting review${emailed ? ' (emailed)' : messageId ? ` (tg msg ${messageId})` : ''}`);
}
export async function approve(reportId, by) {
    await getDb().collection('reports').doc(reportId).update({
        status: 'pending',
        statusDetail: `Approved by ${by}`,
        statusUpdatedAt: FieldValue.serverTimestamp(),
        approvedAt: new Date().toISOString(),
        'review.decision': 'approved', 'review.by': by, 'review.decidedAt': new Date().toISOString(),
    });
    invalidateCache();
}
export async function reject(reportId, by) {
    await updateReportStatus(reportId, 'rejected', `Rejected by ${by}`);
    await getDb().collection('reports').doc(reportId).update({
        'review.decision': 'rejected', 'review.by': by, 'review.decidedAt': new Date().toISOString(),
    });
    invalidateCache();
}
// ── Telegram callback polling ───────────────────────────────
let offset = 0;
let offsetLoaded = false;
async function loadOffset() {
    if (offsetLoaded)
        return;
    const doc = await getDb().collection('meta').doc('telegram').get().catch(() => null);
    offset = doc?.data()?.['offset'] || 0;
    offsetLoaded = true;
}
/** Drain pending button presses. Call from the engine's poll tick. */
export async function processCallbacks() {
    if (!tg.telegramEnabled())
        return;
    await loadOffset();
    const updates = await tg.getCallbacks(offset).catch((e) => { console.error('[hitl] getUpdates failed:', e); return []; });
    for (const u of updates) {
        offset = u.updateId + 1;
        if (String(u.fromId) !== String(config.telegramChatId)) {
            await tg.answerCallback(u.callbackId, 'Not authorized');
            continue;
        }
        const [action, reportId] = u.data.split(':');
        try {
            if (action === 'approve') {
                await approve(reportId, 'telegram');
                await tg.answerCallback(u.callbackId, 'Approved — submitting');
                await tg.editButtons(u.messageId, [[{ text: '✅ Approved', callback_data: 'noop' }]]);
            }
            else if (action === 'reject') {
                await reject(reportId, 'telegram');
                await tg.answerCallback(u.callbackId, 'Rejected');
                await tg.editButtons(u.messageId, [[{ text: '❌ Rejected', callback_data: 'noop' }]]);
            }
            else
                await tg.answerCallback(u.callbackId);
        }
        catch (e) {
            console.error(`[hitl] callback ${u.data} failed:`, e);
            await tg.answerCallback(u.callbackId, 'Error — see dashboard');
        }
    }
    if (updates.length) {
        await getDb().collection('meta').doc('telegram').set({ offset }, { merge: true }).catch(() => { });
    }
}
function escape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
