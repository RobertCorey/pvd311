/**
 * street.ts — "My street": what the city is doing within a few blocks of an address, from the cityCases record
 * (citycases.ts), and the opt-in weekly email about it.
 *
 * Rob, 2026-10-25: "we have kind of the zillow problem where our app isn't really sticky… zillow built in these other
 * features so people not actively buying or selling would still check it." The city's public feed is the data we
 * already have; this gives people who are not reporting anything a reason to look (and an email that brings them back).
 *
 *   GET /api/street/map[?days=30]  THE /street page's only feed (2026-10-25, map-first page): every non-draft case
 *     created or closed inside the window — located and unlocated — as columnar tuples + index tables (MapFeed),
 *     ~50 KB brotli for 30 days. Pan/zoom/filter/cluster all happen in the browser from this one array; `days` is
 *     snapped to 7 / 30 / 90 so the HTTP cache and the isolate cache hit. Public, cached 5 min per isolate + HTTP.
 *   GET /api/street?lat&lng[&radiusM=300][&days=30]  public, cached 5 min per isolate + HTTP
 *     → { items: StreetCase[], radiusM, days, at }   newest activity first (created or closed inside the window)
 *     Kept for the weekly digest's nearby filter and old links; the page no longer calls it.
 *   GET /api/street/city[?days=7]  citywide: counts, busiest case types, newest 20 — kept for old links; the page
 *     now derives the citywide numbers from /api/street/map (Rob, 2026-10-25: "ideally we want to show something")
 *   GET /api/street/case/:guid  one case by GUID, public — the page's fallback for a `?case=` deep link (the follow
 *     mail's "See it on the map", a /my row) whose case is older than the loaded window. 404 when gone or a draft.
 *
 *   runStreetDigest (Mondays, from runDaily): every account with prefs.streetDigest and a saved address gets ONE mail
 *   listing the week's new and closed cases within DIGEST_RADIUS_M of each address — nothing happened → no mail.
 *   "Only tell me about…" (prefs.watchGroups, watchgroups.ts): a section lists only the cases whose picker group the
 *   account chose; an address with nothing left after that filter gets no section, so no mail or push mentions it.
 */
import type { Env, Mailer, SavedAddress, Store, UserDoc } from './contracts.js';
import { CLOSED, closedAt, type CaseLike } from './cityinsights.js';
import { CITY_GUID_RE, followedCaseView, type FollowedCase } from './cityfollow.js';
import { geocodeStreetCached } from './cityfeed.js';
import { logEvent } from './health.js';
import { ensureVapid, hasPush, logPushes, pushAll, type PushPayload, type VapidKeys } from './push.js';
import { groupAllowed } from './watchgroups.js';

export const DEFAULT_RADIUS_M = 300;
export const MAX_RADIUS_M = 1000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const DIGEST_RADIUS_M = 300;
export const DIGEST_DAYS = 7;
const LOAD_TTL_MS = 5 * 60_000;
/** Rows per Firestore read; a window that fills it may be missing its oldest cases (MapFeed.truncated). */
export const LOAD_LIMIT = 3000;
/** Resolution Message cut for the map feed (the live average is ~36 chars; 300 keeps every real note whole). */
const MAP_RES_MAX = 300;
/** The city's status vocabulary in lifecycle order — seeds MapFeed.statuses so indexes are stable across responses. */
export const KNOWN_STATUSES = ['Submitted', 'Assigned', 'In Progress', 'Department Responded', 'Resolved', 'Closed', 'Cancelled', 'Merged'] as const;
/** Cases closed inside the window may have been created well before it; load this much further back. */
const CLOSE_LOOKBACK_DAYS = 60;

export interface StreetCase {
  id: string; caseType: string; category: string; street: string; status: string; open: boolean;
  createdAt: string | null; closedAt: string | null; resolution: string | null;
  lat: number; lng: number; distanceM: number;
}

type Row = Record<string, unknown>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1); const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const parse = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null;
  const v = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(v) ? null : v;
};

