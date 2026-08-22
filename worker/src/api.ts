/**
 * Public app API — the ONLY thing the client talks to. No Firebase SDK in the client.
 *   POST /api/report      multipart → creates the report (Turnstile-verified, paced per device/IP)
 *   POST /api/intake      JSON → moderation flags + optional wording cleanup (AI; never blocks submit)
 *   GET  /api/reports/:id → tracking projection (no PII)
 *   GET  /api/public-feed → recent reports for the map (no PII)
 *   /api/me/*, PATCH /api/reports/:id, POST /api/reports/:id/cancel → me.ts (Firebase ID token required; see auth.ts)
 */
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORIES } from '../../shared/categories.js';
import type { Env, Store, ReportDoc } from './contracts.js';
import { cityItemId, parseCityDate, type CityFeed } from './cityfeed.js';
import { userFromRequest, type AuthUser } from './auth.js';
import { handleMe, editReport, cancelReport, ensureUser, type Viewer } from './me.js';

const DEFAULT_ORIGINS = ['https://fixmypvd.org', 'https://www.fixmypvd.org', 'https://fixmypvd.com', 'https://fixmypvd.org', 'https://www.fixmypvd.org', 'https://pvdsnow.org', 'https://www.pvdsnow.org', 'https://pvd-snow-report.web.app', 'https://pvd-snow-report.firebaseapp.com'];
const PVD_BBOX = { minLat: 41.70, maxLat: 41.92, minLng: -71.52, maxLng: -71.33 };
const PACE_MS = 3 * 60_000;       // one report per device per 3 min
const DAILY_CAP = 5;              // per device per day
const INTAKE_PER_MIN = 10;        // per IP, best-effort (isolate memory)

