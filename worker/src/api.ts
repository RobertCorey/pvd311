/**
 * Public app API — the ONLY thing the client talks to. No Firebase SDK in the client.
 *   POST /api/report      multipart → creates the report (account REQUIRED: Firebase ID token; Turnstile-verified; reporter quota per mailbox + IP, quota.ts)
 *   POST /api/auth/link   JSON → Worker-minted sign-in link by email (authmail.ts)
 *   POST /api/intake      JSON → moderation flags + optional wording cleanup (AI; never blocks submit)
 *   GET  /api/reports/:id → tracking projection (no PII)
 *   GET  /api/nearby      → dedupe signal (ours + city, last 14 days)
 *   GET  /api/stats       → { filed } public counter
 *   GET  /api/photos/:id  → photo bytes
 *   /api/me/*, PATCH /api/reports/:id, POST /api/reports/:id/cancel → me.ts (Firebase ID token required; see auth.ts)
 *   POST /api/reports/:id/answer → the owner's answer to the city's request for more information (cityask.ts)
 *   /api/admin/*          → adminapi.ts (ID token + ADMIN_EMAILS allowlist, Google provider)
 *   POST /api/ui          → first-party usage event (ui.ts; no auth, always 204)
 */
import { CATEGORIES } from '../../shared/categories.js';
import type { Env, Store, ReportDoc } from './contracts.js';
import { cityItemId, parseCityDate, type CityFeed } from './cityfeed.js';
import { userFromRequest, type AuthUser } from './auth.js';
import { handleMe, editReport, cancelReport, ensureUser, type Viewer } from './me.js';
import { sendSignInLink } from './authmail.js';
import { moderate } from './moderation.js';
import { handleAdmin, isAdmin } from './adminapi.js';
import { logEvent, markOk } from './health.js';
import { recordUi } from './ui.js';
import { checkQuota, type QuotaSlot } from './quota.js';
import { cityResolutionMessage, workOrderOf } from './casedetail.js';
import { answerCityAsk, askState, asksOf, cityText, mailKind, sentAnswers } from './cityask.js';
import { createMailer } from './email.js';
import type { Mailer } from './contracts.js';

const DEFAULT_ORIGINS = ['https://fixmypvd.org', 'https://www.fixmypvd.org', 'https://fixmypvd.com', 'https://pvdsnow.org', 'https://www.pvdsnow.org', 'https://pvd-snow-report.web.app', 'https://pvd-snow-report.firebaseapp.com'];
const PVD_BBOX = { minLat: 41.70, maxLat: 41.92, minLng: -71.52, maxLng: -71.33 };
const INTAKE_PER_MIN = 10;        // per IP per minute (durable, Firestore meta)
const INTAKE_PER_DAY_GLOBAL = 1500; // hard cap on AI spend per UTC day, all callers

export interface ApiDeps { store: Store; mailer?: Mailer; moderate?: (env: Env, report: ReportDoc, text: string) => Promise<string[]> }

