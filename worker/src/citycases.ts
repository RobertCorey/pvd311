/**
 * citycases.ts — keep a record of every case on the city's public feed (/public-requests/), not just ours.
 *
 * Two anonymous, read-only surfaces, both plain HTTP (no browser):
 *  - the grid's data endpoint (POST /_services/entity-grid-data.json/<view>): a rolling 7-day window
 *    (~230 cases), 50 per call. Gives the case GUID, case type, street, status and created time.
 *  - the row's detail form (GET /_portal/modal-form-template-path/<view>?id=<guid>&entityformid=…): the
 *    full address, received / routed / work-completed / resolution dates, the city's
 *    Resolution Message and the city-question answers. No description, photo, case number or reporter.
 *
 * The grid POST needs the page's opaque `base64SecureConfiguration`. It is not in the page HTML (the PCF
 * script builds it), so cityfeed.ts captures it from the watcher's Playwright page load and stores it in
 * meta/cityGridConfig; it is session-independent, so plain requests reuse it until the city changes the site.
 *
 * Gentle by design: requests run one at a time with REQUEST_GAP_MS between them, the list stops after
 * MAX_LIST_PAGES, and a detail form is fetched only when a case is first seen or its status changed
 * (≤ DETAIL_PER_RUN per run). Open cases that left the 7-day window get one detail check a day
 * (≤ FOLLOWUP_PER_DAY) so long-running cases still get their resolution. Writes are change-only:
 * one index doc (meta/cityCasesIdx) plus cityCases/{guid} for new or changed cases.
 *
 * Everything the public form shows is stored, licence plates and landlord names included (Rob, 2026-10-17).
 *
 * Each case's street is geocoded once (cityfeed.geocodeStreetCached → lat/lng on the doc; `g` in the index) so the
 * public "My street" page (street.ts) can find cases near an address. Cases stored before this got lat/lng get
 * one daily backfill pass (backfillCityCaseGeo).
 */
import type { Env, Store } from './contracts.js';
import { GRID_CONFIG_META, geocodeStreetCached, mapCategory } from './cityfeed.js';
import { logEvent, markError, markOk } from './health.js';

const INDEX_META = 'cityCasesIdx';
const PAGE_SIZE = 50;
const MAX_LIST_PAGES = 8;            // 7-day window is ~5 pages at 50
export const DETAIL_PER_RUN = 25;
export const FOLLOWUP_PER_DAY = 40;
export const GEOCODES_PER_RUN = 40;   // new ArcGIS lookups per sync (the meta/geo_* cache makes repeats free)
export const GEO_BACKFILL_PER_DAY = 400;
const REQUEST_GAP_MS = 1_500;
const WINDOW_MS = 7 * 24 * 3_600_000;
const KEEP_OPEN_MS = 60 * 24 * 3_600_000; // stop following an open case after 60 days
// The detail form's ids (seen on the live row click, 2026-10-17). The view id is also the grid's.
const DETAIL_FORM_PATH = '/_portal/modal-form-template-path/07a4fc2f-c349-ef11-a316-001dd800f706';
const DETAIL_ENTITY_FORM = '9f5af76f-2897-46df-99b0-0b6aed8ccee9';
const UA = 'FixMyPVD/1.0 (+https://fixmypvd.org; public-requests reader)';
const TERMINAL = new Set(['Resolved', 'Cancelled', 'Closed']);

export interface GridConfig { url: string; body: Record<string, unknown>; at: string }

export interface CityCaseRow {
  id: string;            // the case's entity GUID (incidentid)
  caseType: string;
  caseTypeId: string | null;
  street: string;
  status: string;
  createdAt: string | null; // ISO
}

export interface CityCaseDetail {
  status: string | null;
  address: string | null;
  receivedOn: string | null;
  routedOn: string | null;
  workCompletedOn: string | null;
  resolutionDate: string | null;
  resolution: string | null;
  /** Other city fields with a value: dropdown label, text, or true for a "Yes" radio. */
  answers: Record<string, string | true>;
  /** The form's own label for each answered field ("Type of Animal"). */
  labels: Record<string, string>;
}

