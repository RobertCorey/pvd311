/**
 * Admin API for the in-app /admin screen. Caller must present a Firebase ID token whose email is in
 * env.ADMIN_EMAILS (comma-separated, case-insensitive), verified, and from Google (not an email link):
 *   GET  /api/admin/overview               → engine state + queues (awaiting_review / failed / pending / submitted 7d)
 *   GET  /api/admin/reports/:id            → full report (admin projection incl. description, flags, reporter email, review)
 *   POST /api/admin/reports/:id/approve    → HITL approve
 *   POST /api/admin/reports/:id/reject     → HITL reject
 *   POST /api/admin/reports/:id/requeue    → failed → pending (retry now)
 *   POST /api/admin/engine/resume          → clear circuit breaker
 *   POST /api/admin/engine/pause           → pause submissions
 */
import { CATEGORIES } from '../../shared/categories.js';
import type { Env, Store, ReportDoc } from './contracts.js';
import type { AuthUser } from './auth.js';
import { approve, reject } from './hitl.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Admin = allowlisted email, verified, signed in with Google (an email-link account for the same address is NOT enough). */
export function isAdmin(env: Env, auth: AuthUser | null): boolean {
  if (!auth?.email || !auth.emailVerified) return false;
  if (auth.provider !== 'google.com') return false;
  return adminEmails(env).includes(auth.email.toLowerCase());
}

function toIso(t: unknown): string | null {
  if (!t) return null;
  if (typeof t === 'string') return t;
  const ts = t as { seconds?: number; toDate?: () => Date };
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000).toISOString();
  return null;
}

function adminProjection(r: ReportDoc) {
  return {
    id: r.id, status: r.status, statusDetail: r.statusDetail ?? null, category: r.category, categoryLabel: CATEGORIES[r.category]?.label ?? r.category,
    address: r.address, lat: r.lat, lng: r.lng, description: r.description ?? null, descriptionOriginal: r.descriptionOriginal ?? null,
    extra: r.extra ?? null, intakeFlags: r.intakeFlags ?? [], moderatedAt: r.moderatedAt ?? null,
    photoUrl: r.photo && /^https?:/.test(r.photo) ? r.photo : null, createdAt: toIso(r.timestamp), statusUpdatedAt: toIso(r.statusUpdatedAt),
    reporterEmail: r.reporterEmail ?? null, ownerUid: r.ownerUid ?? null,
    portalCaseId: r.portalCaseId ?? null, portalStatus: r.portalStatus ?? null,
    retries: r.retries ?? 0, retryAfter: r.retryAfter ?? null, review: r.review ?? null, approvedAt: r.approvedAt ?? null,
  };
}

export async function handleAdmin(request: Request, url: URL, env: Env, store: Store, auth: AuthUser | null): Promise<Response> {
  if (!auth) return json({ error: 'unauthenticated' }, 401);
  if (!isAdmin(env, auth)) return json({ error: 'forbidden' }, 403);
  const path = url.pathname;
  const m = request.method;

  if (m === 'GET' && path === '/api/admin/overview') {
    const [engine, awaiting, failed, pending, recent] = await Promise.all([
      store.getMeta<Record<string, unknown>>('engine').catch(() => null),
      store.findByStatus('awaiting_review', 50), store.findByStatus('failed', 50), store.findByStatus('pending', 50), store.findRecentSubmissions(24 * 7),
    ]);
    const oneHourAgo = Date.now() - 3_600_000;
    return json({
      engine: {
        paused: !!engine?.['paused'], consecutiveFailures: Number(engine?.['consecutiveFailures'] ?? 0),
        submissionsThisHour: ((engine?.['submissionTimestamps'] as number[] | undefined) ?? []).filter((t) => t > oneHourAgo).length,
        lastSubmissionTime: engine?.['lastSubmissionTime'] ? new Date(Number(engine['lastSubmissionTime'])).toISOString() : null,
        hitlMode: env.HITL_MODE, accountTrustN: env.ACCOUNT_TRUST_N ?? '3',
      },
      awaitingReview: awaiting.map(adminProjection), failed: failed.map(adminProjection), pending: pending.map(adminProjection),
      submitted7d: recent.map(adminProjection),
    });
  }

  const one = /^\/api\/admin\/reports\/([A-Za-z0-9_-]{10,64})(?:\/(approve|reject|requeue))?$/.exec(path);
  if (one) {
    const [, id, action] = one;
    if (m === 'GET' && !action) {
      const r = await store.fetchReport(id);
      return r ? json(adminProjection(r)) : json({ error: 'not_found' }, 404);
    }
    if (m === 'POST' && action) {
      const r = await store.fetchReport(id);
      if (!r) return json({ error: 'not_found' }, 404);
      if (action === 'approve') { if (r.status !== 'awaiting_review' && r.status !== 'pending') return json({ error: 'not_reviewable', status: r.status }, 409); await approve(store, id, `admin:${auth.email}`); }
      else if (action === 'reject') { if (!['awaiting_review', 'pending', 'failed'].includes(r.status)) return json({ error: 'not_rejectable', status: r.status }, 409); await reject(store, id, `admin:${auth.email}`); }
      else if (action === 'requeue') { if (r.status !== 'failed') return json({ error: 'not_failed', status: r.status }, 409); await store.requeueReport(id, 0, `Requeued by ${auth.email}`, new Date().toISOString()); }
      const after = await store.fetchReport(id);
      return json(after ? adminProjection(after) : { ok: true });
    }
  }

  if (m === 'POST' && path === '/api/admin/engine/resume') {
    const engine = (await store.getMeta<Record<string, unknown>>('engine').catch(() => null)) ?? {};
    await store.setMeta('engine', { ...engine, paused: false, consecutiveFailures: 0 });
    return json({ ok: true, paused: false });
  }
  if (m === 'POST' && path === '/api/admin/engine/pause') {
    const engine = (await store.getMeta<Record<string, unknown>>('engine').catch(() => null)) ?? {};
    await store.setMeta('engine', { ...engine, paused: true });
    return json({ ok: true, paused: true });
  }
  return json({ error: 'not_found' }, 404);
}
