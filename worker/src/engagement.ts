/**
 * engagement.ts — GET /api/admin/engagement: who is subscribed to what (the /admin "Engagement" tab, 2026-10-26).
 *
 * One listUsers scan (the newest ENGAGEMENT_SCAN accounts) counted in memory by countAccounts — accounts with a phone
 * subscribed and their push devices, who follows city cases (and how many distinct cases), the two Monday opt-ins
 * (prefs.streetDigest — some saved address in the street digest, me.ts — and prefs.weekDigest) — plus the two existing
 * equality queries (prefs.X == true, the ones the Monday jobs read) as a cross-check that does not depend on the scan
 * window. `scanned` / `truncated` say how far the scan reached: past ENGAGEMENT_SCAN accounts the in-memory counts are
 * a floor and `queried` is the truth for the two it covers.
 *
 * Around the counts: the last Monday runs (meta/weekDigest, meta/streetDigest — written by week.ts / street.ts), when
 * push was first used (meta/vapid's createdAt — the keys never leave this module), and the recent events (recentEvents,
 * filtered to the kinds these features log) and mails (listEmails, filtered to the four resident/admin digest kinds;
 * no body, recipients masked — each row links to the email tab for the full record).
 *
 * Built at most once per ENGAGEMENT_TTL_MS per isolate (one in-flight build shared); every read fails soft — a missing
 * meta doc or a failed query zeroes its part of the response, never the response.
 */
import type { Store, UserDoc } from './contracts.js';
import type { EmailRecord, EmailKind } from './emaillog.js';
import { isPushSub, VAPID_META } from './push.js';

export const ENGAGEMENT_SCAN = 500;       // accounts read by the one listUsers scan (newest first)
export const ENGAGEMENT_TTL_MS = 60_000;  // one build per minute per isolate
export const RECENT_EVENTS = 40;
export const RECENT_MAILS = 20;
export const EVENT_SCAN = 500;            // recentEvents window the 40 are picked from (the stream is a few dozen a day)
export const MAIL_SCAN = 300;             // listEmails window the 20 are picked from (most mail is per-report status)

/** Event kinds the check-in features log: week.ts, street.ts, push.ts (logPushes). */
export const ENGAGEMENT_EVENT_KINDS = ['week.digest', 'street.digest', 'push.sent'] as const;
/** Email-log kinds these features send: the two resident digests, the followed-case mail, Rob's Monday post. */
export const ENGAGEMENT_MAIL_KINDS = ['week_digest', 'street_digest', 'city_follow', 'admin_digest'] as const satisfies readonly EmailKind[];

export interface AccountCounts {
  total: number;           // countUsers() — every account; `scanned` when the count failed or came back smaller
  scanned: number;         // accounts the in-memory counts looked at (the newest `scanned`)
  truncated: boolean;      // scanned reached ENGAGEMENT_SCAN — the in-memory counts are a floor
  withPush: number;        // accounts with ≥ 1 well-formed push subscription ("Notify me on this phone" is on)
  pushDevices: number;     // subscriptions across them — one per browser profile, ≤ 5 per account
  follows: { accounts: number; cases: number }; // accounts following ≥ 1 city case · distinct cases followed
  streetDigest: number;    // prefs.streetDigest === true (some saved address gets the Monday "My street" mail)
  weekDigest: number;      // prefs.weekDigest === true (the Monday "This week in Providence" mail)
  /** The same two opt-ins from the equality queries (prefs.X == true), capped at ENGAGEMENT_SCAN each; null when a query failed. */
  queried: { streetDigest: number; weekDigest: number } | null;
}

export interface DigestRun { at: string; users: number; mailed: number; pushed: number }
export interface WeekDigestRun extends DigestRun { total: number; adminMailed: boolean }

export type EngagementEvent = { id: string; at: string; level: string; kind: string; msg: string; reportId?: string | null; data?: Record<string, unknown> | null };
/** One mail of the email log for the tab's table: no body, `to` masked (maskEmail, joined with ', ' when several) — the
 *  row links to `#email:<id>`, where the email tab shows the full record. */
export interface EngagementMail { id: string; at: string; kind: EmailKind; to: string; subject: string; status: EmailRecord['status'] }

export interface Engagement {
  at: string;
  accounts: AccountCounts;
  vapidSince: string | null;          // meta/vapid.createdAt — when the first phone could subscribe
  lastWeekDigest: WeekDigestRun | null;
  lastStreetDigest: DigestRun | null;
  recent: { events: EngagementEvent[]; mails: EngagementMail[] };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const iso = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `rob@fixmypvd.org` → `r***@fixmypvd.org`: the first character of the local part, then `***`, then the domain
 *  (no `@` → first character + `***`; blank → `***`). Enough to tell Rob's mail from a resident's on a table. */
export function maskEmail(addr: string): string {
  const a = addr.trim();
  const i = a.indexOf('@');
  const local = i >= 0 ? a.slice(0, i) : a;
  const domain = i >= 0 ? a.slice(i) : '';
  return `${local.slice(0, 1)}***${domain}`;
}

// ── Pure ──────────────────────────────────────────────────────────────────────────────

/** Counts over a users array — the in-memory half of the response. `total` is countUsers()'s answer (null when it
 *  failed) and is never reported below `scanned`; `truncated` when the scan filled its window (`limit`). */
export function countAccounts(users: UserDoc[], o: { total?: number | null; limit?: number } = {}): Omit<AccountCounts, 'queried'> {
  const limit = o.limit ?? ENGAGEMENT_SCAN;
  let withPush = 0, pushDevices = 0, followers = 0, streetDigest = 0, weekDigest = 0;
  const cases = new Set<string>();
  for (const u of users) {
    const subs = Array.isArray(u.push) ? u.push.filter(isPushSub) : [];
    if (subs.length) { withPush++; pushDevices += subs.length; }
    const following = Array.isArray(u.cityFollowing) ? u.cityFollowing.filter((g): g is string => typeof g === 'string' && g.length > 0) : [];
    if (following.length) { followers++; for (const g of following) cases.add(g); }
    if (u.prefs?.streetDigest === true) streetDigest++;
    if (u.prefs?.weekDigest === true) weekDigest++;
  }
  const scanned = users.length;
  const total = typeof o.total === 'number' && Number.isFinite(o.total) && o.total > scanned ? o.total : scanned;
  return { total, scanned, truncated: scanned >= limit, withPush, pushDevices, follows: { accounts: followers, cases: cases.size }, streetDigest, weekDigest };
}

/** meta/weekDigest as week.ts writes it → the card; null when there has been no run (or the doc is not one). */
export function weekDigestRun(m: unknown): WeekDigestRun | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const at = iso(r.at);
  if (!at) return null;
  return { at, users: num(r.users), mailed: num(r.mailed), pushed: num(r.pushed), total: num(r.total), adminMailed: r.adminMailed === true };
}

