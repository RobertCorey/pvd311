/**
 * week311.ts — "This week in 311": Rob's Monday read of the whole city's 311 week, written up.
 *
 * Rob, 2026-11-15: "a once-a-week email … not just our stuff … the 311 platform as a whole. An overview, maybe related
 * back to events or weather, and if there's one particular case that's funny or interesting, highlight it." Rob only for
 * now (he picked trying it on himself before subscribers get it); weather only, no events feed (a model asked about
 * events invents them).
 *
 * The numbers are week.ts's weekSummary — the same week /week and the Monday digest show. Added on top:
 *   weather       Open-Meteo daily (no key), Providence, the week's New York days
 *   write-up      one Claude call over the summary, the weather and every case of the week (type, street, hood, day,
 *                 status, the city's Resolution Message, fixed-choice answers only — street.ts publicAnswer, so no plates
 *                 or names): a short overview and one "case of the week", picked from the list by id
 * Without the weather or the write-up (no key, error) the mail still goes, with the parts it has.
 *
 *   Mondays       runWeekDigest (week.ts) mails it to Rob via mailer.alert after the r/providence post, kind admin_digest
 *   GET /api/admin/week311?until=YYYY-MM-DD   the same mail as JSON { subject, html, … } — a preview, sends nothing
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Env, Mailer, Store } from './contracts.js';
import { addDays, dayInNewYork, LOAD_DAYS, MAX_LOAD_DAYS, ARCHIVE_LOAD_LIMIT, resolveWindow, WEEK_DAYS, weekEnd, weekSummary, type WeekSummary } from './week.js';
import { firstCaseDay, loadCases, LOAD_LIMIT, publicAnswer } from './street.js';
import { etDate } from './quota.js';
import { hoodOf } from '../../shared/neighborhoods.js';
import type { AnswerKind } from './citycases.js';

const TZ = 'America/New_York';
const MODEL = 'claude-opus-5-5';
/** Cases handed to the write-up; a week is ~250–350. */
export const AI_CASES_MAX = 400;

// ── Weather ───────────────────────────────────────────────────────────────────────────────

export interface WeatherDay { date: string; hiF: number | null; loF: number | null; rainIn: number; snowIn: number; windMph: number | null; sky: string }

/** WMO weather codes → a word (Open-Meteo's `weather_code`). */
export function skyOf(code: number | null | undefined): string {
  if (code == null) return '';
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code <= 48) return 'fog';
  if (code <= 57) return 'drizzle';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'showers';
  if (code <= 86) return 'snow showers';
  return 'thunderstorms';
}

