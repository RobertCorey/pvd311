/** The /street landing's "coming back" state (screens/Street.tsx): when this visitor last saw the landing, how many times
 *  they have, and whether they said "Not now" to the home-screen nudge. Three localStorage keys under the app's
 *  `fixmypvd.` prefix, every access wrapped (private mode, blocked storage); the pure helpers take `nowMs` so the unit
 *  spec can run them without a browser.
 *
 *  Timing rule: the screen reads the OLD seenAt once at mount and writes the new one only after the feed has loaded and
 *  the landing sheet is on screen — so "since you last looked" always compares against the previous visit, never this one. */
import { ago, DAY_MS, type MapCase } from './streetMap';

export const SEEN_KEY = 'fixmypvd.street.seenAt';
/** The newest createdAt in the feed that visit showed: the cutoff for "new". The wall-clock seenAt is not, because the
 *  feed runs behind the city (30-min sync, geocoding after it): a case created an hour before the visit but stored after
 *  it would never count. Every case the city created before a sync is stored by it, so anything this visitor has not
 *  seen was created after the newest one they did. seenAt still gates the hour-long sitting and the "when" phrase. */
export const SEEN_FEED_KEY = 'fixmypvd.street.seenFeedAt';
export const VISITS_KEY = 'fixmypvd.street.visits';
export const INSTALL_DISMISSED_KEY = 'fixmypvd.street.installDismissed';

/** A seenAt younger than this is the same sitting, not a return: nothing is shown. */
export const SINCE_MIN_MS = 60 * 60_000;
/** Past this many whole days the phrase is "a while ago" rather than a count. */
export const WHILE_DAYS = 30;
/** "Not now" on the install nudge holds for this long. */
export const INSTALL_SNOOZE_MS = 30 * DAY_MS;
/** The nudge appears from this landing visit on. */
export const INSTALL_FROM_VISIT = 2;

const parse = (iso: string | null): number | null => { if (!iso) return null; const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };

/** The previous visit's seenAt in ms, or null on a first visit (or an unparseable value). */
export function readSeenAt(): number | null { return parse(read(SEEN_KEY)); }
export function writeSeenAt(nowMs: number): void { write(SEEN_KEY, new Date(nowMs).toISOString()); }
export function readSeenFeedAt(): number | null { return parse(read(SEEN_FEED_KEY)); }
export function writeSeenFeedAt(ms: number): void { write(SEEN_FEED_KEY, new Date(ms).toISOString()); }

/** The newest createdAt among `cases` in ms, or null when none has one. */
export function newestCreated(cases: MapCase[]): number | null {
  let max: number | null = null;
  for (const c of cases) { const t = parse(c.createdAt); if (t != null && (max == null || t > max)) max = t; }
  return max;
}

/** The "new" cutoff for a return visit: the newest case that visit saw, but never later than the visit itself (a
 *  clock-skewed createdAt), and the visit time for a visitor whose last visit predates SEEN_FEED_KEY. */
export function newCutoff(visitCutoffMs: number | null, seenFeedMs: number | null): number | null {
  if (visitCutoffMs == null) return null;
  return seenFeedMs != null ? Math.min(seenFeedMs, visitCutoffMs) : visitCutoffMs;
}

/** Count this landing visit; returns the new total (1 on the first). A corrupt value restarts at 1. */
export function bumpVisits(): number {
  const n = Math.max(0, Math.floor(Number(read(VISITS_KEY)) || 0)) + 1;
  write(VISITS_KEY, String(n));
  return n;
}

/** The instant to compare against, or null when there is nothing to compare: no previous visit, or one under an hour old. */
export function sinceCutoff(seenAtMs: number | null, nowMs: number): number | null {
  return seenAtMs != null && nowMs - seenAtMs >= SINCE_MIN_MS ? seenAtMs : null;
}

/** Created strictly after the cutoff. Closing a case is not "new" — the tag means a request the city did not have last time. */
export function isNewSince(c: MapCase, cutoffMs: number | null): boolean {
  if (cutoffMs == null) return false;
  const t = parse(c.createdAt);
  return t != null && t > cutoffMs;
}
export function newSince(cases: MapCase[], cutoffMs: number): number {
  let n = 0;
  for (const c of cases) if (isNewSince(c, cutoffMs)) n++;
  return n;
}

export type SinceWhen = 'today' | 'yesterday' | 'while' | { days: number };
/** The short phrase for the cutoff: today / yesterday / {days} (2 … WHILE_DAYS−1) / 'while' from WHILE_DAYS on. */
export function sinceWhen(cutoffMs: number, nowMs: number): SinceWhen {
  const a = ago(new Date(cutoffMs).toISOString(), nowMs);
  if (a === 'today' || a === 'yesterday') return a;
  const days = typeof a === 'number' ? a : WHILE_DAYS;
  return days >= WHILE_DAYS ? 'while' : { days };
}

/** "Not now" within the last INSTALL_SNOOZE_MS. A dismissal stamped in the future counts as current (clock skew), not expired. */
export function installSnoozed(nowMs: number): boolean {
  const t = parse(read(INSTALL_DISMISSED_KEY));
  return t != null && nowMs - t < INSTALL_SNOOZE_MS;
}
export function snoozeInstall(nowMs: number): void { write(INSTALL_DISMISSED_KEY, new Date(nowMs).toISOString()); }
