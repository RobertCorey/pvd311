/**
 * cityask.ts — the city asks the reporter for more information; the reporter answers; we pass the answer back.
 * No person in the loop (Rob, 2026-10-16: "a solution that doesn't involve my intervention").
 *
 * 1. Classify every city email (relay.ts, at arrival) and portal timeline note (watcher, from the stored snapshot):
 *      receipt — the Constituent Service Hub ack ("successfully received and logged")
 *      routed  — "received and routed for review and action", with its "Department Assigned:" line
 *      ask     — the city needs something from the resident ("needs more information", "please respond to this email by
 *                providing …", …). Rules first; a non-template staff email is read by the AI only to answer "does this
 *                ask the resident for something?" — its words are never rewritten.
 *      update  — everything else (referrals, staff updates)
 * 2. An ask is recorded once on report.cityAsks (the same ask seen as an email AND a portal note within 6 h is one ask)
 *    and mailed to the reporter (owner) only — "reply to this email or answer on the tracking page", Reply-To = relay.
 *    Followers get the usual relayed copy. One reminder at 48 h. An ask found late (> 7 days) or on a closed case is
 *    recorded without mail.
 * 3. The answer — POST /api/reports/:id/answer (signed-in owner) or the owner's email reply (relay.ts: sender = the
 *    owner's address, DMARC pass) — is checked (moderation blocks spam/abuse only), then mailed to the city FROM the
 *    portal account's contact address (RELAY_ADDRESS) as "RE: <the city's subject>", which keeps the city CRM's token
 *    (PVD311:nnnnnnn) that threads it onto the case. ≤ 3 answers per ask, 60 s apart; answerable while the case is
 *    open and for 14 days.
 *
 * The city's words are shown verbatim; ours stay neutral (see notify.ts / api.ts).
 */
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES } from '../../shared/categories.js';
import type { CityAsk, CityAskAnswer, CityMailKind } from '../../shared/types.js';
import { TERMINAL_PORTAL_STATUS, type Env, type Mailer, type ReportDoc, type Store } from './contracts.js';
import { moderate } from './moderation.js';
import { logEvent } from './health.js';

export const ASK_ANSWERABLE_MS = 14 * 24 * 3_600_000;  // an ask stays answerable this long (and only while the case is open)
export const ASK_NOTIFY_MAX_AGE_MS = 7 * 24 * 3_600_000; // an ask found later than this is recorded, not mailed
export const ASK_REMIND_AFTER_MS = 48 * 3_600_000;
export const ASK_SAME_WINDOW_MS = 6 * 3_600_000;       // one ask seen as an email and as a portal note
export const ASK_SETTLE_MS = 10 * 60_000;              // the watcher leaves a just-arrived email to relay.ts
export const MAX_ANSWERS_PER_ASK = 3;
export const ANSWER_MIN_GAP_MS = 60_000;
export const ANSWER_MAX_CHARS = 2_000;
const MAX_ASKS_STORED = 10;
const DEFAULT_CITY_REPLY = 'pvd311@providenceri.gov';

type CityMsg = NonNullable<ReportDoc['cityMessages']>[number];

// ── Classification ────────────────────────────────────────────────────────────────────

/** Sentences that ask the resident for something. Matched per sentence, after the receipt/routed templates. */
const ASK_SENTENCE: RegExp[] = [
  /\b(?:please|kindly)\s+(?:respond|reply)\s+to\s+this\s+(?:e-?mail|message)\s+(?:by\s+providing|with)\b/,
  /\bdid\s+not\s+provide\s+(?:the\s+)?(?:important|required|necessary|enough|sufficient)?\s*information\b/,
  /\b(?:we|i)\s+(?:need|require)\s+(?:some\s+)?(?:more|additional|further)\s+(?:information|details)\b/,
  /\b(?:could|can|would)\s+you\s+(?:please\s+)?(?:provide|send|clarify|confirm|tell\s+us|let\s+us\s+know)\b/,
  /\bplease\s+(?:provide|send|clarify|confirm)\s+(?:us\s+)?(?:with\s+)?(?:the|a|an|more|additional|your|which|where|what|when|a\s+photo)\b/,
];
const NOT_AN_ASK = /\b(?:survey|feedback|rate\s+(?:our|your)|how\s+did\s+we\s+do)\b/;