/** Index entry: s = last known status, ds = the value of s when the detail was last read, c = created ISO, dc = last detail read ISO, dv = DETAIL_VERSION of that read, g = 1 once the street was geocoded (lat/lng on the doc, null when the geocoder had nothing). */
interface IdxEntry { s: string; ds?: string; c: string | null; dc?: string; dv?: number; g?: 1 }
/** Bump when parseDetailHtml stores more, so already-read cases are read again (2: plates/landlords + labels). */
const DETAIL_VERSION = 2;
type Index = Record<string, IdxEntry>;

// ── Parsing (pure) ───────────────────────────────────────────────────────────────────────

interface GridAttr { Name: string; Value?: unknown; FormattedValue?: string | null }
interface GridRecord { Id: string; Attributes: GridAttr[] }

/** One grid record → row. Null when it has no id or case type. */
export function parseGridRecord(rec: GridRecord): CityCaseRow | null {
  const a = new Map(rec.Attributes.map((x) => [x.Name, x]));
  const ct = a.get('cop_casetype');
  const ctVal = (ct?.Value ?? null) as { Id?: string; Name?: string } | null;
  const caseType = (ctVal?.Name ?? ct?.FormattedValue ?? '').trim();
  if (!rec.Id || !caseType) return null;
  const street = a.get('cop_street1');
  return {
    id: rec.Id,
    caseType,
    caseTypeId: ctVal?.Id ?? null,
    street: String(street?.Value ?? street?.FormattedValue ?? '').trim(),
    status: (a.get('statuscode')?.FormattedValue ?? '').trim(),
    createdAt: parseMsDate(a.get('createdon')?.Value),
  };
}

/** "/Date(1792007521000)/" → ISO. */
function parseMsDate(v: unknown): string | null {
  const m = typeof v === 'string' ? v.match(/\/Date\((-?\d+)\)\//) : null;
  return m ? new Date(Number(m[1])).toISOString() : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}
const isCityField = (id: string) => /^(cop_|adx_|createdon$)/.test(id) && !/_datepicker_description$/.test(id);

/** The detail form's HTML → fields. Read from the server-rendered form; no DOM needed. */
export function parseDetailHtml(html: string): CityCaseDetail {
  const raw: Record<string, string | true> = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const id = attr(tag, 'id'); const type = (attr(tag, 'type') ?? 'text').toLowerCase();
    if (!id || type === 'hidden') continue;
    if (type === 'radio') {
      // Every unanswered yes/no shows its "No" pre-checked, so only a checked "Yes" carries information.
      const base = id.replace(/_[01]$/, '');
      if (id.endsWith('_1') && /\schecked(="[^"]*")?/i.test(tag) && isCityField(base)) raw[base] = true;
      continue;
    }
    const v = (attr(tag, 'value') ?? '').trim();
    if (v && isCityField(id)) raw[id] = v;
  }
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const id = attr(m[1], 'id');
    if (!id || !isCityField(id)) continue;
    const opt = m[2].match(/<option\b[^>]*\sselected(?:="[^"]*")?[^>]*>([^<]*)<\/option>/i);
    const val = opt ? attr(opt[0], 'value') : null;
    if (opt && val) raw[id] = decodeEntities(opt[1]).trim();
  }
  for (const m of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const id = attr(m[1], 'id');
    const v = decodeEntities(m[2]).trim();
    if (id && v && isCityField(id)) raw[id] = v;
  }
  const status = html.match(/<span\b[^>]*\bid="statuscode"[^>]*>([^<]*)<\/span>/i);

  const take = (k: string): string | null => { const v = raw[k]; delete raw[k]; return typeof v === 'string' ? v : null; };
  const address = take('cop_address');
  const out: CityCaseDetail = {
    status: status ? decodeEntities(status[1]).trim() || null : null,
    address,
    receivedOn: take('cop_receivedon'),
    routedOn: take('cop_routedon'),
    workCompletedOn: take('cop_workcompletedon'),
    resolutionDate: take('adx_resolutiondate'),
    resolution: take('adx_resolution'),
    answers: {},
    labels: {},
  };
  take('createdon'); take('cop_casetype_name'); // already on the row
  for (const [k, v] of Object.entries(raw)) {
    out.answers[k] = v;
    const lab = html.match(new RegExp(`<label\\b[^>]*\\bid="${k}_label"[^>]*>([^<]*)</label>`, 'i'));
    if (lab && decodeEntities(lab[1]).trim()) out.labels[k] = decodeEntities(lab[1]).trim();
  }
  return out;
}

// ── HTTP (gentle, one request at a time) ────────────────────────────────────────────────

class CityHttp {
  private last = 0;
  private cookies = new Map<string, string>();
  requests = 0;
  constructor(private base: string, private gapMs: number) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const headers = new Headers(init.headers);
    headers.set('user-agent', UA);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    try {
      const resp = await fetch(path.startsWith('http') ? path : this.base + path, { ...init, headers, redirect: 'manual' });
      for (const c of resp.headers.getSetCookie?.() ?? []) {
        const kv = c.split(';')[0]; const i = kv.indexOf('=');
        if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
      return resp;
    } finally { this.last = Date.now(); this.requests++; }
  }
}

async function antiForgeryToken(http: CityHttp): Promise<string> {
  const resp = await http.fetch('/_layout/tokenhtml');
  const t = (await resp.text()).match(/value="([^"]+)"/)?.[1];
  if (!resp.ok || !t) throw new Error(`token: HTTP ${resp.status}`);
  return t;
}

