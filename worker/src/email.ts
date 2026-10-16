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
        text: toText(html),
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!resp.ok) { await health(false, `Resend ${resp.status}: ${data.message ?? 'send failed'} (${subject})`); throw new Error(`Resend ${resp.status}: ${data.message ?? 'send failed'}`); }
    await health(true, `admin: ${subject}`);
    return data.id ?? null;
  }

  /** Reporter-facing mail. Never throws. */
  async function sendTo(to: string, subject: string, html: string, opts?: { replyTo?: string }): Promise<void> {
    if (!enabled) { console.log(`[email] (no RESEND_API_KEY) to=${to} ${subject}`); return; }
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.NOTIFY_FROM, to: [to], subject, html, text: toText(html), ...(opts?.replyTo ? { reply_to: opts.replyTo } : {}) }),
      });
      if (!resp.ok) { console.error(`[email] reporter mail failed ${resp.status}`); await health(false, `Resend ${resp.status} (reporter: ${subject})`); }
      else await health(true, `reporter: ${subject}`);
    } catch (e) { console.error('[email] reporter mail error', e); await health(false, e); }
  }

  /** City-facing mail from the relay address (cityask.ts). Threads onto the city's message when we know its Message-ID. Never throws. */
  async function sendAsRelay(o: { to: string; subject: string; text: string; html: string; inReplyTo?: string | null }): Promise<{ ok: boolean; id: string | null; error: string | null }> {
    if (!env.RESEND_API_KEY) { console.log(`[email] (no RESEND_API_KEY) city mail to=${o.to} ${o.subject}`); return { ok: false, id: null, error: 'email disabled' }; }
    const relay = env.RELAY_ADDRESS ?? 'cases@fixmypvd.org';
    const headers = o.inReplyTo ? { 'In-Reply-To': o.inReplyTo, References: o.inReplyTo } : undefined;
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${env.APP_NAME || 'FixMyPVD'} <${relay}>`, to: [o.to], reply_to: relay, subject: o.subject, text: o.text, html: o.html, ...(headers ? { headers } : {}) }),
      });
      const data = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!resp.ok) { const error = `Resend ${resp.status}: ${data.message ?? 'send failed'}`; await health(false, `${error} (city: ${o.subject})`); return { ok: false, id: null, error }; }
      await health(true, `city: ${o.subject}`);
      return { ok: true, id: data.id ?? null, error: null };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await health(false, e);
      return { ok: false, id: null, error };
    }
  }

  /** Fire-and-forget alert; never throws. Subject is prefixed [FixMyPVD]. */
  async function alert(subject: string, html: string): Promise<void> {
    try { await send(`[FixMyPVD] ${subject}`, html); }
    catch (e) { console.error('[email] alert failed:', e); }
  }

  return { send, alert, sendTo, sendAsRelay };
}

/** Plain-text alternative for a small HTML mail: tags → newlines, entities decoded. */
function toText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|blockquote|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
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