const allowedOrigins = (env: Env) => [...DEFAULT_ORIGINS, ...(env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
const originOk = (env: Env, origin: string | null) => !!origin && (allowedOrigins(env).includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = allowedOrigins(env);
  const ok = originOk(env, origin);
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
  if (url.pathname === '/api/status' || url.pathname === '/api/deploy-hold') return null; // ops endpoints, handled in index.ts (token-gated)
  const cors = corsHeaders(env, request.headers.get('origin'));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    let resp: Response;
    const reportId = /^\/api\/reports\/([A-Za-z0-9_-]{10,64})(\/cancel|\/answer)?$/.exec(url.pathname);
    const isCreate = request.method === 'POST' && url.pathname === '/api/report';
    const needsAuth = url.pathname.startsWith('/api/me') || url.pathname.startsWith('/api/admin') || !!(reportId && (request.method === 'PATCH' || (request.method === 'POST' && reportId[2])));
    const auth = needsAuth || isCreate || request.headers.has('authorization') ? await userFromRequest(env, request) : null;
    if (request.method === 'POST' && url.pathname === '/api/ui') resp = await recordUi(request, env, (o) => originOk(env, o));
    else if (isCreate && !auth) resp = json({ error: 'auth_required' }, 401);
    else if (needsAuth && !auth) resp = json({ error: 'unauthenticated' }, 401);
    else if (url.pathname.startsWith('/api/admin')) resp = await handleAdmin(request, url, env, deps.store, auth);
    else if (url.pathname.startsWith('/api/me')) resp = await handleMe(request, url, env, { store: deps.store, project: projectReport, admin: isAdmin(env, auth) }, auth!);
    else if (request.method === 'PATCH' && reportId && !reportId[2]) resp = await editReport(reportId[1], request, deps.store, auth!);
    else if (request.method === 'POST' && reportId?.[2] === '/cancel') resp = await cancelReport(reportId[1], deps.store, auth!);
    else if (request.method === 'POST' && reportId?.[2] === '/answer') resp = await answerCity(reportId[1], request, env, deps, auth!);
    else if (isCreate) resp = await createReport(request, env, deps, auth!);
    else if (request.method === 'POST' && url.pathname === '/api/auth/link') resp = await sendSignInLink(request, env, deps.store);
    else if (request.method === 'POST' && url.pathname === '/api/intake') resp = await intake(request, env, deps);
    else if (request.method === 'GET' && /^\/api\/reports\/[A-Za-z0-9_-]{10,64}$/.test(url.pathname)) resp = await getReport(url.pathname.split('/').pop()!, deps, auth);
    else if (request.method === 'GET' && url.pathname === '/api/nearby') resp = await nearby(url, deps);
    else if (request.method === 'GET' && url.pathname === '/api/stats') resp = await stats(deps);
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
  if (!env.TURNSTILE_SECRET) return env.ALLOW_NO_TURNSTILE === '1'; // fail CLOSED unless explicitly opened (tests/dev)
  if (!token) return false;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const d = (await r.json().catch(() => ({}))) as { success?: boolean };
  return !!d.success;
}

export { paceIdentity } from './quota.js'; // re-exported: tests + older imports

const intakeHits = new Map<string, number[]>();
/** Fast in-isolate check, then a durable per-IP-per-minute + global-per-day check in Firestore meta
 *  (isolate memory alone is per-PoP and resets, so it can't bound AI spend). */
async function intakeAllowed(store: Store, ip: string): Promise<boolean> {
  const now = Date.now();
  const arr = (intakeHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= INTAKE_PER_MIN) return false;
  arr.push(now); intakeHits.set(ip, arr);
  const minute = Math.floor(now / 60_000);
  const day = new Date(now).toISOString().slice(0, 10);
  const ipId = `intake_ip_${ip.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)}`;
  const dayId = `intake_day_${day}`;
  const [ipRec, dayRec] = await Promise.all([store.getMeta<{ minute: number; count: number }>(ipId), store.getMeta<{ count: number }>(dayId)]);
  const ipCount = ipRec?.minute === minute ? ipRec.count : 0;
  const dayCount = dayRec?.count ?? 0;
  if (ipCount >= INTAKE_PER_MIN || dayCount >= INTAKE_PER_DAY_GLOBAL) return false;
  await Promise.all([store.setMeta(ipId, { minute, count: ipCount + 1 }), store.setMeta(dayId, { count: dayCount + 1 })]);
  return true;
}

// ── POST /api/report ────────────────────────────────────────

async function createReport(request: Request, env: Env, { store }: ApiDeps, auth: AuthUser): Promise<Response> {
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
    if (existing && existing.ownerUid === auth.uid) return json({ id: existing.id, trackingUrl: `/r/${existing.id}`, category: existing.category, createdAt: toIso(existing.timestamp), idempotent: true }, 200);
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
  // Identity comes ONLY from the verified token: owner + the email the city's updates go to (unless opted out).
  const account = await ensureUser(store, auth);
  const email = account.email && account.prefs?.emailUpdates !== false ? account.email : null;

  const photo = form.get('photo');
  const hasPhoto = photo instanceof File && photo.size > 0;
  if (!hasPhoto && cat.photoRequired !== false) return json({ error: 'photo_required', field: 'photo' }, 400);
  if (hasPhoto && (photo.size > 5 * 1024 * 1024 || !/^image\//.test(photo.type))) return json({ error: 'invalid_photo', field: 'photo' }, 400);

  // Reporter quota (docs/quota.md): per mailbox, plus a loose per-IP backstop. Every accepted report counts.
  let quotaSlot: QuotaSlot;
  {
    const q = await checkQuota(store, { uid: account.uid, email: account.email, ip });
    if (!q.ok) return json({ error: 'rate_limited', reason: q.reason, retryAfterSec: q.retryAfterSec, quota: q.quota }, 429, { 'retry-after': String(q.retryAfterSec) });
    quotaSlot = q.slot;
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
    extra, intakeFlags, photo: photoUrl, reporterName: null, reporterEmail: email,
    status: 'pending', statusDetail: null, portalCaseId: null, statusUpdatedAt: now,
    ip, clientId, appVersion: f('appVersion').slice(0, 40) || null, source: 'app',
    ownerUid: account.uid, quotaSlot,
  });
  await logEvent(store, { level: 'info', kind: 'report.created', msg: `${cat.label} @ ${address}${intakeFlags?.length ? ` (client flags: ${intakeFlags.join(',')})` : ''}`, reportId: id, data: { category, hasPhoto, appVersion: f('appVersion').slice(0, 40) || null } });
  await markOk(store, 'api', `report ${category}`);
  return json({ id, trackingUrl: `/r/${id}`, category, createdAt: now.toISOString() }, 201);
}

// ── POST /api/intake (moderation + optional polish; never blocks submit) ──

async function intake(request: Request, env: Env, { store }: ApiDeps): Promise<Response> {
  const ip = clientIp(request);
  if (!(await intakeAllowed(store, ip))) return json({ error: 'rate_limited', retryAfterSec: 60 }, 429);
  const body = (await request.json().catch(() => null)) as { category?: string | null; description?: string; address?: string; extra?: Record<string, string>; hasPhoto?: boolean } | null;
  if (!body || typeof body.description !== 'string') return json({ error: 'invalid_body' }, 400);
  const extra = body.extra && typeof body.extra === 'object' ? Object.fromEntries(Object.entries(body.extra).slice(0, 8).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 200)])) : {};
  const out = await moderate(env, { category: body.category ?? null, description: body.description, address: body.address ?? '', extra, hasPhoto: !!body.hasPhoto }, store);
  if (out.flags.length) await logEvent(store, { level: out.flags.includes('emergency') ? 'warn' : 'info', kind: 'intake.flagged', msg: `Intake flagged ${out.flags.join(', ')} (${body.category ?? 'no category'})${out.note ? ` — ${out.note}` : ''}` });
  return json(out);
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

/** Reporter-safe explanation for a report that will not be filed. Never leaks internal ids or the reviewer. */
export function notFiledReason(r: ReportDoc): { code: string; text: string; duplicateOf: string | null } | null {
  if (r.cancelledByReporter) return { code: 'cancelled', text: 'You cancelled this report before it was sent.', duplicateOf: null };
  if (r.status === 'rejected') {
    const reason = r.review?.reason?.trim();
    return { code: 'reviewed', text: reason ? reason : 'A person reviewed this and decided not to send it to the city — usually because it was a duplicate, outside Providence, not something 311 handles, or missing the details the city needs.', duplicateOf: null };
  }
  if (r.status === 'auto-rejected') {
    const d = r.statusDetail ?? '';
    const dup = /Duplicate: within \d+m of submitted report ([A-Za-z0-9_-]+)/.exec(d);
    if (dup) return { code: 'duplicate', text: 'Someone already reported this problem at this spot recently, so we did not file it twice.', duplicateOf: dup[1] };
    if (/^Outside Providence/.test(d)) return { code: 'outside', text: 'The location is outside Providence city limits, which the city\'s 311 does not cover.', duplicateOf: null };
    if (/^No photo/.test(d)) return { code: 'no_photo', text: 'This category needs a photo and none was attached.', duplicateOf: null };
    if (/^No address/.test(d)) return { code: 'no_address', text: 'No address or intersection was given.', duplicateOf: null };
    if (/^Blocked address/.test(d)) return { code: 'blocked', text: 'We could not file a report for that address.', duplicateOf: null };
    return { code: 'other', text: 'We could not file this report with the city.', duplicateOf: null };
  }
  if (r.status === 'failed') return { code: 'failed', text: 'Filing hit a problem on the city\'s side. A person is looking at it; you do not need to do anything.', duplicateOf: null };
  return null;
}

/** A relayed city email's body for the report's owner: plain text as stored, minus lines that are only an inline-image
 *  placeholder ("[cid:image001.png@…]"), with runs of blank lines collapsed. Nothing else is touched. */
function cityMessageText(text: string): string {
  return text.split('\n').filter((l) => !/^\s*\[cid:[^\]]*\]\s*$/i.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** `kind` lets the app render a row in its own words; `label` is the English fallback. `text` = the city's (or the owner's)
 *  words — owner only, single-report read only. */
type TimelineKind = 'city_message' | 'city_receipt' | 'city_routed' | 'city_ask' | 'city_answer' | 'work_order';
type TimelineItem = { at: string | null; label: string; kind?: TimelineKind; text?: string; vars?: Record<string, string> };

/** Owner-only city mail body: the stored plain text, minus image placeholders; for an ask, the cleaned city words. */
const ownerMailText = (m: { text?: string }) => (typeof m.text === 'string' ? cityMessageText(cityText(m.text)) : '');

/** Where the city sent the case: the "Department Assigned:" of its routing email, else the portal timeline's last dispatch. */
function departmentOf(r: ReportDoc): string | null {
  for (const m of [...(r.cityMessages ?? [])].reverse()) if (m?.dept) return m.dept;
  const routing = r.portalRouting ?? [];
  return routing.length ? routing[routing.length - 1].dept : null;
}

/** The newest city ask as the tracking page shows it. Public: that the city asked, and whether it was answered. Owner: the words + answers. */
function projectAsk(r: ReportDoc, mine: boolean, ownerText: boolean, now = Date.now()) {
  const asks = asksOf(r);
  const ask = asks.length ? asks[asks.length - 1] : null;
  if (!ask) return null;
  const st = askState(ask, r, now);
  const sent = sentAnswers(ask);
  return {
    askedAt: ask.at, open: st.open, answered: sent.length > 0, answeredAt: sent.length ? sent[sent.length - 1].at : null,
    ...(mine ? { id: ask.id, canAnswer: st.answerable, expiresAt: st.expiresAt } : {}),
    ...(ownerText ? { text: ask.text, answers: (ask.answers ?? []).map((a) => ({ at: a.at, via: a.via, status: a.status, text: a.text })) } : {}),
  };
}

/**
 * Tracking projection (no PII). With a viewer (signed-in caller) adds mine/following/editable + the description for owners.
 * `resolutionMessage` is the city's own Resolution Message, verbatim and public (the tracking link is public).
 * City-email timeline rows carry only their subject publicly; the full `text` (which can quote the reporter's
 * description and address) goes to the owner, and only on the single-report read (`withMessageText`), not in lists.
 */
function projectReport(r: ReportDoc, viewer?: Viewer, opts: { withMessageText?: boolean } = {}) {
  const cat = CATEGORIES[r.category];
  const status = PUBLIC_STATUS[r.status] ?? 'received';
  const mine = !!viewer && !!r.ownerUid && r.ownerUid === viewer.uid;
  const timeline: TimelineItem[] = [{ at: toIso(r.timestamp), label: 'Received' }];
  if (r.portalCaseId) timeline.push({ at: toIso(r.statusUpdatedAt), label: `Filed with the city as ${r.portalCaseId}` });
  // One row per city status the watcher saw (oldest first); reports from before the history field carry only the latest.
  const history = (r.portalStatusHistory ?? []).filter((h) => h && h.status);
  if (history.length) for (const h of history) timeline.push({ at: h.at, label: `City status: ${h.status}` });
  else if (r.portalStatus) timeline.push({ at: toIso(r.portalStatusUpdatedAt), label: `City status: ${r.portalStatus}` });
  if (history.length && r.portalStatus && history[history.length - 1].status !== r.portalStatus) timeline.push({ at: toIso(r.portalStatusUpdatedAt), label: `City status: ${r.portalStatus}` });
  const ownerText = mine && opts.withMessageText === true;
  // City mail in the city's own categories: its receipt and routing templates read as steps, not as raw subjects.
  const asks = asksOf(r);
  const seen = new Set<string>();
  for (const m of (r.cityMessages ?? []).slice(-8)) {
    if (!m?.at) continue;
    const kind = mailKind(m);
    const text = ownerText ? ownerMailText(m) : '';
    const withText = text ? { text } : {};
    if (kind === 'receipt') {
      if (seen.has('receipt')) continue;
      seen.add('receipt');
      timeline.push({ at: m.at, label: 'The city confirmed it has your request', kind: 'city_receipt', ...withText });
    } else if (kind === 'routed') {
      const dept = m.dept ?? null;
      timeline.push({ at: m.at, label: dept ? `The city sent it to ${dept}` : 'The city routed your request', kind: 'city_routed', ...(dept ? { vars: { dept } } : {}), ...withText });
    } else if (kind === 'ask') {
      continue; // asks come from the ask list below (one row per ask, whichever channel it arrived on)
    } else {
      const label = `Message from the city${m.subject ? `: ${m.subject.replace(/\bPVD311:\d+\b/gi, '').replace(/\bPVD\d{4}-\d+\b/gi, '').replace(/\s+/g, ' ').trim()}` : ''}`.slice(0, 160);
      timeline.push({ at: m.at, label, kind: 'city_message', ...withText });
    }
  }
  for (const a of asks) {
    timeline.push({ at: a.at, label: 'The city asked for more information', kind: 'city_ask', ...(ownerText && a.text ? { text: a.text } : {}) });
    for (const ans of sentAnswers(a)) timeline.push({ at: ans.at, label: 'Answer sent to the city', kind: 'city_answer', ...(ownerText ? { text: ans.text } : {}) });
  }
  // The city's work order: each change the watcher saw, or the current one.
  const wo = r.portalDetail ? workOrderOf(r.portalDetail.fields) : null;
  const woRows = r.workOrderHistory?.length ? r.workOrderHistory : wo ? [{ ...wo, at: r.portalDetail!.capturedAt }] : [];
  for (const w of woRows) {
    const at = /complete/i.test(w.status) && w.completedAt ? w.completedAt : w.at;
    timeline.push({ at, label: `City work order${w.number ? ` ${w.number}` : ''}${w.status ? `: ${w.status}` : ''}`, kind: 'work_order', vars: { number: w.number ?? '', status: w.status } });
  }
  if (status === 'rejected') timeline.push({ at: toIso(r.statusUpdatedAt), label: 'Not filed' });
  if (status === 'needs_attention') timeline.push({ at: toIso(r.statusUpdatedAt), label: 'Needs attention — we are looking at it' });
  return {
    id: r.id, category: r.category, categoryLabel: cat?.label ?? r.category, address: r.address, lat: r.lat, lng: r.lng,
    photoUrl: r.photo && /^https?:/.test(r.photo) ? r.photo : null, createdAt: toIso(r.timestamp), status,
    portalCaseId: r.portalCaseId ?? null, portalStatus: r.portalStatus ?? null, resolutionMessage: cityResolutionMessage(r), timeline,
    workOrder: wo, department: departmentOf(r), cityAsk: projectAsk(r, mine, ownerText),
    cancelledByReporter: r.cancelledByReporter === true,
    notFiled: notFiledReason(r),
    ...(viewer ? { mine, following: viewer.following.has(r.id), editable: mine && (r.status === 'pending' || r.status === 'awaiting_review'), description: mine ? (r.description ?? null) : undefined } : {}),
    nextUpdateHint: status === 'sent' ? 'The city updates this case on its own schedule; we check every 30 minutes.' : status === 'received' ? 'We file reports with the city within a few minutes.' : null,
  };
}

async function getReport(id: string, { store }: ApiDeps, auth: AuthUser | null): Promise<Response> {
  const r = await store.fetchReport(id);
  if (!r) return json({ error: 'not_found' }, 404);
  let viewer: Viewer | undefined;
  if (auth) { const u = await store.getUser(auth.uid); viewer = { uid: auth.uid, following: new Set(u?.following ?? []) }; }
  return json(projectReport(r, viewer, { withMessageText: true }), 200, { 'cache-control': 'no-store' });
}

// ── POST /api/reports/:id/answer ─────────────────────────────

const ANSWER_STATUS: Record<string, number> = { invalid_text: 400, no_ask: 409, case_closed: 409, expired: 409, too_many: 409, too_soon: 429, blocked: 422, send_failed: 502 };

/** The owner's answer to the city's request for more information → the city (cityask.answerCityAsk). */
async function answerCity(id: string, request: Request, env: Env, deps: ApiDeps, auth: AuthUser): Promise<Response> {
  const r = await deps.store.fetchReport(id);
  if (!r) return json({ error: 'not_found' }, 404);
  if (r.ownerUid !== auth.uid) return json({ error: 'not_owner' }, 403);
  const body = (await request.json().catch(() => null)) as { text?: unknown; askId?: unknown } | null;
  if (!body || typeof body.text !== 'string') return json({ error: 'invalid_text' }, 400);
  const report = { ...r, cityAsks: asksOf(r, env.APP_NAME) };
  const result = await answerCityAsk(env, { store: deps.store, mailer: deps.mailer ?? createMailer(env), moderate: deps.moderate }, report,
    { text: body.text, via: 'app', askId: typeof body.askId === 'string' ? body.askId : null });
  if (result.ok) return json({ ok: true, answer: { at: result.answer.at, via: result.answer.via, status: result.answer.status, text: result.answer.text } });
  const extra = result.retryAfterSec ? { 'retry-after': String(result.retryAfterSec) } : undefined;
  return json({ error: result.error, ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}), ...(result.flags ? { flags: result.flags } : {}) }, ANSWER_STATUS[result.error] ?? 400, extra);
}

// ── GET /api/photos/:id ─────────────────────────────────────

async function getPhoto(id: string, { store }: ApiDeps): Promise<Response> {
  const p = await store.getPhoto(id);
  if (!p) return json({ error: 'not_found' }, 404);
  return new Response(p.bytes, { headers: { 'content-type': p.contentType, 'cache-control': 'public, max-age=31536000, immutable' } });
}

// ── Feed items (nearby) ─────────────────────────────────────

interface FeedItem {
  id: string; source: 'ours' | 'city'; category: string; categoryLabel: string;
  lat: number | null; lng: number | null; address: string; createdAt: string | null;
  status: string; portalStatus: string | null;
}

function ourFeedItem(r: ReportDoc): FeedItem {
  return {
    id: r.id, source: 'ours', category: r.category, categoryLabel: CATEGORIES[r.category]?.label ?? r.category,
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

// ── GET /api/stats — public social proof: how many reports we've filed with the city ──
// No "resolved" count (Rob, 2026-10-16): the city's Resolved often means referred elsewhere, not fixed.

async function stats({ store }: ApiDeps): Promise<Response> {
  const filed = await store.countByStatus('submitted').catch(() => 0);
  return json({ filed }, 200, { 'cache-control': 'public, max-age=300' });
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
