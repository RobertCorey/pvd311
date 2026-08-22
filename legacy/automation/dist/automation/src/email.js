/** Rob-facing notifications by email (Resend). Inert when RESEND_API_KEY is unset. */
import { createHmac } from 'node:crypto';
import { config } from './config.js';
export const emailEnabled = () => !!config.resendApiKey && !!config.emailTo;
export async function sendEmail(subject, html, text) {
    if (!emailEnabled()) {
        console.log(`[email] (disabled) ${subject}`);
        return null;
    }
    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: config.emailFrom, to: [config.emailTo], subject, html, text: text ?? html.replace(/<[^>]+>/g, '') }),
    });
    const data = (await resp.json().catch(() => ({})));
    if (!resp.ok)
        throw new Error(`Resend ${resp.status}: ${data.message ?? 'send failed'}`);
    return data.id ?? null;
}
/** Fire-and-forget alert; never throws. */
export async function alert(subject, html) {
    try {
        await sendEmail(`[PVD311] ${subject}`, html);
    }
    catch (e) {
        console.error('[email] alert failed:', e);
    }
}
/** Signed approve/reject link for HITL emails (verified by the Worker / server endpoint). */
export function signAction(action, reportId) {
    return createHmac('sha256', config.hitlSecret).update(`${action}:${reportId}`).digest('hex');
}
export function actionUrl(action, reportId) {
    return `${config.hitlBaseUrl}/hitl/${action}?id=${encodeURIComponent(reportId)}&sig=${signAction(action, reportId)}`;
}
