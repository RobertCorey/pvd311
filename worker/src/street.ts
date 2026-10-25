/**
 * street.ts — "My street": what the city is doing within a few blocks of an address, from the cityCases record
 * (citycases.ts), and the opt-in weekly email about it.
 *
 * Rob, 2026-10-25: "we have kind of the zillow problem where our app isn't really sticky… zillow built in these other
 * features so people not actively buying or selling would still check it." The city's public feed is the data we
 * already have; this gives people who are not reporting anything a reason to look (and an email that brings them back).
 *
 *   GET /api/street?lat&lng[&radiusM=300][&days=30]  public, cached 5 min per isolate + HTTP
 *     → { items: StreetCase[], radiusM, days, at }   newest activity first (created or closed inside the window)
 *
 *   runStreetDigest (Mondays, from runDaily): every account with prefs.streetDigest and a saved address gets ONE mail
 *   listing the week's new and closed cases within DIGEST_RADIUS_M of each address — nothing happened → no mail.
 */
import type { Env, Mailer, SavedAddress, Store, UserDoc } from './contracts.js';
import { CLOSED, closedAt, type CaseLike } from './cityinsights.js';
import { geocodeStreetCached } from './cityfeed.js';
import { logEvent } from './health.js';

export const DEFAULT_RADIUS_M = 300;
export const MAX_RADIUS_M = 1000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const DIGEST_RADIUS_M = 300;
export const DIGEST_DAYS = 7;
const LOAD_TTL_MS = 5 * 60_000;
const LOAD_LIMIT = 3000;
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

// ── Loading (one Firestore read per window per 5 minutes per isolate) ─────────────────────

const loads = new Map<string, { at: number; rows: Promise<Row[]> }>();

export async function loadCases(store: Store, days: number, now = Date.now()): Promise<Row[]> {
  const since = new Date(now - (days + CLOSE_LOOKBACK_DAYS) * 86_400_000).toISOString().slice(0, 10);
  const hit = loads.get(since);
  if (hit && now - hit.at < LOAD_TTL_MS) return hit.rows;
  const rows = store.listCityCasesSince(since, LOAD_LIMIT);
  loads.set(since, { at: now, rows });
  rows.catch(() => loads.delete(since));
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

export interface DigestSection { label: string; address: string; url: string; items: StreetCase[] }

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
    + `You asked for this weekly email on FixMyPVD — turn it off under <a href="${esc(o.base)}/account">Account</a>. `
    + `FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  return { subject, html };
}

/** Mondays: one mail per opted-in account with activity near a saved address. Returns counts for the log. */
export async function runStreetDigest(env: Env, store: Store, mailer: Mailer, opts: { now?: number } = {}): Promise<{ users: number; mailed: number }> {
  const now = opts.now ?? Date.now();
  const base = env.APP_BASE_URL ?? 'https://fixmypvd.org';
  const since = new Date(now - DIGEST_DAYS * 86_400_000).toISOString();
  const users = await store.listStreetDigestUsers(500);
  let mailed = 0;
  let rows: Row[] | null = null;
  for (const u of users) {
    if (!u.email || !u.emailVerified || !(u.addresses ?? []).length) continue;
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
      const items = nearbyCases(rows, { lat, lng, radiusM: DIGEST_RADIUS_M, days: DIGEST_DAYS, now });
      if (items.length) sections.push({ label: a.label, address: a.address, url: streetUrl(base, { lat, lng, address: a.address }), items });
    }
    if (patched) await store.patchUser(u.uid, { addresses }).catch(() => {});
    if (!sections.length) continue;
    const m = streetDigestEmail(sections, { base, since });
    await mailer.sendTo(u.email, m.subject, m.html, { kind: 'street_digest' });
    mailed++;
  }
  console.log(`[street] digest: ${mailed} of ${users.length} opted-in accounts mailed`);
  await logEvent(store, { level: 'info', kind: 'street.digest', msg: `Weekly street digest: ${mailed} of ${users.length} opted-in accounts had something to hear about`, data: { users: users.length, mailed } });
  await store.setMeta('streetDigest', { at: new Date(now).toISOString(), users: users.length, mailed }).catch(() => {});
  return { users: users.length, mailed };
}

export type { UserDoc };
