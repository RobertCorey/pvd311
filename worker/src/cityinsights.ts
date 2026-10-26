/**
 * cityinsights.ts — "How it gets done": what the city actually does with cases, from the stored public-feed
 * record (citycases.ts). Per picker group and per city case type: how fast cases are routed and closed, and
 * what closing meant, read from the city's own Resolution Message.
 *
 * Outcome rules are deliberately plain regexes over the city's words, applied at read time so they can be
 * tuned without re-scraping. Closing times count only transitions we watched happen (a case first seen
 * already closed has no trustworthy close time) or the city's own resolution date.
 */
import { CATEGORIES } from '../../shared/categories.js';

export const OUTCOMES = ['work_done', 'enforcement', 'referred', 'logged_elsewhere', 'info_only', 'no_action', 'cancelled', 'open'] as const;
export type Outcome = typeof OUTCOMES[number];

export const CLOSED = new Set(['Resolved', 'Closed', 'Cancelled', 'Merged']);

/** The city's Resolution Message → what closing meant. Order matters: the first match wins. */
export function classifyResolution(msg: string | null | undefined): Exclude<Outcome, 'cancelled' | 'open'> {
  const m = (msg ?? '').trim();
  if (!m) return 'no_action';
  if (/citation|ticket(ed)?\b|violation notice|summons|fined?\b/i.test(m)) return 'enforcement';
  if (/\b(picked up|pick up completed|completed|emptied|repaired|replaced|fixed|filled|patched|removed|cleaned|installed|trimmed|pruned|plowed|swept|delivered|restored|collected)\b/i.test(m)) return 'work_done';
  if (/\bCODE-\d+-\d+|logged into the system|previously logged|work order/i.test(m)) return 'logged_elsewhere';
  if (/\bPPD\b|police|RI ?DOT|HHS|Housing and Human|Inspections and Standards|National Grid|RI Energy|Verizon|Spin\b|Lime\b|North Providence|Cranston|Johnston|East Providence|forwarded|transferred|reported to|submitted to|referred|another (agency|department)|not (a )?city/i.test(m)) return 'referred';
  if (/\b(NAR|no action|no issues?|nothing found|did not (see|find|observe)|unable to (locate|find)|not found|duplicate|no information provided|gone on arrival|GOA)\b/i.test(m)) return 'no_action';
  if (/information|info\b|email(ed)? sent|instructed|explained|advised|called|portal comment/i.test(m)) return 'info_only';
  return 'no_action';
}

export function outcomeOf(c: CaseLike): Outcome {
  if (c.status === 'Cancelled' || c.status === 'Merged') return 'cancelled';
  if (!CLOSED.has(c.status)) return 'open';
  return classifyResolution(c.detail?.resolution);
}

export interface CaseLike {
  id: string; caseType: string; category?: string; status: string; createdAt: string | null; firstSeenAt?: string;
  statusSeen?: Record<string, string>;
  detail?: { routedOn?: string | null; resolutionDate?: string | null; resolution?: string | null } | null;
}

export interface Stats {
  n: number;
  routed: number;              // cases with a routed date
  medRouteHours: number | null;
  closed: number;              // Resolved / Closed / Cancelled / Merged
  medCloseDays: number | null; // over watched closes only
  closeSample: number;         // how many closes the median is over
  openOver7d: number;
  outcomes: Record<Outcome, number>;
}
export interface TypeRow extends Stats { caseType: string; examples: { text: string; n: number }[] }
export interface GroupRow extends Stats { group: string; types: TypeRow[] }
export interface Insights { at: string; days: number; since: string; total: Stats; groups: GroupRow[]; trackedSince: string | null }

/** Median of a sample, null when empty (shared with week.ts — the week's medianCloseDays uses the same rule). */
export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
const t = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(v) ? null : v;
};

/** When the case closed, if we can say: the city's resolution date, else a close we watched happen. */
export function closedAt(c: CaseLike): number | null {
  const r = t(c.detail?.resolutionDate);
  if (r != null) return r;
  const first = t(c.firstSeenAt);
  let best: number | null = null;
  for (const [k, v] of Object.entries(c.statusSeen ?? {})) {
    if (!CLOSED.has(k.replace(/_/g, ' '))) continue;
    const at = t(v);
    if (at != null && first != null && at > first && (best == null || at < best)) best = at;
  }
  return best;
}

function stats(cases: CaseLike[], now: number): Stats {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  const route: number[] = []; const close: number[] = [];
  let routed = 0; let closed = 0; let openOver7d = 0;
  for (const c of cases) {
    const o = outcomeOf(c); outcomes[o]++;
    const created = t(c.createdAt);
    const r = t(c.detail?.routedOn);
    if (r != null) { routed++; if (created != null && r >= created) route.push((r - created) / 3_600_000); }
    if (o === 'open') { if (created != null && now - created > 7 * 86_400_000) openOver7d++; continue; }
    closed++;
    const ca = closedAt(c);
    if (ca != null && created != null && ca >= created) close.push((ca - created) / 86_400_000);
  }
  const mr = median(route); const mc = median(close);
  return { n: cases.length, routed, medRouteHours: mr == null ? null : Math.round(mr * 10) / 10, closed,
    medCloseDays: mc == null ? null : Math.round(mc * 10) / 10, closeSample: close.length, openOver7d, outcomes };
}

/** Case numbers vary per message ("CODE-26-1449"); fold them so the same wording groups together. */
const normMsg = (m: string) => m.trim().replace(/\bCODE-\d+-\d+\b/g, 'CODE-…').replace(/\s+/g, ' ');

export function groupOf(category: string | undefined): string {
  return (category && CATEGORIES[category]?.group) || 'other';
}

export function buildInsights(cases: CaseLike[], opts: { days: number; now?: number }): Insights {
  const now = opts.now ?? Date.now();
  const since = now - opts.days * 86_400_000;
  const inWindow = cases.filter((c) => { const v = t(c.createdAt); return v != null && v >= since; });
  const byGroup = new Map<string, Map<string, CaseLike[]>>();
  for (const c of inWindow) {
    const g = groupOf(c.category);
    const types = byGroup.get(g) ?? new Map<string, CaseLike[]>();
    const k = c.caseType.trim();
    types.set(k, [...(types.get(k) ?? []), c]);
    byGroup.set(g, types);
  }
  const groups: GroupRow[] = [...byGroup].map(([group, types]) => ({
    group,
    ...stats([...types.values()].flat(), now),
    types: [...types].map(([caseType, cs]) => {
      const ex = new Map<string, number>();
      for (const c of cs) if (c.detail?.resolution && outcomeOf(c) !== 'open') { const m = normMsg(c.detail.resolution); ex.set(m, (ex.get(m) ?? 0) + 1); }
      return { caseType, ...stats(cs, now), examples: [...ex].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([text, n]) => ({ text, n })) };
    }).sort((a, b) => b.n - a.n),
  })).sort((a, b) => b.n - a.n);
  const first = cases.reduce<number | null>((m, c) => { const v = t(c.firstSeenAt); return v != null && (m == null || v < m) ? v : m; }, null);
  return { at: new Date(now).toISOString(), days: opts.days, since: new Date(since).toISOString(), total: stats(inWindow, now), groups,
    trackedSince: first == null ? null : new Date(first).toISOString() };
}
