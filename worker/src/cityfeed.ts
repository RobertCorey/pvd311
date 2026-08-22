/**
 * cityfeed.ts — read Providence's anonymous city-wide request feed (/public-requests/)
 * and merge it into our public map + "already reported nearby" data.
 *
 * The /public-requests/ page is a Power Pages PCF grid (client-rendered): columns
 * Case Type | Street | Status Reason | Created On. No case id, no lat/lng — street only.
 * We parse the newest page (one page is enough; ~15–50 rows), geocode each distinct
 * street with ArcGIS findAddressCandidates (cached forever in Firestore meta/geo_<sha1>),
 * map the case-type name to our category keys, and persist meta/cityFeed (cap 200).
 *
 * Read-only: never clicks Next/Submit. Runs on the watcher's existing Playwright page
 * (logged-in, but this page is anonymous-readable) so it costs no extra browser session.
 *
 * `document` below is the browser-page global referenced inside page.evaluate(). The Worker
 * tsconfig has no DOM lib, so it is declared ambient `any` (erased at build); it resolves to
 * the real browser global when the serialized callback runs in the page. (Same trick as portal.ts.)
 */
import type { Page } from '@cloudflare/playwright';
import { CATEGORIES } from '../../shared/categories.js';
import type { Env, Store } from './contracts.js';

declare const document: any;

export interface CityFeedItem {
  caseId: string | null;      // the anonymous feed exposes no case id
  caseTypeName: string;       // raw portal case-type label
  category: string;           // mapped category key from shared/categories.ts, else 'unsure'
  street: string;
  lat: number | null;
  lng: number | null;
  status: string;             // portal Status Reason (Draft/Submitted/Assigned/Resolved/Cancelled/…)
  createdOn: string;          // raw "Created On" cell text
}
export interface CityFeed {
  fetchedAt: string;
  items: CityFeedItem[];
}

const MAX_ITEMS = 200;
const MAX_GEOCODES_PER_RUN = 80; // bound ArcGIS calls on a cold cache; cache makes later runs ~free
// Loose RI/Providence guard so a bad geocode can't drop a pin in another state.
const GEO_BOUNDS = { minLat: 41.6, maxLat: 42.05, minLng: -71.7, maxLng: -71.2 };

interface RawRow {
  caseTypeName: string;
  street: string;
  status: string;
  createdOn: string;
}

/**
 * Load /public-requests/, parse the grid, geocode distinct streets (cache-aware), map
 * categories, and persist meta/cityFeed. Returns the persisted feed (handy for a local run).
 */
export async function fetchCityFeed(env: Env, page: Page, store: Store): Promise<CityFeed> {
  const rows = await scrapeCityGrid(env, page);

  // Geocode each distinct street once (cache-aware).
  const geo = new Map<string, { lat: number; lng: number } | null>();
  let budget = MAX_GEOCODES_PER_RUN;
  for (const street of new Set(rows.map((r) => r.street))) {
    const cached = await getCachedGeo(store, street);
    if (cached) {
      geo.set(street, cached.lat != null && cached.lng != null ? { lat: cached.lat, lng: cached.lng } : null);
      continue;
    }
    if (budget <= 0) { geo.set(street, null); continue; }
    budget--;
    const g = await geocodeStreet(street);
    await setCachedGeo(store, street, g);
    geo.set(street, g);
  }

  const items: CityFeedItem[] = rows.slice(0, MAX_ITEMS).map((r) => {
    const g = geo.get(r.street) ?? null;
    return {
      caseId: null,
      caseTypeName: r.caseTypeName,
      category: mapCategory(r.caseTypeName),
      street: r.street,
      lat: g?.lat ?? null,
      lng: g?.lng ?? null,
      status: r.status,
      createdOn: r.createdOn,
    };
  });

  const feed: CityFeed = { fetchedAt: new Date().toISOString(), items };
  await store.setMeta('cityFeed', feed as unknown as Record<string, unknown>);
  console.log(`[cityfeed] ${items.length} items (${items.filter((i) => i.lat != null).length} geocoded)`);
  return feed;
}

// ── Grid scrape ────────────────────────────────────────────────────────────────────────

