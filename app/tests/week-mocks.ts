import type { Page } from '@playwright/test';

/** Shared mock for GET /api/week (week.spec.ts, a11y.spec.ts): the contract shape from worker/src/week.ts. */
export const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
export const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };

const DAY = 86_400_000;
const UNTIL = Date.parse('2026-10-25T17:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A busy week: 312 requests (+22 on last week), 114 closed (−16), outcomes summing to 114, ten hoods (eight shown),
 *  six types across five groups plus an unknown category, three notable closes (the third unplaced). */
export const WEEK = {
  days: 7, since: iso(UNTIL - 7 * DAY), until: iso(UNTIL), at: iso(UNTIL),
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
    { name: 'Elmhurst', slug: 'elmhurst', n: 48, open: 30, closed: 18 },
    { name: 'West End', slug: 'west-end', n: 41, open: 25, closed: 16 },
    { name: 'Downtown', slug: 'downtown', n: 36, open: 20, closed: 16 },
    { name: 'Fox Point', slug: 'fox-point', n: 30, open: 19, closed: 11 },
    { name: 'Upper South Providence', slug: 'upper-south-providence', n: 27, open: 18, closed: 9 },
    { name: 'Mount Pleasant', slug: 'mount-pleasant', n: 24, open: 15, closed: 9 },
    { name: 'Silver Lake', slug: 'silver-lake', n: 22, open: 14, closed: 8 },
    { name: 'Washington Park', slug: 'washington-park', n: 19, open: 12, closed: 7 },
    { name: 'Smith Hill', slug: 'smith-hill', n: 17, open: 11, closed: 6 },
    { name: 'Hope', slug: 'hope', n: 16, open: 10, closed: 6 },
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

export const QUIET = { ...WEEK, total: 0, open: 0, closed: 0, located: 0, prev: { total: 0, closed: 0 }, topTypes: [], neighborhoods: [], outcomes: { work_done: 0, enforcement: 0, referred: 0, logged_elsewhere: 0, info_only: 0, no_action: 0, cancelled: 0 }, medianCloseDays: null, notable: [], busiestDay: null };

export interface Call { method: string; url: string; body: unknown }

export interface WeekSetupOpts {
  body?: unknown;
  /** Status per /api/week call (1-based) — e.g. (n) => (n === 1 ? 500 : 200) for the retry path. */
  status?: (n: number) => number;
  signedIn?: boolean;
  me?: Record<string, unknown>;
}

/** Route /api/week (+ the account endpoints when signed in). Returns the call log. */
export async function setupWeek(page: Page, o: WeekSetupOpts = {}): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  let n = 0;
  await page.route(`${API}/api/week`, (r) => {
    calls.push({ method: 'GET', url: r.request().url(), body: null });
    const status = o.status ? o.status(++n) : 200;
    if (status !== 200) return r.fulfill({ status, contentType: 'application/json', body: '{"error":"boom"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o.body ?? WEEK) });
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
