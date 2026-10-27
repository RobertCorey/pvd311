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
  ['Noise Complaint', 'noise'],                 // 7 nuisance
  ['Water Leak', 'water_leak'],                 // 8 water
  ['Animal Control', 'animal_control'],         // 9 animals
  ['Something Else', 'unsure'],                 // 10 other
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
/** Two requests at one address (an open pothole, a tree closed yesterday): the smallest stack. Not in DEFAULT_ITEMS — the
 *  fan tests add it — so the landing's counts stay put. */
export const PAIR = { lat: 41.852, lng: -71.428 };
export const PAIR_CASES: Case[] = [
  { id: 'p1', t: 0, status: 'Submitted', createdDaysAgo: 3, lat: PAIR.lat, lng: PAIR.lng, street: '40 Douglas Ave' },
  { id: 'p2', t: 6, status: 'Resolved', createdDaysAgo: 6, closedDaysAgo: 1, lat: PAIR.lat, lng: PAIR.lng, street: '40 Douglas Ave', res: 'Removed.' },
];
/** Thirteen at one spot — one more than a stack fans out (lib/streetMap SPIDER_MAX): it stays a disc whose tap lists them.
 *  Not in DEFAULT_ITEMS either. */
export const BIG_STACK = { lat: 41.8075, lng: -71.388 };
export const BIG_STACK_CASES: Case[] = Array.from({ length: 13 }, (_, i) => ({
  id: `b${i + 1}`, t: i % 2 ? 3 : 0, status: i < 7 ? 'Assigned' : 'Closed', createdDaysAgo: i + 1, closedDaysAgo: i < 7 ? null : 0,
  lat: BIG_STACK.lat, lng: BIG_STACK.lng, street: 'Allens Ave',
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

/** GET /api/street/case/:id body (worker/src/street.ts StreetCaseView) for one fixture case. */
export function caseWire(c: Case) {
  const iso = (days: number) => new Date(minsAgo(days) * 60_000).toISOString();
  const open = !['Resolved', 'Closed', 'Cancelled', 'Merged'].includes(c.status);
  return {
    id: c.id, caseType: TYPES[c.t][0], category: TYPES[c.t][1], street: c.street, status: c.status, open,
    createdAt: iso(c.createdDaysAgo), closedAt: c.closedDaysAgo == null ? null : iso(c.closedDaysAgo), resolution: c.res ?? null,
    lat: c.lat, lng: c.lng, updatedAt: iso(c.closedDaysAgo ?? c.createdDaysAgo),
  };
}

/** A `detail` for GET /api/street/case/:id (worker/src/street.ts StreetCaseDetail) for a fixture case: the full address,
 *  the form's dates (received + routed on the day it was reported, resolved for a closed case) and two answers. */
export function detailFor(c: Case, o: { address?: string | null; answers?: { label: string; value: string }[]; workCompletedDaysAgo?: number } = {}) {
  const iso = (days: number) => new Date(minsAgo(days) * 60_000).toISOString();
  const later = (days: number, mins: number) => new Date((minsAgo(days) + mins) * 60_000).toISOString();
  return {
    address: o.address === undefined ? `${c.street}, Providence, RI, 02906, USA` : o.address,
    timeline: {
      reported: iso(c.createdDaysAgo), received: later(c.createdDaysAgo, 1), routed: later(c.createdDaysAgo, 2),
      workCompleted: o.workCompletedDaysAgo == null ? null : iso(o.workCompletedDaysAgo), resolved: c.closedDaysAgo == null ? null : iso(c.closedDaysAgo),
    },
    answers: o.answers ?? [{ label: 'Type of Property', value: "Residential (someone else's property)" }, { label: 'Is Property Abandoned', value: 'Yes' }],
    statusHistory: [{ status: 'Submitted', at: iso(c.createdDaysAgo) }],
  };
}

/** The tracking page's point (120 Benefit St, the track.spec fixture) and the four city cases around it: two open
 *  (28 m, three days ago / 130 m, today), two closed (80 m yesterday with the city's note / 150 m) — the fourth is counted, never a row. */
export const TRACK_PT = { lat: 41.8268, lng: -71.4053 };
export const TRACK_NEAR: Case[] = [
  { id: 'n1', t: 0, status: 'Assigned', createdDaysAgo: 3, lat: 41.827, lng: -71.4051, street: '124 Benefit St' },
  { id: 'n2', t: 1, status: 'Resolved', createdDaysAgo: 9, closedDaysAgo: 1, lat: 41.8262, lng: -71.4058, street: '98 Benefit St', res: 'Bulb replaced.' },
  { id: 'n3', t: 4, status: 'In Progress', createdDaysAgo: 0, lat: 41.8275, lng: -71.404, street: '15 Meeting St' },
  { id: 'n4', t: 3, status: 'Closed', createdDaysAgo: 12, closedDaysAgo: 5, lat: 41.826, lng: -71.4066, street: '77 Benefit St' },
];

/** GET /api/street?lat&lng&radiusM&days body (worker/src/street.ts handleStreet → StreetCase[]) for fixture cases
 *  around `at`: the case fields plus distanceM, in the given order (the worker's is newest activity first). */
export function nearWire(cases: Case[], at: { lat: number; lng: number }, o: { radiusM?: number; days?: number } = {}) {
  const R = 6_371_000; const rad = (d: number) => (d * Math.PI) / 180;
  const dist = (lat: number, lng: number) => {
    const dLat = rad(lat - at.lat), dLng = rad(lng - at.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(at.lat)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
  };
  const items = cases.filter((c) => c.lat != null && c.lng != null).map((c) => {
    const { updatedAt: _updatedAt, ...w } = caseWire(c);
    return { ...w, distanceM: dist(c.lat!, c.lng!) };
  });
  return { items, radiusM: o.radiusM ?? 300, days: o.days ?? 30, at: new Date().toISOString() };
}

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
  /** Cases GET /api/street/case/:id knows beyond the window sets (a followed case months old); anything else is 404. */
  extraCases?: Case[];
  /** GET /api/street/case/:id's `detail` per case id (worker/src/street.ts streetCaseDetail); absent → omitted. */
  details?: Record<string, unknown>;
  /** Status for GET /api/street/case/:id per id (default 200 / 404) — e.g. () => 500 for the overlay's failure path. */
  caseStatus?: (id: string) => number | undefined;
  /** Hold every GET /api/street/case/:id this long (the overlay's skeleton). */
  caseDelayMs?: number;
  /** Status for GET /api/me per call (default 200) — e.g. (n) => (n === 1 ? 500 : 200) for the retry path. */
  meStatus?: (n: number) => number;
  /** Hold every GET /api/me this long (the "Loading your account…" state). */
  meDelayMs?: number;
  /** Hold PUT/DELETE /api/me/city/:guid this long (the in-flight toggle). */
  followDelayMs?: number;
  /** GET /api/me/city items (FollowedCase[]) for a signed-in page; default none. */
  followed?: unknown[];
  /** Status for PUT/DELETE /api/me/city/:guid (default 204) — e.g. () => 500 for the revert path. */
  followStatus?: (method: string, guid: string) => number;
  /** Respond to /api/street/map with this status (per call count) — e.g. () => 500 for the error state. */
  status?: (n: number, days: number) => number;
  /** Let the page load the real self-hosted basemap (vector tiles) instead of the stubbed raster fallback. */
  basemap?: boolean;
}

/** Route everything the page talks to: the API (feed, me, addresses), OSM tiles, ArcGIS. Returns the call log. */
export async function setup(page: Page, o: SetupOpts = {}): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, body: '' }));
  // No vector basemap in the suite (deterministic, fast): a 404 manifest makes MapView fall back to the stubbed raster.
  if (!o.basemap) await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
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
  // One case by id (the deep-link fallback): the window sets plus `extraCases`; 404 otherwise.
  await page.route(`${API}/api/street/case/*`, async (r) => {
    const id = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() ?? '');
    calls.push({ method: 'GET', url: r.request().url(), body: null });
    if (o.caseDelayMs) await new Promise((res) => setTimeout(res, o.caseDelayMs));
    const forced = o.caseStatus?.(id);
    if (forced && forced !== 200) return r.fulfill({ status: forced, contentType: 'application/json', body: '{"error":"boom"}' });
    const all = [...(o.items ?? DEFAULT_ITEMS), ...(o.items90 ?? []), ...(o.extraCases ?? [])];
    const c = all.find((x) => x.id === id);
    if (!c) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    const detail = o.details?.[id];
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...caseWire(c), ...(detail ? { detail } : {}) }) });
  });
  // The old endpoints must never be called by the page.
  await page.route(`${API}/api/street/city*`, (r) => { calls.push({ method: 'GET', url: r.request().url(), body: null }); return r.fulfill({ status: 500, body: '' }); });
  await page.route(`${API}/api/street?*`, (r) => { calls.push({ method: 'GET', url: r.request().url(), body: null }); return r.fulfill({ status: 500, body: '' }); });
  await page.route('https://geocode.arcgis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ location: { x: -71.4005, y: 41.8282 }, score: 100, attributes: { Match_addr: '481 Angell St, Providence, Rhode Island, 02906' } }] }) }));
  if (o.signedIn) {
    await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
    let me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true, streetDigest: false }, addresses: [], following: [], cityFollowing: [], createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), ...(o.me ?? {}) } as Record<string, unknown>;
    // Following a city case: GET /api/me/city (the list), PUT/DELETE /api/me/city/:guid (204, idempotent).
    await page.route((u) => u.href.startsWith(`${API}/api/me/city`), async (r) => {
      const req = r.request(); const m = req.method();
      const guid = decodeURIComponent(new URL(req.url()).pathname.split('/').pop() ?? '');
      calls.push({ method: m, url: req.url(), body: null });
      if (m === 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: o.followed ?? [] }) });
      const status = o.followStatus ? o.followStatus(m, guid) : 204;
      if (o.followDelayMs) await new Promise((res) => setTimeout(res, o.followDelayMs));
      if (status !== 204) return r.fulfill({ status, contentType: 'application/json', body: '{"error":"boom"}' });
      const cur = ((me.cityFollowing as string[] | undefined) ?? []).filter((x) => x !== guid);
      me = { ...me, cityFollowing: m === 'PUT' ? [guid, ...cur] : cur };
      return r.fulfill({ status: 204, body: '' });
    });
    let meCalls = 0;
    await page.route(`${API}/api/me`, async (r) => {
      const req = r.request();
      if (req.method() === 'GET') {
        meCalls++;
        calls.push({ method: 'GET', url: req.url(), body: null });
        if (o.meDelayMs) await new Promise((res) => setTimeout(res, o.meDelayMs));
        const status = o.meStatus ? o.meStatus(meCalls) : 200;
        if (status !== 200) return r.fulfill({ status, contentType: 'application/json', body: '{"error":"boom"}' });
      }
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
