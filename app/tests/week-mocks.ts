import type { Page } from '@playwright/test';

/** Shared mock for GET /api/week (week.spec.ts, a11y.spec.ts): the contract shape from worker/src/week.ts. */
export const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
export const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };

const DAY = 86_400_000;
const UNTIL = Date.parse('2026-10-25T17:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** The mocked "today" in Providence: Sunday 2026-10-25 (UNTIL is 13:00 EDT). Archive floor = 56 days back. */
export const TODAY = '2026-10-25';
export const FLOOR = '2026-08-30';
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** A busy week: 312 requests (+22 on last week), 114 closed (−16), outcomes summing to 114, ten hoods (eight shown; each
 *  with its own median days to close, Washington Park without one, Smith Hill with 1 close of 1 day),
 *  six types across five groups plus an unknown category, three notable closes (the third unplaced). The current
 *  week (ending now): untilDate = today, a previous week, no next. */
export const WEEK = {
  days: 7, since: iso(UNTIL - 7 * DAY), until: iso(UNTIL), at: iso(UNTIL),
  untilDate: TODAY, prevUntil: addDays(TODAY, -7), nextUntil: null as string | null, current: true,
  total: 312, open: 198, closed: 114, located: 280,
  prev: { total: 290, closed: 130 },
  topTypes: [
    { caseType: 'Pothole', category: 'pothole', n: 61, prevN: 48 },
    { caseType: 'Street Light Out', category: 'street_light', n: 44, prevN: 51 },
    { caseType: 'Missed Trash Pickup', category: 'missed_trash', n: 39, prevN: 39 },
    { caseType: 'Graffiti', category: 'graffiti', n: 21, prevN: 15 },
    { caseType: 'Abandoned Vehicle', category: 'abandoned_vehicle', n: 18, prevN: 22 },
    { caseType: 'Mystery Request', category: 'zzz_not_a_category', n: 9, prevN: 4 },
  ],
  neighborhoods: [
    { name: 'Elmhurst', slug: 'elmhurst', n: 48, open: 30, closed: 18, medianCloseDays: 2.5 as number | null },
    { name: 'West End', slug: 'west-end', n: 41, open: 25, closed: 16, medianCloseDays: 3 },
    { name: 'Downtown', slug: 'downtown', n: 36, open: 20, closed: 16, medianCloseDays: 1.5 },
    { name: 'Fox Point', slug: 'fox-point', n: 30, open: 19, closed: 11, medianCloseDays: 4.5 },
    { name: 'Upper South Providence', slug: 'upper-south-providence', n: 27, open: 18, closed: 9, medianCloseDays: 6 },
    { name: 'Mount Pleasant', slug: 'mount-pleasant', n: 24, open: 15, closed: 9, medianCloseDays: 3.5 },
    { name: 'Silver Lake', slug: 'silver-lake', n: 22, open: 14, closed: 8, medianCloseDays: 2 },
    { name: 'Washington Park', slug: 'washington-park', n: 19, open: 12, closed: 7, medianCloseDays: null },   // no dated close: no median
    { name: 'Smith Hill', slug: 'smith-hill', n: 17, open: 16, closed: 1, medianCloseDays: 1 },              // the singulars
    { name: 'Hope', slug: 'hope', n: 16, open: 10, closed: 6, medianCloseDays: 2 },
  ],
  outcomes: { work_done: 40, enforcement: 10, referred: 30, logged_elsewhere: 20, info_only: 5, no_action: 9, cancelled: 0 },
  medianCloseDays: 3.5,
  notable: [
    { id: 'n1', caseType: 'Street Light Out', category: 'street_light', street: '22 Thayer St', neighborhood: 'College Hill', status: 'Resolved', closedAt: iso(UNTIL - 1 * DAY), resolution: 'Bulb replaced.', lat: 41.82856, lng: -71.4005 },
    { id: 'n2', caseType: 'Pothole', category: 'pothole', street: '10 Angell St', neighborhood: 'College Hill', status: 'Closed', closedAt: iso(UNTIL - 2 * DAY), resolution: 'Filled with cold patch; permanent repair scheduled.', lat: 41.8283, lng: -71.4006 },
    { id: 'n3', caseType: 'Graffiti', category: 'graffiti', street: '', neighborhood: null, status: 'Resolved', closedAt: iso(UNTIL - 3 * DAY), resolution: 'Referred to Parks.', lat: null, lng: null },
  ],
  busiestDay: { date: '2026-10-21', n: 61 },
};

/** The week ending Sunday Oct 18 as the Worker would answer `?until=2026-10-18`: Mon Oct 12 00:00 EDT →
 *  Sun Oct 18 23:59:59.999 EDT, both neighbours present, not current. Same numbers as WEEK apart from the dates. */
export const DATED = datedWeek('2026-10-18');

/** The Worker's answer for `?until=<ymd>` relative to TODAY: today → WEEK itself; a past date → WEEK's numbers in that
 *  calendar window with prev/next by the floor and today. */
export function datedWeek(untilDate: string): typeof WEEK {
  if (untilDate === TODAY) return WEEK;
  const since = Date.parse(`${addDays(untilDate, -6)}T04:00:00Z`);          // 00:00 EDT
  const untilX = Date.parse(`${addDays(untilDate, 1)}T04:00:00Z`);
  const prev = addDays(untilDate, -7); const next = addDays(untilDate, 7);
  return {
    ...WEEK, since: iso(since), until: iso(untilX - 1), at: iso(UNTIL),
    untilDate, prevUntil: prev >= FLOOR ? prev : null, nextUntil: next <= TODAY ? next : null, current: false,
    busiestDay: { date: addDays(untilDate, -4), n: 61 },
  };
}

export const QUIET = { ...WEEK, total: 0, open: 0, closed: 0, located: 0, prev: { total: 0, closed: 0 }, topTypes: [], neighborhoods: [], outcomes: { work_done: 0, enforcement: 0, referred: 0, logged_elsewhere: 0, info_only: 0, no_action: 0, cancelled: 0 }, medianCloseDays: null, notable: [], busiestDay: null };

/** Saved places in three neighborhoods (real points, checked against the rings): Hope is 10th of 10 this week (outside
 *  the top 8), College Hill had nothing this week, Fox Point is 4th. Account order: Hope, College Hill, Fox Point. */
export const PLACES = [
  { id: 'p1', label: 'Home', address: '120 Summit Ave, Providence', lat: 41.8525, lng: -71.4024 },
  { id: 'p2', label: 'Work', address: '69 Brown St, Providence', lat: 41.8262, lng: -71.4032 },
  { id: 'p3', label: 'Mom', address: '10 Wickenden St, Providence', lat: 41.8170, lng: -71.3930 },
];

export interface Call { method: string; url: string; body: unknown }

export interface WeekSetupOpts {
  /** The body for every call, or a function of the `until` asked for (null = the current week). Default: WEEK for the
   *  current week, datedWeek(until) for a past one. */
  body?: unknown | ((until: string | null) => unknown);
  /** Status per /api/week call (1-based) — e.g. (n) => (n === 1 ? 500 : 200) for the retry path. */
  status?: (n: number) => number;
  /** The error body for a non-200 status (default {"error":"boom"}). */
  error?: unknown;
  signedIn?: boolean;
  me?: Record<string, unknown>;
}

/** Route /api/week (any `?until=`) (+ the account endpoints when signed in). Returns the call log. */
export async function setupWeek(page: Page, o: WeekSetupOpts = {}): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  let n = 0;
  await page.route((u) => u.origin + u.pathname === `${API}/api/week`, (r) => {
    const url = r.request().url();
    const until = new URL(url).searchParams.get('until');
    calls.push({ method: 'GET', url, body: null });
    const status = o.status ? o.status(++n) : 200;
    if (status !== 200) return r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o.error ?? { error: 'boom' }) });
    const body = typeof o.body === 'function' ? (o.body as (u: string | null) => unknown)(until) : (o.body ?? datedWeek(until ?? TODAY));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  if (o.signedIn) {
    await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
    let me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [], createdAt: new Date(Date.now() - 30 * DAY).toISOString(), ...(o.me ?? {}) } as Record<string, unknown>;
    await page.route(`${API}/api/me`, async (r) => {
      const req = r.request();
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON();
        calls.push({ method: 'PATCH', url: req.url(), body });
        me = { ...me, prefs: { ...(me.prefs as object), ...(body.prefs ?? {}) } };
      } else calls.push({ method: req.method(), url: req.url(), body: null });
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) });
    });
  }
  return calls;
}