/** Daily weather for Providence over [from, to] (New York dates); null when Open-Meteo fails. */
export async function fetchWeather(from: string, to: string, fetchImpl: typeof fetch = fetch): Promise<WeatherDay[] | null> {
  const q = new URLSearchParams({
    latitude: '41.824', longitude: '-71.413', timezone: TZ, start_date: from, end_date: to,
    daily: 'temperature_2m_max,temperature_2m_min,rain_sum,snowfall_sum,wind_speed_10m_max,weather_code',
    temperature_unit: 'fahrenheit', precipitation_unit: 'inch', wind_speed_unit: 'mph',
  });
  try {
    const r = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = ((await r.json()) as { daily?: Record<string, (number | string | null)[]> }).daily;
    if (!d?.time?.length) return null;
    const n = (k: string, i: number) => { const v = d[k]?.[i]; return typeof v === 'number' ? v : null; };
    return d.time.map((date, i) => ({
      date: String(date), hiF: round(n('temperature_2m_max', i)), loF: round(n('temperature_2m_min', i)),
      rainIn: +(n('rain_sum', i) ?? 0).toFixed(2), snowIn: +(n('snowfall_sum', i) ?? 0).toFixed(1), // inches (precipitation_unit applies to snow too)
      windMph: round(n('wind_speed_10m_max', i)), sky: skyOf(n('weather_code', i)),
    }));
  } catch (e) {
    console.error('[week311] weather failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
const round = (v: number | null) => (v == null ? null : Math.round(v));

// ── The week's cases, for the write-up ───────────────────────────────────────────────────

type Row = Record<string, unknown>;
export interface CaseLine { id: string; type: string; street: string; hood: string | null; day: string; status: string; resolution: string | null; answers: string[] }

/** Every non-draft case created in [since, until] — what the city heard this week — newest last. */
export function weekCases(rows: Row[], s: Pick<WeekSummary, 'since' | 'until'>): CaseLine[] {
  const since = Date.parse(s.since); const until = Date.parse(s.until);
  const out: (CaseLine & { t: number })[] = [];
  for (const c of rows) {
    if (/^draft$/i.test(String(c.status ?? ''))) continue;
    const t = typeof c.createdAt === 'string' ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(c.createdAt) ? c.createdAt : c.createdAt + 'Z') : NaN;
    if (!(t >= since && t <= until)) continue;
    const d = (c.detail ?? null) as { resolution?: string | null; answers?: Record<string, string | true>; labels?: Record<string, string>; kinds?: Record<string, AnswerKind> } | null;
    const answers: string[] = [];
    for (const [id, v] of Object.entries(d?.answers ?? {})) {
      const label = d?.labels?.[id] ?? '';
      if (label && publicAnswer(id, label, v, d?.kinds?.[id])) answers.push(`${label}: ${v === true ? 'Yes' : v}`);
    }
    const lat = typeof c.lat === 'number' ? c.lat : null; const lng = typeof c.lng === 'number' ? c.lng : null;
    out.push({
      id: String(c.id), type: String(c.caseType ?? ''), street: String(c.street ?? '').trim(),
      hood: lat != null && lng != null ? hoodOf(lat, lng) : null, day: dayInNewYork(t), status: String(c.status ?? ''),
      resolution: d?.resolution?.trim().slice(0, 300) || null, answers, t,
    });
  }
  return out.sort((a, b) => a.t - b.t).map(({ t: _t, ...x }) => x);
}

// ── The write-up ─────────────────────────────────────────────────────────────────────────

export interface WriteUp { overview: string; pick: { id: string; headline: string; blurb: string } | null }

const SYSTEM = `You write "This week in 311", a short weekly email about Providence, Rhode Island's public 311 requests (the city's service-request system: potholes, missed trash, rats, streetlights, abandoned cars and so on). The reader lives in Providence.

You get the week's numbers, the daily weather, and every request the city received this week. Write two things:

1. overview: 3 to 5 plain sentences on what the week looked like. Lead with what stood out (what people reported most, what jumped or dropped against last week, a busy day or neighborhood). Tie it to the weather only where the timing in the data supports it, and say it as a likely link, not a proven cause. Use the numbers you were given; do not compute new statistics beyond simple comparisons.

2. caseOfWeek: the single request that is the funniest, oddest or most human, with its id from the list, a headline of at most 8 words, and a blurb of 1 or 2 sentences that says what happened using only that request's own fields. Be warm and wry, never mocking the person who reported it or city workers. If nothing stands out, pick the most interesting one anyway.

Only state facts that are in the data. Do not mention holidays, events, games or news; you have no information about them. No names of people, no license plates. No exclamation marks, no emoji.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['overview', 'caseOfWeek'],
  properties: {
    overview: { type: 'string' },
    caseOfWeek: { type: 'object', additionalProperties: false, required: ['id', 'headline', 'blurb'], properties: { id: { type: 'string' }, headline: { type: 'string' }, blurb: { type: 'string' } } },
  },
} as const;

/** The model's input: the numbers, the weather, the cases as compact lines. */
export function writeUpInput(s: WeekSummary, weather: WeatherDay[] | null, cases: CaseLine[]): string {
  const nums = {
    week: `${s.since.slice(0, 10)} to ${s.until.slice(0, 10)}${s.current ? ' (week in progress, through ' + new Date(s.until).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', timeZone: TZ }) + ')' : ''}`,
    requests: s.total, closed: s.closed, lastWeek: s.prev,
    medianDaysToClose: s.medianCloseDays,
    topTypes: s.topTypes.map((t) => `${t.caseType}: ${t.n} (last week ${t.prevN})`),
    busiestNeighborhoods: s.neighborhoods.slice(0, 5).map((h) => `${h.name}: ${h.n}`),
    busiestDay: s.busiestDay, closedBy: s.outcomes,
  };
  const wx = weather?.map((d) => `${d.date} ${weekday(d.date)}: ${d.hiF}°/${d.loF}°F, ${d.sky}${d.rainIn ? `, rain ${d.rainIn} in` : ''}${d.snowIn ? `, snow ${d.snowIn} in` : ''}${d.windMph ? `, wind to ${d.windMph} mph` : ''}`) ?? ['(weather unavailable)'];
  const lines = cases.slice(-AI_CASES_MAX).map((c) => [c.id, c.day, c.type, c.street, c.hood ?? '', c.status, c.answers.join('; '), c.resolution ? `city: ${c.resolution.replace(/\s+/g, ' ')}` : ''].join(' | '));
  return `NUMBERS\n${JSON.stringify(nums, null, 1)}\n\nWEATHER\n${wx.join('\n')}\n\nREQUESTS (id | day | type | street | neighborhood | status | details | city's closing note)\n${lines.join('\n')}`;
}

