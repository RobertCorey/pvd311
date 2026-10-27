/**
 * week.ts — "This week in Providence": 7 days of the city's public 311 list, citywide, against the 7 before.
 *
 * Rob, 2026-10-25: "make the app more something you'd want to check in on." The city's public cases are data we
 * already hold (citycases.ts); a weekly, shareable "what happened in Providence" is both a reason to come back and
 * r/providence re-post material. Three pieces, all from the same summary:
 *
 *   GET /api/week                 public, cache-control public max-age=300, one Firestore read per 5 min per isolate
 *                                 per week (loadCases: the two windows plus street.ts's 60-day close lookback)
 *   GET /api/week?until=YYYY-MM-DD the week ending at the END of that New York calendar day (23:59:59.999), so a link
 *                                 posted on Monday still means the same week on Thursday (2026-10-26). Archive floor
 *                                 56 days back; `prevUntil` / `nextUntil` let the page browse; `current` says whether
 *                                 the window ends now.
 *   /week (app)                   the page anyone can open and share — reads this one endpoint; Share copies the dated url
 *   prefs.weekDigest              "Email me this every Monday": runWeekDigest from runDaily on Mondays, after the
 *                                 per-address street digest, for the Mon–Sun calendar week that just ended (its dated
 *                                 link reproduces it exactly); kind 'week_digest' in the email log; no mail on an empty week.
 *                                 Per reader (2026-10-27): "Your neighborhoods" — the hoods of their saved places (the
 *                                 app's placedAddresses), from the user docs the run already holds; none → the shared mail
 *   Rob's post                    the same Monday run mails Rob the week as the ready r/providence Markdown post —
 *                                 shared/weekPost.ts, the bytes /week's "Copy as post" copies — via mailer.alert (kind
 *                                 'admin_digest'), whether or not anyone opted in; nothing on an empty week (2026-10-26)
 *
 * Windows. The current week is "the last 7 × 24 h ending now" (today's behaviour, since = now − 7 d). A dated week is
 * 7 New York calendar days, 00:00 of untilDate − 6 to 23:59:59.999 of untilDate (167 or 169 h across a DST change),
 * and ?until=<today> is the current week — the shared link of today's page becomes the full-day week at midnight.
 *
 * Inclusion = cityOverview / nearbyCases (street.ts): skip Draft; a case counts for a week when its created time OR its
 * closedAt falls inside that window — the same rule on both sides, so `prev` is what this endpoint reported a week
 * earlier and the "vs last week" delta is like for like. A case created ten days ago and closed two days ago is in
 * BOTH weeks (last week as a new request, this week as a close); for this week that equals activity ≥ since. Open /
 * closed from cityinsights' CLOSED set; outcomes from its classifyResolution / outcomeOf; neighborhoods by
 * point-in-polygon over the shared rings, each with its own median days to close (/week's "Your neighborhood" line).
 */
import type { Env, Mailer, SavedAddress, Store, UserDoc } from './contracts.js';
import { CLOSED, closedAt, median, outcomeOf, type CaseLike, type Outcome } from './cityinsights.js';
import { loadCases, LOAD_LIMIT } from './street.js';
import { etDate, etMidnight } from './quota.js';
import { hoodOf as sharedHoodOf, hoodSlug } from '../../shared/neighborhoods.js';
import { logEvent } from './health.js';
import { ensureVapid, hasPush, logPushes, pushAll, type PushPayload } from './push.js';
import { weekPostMarkdown, weekPostRange } from '../../shared/weekPost.js';

export const WEEK_DAYS = 7;
/** loadCases window for the current week: this week + last week; loadCases adds the 60-day close lookback itself.
 *  Every dated week loads MAX_LOAD_DAYS (the floor week's need) so the eight archive weeks share ONE loadCases entry
 *  and one Firestore read per 5 minutes, instead of a distinct `since` — and a distinct 6000-row read — each. */