/** Cases within `radiusM` of the point whose creation or close falls inside the last `days`; newest activity first. Pure. */
export function nearbyCases(rows: Row[], o: { lat: number; lng: number; radiusM: number; days: number; now?: number }): StreetCase[] {
  const now = o.now ?? Date.now();
  const since = now - o.days * 86_400_000;
  const out: (StreetCase & { activity: number })[] = [];
  for (const c of rows) {
    const lat = c.lat; const lng = c.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (/^draft$/i.test(String(c.status ?? ''))) continue;
    const d = haversineMeters(o.lat, o.lng, lat, lng);
    if (d > o.radiusM) continue;
    const status = String(c.status ?? '');
    const open = !CLOSED.has(status);
    const created = parse(c.createdAt);
    const closed = open ? null : closedAt(c as unknown as CaseLike);
    const activity = Math.max(created ?? 0, closed ?? 0);
    if (!activity || activity < since) continue;
    const detail = (c.detail ?? null) as { resolution?: string | null } | null;
    out.push({
      id: String(c.id), caseType: String(c.caseType ?? ''), category: String(c.category ?? 'unsure'), street: String(c.street ?? ''),
      status, open, createdAt: created != null ? new Date(created).toISOString() : null,
      closedAt: closed != null ? new Date(closed).toISOString() : null,
      resolution: detail?.resolution?.trim() || null, lat, lng, distanceM: Math.round(d), activity,
    });
  }
  out.sort((a, b) => b.activity - a.activity);
  return out.map(({ activity: _a, ...rest }) => rest);
}

// ── Citywide overview (the landing state, and the fallback when a street is quiet) ────────

export interface CityOverview {
  days: number; total: number; open: number; closed: number; located: number;
  topTypes: { caseType: string; category: string; n: number }[];
  latest: Omit<StreetCase, 'lat' | 'lng' | 'distanceM'>[];
  at: string;
}

/** Everything created or closed in the last `days`, citywide — counts, the busiest case types, the newest activity. Pure. */
export function cityOverview(rows: Row[], o: { days: number; now?: number; latestN?: number }): CityOverview {
  const now = o.now ?? Date.now();
  const since = now - o.days * 86_400_000;
  const types = new Map<string, { caseType: string; category: string; n: number }>();
  const latest: (Omit<StreetCase, 'lat' | 'lng' | 'distanceM'> & { activity: number })[] = [];
  let open = 0; let closed = 0; let located = 0;
  for (const c of rows) {
    if (/^draft$/i.test(String(c.status ?? ''))) continue;
    const status = String(c.status ?? '');
    const isOpen = !CLOSED.has(status);
    const created = parse(c.createdAt);
    const closedAtMs = isOpen ? null : closedAt(c as unknown as CaseLike);
    const activity = Math.max(created ?? 0, closedAtMs ?? 0);
    if (!activity || activity < since) continue;
    if (isOpen) open++; else closed++;
    if (typeof c.lat === 'number') located++;
    const caseType = String(c.caseType ?? '');
    const t = types.get(caseType) ?? { caseType, category: String(c.category ?? 'unsure'), n: 0 };
    t.n++; types.set(caseType, t);
    const detail = (c.detail ?? null) as { resolution?: string | null } | null;
    latest.push({
      id: String(c.id), caseType, category: String(c.category ?? 'unsure'), street: String(c.street ?? ''), status, open: isOpen,
      createdAt: created != null ? new Date(created).toISOString() : null,
      closedAt: closedAtMs != null ? new Date(closedAtMs).toISOString() : null,
      resolution: detail?.resolution?.trim() || null, activity,
    });
  }
  latest.sort((a, b) => b.activity - a.activity);
  return {
    days: o.days, total: open + closed, open, closed, located,
    topTypes: [...types.values()].sort((a, b) => b.n - a.n).slice(0, 5),
    latest: latest.slice(0, o.latestN ?? 20).map(({ activity: _a, ...rest }) => rest),
    at: new Date(now).toISOString(),
  };
}

export async function handleStreetCity(url: URL, store: Store): Promise<Response> {
  const d = Number(url.searchParams.get('days'));
  const days = Math.min(MAX_DAYS, Math.max(1, Number.isFinite(d) && d > 0 ? Math.round(d) : 7));
  const rows = await loadCases(store, days);
  return json(cityOverview(rows, { days }), 200, { 'cache-control': 'public, max-age=300' });
}

// ── Map feed (the /street page's one request) ─────────────────────────────────────────────

/**
 * One case as a tuple: [id, t, s, createdMin, closedMin, lat, lng, street, res].
 *   t / s        index into MapFeed.types / MapFeed.statuses
 *   createdMin   floor(createdAt / 60 s) in UTC minutes, 0 when unparseable
 *   closedMin    floor(closedAt / 60 s) for closed cases (resolutionDate, else the close we watched), 0 when open/unknown
 *   lat / lng    rounded to 5 dp, or null when the case has no coordinates (still counted in `total`)
 *   street       "" when blank
 *   res          the city's Resolution Message, trimmed and cut to 300 chars, or 0 when absent (clients read `res || null`)
 * `open` is not transmitted: the client derives it from statuses[s] with the same CLOSED set as cityinsights.
 */