/** One Claude call; null when there is no key or it fails. The pick is dropped unless its id is one of `cases`. */
export async function writeUp(env: Pick<Env, 'ANTHROPIC_API_KEY'>, s: WeekSummary, weather: WeatherDay[] | null, cases: CaseLine[]): Promise<WriteUp | null> {
  if (!env.ANTHROPIC_API_KEY || !cases.length) return null;
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 });
    const r = await client.beta.messages.create({
      model: MODEL, max_tokens: 16_000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA as unknown as Record<string, unknown> } },
      system: SYSTEM, messages: [{ role: 'user', content: writeUpInput(s, weather, cases) }],
    });
    if (r.stop_reason === 'refusal') throw new Error('refused');
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const o = JSON.parse(text) as { overview?: string; caseOfWeek?: { id?: string; headline?: string; blurb?: string } };
    const c = o.caseOfWeek;
    const pick = c?.id && cases.some((x) => x.id === c.id) && c.headline && c.blurb ? { id: c.id, headline: c.headline, blurb: c.blurb } : null;
    return { overview: (o.overview ?? '').trim(), pick };
  } catch (e) {
    console.error('[week311] write-up failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

// ── The mail ─────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const monthDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });
const vs = (n: number, prev: number) => (prev ? ` <span style="color:#888">(last week ${prev})</span>` : '');

export function week311Email(s: WeekSummary, o: { base: string; weather: WeatherDay[] | null; cases: CaseLine[]; ai: WriteUp | null }): { subject: string; html: string } {
  const base = o.base.replace(/\/+$/, '');
  const url = `${base}/week?until=${s.untilDate}`;
  const range = `${monthDay(s.since)} – ${monthDay(s.until)}`;
  const subject = `This week in 311 (${range}): ${s.total.toLocaleString('en-US')} requests`;
  const h3 = (t: string) => `<h3 style="margin:1.4em 0 .4em">${esc(t)}</h3>`;
  const li = (inner: string) => `<li style="margin:0 0 6px">${inner}</li>`;

  const overview = o.ai?.overview ? `<p style="font-size:1.05em;line-height:1.5;margin:0 0 1em">${esc(o.ai.overview)}</p>` : '';
  const numbers = `<p style="margin:0"><b>${s.total.toLocaleString('en-US')}</b> requests${vs(s.total, s.prev.total)} · <b>${s.closed.toLocaleString('en-US')}</b> closed${vs(s.closed, s.prev.closed)}`
    + (s.medianCloseDays != null ? ` · median ${s.medianCloseDays} days to close` : '') + '</p>'
    + (s.current ? `<p style="color:#888;margin:.3em 0 0">Week in progress, counted through ${esc(new Date(s.until).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ }))}.</p>` : '');

  const c = o.ai?.pick ? o.cases.find((x) => x.id === o.ai!.pick!.id) : undefined;
  const pick = c && o.ai?.pick
    ? h3('Case of the week')
      + `<div style="border-left:3px solid #F26A2E;padding:4px 0 4px 12px">`
      + `<p style="margin:0 0 .3em;font-weight:bold">${esc(o.ai.pick.headline)}</p>`
      + `<p style="margin:0 0 .4em;line-height:1.5">${esc(o.ai.pick.blurb)}</p>`
      + `<p style="margin:0;color:#666;font-size:.9em">${esc([c.type, c.street, c.hood].filter(Boolean).join(' · '))} · ${esc(weekday(c.day))} · ${esc(c.status)}</p>`
      + (c.resolution ? `<p style="margin:.3em 0 0;color:#666;font-size:.9em">The city: “${esc(c.resolution)}”</p>` : '')
      + `</div>` : '';

  const types = s.topTypes.slice(0, 5).map((t) => li(`${esc(t.caseType)} · <b>${t.n}</b>${vs(t.n, t.prevN)}`));
  const hoods = s.neighborhoods.slice(0, 3).map((h) => li(`${esc(h.name)} · <b>${h.n}</b>`));
  const wx = o.weather?.length
    ? h3('Weather') + `<table style="border-collapse:collapse;font-size:.92em">${o.weather.map((d) => `<tr><td style="padding:1px 10px 1px 0;color:#666">${weekday(d.date)}</td>`
      + `<td style="padding:1px 10px 1px 0">${d.hiF ?? '–'}° / ${d.loF ?? '–'}°</td><td style="padding:1px 0">${esc([d.sky, d.rainIn ? `${d.rainIn} in rain` : '', d.snowIn ? `${d.snowIn} in snow` : ''].filter(Boolean).join(', '))}</td></tr>`).join('')}</table>`
    : '';

  const html = `<h2 style="margin:0 0 .2em">This week in 311</h2>`
    + `<p style="color:#666;margin:0 0 1em">Providence, ${esc(range)}</p>`
    + overview + numbers + pick
    + (types.length ? h3('Most reported') + `<ul style="padding-left:1.2em;margin:0">${types.join('')}</ul>` : '')
    + (hoods.length ? h3('Busiest neighborhoods') + `<ul style="padding-left:1.2em;margin:0">${hoods.join('')}</ul>` : '')
    + wx
    + `<p style="margin:1.4em 0 0"><a href="${esc(url)}">The whole week on FixMyPVD</a></p>`
    + `<p style="color:#888;margin-top:2em;font-size:.85em">From the city's public 311 list. Written up by Claude from that list and Open-Meteo's weather; numbers are counted, not written.</p>`;
  return { subject, html };
}

/** The mail for a week: `until` (any day of it, New York) or the last whole week before `now`. */
export async function buildWeek311(env: Env, store: Store, o: { now?: number; until?: string | null; fetchImpl?: typeof fetch } = {}): Promise<{ subject: string; html: string; summary: WeekSummary; ai: WriteUp | null; weather: boolean; cases: number } | null> {
  const now = o.now ?? Date.now();
  const until = o.until || weekEnd(addDays(etDate(now), -WEEK_DAYS));
  const w = resolveWindow(until, now);
  if (typeof w === 'string') throw new Error(w);
  const [days, limit] = w.current ? [LOAD_DAYS, LOAD_LIMIT] : [MAX_LOAD_DAYS, ARCHIVE_LOAD_LIMIT];
  const rows = await loadCases(store, days, now, limit);
  const s = weekSummary(rows, { now, until: w.untilDate, firstDay: firstCaseDay(rows, days, now, limit) });
  if (s.total === 0) return null;
  const cases = weekCases(rows, s);
  const weather = await fetchWeather(addDays(w.untilDate, 1 - WEEK_DAYS), w.current ? etDate(now) : w.untilDate, o.fetchImpl);
  const ai = await writeUp(env, s, weather, cases);
  const m = week311Email(s, { base: env.APP_BASE_URL ?? 'https://fixmypvd.org', weather, cases, ai });
  return { ...m, summary: s, ai, weather: !!weather, cases: cases.length };
}

/** Mondays (week.ts runWeekDigest): the last whole week to Rob. Never throws. */
export async function runWeek311(env: Env, store: Store, mailer: Mailer, now = Date.now()): Promise<boolean> {
  try {
    const m = await buildWeek311(env, store, { now });
    if (!m) return false;
    await mailer.alert(m.subject, m.html, { kind: 'admin_digest' });
    return true;
  } catch (e) {
    console.error('[week311] failed:', e instanceof Error ? e.message : e);
    return false;
  }
}
