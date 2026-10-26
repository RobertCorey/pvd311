/**
 * week.ts — "This week in Providence": the last 7 days of the city's public 311 list, citywide, against the 7 before.
 *
 * Rob, 2026-10-25: "make the app more something you'd want to check in on." The city's public cases are data we
 * already hold (citycases.ts); a weekly, shareable "what happened in Providence" is both a reason to come back and
 * r/providence re-post material. Three pieces, all from the same summary:
 *
 *   GET /api/week                 public, cache-control public max-age=300, one Firestore read per 5 min per isolate
 *                                 (loadCases(store, 14): the two windows plus street.ts's 60-day close lookback)
 *   /week (app)                   the page anyone can open and share — reads this one endpoint
 *   prefs.weekDigest              "Email me this every Monday": runWeekDigest from runDaily on Mondays, after the
 *                                 per-address street digest; kind 'week_digest' in the email log; no mail on an empty week
 *
 * Inclusion = cityOverview / nearbyCases (street.ts): skip Draft; a case counts for a week when its created time OR its
 * closedAt falls inside that window — the same rule on both sides, so `prev` is what this endpoint reported a week
 * earlier and the "vs last week" delta is like for like. A case created ten days ago and closed two days ago is in
 * BOTH weeks (last week as a new request, this week as a close); for this week that equals activity ≥ since. Open /
 * closed from cityinsights' CLOSED set; outcomes from its classifyResolution / outcomeOf; neighborhoods by
 * point-in-polygon over the shared rings.
 */
import type { Env, Mailer, Store } from './contracts.js';
import { CLOSED, closedAt, median, outcomeOf, type CaseLike, type Outcome } from './cityinsights.js';
import { loadCases } from './street.js';
import { hoodOf as sharedHoodOf, hoodSlug } from '../../shared/neighborhoods.js';
import { logEvent } from './health.js';

export const WEEK_DAYS = 7;
/** loadCases window: this week + last week; loadCases adds the 60-day close lookback itself. */
export const LOAD_DAYS = 2 * WEEK_DAYS;
export const TOP_TYPES_N = 6;
export const NOTABLE_N = 12;
/** Resolution Message cut for `notable` (the live average is ~36 chars). */
export const NOTABLE_RES_MAX = 240;
const SUMMARY_TTL_MS = 5 * 60_000;
const TZ = 'America/New_York';

/** Closed-case outcomes — cityinsights' OUTCOMES without 'open' (every case here is closed). */
export const WEEK_OUTCOMES = ['work_done', 'enforcement', 'referred', 'logged_elsewhere', 'info_only', 'no_action', 'cancelled'] as const;
export type WeekOutcome = typeof WEEK_OUTCOMES[number];

export interface WeekType { caseType: string; category: string; n: number; prevN: number }
export interface WeekHood { name: string; slug: string; n: number; open: number; closed: number }
export interface WeekNotable {
  id: string; caseType: string; category: string; street: string; neighborhood: string | null; status: string;
  closedAt: string | null; resolution: string; lat: number | null; lng: number | null;
}
export interface WeekSummary {
  days: 7;
  /** [since, until) — until is when the summary was built (= at). */
  since: string; until: string; at: string;
  total: number; open: number; closed: number; located: number;
  /** The 7 days before `since`, same created-OR-closed rule — what this endpoint reported a week earlier. */
  prev: { total: number; closed: number };
  /** Top 6 case types by n this week, with last week's count for each. */
  topTypes: WeekType[];
  /** Every neighborhood with activity this week, n desc (name asc on ties); located cases only. */
  neighborhoods: WeekHood[];
  /** Closed this week, by what closing meant (cityinsights). */
  outcomes: Record<WeekOutcome, number>;
  /** Median days from created to closed over this week's closes with both times known; null when none. */
  medianCloseDays: number | null;
  /** Closed this week with a Resolution Message, newest close first, ≤ 12, resolution cut to 240 chars. */
  notable: WeekNotable[];
  /** The America/New_York calendar day with the most new cases this week, or null when none were created. */
  busiestDay: { date: string; n: number } | null;
}

type Row = Record<string, unknown>;
export type HoodOf = (lat: number, lng: number) => string | null;

const json = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });

const parse = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null;
  const v = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(v) ? null : v;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** YYYY-MM-DD in New York (en-CA formats ISO-style). */
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayInNewYork = (ms: number): string => nyDay.format(new Date(ms));

interface Seen {
  id: string; caseType: string; category: string; street: string; status: string; open: boolean;
  created: number | null; closed: number | null; activity: number;
  lat: number | null; lng: number | null; resolution: string | null; row: Row;
}