/** The city's template ("Department Assigned: DPW Sewer"), verbatim minus invisible characters. */
function departmentAssigned(text: string): string | null {
  const m = text.replace(/﻿/g, '').match(/Department Assigned:[ \t]*([^\n]+)/i);
  const dept = m?.[1].replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '') ?? '';
  return /[a-z]/i.test(dept) ? dept.slice(0, 80) : null;
}

/** Rules only — pure, deterministic. */
export function classifyCityMail(subject: string, text: string): { kind: CityMailKind; dept: string | null } {
  const body = text.replace(/﻿/g, '');
  const all = `${subject}\n${body}`.replace(/\s+/g, ' ').toLowerCase();
  if (/\bneeds? more information\b/.test(subject.toLowerCase())) return { kind: 'ask', dept: null };
  if (/successfully received and logged/.test(all)) return { kind: 'receipt', dept: null };
  if (/received and routed for review and action/.test(all)) return { kind: 'routed', dept: departmentAssigned(body) };
  const sentences = all.split(/(?<=[.?!])\s+|\n/);
  if (sentences.some((s) => !NOT_AN_ASK.test(s) && ASK_SENTENCE.some((re) => re.test(s)))) return { kind: 'ask', dept: null };
  return { kind: 'update', dept: departmentAssigned(body) };
}

const AI_SYSTEM = `You read one email that Providence's 311 office sent about a resident's service request.
Decide whether the city is asking the resident to send information or answer a question before it can act on the request (asksResident = true).
Acknowledgements, status updates, referrals to another department, closure notices, survey or feedback requests, and generic "call 311 if you have questions" lines are NOT asks (false).`;
const AI_TOOL: Anthropic.Tool = {
  name: 'classify',
  description: 'Record whether the email asks the resident for something.',
  input_schema: { type: 'object', additionalProperties: false, required: ['asksResident'], properties: { asksResident: { type: 'boolean' } } },
};

/** AI read of a non-template staff email: does it ask the resident for something? null when unavailable (no key, error). */
export async function aiAsksResident(env: Pick<Env, 'ANTHROPIC_API_KEY'>, subject: string, text: string): Promise<boolean | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    // Bounded: this runs inside the inbound-email handler.
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 15_000, maxRetries: 1 });
    const r = await client.messages.create({
      model: 'claude-opus-5', max_tokens: 1024, output_config: { effort: 'low' }, system: AI_SYSTEM, tools: [AI_TOOL], tool_choice: { type: 'tool', name: 'classify' },
      messages: [{ role: 'user', content: JSON.stringify({ subject: subject.slice(0, 300), body: text.slice(0, 4_000) }) }],
    });
    const block = r.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const v = (block?.input as { asksResident?: unknown } | undefined)?.asksResident;
    return typeof v === 'boolean' ? v : null;
  } catch (e) {
    console.error('[cityask] AI classify failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** relay.ts: rules, then the AI only for an 'update' (a non-template staff email). */
export async function classifyInbound(env: Pick<Env, 'ANTHROPIC_API_KEY'>, subject: string, text: string): Promise<{ kind: CityMailKind; dept: string | null; by: 'rule' | 'ai' }> {
  const rule = classifyCityMail(subject, text);
  if (rule.kind !== 'update') return { ...rule, by: 'rule' };
  const ai = await aiAsksResident(env, subject, text);
  return ai ? { kind: 'ask', dept: rule.dept, by: 'ai' } : { ...rule, by: 'rule' };
}

/** Stored mail carries its kind from arrival; older rows are classified by the rules on read. */
export function mailKind(m: Pick<CityMsg, 'subject' | 'text' | 'kind'>): CityMailKind {
  return m.kind ?? classifyCityMail(m.subject ?? '', m.text ?? '').kind;
}

/** The city's words for display: drop inline-image placeholder lines, invisible characters and "<mailto:…>" echoes. */
export function cityText(text: string): string {
  return text.replace(/﻿/g, '').replace(/<mailto:[^>\s]+>/gi, '')
    .split('\n').filter((l) => !/^\s*\[cid:[^\]]*\]\s*$/i.test(l)).join('\n')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Asks on a report ──────────────────────────────────────────────────────────────────

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** The portal renders note times as "10/16/2026 3:53 PM" in UTC (matches the relayed email's Date). */
export function parseNoteTime(s: string | null | undefined): string | null {
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (/pm/i.test(m[6])) h += 12;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]))).toISOString();
}