async function listAll(http: CityHttp, cfg: GridConfig): Promise<{ rows: CityCaseRow[]; total: number | null; complete: boolean }> {
  const token = await antiForgeryToken(http);
  const rows: CityCaseRow[] = [];
  let total: number | null = null;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const resp = await http.fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', '__RequestVerificationToken': token, 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ ...cfg.body, page, pageSize: PAGE_SIZE }),
    });
    if (!resp.ok) throw new Error(`grid page ${page}: HTTP ${resp.status}`);
    const j = (await resp.json()) as { Records?: GridRecord[]; ItemCount?: number; MoreRecords?: boolean };
    total = j.ItemCount ?? total;
    for (const rec of j.Records ?? []) { const r = parseGridRecord(rec); if (r) rows.push(r); }
    if (!j.MoreRecords || !j.Records?.length) return { rows, total, complete: true };
  }
  return { rows, total, complete: false };
}

async function readDetail(http: CityHttp, id: string): Promise<CityCaseDetail> {
  const resp = await http.fetch(`${DETAIL_FORM_PATH}?id=${encodeURIComponent(id)}&entityformid=${DETAIL_ENTITY_FORM}&languagecode=1033`);
  if (!resp.ok) throw new Error(`detail ${id}: HTTP ${resp.status}`);
  const d = parseDetailHtml(await resp.text());
  if (!d.status && !d.address) throw new Error(`detail ${id}: no form fields`);
  return d;
}

// ── Sync ────────────────────────────────────────────────────────────────────────────────

const statusKey = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_') || 'unknown';

/** Which cases need a detail read this run: never read, the list status moved since the last read, or read by an older parser. Oldest first. */
export function pickDetailReads(index: Index, limit: number): string[] {
  return Object.entries(index)
    .filter(([, e]) => e.ds === undefined || e.ds !== e.s || (e.ds !== undefined && (e.dv ?? 1) < DETAIL_VERSION))
    .sort(([, a], [, b]) => (a.c ?? '').localeCompare(b.c ?? ''))
    .slice(0, limit).map(([id]) => id);
}

