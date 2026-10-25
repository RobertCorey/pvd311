import type { Page } from '@playwright/test';

/** Shared mocks for the /street map page (street.spec.ts, a11y.spec.ts, the screenshot script).
 *  The feed is the tuple shape of GET /api/street/map (worker/src/street.ts mapFeed). */

export const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
export const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
/** The digest email's link for 481 Angell St (College Hill / Wayland edge). */
export const POINT = '/street?lat=41.82820&lng=-71.40050&q=481%20Angell%20St';
export const PT = { lat: 41.8282, lng: -71.4005 };
/** Six cases share this coordinate (a street-only address geocoded to one centroid): the stack. */
export const STACK = { lat: 41.86, lng: -71.4 };

export const STATUSES = ['Submitted', 'Assigned', 'In Progress', 'Department Responded', 'Resolved', 'Closed', 'Cancelled', 'Merged'];
export const TYPES: [string, string][] = [
  ['Pothole', 'pothole'],                       // 0 streets
  ['Street Light Out', 'street_light'],         // 1 lights
  ['Overflowing Dumpster', 'illegal_dumping'],  // 2 trash
  ['Missed Trash Pickup', 'missed_trash'],      // 3 trash
  ['Graffiti', 'graffiti'],                     // 4 property
  ['Abandoned Vehicle', 'abandoned_vehicle'],   // 5 traffic
  ['Tree Down', 'tree'],                        // 6 trees
];

export interface Case {
  id: string; t: number; status: string; createdDaysAgo: number; closedDaysAgo?: number | null;
  lat: number | null; lng: number | null; street: string; res?: string | null;
}

const minsAgo = (days: number) => Math.floor((Date.now() - days * 86_400_000) / 60_000);

/** The three cases around 481 Angell St: 3 m (open, today), 40 m (open, 3 days), 55 m (closed yesterday, with the city's note). */
export const NEAR: Case[] = [
  { id: 'c1', t: 0, status: 'Assigned', createdDaysAgo: 3, lat: 41.82856, lng: -71.4005, street: '10 Angell St' },
  { id: 'c2', t: 1, status: 'Resolved', createdDaysAgo: 9, closedDaysAgo: 1, lat: 41.8277, lng: -71.4005, street: '22 Thayer St', res: 'Bulb replaced.' },
  { id: 'c3', t: 2, status: 'In Progress', createdDaysAgo: 0, lat: 41.82822, lng: -71.40052, street: '481 Angell St' },
];
/** One case the city gave no street for: counted, listed on the landing, never on the map. */
export const UNPLACED: Case = { id: 'z2', t: 0, status: 'Resolved', createdDaysAgo: 4, closedDaysAgo: 0, lat: null, lng: null, street: '', res: 'Filled.' };
export const STACK_CASES: Case[] = Array.from({ length: 6 }, (_, i) => ({
  id: `s${i + 1}`, t: i % 3 === 0 ? 0 : i % 3 === 1 ? 3 : 1, status: i < 4 ? 'Submitted' : 'Closed', createdDaysAgo: i + 1, closedDaysAgo: i < 4 ? null : 1,
  lat: STACK.lat, lng: STACK.lng, street: 'Hope St',
}));

/** Deterministic filler: clusters of cases in six neighborhoods, away from the test point and the stack, so the city
 *  reads 1,234 requests (738 open · 496 closed, 126 unplaced) and a z16 view around 481 Angell St stays empty. */
const FILL_CENTRES: [number, number, string][] = [
  [41.845, -71.445, 'Smith St'],        // Elmhurst
  [41.818, -71.39, 'Wickenden St'],     // Fox Point
  [41.822, -71.418, 'Westminster St'],  // Downtown (west edge)
  [41.79, -71.405, 'Broad St'],         // Washington Park
  [41.84, -71.455, 'Chalkstone Ave'],   // Mount Pleasant
  [41.81, -71.455, 'Union Ave'],        // Silver Lake
];
const FILL_WEIGHTS = [6, 4, 5, 3, 2, 2]; // Elmhurst busiest
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
export function filler(n = 1224, opts: { open?: number; unplaced?: number } = {}): Case[] {
  const open = opts.open ?? 734, unplaced = opts.unplaced ?? 125;
  const r = rng(42);
  const total = FILL_WEIGHTS.reduce((a, b) => a + b, 0);
  const out: Case[] = [];
  for (let i = 0; i < n; i++) {
    // type: potholes dominate, then missed trash, then street lights
    const t = i % 10 < 4 ? 0 : i % 10 < 7 ? 3 : i % 10 < 9 ? 1 : 2 + (i % 5);
    const isOpen = i < open;
    const located = i >= unplaced;
    let pick = r() * total, k = 0;
    while (pick > FILL_WEIGHTS[k]) { pick -= FILL_WEIGHTS[k]; k++; }
    const [clat, clng, street] = FILL_CENTRES[Math.min(k, FILL_CENTRES.length - 1)];
    const lat = clat + (r() - 0.5) * 0.005, lng = clng + (r() - 0.5) * 0.007; // ≈ ±280 m
    const created = Math.floor(r() * 25) + 1;
    out.push({
      id: `f${i}`, t: t > 6 ? 4 : t, status: isOpen ? (i % 2 ? 'Submitted' : 'Assigned') : (i % 3 ? 'Resolved' : 'Closed'),
      createdDaysAgo: created, closedDaysAgo: isOpen ? null : Math.max(0, created - 2),
      lat: located ? Math.round(lat * 1e5) / 1e5 : null, lng: located ? Math.round(lng * 1e5) / 1e5 : null,
      street: located ? `${10 + (i % 90)} ${street}` : '', res: isOpen ? null : (i % 4 === 0 ? 'Filled.' : null),
    });
  }
  return out;
}