export interface ApiDeps { store: Store }

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = [...DEFAULT_ORIGINS, ...(env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  const ok = !!origin && (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return {
    'access-control-allow-origin': ok ? origin! : allowed[0],
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-turnstile-token,authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

export async function handleApi(request: Request, env: Env, deps: ApiDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  const cors = corsHeaders(env, request.headers.get('origin'));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    let resp: Response;
    const reportId = /^\/api\/reports\/([A-Za-z0-9_-]{10,64})(\/cancel)?$/.exec(url.pathname);
    const needsAuth = url.pathname.startsWith('/api/me') || !!(reportId && (request.method === 'PATCH' || (request.method === 'POST' && reportId[2])));
    const auth = needsAuth || request.headers.has('authorization') ? await userFromRequest(env, request) : null;
    if (needsAuth && !auth) resp = json({ error: 'unauthenticated' }, 401);
    else if (url.pathname.startsWith('/api/me')) resp = await handleMe(request, url, env, { store: deps.store, project: projectReport }, auth!);
    else if (request.method === 'PATCH' && reportId && !reportId[2]) resp = await editReport(reportId[1], request, deps.store, auth!);
    else if (request.method === 'POST' && reportId?.[2]) resp = await cancelReport(reportId[1], deps.store, auth!);
    else if (request.method === 'POST' && url.pathname === '/api/report') resp = await createReport(request, env, deps, auth);
    else if (request.method === 'POST' && url.pathname === '/api/intake') resp = await intake(request, env);
    else if (request.method === 'GET' && /^\/api\/reports\/[A-Za-z0-9_-]{10,64}$/.test(url.pathname)) resp = await getReport(url.pathname.split('/').pop()!, deps, auth);
    else if (request.method === 'POST' && /^\/api\/reports\/[A-Za-z0-9_-]{10,64}\/email$/.test(url.pathname)) resp = await attachEmail(url.pathname.split('/')[3], request, deps);
    else if (request.method === 'POST' && /^\/api\/reports\/[A-Za-z0-9_-]{10,64}\/follow$/.test(url.pathname)) resp = await followReport(url.pathname.split('/')[3], request, deps);
    else if (request.method === 'GET' && url.pathname === '/api/public-feed') resp = await publicFeed(url, deps);
    else if (request.method === 'GET' && url.pathname === '/api/nearby') resp = await nearby(url, deps);
    else if (request.method === 'GET' && /^\/api\/photos\/[A-Za-z0-9_-]{10,64}$/.test(url.pathname)) resp = await getPhoto(url.pathname.split('/').pop()!, deps);
    else resp = json({ error: 'not_found' }, 404);
    for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v);
    return resp;
  } catch (e) {
    console.error('[api]', e);
    const resp = json({ error: 'internal' }, 500);
    for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v);
    return resp;
  }
}

// ── helpers ─────────────────────────────────────────────────

function newId(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // 22 chars, url-safe
}
const clientIp = (r: Request) => r.headers.get('cf-connecting-ip') ?? '0.0.0.0';

async function verifyTurnstile(env: Env, token: string | null, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // not configured → open (dev)
  if (!token) return false;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const d = (await r.json().catch(() => ({}))) as { success?: boolean };
  return !!d.success;
}

/** Pacing per device and per IP, persisted in Firestore meta (low volume → fine).
 *  Two phases so a rejection by one key never consumes the other's budget: peek all, then commit all. */
type PaceRec = { last: number; day: string; count: number };
const paceId = (key: string) => `pace_${key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}`;
async function checkPace(store: Store, keys: string[]): Promise<{ ok: boolean; retryAfterSec: number }> {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const recs: { id: string; rec: PaceRec; count: number }[] = [];
  for (const key of keys) {
    const id = paceId(key);
    const rec = (await store.getMeta<PaceRec>(id)) ?? { last: 0, day: '', count: 0 };
    const count = rec.day === today ? rec.count : 0;
    if (now - rec.last < PACE_MS) return { ok: false, retryAfterSec: Math.ceil((PACE_MS - (now - rec.last)) / 1000) };
    if (count >= DAILY_CAP) return { ok: false, retryAfterSec: 3600 };
    recs.push({ id, rec, count });
  }
  for (const { id, count } of recs) await store.setMeta(id, { last: now, day: today, count: count + 1 });
  return { ok: true, retryAfterSec: 0 };
}

const intakeHits = new Map<string, number[]>();
function intakeAllowed(ip: string): boolean {
  const now = Date.now();
  const arr = (intakeHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= INTAKE_PER_MIN) return false;
  arr.push(now); intakeHits.set(ip, arr); return true;
}

// ── POST /api/report ────────────────────────────────────────

async function createReport(request: Request, env: Env, { store }: ApiDeps, auth: AuthUser | null): Promise<Response> {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.includes('multipart/form-data')) return json({ error: 'multipart_required' }, 400);
  const form = await request.formData();
  const f = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v.trim() : ''; };
  const ip = clientIp(request);

  if (!(await verifyTurnstile(env, f('turnstileToken') || null, ip))) return json({ error: 'turnstile_failed' }, 403);

  // Idempotency: the client's outbox reuses the same clientId on retry — never create a second report for it.
  const clientId = f('clientId').slice(0, 64) || null;
  if (clientId) {
    const existing = await store.findByClientId(clientId);
    if (existing) return json({ id: existing.id, trackingUrl: `/r/${existing.id}`, category: existing.category, createdAt: toIso(existing.timestamp), idempotent: true }, 200);
  }

  const category = f('category');
  const cat = CATEGORIES[category];
  if (!cat) return json({ error: 'invalid_category', field: 'category' }, 400);
  const address = f('address');
  if (address.length < 3 || address.length > 500) return json({ error: 'invalid_address', field: 'address' }, 400);
  const description = f('description');
  if (description.length > 2000) return json({ error: 'too_long', field: 'description' }, 400);
  let lat: number | null = f('lat') ? Number(f('lat')) : null;
  let lng: number | null = f('lng') ? Number(f('lng')) : null;
  if ((lat == null) !== (lng == null)) return json({ error: 'lat_lng_pair', field: 'lat' }, 400);
  if (lat != null && lng != null) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'invalid_coords', field: 'lat' }, 400);
    if (lat < PVD_BBOX.minLat || lat > PVD_BBOX.maxLat || lng < PVD_BBOX.minLng || lng > PVD_BBOX.maxLng) return json({ error: 'outside_providence', field: 'lat' }, 400);
  }
  let extra: Record<string, string> | null = null;
  if (f('extra')) {
    try { const o = JSON.parse(f('extra')); if (o && typeof o === 'object' && Object.keys(o).length <= 8) extra = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v).slice(0, 200)])); } catch { return json({ error: 'invalid_extra', field: 'extra' }, 400); }
  }
  let intakeFlags: string[] | null = null;
  if (f('intakeFlags')) { try { const a = JSON.parse(f('intakeFlags')); if (Array.isArray(a)) intakeFlags = a.map(String).slice(0, 5); } catch { /* ignore */ } }
  let email = f('email') || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_email', field: 'email' }, 400);
  // Signed in (Worker-verified token): own the report; fall back to the account email for status mail when opted in.
  const account = auth ? await ensureUser(store, auth) : null;
  if (account && !email && account.email && account.emailVerified && account.prefs?.emailUpdates !== false) email = account.email;
  const deviceId = f('deviceId').slice(0, 64) || ip;

  const photo = form.get('photo');
  const hasPhoto = photo instanceof File && photo.size > 0;
  if (!hasPhoto && cat.photoRequired !== false) return json({ error: 'photo_required', field: 'photo' }, 400);
  if (hasPhoto && (photo.size > 5 * 1024 * 1024 || !/^image\//.test(photo.type))) return json({ error: 'invalid_photo', field: 'photo' }, 400);

  // Pace per device and per IP
  {
    const p = await checkPace(store, [`d_${deviceId}`, `ip_${ip}`]);
    if (!p.ok) return json({ error: 'rate_limited', retryAfterSec: p.retryAfterSec }, 429, { 'retry-after': String(p.retryAfterSec) });
  }

  const id = newId();
  let photoUrl: string | null = null;
  if (hasPhoto) {
    // Spark plan: no server-side bucket writes. Photo bytes live in Firestore (photos/{id}) and are served by /api/photos/:id.
    await store.putPhoto(id, new Uint8Array(await photo.arrayBuffer()), photo.type);
    photoUrl = `${new URL(request.url).origin}/api/photos/${id}`;
  }
  const now = new Date();
  await store.patchReport(id, {
    timestamp: now, category, address, lat, lng, description: description || null, descriptionOriginal: f('descriptionOriginal') || null,
    extra, intakeFlags, photo: photoUrl, reporterName: f('name').slice(0, 120) || null, reporterEmail: email,
    status: 'pending', statusDetail: null, portalCaseId: null, statusUpdatedAt: now,
    deviceId, ip, clientId, appVersion: f('appVersion').slice(0, 40) || null, source: 'app',
    ownerUid: account?.uid ?? null,
  });
  return json({ id, trackingUrl: `/r/${id}`, category, createdAt: now.toISOString() }, 201);
}

// ── POST /api/intake (moderation + optional polish; never blocks submit) ──

const INTAKE_TOOL: Anthropic.Tool = {
  name: 'review_report', description: 'Moderate and optionally tidy a resident 311 report.', strict: true,
  input_schema: {
    type: 'object', additionalProperties: false, required: ['flags', 'polishedDescription', 'note'],
    properties: {
      flags: { type: 'array', items: { type: 'string', enum: ['spam', 'abuse', 'personal_info', 'not_311', 'emergency'] } },
      polishedDescription: { type: ['string', 'null'], description: 'Cleaner wording with the SAME facts (≤600 chars), or null if already fine' },
      note: { type: ['string', 'null'], description: 'One short reporter-facing sentence if a flag needs explaining, else null' },
    },
  },
};
const INTAKE_SYSTEM = `You review a resident's Providence, RI 311 service request before it is filed with the city.
Flag: spam (nonsense/ads), abuse (harassment, threats, slurs, targeting a person), personal_info (names, phone numbers, plates of private individuals — except a plate on an ABANDONED vehicle, which the city needs), not_311 (not a city service issue), emergency (fire, injury, crime in progress, gas smell — should call 911).
polishedDescription: only if the text is hard to read; keep every fact, add none, plain and brief. Otherwise null.
note: one short sentence for the reporter only when a flag needs explaining (e.g. "This sounds like an emergency — please call 911."). Otherwise null.`;

async function intake(request: Request, env: Env): Promise<Response> {
  const ip = clientIp(request);
  if (!intakeAllowed(ip)) return json({ error: 'rate_limited', retryAfterSec: 60 }, 429);
  const body = (await request.json().catch(() => null)) as { category?: string | null; description?: string; address?: string; extra?: Record<string, string>; hasPhoto?: boolean } | null;
  if (!body || typeof body.description !== 'string') return json({ error: 'invalid_body' }, 400);
  const description = body.description.slice(0, 2000);
  if (!env.ANTHROPIC_API_KEY || description.trim().length < 3) return json({ polishedDescription: null, flags: [], note: null, model: null });
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const r = await client.messages.create({
    model: 'claude-opus-5', max_tokens: 4096, output_config: { effort: 'low' }, system: INTAKE_SYSTEM, tools: [INTAKE_TOOL], tool_choice: { type: 'tool', name: 'review_report' },
    messages: [{ role: 'user', content: JSON.stringify({ category: body.category ?? null, categoryLabel: body.category ? CATEGORIES[body.category]?.label : null, description, address: (body.address ?? '').slice(0, 300), extra: body.extra ?? {}, hasPhoto: !!body.hasPhoto }) }],
  });
  const block = r.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const out = (block?.input ?? { flags: [], polishedDescription: null, note: null }) as { flags: string[]; polishedDescription: string | null; note: string | null };
  return json({ polishedDescription: out.polishedDescription ? out.polishedDescription.slice(0, 600) : null, flags: out.flags ?? [], note: out.note ?? null, model: r.model });
}

// ── GET /api/reports/:id ─────────────────────────────────────

const PUBLIC_STATUS: Record<string, string> = { pending: 'received', awaiting_review: 'received', processing: 'sending', submitted: 'sent', failed: 'needs_attention', rejected: 'rejected', 'auto-rejected': 'rejected' };

function toIso(t: unknown): string | null {
  if (!t) return null;
  if (typeof t === 'string') return t;
  const ts = t as { seconds?: number; toDate?: () => Date };
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000).toISOString();
  return null;
}