type AskCandidate = Omit<CityAsk, 'notifiedAt' | 'answers' | 'remindedAt'>;

/** Stored mail carries its kind/department from arrival; older rows get both from the rules on read. */
export function mailInfo(m: Pick<CityMsg, 'subject' | 'text' | 'kind' | 'dept'>): { kind: CityMailKind; dept: string | null } {
  if (m.kind) return { kind: m.kind, dept: m.dept ?? null };
  return classifyCityMail(m.subject ?? '', m.text ?? '');
}

/** One ask per real question: the email copy wins over the same ask's portal note (it carries the city's subject — the CRM
 *  token that threads an answer — its sender and Message-ID). Oldest first. */
export function dedupeAsks<T extends Pick<CityAsk, 'id' | 'at' | 'source'>>(cands: T[]): T[] {
  const kept: T[] = [];
  for (const c of [...cands].sort((a, b) => (a.source === b.source ? 0 : a.source === 'email' ? -1 : 1) || a.at.localeCompare(b.at))) {
    if (!kept.some((k) => sameAsk(k, c))) kept.push(c);
  }
  return kept.sort((a, b) => a.at.localeCompare(b.at));
}

/** Every ask the stored city mail and portal notes contain, oldest first. Own notes (our account's comments) never count. */
export function askCandidates(report: Pick<ReportDoc, 'cityMessages' | 'portalDetail'>, selfName = 'FixMyPVD'): AskCandidate[] {
  const out: AskCandidate[] = [];
  for (const m of report.cityMessages ?? []) {
    if (!m?.at || mailKind(m) !== 'ask') continue;
    out.push({ id: hash(`email|${m.at}|${m.subject}`), at: m.at, source: 'email', from: m.from || null, subject: m.subject ?? '', text: cityText(m.text ?? ''), messageId: m.messageId ?? null, by: m.by ?? 'rule' });
  }
  const self = selfName.toLowerCase();
  for (const n of report.portalDetail?.notes ?? []) {
    if (self && n.from.toLowerCase().includes(self)) continue;
    if (classifyCityMail('', n.text).kind !== 'ask') continue;
    const at = parseNoteTime(n.modifiedOn ?? n.postedOn) ?? report.portalDetail?.capturedAt ?? null;
    if (!at) continue;
    out.push({ id: hash(`portal|${at}|${n.text.slice(0, 200)}`), at, source: 'portal', from: null, subject: '', text: cityText(n.text), messageId: null, by: 'rule' });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function sameAsk(a: Pick<CityAsk, 'id' | 'at' | 'source'>, b: Pick<CityAsk, 'id' | 'at' | 'source'>): boolean {
  if (a.id === b.id) return true;
  return a.source !== b.source && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= ASK_SAME_WINDOW_MS;
}

const isTerminal = (r: Pick<ReportDoc, 'portalStatus'>) => TERMINAL_PORTAL_STATUS.test(r.portalStatus ?? '');
export const sentAnswers = (a: CityAsk) => (a.answers ?? []).filter((x) => x.status === 'sent');

/** Can the owner still answer this ask? `open` = answerable and not answered yet (the "waiting on you" state). */
export function askState(ask: CityAsk, report: Pick<ReportDoc, 'portalStatus' | 'status'>, now = Date.now()): { answerable: boolean; open: boolean; expiresAt: string } {
  const expires = Date.parse(ask.at) + ASK_ANSWERABLE_MS;
  // 'processing': the city's mail can beat the engine's 'submitted' write by seconds (relay.ts findReport).
  const filed = report.status === 'submitted' || report.status === 'processing';
  const answerable = filed && !isTerminal(report) && now < expires && sentAnswers(ask).length < MAX_ANSWERS_PER_ASK;
  return { answerable, open: answerable && sentAnswers(ask).length === 0, expiresAt: new Date(expires).toISOString() };
}

/** The report's recorded asks — or, before the watcher has recorded them, the asks its stored mail/notes contain (unmailed). */
export function asksOf(report: Pick<ReportDoc, 'cityAsks' | 'cityMessages' | 'portalDetail'>, selfName?: string): CityAsk[] {
  if (report.cityAsks?.length) return report.cityAsks;
  return dedupeAsks(askCandidates(report, selfName)).map((c) => ({ ...c, notifiedAt: null, answers: [] }));
}

async function ownerEmail(store: Store, report: ReportDoc): Promise<string | null> {
  if (report.reporterEmail) return report.reporterEmail.toLowerCase();
  if (!report.ownerUid) return null;
  const u = await store.getUser(report.ownerUid).catch(() => null);
  return u?.email?.toLowerCase() ?? null;
}

/** Is `from` the report owner's address? (relay.ts: an emailed answer must come from the reporter.) */
export async function isOwnerAddress(store: Store, report: ReportDoc, from: string): Promise<boolean> {
  const addr = from.trim().toLowerCase();
  if (!addr) return false;
  if (report.reporterEmail && report.reporterEmail.toLowerCase() === addr) return true;
  if (!report.ownerUid) return false;
  const u = await store.getUser(report.ownerUid).catch(() => null);
  return !!u?.email && u.email.toLowerCase() === addr;
}

const trackUrl = (env: Pick<Env, 'APP_BASE_URL'>, id: string) => `${(env.APP_BASE_URL ?? 'https://fixmypvd.org').replace(/\/+$/, '')}/r/${id}`;
const categoryWords = (r: Pick<ReportDoc, 'category'>) => (CATEGORIES[r.category]?.label ?? r.category.replace(/_/g, ' ')).toLowerCase();
const caseOf = (r: Pick<ReportDoc, 'portalCaseId' | 'cityCaseId'>) => r.portalCaseId ?? r.cityCaseId ?? '';

/** The reporter's "the city needs more information" mail (and its one reminder). */
export function askEmail(o: { reminder: boolean; caseId: string; category: string; address: string; trackUrl: string; cityText: string }): { subject: string; html: string } {
  const subject = o.reminder
    ? `Reminder: the city is waiting for more information (${o.caseId})`
    : `The city needs more information about your report (${o.caseId})`;
  const html = `<p>${o.reminder ? 'Providence 311 is still waiting for' : 'Providence 311 asked for'} more information about your ${esc(o.category)} report at ${esc(o.address)} (city case <b>${esc(o.caseId)}</b>). Their message:</p>`
    + quote(o.cityText)
    + `<p><b>Reply to this email with your answer</b> and we'll send it to the city with your case number. Or answer on your tracking page: <a href="${esc(o.trackUrl)}#answer">${esc(o.trackUrl)}</a>.</p>`
    + `<p style="color:#888">Your answer goes to the city from FixMyPVD's account, not from your email address. FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  return { subject, html };
}

/**
 * Record asks found in the report's stored city mail + portal notes; mail the owner about a new one; remind once at 48 h.
 * Idempotent. `settleMs` skips asks younger than that (the watcher leaves fresh mail to relay.ts). Never throws.
 */
export async function syncCityAsks(
  env: Env, deps: { store: Store; mailer: Mailer }, report: ReportDoc,
  opts: { now?: Date; settleMs?: number } = {},
): Promise<{ opened: number; notified: number; reminded: number }> {
  const now = (opts.now ?? new Date()).getTime();
  const nowIso = new Date(now).toISOString();
  const out = { opened: 0, notified: 0, reminded: 0 };
  try {
    const known: CityAsk[] = (report.cityAsks ?? []).map((a) => ({ ...a }));
    const candidates = dedupeAsks(askCandidates(report, env.APP_NAME));
    if (!known.length && !candidates.length) return out; // the common case: the city never asked
    const fresh: CityAsk[] = [];
    let changed = false;
    for (const c of candidates) {
      if (now - Date.parse(c.at) < (opts.settleMs ?? 0)) continue;
      const match = [...known, ...fresh].find((k) => sameAsk(k, c));
      if (match) {
        // An ask first recorded from its portal note gets the email's subject/sender/Message-ID when the email shows up.
        if (match.source === 'portal' && c.source === 'email') {
          Object.assign(match, { source: c.source, from: c.from, subject: c.subject, messageId: c.messageId, text: c.text || match.text });
          changed = true;
        }
        continue;
      }
      fresh.push({ ...c, notifiedAt: null, answers: [] });
    }
    const all = [...known, ...fresh].sort((a, b) => a.at.localeCompare(b.at));
    if (fresh.length) changed = true;
    const caseId = caseOf(report);
    const url = trackUrl(env, report.id);
    const to = await ownerEmail(deps.store, report);

    // Mail the newest new ask only (a backfill that finds several mails once).
    const newest = fresh.length ? fresh.reduce((a, b) => (a.at >= b.at ? a : b)) : null;
    for (const a of fresh) {
      out.opened++;
      const mailIt = a === newest && !!to && askState(a, report, now).open && now - Date.parse(a.at) <= ASK_NOTIFY_MAX_AGE_MS;
      if (mailIt) {
        const m = askEmail({ reminder: false, caseId, category: categoryWords(report), address: report.address, trackUrl: url, cityText: a.text });
        await deps.mailer.sendTo(to!, m.subject, m.html, { replyTo: env.RELAY_ADDRESS ?? 'cases@fixmypvd.org' });
        a.notifiedAt = nowIso;
        out.notified++;
      }
      await logEvent(deps.store, {
        level: 'warn', kind: 'city.ask', reportId: report.id,
        msg: `${caseId}: the city asked for more information (${a.source}${a.by === 'ai' ? ', AI-read' : ''}) — ${mailIt ? 'emailed the reporter' : to ? 'not emailed (late or case closed)' : 'no reporter email on file'}`,
        data: { caseId, askId: a.id, source: a.source, by: a.by, notified: mailIt },
      });
    }

    // One reminder for the newest ask, 48 h after we mailed it, while it is still unanswered and answerable.
    const last = all[all.length - 1];
    if (last && to && last.notifiedAt && !last.remindedAt && askState(last, report, now).open && now - Date.parse(last.notifiedAt) >= ASK_REMIND_AFTER_MS) {
      const m = askEmail({ reminder: true, caseId, category: categoryWords(report), address: report.address, trackUrl: url, cityText: last.text });
      await deps.mailer.sendTo(to, m.subject, m.html, { replyTo: env.RELAY_ADDRESS ?? 'cases@fixmypvd.org' });
      last.remindedAt = nowIso;
      changed = true;
      out.reminded++;
      await logEvent(deps.store, { level: 'info', kind: 'city.ask_reminder', reportId: report.id, msg: `${caseId}: reminded the reporter about the city's question`, data: { caseId, askId: last.id } });
    }

    if (changed) await deps.store.patchReport(report.id, { cityAsks: all.slice(-MAX_ASKS_STORED) });
  } catch (e) {
    console.error('[cityask] sync failed:', e instanceof Error ? e.message : e);
    await logEvent(deps.store, { level: 'error', kind: 'city.ask_failed', reportId: report.id, msg: `Ask sync failed: ${e instanceof Error ? e.message : String(e)}` }).catch(() => {});
  }
  return out;
}

