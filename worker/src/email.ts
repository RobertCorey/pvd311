/**
 * Rob-facing notifications by email (Resend REST). Inert when RESEND_API_KEY / NOTIFY_EMAIL are unset.
 * Also the HMAC signing used for HITL approve/reject links (WebCrypto — no node:crypto in Workers).
 */
import type { Env, Mailer, Store } from './contracts.js';
import { createStore } from './firestore.js';
import { markOk, markError } from './health.js';
import { inferKind, logEmail, newOutId, record, toText, type EmailKind, type EmailMeta } from './emaillog.js';

/** Build a Mailer bound to this Worker's env (from NOTIFY_FROM → NOTIFY_EMAIL). */
export function createMailer(env: Env): Mailer {
  const enabled = !!env.RESEND_API_KEY && !!env.NOTIFY_EMAIL;
  let store: Store | null = null;
  const getStore = () => { try { return (store ??= createStore(env)); } catch { return null; } };
  const health = (ok: boolean, detail: unknown) => {
    const st = getStore();
    if (!st) return Promise.resolve();
    return (ok ? markOk(st, 'email', String(detail)) : markError(st, 'email', detail)).catch(() => {});
  };

  /** One Resend send, logged to emails/{id} whatever happens (emaillog.ts). Never throws. */
  async function deliver(o: { from: string; to: string; subject: string; html: string; text?: string; replyTo?: string | null; headers?: Record<string, string> }, kind: EmailKind, meta: EmailMeta | undefined, label: string): Promise<{ ok: boolean; id: string | null; error: string | null }> {
    const at = new Date().toISOString();
    const text = o.text ?? toText(o.html);
    const log = (status: 'sent' | 'failed' | 'skipped', id: string | null, error: string | null) => logEmail(getStore(), record({
      id: newOutId(id), at, dir: 'out', kind: meta?.kind ?? kind, from: o.from, to: [o.to], subject: o.subject, text, status, error, resendId: id,
      // lastEvent left out (undefined → not written): the delivery webhook can land before this write and must not be erased
      lastEvent: undefined, reportId: meta?.reportId ?? null, caseId: meta?.caseId ?? null, replyTo: o.replyTo ?? null, source: 'live',
    }));
    if (!env.RESEND_API_KEY) { console.log(`[email] (no RESEND_API_KEY) to=${o.to} ${o.subject}`); await log('skipped', null, 'email disabled'); return { ok: false, id: null, error: 'email disabled' }; }
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: o.from, to: [o.to], subject: o.subject, html: o.html, text, ...(o.replyTo ? { reply_to: o.replyTo } : {}), ...(o.headers ? { headers: o.headers } : {}) }),
      });
      const data = (await resp.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!resp.ok) {
        const error = `Resend ${resp.status}: ${data.message ?? 'send failed'}`;
        await health(false, `${error} (${label}: ${o.subject})`);
        await log('failed', null, error);
        return { ok: false, id: null, error };
      }
      await health(true, `${label}: ${o.subject}`);
      await log('sent', data.id ?? null, null);
      return { ok: true, id: data.id ?? null, error: null };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await health(false, e);
      await log('failed', null, error);
      return { ok: false, id: null, error };
    }
  }

  /** Admin mail (to NOTIFY_EMAIL). Throws on a failed send (callers that must not throw use alert()). */
  async function send(subject: string, html: string, meta?: EmailMeta): Promise<string | null> {
    if (!enabled) { console.log(`[email] (disabled) ${subject}`); return null; }
    const r = await deliver({ from: env.NOTIFY_FROM, to: env.NOTIFY_EMAIL, subject, html }, inferKind(subject, [env.NOTIFY_EMAIL.toLowerCase()], env), meta, 'admin');
    if (!r.ok) throw new Error(r.error ?? 'send failed');
    return r.id;
  }

  /** Reporter-facing mail. Never throws. */
  async function sendTo(to: string, subject: string, html: string, opts?: { replyTo?: string } & EmailMeta): Promise<void> {
    if (!enabled) { console.log(`[email] (no RESEND_API_KEY) to=${to} ${subject}`); return; }
    const r = await deliver({ from: env.NOTIFY_FROM, to, subject, html, replyTo: opts?.replyTo ?? null }, inferKind(subject, [to.toLowerCase()], env), opts, 'reporter');
    if (!r.ok) console.error(`[email] reporter mail failed: ${r.error}`);
  }

  /** City-facing mail from the relay address (cityask.ts). Threads onto the city's message when we know its Message-ID. Never throws. */
  async function sendAsRelay(o: { to: string; subject: string; text: string; html: string; inReplyTo?: string | null } & EmailMeta): Promise<{ ok: boolean; id: string | null; error: string | null }> {
    const relay = env.RELAY_ADDRESS ?? 'cases@fixmypvd.org';
    const headers = o.inReplyTo ? { 'In-Reply-To': o.inReplyTo, References: o.inReplyTo } : undefined;
    return deliver({ from: `${env.APP_NAME || 'FixMyPVD'} <${relay}>`, to: o.to, subject: o.subject, html: o.html, text: o.text, replyTo: relay, headers }, 'to_city', { kind: o.kind ?? 'to_city', reportId: o.reportId, caseId: o.caseId }, 'city');
  }

  /** Fire-and-forget alert; never throws. Subject is prefixed [FixMyPVD]. */
  async function alert(subject: string, html: string, meta?: EmailMeta): Promise<void> {
    try { await send(`[FixMyPVD] ${subject}`, html, meta); }
    catch (e) { console.error('[email] alert failed:', e); }
  }

  return { send, alert, sendTo, sendAsRelay };
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
