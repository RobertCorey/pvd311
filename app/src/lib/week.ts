/** The client's twin of worker/src/week.ts resolveWindow's rules for `?until=`: which /week links the Worker is certain
 *  to answer 400, decided before the chunk or the numbers arrive. Every shared dated link (the Monday mail, r/providence
 *  posts) ages past the archive floor eventually, so both the route fallback (App.tsx) and the page (Week.tsx) load such
 *  a link as the few lines of error view it will become — never as a screen-tall blank or a 1,400 px skeleton that then
 *  collapses and drops the footer onto the screen (CLS 0.35 measured 2026-10-26). The Worker still has the final say. */

/** The Worker keeps this many days of weeks (worker/src/week.ts ARCHIVE_DAYS); older links answer 400 too_old. */
export const WEEK_ARCHIVE_DAYS = 56;
/** Providence's clock: the Worker names days in America/New_York. */
export const WEEK_TZ = 'America/New_York';
export const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The Providence calendar date of an instant, YYYY-MM-DD (en-CA formats ISO-style). */
export const dayNY = (ms: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: WEEK_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
/** Today's calendar date in Providence. */
export const todayNY = (): string => dayNY(Date.now());
/** A YYYY-MM-DD plus n days, as YYYY-MM-DD (calendar arithmetic in UTC, so no zone can shift the day). */
export const addDays = (ymd: string, n: number): string => {
  const m = YMD.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
};
/** A real calendar date in YYYY-MM-DD ('2026-02-30' and '2026-10-1' are not) — the Worker's isYmd. */
export const isYmd = (s: string): boolean => YMD.test(s) && addDays(s, 0) === s;
/** The Sunday ending the Monday–Sunday week that holds a YYYY-MM-DD (the Worker's weekEnd): weeks are named by it. */
export const weekEnd = (ymd: string): string => {
  const m = YMD.exec(ymd);
  return m ? addDays(ymd, (7 - new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()) % 7) : ymd;
};

export type WeekLinkProblem = 'invalid_until' | 'too_old';
/** What the Worker will say about `?until=`: null for the current week (no / empty until, or a day of it) and any date
 *  within the archive; 'invalid_until' for a malformed date or one after this week; 'too_old' when its week ended
 *  before the floor. */
export function weekLinkProblem(until: string | null | undefined, today: string = todayNY()): WeekLinkProblem | null {
  if (until == null || until === '') return null;
  if (!isYmd(until) || until > weekEnd(today)) return 'invalid_until';
  if (weekEnd(until) < addDays(today, -WEEK_ARCHIVE_DAYS)) return 'too_old';
  return null;
}
