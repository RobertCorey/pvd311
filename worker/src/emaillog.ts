/**
 * emaillog.ts — one record per email, in or out (Rob, 2026-10-16: "I want to look at the system from different angles"
 * — by user, by report, by email). Firestore `emails/{id}`, admin-only, kept EMAIL_RETENTION_DAYS.
 *
 *   out: every Mailer send (email.ts logs it) — kind, recipients, subject, plain text,
 *        Resend id + delivery state (last_event, refreshed when the email is opened in /admin and by the daily sync)
 *   in:  every message relay.ts handles — city mail (matched or not), replies, drops — with what we did with it
 *
 * Each record carries reportId / caseId when it is about a report and `addrs` (every address on it, lowercased) so a
 * person's mail is one array-contains query. Ids: `rs_<resend id>` for anything Resend sent (so a live record and the
 * Resend import never duplicate), `in_<hash>` for inbound. Sign-in link emails are never logged (Rob, 2026-10-17: "we
 * don't need sign in link messages"); HITL action links are cut from stored text — the log never holds a working credential.
 */
import type { Env, Store } from './contracts.js';

export const EMAIL_RETENTION_DAYS = 60;
const TEXT_CAP = 20_000;

export type EmailKind =
  // to reporters / followers
  | 'signin_link' | 'filed' | 'status' | 'city_copy' | 'ask' | 'ask_reminder' | 'answer_receipt' | 'not_sent' | 'street_digest' | 'reporter_other'
  // to the city
  | 'to_city'
  // to you
  | 'admin_review' | 'admin_alert' | 'admin_digest'
  // inbound
  | 'city_in' | 'reply_in' | 'unmatched_in' | 'dropped_in';

export interface EmailMeta { kind?: EmailKind; reportId?: string | null; caseId?: string | null }