/** Tracking projection (no PII). With a viewer (signed-in caller) adds mine/following/editable + the description for owners. */
function projectReport(r: ReportDoc, viewer?: Viewer) {
  const cat = CATEGORIES[r.category];
  const status = PUBLIC_STATUS[r.status] ?? 'received';
  const mine = !!viewer && !!r.ownerUid && r.ownerUid === viewer.uid;
  const timeline: { at: string | null; label: string }[] = [{ at: toIso(r.timestamp), label: 'Received' }];
  if (r.portalCaseId) timeline.push({ at: toIso(r.statusUpdatedAt), label: `Filed with the city as ${r.portalCaseId}` });
  if (r.portalStatus) timeline.push({ at: toIso(r.portalStatusUpdatedAt), label: `City status: ${r.portalStatus}` });
  if (status === 'rejected') timeline.push({ at: toIso(r.statusUpdatedAt), label: 'Not filed' });
  if (status === 'needs_attention') timeline.push({ at: toIso(r.statusUpdatedAt), label: 'Needs attention — we are looking at it' });
  return {
    id: r.id, category: r.category, categoryLabel: cat?.label ?? r.category, address: r.address, lat: r.lat, lng: r.lng,
    photoUrl: r.photo && /^https?:/.test(r.photo) ? r.photo : null, createdAt: toIso(r.timestamp), status,
    portalCaseId: r.portalCaseId ?? null, portalStatus: r.portalStatus ?? null, timeline, hasEmail: !!r.reporterEmail,
    owned: !!r.ownerUid,
    ...(viewer ? { mine, following: viewer.following.has(r.id), editable: mine && (r.status === 'pending' || r.status === 'awaiting_review'), description: mine ? (r.description ?? null) : undefined } : {}),
    nextUpdateHint: status === 'sent' ? 'The city updates this case as crews work it; we check every 30 minutes.' : status === 'received' ? 'We file reports with the city within a few minutes.' : null,
  };
}