async function scrapeCityGrid(env: Env, page: Page): Promise<RawRow[]> {
  await page.goto(`${env.PORTAL_BASE_URL}/public-requests/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[role="grid"] [role="row"], table tbody tr', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3_000); // lazy PCF grid render

  const { headers, rows } = (await page.evaluate(() => {
    const norm = (s: any) => (s || '').replace(/\s+/g, ' ').trim();
    const grid = document.querySelector('[role="grid"]') || document.querySelector('table');
    if (!grid) return { headers: [] as string[], rows: [] as string[][] };
    const headers = Array.from(grid.querySelectorAll('[role="columnheader"], thead th')).map((h: any) =>
      norm(h.textContent),
    );
    const rows: string[][] = [];
    for (const r of Array.from(grid.querySelectorAll('[role="row"], tbody tr')) as any[]) {
      const cellEls = r.querySelectorAll('[role="gridcell"], td');
      if (!cellEls.length) continue; // header / empty row
      rows.push(Array.from(cellEls).map((c: any) => norm(c.textContent)));
    }
    return { headers, rows };
  })) as { headers: string[]; rows: string[][] };

  const out: RawRow[] = [];
  for (const cells of rows) {
    const parsed = parseCityRow(headers, cells);
    if (parsed) out.push(parsed);
  }
  return out;
}

function headerIndex(headers: string[], ...needles: string[]): number {
  return headers.findIndex((h) => needles.some((n) => h.toLowerCase().includes(n)));
}

/** Columns are Case Type | Street | Status Reason | Created On; fall back to that order if headers are missing. */
export function parseCityRow(headers: string[], cells: string[]): RawRow | null {
  const iType = headerIndex(headers, 'case type', 'type', 'request', 'title');
  const iStreet = headerIndex(headers, 'street', 'address', 'location');
  const iStatus = headerIndex(headers, 'status');
  const iCreated = headerIndex(headers, 'created', 'submitted', 'date');

  const caseTypeName = ((iType >= 0 ? cells[iType] : cells[0]) ?? '').trim();
  const street = ((iStreet >= 0 ? cells[iStreet] : cells[1]) ?? '').trim();
  const status = ((iStatus >= 0 ? cells[iStatus] : cells[2]) ?? '').trim();
  const createdOn = ((iCreated >= 0 ? cells[iCreated] : cells[3]) ?? '').trim();

  if (!street || !caseTypeName) return null; // skip rows with no street (per spec) or no type
  return { caseTypeName, street, status, createdOn };
}

// ── Category mapping ─────────────────────────────────────────────────────────────────────

// Filler words dropped before comparing case-type names by significant-token set.
const STOP = new Set(['or', 'to', 'of', 'a', 'an', 'the', 'and', 'for', 'report', 'request', 'issue', 'issues', 'concern', 'concerns']);
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function sigTokens(s: string): Set<string> {
  return new Set(normName(s).split(' ').filter((t) => t && !STOP.has(t)));
}
function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}
const CATEGORY_BY_NAME = Object.entries(CATEGORIES).map(([key, cfg]) => ({
  key,
  norm: normName(cfg.portalCaseTypeName),
  tok: sigTokens(cfg.portalCaseTypeName),
}));

/**
 * Map a portal case-type name to one of our category keys; unmatched → 'unsure'.
 * Matches on the set of significant tokens (filler words dropped) so the public grid's
 * full names AND the /analytics/ abbreviations ("Trash or Recycling Bins/Carts",
 * "Snow Plowing/Salting/Sanding") both resolve; a ≥2-token subset covers partial labels.
 */
export function mapCategory(caseTypeName: string): string {
  const n = normName(caseTypeName);
  if (!n) return 'unsure';
  for (const e of CATEGORY_BY_NAME) if (e.norm === n) return e.key; // exact normalized

  const t = sigTokens(caseTypeName);
  for (const e of CATEGORY_BY_NAME) {
    if (e.key === 'unsure') continue;
    if (t.size === e.tok.size && isSubset(t, e.tok)) return e.key; // same significant tokens
  }
  for (const e of CATEGORY_BY_NAME) {
    if (e.key === 'unsure') continue;
    if (Math.min(t.size, e.tok.size) >= 2 && (isSubset(t, e.tok) || isSubset(e.tok, t))) return e.key; // subset
  }
  return 'unsure';
}

// ── Geocoding (ArcGIS findAddressCandidates) + Firestore cache ───────────────────────────

async function geocodeStreet(street: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const single = encodeURIComponent(`${street}, Providence, RI`);
    const url =
      `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates` +
      `?SingleLine=${single}&f=json&maxLocations=1&outFields=Match_addr&outSR=4326&countryCode=USA`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { candidates?: { location?: { x: number; y: number }; score?: number }[] };
    const c = data.candidates?.[0];
    if (!c?.location) return null;
    const lat = c.location.y;
    const lng = c.location.x;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < GEO_BOUNDS.minLat || lat > GEO_BOUNDS.maxLat || lng < GEO_BOUNDS.minLng || lng > GEO_BOUNDS.maxLng) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

interface GeoCache { lat: number | null; lng: number | null }

async function getCachedGeo(store: Store, street: string): Promise<GeoCache | null> {
  return store.getMeta<GeoCache>('geo_' + (await sha1Hex(street)));
}
async function setCachedGeo(store: Store, street: string, g: { lat: number; lng: number } | null): Promise<void> {
  // Cache negatives too (lat:null) so an un-geocodable street is never re-queried.
  await store.setMeta('geo_' + (await sha1Hex(street)), {
    street,
    lat: g?.lat ?? null,
    lng: g?.lng ?? null,
    at: new Date().toISOString(),
  });
}

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Helpers shared with api.ts ───────────────────────────────────────────────────────────

/** Stable, unguessable-enough id for a city feed item (no real case id exists). */
export function cityItemId(item: { caseTypeName: string; street: string; createdOn: string }): string {
  return 'city:' + fnv1a(`${item.caseTypeName}|${item.street}|${item.createdOn}`);
}
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Parse the raw "Created On" cell to an ISO string, or null if unparseable. */
export function parseCityDate(createdOn: string): string | null {
  if (!createdOn) return null;
  const t = Date.parse(createdOn);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