export interface EmailRecord {
  id: string;
  at: string;                 // ISO
  dir: 'in' | 'out';
  kind: EmailKind;
  from: string;
  to: string[];
  addrs: string[];            // from + to, lowercased (array-contains: a person's mail)
  subject: string;
  text: string | null;        // plain text, links redacted; null until fetched (Resend import)
  status: 'sent' | 'failed' | 'skipped' | 'received' | 'dropped';
  error?: string | null;
  resendId?: string | null;
  lastEvent?: string | null;  // Resend: delivered / bounced / complained / opened / clicked / sent …
  lastEventAt?: string | null;
  reportId?: string | null;
  caseId?: string | null;
  replyTo?: string | null;
  messageId?: string | null;
  cityKind?: string | null;   // inbound city mail: receipt / routed / ask / update (cityask.ts)
  outcome?: string | null;    // inbound: what relay.ts did (forwarded, answer sent, to Rob, dropped …)
  source: 'live' | 'import';
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────

export function bare(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

/** HTML → plain text for the log (and the plain-text part of our mail). */
export function toText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|blockquote|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cut working credentials out of stored text: Firebase sign-in links and signed HITL approve/reject links. */
export function redact(text: string): string {
  return text
    .replace(/https?:\/\/\S*(?:oobCode=|__\/auth\/action|\/hitl\/(?:approve|reject)\/)\S*/gi, '[link removed]')
    .slice(0, TEXT_CAP);
}

export const CASE_RE = /\bPVD\d{4}-\d{4,7}\b/i;
export const caseIdIn = (...s: (string | null | undefined)[]): string | null => {
  for (const x of s) { const m = x?.match(CASE_RE); if (m) return m[0].toUpperCase(); }
  return null;
};

/** What an outbound email is, from its subject — for the Resend import and for sends without a kind. */
export function inferKind(subject: string, to: string[], env: Pick<Env, 'NOTIFY_EMAIL'> & { RELAY_ADDRESS?: string; CITY_SENDER_DOMAINS?: string }): EmailKind {
  const s = subject.toLowerCase();
  const admin = (env.NOTIFY_EMAIL ?? '').toLowerCase();
  const city = (env.CITY_SENDER_DOMAINS ?? 'providenceri.gov').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (to.some((a) => city.some((d) => a.endsWith(`@${d}`) || a.endsWith(`.${d}`)))) return 'to_city';
  if (/sign-in link|enlace para entrar/.test(s)) return 'signin_link';
  if (s.startsWith('[fixmypvd] review:')) return 'admin_review';
  if (s.startsWith('[fixmypvd] daily digest')) return 'admin_digest';
  if (s.startsWith("[fixmypvd] we didn't send your")) return 'not_sent';
  if (s.startsWith('[fixmypvd]') || (admin && to.includes(admin))) return 'admin_alert';
  if (s.startsWith('your report was filed with providence 311')) return 'filed';
  if (s.startsWith('providence 311 on your report')) return 'city_copy';
  if (s.startsWith('reminder: the city is waiting')) return 'ask_reminder';
  if (s.startsWith('the city needs more information')) return 'ask';
  if (/your answer|answer the city on your tracking page/.test(s)) return 'answer_receipt';
  if (s.startsWith('this week near ')) return 'street_digest';
  if (/^(the city|a city department)\b/.test(s)) return 'status';
  if (/^your report pvd\d{4}-\d+ (has been|was|is)\b/.test(s)) return 'status'; // the Aug–Oct 2026 status wording
  return 'reporter_other';
}

/** Stable id for an inbound message (relay.ts and the cityMessages import agree on it). */
export function inboundId(parts: (string | null | undefined)[]): string {
  const s = parts.map((p) => p ?? '').join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  let h2 = 0x01000193;
  for (let i = s.length - 1; i >= 0; i--) { h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x811c9dc5) >>> 0; }
  return `in_${h.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function newOutId(resendId: string | null | undefined): string {
  if (resendId) return `rs_${resendId}`;
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `out_${Date.now().toString(36)}_${rnd}`;
}

export function record(r: Omit<EmailRecord, 'addrs'> & { addrs?: string[] }): EmailRecord {
  const to = r.to.map(bare).filter(Boolean);
  const from = bare(r.from);
  return { ...r, from, to, addrs: [...new Set([from, ...to].filter(Boolean))], text: r.text == null ? null : redact(r.text) };
}

/** Kinds the log leaves out entirely: sign-in link emails (Rob, 2026-10-17: "we don't need sign in link messages"). */
export const UNLOGGED_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>(['signin_link']);

/** Write one record (false: a kind the log leaves out). Never throws — a log write must never break a send. */
export async function logEmail(store: Pick<Store, 'putEmail'> | null | undefined, r: EmailRecord): Promise<boolean> {
  if (!store || UNLOGGED_KINDS.has(r.kind)) return false;
  try { await store.putEmail(r); return true; } catch (e) { console.error('[emaillog] write failed:', e instanceof Error ? e.message : e); return false; }
}

// ── Resend: import what it sent, refresh delivery state ─────────────────────────────

interface ResendListItem { id: string; to: string[]; from: string; created_at: string; subject: string; last_event?: string | null; reply_to?: string[] | null }
interface ResendEmail extends ResendListItem { html?: string | null; text?: string | null }

const resendIso = (s: string) => {
  const t = Date.parse(s.replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
};

/** Reads need a full-access Resend key; the Worker's key is send-only by design → `unreadable`, not an error.
 *  Delivery state then arrives by webhook (handleResendWebhook) and history by the one-off import script. */
class ResendUnreadable extends Error {}
async function resendGet<T>(env: Pick<Env, 'RESEND_API_KEY'>, path: string): Promise<T | null> {
  if (!env.RESEND_API_KEY) return null;
  const r = await fetch(`https://api.resend.com${path}`, { headers: { authorization: `Bearer ${env.RESEND_API_KEY}` } });
  if (r.status === 401 || r.status === 403) throw new ResendUnreadable(`Resend ${r.status} on ${path}`);
  if (!r.ok) throw new Error(`Resend ${r.status} on ${path}`);
  return (await r.json()) as T;
}

/** One email's body + delivery state from Resend, redacted. Null when Resend has none / no key. */
export async function fetchResendEmail(env: Pick<Env, 'RESEND_API_KEY'>, resendId: string): Promise<{ text: string | null; lastEvent: string | null } | null> {
  const e = await resendGet<ResendEmail>(env, `/emails/${encodeURIComponent(resendId)}`).catch((err) => { if (err instanceof ResendUnreadable) return null; throw err; });
  if (!e) return null;
  const text = (e.text && e.text.trim()) || (e.html ? toText(e.html) : '');
  return { text: text ? redact(text) : null, lastEvent: e.last_event ?? null };
}

/**
 * Import Resend's sent mail we have no record of (the history before the log existed, or a send that bypassed the
 * Mailer) and refresh delivery state on the ones we have. Bodies are fetched lazily when opened. Matches a case id
 * in the subject to our report. Bounded by `maxPages` × 100.
 */
export async function syncFromResend(
  env: Env, store: Store, opts: { maxPages?: number; now?: Date } = {},
): Promise<{ scanned: number; imported: number; updated: number; unreadable?: boolean }> {
  const out: { scanned: number; imported: number; updated: number; unreadable?: boolean } = { scanned: 0, imported: 0, updated: 0 };
  if (!env.RESEND_API_KEY) return out;
  try { await syncPages(env, store, opts, out); }
  catch (e) { if (e instanceof ResendUnreadable) out.unreadable = true; else throw e; }
  return out;
}

async function syncPages(env: Env, store: Store, opts: { maxPages?: number; now?: Date }, out: { scanned: number; imported: number; updated: number }): Promise<void> {
  const now = (opts.now ?? new Date()).toISOString();
  const reportByCase = new Map<string, string | null>();
  let after = '';
  for (let page = 0; page < (opts.maxPages ?? 10); page++) {
    const r = await resendGet<{ data: ResendListItem[]; has_more?: boolean }>(env, `/emails?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    const items = r?.data ?? [];
    for (const it of items) {
      out.scanned++;
      const id = newOutId(it.id);
      const have = await store.getEmail(id).catch(() => null);
      if (have) {
        if ((it.last_event ?? null) !== (have.lastEvent ?? null)) {
          await store.patchEmail(id, { lastEvent: it.last_event ?? null, lastEventAt: now });
          out.updated++;
        }
        continue;
      }
      const to = (it.to ?? []).map(bare);
      const caseId = caseIdIn(it.subject);
      let reportId: string | null = null;
      if (caseId) {
        if (!reportByCase.has(caseId)) reportByCase.set(caseId, (await store.findByPortalCaseId(caseId).catch(() => null))?.id ?? null);
        reportId = reportByCase.get(caseId) ?? null;
      }
      const stored = await logEmail(store, record({
        id, at: resendIso(it.created_at), dir: 'out', kind: inferKind(it.subject ?? '', to, env), from: it.from, to, subject: it.subject ?? '', text: null,
        status: 'sent', resendId: it.id, lastEvent: it.last_event ?? null, lastEventAt: now, reportId, caseId,
        replyTo: it.reply_to?.[0] ?? null, source: 'import',
      }));
      if (stored) out.imported++;
    }
    if (!r?.has_more || !items.length) break;
    after = items[items.length - 1].id;
  }
}

// ── Resend webhook: delivery state pushed to us (svix-signed) ─────────────────────

/** How far along a delivery state is; a late "sent" never overwrites "delivered", a bounce always wins. */
const STATE_RANK: Record<string, number> = { sent: 1, delivery_delayed: 2, delivered: 3, opened: 4, clicked: 5, bounced: 9, complained: 9, failed: 9 };

/** Svix signature (what Resend signs webhooks with): v1 = base64 HMAC-SHA256(secret, `${id}.${timestamp}.${body}`), ±5 min. */
export async function verifyResendWebhook(secret: string, headers: Headers, body: string, nowMs = Date.now()): Promise<boolean> {
  const id = headers.get('svix-id'); const ts = headers.get('svix-timestamp'); const sig = headers.get('svix-signature');
  if (!id || !ts || !sig || !Number.isFinite(Number(ts)) || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const raw = atob(secret.replace(/^whsec_/, ''));
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(raw, (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  const want = btoa(String.fromCharCode(...mac));
  return sig.split(' ').some((part) => {
    const [v, s] = part.split(',');
    if (v !== 'v1' || !s || s.length !== want.length) return false;
    let d = 0; for (let i = 0; i < s.length; i++) d |= s.charCodeAt(i) ^ want.charCodeAt(i);
    return d === 0;
  });
}

interface ResendWebhook { type?: string; created_at?: string; data?: { email_id?: string; from?: string; to?: string[]; subject?: string; created_at?: string } }

/** POST /hooks/resend — delivery events. Updates the email's state; an email the log never saw is recorded from the event. */
export async function handleResendWebhook(request: Request, env: Env, store: Store): Promise<Response> {
  const secret = (env as unknown as { RESEND_WEBHOOK_SECRET?: string }).RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response('not configured', { status: 503 });
  const body = await request.text();
  if (!(await verifyResendWebhook(secret, request.headers, body))) return new Response('bad signature', { status: 401 });
  let ev: ResendWebhook;
  try { ev = JSON.parse(body) as ResendWebhook; } catch { return new Response('bad json', { status: 400 }); }
  const state = (ev.type ?? '').replace(/^email\./, '');
  const resendId = ev.data?.email_id;
  if (!resendId || !(state in STATE_RANK)) return new Response('ignored', { status: 200 });
  const id = newOutId(resendId);
  const at = ev.created_at ? resendIso(ev.created_at) : new Date().toISOString();
  const have = await store.getEmail(id).catch(() => null);
  if (have) {
    if ((STATE_RANK[state] ?? 0) >= (STATE_RANK[have.lastEvent ?? ''] ?? 0)) await store.patchEmail(id, { lastEvent: state, lastEventAt: at });
  } else {
    const to = (ev.data?.to ?? []).map(bare);
    const subject = ev.data?.subject ?? '';
    const caseId = caseIdIn(subject);
    const reportId = caseId ? (await store.findByPortalCaseId(caseId).catch(() => null))?.id ?? null : null;
    await logEmail(store, record({
      id, at: ev.data?.created_at ? resendIso(ev.data.created_at) : at, dir: 'out', kind: inferKind(subject, to, env), from: ev.data?.from ?? '', to, subject,
      text: null, status: 'sent', resendId, lastEvent: state, lastEventAt: at, reportId, caseId, source: 'import',
    }));
  }
  return new Response('ok', { status: 200 });
}

/** City mail already stored on reports (cityMessages) → inbound records, for the time before the log existed. */
export async function importCityMessages(env: Env, store: Store, reports: { id: string; portalCaseId?: string | null; cityMessages?: { at: string; from: string; subject: string; text: string; caseId: string | null; kind?: string; messageId?: string | null }[] | null }[]): Promise<number> {
  let n = 0;
  const to = env.RELAY_ADDRESS ?? 'cases@fixmypvd.org';
  for (const r of reports) {
    for (const m of r.cityMessages ?? []) {
      if (!m?.at) continue;
      const id = inboundId([r.id, m.at, m.subject]);
      if (await store.getEmail(id).catch(() => null)) continue;
      await logEmail(store, record({
        id, at: m.at, dir: 'in', kind: 'city_in', from: m.from, to: [to], subject: m.subject ?? '', text: m.text ?? '', status: 'received',
        reportId: r.id, caseId: m.caseId ?? r.portalCaseId ?? null, messageId: m.messageId ?? null, cityKind: m.kind ?? null,
        outcome: 'forwarded to the reporter', source: 'import',
      }));
      n++;
    }
  }
  return n;
}