export type MapItem = [id: string, t: number, s: number, createdMin: number, closedMin: number, lat: number | null, lng: number | null, street: string, res: string | 0];

export interface MapFeed {
  v: 1;
  days: number;
  /** When this response was built. */
  at: string;
  /** Non-draft cases created or closed inside the window, unlocated included. */
  total: number;
  /** Of those, with coordinates. */
  located: number;
  /** True when the load hit LOAD_LIMIT — the window may be missing its oldest cases. */
  truncated: boolean;
  /** index = t → [city caseType, category key] ('unsure' when the doc has none). */
  types: [string, string][];
  /** index = s; starts with KNOWN_STATUSES, any other status string seen is appended. */
  statuses: string[];
  items: MapItem[];
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/**
 * Every non-draft case created or closed in the last `days`, as the columnar feed above. Same inclusion rule as
 * nearbyCases (skip Draft, activity = max(created, closedAt) ≥ since), newest activity first (input order is the
 * tiebreak — the sort is stable). Pure.
 */
export function mapFeed(rows: Row[], o: { days: number; now?: number; truncated?: boolean }): MapFeed {
  const now = o.now ?? Date.now();
  const since = now - o.days * 86_400_000;
  const types: [string, string][] = [];
  const typeIndex = new Map<string, number>();
  const statuses: string[] = [...KNOWN_STATUSES];
  const statusIndex = new Map<string, number>(statuses.map((s, i) => [s, i]));
  const items: { item: MapItem; activity: number }[] = [];
  let located = 0;
  for (const c of rows) {
    const status = String(c.status ?? '');
    if (/^draft$/i.test(status)) continue;
    const open = !CLOSED.has(status);
    const created = parse(c.createdAt);
    const closed = open ? null : closedAt(c as unknown as CaseLike);
    const activity = Math.max(created ?? 0, closed ?? 0);
    if (!activity || activity < since) continue;
    const caseType = String(c.caseType ?? '');
    let t = typeIndex.get(caseType);
    if (t == null) {
      t = types.length;
      types.push([caseType, typeof c.category === 'string' && c.category ? c.category : 'unsure']);
      typeIndex.set(caseType, t);
    }
    let s = statusIndex.get(status);
    if (s == null) { s = statuses.length; statuses.push(status); statusIndex.set(status, s); }
    const hasGeo = typeof c.lat === 'number' && typeof c.lng === 'number' && Number.isFinite(c.lat) && Number.isFinite(c.lng);
    if (hasGeo) located++;
    const detail = (c.detail ?? null) as { resolution?: string | null } | null;
    const res = detail?.resolution?.trim() || '';
    items.push({
      activity,
      item: [
        String(c.id), t, s,
        created != null ? Math.floor(created / 60_000) : 0,
        closed != null ? Math.floor(closed / 60_000) : 0,
        hasGeo ? round5(c.lat as number) : null,
        hasGeo ? round5(c.lng as number) : null,
        String(c.street ?? ''),
        res ? res.slice(0, MAP_RES_MAX) : 0,
      ],
    });
  }
  items.sort((a, b) => b.activity - a.activity);
  return {
    v: 1, days: o.days, at: new Date(now).toISOString(),
    total: items.length, located, truncated: o.truncated ?? false,
    types, statuses, items: items.map((x) => x.item),
  };
}

/** `days` → the window the caches are keyed on: missing/NaN/≤0 → 30; 1–7 → 7; 8–30 → 30; anything larger → 90. */
export function snapDays(raw: string | null): 7 | 30 | 90 {
  const d = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(d) || d <= 0) return DEFAULT_DAYS;
  if (d <= 7) return 7;
  if (d <= 30) return DEFAULT_DAYS;
  return MAX_DAYS;
}

export async function handleStreetMap(url: URL, store: Store): Promise<Response> {
  const days = snapDays(url.searchParams.get('days'));
  const rows = await loadCases(store, days);
  return json(mapFeed(rows, { days, truncated: rows.length >= LOAD_LIMIT }), 200, { 'cache-control': 'public, max-age=300' });
}

// ── GET /api/street/case/:guid ────────────────────────────────────────────────────────────

/** One case as the /my list shows it (cityfollow.followedCaseView without `followedAt`): a deep link's fallback. */
export type StreetCaseView = Omit<FollowedCase, 'followedAt'>;

/** 400 `invalid_id` off the GUID shape; 404 `not_found` when there is no doc or it is a draft (the feed skips drafts
 *  too); otherwise the StreetCaseView, cacheable 5 min like the feed. One doc read, no window load. */
