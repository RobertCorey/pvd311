/**
 * weekPost.ts — "This week in Providence" as a short Markdown post for r/providence or Nextdoor. Rob posts the week by
 * hand every Monday (typing costs him), so the same builder serves two places and must produce the same bytes in both:
 *
 *   app  /week "Copy as post"            app/src/lib/weekPost.ts re-exports this module
 *   worker  the Monday admin mail        worker/src/week.ts weekPostAdminEmail → mailer.alert, from runWeekDigest
 *
 * Pure — no React, no window, no JSON imports (the app's Playwright runner and the Worker's vitest both load it as plain
 * TS). The post is English whatever language the app is in (it goes to an English-language forum; only the button is
 * i18n), so the two label families it needs — what closing meant, and a group's name for a case with no city type —
 * are inlined here (OUTCOME_LABELS_EN / GROUP_LABELS_EN, the app dictionary's `week.outcome.*` / `group.*` values;
 * worker/test/week.test.ts checks they still match it) unless the caller passes its own `t`. Lines that have nothing
 * to say (no median, no closes with a note, no neighborhoods) are left out rather than written as zeros, and so is
 * "vs last week" when either week is not a whole one (`compare` false: the week in progress, or a week of data that
 * starts mid-week).
 */
import { CATEGORIES, type GroupKey } from './categories.js';

// ── The input: the fields of GET /api/week's body that the post reads (app/src/api/week.ts and worker/src/week.ts
//    both define the full WeekSummary; either is assignable here) ──────────────────────────────────────────────────

export type WeekPostOutcome = 'work_done' | 'enforcement' | 'referred' | 'logged_elsewhere' | 'info_only' | 'no_action' | 'cancelled';
export interface WeekPostType { caseType: string; category: string; n: number }
export interface WeekPostHood { name: string; n: number }
export interface WeekPostNotable { caseType: string; category: string; street: string; neighborhood: string | null; resolution: string }
export interface WeekPostSummary {
  /** The window (ISO). Read for the title's range when `current` or when there is no `untilDate`. */
  since: string; until: string;
  /** The New York calendar date the week ends on — the `?until=` of the link line; '' links the live page. */
  untilDate: string;
  current: boolean;
  total: number; closed: number;
  prev: { total: number };
  /** Both weeks are whole, so the change is worth saying (GET /api/week `compare`); missing = true. */
  compare?: boolean;
  topTypes: WeekPostType[];
  neighborhoods: WeekPostHood[];
  outcomes: Record<WeekPostOutcome, number>;
  medianCloseDays: number | null;
  /** Newest close first, as the Worker sends them. */
  notable: WeekPostNotable[];
}

export type PostT = (key: string, vars?: Record<string, string | number>) => string;

export interface WeekPostOpts {
  /** Site origin for the link line, no trailing slash (https://fixmypvd.org in production). */
  base: string;
  /** Labels for `week.outcome.<o>` and `group.<group>`; the inlined English ones when omitted. */
  t?: PostT;
}

// ── English labels (the app dictionary's values, kept in step by a worker test) ─────────────────────────────────

export const OUTCOME_LABELS_EN: Record<WeekPostOutcome, string> = {
  work_done: 'Work done',
  enforcement: 'Citation or enforcement',
  referred: 'Referred elsewhere',
  logged_elsewhere: 'Logged in another system',
  info_only: 'Information only',
  no_action: 'Nothing found',
  cancelled: 'Cancelled or merged',
};
export const GROUP_LABELS_EN: Record<GroupKey, string> = {
  trash: 'Trash & recycling', streets: 'Streets & sidewalks', traffic: 'Traffic, signs & parking', trees: 'Trees, parks & yards',
  property: 'Buildings & property', lights: 'Lights & wires', nuisance: 'Noise & neighborhood', water: 'Water, sewer & gas',
  animals: 'Animals & pests', other: 'Something else',
};
const LABELS_EN: Record<string, string> = {
  ...Object.fromEntries(Object.entries(OUTCOME_LABELS_EN).map(([k, v]) => [`week.outcome.${k}`, v])),
  ...Object.fromEntries(Object.entries(GROUP_LABELS_EN).map(([k, v]) => [`group.${k}`, v])),
};
/** `{var}` substitution, as the app's t() does it. */
export const substitute = (s: string, vars?: Record<string, string | number>): string => {
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
};
/** The default `t`: the post's two label families in English, keyed like the app's dictionary; any other key comes
 *  back as itself (the app's tEn falls back to this for keys its dictionary lacks). */
export const labelsEn: PostT = (key, vars) => substitute(LABELS_EN[key] ?? key, vars);

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How many of each list the post carries. */
export const POST_TOP = 3;