/** POST /api/reports/:id/email — attach an email after submit ("get the city's updates"). Knowing the id is the credential. */
async function attachEmail(id: string, request: Request, { store }: ApiDeps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = (body?.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json({ error: 'invalid_email', field: 'email' }, 400);
  const r = await store.fetchReport(id);
  if (!r) return json({ error: 'not_found' }, 404);
  await store.patchReport(id, { reporterEmail: email, emailAttachedAt: new Date().toISOString() });
  return new Response(null, { status: 204 });
}

/** POST /api/reports/:id/follow {email} — get updates on someone else's (FixMyPVD) report instead of filing a duplicate. */
async function followReport(id: string, request: Request, { store }: ApiDeps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = (body?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json({ error: 'invalid_email', field: 'email' }, 400);
  const r = await store.fetchReport(id);
  if (!r) return json({ error: 'not_found' }, 404);
  const followers = Array.from(new Set([...(((r as unknown as { followers?: string[] }).followers) ?? []), email])).slice(0, 50);
  await store.patchReport(id, { followers });
  return new Response(null, { status: 204 });
}

async function getReport(id: string, { store }: ApiDeps, auth: AuthUser | null): Promise<Response> {
  const r = await store.fetchReport(id);
  if (!r) return json({ error: 'not_found' }, 404);
  let viewer: Viewer | undefined;
  if (auth) { const u = await store.getUser(auth.uid); viewer = { uid: auth.uid, following: new Set(u?.following ?? []) }; }
  return json(projectReport(r, viewer), 200, { 'cache-control': 'no-store' });
}

// ── GET /api/photos/:id ─────────────────────────────────────

async function getPhoto(id: string, { store }: ApiDeps): Promise<Response> {
  const p = await store.getPhoto(id);
  if (!p) return json({ error: 'not_found' }, 404);
  return new Response(p.bytes, { headers: { 'content-type': p.contentType, 'cache-control': 'public, max-age=31536000, immutable' } });
}

// ── GET /api/public-feed (ours + city) ──────────────────────

interface FeedItem {
  id: string; source: 'snappvd' | 'city'; category: string; categoryLabel: string;
  lat: number | null; lng: number | null; address: string; createdAt: string | null;
  status: string; portalStatus: string | null;
}

function ourFeedItem(r: ReportDoc): FeedItem {
  return {
    id: r.id, source: 'snappvd', category: r.category, categoryLabel: CATEGORIES[r.category]?.label ?? r.category,
    lat: r.lat, lng: r.lng, address: r.address, createdAt: toIso(r.timestamp),
    status: PUBLIC_STATUS[r.status] ?? 'received', portalStatus: r.portalStatus ?? null,
  };
}

/** City items carry the city's Status Reason in `portalStatus`; `status` is the synthetic 'city'. */
function cityFeedItem(it: CityFeed['items'][number]): FeedItem {
  return {
    id: cityItemId(it), source: 'city', category: it.category, categoryLabel: CATEGORIES[it.category]?.label ?? it.category,
    lat: it.lat, lng: it.lng, address: it.street, createdAt: parseCityDate(it.createdOn),
    status: 'city', portalStatus: it.status || null,
  };
}

async function publicFeed(url: URL, { store }: ApiDeps): Promise<Response> {
  const limit = Math.min(200, Math.max(1, Number.isFinite(Number(url.searchParams.get('limit'))) && url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 100));
  const bbox = (url.searchParams.get('bbox') ?? '').split(',').map(Number);
  const inBbox = (lat: number, lng: number) =>
    bbox.length !== 4 || bbox.some(Number.isNaN) || (lng >= bbox[0] && lat >= bbox[1] && lng <= bbox[2] && lat <= bbox[3]);

  const ours = (await store.findReportsSince(24 * 30, limit))
    .filter((r) => r.lat != null && r.lng != null && inBbox(r.lat!, r.lng!))
    .map(ourFeedItem);

  const feed = await store.getMeta<CityFeed>('cityFeed');
  const city = (feed?.items ?? [])
    .filter((it) => it.lat != null && it.lng != null && inBbox(it.lat!, it.lng!))
    .filter((it) => !/^draft$/i.test(it.status || '')).map(cityFeedItem);

  // Interleave by recency so a busy week of ours never starves the city rows (and vice versa).
  const items = [...ours, ...city].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '')).slice(0, limit);
  return json({ items }, 200, { 'cache-control': 'public, max-age=60' });
}