// ── Answers ───────────────────────────────────────────────────────────────────────────

export type AnswerError = 'no_ask' | 'case_closed' | 'expired' | 'invalid_text' | 'too_many' | 'too_soon' | 'blocked' | 'send_failed';
export type AnswerResult =
  | { ok: true; answer: CityAskAnswer; ask: CityAsk }
  | { ok: false; error: AnswerError; flags?: string[]; retryAfterSec?: number; answer?: CityAskAnswer };

/** Typed text (or an email reply's top part): control characters out, blank runs collapsed. */
export function normalizeAnswer(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cityDomainOk(addr: string | null | undefined, env: Pick<Env, 'CITY_SENDER_DOMAINS'>): boolean {
  if (!addr) return false;
  const domains = (env.CITY_SENDER_DOMAINS ?? 'providenceri.gov').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  const dom = addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();
  return addr.includes('@') && domains.some((d) => dom === d || dom.endsWith(`.${d}`));
}

/** What goes to the city: the reporter's words, the case, and the original location/description for context. */
export function cityAnswerMail(report: ReportDoc, ask: CityAsk, answer: string): { subject: string; text: string; html: string } {
  const caseId = caseOf(report);
  const base = ask.subject.trim() || `${caseId} — information you asked for`;
  let subject = /^re\s*:/i.test(base) ? base : `RE: ${base}`;
  if (caseId && !subject.includes(caseId)) subject = `${subject} (${caseId})`;
  const label = CATEGORIES[report.category]?.label ?? report.category;
  const map = report.lat != null && report.lng != null ? `https://maps.google.com/?q=${report.lat.toFixed(6)},${report.lng.toFixed(6)}` : null;
  const lines = [
    'Hello PVD311 team,',
    '',
    `This is the information you asked for on service request ${caseId} (${label}). The resident who reported it wrote:`,
    '',
    answer,
    '',
    'Original report',
    `Address: ${report.address}`,
    ...(map ? [`Exact location: ${map}`] : []),
    ...(report.description ? [`Description: ${report.description}`] : []),
    '',
    'Thank you,',
    'FixMyPVD, on behalf of the resident who filed this request at fixmypvd.org',
    `[FixMyPVD ref:${report.id}]`,
  ];
  const html = `<p>Hello PVD311 team,</p><p>This is the information you asked for on service request <b>${esc(caseId)}</b> (${esc(label)}). The resident who reported it wrote:</p>`
    + quote(answer)
    + `<p><b>Original report</b><br>Address: ${esc(report.address)}${map ? `<br>Exact location: <a href="${map}">${map}</a>` : ''}${report.description ? `<br>Description: ${esc(report.description)}` : ''}</p>`
    + `<p>Thank you,<br>FixMyPVD, on behalf of the resident who filed this request at fixmypvd.org<br>[FixMyPVD ref:${esc(report.id)}]</p>`;
  return { subject, text: lines.join('\n'), html };
}

type ModerateFn = (env: Env, report: ReportDoc, text: string) => Promise<string[]>;
const defaultModerate: ModerateFn = async (env, report, text) => {
  try {
    const r = await moderate(env, { category: report.category, description: text, address: report.address, extra: {}, hasPhoto: false });
    return r.flags;
  } catch (e) {
    console.error('[cityask] moderation unavailable, sending unchecked:', e instanceof Error ? e.message : e);
    return [];
  }
};

/**
 * Send the owner's answer to the city (the newest ask unless `askId`). Records every attempt on the ask — sent, blocked
 * or failed — and logs it. Caller checks ownership. Never throws.
 */
export async function answerCityAsk(
  env: Env, deps: { store: Store; mailer: Mailer; moderate?: ModerateFn }, report: ReportDoc,
  input: { text: string; via: 'app' | 'email'; askId?: string | null }, now = new Date(),
): Promise<AnswerResult> {
  const asks = (report.cityAsks ?? []).map((a) => ({ ...a, answers: [...(a.answers ?? [])] }));
  const ask = input.askId ? asks.find((a) => a.id === input.askId) : asks[asks.length - 1];
  if (!ask) return { ok: false, error: 'no_ask' };
  const text = normalizeAnswer(input.text ?? '');
  if (!text || text.length > ANSWER_MAX_CHARS) return { ok: false, error: 'invalid_text' };
  if (isTerminal(report) || (report.status !== 'submitted' && report.status !== 'processing')) return { ok: false, error: 'case_closed' };
  if (now.getTime() >= Date.parse(ask.at) + ASK_ANSWERABLE_MS) return { ok: false, error: 'expired' };
  if (sentAnswers(ask).length >= MAX_ANSWERS_PER_ASK) return { ok: false, error: 'too_many' };
  const lastAt = ask.answers.length ? Date.parse(ask.answers[ask.answers.length - 1].at) : NaN;
  if (Number.isFinite(lastAt) && now.getTime() - lastAt < ANSWER_MIN_GAP_MS) {
    return { ok: false, error: 'too_soon', retryAfterSec: Math.ceil((ANSWER_MIN_GAP_MS - (now.getTime() - lastAt)) / 1000) };
  }
  const caseId = caseOf(report);
  const at = now.toISOString();
  const save = async (answer: CityAskAnswer) => {
    ask.answers.push(answer);
    await deps.store.patchReport(report.id, { cityAsks: asks });
  };

  const flags = await (deps.moderate ?? defaultModerate)(env, report, text);
  const stop = flags.filter((f) => f === 'spam' || f === 'abuse');
  if (stop.length) {
    const answer: CityAskAnswer = { at, via: input.via, text, status: 'blocked', reason: stop.join(',') };
    await save(answer);
    await logEvent(deps.store, { level: 'warn', kind: 'city.answer_blocked', reportId: report.id, msg: `${caseId}: answer to the city blocked (${stop.join(', ')})`, data: { caseId, askId: ask.id, via: input.via, flags } });
    return { ok: false, error: 'blocked', flags: stop, answer };
  }

  const to = cityDomainOk(ask.from, env) ? ask.from! : (env.CITY_REPLY_ADDRESS || DEFAULT_CITY_REPLY);
  const mail = cityAnswerMail(report, ask, text);
  const res = await deps.mailer.sendAsRelay({ to, subject: mail.subject, text: mail.text, html: mail.html, inReplyTo: ask.messageId ?? null });
  const answer: CityAskAnswer = { at, via: input.via, text, status: res.ok ? 'sent' : 'failed', reason: res.ok ? null : res.error, emailId: res.id };
  await save(answer);
  if (!res.ok) {
    await logEvent(deps.store, { level: 'error', kind: 'city.answer_failed', reportId: report.id, msg: `${caseId}: answer to the city failed to send — ${res.error}`, data: { caseId, askId: ask.id, via: input.via, to } });
    await deps.mailer.alert(`Answer to the city failed (${caseId})`, `<p>The reporter's answer on <b>${esc(caseId)}</b> (report ${esc(report.id)}) could not be mailed to ${esc(to)}: ${esc(res.error ?? 'unknown error')}. They were told to try again.</p>`);
    return { ok: false, error: 'send_failed', answer };
  }
  await logEvent(deps.store, { level: 'info', kind: 'city.answer_sent', reportId: report.id, msg: `${caseId}: the reporter's answer went to the city (${input.via})`, data: { caseId, askId: ask.id, via: input.via, to, emailId: res.id } });
  return { ok: true, answer, ask };
}

/** Is this reply part of the ask conversation? Our ask mail and its reminder, the city's own ask as relayed, and our
 *  answer receipts all say so in the subject. Replies to anything else (status mail says "Reply to stop updates") are not answers. */
export function isAnswerSubject(subject: string): boolean {
  return /needs more information|waiting for more information|your answer/i.test(subject);
}

/** "stop" / "unsubscribe", or a bare "thanks" (a reply to our receipt), is never an answer to the city. */
export function isNotAnAnswer(text: string): boolean {
  return /^\s*(stop|unsubscribe|remove me|opt out|cancel|thanks?( you)?( so much)?|thx|ty|ok(ay)?|great|cool|got it|👍)[\s.!]*$/iu.test(text);
}

/** The top of an email reply: everything above the quoted message (Gmail / Apple / Outlook markers, our own address). */
export function extractReplyText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1] ?? '';
    if (/^\s*>/.test(l)) break;
    if (/(wrote|escribió|a écrit)\s*:\s*$/i.test(l)) break;
    if (/^\s*(On|El|Le)\s.+/.test(l) && /(wrote|escribió|a écrit)\s*:\s*$/i.test(next)) break;
    if (/updates@fixmypvd\.org|cases@fixmypvd\.org/i.test(l)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^_{8,}\s*$/.test(l)) break;
    if (/^\s*From:\s.+/i.test(l) && lines.slice(i + 1, i + 5).some((x) => /^\s*(Sent|Date|To|Subject):/i.test(x))) break;
    if (/^\s*(Sent from my |Get Outlook for )/i.test(l)) break;
    if (/^--\s*$/.test(l)) break;
    out.push(l);
  }
  return normalizeAnswer(out.join('\n'));
}

