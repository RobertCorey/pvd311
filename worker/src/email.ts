/**
 * Rob-facing notifications by email (Resend REST). Inert when RESEND_API_KEY / NOTIFY_EMAIL are unset.
 * Also the HMAC signing used for HITL approve/reject links (WebCrypto — no node:crypto in Workers).
 */
import type { Env, Mailer } from './contracts.js';

/** Build a Mailer bound to this Worker's env (from NOTIFY_FROM → NOTIFY_EMAIL). */
export function createMailer(env: Env): Mailer {
  const enabled = !!env.RESEND_API_KEY && !!env.NOTIFY_EMAIL;

  async function send(subject: string, html: string): Promise<string | null> {
    if (!enabled) { console.log(`[email] (disabled) ${subject}`); return null; }
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.NOTIFY_FROM,
        to: [env.NOTIFY_EMAIL],
        subject,
        html,
        text: html.replace(/<[^>]+>/g, ''),
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!resp.ok) throw new Error(`Resend ${resp.status}: ${data.message ?? 'send failed'}`);
    return data.id ?? null;
  }

  /** Reporter-facing mail. Gated by REPORTER_EMAIL_ENABLED until the sending domain is verified on Resend
   *  (onboarding@resend.dev can only deliver to the account owner). Never throws. */
  async function sendTo(to: string, subject: string, html: string): Promise<void> {
    if (!enabled || env.REPORTER_EMAIL_ENABLED !== 'true') { console.log(`[email] (reporter mail gated) to=${to} ${subject}`); return; }
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.NOTIFY_FROM, to: [to], subject, html, text: html.replace(/<[^>]+>/g, '') }),
      });
      if (!resp.ok) console.error(`[email] reporter mail failed ${resp.status}`);
    } catch (e) { console.error('[email] reporter mail error', e); }
  }

  /** Fire-and-forget alert; never throws. Subject is prefixed [FixMyPVD]. */
  async function alert(subject: string, html: string): Promise<void> {
    try { await send(`[FixMyPVD] ${subject}`, html); }
    catch (e) { console.error('[email] alert failed:', e); }
  }

  return { send, alert, sendTo };
}

// ── HITL link signing (HMAC-SHA256 hex via WebCrypto) ───────────────────────────────

const enc = new TextEncoder();

/** Sign `${action}:${id}` with HMAC-SHA256, returned as lowercase hex. */
export async function signAction(secret: string, action: 'approve' | 'reject', id: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${action}:${id}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Signed approve/reject link the HITL email embeds; verified by the Worker's /hitl endpoints. */
export async function actionUrl(baseUrl: string, secret: string, action: 'approve' | 'reject', id: string): Promise<string> {
  const sig = await signAction(secret, action, id);
  return `${baseUrl.replace(/\/+$/, '')}/hitl/${action}?id=${encodeURIComponent(id)}&sig=${sig}`;
}

/** Constant-time string compare (both hex of equal length in normal use). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
