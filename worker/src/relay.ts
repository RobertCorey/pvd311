/**
 * relay.ts — inbound city email → reporter (Cloudflare Email Workers).
 *
 * The portal account's contact address is RELAY_ADDRESS (cases@fixmypvd.org). Cloudflare Email Routing
 * hands every message for it to `email()` in index.ts, which calls handleInbound():
 *
 *   city sender (providenceri.gov, DMARC not failed) + PVD case id that matches a report
 *     → forward the body to the reporter + followers (notify.ts recipients, Reply-To = relay address),
 *       append to report.cityMessages, event relay.forwarded
 *   city sender, no case id / no matching report → Rob (NOTIFY_EMAIL), event relay.unmatched
 *   anyone else (a reporter replying to a forwarded mail, or noise) → Rob, event relay.reply — nothing is
 *       ever sent to the city automatically; a person decides (HITL is launch mode)
 *   auto-replies / our own domain / bounces → dropped, event relay.dropped (loop guard)
 *
 * Privacy holds: the city only ever sees the project account; reporters only ever see updates@fixmypvd.org.
 */
import PostalMime from 'postal-mime';
import type { Env, Store, Mailer, ReportDoc } from './contracts.js';
import { notifyReport } from './notify.js';
import { markOk, markError, logEvent } from './health.js';

export const CASE_ID_RE = /\bPVD\d{4}-\d{4,7}\b/i;
const MAX_STORED = 20;           // cityMessages kept per report
const MAX_TEXT = 4_000;          // chars stored per message
const MAX_FORWARD = 20_000;      // chars forwarded per message

export interface InboundMail {
  from: string;            // bare address, lowercase
  fromName: string | null;
  to: string;              // envelope recipient, lowercase
  subject: string;
  text: string;            // plain text (derived from HTML when the mail has no text part)
  date: string | null;     // ISO
  messageId: string | null;
  autoSubmitted: boolean;  // Auto-Submitted / X-Auto-Response-Suppress / precedence bulk|auto_reply
  dmarc: 'pass' | 'fail' | 'unknown';
  attachments: number;
}

export interface CityMessage { at: string; from: string; subject: string; text: string; caseId: string | null }

/** Minimal shape of Cloudflare's ForwardableEmailMessage that we consume (tests pass a literal). */
export interface InboundMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array> | ArrayBuffer | string;
  rawSize?: number;
}

export type RelayOutcome =
  | { kind: 'forwarded'; caseId: string; reportId: string; recipients: number }
  | { kind: 'unmatched'; caseId: string | null }
  | { kind: 'reply'; caseId: string | null }
  | { kind: 'dropped'; reason: string };

// ── Parsing ───────────────────────────────────────────────────────────────────────────

export async function parseInbound(msg: InboundMessage): Promise<InboundMail> {
  const parsed = await new PostalMime().parse(msg.raw as never);
  const hdr = (name: string) => msg.headers.get(name) ?? parsed.headers.find((h) => h.key === name.toLowerCase())?.value ?? null;
  const text = (parsed.text && parsed.text.trim()) || htmlToText(parsed.html ?? '');
  const auto = (hdr('auto-submitted') ?? '').toLowerCase();
  const precedence = (hdr('precedence') ?? '').toLowerCase();
  const autoSubmitted = (auto !== '' && auto !== 'no') || !!hdr('x-auto-response-suppress') || precedence === 'bulk' || precedence === 'auto_reply' || precedence === 'junk';
  const authRes = (hdr('authentication-results') ?? '').toLowerCase();
  const dmarc: InboundMail['dmarc'] = /dmarc=pass/.test(authRes) ? 'pass' : /dmarc=fail/.test(authRes) ? 'fail' : 'unknown';
  return {
    from: bareAddress(parsed.from?.address ?? msg.from),
    fromName: parsed.from?.name?.trim() || null,
    to: bareAddress(msg.to),
    subject: (parsed.subject ?? hdr('subject') ?? '').replace(/\s+/g, ' ').trim(),
    text: text.replace(/\r\n/g, '\n').trim(),
    date: parsed.date ? new Date(parsed.date).toISOString() : null,
    messageId: parsed.messageId ?? null,
    autoSubmitted,
    dmarc,
    attachments: parsed.attachments?.length ?? 0,
  };
}