function seen(rows: Row[]): Seen[] {
  const out: Seen[] = [];
  for (const c of rows) {
    const status = String(c.status ?? '');
    if (/^draft$/i.test(status)) continue;
    const open = !CLOSED.has(status);
    const created = parse(c.createdAt);
    const closed = open ? null : closedAt(c as unknown as CaseLike);
    const activity = Math.max(created ?? 0, closed ?? 0);
    if (!activity) continue;
    const lat = num(c.lat); const lng = num(c.lng);
    const detail = (c.detail ?? null) as { resolution?: string | null } | null;
    out.push({
      id: String(c.id), caseType: String(c.caseType ?? ''), category: typeof c.category === 'string' && c.category ? c.category : 'unsure',
      street: String(c.street ?? ''), status, open, created, closed, activity,
      lat: lat != null && lng != null ? lat : null, lng: lat != null && lng != null ? lng : null,
      resolution: detail?.resolution?.trim() || null, row: c,
    });
  }
  return out;
}

/** The week's summary from cityCases rows. Pure; `hoodOf` defaults to the shared rings (injectable for tests). */
export function weekSummary(rows: Row[], o: { now?: number; hoodOf?: HoodOf } = {}): WeekSummary {
  const now = o.now ?? Date.now();
  const hoodOf = o.hoodOf ?? sharedHoodOf;
  const since = now - WEEK_DAYS * 86_400_000;
  const prevSince = since - WEEK_DAYS * 86_400_000;
  const all = seen(rows);
  const week = all.filter((x) => x.activity >= since);
  // Last week by the same created-OR-closed rule (a case closed without a known close time counts by its creation).
  const inPrev = (t: number | null) => t != null && t >= prevSince && t < since;
  const prev = all.filter((x) => inPrev(x.created) || inPrev(x.closed));
  const prevClosed = prev.filter((x) => inPrev(x.closed) || (!x.open && x.closed == null && inPrev(x.created))).length;

  let open = 0; let closed = 0; let located = 0;
  const types = new Map<string, WeekType>();
  const hoods = new Map<string, WeekHood>();
  const outcomes = Object.fromEntries(WEEK_OUTCOMES.map((k) => [k, 0])) as Record<WeekOutcome, number>;
  const closeDays: number[] = [];
  const notable: (WeekNotable & { sort: number })[] = [];
  const days = new Map<string, number>();

  for (const x of week) {
    if (x.open) open++; else closed++;
    const t = types.get(x.caseType) ?? { caseType: x.caseType, category: x.category, n: 0, prevN: 0 };
    t.n++; types.set(x.caseType, t);
    let hood: string | null = null;
    if (x.lat != null && x.lng != null) {
      located++;
      hood = hoodOf(x.lat, x.lng);
      if (hood) {
        const h = hoods.get(hood) ?? { name: hood, slug: hoodSlug(hood), n: 0, open: 0, closed: 0 };
        h.n++; if (x.open) h.open++; else h.closed++;
        hoods.set(hood, h);
      }
    }
    if (x.created != null && x.created >= since) {
      const d = dayInNewYork(x.created);
      days.set(d, (days.get(d) ?? 0) + 1);
    }
    if (x.open) continue;
    const oc = outcomeOf(x.row as unknown as CaseLike) as Outcome;
    if (oc !== 'open') outcomes[oc as WeekOutcome]++;
    if (x.closed != null && x.created != null && x.closed >= x.created) closeDays.push((x.closed - x.created) / 86_400_000);
    if (x.resolution) {
      notable.push({
        id: x.id, caseType: x.caseType, category: x.category, street: x.street, neighborhood: hood, status: x.status,
        closedAt: x.closed != null ? new Date(x.closed).toISOString() : null, resolution: x.resolution.slice(0, NOTABLE_RES_MAX),
        lat: x.lat, lng: x.lng, sort: x.closed ?? x.activity,
      });
    }
  }
  for (const x of prev) { const t = types.get(x.caseType); if (t) t.prevN++; }

  const topTypes = [...types.values()].sort((a, b) => b.n - a.n || a.caseType.localeCompare(b.caseType)).slice(0, TOP_TYPES_N);
  const neighborhoods = [...hoods.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  notable.sort((a, b) => b.sort - a.sort);
  const mc = median(closeDays);
  let busiestDay: WeekSummary['busiestDay'] = null;
  for (const [date, n] of days) if (!busiestDay || n > busiestDay.n || (n === busiestDay.n && date > busiestDay.date)) busiestDay = { date, n };

  return {
    days: WEEK_DAYS, since: new Date(since).toISOString(), until: new Date(now).toISOString(), at: new Date(now).toISOString(),
    total: week.length, open, closed, located,
    prev: { total: prev.length, closed: prevClosed },
    topTypes, neighborhoods, outcomes,
    medianCloseDays: mc == null ? null : Math.round(mc * 10) / 10,
    notable: notable.slice(0, NOTABLE_N).map(({ sort: _s, ...rest }) => rest),
    busiestDay,
  };
}

// ── GET /api/week ─────────────────────────────────────────────────────────────────────────

let cached: { at: number; body: string } | null = null;

/** The summary as a response body, built at most once per 5 minutes per isolate (the rows come from street.ts's
 *  loadCases cache, so a cold summary is one Firestore read shared with nothing else — the 14-day window is its own). */
export async function handleWeek(_url: URL, store: Store, now = Date.now()): Promise<Response> {
  if (!cached || now - cached.at >= SUMMARY_TTL_MS) {
    const rows = await loadCases(store, LOAD_DAYS, now);
    cached = { at: now, body: JSON.stringify(weekSummary(rows, { now })) };
  }
  return json(cached.body, 200, { 'cache-control': 'public, max-age=300' });
}

/** Tests: drop the in-isolate summary cache (street.ts's resetStreetCache drops the rows). */
export function resetWeekCache(): void { cached = null; }

// ── The Monday mail ───────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shortDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ }) : '');
const monthDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });

