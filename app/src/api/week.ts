// "This week in Providence": GET /api/week (worker/src/week.ts) — 7 days of the city's public 311 list against the 7
// before. One public, cached endpoint; the page (screens/Week.tsx) renders it and the Monday 'week_digest' mail is the
// same numbers. `?until=YYYY-MM-DD` (a New York calendar date) picks a past week so a shared link keeps its meaning;
// the body carries `untilDate` / `prevUntil` / `nextUntil` / `current` for the page's stable Share url and week nav.
// Cached here for 5 minutes per week so a tab return or a step back and forth never refetches.
import { apiFetch, parseError, withTimeout } from './client';

/** classifyResolution / outcomeOf buckets (worker/src/cityinsights.ts) for cases closed this week; fixed order = the
 *  colour slot in Week.css (the admin "How it gets done" palette). 'open' is not a closing outcome and is left out. */
export type WeekOutcome = 'work_done' | 'enforcement' | 'referred' | 'logged_elsewhere' | 'info_only' | 'no_action' | 'cancelled';
export const WEEK_OUTCOMES: readonly WeekOutcome[] = ['work_done', 'enforcement', 'referred', 'logged_elsewhere', 'info_only', 'no_action', 'cancelled'];

export interface WeekTopType { caseType: string; category: string; n: number; prevN: number }
export interface WeekHood { name: string; slug: string; n: number; open: number; closed: number }
/** A case closed this week WITH the city's own Resolution Message (cut to 240 chars by the Worker). */
export interface WeekNotable {
  id: string; caseType: string; category: string; street: string; neighborhood: string | null; status: string;
  closedAt: string | null; resolution: string; lat: number | null; lng: number | null;
}
/** GET /api/week body (docs/api.md). A case counts for a week when it was created or closed inside the window. */
export interface WeekSummary {
  days: 7; since: string; until: string; at: string;
  /** The New York calendar date the window ends on — the stable `/week?until=` for this week. */
  untilDate: string;
  /** untilDate − 7 days; null below the 56-day archive floor. */
  prevUntil: string | null;
  /** untilDate + 7 days; null when that would be after today. */
  nextUntil: string | null;
  /** True when the window ends now (no `until`, or `until` = today in New York). */
  current: boolean;
  total: number; open: number; closed: number; located: number;
  /** The 7 days before `since`, same rules. */
  prev: { total: number; closed: number };
  /** Top 6 by n this week. */
  topTypes: WeekTopType[];
  /** Every neighborhood that had activity, n desc; located cases only. */
  neighborhoods: WeekHood[];
  outcomes: Record<WeekOutcome, number>;
  /** Median days from created to closed over this week's closes with a known created time. */
  medianCloseDays: number | null;
  /** Newest 12 closes with a note. */
  notable: WeekNotable[];
  /** By createdAt, America/New_York; null for an empty week. */
  busiestDay: { date: string; n: number } | null;
}

const TTL_MS = 5 * 60_000;
/** Keyed by the `until` asked for ('' = the current week). */
const cache = new Map<string, { at: number; data: WeekSummary }>();
const inflight = new Map<string, Promise<WeekSummary>>();

/** The week summary — the current week, or the week ending on `until` (YYYY-MM-DD) — cached for 5 minutes per week
 *  (concurrent calls share one request). A failed fetch rejects and leaves any previous entry alone. */
export function getWeek(until?: string | null): Promise<WeekSummary> {
  const key = until || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.data);
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchWeek(key)
    .then((data) => { cache.set(key, { at: Date.now(), data }); return data; })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** Tests / the page's Retry: forget every cached summary. */
export function resetWeekCache(): void { cache.clear(); inflight.clear(); }

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Shape-check the body so a partial or older Worker degrades to zeros and empty lists instead of a crash. */
export function decodeWeek(d: Partial<WeekSummary> | null | undefined): WeekSummary {
  if (!d || typeof d.total !== 'number') throw new Error('week_bad_body');
  const oc = (d.outcomes ?? {}) as Partial<Record<WeekOutcome, number>>;
  const outcomes = Object.fromEntries(WEEK_OUTCOMES.map((o) => [o, num(oc[o])])) as Record<WeekOutcome, number>;
  return {
    days: 7, since: str(d.since), until: str(d.until), at: str(d.at),
    untilDate: str(d.untilDate), prevUntil: typeof d.prevUntil === 'string' ? d.prevUntil : null, nextUntil: typeof d.nextUntil === 'string' ? d.nextUntil : null,
    current: typeof d.current === 'boolean' ? d.current : true,
    total: num(d.total), open: num(d.open), closed: num(d.closed), located: num(d.located),
    prev: { total: num(d.prev?.total), closed: num(d.prev?.closed) },
    topTypes: arr<Partial<WeekTopType>>(d.topTypes).map((x) => ({ caseType: str(x.caseType), category: str(x.category, 'unsure'), n: num(x.n), prevN: num(x.prevN) })),
    neighborhoods: arr<Partial<WeekHood>>(d.neighborhoods).filter((x) => x && typeof x.name === 'string')
      .map((x) => ({ name: x.name!, slug: str(x.slug, x.name!.trim().toLowerCase().replace(/\s+/g, '-')), n: num(x.n), open: num(x.open), closed: num(x.closed) })),
    outcomes,
    medianCloseDays: typeof d.medianCloseDays === 'number' && Number.isFinite(d.medianCloseDays) ? d.medianCloseDays : null,
    notable: arr<Partial<WeekNotable>>(d.notable).filter((x) => x && typeof x.id === 'string').map((x) => ({
      id: x.id!, caseType: str(x.caseType), category: str(x.category, 'unsure'), street: str(x.street), neighborhood: typeof x.neighborhood === 'string' ? x.neighborhood : null,
      status: str(x.status), closedAt: typeof x.closedAt === 'string' ? x.closedAt : null, resolution: str(x.resolution),
      lat: typeof x.lat === 'number' && typeof x.lng === 'number' ? x.lat : null, lng: typeof x.lat === 'number' && typeof x.lng === 'number' ? x.lng : null,
    })),
    busiestDay: d.busiestDay && typeof d.busiestDay.date === 'string' ? { date: d.busiestDay.date, n: num(d.busiestDay.n) } : null,
  };
}

async function fetchWeek(until: string): Promise<WeekSummary> {
  const t = withTimeout(20_000);
  try {
    const resp = await apiFetch(until ? `/api/week?until=${encodeURIComponent(until)}` : '/api/week', { signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    return decodeWeek((await resp.json()) as Partial<WeekSummary>);
  } finally { t.done(); }
}