export const DEFAULT_ITEMS: Case[] = [...NEAR, UNPLACED, ...STACK_CASES, ...filler()];

/** Build the wire body. `days` is echoed; items outside the window are the worker's job, not this builder's. */
export function feed(o: { days?: number; items?: Case[]; truncated?: boolean } = {}) {
  const items = o.items ?? DEFAULT_ITEMS;
  const rows = items.map((c) => {
    const s = STATUSES.indexOf(c.status); const si = s < 0 ? STATUSES.length : s;
    const located = c.lat != null && c.lng != null;
    return [c.id, c.t, si, minsAgo(c.createdDaysAgo), c.closedDaysAgo == null ? 0 : minsAgo(c.closedDaysAgo), located ? c.lat : null, located ? c.lng : null, c.street, c.res ?? 0];
  });
  const extra = items.map((c) => c.status).filter((s) => !STATUSES.includes(s));
  return {
    v: 1, days: o.days ?? 30, at: new Date().toISOString(), total: items.length, located: items.filter((c) => c.lat != null).length,
    truncated: !!o.truncated, types: TYPES, statuses: [...STATUSES, ...Array.from(new Set(extra))], items: rows,
  };
}

export interface Call { method: string; url: string; body: unknown }

export interface SetupOpts {
  items?: Case[]; items90?: Case[]; signedIn?: boolean; me?: Record<string, unknown>;
  /** Respond to /api/street/map with this status (per call count) — e.g. () => 500 for the error state. */
  status?: (n: number, days: number) => number;
}

/** Route everything the page talks to: the API (feed, me, addresses), OSM tiles, ArcGIS. Returns the call log. */
export async function setup(page: Page, o: SetupOpts = {}): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, body: '' }));
  let n = 0;
  await page.route(`${API}/api/street/map*`, (r) => {
    const u = new URL(r.request().url());
    const days = Number(u.searchParams.get('days') ?? 30);
    calls.push({ method: 'GET', url: r.request().url(), body: null });
    const status = o.status ? o.status(++n, days) : 200;
    if (status !== 200) return r.fulfill({ status, contentType: 'application/json', body: '{"error":"boom"}' });
    const items = days === 90 ? (o.items90 ?? o.items ?? DEFAULT_ITEMS) : (o.items ?? DEFAULT_ITEMS);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed({ days, items })) });
  });
  // The old endpoints must never be called by the page.
  await page.route(`${API}/api/street/city*`, (r) => { calls.push({ method: 'GET', url: r.request().url(), body: null }); return r.fulfill({ status: 500, body: '' }); });
  await page.route(`${API}/api/street?*`, (r) => { calls.push({ method: 'GET', url: r.request().url(), body: null }); return r.fulfill({ status: 500, body: '' }); });
  await page.route('https://geocode.arcgis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ location: { x: -71.4005, y: 41.8282 }, score: 100, attributes: { Match_addr: '481 Angell St, Providence, Rhode Island, 02906' } }] }) }));
  if (o.signedIn) {
    await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
    let me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true, streetDigest: false }, addresses: [], following: [], createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), ...(o.me ?? {}) } as Record<string, unknown>;
    await page.route(`${API}/api/me`, async (r) => {
      const req = r.request();
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON();
        calls.push({ method: 'PATCH', url: req.url(), body });
        me = { ...me, prefs: { ...(me.prefs as object), ...(body.prefs ?? {}) } };
      }
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) });
    });
    await page.route(`${API}/api/me/addresses`, async (r) => {
      const body = r.request().postDataJSON();
      calls.push({ method: 'PUT', url: r.request().url(), body });
      me = { ...me, addresses: [{ id: 'a1', ...body }] };
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ addresses: me.addresses }) });
    });
  }
  return calls;
}

/** The Leaflet map handle the page exposes on localhost (MapView testHook). */
export const mapEval = <T>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const m = window.__streetMap; return (${fn})(m); })()`) as Promise<T>;
export const zoomOf = (page: Page) => mapEval<number>(page, 'm => m.getZoom()');
export const setView = (page: Page, lat: number, lng: number, z: number) => mapEval<void>(page, `m => { m.setView([${lat}, ${lng}], ${z}, { animate: false }); }`);
/** A user pan: Leaflet's dragstart marks the move as the user's (MapView counts dragstart/zoomstart, not movestart). */
export const userPan = (page: Page, dx: number, dy: number) => mapEval<void>(page, `m => { m.fire('dragstart'); m.panBy([${dx}, ${dy}], { animate: false }); }`);
export const waitForMap = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __streetMap?: unknown }).__streetMap);
