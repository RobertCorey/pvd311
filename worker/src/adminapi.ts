/**
 * Admin API for the in-app /admin screen. Caller must present a Firebase ID token whose email is in
 * env.ADMIN_EMAILS (comma-separated, case-insensitive), verified, and from Google (not an email link):
 *   GET  /api/admin/overview               → engine state + queues (awaiting_review / failed / pending / submitted 7d)
 *   GET  /api/admin/reports/:id            → full report (admin projection incl. description, flags, reporter email, review)
 *   POST /api/admin/reports/:id/approve    → HITL approve
 *   POST /api/admin/reports/:id/reject     → HITL reject; JSON body { reason? } → emailed to the reporter
 *   GET  /api/admin/users/:uid             → { uid, email, trusted, submitted, rejected }
 *   POST /api/admin/users/:uid/trust       → JSON { trusted: boolean } (override the ramp)
 *   POST /api/admin/reports/:id/requeue    → failed → pending (retry now)
 *   GET  /api/admin/health                 → system visibility: subsystem traffic lights, counters, event stream
 *   POST /api/admin/engine/resume          → clear circuit breaker
 *   POST /api/admin/engine/pause           → pause submissions
 */
import { CATEGORIES } from '../../shared/categories.js';
import type { Env, Store, ReportDoc } from './contracts.js';
import type { AuthUser } from './auth.js';
import { approve, reject } from './hitl.js';
import { createMailer } from './email.js';
import { logEvent, SUBSYSTEMS, deriveStatus, type HealthRec } from './health.js';

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

  if (m === 'GET' && path === '/api/admin/health') {
    const now = Date.now();
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('events')) || 100));
    const statuses = ['pending', 'awaiting_review', 'processing', 'submitted', 'failed', 'rejected', 'auto-rejected'] as const;
    const day = new Date().toISOString().slice(0, 10);
    const [engine, recs, counts, cityFeed, intakeDay, users, events] = await Promise.all([
      store.getMeta<Record<string, unknown>>('engine').catch(() => null),
      Promise.all(SUBSYSTEMS.map((d) => store.getMeta<HealthRec>(`health_${d.key}`).catch(() => null))),
      Promise.all(statuses.map((st) => store.countByStatus(st).catch(() => -1))),
      store.getMeta<{ fetchedAt?: string; items?: unknown[] }>('cityFeed').catch(() => null),
      store.getMeta<{ count?: number }>(`intake_day_${day}`).catch(() => null),
      store.countUsers().catch(() => -1),
      store.recentEvents(limit).catch(() => []),
    ]);
    const subsystems = SUBSYSTEMS.map((d, i) => {
      const rec = recs[i];
      return {
        key: d.key, label: d.label, what: d.what, status: deriveStatus(d, rec, now),
        lastOkAt: rec?.lastOkAt ?? null, lastErrorAt: rec?.lastErrorAt ?? null, lastError: rec?.lastError ?? null, lastDetail: rec?.lastDetail ?? null,
        okToday: rec?.day === day ? rec?.okToday ?? 0 : 0, errToday: rec?.day === day ? rec?.errToday ?? 0 : 0,
        expectedEvery: d.freshMs ? `${Math.round(d.freshMs / 60_000)} min` : null,
      };
    });
    const paused = !!engine?.['paused'];
    const overall = paused ? 'warn' : subsystems.some((x) => x.status === 'error') ? 'error' : subsystems.some((x) => x.status === 'warn') ? 'warn' : 'ok';
    const oneHourAgo = now - 3_600_000;
    return json({
      generatedAt: new Date(now).toISOString(), overall,
      engine: {
        paused, consecutiveFailures: Number(engine?.['consecutiveFailures'] ?? 0),
        submissionsThisHour: ((engine?.['submissionTimestamps'] as number[] | undefined) ?? []).filter((t) => t > oneHourAgo).length,
        lastSubmissionTime: engine?.['lastSubmissionTime'] ? new Date(Number(engine['lastSubmissionTime'])).toISOString() : null,
        locked: !!(engine?.['lock'] && Number((engine['lock'] as { until?: number }).until ?? 0) > now),
        hitlMode: env.HITL_MODE, accountTrustN: env.ACCOUNT_TRUST_N ?? '3', reporterEmailEnabled: env.REPORTER_EMAIL_ENABLED === 'true',
      },
      subsystems,
      counts: Object.fromEntries(statuses.map((st, i) => [st, counts[i]])),
      users, ai: { intakeToday: intakeDay?.count ?? 0, dailyCap: 1500 },
      cityFeed: { fetchedAt: cityFeed?.fetchedAt ?? null, items: cityFeed?.items?.length ?? 0 },
      events,
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
      else if (action === 'reject') {
        if (!['awaiting_review', 'pending', 'failed'].includes(r.status)) return json({ error: 'not_rejectable', status: r.status }, 409);
        const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
        await reject(store, id, `admin:${auth.email}`, { reason: typeof body?.reason === 'string' ? body.reason : null, mailer: createMailer(env), env });
      }
      else if (action === 'requeue') { if (r.status !== 'failed') return json({ error: 'not_failed', status: r.status }, 409); await store.requeueReport(id, 0, `Requeued by ${auth.email}`, new Date().toISOString()); }
      const after = await store.fetchReport(id);
      return json(after ? adminProjection(after) : { ok: true });
    }
  }

  const usr = /^\/api\/admin\/users\/([A-Za-z0-9_-]{6,128})(?:\/(trust))?$/.exec(path);
  if (usr) {
    const [, uid, action] = usr;
    const u = await store.getUser(uid);
    if (!u) return json({ error: 'not_found' }, 404);
    if (m === 'POST' && action === 'trust') {
      const body = (await request.json().catch(() => null)) as { trusted?: unknown } | null;
      if (!body || typeof body.trusted !== 'boolean') return json({ error: 'invalid_body' }, 400);
      await store.patchUser(uid, { trusted: body.trusted, trustedBy: body.trusted ? auth.email : null, trustedAt: body.trusted ? new Date().toISOString() : null });
      await logEvent(store, { level: 'info', kind: 'admin.trust', msg: `${body.trusted ? 'Trusted' : 'Untrusted'} account ${u.email ?? uid} (by ${auth.email})` });
    }
    if (m === 'GET' || (m === 'POST' && action === 'trust')) {
      const fresh = (await store.getUser(uid)) ?? u;
      const [submitted, rejected] = await Promise.all([store.countOwnerByStatus(uid, 'submitted'), store.countOwnerByStatus(uid, 'rejected')]);
      return json({ uid, email: fresh.email ?? null, provider: fresh.provider ?? null, trusted: !!fresh.trusted, submitted, rejected, createdAt: fresh.createdAt ?? null });
    }
  }

  if (m === 'POST' && path === '/api/admin/engine/resume') {
    const engine = (await store.getMeta<Record<string, unknown>>('engine').catch(() => null)) ?? {};
    await store.setMeta('engine', { ...engine, paused: false, consecutiveFailures: 0 });
    await logEvent(store, { level: 'info', kind: 'admin.resume', msg: `Engine resumed by ${auth.email}` });
    return json({ ok: true, paused: false });
  }
  if (m === 'POST' && path === '/api/admin/engine/pause') {
    const engine = (await store.getMeta<Record<string, unknown>>('engine').catch(() => null)) ?? {};
    await store.setMeta('engine', { ...engine, paused: true });
    await logEvent(store, { level: 'warn', kind: 'admin.pause', msg: `Engine paused by ${auth.email}` });
    return json({ ok: true, paused: true });
  }
  return json({ error: 'not_found' }, 404);
}
