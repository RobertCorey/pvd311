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
 *   GET  /api/admin/reports?status&category&q&before&limit → all reports, newest first (admin projection); q = substring on address/description/email/id/caseId
 *   GET  /api/admin/users?before&limit     → accounts with report counts + trust
 *   GET  /api/admin/events?level&kind&reportId&before&limit → filtered event stream
 *   GET  /api/admin/categories             → registry (label, portal case type + GUID, fields, photo/seasonal) + per-category golden/controls status + counts
 *   GET  /api/admin/config                 → live settings with explanations (no secrets)
 *   GET  /api/admin/explain                → "how it works" sections with live numbers (Learn tabs)
 *   GET  /api/admin/reports/:id/proofs     → [{ name, createdAt, contentType }]  ·  GET …/proofs/:name → image bytes
 *   POST /api/admin/canary/golden/:category/rebaseline → JSON { controls? } replaces the live golden; no body clears it (next live dump re-mints)
 *   POST /api/admin/engine/resume          → clear circuit breaker
 *   POST /api/admin/engine/pause           → pause submissions
 */
import { CATEGORIES } from '../../shared/categories.js';
import type { Env, Store, ReportDoc } from './contracts.js';
import type { AuthUser } from './auth.js';
import { approve, reject } from './hitl.js';
import { createMailer } from './email.js';
import { logEvent, SUBSYSTEMS, deriveStatus, type HealthRec } from './health.js';
import { canaryGoldenStatus, rebaselineGolden } from './canary-golden.js';
import { explainSystem } from './adminexplain.js';
import type { ReportStatus } from '../../shared/types.js';

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
    caseIdPending: r.caseIdPending === true, portalEntityId: (r as unknown as { portalEntityId?: string | null }).portalEntityId ?? r.portalDraft?.entityId ?? null,
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
    const n = (v: unknown): number => Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0;
    const ids = (v: unknown): string[] => Array.isArray(v) ? v.map(String).slice(0, 50) : [];
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('events')) || 100));
    const statuses = ['pending', 'awaiting_review', 'processing', 'submitted', 'failed', 'rejected', 'auto-rejected'] as const;
    const day = new Date().toISOString().slice(0, 10);
    const [engine, recs, counts, cityFeed, intakeDay, users, events, unconfirmed, canary, reconcile] = await Promise.all([
      store.getMeta<Record<string, unknown>>('engine').catch(() => null),
      Promise.all(SUBSYSTEMS.map((d) => store.getMeta<HealthRec>(`health_${d.key}`).catch(() => null))),
      Promise.all(statuses.map((st) => store.countByStatus(st).catch(() => -1))),
      store.getMeta<{ fetchedAt?: string; items?: unknown[] }>('cityFeed').catch(() => null),
      store.getMeta<{ count?: number }>(`intake_day_${day}`).catch(() => null),
      store.countUsers().catch(() => -1),
      store.recentEvents(limit).catch(() => []),
      store.findSubmittedUnconfirmed(50).catch(() => []),
      canaryGoldenStatus(store).catch(() => ({ categories: [] })),
      store.getMeta<{ at?: string; scanned?: number; adopted?: string[] | number; stranded?: string[] | number; missing?: string[] | number; error?: string | null }>('reconcile').catch(() => null),
    ]);
    const subsystems = SUBSYSTEMS.map((d, i) => {
      const rec = recs[i];
      return {
        key: d.key, label: d.label, what: d.what, status: deriveStatus(d, rec, now),
        lastOkAt: rec?.lastOkAt ?? null, lastErrorAt: rec?.lastErrorAt ?? null, lastError: rec?.lastError ?? null, lastDetail: rec?.lastDetail ?? null,
        okToday: rec?.day === day ? rec?.okToday ?? 0 : 0, errToday: rec?.day === day ? rec?.errToday ?? 0 : 0,
        expectedEvery: d.expected,
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
      canary: { enabled: env.DRIFT_CANARY_ENABLED === '1' || env.DRIFT_CANARY_ENABLED === 'true', ...canary },
      sync: {
        // DB ↔ portal agreement. caseIdPending = portal accepted a submission but we have not confirmed its number yet.
        caseIdPending: unconfirmed.length,
        caseIdPendingOldestAt: unconfirmed.map((r) => toIso(r.statusUpdatedAt)).filter(Boolean).sort()[0] ?? null,
        reconcile: reconcile ? {
          at: reconcile.at ?? null, scanned: reconcile.scanned ?? 0,
          adopted: n(reconcile.adopted), stranded: n(reconcile.stranded), missing: n(reconcile.missing),
          ids: { adopted: ids(reconcile.adopted), stranded: ids(reconcile.stranded), missing: ids(reconcile.missing) },
          error: reconcile.error ?? null,
        } : null,
        status: n(reconcile?.missing) > 0 ? 'error' : unconfirmed.length === 0 ? 'ok' : 'warn',
      },
      events,
    });
  }

  if (m === 'GET' && path === '/api/admin/reports') {
    const status = (url.searchParams.get('status') || null) as ReportStatus | null;
    const category = url.searchParams.get('category') || null;
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const before = url.searchParams.get('before') || null;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    // With a search term, scan a wider window and filter in-memory (Firestore has no substring search).
    const rows = await store.listReports({ status, category, before, limit: q ? Math.min(1000, limit * 10) : limit });
    const hit = (r: ReportDoc) => !q || [r.id, r.address, r.description ?? '', r.reporterEmail ?? '', r.portalCaseId ?? '', r.statusDetail ?? ''].some((v) => String(v).toLowerCase().includes(q));
    const items = rows.filter(hit).slice(0, limit).map(adminProjection);
    const last = rows[rows.length - 1];
    return json({ items, next: rows.length >= limit && last ? toIso(last.timestamp) : null });
  }

  if (m === 'GET' && path === '/api/admin/users') {
    const before = url.searchParams.get('before') || null;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    const users = await store.listUsers({ before, limit });
    const items = await Promise.all(users.map(async (u) => {
      const [submitted, rejected, pending] = await Promise.all([
        store.countOwnerByStatus(u.uid, 'submitted').catch(() => 0), store.countOwnerByStatus(u.uid, 'rejected').catch(() => 0), store.countOwnerByStatus(u.uid, 'awaiting_review').catch(() => 0),
      ]);
      const n = Number(env.ACCOUNT_TRUST_N ?? '3') || 3;
      return { uid: u.uid, email: u.email, displayName: u.displayName ?? null, provider: u.provider, emailVerified: !!u.emailVerified, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt ?? null,
        trusted: !!u.trusted, emailUpdates: u.prefs?.emailUpdates !== false, following: (u.following ?? []).length, addresses: (u.addresses ?? []).length,
        submitted, rejected, awaitingReview: pending, autoFiles: !!u.trusted || (submitted >= n && rejected === 0) };
    }));
    return json({ items, next: users.length >= limit ? users[users.length - 1].createdAt : null });
  }

  if (m === 'GET' && path === '/api/admin/events') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const items = await store.listEvents({ level: url.searchParams.get('level') || null, kind: url.searchParams.get('kind') || null, reportId: url.searchParams.get('reportId') || null, before: url.searchParams.get('before') || null, limit });
    return json({ items, next: items.length >= limit ? items[items.length - 1].at : null });
  }

  if (m === 'GET' && path === '/api/admin/categories') {
    const canary = await canaryGoldenStatus(store).catch(() => ({ categories: [] as { category: string; goldenSource: string | null; goldenAt: string | null; lastLiveAt: string | null; drifted: boolean }[] }));
    const byCat = new Map(canary.categories.map((c) => [c.category, c]));
    const items = await Promise.all(Object.entries(CATEGORIES).map(async ([key, c]) => {
      const [submitted, rejected] = await Promise.all([
        store.listReports({ status: 'submitted', category: key, limit: 200 }).then((r) => r.length).catch(() => 0),
        store.listReports({ status: 'rejected', category: key, limit: 200 }).then((r) => r.length).catch(() => 0),
      ]);
      const g = byCat.get(key);
      return { key, label: c.label, portalCaseTypeName: c.portalCaseTypeName, portalCaseTypeGuid: c.portalCaseTypeGuid, portalSearchTerm: c.portalSearchTerm, requestType: c.requestType ?? '2',
        photoRequired: c.photoRequired !== false, seasonal: c.seasonal ?? null, fields: c.fields ?? {},
        golden: g ? { source: g.goldenSource, at: g.goldenAt, lastLiveAt: g.lastLiveAt, drifted: g.drifted } : null,
        counts: { submitted, rejected } };
    }));
    return json({ items });
  }

  if (m === 'GET' && path === '/api/admin/config') {
    const row = (key: string, value: unknown, what: string) => ({ key, value, what });
    return json({ items: [
      row('HITL_MODE', env.HITL_MODE, 'review = every report to you; ramp = first ACCOUNT_TRUST_N per account, then auto unless flagged; auto = nothing to you (flags still force review).'),
      row('ACCOUNT_TRUST_N', env.ACCOUNT_TRUST_N ?? '3', 'Reports an account must get filed (with 0 human/auto rejections) before it auto-files.'),
      row('REPORTER_EMAIL_ENABLED', env.REPORTER_EMAIL_ENABLED === 'true', 'Whether reporters/followers get email (filed, status changes, not-filed). Admin mail is always on.'),
      row('RECONCILE_ENABLED', env.RECONCILE_ENABLED ?? '0', 'Watcher compares the whole My Requests list to our DB every 30 min (adopt / stranded / missing).'),
      row('DRIFT_CANARY_ENABLED', env.DRIFT_CANARY_ENABLED ?? '0', 'Nightly Step-3 control diff on the designated canary draft; alerts when the city changes the form.'),
      row('ADMIN_EMAILS', env.ADMIN_EMAILS ?? '', 'Google accounts allowed into /admin.'),
      row('APP_BASE_URL', env.APP_BASE_URL ?? null, 'Public app origin used in emails and tracking links.'),
      row('PORTAL_BASE_URL', env.PORTAL_BASE_URL ?? null, 'The city portal the browser drives.'),
      row('NOTIFY_EMAIL', env.NOTIFY_EMAIL ?? null, 'Where admin mail goes.'),
      row('NOTIFY_FROM', env.NOTIFY_FROM ?? null, 'From address for all mail (Resend, domain verified).'),
      row('BLOCKED_ADDRESSES', (env as unknown as { BLOCKED_ADDRESSES?: string }).BLOCKED_ADDRESSES ?? '(default)', 'Addresses the engine auto-rejects (substring match).'),
      row('Pacing', '1 per 3 min, 5 per day, per mailbox and per IP', 'Enforced in POST /api/report via Firestore counters.'),
      row('Intake AI limits', '10/min per IP, 1,500/day global', 'Caps Anthropic spend; server-side moderation runs once per report regardless.'),
      row('Engine limits', 'lock 12 min · stuck reaper 20 min · retries 2 with backoff · breaker after repeated failures · hourly cap', 'See worker/src/engine.ts constants.'),
      row('Retention', 'photos 30 days after the city closes a case · events 14 days · HITL links 30 days', 'Daily job at 7 am ET.'),
    ] });
  }

  if (m === 'GET' && path === '/api/admin/explain') {
    const [users, submitted, rejected] = await Promise.all([store.countUsers().catch(() => -1), store.countByStatus('submitted').catch(() => -1), store.countByStatus('rejected').catch(() => -1)]);
    return json({ sections: explainSystem(env, { users, submitted, rejected, categories: Object.keys(CATEGORIES).length }) });
  }

  const proof = /^\/api\/admin\/reports\/([A-Za-z0-9_-]{10,64})\/proofs(?:\/([A-Za-z0-9_-]{1,120}))?$/.exec(path);
  if (proof && m === 'GET') {
    const [, id, name] = proof;
    if (!name) return json(await store.listProofs(id));
    const p = await store.getProof(id, name);
    if (!p) return json({ error: 'not_found' }, 404);
    return new Response(p.bytes, { headers: { 'content-type': p.contentType, 'cache-control': 'private, max-age=3600' } });
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

  const gold = /^\/api\/admin\/canary\/golden\/([a-z_]{2,40})\/rebaseline$/.exec(path);
  if (gold && m === 'POST') {
    const category = gold[1];
    const body = (await request.json().catch(() => null)) as { controls?: unknown } | null;
    const controls = Array.isArray(body?.controls) ? (body!.controls as Parameters<typeof rebaselineGolden>[2]) : undefined;
    await rebaselineGolden(store, category, controls);
    await logEvent(store, { level: 'warn', kind: 'admin.rebaseline', msg: `${controls ? 'Replaced' : 'Cleared'} live golden for ${category} (by ${auth.email})`, data: { category } });
    return json(await canaryGoldenStatus(store));
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