export function extractCaseId(...sources: (string | null | undefined)[]): string | null {
  for (const s of sources) {
    const m = s?.match(CASE_ID_RE);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

export function bareAddress(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

export function isCitySender(mail: Pick<InboundMail, 'from' | 'dmarc'>, env: Pick<Env, 'CITY_SENDER_DOMAINS'>): boolean {
  const domains = (env.CITY_SENDER_DOMAINS ?? 'providenceri.gov').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const at = mail.from.lastIndexOf('@');
  if (at < 0) return false;
  const dom = mail.from.slice(at + 1);
  return mail.dmarc !== 'fail' && domains.some((d) => dom === d || dom.endsWith(`.${d}`));
}

/** Strip the city's CRM token and the case id from a subject so the forwarded subject reads cleanly. */
export function cleanSubject(subject: string, caseId: string | null): string {
  let s = subject.replace(/\bPVD311:\d+\b/gi, '');
  if (caseId) s = s.replace(new RegExp(caseId.replace('-', '\\-'), 'gi'), '');
  s = s.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  return s;
}

// ── Handling ──────────────────────────────────────────────────────────────────────────

export async function handleInbound(
  msg: InboundMessage,
  env: Env,
  deps: { store: Store; mailer: Mailer },
): Promise<RelayOutcome> {
  const { store, mailer } = deps;
  const mail = await parseInbound(msg);
  const caseId = extractCaseId(mail.subject, mail.text);
  const ownDomain = (env.RELAY_ADDRESS ?? 'cases@fixmypvd.org').split('@')[1]?.toLowerCase() ?? 'fixmypvd.org';

  // Loop guard: never react to our own mail, auto-responders, or bounces.
  if (mail.from.endsWith(`@${ownDomain}`) || mail.autoSubmitted || /^(mailer-daemon|postmaster|no-?reply)@/.test(mail.from) && !isCitySender(mail, env)) {
    await logEvent(store, { level: 'info', kind: 'relay.dropped', msg: `Dropped ${mail.from}: ${mail.subject}`.slice(0, 200), data: { auto: mail.autoSubmitted } });
    return { kind: 'dropped', reason: mail.autoSubmitted ? 'auto-submitted' : 'own-domain-or-daemon' };
  }

  if (!isCitySender(mail, env)) {
    // A reporter (or anyone) wrote to the relay address — a person handles it; nothing goes to the city.
    await mailer.alert(
      `Reply to relay${caseId ? ` re ${caseId}` : ''} from ${mail.from}`,
      `<p><b>${escHtml(mail.fromName ?? mail.from)}</b> &lt;${escHtml(mail.from)}&gt; wrote to ${escHtml(mail.to)}${caseId ? ` about <b>${escHtml(caseId)}</b>` : ''}. Nothing was sent to the city.</p>`
      + `<p><b>${escHtml(mail.subject || '(no subject)')}</b></p>${quote(mail.text)}`,
    );
    await logEvent(store, { level: 'info', kind: 'relay.reply', msg: `Reply from ${mail.from}${caseId ? ` re ${caseId}` : ''}`, data: { caseId } });
    await markOk(store, 'relay', `reply from ${mail.from}`);
    return { kind: 'reply', caseId };
  }

  const report = caseId ? await store.findByPortalCaseId(caseId).catch(() => null) : null;
  if (!report) {
    await mailer.alert(
      `City email${caseId ? ` for ${caseId}` : ''} — no matching report`,
      `<p>From ${escHtml(mail.from)} to ${escHtml(mail.to)}${caseId ? `, case <b>${escHtml(caseId)}</b> is not one of ours (or the case id was never recorded)` : ', no PVD case id found'}.</p>`
      + `<p><b>${escHtml(mail.subject || '(no subject)')}</b></p>${quote(mail.text)}`,
    );
    await logEvent(store, { level: 'warn', kind: 'relay.unmatched', msg: `City email with no matching report${caseId ? ` (${caseId})` : ''}: ${mail.subject}`.slice(0, 300), data: { caseId, from: mail.from } });
    await markOk(store, 'relay', `unmatched ${caseId ?? '(no id)'}`);
    return { kind: 'unmatched', caseId };
  }

  const recipients = await forwardToReporter(env, store, mailer, report, mail, caseId!);
  return { kind: 'forwarded', caseId: caseId!, reportId: report.id, recipients };
}

async function forwardToReporter(env: Env, store: Store, mailer: Mailer, report: ReportDoc, mail: InboundMail, caseId: string): Promise<number> {
  const at = new Date().toISOString();
  const track = `${(env.APP_BASE_URL ?? 'https://fixmypvd.org').replace(/\/+$/, '')}/r/${report.id}`;
  const subjectTail = cleanSubject(mail.subject, caseId);
  const subject = `Providence 311 on your report ${caseId}${subjectTail ? `: ${subjectTail}` : ''}`;
  const body = mail.text.length > MAX_FORWARD ? `${mail.text.slice(0, MAX_FORWARD)}\n\n[trimmed]` : mail.text;
  const html =
    `<p>The city sent an update on your ${escHtml(report.category.replace(/_/g, ' '))} report at ${escHtml(report.address)} (case <b>${escHtml(caseId)}</b>):</p>`
    + quote(body)
    + (mail.attachments ? `<p style="color:#888">The city's message had ${mail.attachments} attachment${mail.attachments === 1 ? '' : 's'}, which we do not pass along.</p>` : '')
    + `<p><a href="${track}">Track this report</a>. Replying to this email reaches the FixMyPVD team, not the city.</p>`
    + `<p style="color:#888">FixMyPVD is an independent project, not affiliated with the City of Providence. Reply to stop updates.</p>`;

  const recipients = await notifyReport(store, mailer, report, subject, html, { replyTo: env.RELAY_ADDRESS ?? undefined });

  const entry: CityMessage = { at, from: mail.from, subject: mail.subject.slice(0, 300), text: mail.text.slice(0, MAX_TEXT), caseId };
  const prev = (report.cityMessages ?? []).slice(-(MAX_STORED - 1));
  await store.patchReport(report.id, { cityMessages: [...prev, entry], lastCityEmailAt: at }).catch((e) => console.error('[relay] patch failed', e));
  await logEvent(store, { level: 'info', kind: 'relay.forwarded', msg: `City email on ${caseId} forwarded to ${recipients} recipient${recipients === 1 ? '' : 's'}: ${subjectTail || mail.subject}`.slice(0, 300), reportId: report.id, data: { caseId, recipients } });
  await markOk(store, 'relay', `${caseId} → ${recipients}`);
  return recipients;
}

/** Entry point for index.ts: never throws; on failure the raw mail is forwarded to RELAY_FALLBACK_TO so nothing is lost. */
export async function relayEmail(
  message: InboundMessage & { forward?: (to: string) => Promise<unknown> },
  env: Env,
  deps: { store: Store; mailer: Mailer },
): Promise<RelayOutcome | null> {
  try {
    return await handleInbound(message, env, deps);
  } catch (e) {
    console.error('[relay] failed:', e instanceof Error ? e.message : e);
    await markError(deps.store, 'relay', e);
    await logEvent(deps.store, { level: 'error', kind: 'relay.failed', msg: `Inbound mail from ${message.from} failed: ${e instanceof Error ? e.message : String(e)}` });
    const fallback = env.RELAY_FALLBACK_TO;
    if (fallback && message.forward) await message.forward(fallback).catch((e2) => console.error('[relay] fallback forward failed:', e2));
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function quote(text: string): string {
  return `<blockquote style="border-left:3px solid #ccc;margin:12px 0;padding:4px 12px;white-space:pre-wrap">${escHtml(text || '(empty message)')}</blockquote>`;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