export async function handleStreetCase(guid: string, store: Store): Promise<Response> {
  if (!CITY_GUID_RE.test(guid)) return json({ error: 'invalid_id' }, 400);
  const doc = await store.getCityCase(guid);
  if (!doc || /^draft$/i.test(String(doc.status ?? ''))) return json({ error: 'not_found' }, 404, { 'cache-control': 'public, max-age=60' });
  const { followedAt: _followedAt, ...view } = followedCaseView({ ...doc, id: guid });
  return json(view satisfies StreetCaseView, 200, { 'cache-control': 'public, max-age=300' });
}

// ── Loading (one Firestore read per window per 5 minutes per isolate) ─────────────────────

const loads = new Map<string, { at: number; rows: Promise<Row[]> }>();

/** Rows created in the last `days` + the 60-day close lookback, cached per (since, limit) for 5 minutes. `limit` is
 *  LOAD_LIMIT unless a caller needs a deeper read (week.ts's archive weeks reach 130 days back and would otherwise
 *  lose their oldest — the wanted — rows, since the query is newest-first). */
export async function loadCases(store: Store, days: number, now = Date.now(), limit = LOAD_LIMIT): Promise<Row[]> {
  const since = new Date(now - (days + CLOSE_LOOKBACK_DAYS) * 86_400_000).toISOString().slice(0, 10);
  const key = `${since}|${limit}`;
  const hit = loads.get(key);
  if (hit && now - hit.at < LOAD_TTL_MS) return hit.rows;
  const rows = store.listCityCasesSince(since, limit);
  loads.set(key, { at: now, rows });
  rows.catch(() => loads.delete(key));
  return rows;
}

/** Tests: drop the in-isolate cache. */
export function resetStreetCache(): void { loads.clear(); }

// ── GET /api/street ───────────────────────────────────────────────────────────────────────

export async function handleStreet(url: URL, store: Store): Promise<Response> {
  const lat = Number(url.searchParams.get('lat')); const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 41.6 || lat > 42.05 || lng < -71.7 || lng > -71.2) return json({ error: 'invalid_coords', field: 'lat' }, 400);
  const r = Number(url.searchParams.get('radiusM'));
  const radiusM = Math.min(MAX_RADIUS_M, Math.max(50, Number.isFinite(r) && r > 0 ? Math.round(r) : DEFAULT_RADIUS_M));
  const d = Number(url.searchParams.get('days'));
  const days = Math.min(MAX_DAYS, Math.max(1, Number.isFinite(d) && d > 0 ? Math.round(d) : DEFAULT_DAYS));
  const rows = await loadCases(store, days);
  const items = nearbyCases(rows, { lat, lng, radiusM, days });
  return json({ items, radiusM, days, at: new Date().toISOString() }, 200, { 'cache-control': 'public, max-age=300' });
}

// ── Weekly digest ─────────────────────────────────────────────────────────────────────────