/** Every 30 min (after the watcher): list the window, record new/changed cases, read details for some. */
export async function syncCityCases(env: Env, store: Store, opts: { gapMs?: number; now?: number } = {}): Promise<{ listed: number; added: number; changed: number; details: number; requests: number } | null> {
  const cfg = await store.getMeta<GridConfig>(GRID_CONFIG_META).catch(() => null);
  if (!cfg?.url || !cfg.body) { console.log('[citycases] no grid config yet (captured by the city feed scrape)'); return null; }
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const http = new CityHttp(env.PORTAL_BASE_URL, opts.gapMs ?? REQUEST_GAP_MS);
  try {
    const { rows, total, complete } = await listAll(http, cfg);
    const index: Index = (await store.getMeta<{ cases?: Index }>(INDEX_META).catch(() => null))?.cases ?? {};
    let added = 0; let changed = 0; let geocodes = 0;
    for (const r of rows) {
      const e = index[r.id];
      const fields: Record<string, unknown> = {};
      if (!e || e.s !== r.status) {
        Object.assign(fields, {
          id: r.id, caseType: r.caseType, caseTypeId: r.caseTypeId, category: mapCategory(r.caseType),
          street: r.street, status: r.status, createdAt: r.createdAt, statusAt: nowIso,
          [`statusSeen.${statusKey(r.status)}`]: nowIso,
        });
        if (!e) { fields.firstSeenAt = nowIso; added++; } else changed++;
      }
      let g: 1 | undefined = e?.g;
      if (!g && geocodes < GEOCODES_PER_RUN) {
        geocodes++;
        const hit = await geocodeStreetCached(store, r.street);
        fields.lat = hit?.lat ?? null; fields.lng = hit?.lng ?? null;
        g = 1;
      }
      if (!Object.keys(fields).length) continue;
      await store.patchCityCase(r.id, fields);
      index[r.id] = { ...e, s: r.status, c: r.createdAt, ...(g ? { g } : {}) };
    }

    let details = 0;
    for (const id of pickDetailReads(index, DETAIL_PER_RUN)) {
      if (await readAndStoreDetail(http, store, index, id, nowIso, false)) details++;
    }

    pruneIndex(index, now);
    await store.setMeta(INDEX_META, { cases: index, at: nowIso });
    const bf = await backfillCityCaseGeoIfPending(store, GEOCODES_PER_RUN * 2).catch((e) => { console.error('[citycases] geo backfill failed:', e instanceof Error ? e.message : e); return null; });
    const note = `${rows.length}${total != null ? `/${total}` : ''} listed${complete ? '' : ' (partial)'}, ${added} new, ${changed} changed, ${details} details, ${geocodes} geocoded${bf ? `, backfill ${bf.patched} (${bf.remaining} left)` : ''}, ${http.requests} requests`;
    console.log(`[citycases] ${note}`);
    await markOk(store, 'citycases', note);
    return { listed: rows.length, added, changed, details, requests: http.requests };
  } catch (e) {
    console.error('[citycases] failed:', e instanceof Error ? e.message : e);
    await markError(store, 'citycases', e);
    await logEvent(store, { level: 'warn', kind: 'citycases.failed', msg: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

const GEO_BACKFILL_META = 'cityGeoBackfill';

/** Give lat/lng to stored cases that never got geocoded (older than the sync's `g` flag); a blank street gets null outright.
 *  Daily, and from each sync (smaller batch) until a pass finds nothing left — then meta/cityGeoBackfill.doneAt skips the scan. */
export async function backfillCityCaseGeo(store: Store, opts: { limit?: number; days?: number; now?: number } = {}): Promise<{ patched: number; remaining: number }> {
  const now = opts.now ?? Date.now();
  const since = new Date(now - (opts.days ?? 120) * 86_400_000).toISOString();
  const rows = await store.listCityCasesSince(since, 3000);
  const todo = rows.filter((c) => !('lat' in c) || (c.lat != null && !/[A-Za-z]{2,}/.test(String(c.street ?? ''))));
  let patched = 0;
  for (const c of todo.slice(0, opts.limit ?? GEO_BACKFILL_PER_DAY)) {
    const hit = await geocodeStreetCached(store, String(c.street ?? ''));
    await store.patchCityCase(c.id as string, { lat: hit?.lat ?? null, lng: hit?.lng ?? null });
    patched++;
  }
  const remaining = todo.length - patched;
  if (todo.length) console.log(`[citycases] geo backfill: ${patched} of ${todo.length} without coordinates`);
  await store.setMeta(GEO_BACKFILL_META, { at: new Date(now).toISOString(), patched, remaining, ...(remaining === 0 ? { doneAt: new Date(now).toISOString() } : {}) }).catch(() => {});
  return { patched, remaining };
}

/** Sync-time backfill: skipped once a pass has found nothing left (the sync geocodes every new case itself). */
export async function backfillCityCaseGeoIfPending(store: Store, limit: number): Promise<{ patched: number; remaining: number } | null> {
  const m = await store.getMeta<{ doneAt?: string }>(GEO_BACKFILL_META).catch(() => null);
  if (m?.doneAt) return null;
  return backfillCityCaseGeo(store, { limit });
}

/** Daily: one detail check for open cases that left the 7-day list window (their status no longer shows there). */
export async function followUpCityCases(env: Env, store: Store, opts: { gapMs?: number; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const index: Index = (await store.getMeta<{ cases?: Index }>(INDEX_META).catch(() => null))?.cases ?? {};
  const due = Object.entries(index)
    .filter(([, e]) => !TERMINAL.has(e.ds ?? e.s) && e.c && now - Date.parse(e.c) > WINDOW_MS)
    .filter(([, e]) => !e.dc || now - Date.parse(e.dc) > 20 * 3_600_000)
    .sort(([, a], [, b]) => (a.dc ?? '').localeCompare(b.dc ?? ''))
    .slice(0, FOLLOWUP_PER_DAY).map(([id]) => id);
  if (!due.length) return 0;
  const http = new CityHttp(env.PORTAL_BASE_URL, opts.gapMs ?? REQUEST_GAP_MS);
  let n = 0;
  for (const id of due) if (await readAndStoreDetail(http, store, index, id, nowIso, true)) n++;
  pruneIndex(index, now);
  await store.setMeta(INDEX_META, { cases: index, at: nowIso });
  console.log(`[citycases] follow-up: ${n}/${due.length} open cases re-read`);
  return n;
}

/**
 * Inside the window the list is the status authority (a detail that lags it is stored but does not move the
 * index, so the two can't ping-pong). Out of the window (`followUp`) the detail form is the only source.
 */
async function readAndStoreDetail(http: CityHttp, store: Store, index: Index, id: string, nowIso: string, followUp: boolean): Promise<boolean> {
  const e = index[id];
  try {
    const d = await readDetail(http, id);
    const fields: Record<string, unknown> = { detail: d, detailAt: nowIso };
    const s = followUp && d.status ? d.status : e.s;
    if (s !== e.s) { fields.status = s; fields.statusAt = nowIso; fields[`statusSeen.${statusKey(s)}`] = nowIso; }
    await store.patchCityCase(id, fields);
    index[id] = { ...e, s, ds: s, dc: nowIso, dv: DETAIL_VERSION };
    return true;
  } catch (err) {
    console.warn('[citycases] detail failed:', err instanceof Error ? err.message : err);
    index[id] = { ...e, dc: nowIso, ds: e.s, dv: DETAIL_VERSION }; // retried on the next status change, not every run
    return false;
  }
}

/** Drop finished cases once they leave the window, and open ones after KEEP_OPEN_MS. */
function pruneIndex(index: Index, now: number): void {
  for (const [id, e] of Object.entries(index)) {
    const age = e.c ? now - Date.parse(e.c) : Infinity;
    if ((TERMINAL.has(e.ds ?? '') && age > WINDOW_MS + 24 * 3_600_000) || age > KEEP_OPEN_MS) delete index[id];
  }
}
