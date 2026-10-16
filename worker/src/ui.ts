/**
 * First-party usage analytics on Workers Analytics Engine (dataset fixmypvd_ui). Same API host as the app,
 * so content blockers that stub third-party trackers (GA) still let these through.
 *   POST /api/ui            text/plain JSON { e, p, v, s, c?, m?, u?, r?, l? } → 204 (always; never errors the client)
 *   GET  /api/admin/usage   → usage() via the Analytics Engine SQL API (adminapi.ts routes it)
 * Data point: index1 = visitor id (random, localStorage) · blob1 event · blob2 path (already redacted client-side) ·
 * blob3 category · blob4 meta · blob5 country · blob6 device · blob7 utm_source · blob8 referrer host · blob9 session id · blob10 lang.
 */
import type { Env } from './contracts.js';

const DATASET = 'fixmypvd_ui';
/** Funnel order first (page → category → photo → gate → link → login → sent), then side events. */
export const UI_EVENTS = ['page_view', 'select_category', 'photo_added', 'sign_in_gate_shown', 'sign_in_link_sent', 'login', 'report_submitted', 'report_error', 'share'] as const;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|monitor/i;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
function device(ua: string): string {
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  return /mobi|iphone|android/i.test(ua) ? 'mobile' : 'desktop';
}

export async function recordUi(request: Request, env: Env, allowedOrigin: (o: string | null) => boolean): Promise<Response> {
  const done = new Response(null, { status: 204 });
  const ua = request.headers.get('user-agent') ?? '';
  if (!env.UI_EVENTS || BOT.test(ua) || !allowedOrigin(request.headers.get('origin'))) return done;
  const raw = await request.text().catch(() => '');
  if (raw.length > 2048) return done;
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw) as Record<string, unknown>; } catch { return done; }
  const e = str(b.e, 40);
  const vid = str(b.v, 40);
  if (!(UI_EVENTS as readonly string[]).includes(e) || !vid) return done;
  const p = str(b.p, 120);
  const cf = (request as unknown as { cf?: { country?: string } }).cf;
  env.UI_EVENTS.writeDataPoint({
    indexes: [vid],
    blobs: [e, p.startsWith('/') ? p : '', str(b.c, 60), str(b.m, 60), cf?.country ?? '', device(ua), str(b.u, 60).toLowerCase(), str(b.r, 80).toLowerCase(), str(b.s, 40), str(b.l, 8)],
    doubles: [1],
  });
  return done;
}

// ── read side ───────────────────────────────────────────────

type Row = Record<string, string | number>;
async function sql(env: Env, q: string): Promise<Row[]> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: 'POST', headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: `${q} FORMAT JSON`,
  });
  if (!r.ok) throw new Error(`analytics_engine ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { data: Row[] }).data;
}
const num = (v: unknown) => Number(v) || 0;

export interface Usage {
  configured: boolean; days: number;
  totals: { visitors: number; sessions: number; pageViews: number };
  funnel: { event: string; visitors: number; count: number }[];
  daily: { day: string; visitors: number; reports: number }[];
  pages: { path: string; views: number }[];
  sources: { source: string; visitors: number }[];
  countries: { country: string; visitors: number }[];
  devices: { device: string; visitors: number }[];
  categories: { category: string; visitors: number }[];
}

export async function usage(env: Env, days: number): Promise<Usage> {
  const empty: Usage = { configured: false, days, totals: { visitors: 0, sessions: 0, pageViews: 0 }, funnel: [], daily: [], pages: [], sources: [], countries: [], devices: [], categories: [] };
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return empty;
  const where = `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`;
  const top = (col: string, alias: string, extra = '') =>
    `SELECT ${col} AS ${alias}, COUNT(DISTINCT index1) AS visitors FROM ${DATASET} ${where} ${extra} GROUP BY ${alias} ORDER BY visitors DESC LIMIT 10`;
  const [totals, byEvent, daily, pages, sources, countries, devices, categories] = await Promise.all([
    sql(env, `SELECT COUNT(DISTINCT index1) AS visitors, COUNT(DISTINCT blob9) AS sessions, SUM(IF(blob1 = 'page_view', _sample_interval, 0)) AS pageViews FROM ${DATASET} ${where}`),
    sql(env, `SELECT blob1 AS event, COUNT(DISTINCT index1) AS visitors, SUM(_sample_interval) AS count FROM ${DATASET} ${where} GROUP BY event`),
    sql(env, `SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, COUNT(DISTINCT index1) AS visitors, SUM(IF(blob1 = 'report_submitted', _sample_interval, 0)) AS reports FROM ${DATASET} ${where} GROUP BY day ORDER BY day`),
    sql(env, `SELECT blob2 AS path, SUM(_sample_interval) AS views FROM ${DATASET} ${where} AND blob1 = 'page_view' GROUP BY path ORDER BY views DESC LIMIT 10`),
    sql(env, top(`IF(blob7 != '', blob7, IF(blob8 != '', blob8, '(direct)'))`, 'source')),
    sql(env, top('blob5', 'country')),
    sql(env, top('blob6', 'device')),
    sql(env, top('blob3', 'category', "AND blob1 = 'select_category'")),
  ]);
  const ev = new Map(byEvent.map((r) => [String(r.event), r]));
  return {
    configured: true, days,
    totals: { visitors: num(totals[0]?.visitors), sessions: num(totals[0]?.sessions), pageViews: num(totals[0]?.pageViews) },
    funnel: UI_EVENTS.map((e) => ({ event: e, visitors: num(ev.get(e)?.visitors), count: num(ev.get(e)?.count) })), // UI_EVENTS is in funnel order
    daily: daily.map((r) => ({ day: String(r.day).slice(0, 10), visitors: num(r.visitors), reports: num(r.reports) })),
    pages: pages.map((r) => ({ path: String(r.path) || '(none)', views: num(r.views) })),
    sources: sources.map((r) => ({ source: String(r.source), visitors: num(r.visitors) })),
    countries: countries.map((r) => ({ country: String(r.country) || '??', visitors: num(r.visitors) })),
    devices: devices.map((r) => ({ device: String(r.device), visitors: num(r.visitors) })),
    categories: categories.map((r) => ({ category: String(r.category), visitors: num(r.visitors) })),
  };
}