export const LOAD_DAYS = 2 * WEEK_DAYS;
/** How far back `?until=` may reach, in days from today (New York). */
export const ARCHIVE_DAYS = 56;
export const MAX_LOAD_DAYS = ARCHIVE_DAYS + LOAD_DAYS;
/** Rows per read for an archive week: 130 days of cases at the city's 30–47 a day overflow street.ts's LOAD_LIMIT,
 *  and the query is newest-first, so the oldest (wanted) rows would be the ones cut. */
export const ARCHIVE_LOAD_LIMIT = 2 * LOAD_LIMIT;
export const TOP_TYPES_N = 6;
export const NOTABLE_N = 12;
/** Resolution Message cut for `notable` (the live average is ~36 chars). */
export const NOTABLE_RES_MAX = 240;
/** "Your neighborhoods" in the Monday mail: at most this many of the reader's hoods (2026-10-27). */
export const YOUR_HOODS_N = 3;
/** Saved places a reader's hoods come from — the app's api/me PLACES_MAX (placedAddresses: the first 5 with coordinates). */
export const PLACES_MAX = 5;
const SUMMARY_TTL_MS = 5 * 60_000;
const TZ = 'America/New_York';

/** Closed-case outcomes — cityinsights' OUTCOMES without 'open' (every case here is closed). */
export const WEEK_OUTCOMES = ['work_done', 'enforcement', 'referred', 'logged_elsewhere', 'info_only', 'no_action', 'cancelled'] as const;
export type WeekOutcome = typeof WEEK_OUTCOMES[number];

export interface WeekType { caseType: string; category: string; n: number; prevN: number }
/** `medianCloseDays`: the hood's own median days created → closed over this week's closes in it with both times known
 *  (medianDays, the city-wide rule and rounding); null when it had none (2026-10-27, /week "Your neighborhood"). */