// ── GET /api/nearby?lat=&lng=&category=&radiusM=75 (ours + city, last 14 days) ──

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function nearby(url: URL, { store }: ApiDeps): Promise<Response> {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'invalid_coords', field: 'lat' }, 400);
  const rawRadius = Number(url.searchParams.get('radiusM'));
  const radiusM = Math.min(2000, Math.max(1, Number.isFinite(rawRadius) && rawRadius > 0 ? rawRadius : 75));
  const category = url.searchParams.get('category') || null;
  const sinceMs = Date.now() - 14 * 24 * 3_600_000;

  const out: (FeedItem & { distanceM: number })[] = [];

  // Ours (query already windowed to 14 days).
  for (const r of await store.findReportsSince(24 * 14, 500)) {
    if (r.lat == null || r.lng == null) continue;
    if (category && r.category !== category) continue;
    const d = haversineMeters(lat, lng, r.lat, r.lng);
    if (d > radiusM) continue;
    out.push({ ...ourFeedItem(r), distanceM: Math.round(d) });
  }

  // City (filter to 14 days; unparseable dates are kept so a fresh dedupe signal isn't dropped).
  const feed = await store.getMeta<CityFeed>('cityFeed');
  for (const it of feed?.items ?? []) {
    if (it.lat == null || it.lng == null) continue;
    if (/^draft$/i.test(it.status || '')) continue; // abandoned wizards aren't reports
    if (category && it.category !== category) continue;
    const iso = parseCityDate(it.createdOn);
    if (iso != null && Date.parse(iso) < sinceMs) continue;
    const d = haversineMeters(lat, lng, it.lat, it.lng);
    if (d > radiusM) continue;
    out.push({ ...cityFeedItem(it), distanceM: Math.round(d) });
  }

  out.sort((a, b) => a.distanceM - b.distanceM);
  return json({ items: out }, 200, { 'cache-control': 'public, max-age=30' });
}
