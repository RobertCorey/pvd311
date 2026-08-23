/**
 * Rob-facing notifications by email (Resend REST). Inert when RESEND_API_KEY / NOTIFY_EMAIL are unset.
 * Also the HMAC signing used for HITL approve/reject links (WebCrypto — no node:crypto in Workers).
 */
import type { Env, Mailer, Store } from './contracts.js';
import { createStore } from './firestore.js';
import { markOk, markError } from './health.js';

/** Build a Mailer bound to this Worker's env (from NOTIFY_FROM → NOTIFY_EMAIL). */
export function createMailer(env: Env): Mailer {
  const enabled = !!env.RESEND_API_KEY && !!env.NOTIFY_EMAIL;
  let store: Store | null = null;
  const health = (ok: boolean, detail: unknown) => {
    try { store ??= createStore(env); return ok ? markOk(store, 'email', String(detail)) : markError(store, 'email', detail); } catch { return Promise.resolve(); }
  };

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
    if (!resp.ok) { await health(false, `Resend ${resp.status}: ${data.message ?? 'send failed'} (${subject})`); throw new Error(`Resend ${resp.status}: ${data.message ?? 'send failed'}`); }
    await health(true, `admin: ${subject}`);
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
      if (!resp.ok) { console.error(`[email] reporter mail failed ${resp.status}`); await health(false, `Resend ${resp.status} (reporter: ${subject})`); }
      else await health(true, `reporter: ${subject}`);
    } catch (e) { console.error('[email] reporter mail error', e); await health(false, e); }
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

export const HITL_LINK_TTL_MS = 30 * 24 * 3_600_000;

/** Sign `${action}:${id}:${exp}` with HMAC-SHA256, returned as lowercase hex. `exp` = unix seconds the link stops working. */
export async function signAction(secret: string, action: 'approve' | 'reject', id: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${action}:${id}:${exp}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Signed approve/reject link the HITL email embeds; verified by the Worker's /hitl endpoints.
 *  Path form, not ?id=&sig=: a hex sig after "=" forms "=XX" pairs that a quoted-printable mis-decode on the
 *  mail path turns into garbage (seen via Cloudflare Email Routing → Gmail). Expires after HITL_LINK_TTL_MS. */
export async function actionUrl(baseUrl: string, secret: string, action: 'approve' | 'reject', id: string, now = Date.now()): Promise<string> {
  const exp = Math.floor((now + HITL_LINK_TTL_MS) / 1000);
  const sig = await signAction(secret, action, id, exp);
  return `${baseUrl.replace(/\/+$/, '')}/hitl/${action}/${encodeURIComponent(id)}/${exp}/${sig}`;
}

/** Constant-time string compare (both hex of equal length in normal use). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
