/** "Copy as post" on /week: the week summary as a short Markdown post for r/providence or Nextdoor (Rob posts the
 *  week by hand every Monday). Pure — no React, no window — so it is unit-tested for the exact string. The post is
 *  English whatever language the app is in (it goes to an English-language forum; only the button is i18n), so the
 *  labels come from the English dictionary unless the caller passes its own `t`. Lines that have nothing to say
 *  (no median, no closes with a note, no neighborhoods) are left out rather than written as zeros. */
import en from '../i18n/strings.en.json' with { type: 'json' };
import type { WeekNotable, WeekOutcome, WeekSummary } from '../api/week';
import { groupOf } from './categories';
import { addDays, WEEK_TZ, YMD } from './week';

export type PostT = (key: string, vars?: Record<string, string | number>) => string;
const EN = en as Record<string, string>;
/** The English strings, with the same `{var}` substitution as the app's t(). */
export const tEn: PostT = (key, vars) => {
  let s = EN[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
};

export interface WeekPostOpts {
  /** Site origin for the link line, no trailing slash (BRAND.siteUrl: https://fixmypvd.org in production). */
  base: string;
  t?: PostT;
}

/** How many of each list the post carries. */
export const POST_TOP = 3;

const num = (n: number): string => n.toLocaleString('en-US');
const MD: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const dayOfIso = (iso: string): string => { const ms = Date.parse(iso); return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-US', { ...MD, timeZone: WEEK_TZ }) : ''; };
const dayOfYmd = (ymd: string): string => { const m = YMD.exec(ymd); return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)).toLocaleDateString('en-US', { ...MD, timeZone: 'UTC' }) : ''; };
/** One line: newlines and runs of spaces in the city's note become single spaces. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** "Oct 18 – Oct 25": the page's own range — since/until (Providence days) for the current week, the seven calendar
 *  days ending untilDate for a dated one; '' when neither is usable. */
export function weekPostRange(s: WeekSummary): string {
  if (s.current || !s.untilDate) {
    const a = dayOfIso(s.since), b = dayOfIso(s.until);
    if (a && b) return `${a} – ${b}`;
  }
  const to = dayOfYmd(s.untilDate), from = dayOfYmd(addDays(s.untilDate, -6));
  return to && from ? `${from} – ${to}` : '';
}

/** The post. Paragraphs separated by blank lines, no trailing newline. */
export function weekPostMarkdown(s: WeekSummary, o: WeekPostOpts): string {
  const t = o.t ?? tEn;
  const typeName = (caseType: string, category: string) => caseType || t(`street.g.${groupOf(category) ?? 'other'}`);
  const range = weekPostRange(s);
  const out: string[] = [];

  out.push(`**This week in Providence${range ? ` (${range})` : ''}**`);

  // 312 requests to 311 (+22 vs last week), 114 closed, median 3.5 days to close.
  const d = s.total - s.prev.total;
  const delta = d > 0 ? `+${num(d)} vs last week` : d < 0 ? `−${num(-d)} vs last week` : 'same as last week';
  const parts = [`${num(s.total)} ${s.total === 1 ? 'request' : 'requests'} to 311 (${delta})`, `${num(s.closed)} closed`];
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
  const outcomes = (Object.entries(s.outcomes) as [WeekOutcome, number][]).filter(([, n]) => n > 0);
  const closedSum = outcomes.reduce((a, [, n]) => a + n, 0);
  if (closedSum > 0) {
    const ranked = [...outcomes].sort((a, b) => b[1] - a[1]).slice(0, POST_TOP);
    const text = ranked.map(([o, n]) => `${Math.round((100 * n) / closedSum)}% ${lowerFirst(t(`week.outcome.${o}`))}`).join(', ');
    out.push(`What closing meant: ${text}${outcomes.length > POST_TOP ? '…' : '.'}`);
  }

  const notable = s.notable.slice(0, POST_TOP);
  if (notable.length) out.push(notable.map((x) => notableLine(x, typeName)).join('\n'));

  out.push(`Full week, map and the city's own notes: ${o.base}/week${s.untilDate ? `?until=${s.untilDate}` : ''}`);
  out.push("From Providence 311's public request list. Not affiliated with the city.");
  return out.join('\n\n');
}

/** - Street Light Out, 22 Thayer St (College Hill): "Bulb replaced." — street and neighborhood only when given. */
function notableLine(x: WeekNotable, typeName: (caseType: string, category: string) => string): string {
  const where = x.street ? `, ${x.street}` : '';
  const hood = x.neighborhood ? ` (${x.neighborhood})` : '';
  const note = oneLine(x.resolution);
  return `- ${typeName(x.caseType, x.category)}${where}${hood}${note ? `: "${note}"` : ''}`;
}