/** Providence's clock: the Worker names days in America/New_York. */
const WEEK_TZ = 'America/New_York';
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A YYYY-MM-DD plus n days, as YYYY-MM-DD (calendar arithmetic in UTC, so no zone can shift the day). */
const addDays = (ymd: string, n: number): string => {
  const m = YMD.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
};
/** The picker group of a category key (shared/categories.ts), for a case the city left without a type name. */
const groupOf = (category: string): GroupKey | null => CATEGORIES[category]?.group ?? null;

const num = (n: number): string => n.toLocaleString('en-US');
const MD: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const dayOfIso = (iso: string): string => { const ms = Date.parse(iso); return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-US', { ...MD, timeZone: WEEK_TZ }) : ''; };
const dayOfYmd = (ymd: string): string => { const m = YMD.exec(ymd); return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)).toLocaleDateString('en-US', { ...MD, timeZone: 'UTC' }) : ''; };
/** One line: newlines and runs of spaces in the city's note become single spaces. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** "Oct 19 – Oct 25": the page's own range — Monday to today (since/until, Providence days) for the week in progress,
 *  Monday to Sunday (the seven calendar days ending untilDate) for a past one; '' when neither is usable. */
export function weekPostRange(s: Pick<WeekPostSummary, 'since' | 'until' | 'untilDate' | 'current'>): string {
  if (s.current || !s.untilDate) {
    const a = dayOfIso(s.since), b = dayOfIso(s.until);
    if (a && b) return `${a} – ${b}`;
  }
  const to = dayOfYmd(s.untilDate), from = dayOfYmd(addDays(s.untilDate, -6));
  return to && from ? `${from} – ${to}` : '';
}

/** The post. Paragraphs separated by blank lines, no trailing newline. */
export function weekPostMarkdown(s: WeekPostSummary, o: WeekPostOpts): string {
  const t = o.t ?? labelsEn;
  const typeName = (caseType: string, category: string) => caseType || t(`group.${groupOf(category) ?? 'other'}`);
  const range = weekPostRange(s);
  const out: string[] = [];

  out.push(`**This week in Providence${range ? ` (${range})` : ''}**`);

  // 312 requests to 311 (+22 vs last week), 114 closed, median 3.5 days to close.
  const d = s.total - s.prev.total;
  const delta = s.compare === false ? '' : d > 0 ? ` (+${num(d)} vs last week)` : d < 0 ? ` (−${num(-d)} vs last week)` : ' (same as last week)';
  const parts = [`${num(s.total)} ${s.total === 1 ? 'request' : 'requests'} to 311${delta}`, `${num(s.closed)} closed`];
  if (s.medianCloseDays != null) {
    const m = Math.round(s.medianCloseDays * 10) / 10;
    parts.push(`median ${num(m)} ${m === 1 ? 'day' : 'days'} to close`);
  }
  out.push(`${parts.join(', ')}.`);

  const top = s.topTypes.slice(0, POST_TOP);
  if (top.length) out.push(`Most reported: ${top.map((x) => `${typeName(x.caseType, x.category)} (${num(x.n)})`).join(', ')}.`);

  const hoods = s.neighborhoods.slice(0, POST_TOP);
  if (hoods.length) out.push(`Busiest: ${hoods.map((h) => `${h.name} (${num(h.n)})`).join(', ')}.`);

  // Top outcomes by share (ties keep the dictionary's order); "…" when there are more than the three named.
  const outcomes = (Object.entries(s.outcomes) as [WeekPostOutcome, number][]).filter(([, n]) => n > 0);
  const closedSum = outcomes.reduce((a, [, n]) => a + n, 0);
  if (closedSum > 0) {
    const ranked = [...outcomes].sort((a, b) => b[1] - a[1]).slice(0, POST_TOP);
    const text = ranked.map(([oc, n]) => `${Math.round((100 * n) / closedSum)}% ${lowerFirst(t(`week.outcome.${oc}`))}`).join(', ');
    out.push(`What closing meant: ${text}${outcomes.length > POST_TOP ? '…' : '.'}`);
  }

  const notable = s.notable.slice(0, POST_TOP);
  if (notable.length) out.push(notable.map((x) => notableLine(x, typeName)).join('\n'));

  out.push(`Full week and the city's own notes: ${o.base}/week${s.untilDate ? `?until=${s.untilDate}` : ''}`);
  out.push("From Providence 311's public request list. Not affiliated with the city.");
  return out.join('\n\n');
}

/** - Street Light Out, 22 Thayer St (College Hill): "Bulb replaced." — street and neighborhood only when given. */
function notableLine(x: WeekPostNotable, typeName: (caseType: string, category: string) => string): string {
  const where = x.street ? `, ${x.street}` : '';
  const hood = x.neighborhood ? ` (${x.neighborhood})` : '';
  const note = oneLine(x.resolution);
  return `- ${typeName(x.caseType, x.category)}${where}${hood}${note ? `: "${note}"` : ''}`;
}