export interface WeekHood { name: string; slug: string; n: number; open: number; closed: number; medianCloseDays: number | null }
export interface WeekNotable {
  id: string; caseType: string; category: string; street: string; neighborhood: string | null; status: string;
  closedAt: string | null; resolution: string; lat: number | null; lng: number | null;
}
export interface WeekSummary {
  days: 7;
  /** The window. Current week: [since, until) with until = at = when the summary was built. Dated week: since = 00:00
   *  New York of untilDate − 6, until = 23:59:59.999 New York of untilDate (inclusive). */
  since: string; until: string; at: string;
  /** The New York calendar date the window ends on — the stable `?until=` for this week. */
  untilDate: string;
  /** untilDate − 7 days, or null when that week is older than the 56-day archive floor. */
  prevUntil: string | null;
  /** untilDate + 7 days, or null when that would be after today. */
  nextUntil: string | null;
  /** True when the window ends now (no `until`, or `until` = today). */
  current: boolean;
  total: number; open: number; closed: number; located: number;
  /** The 7 days before `since`, same created-OR-closed rule — what this endpoint reported a week earlier. */
  prev: { total: number; closed: number };
  /** Top 6 case types by n this week, with last week's count for each. */
  topTypes: WeekType[];
  /** Every neighborhood with activity this week, n desc (name asc on ties); located cases only; each with its own median. */
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

/** Median of close durations in days, to 1 dp (the city-wide `medianCloseDays` and each hood's); null for none. */
export const medianDays = (days: number[]): number | null => {
  const m = median(days);
  return m == null ? null : Math.round(m * 10) / 10;
};

/** YYYY-MM-DD in New York (en-CA formats ISO-style). */
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayInNewYork = (ms: number): string => nyDay.format(new Date(ms));

// ── Calendar dates (YYYY-MM-DD strings; compare lexicographically) ────────────────────────

const DAY_MS = 86_400_000;
const ymdMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
/** date ± n calendar days. */
export const addDays = (date: string, n: number): string => new Date(ymdMs(date) + n * DAY_MS).toISOString().slice(0, 10);
/** a − b in whole days. */
export const daysBetween = (a: string, b: string): number => Math.round((ymdMs(a) - ymdMs(b)) / DAY_MS);
/** A real calendar date in YYYY-MM-DD ('2026-02-30' and '2026-10-1' are not). */
export const isYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(ymdMs(s)) && new Date(ymdMs(s)).toISOString().slice(0, 10) === s;

export type UntilError = 'invalid_until' | 'too_old';
export interface WeekWindow {
  untilDate: string; current: boolean; prevUntil: string | null; nextUntil: string | null;
  /** Membership is [since, untilX) in ms; `until` is the reported end (now, or untilX − 1 ms for a dated week). */
  since: number; until: number; untilX: number; prevSince: number;
  /** Calendar days from today back to untilDate (0 for the current week). */
  daysBack: number;
}

/** The window for `?until=` at `now`: omitted / '' / today → the current week (ending now); a past date → that New York
 *  calendar week; a malformed or future date → 'invalid_until'; older than ARCHIVE_DAYS → 'too_old'. */
export function resolveWindow(until: string | null | undefined, now: number): WeekWindow | UntilError {
  const today = etDate(now);
  const floor = addDays(today, -ARCHIVE_DAYS);
  let untilDate = today;
  if (until != null && until !== '') {
    if (!isYmd(until) || until > today) return 'invalid_until';
    if (until < floor) return 'too_old';
    untilDate = until;
  }
  const current = untilDate === today;
  const prev = addDays(untilDate, -WEEK_DAYS);
  const next = addDays(untilDate, WEEK_DAYS);
  const base = { untilDate, current, prevUntil: prev >= floor ? prev : null, nextUntil: next <= today ? next : null, daysBack: daysBetween(today, untilDate) };
  if (current) {
    const since = now - WEEK_DAYS * DAY_MS;
    return { ...base, since, until: now, untilX: Number.POSITIVE_INFINITY, prevSince: since - WEEK_DAYS * DAY_MS };
  }
  const untilX = etMidnight(addDays(untilDate, 1));
  return { ...base, since: etMidnight(addDays(untilDate, 1 - WEEK_DAYS)), until: untilX - 1, untilX, prevSince: etMidnight(addDays(untilDate, 1 - 2 * WEEK_DAYS)) };
}

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

/** The week's summary from cityCases rows. Pure; `hoodOf` defaults to the shared rings (injectable for tests).
 *  `until` (YYYY-MM-DD, New York) picks a past week — see resolveWindow; it must be valid (the handler checks). */
export function weekSummary(rows: Row[], o: { now?: number; hoodOf?: HoodOf; until?: string | null } = {}): WeekSummary {
  const now = o.now ?? Date.now();
  const hoodOf = o.hoodOf ?? sharedHoodOf;
  const w = resolveWindow(o.until, now);
  if (typeof w === 'string') throw new Error(w);
  const { since, untilX, prevSince } = w;
  const all = seen(rows);
  // A case is in a window when its created time OR its close falls inside it; it counts as closed there when it is
  // closed now and that close is not after the window's end (an undated close goes by its creation). For the current
  // week untilX is +∞, so this is exactly "latest activity ≥ since" and "closed = status closed".
  const inWeek = (t: number | null) => t != null && t >= since && t < untilX;
  const week = all.filter((x) => inWeek(x.created) || inWeek(x.closed));
  const closedBy = (x: Seen, end: number) => !x.open && (x.closed == null || x.closed < end);
  const inPrev = (t: number | null) => t != null && t >= prevSince && t < since;
  const prev = all.filter((x) => inPrev(x.created) || inPrev(x.closed));
  const prevClosed = prev.filter((x) => closedBy(x, since)).length;

  let open = 0; let closed = 0; let located = 0;
  const types = new Map<string, WeekType>();
  const hoods = new Map<string, Omit<WeekHood, 'medianCloseDays'>>();
  const hoodDays = new Map<string, number[]>();
  const outcomes = Object.fromEntries(WEEK_OUTCOMES.map((k) => [k, 0])) as Record<WeekOutcome, number>;
  const closeDays: number[] = [];
  const notable: (WeekNotable & { sort: number })[] = [];
  const days = new Map<string, number>();

  for (const x of week) {
    const isClosed = closedBy(x, untilX);
    if (isClosed) closed++; else open++;
    const t = types.get(x.caseType) ?? { caseType: x.caseType, category: x.category, n: 0, prevN: 0 };
    t.n++; types.set(x.caseType, t);
    let hood: string | null = null;
    if (x.lat != null && x.lng != null) {
      located++;
      hood = hoodOf(x.lat, x.lng);
      if (hood) {
        const h = hoods.get(hood) ?? { name: hood, slug: hoodSlug(hood), n: 0, open: 0, closed: 0 };
        h.n++; if (isClosed) h.closed++; else h.open++;
        hoods.set(hood, h);
      }
    }
    if (inWeek(x.created)) {
      const d = dayInNewYork(x.created!);
      days.set(d, (days.get(d) ?? 0) + 1);
    }
    if (!isClosed) continue;
    const oc = outcomeOf(x.row as unknown as CaseLike) as Outcome;
    if (oc !== 'open') outcomes[oc as WeekOutcome]++;
    if (x.closed != null && x.created != null && x.closed >= x.created) {
      const d = (x.closed - x.created) / 86_400_000;
      closeDays.push(d);
      if (hood) { const ds = hoodDays.get(hood); if (ds) ds.push(d); else hoodDays.set(hood, [d]); }
    }
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
  const neighborhoods: WeekHood[] = [...hoods.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((h) => ({ ...h, medianCloseDays: medianDays(hoodDays.get(h.name) ?? []) }));
  notable.sort((a, b) => b.sort - a.sort);
  let busiestDay: WeekSummary['busiestDay'] = null;
  for (const [date, n] of days) if (!busiestDay || n > busiestDay.n || (n === busiestDay.n && date > busiestDay.date)) busiestDay = { date, n };

  return {
    days: WEEK_DAYS, since: new Date(since).toISOString(), until: new Date(w.until).toISOString(), at: new Date(now).toISOString(),
    untilDate: w.untilDate, prevUntil: w.prevUntil, nextUntil: w.nextUntil, current: w.current,
    total: week.length, open, closed, located,
    prev: { total: prev.length, closed: prevClosed },
    topTypes, neighborhoods, outcomes,
    medianCloseDays: medianDays(closeDays),
    notable: notable.slice(0, NOTABLE_N).map(({ sort: _s, ...rest }) => rest),
    busiestDay,
  };
}

// ── GET /api/week ─────────────────────────────────────────────────────────────────────────

/** One entry per week: 'now|<today>' for the current week (also `?until=<today>`), else the untilDate. */
const summaries = new Map<string, { at: number; body: string }>();

/** The summary as a response body, built at most once per 5 minutes per isolate per week (the rows come from
 *  street.ts's loadCases cache — one Firestore read per load window). `?until=` picks a past week: 400 `invalid_until`
 *  for a malformed or future date, 400 `too_old` beyond the 56-day archive floor. The current week reads 14 days
 *  (LOAD_LIMIT rows); every dated week reads the same MAX_LOAD_DAYS window with the deeper ARCHIVE_LOAD_LIMIT, so
 *  browsing the whole archive costs one read and the week at the floor is not the part a newest-first read cuts off.
 *  The current entry is keyed by its date too, so it is not served as "current" for five minutes past New York midnight. */
export async function handleWeek(url: URL, store: Store, now = Date.now()): Promise<Response> {
  const w = resolveWindow(url.searchParams.get('until'), now);
  if (typeof w === 'string') return json(JSON.stringify({ error: w }), 400);
  const key = w.current ? `now|${w.untilDate}` : w.untilDate;
  let hit = summaries.get(key);
  if (!hit || now - hit.at >= SUMMARY_TTL_MS) {
    const rows = w.current ? await loadCases(store, LOAD_DAYS, now, LOAD_LIMIT) : await loadCases(store, MAX_LOAD_DAYS, now, ARCHIVE_LOAD_LIMIT);
    hit = { at: now, body: JSON.stringify(weekSummary(rows, { now, until: w.untilDate })) };
    for (const [k, v] of summaries) if (now - v.at >= SUMMARY_TTL_MS) summaries.delete(k);
    summaries.set(key, hit);
  }
  return json(hit.body, 200, { 'cache-control': 'public, max-age=300' });
}

/** Tests: drop the in-isolate summary cache (street.ts's resetStreetCache drops the rows). */
export function resetWeekCache(): void { summaries.clear(); }

// ── The Monday mail ───────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const shortDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ }) : '');
const monthDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });

/** "+12 vs last week" / "-3 vs last week" / "same as last week". */
export function deltaText(n: number, prev: number): string {
  if (n === prev) return 'same as last week';
  return `${n > prev ? '+' : '-'}${Math.abs(n - prev)} vs last week`;
}

/** "4.5 days" / "1 day" — a 1-dp median as the mail writes it. */
const daysText = (d: number) => `${d} ${d === 1 ? 'day' : 'days'}`;

/** The reader's neighborhoods (2026-10-27): their saved addresses with coordinates, in the account's order, at most
 *  PLACES_MAX (the app's api/me placedAddresses — the places /week tags "Yours"), each through hoodOf; once each, a
 *  place outside every ring left out. Pure — the user doc is the one runWeekDigest already read; a malformed list or
 *  entry counts as no place rather than throwing the whole Monday run. */
export function readerHoods(addresses: readonly SavedAddress[] | null | undefined, hoodOf: HoodOf = sharedHoodOf): string[] {
  const out: string[] = [];
  for (const a of (Array.isArray(addresses) ? addresses : []).filter((a) => a?.lat != null && a?.lng != null).slice(0, PLACES_MAX)) {
    const h = hoodOf(a.lat!, a.lng!);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

/** The reader's first YOUR_HOODS_N hoods with this week's numbers — the summary's row, or a quiet one (n 0). */
function yourHoods(s: WeekSummary, hoods: readonly string[] | undefined): WeekHood[] {
  const byName = new Map(s.neighborhoods.map((h) => [h.name, h]));
  return (hoods ?? []).slice(0, YOUR_HOODS_N)
    .map((name) => byName.get(name) ?? { name, slug: hoodSlug(name), n: 0, open: 0, closed: 0, medianCloseDays: null });
}

/** Subject + HTML for the Monday mail — the week page's headline numbers, in the street digest's plain style.
 *  "See the whole week" is the DATED url (/week?until=<untilDate>), so the mail still means this week next month;
 *  the opt-out line points at the live page. `hoods` (readerHoods) adds "Your neighborhoods" under the headline: one
 *  line per hood (≤ 3, saved order) linked to its /street page, then the first of them with a median against the
 *  city's — the mail's take on /week's "Yours" rows and compare line (the page orders busiest first, the mail keeps the
 *  reader's saved order, so the two can compare different hoods). Without hoods the mail is exactly the shared one. */
export function weekDigestEmail(s: WeekSummary, o: { base: string; hoods?: readonly string[] }): { subject: string; html: string } {
  const base = o.base.replace(/\/+$/, '');
  const weekUrl = `${base}/week`;
  const datedUrl = s.untilDate ? `${weekUrl}?until=${s.untilDate}` : weekUrl;
  const subject = `This week in Providence: ${s.total} ${s.total === 1 ? 'request' : 'requests'}, ${s.closed} closed`;
  const li = (inner: string) => `<li style="margin:0 0 8px">${inner}</li>`;
  const section = (title: string, items: string[]) => (items.length
    ? `<h3 style="margin:1.2em 0 .3em">${esc(title)}</h3><ul style="padding-left:1.2em;margin:0">${items.join('')}</ul>` : '');
  // "Fox Point: 30 requests, 12 closed · median 4.5 days" (the median left out without a dated close) / "Elmhurst: nothing this week".
  const mine = yourHoods(s, o.hoods);
  const mineItems = mine.map((h) => li(`<a href="${esc(`${base}/street?n=${encodeURIComponent(h.slug)}`)}"><b>${esc(h.name)}</b></a>: `
    + (h.n === 0 ? 'nothing this week'
      : `${h.n} ${h.n === 1 ? 'request' : 'requests'}, ${h.closed} closed${h.medianCloseDays != null ? ` · median ${daysText(h.medianCloseDays)}` : ''}`)));
  const compare = s.medianCloseDays != null ? mine.find((h) => h.medianCloseDays != null) : undefined;
  const mineHtml = section(mine.length === 1 ? 'Your neighborhood' : 'Your neighborhoods', mineItems)
    + (compare ? `<p style="margin:.4em 0 0">Closed requests in ${esc(compare.name)} took a median ${daysText(compare.medianCloseDays!)} — the city's was ${s.medianCloseDays}.</p>` : '');
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
    + mineHtml
    + section('Most reported', types)
    + section('Busiest neighborhoods', hoods)
    + section("Closed this week, in the city's words", notable)
    + `<p style="margin:1.2em 0 0"><a href="${esc(datedUrl)}">See the whole week</a></p>`
    + `<p style="color:#888;margin-top:2em">You asked for this every Monday on FixMyPVD — turn it off on <a href="${esc(weekUrl)}">the week page</a> or under <a href="${esc(base)}/account">Account</a>. `
    + `FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  return { subject, html };
}

/** The Monday push (push.ts) for the same week: "<total> requests · <closed> closed", opening the dated page; with
 *  `hoods`, the first of the mail's "Your neighborhoods" with activity rides along — " · Fox Point: 30 requests, median
 *  4.5 d" (the median left out without one): ≤ ~55 characters more with the longest hood name and four-digit counts. */
export function weekDigestPush(s: WeekSummary, o: { base: string; hoods?: readonly string[] }): PushPayload {
  const h = yourHoods(s, o.hoods).find((x) => x.n > 0);
  const mine = h ? ` · ${h.name}: ${h.n} request${h.n === 1 ? '' : 's'}${h.medianCloseDays != null ? `, median ${h.medianCloseDays} d` : ''}` : '';
  return { title: 'This week in Providence', body: `${s.total} request${s.total === 1 ? '' : 's'} · ${s.closed} closed${mine}`, url: `${o.base.replace(/\/+$/, '')}/week?until=${s.untilDate}`, tag: 'week' };
}

/** Rob's post (admin mail, Mondays): the week as the r/providence Markdown post — shared/weekPost.ts, byte for byte
 *  what /week's "Copy as post" copies — in a pre-wrap <pre> so it pastes as written, with the dated week page beside
 *  it for the button. The subject is what mailer.alert prefixes with "[FixMyPVD] " (emaillog inferKind → admin_digest). */
export function weekPostAdminEmail(s: WeekSummary, o: { base: string }): { subject: string; html: string } {
  const base = o.base.replace(/\/+$/, '');
  const datedUrl = `${base}/week${s.untilDate ? `?until=${s.untilDate}` : ''}`;
  const range = weekPostRange(s);
  const md = weekPostMarkdown(s, { base });
  const subject = 'Your r/providence post for this week';
  const html = `<p style="margin:0 0 1em">Last week in Providence${range ? ` (${esc(range)})` : ''} — ${s.total.toLocaleString('en-US')} ${s.total === 1 ? 'request' : 'requests'}, ${s.closed.toLocaleString('en-US')} closed — as a ready post for r/providence; paste it as is or trim.</p>`
    + `<pre style="white-space:pre-wrap;font:inherit;margin:0;padding:12px;border-left:3px solid #ccc">${esc(md)}\n</pre>\n`
    + `<p style="margin:1.2em 0 0"><a href="${esc(datedUrl)}">Copy it from the week page</a></p>`
    + `<p style="color:#888;margin-top:2em">FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  return { subject, html };
}

/** Mondays (runDaily, after runStreetDigest): one mail per opted-in verified account, the same numbers on their
 *  subscribed phones, then ONE admin mail to Rob with the week as the r/providence post (whether or not anyone opted in);
 *  nothing at all when the week had no cases. The week is the Monday–Sunday calendar week that just ended (`until` =
 *  yesterday, New York) — the same window its dated link resolves to forever, so the page a reader opens on Tuesday
 *  shows the numbers that were mailed. (Built on the 168 h ending at the 07:00 cron, the link would mean a different,
 *  Tue–Mon week from the next day on.) Returns counts for the log; `adminMailed` = the post went to mailer.alert (which
 *  never throws — a failed send is in the email log). */
export async function runWeekDigest(env: Env, store: Store, mailer: Mailer, opts: { now?: number } = {}): Promise<{ users: number; mailed: number; pushed: number; adminMailed: boolean }> {
  const now = opts.now ?? Date.now();
  const base = env.APP_BASE_URL ?? 'https://fixmypvd.org';
  const users = await store.listWeekDigestUsers(500);
  const optedIn = users.filter((u) => u.prefs?.weekDigest === true);
  const eligible = optedIn.filter((u) => !!u.email && !!u.emailVerified);
  const phones = optedIn.filter(hasPush); // a subscription is its own opt-in: the pref gates the digest, not the mailbox
  let mailed = 0; let pushed = 0; let adminMailed = false;
  // Built every Monday, opted-in residents or none: Rob's post needs it too (one loadCases read).
  const until = addDays(etDate(now), -1);
  const summary = weekSummary(await loadCases(store, LOAD_DAYS + 1, now), { now, until });
  const total = summary.total;
  if (total > 0) {
    // "Your neighborhoods": each reader's hoods from the user docs read above (≤ 5 points each, no further read); a reader
    // without a placed address in a ring gets the shared mail and push, built once — exactly what everyone got before.
    const hoods = new Map<UserDoc, string[]>(optedIn.map((u) => [u, readerHoods(u.addresses)]));
    if (eligible.length) {
      const shared = weekDigestEmail(summary, { base });
      for (const u of eligible) {
        const mine = hoods.get(u)!;
        const m = mine.length ? weekDigestEmail(summary, { base, hoods: mine }) : shared;
        await mailer.sendTo(u.email!, m.subject, m.html, { kind: 'week_digest' });
        mailed++;
      }
    }
    // The same numbers on subscribed phones (push.ts) — alongside the mail, never instead of it; a failed push fails alone.
    if (phones.length) {
      try {
        const keys = await ensureVapid(store);
        for (const u of phones) pushed += await pushAll(store, u, weekDigestPush(summary, { base, hoods: hoods.get(u) }), keys);
      } catch (e) { console.error('[week] digest push failed:', e instanceof Error ? e.message : e); }
      await logPushes(store, 'week_digest', { users: phones.length, sent: pushed });
    }
    // Rob's r/providence post, after the residents' mails — one per run, however many (or few) opted in.
    const post = weekPostAdminEmail(summary, { base });
    await mailer.alert(post.subject, post.html, { kind: 'admin_digest' });
    adminMailed = true;
  }
  console.log(`[week] digest: ${mailed} of ${users.length} opted-in accounts mailed, ${pushed} pushes${adminMailed ? ', the post mailed to admin' : ''}${total === 0 ? ' (empty week, skipped)' : ''}`);
  await logEvent(store, { level: 'info', kind: 'week.digest', msg: total === 0 ? 'Weekly city digest: the week had no cases — no mail sent' : `Weekly city digest: ${mailed} of ${users.length} opted-in accounts mailed; the r/providence post mailed to admin`, data: { users: users.length, mailed, pushed, total, adminMailed } });
  await store.setMeta('weekDigest', { at: new Date(now).toISOString(), users: users.length, mailed, pushed, total, adminMailed }).catch(() => {});
  return { users: users.length, mailed, pushed, adminMailed };
}