/** "+12 vs last week" / "-3 vs last week" / "same as last week". */
export function deltaText(n: number, prev: number): string {
  if (n === prev) return 'same as last week';
  return `${n > prev ? '+' : '-'}${Math.abs(n - prev)} vs last week`;
}

/** Subject + HTML for the Monday mail — the week page's headline numbers, in the street digest's plain style. */
export function weekDigestEmail(s: WeekSummary, o: { base: string }): { subject: string; html: string } {
  const base = o.base.replace(/\/+$/, '');
  const weekUrl = `${base}/week`;
  const subject = `This week in Providence: ${s.total} ${s.total === 1 ? 'request' : 'requests'}, ${s.closed} closed`;
  const li = (inner: string) => `<li style="margin:0 0 8px">${inner}</li>`;
  const section = (title: string, items: string[]) => (items.length
    ? `<h3 style="margin:1.2em 0 .3em">${esc(title)}</h3><ul style="padding-left:1.2em;margin:0">${items.join('')}</ul>` : '');
  const types = s.topTypes.slice(0, 3).map((t) => li(`<b>${esc(t.caseType)}</b> · ${t.n} (last week ${t.prevN})`));
  const hoods = s.neighborhoods.slice(0, 3).map((h) => li(`<b>${esc(h.name)}</b> · ${h.n} ${h.n === 1 ? 'request' : 'requests'}, ${h.closed} closed`));
  const notable = s.notable.slice(0, 3).map((c) => {
    const where = [c.street.trim(), c.neighborhood].filter((p): p is string => !!p).map(esc).join(', ');
    const when = c.closedAt ? ` (closed ${shortDay(c.closedAt)})` : '';
    return li(`<b>${esc(c.caseType)}</b>${where ? ` · ${where}` : ''} · ${esc(c.status)}${when}`
      + `<div style="color:#555;margin:2px 0 0 1em;white-space:pre-wrap">${esc(c.resolution)}</div>`);
  });
  const html = `<h2 style="margin:0 0 .2em">This week in Providence</h2>`
    + `<p style="color:#666;margin:0 0 1em">${esc(monthDay(s.since))} – ${esc(monthDay(s.until))}, from Providence 311's public list.</p>`
    + `<p style="font-size:1.1em;margin:0"><b>${s.total}</b> ${s.total === 1 ? 'request' : 'requests'} (${deltaText(s.total, s.prev.total)}) · `
    + `<b>${s.closed}</b> closed (${deltaText(s.closed, s.prev.closed)})</p>`
    + section('Most reported', types)
    + section('Busiest neighborhoods', hoods)
    + section("Closed this week, in the city's words", notable)
    + `<p style="margin:1.2em 0 0"><a href="${esc(weekUrl)}">See the whole week</a></p>`
    + `<p style="color:#888;margin-top:2em">You asked for this every Monday on FixMyPVD — turn it off on <a href="${esc(weekUrl)}">the week page</a> or under <a href="${esc(base)}/account">Account</a>. `
    + `FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  return { subject, html };
}

/** Mondays (runDaily, after runStreetDigest): one mail per opted-in verified account; none at all when the week had
 *  no cases. Returns counts for the log. */
export async function runWeekDigest(env: Env, store: Store, mailer: Mailer, opts: { now?: number } = {}): Promise<{ users: number; mailed: number }> {
  const now = opts.now ?? Date.now();
  const base = env.APP_BASE_URL ?? 'https://fixmypvd.org';
  const users = await store.listWeekDigestUsers(500);
  const eligible = users.filter((u) => !!u.email && !!u.emailVerified && u.prefs?.weekDigest === true);
  let mailed = 0;
  let total: number | null = null;
  if (eligible.length) {
    const summary = weekSummary(await loadCases(store, LOAD_DAYS, now), { now });
    total = summary.total;
    if (summary.total > 0) {
      const m = weekDigestEmail(summary, { base });
      for (const u of eligible) {
        await mailer.sendTo(u.email!, m.subject, m.html, { kind: 'week_digest' });
        mailed++;
      }
    }
  }
  console.log(`[week] digest: ${mailed} of ${users.length} opted-in accounts mailed${total === 0 ? ' (empty week, skipped)' : ''}`);
  await logEvent(store, { level: 'info', kind: 'week.digest', msg: total === 0 ? 'Weekly city digest: the week had no cases — no mail sent' : `Weekly city digest: ${mailed} of ${users.length} opted-in accounts mailed`, data: { users: users.length, mailed, total } });
  await store.setMeta('weekDigest', { at: new Date(now).toISOString(), users: users.length, mailed, total }).catch(() => {});
  return { users: users.length, mailed };
}