/** Mail to the owner after an emailed answer: what happened to it, in our words. */
export function answerOutcomeEmail(o: { result: AnswerResult; caseId: string; trackUrl: string; text: string; attachments?: number }): { subject: string; html: string } {
  const foot = `<p><a href="${esc(o.trackUrl)}">Track this report</a>.</p><p style="color:#888">FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  const files = o.attachments ? `<p>We can't pass along photos or files — only your text was sent.</p>` : '';
  if (o.result.ok) {
    return { subject: `We sent your answer to the city (${o.caseId})`, html: `<p>We sent this to Providence 311 for case <b>${esc(o.caseId)}</b>:</p>${quote(o.text)}${files}<p>We'll email you when the city updates the case.</p>${foot}` };
  }
  const why: Record<AnswerError, string> = {
    blocked: 'Our automatic check flagged it as spam or abusive, so it was not sent. If that is a mistake, rephrase it and reply again, or answer on the tracking page.',
    case_closed: 'The city has already closed this case, so we did not send it.',
    expired: 'The city asked more than 14 days ago, so we did not send it. If the problem is still there, please file a new report.',
    too_many: 'You have already sent the city 3 answers on this request, so we did not send another.',
    too_soon: 'You sent an answer less than a minute ago. Wait a moment and reply again.',
    invalid_text: o.text ? 'It is longer than 2,000 characters. Please shorten it and reply again.' : 'We could not find your answer in that email. Please type it above the quoted message and reply again.',
    send_failed: 'Something went wrong sending it to the city. Please try again in a few minutes, or answer on the tracking page.',
    no_ask: 'The city has not asked for anything on this case, so we did not send it.',
  };
  return { subject: `We couldn't send your answer (${o.caseId})`, html: `<p>${esc(why[o.result.error])}</p>${o.text ? quote(o.text) : ''}${foot}` };
}

/** Owner whose reply we could not verify (no DMARC pass): point them at the app, send nothing to the city. */
export function unverifiedReplyEmail(o: { caseId: string; trackUrl: string }): { subject: string; html: string } {
  return {
    subject: `Please answer the city on your tracking page (${o.caseId})`,
    html: `<p>We got an email reply about case <b>${esc(o.caseId)}</b>, but couldn't confirm it came from your address, so we did not send it to the city.</p>`
      + `<p>Please answer here instead: <a href="${esc(o.trackUrl)}#answer">${esc(o.trackUrl)}</a></p>`
      + `<p style="color:#888">FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────

export function quote(text: string): string {
  return `<blockquote style="border-left:3px solid #ccc;margin:12px 0;padding:4px 12px;white-space:pre-wrap">${esc(text || '(empty message)')}</blockquote>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