/** meta/streetDigest as street.ts writes it → the card; null when there has been no run. */
export function streetDigestRun(m: unknown): DigestRun | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const at = iso(r.at);
  if (!at) return null;
  return { at, users: num(r.users), mailed: num(r.mailed), pushed: num(r.pushed) };
}

/** The newest `n` events of ENGAGEMENT_EVENT_KINDS out of a newest-first stream. */
export function pickEvents(events: EngagementEvent[], n = RECENT_EVENTS): EngagementEvent[] {
  const kinds = new Set<string>(ENGAGEMENT_EVENT_KINDS);
  return events.filter((e) => kinds.has(e.kind)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, n)
    .map((e) => ({ id: e.id, at: e.at, level: e.level, kind: e.kind, msg: e.msg, reportId: e.reportId ?? null, data: e.data ?? null }));
}

/** The newest `n` mails of ENGAGEMENT_MAIL_KINDS as table rows: never the body, recipients masked. */
export function pickMails(emails: EmailRecord[], n = RECENT_MAILS): EngagementMail[] {
  const kinds = new Set<string>(ENGAGEMENT_MAIL_KINDS);
  return emails.filter((e) => kinds.has(e.kind)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, n)
    .map((e) => ({ id: e.id, at: e.at, kind: e.kind, to: (e.to ?? []).map(maskEmail).join(', '), subject: e.subject, status: e.status }));
}

// ── Assembly ──────────────────────────────────────────────────────────────────────────

const soft = <T,>(p: Promise<T>, fallback: T, what: string): Promise<T> =>
  p.catch((e) => { console.error(`[engagement] ${what} failed:`, e instanceof Error ? e.message : e); return fallback; });

/** One uncached build: the scan, the two cross-check queries, three meta docs, the event stream and the email log, all
 *  in parallel, each failing soft. */
export async function buildEngagement(store: Store, now = Date.now()): Promise<Engagement> {
  const [users, total, qStreet, qWeek, week, street, vapid, events, mails] = await Promise.all([
    soft(store.listUsers({ limit: ENGAGEMENT_SCAN }), [] as UserDoc[], 'listUsers'),
    soft(store.countUsers(), null as number | null, 'countUsers'),
    soft(store.listStreetDigestUsers(ENGAGEMENT_SCAN).then((r) => r.length), null as number | null, 'listStreetDigestUsers'),
    soft(store.listWeekDigestUsers(ENGAGEMENT_SCAN).then((r) => r.length), null as number | null, 'listWeekDigestUsers'),
    soft(store.getMeta<Record<string, unknown>>('weekDigest'), null, 'meta/weekDigest'),
    soft(store.getMeta<Record<string, unknown>>('streetDigest'), null, 'meta/streetDigest'),
    soft(store.getMeta<{ createdAt?: unknown }>(VAPID_META), null, 'meta/vapid'),
    soft(store.recentEvents(EVENT_SCAN), [] as EngagementEvent[], 'recentEvents'),
    soft(store.listEmails({ limit: MAIL_SCAN }), [] as EmailRecord[], 'listEmails'),
  ]);
  const queried = qStreet != null && qWeek != null ? { streetDigest: qStreet, weekDigest: qWeek } : null;
  return {
    at: new Date(now).toISOString(),
    accounts: { ...countAccounts(users, { total }), queried },
    vapidSince: iso(vapid?.createdAt),   // only the date leaves; the key pair stays here
    lastWeekDigest: weekDigestRun(week),
    lastStreetDigest: streetDigestRun(street),
    recent: { events: pickEvents(events), mails: pickMails(mails) },
  };
}

let cache: { at: number; body: Engagement } | null = null;
let inflight: Promise<Engagement> | null = null;

/** The response, built at most once per ENGAGEMENT_TTL_MS per isolate; concurrent callers share one build. */
export function engagement(store: Store, now = Date.now()): Promise<Engagement> {
  if (cache && now - cache.at < ENGAGEMENT_TTL_MS) return Promise.resolve(cache.body);
  if (!inflight) {
    inflight = buildEngagement(store, now)
      .then((body) => { cache = { at: now, body }; return body; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Tests: drop the in-isolate cache. */
export function resetEngagementCache(): void { cache = null; inflight = null; }