export interface DigestSection { id?: string; label: string; address: string; url: string; items: StreetCase[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : '');

export function streetUrl(base: string, a: { lat: number; lng: number; address: string }): string {
  return `${base}/street?lat=${a.lat.toFixed(5)}&lng=${a.lng.toFixed(5)}&q=${encodeURIComponent(a.address)}`;
}

/** Subject + HTML for one person's weekly mail. `sections` only holds addresses where something happened. */
export function streetDigestEmail(sections: DigestSection[], o: { base: string; since: string }): { subject: string; html: string } {
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const newN = sections.reduce((n, s) => n + s.items.filter((i) => i.createdAt && i.createdAt >= o.since).length, 0);
  const closedN = sections.reduce((n, s) => n + s.items.filter((i) => !i.open && i.closedAt && i.closedAt >= o.since).length, 0);
  const where = sections.length === 1 ? sections[0].label || sections[0].address : `${sections.length} of your addresses`;
  const subject = `This week near ${where}: ${newN} new, ${closedN} closed`;
  const row = (i: StreetCase) => {
    const when = i.open ? `reported ${day(i.createdAt)}` : `closed ${day(i.closedAt)}`;
    const note = !i.open && i.resolution ? `<div style="color:#555;margin:2px 0 0 1em;white-space:pre-wrap">${esc(i.resolution)}</div>` : '';
    return `<li style="margin:0 0 8px"><b>${esc(i.caseType)}</b> · ${esc(i.street)} · ${esc(i.status)} (${when})${note}</li>`;
  };
  const html = sections.map((s) =>
    `<h3 style="margin:1.2em 0 .3em">${esc(s.label || s.address)}<span style="font-weight:normal;color:#666"> — ${esc(s.address)}</span></h3>`
    + `<ul style="padding-left:1.2em;margin:0">${s.items.map(row).join('')}</ul>`
    + `<p style="margin:.5em 0 0"><a href="${esc(s.url)}">See everything near here</a></p>`).join('')
    + `<p style="color:#888;margin-top:2em">City cases within about ${DIGEST_RADIUS_M} m, from Providence 311's public list. ${total} this week. `
    + `You asked for this weekly email on FixMyPVD — turn it off with "Turn off" under <a href="${esc(sections[0]?.url ?? `${o.base}/street`)}">Hear about this street every week</a> on your street page, `
    + `or manage your addresses under <a href="${esc(o.base)}/account">Account</a>. `
    + `FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  return { subject, html };
}

/** The push (push.ts) for one address's week — "This week near <label>" / "<new> new · <closed> closed", opening that
 *  street page. Tagged per address so two saved addresses give two notifications instead of one replacing the other. */
export function streetDigestPush(s: DigestSection, since: string): PushPayload {
  const newN = s.items.filter((i) => i.createdAt && i.createdAt >= since).length;
  const closedN = s.items.filter((i) => !i.open && i.closedAt && i.closedAt >= since).length;
  return { title: `This week near ${s.label || s.address}`, body: `${newN} new · ${closedN} closed`, url: s.url, tag: `street:${s.id ?? s.label}` };
}

/** Mondays: one mail per opted-in account with activity near a saved address, and a push per such address to the
 *  account's subscribed phones (push.ts; mail needs a verified email, a push only needs the subscription). The account's
 *  "Only tell me about…" groups (watchgroups.groupAllowed) are applied to each address's cases before a section is built,
 *  so the mail's rows, the subject's counts and the push's "<new> new · <closed> closed" all count matching cases only.
 *  Returns counts for the log. */
export async function runStreetDigest(env: Env, store: Store, mailer: Mailer, opts: { now?: number } = {}): Promise<{ users: number; mailed: number; pushed: number }> {
  const now = opts.now ?? Date.now();
  const base = env.APP_BASE_URL ?? 'https://fixmypvd.org';
  const since = new Date(now - DIGEST_DAYS * 86_400_000).toISOString();
  const users = await store.listStreetDigestUsers(500);
  let mailed = 0; let pushed = 0; let pushUsers = 0;
  let keys: VapidKeys | null = null;
  let rows: Row[] | null = null;
  for (const u of users) {
    const canMail = !!u.email && !!u.emailVerified;
    const canPush = hasPush(u);
    if ((!canMail && !canPush) || !(u.addresses ?? []).length) continue;
    rows ??= await loadCases(store, DIGEST_DAYS, now);
    const sections: DigestSection[] = [];
    let patched = false;
    const addresses: SavedAddress[] = [];
    for (const a of u.addresses) {
      let { lat, lng } = a;
      if (lat == null || lng == null) {
        const hit = await geocodeStreetCached(store, a.address).catch(() => null);
        if (hit) { lat = hit.lat; lng = hit.lng; patched = true; }
      }
      addresses.push({ ...a, lat, lng });
      if (lat == null || lng == null) continue;
      const items = nearbyCases(rows, { lat, lng, radiusM: DIGEST_RADIUS_M, days: DIGEST_DAYS, now }).filter((c) => groupAllowed(u, c));
      if (items.length) sections.push({ id: a.id, label: a.label, address: a.address, url: streetUrl(base, { lat, lng, address: a.address }), items });
    }
    if (patched) await store.patchUser(u.uid, { addresses }).catch(() => {});
    if (!sections.length) continue;
    if (canMail) {
      const m = streetDigestEmail(sections, { base, since });
      await mailer.sendTo(u.email!, m.subject, m.html, { kind: 'street_digest' });
      mailed++;
    }
    if (canPush) {
      pushUsers++;
      try {
        keys ??= await ensureVapid(store);
        for (const s of sections) pushed += await pushAll(store, u, streetDigestPush(s, since), keys);
      } catch (e) { console.error('[street] digest push failed:', e instanceof Error ? e.message : e); }
    }
  }
  console.log(`[street] digest: ${mailed} of ${users.length} opted-in accounts mailed, ${pushed} pushes`);
  await logEvent(store, { level: 'info', kind: 'street.digest', msg: `Weekly street digest: ${mailed} of ${users.length} opted-in accounts had something to hear about`, data: { users: users.length, mailed, pushed } });
  await logPushes(store, 'street_digest', { users: pushUsers, sent: pushed });
  await store.setMeta('streetDigest', { at: new Date(now).toISOString(), users: users.length, mailed, pushed }).catch(() => {});
  return { users: users.length, mailed, pushed };
}

export type { UserDoc };
