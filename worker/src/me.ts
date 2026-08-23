/**
 * me.ts — account endpoints (/api/me/*) + owner-only report actions. Every handler here runs AFTER
 * auth.ts verified a Firebase ID token; the anonymous flows in api.ts are untouched.
 *
 *   GET    /api/me                      profile + prefs + saved addresses + following (upserts users/{uid})
 *   PATCH  /api/me                      { displayName?, prefs? }
 *   GET    /api/me/reports              reports owned by this account (newest first)
 *   POST   /api/me/claim                { ids[] } → attach unowned reports (tracking ids from the device)
 *   POST   /api/me/recover              claim unowned reports whose reporterEmail == the verified account email
 *   GET    /api/me/following            followed reports
 *   PUT    /api/me/following/:id        follow   (204)
 *   DELETE /api/me/following/:id        unfollow (204)
 *   PUT    /api/me/addresses            { id?, label, address, lat?, lng? } → { addresses }
 *   DELETE /api/me/addresses/:id        → { addresses }
 *   PATCH  /api/reports/:id             { description } owner-only, while still pending
 *   POST   /api/reports/:id/cancel      owner-only, while still pending → status 'rejected' ("Cancelled by reporter")
 */
import type { Env, ReportDoc, SavedAddress, Store, UserDoc } from './contracts.js';
import type { AuthUser } from './auth.js';

export interface MeDeps { store: Store; project: (r: ReportDoc, viewer?: Viewer) => Record<string, unknown>; admin?: boolean }
export interface Viewer { uid: string; following: Set<string> }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const noContent = () => new Response(null, { status: 204 });
const ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const EDITABLE = new Set(['pending', 'awaiting_review']);
const MAX_ADDRESSES = 10;
const MAX_FOLLOWING = 200;

/** Load or lazily create users/{uid}; refreshes the identity fields from the verified token each call. */
export async function ensureUser(store: Store, u: AuthUser): Promise<UserDoc> {
  const now = new Date().toISOString();
  const existing = await store.getUser(u.uid);
  if (existing) {
    const patch: Record<string, unknown> = { lastSeenAt: now };
    if (u.email && u.email !== existing.email) patch.email = u.email;
    if (u.emailVerified !== !!existing.emailVerified) patch.emailVerified = u.emailVerified;
    if (u.provider !== existing.provider) patch.provider = u.provider;
    if (!existing.displayName && u.name) patch.displayName = u.name;
    await store.patchUser(u.uid, patch);
    return { ...existing, ...(patch as Partial<UserDoc>), prefs: existing.prefs ?? { emailUpdates: true }, addresses: existing.addresses ?? [], following: existing.following ?? [] };
  }
  const doc: UserDoc = {
    uid: u.uid, email: u.email, emailVerified: u.emailVerified, displayName: u.name, provider: u.provider,
    createdAt: now, lastSeenAt: now, prefs: { emailUpdates: true }, addresses: [], following: [],
  };
  await store.patchUser(u.uid, { ...doc });
  return doc;
}

function projectMe(u: UserDoc, admin = false) {
  return {
    admin, uid: u.uid, email: u.email, emailVerified: !!u.emailVerified, displayName: u.displayName ?? null, provider: u.provider,
    prefs: { emailUpdates: u.prefs?.emailUpdates !== false }, addresses: u.addresses ?? [], following: u.following ?? [], createdAt: u.createdAt,
  };
}

export async function handleMe(request: Request, url: URL, env: Env, deps: MeDeps, auth: AuthUser): Promise<Response> {
  const { store } = deps;
  const path = url.pathname;
  const m = request.method;
  const user = await ensureUser(store, auth);
  const viewer: Viewer = { uid: user.uid, following: new Set(user.following ?? []) };

  if (path === '/api/me') {
    if (m === 'GET') return json(projectMe(user, !!deps.admin));
    if (m === 'PATCH') {
      const body = (await request.json().catch(() => null)) as { displayName?: unknown; prefs?: { emailUpdates?: unknown } } | null;
      if (!body) return json({ error: 'invalid_body' }, 400);
      const patch: Record<string, unknown> = {};
      if ('displayName' in body) {
        if (body.displayName !== null && typeof body.displayName !== 'string') return json({ error: 'invalid_name', field: 'displayName' }, 400);
        patch.displayName = body.displayName ? String(body.displayName).trim().slice(0, 80) || null : null;
      }
      if (body.prefs && typeof body.prefs === 'object' && 'emailUpdates' in body.prefs) patch['prefs.emailUpdates'] = body.prefs.emailUpdates === true;
      if (Object.keys(patch).length) await store.patchUser(user.uid, patch);
      return json(projectMe((await store.getUser(user.uid)) ?? user, !!deps.admin));
    }
    return json({ error: 'not_found' }, 404);
  }

  if (path === '/api/me/reports' && m === 'GET') {
    const items = (await store.findReportsByOwner(user.uid, 100)).map((r) => deps.project(r, viewer));
    return json({ items });
  }

  if (path === '/api/me/claim' && m === 'POST') {
    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? Array.from(new Set(body!.ids.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))).slice(0, 50) : [];
    if (!ids.length) return json({ error: 'invalid_ids', field: 'ids' }, 400);
    const found = await store.fetchReports(ids);
    const claimed: string[] = []; const skipped: string[] = [];
    for (const r of found) {
      if (r.ownerUid && r.ownerUid !== user.uid) { skipped.push(r.id); continue; }
      if (!r.ownerUid) await store.patchReport(r.id, { ownerUid: user.uid, claimedAt: new Date().toISOString() });
      claimed.push(r.id);
    }
    for (const id of ids) if (!found.some((r) => r.id === id)) skipped.push(id);
    return json({ claimed, skipped });
  }

  if (path === '/api/me/recover' && m === 'POST') {
    if (!user.email || !user.emailVerified) return json({ error: 'email_unverified' }, 403);
    const claimed: string[] = [];
    for (const r of await store.findReportsByEmail(user.email, 100)) {
      if (r.ownerUid) continue;
      await store.patchReport(r.id, { ownerUid: user.uid, claimedAt: new Date().toISOString() });
      claimed.push(r.id);
    }
    return json({ claimed });
  }

  if (path === '/api/me/following' && m === 'GET') {
    const ids = (user.following ?? []).slice(0, MAX_FOLLOWING);
    const reports = await store.fetchReports(ids);
    const order = new Map(ids.map((id, i) => [id, i]));
    reports.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return json({ items: reports.map((r) => deps.project(r, viewer)) });
  }

  const fm = /^\/api\/me\/following\/([A-Za-z0-9_-]{10,64})$/.exec(path);
  if (fm && (m === 'PUT' || m === 'DELETE')) {
    const id = fm[1];
    const r = await store.fetchReport(id);
    if (!r) return json({ error: 'not_found' }, 404);
    const following = (user.following ?? []).filter((x) => x !== id);
    const followerUids = (r.followerUids ?? []).filter((x) => x !== user.uid);
    if (m === 'PUT') { following.unshift(id); followerUids.push(user.uid); }
    await store.patchUser(user.uid, { following: following.slice(0, MAX_FOLLOWING) });
    await store.patchReport(id, { followerUids: followerUids.slice(0, 200) });
    return noContent();
  }

  if (path === '/api/me/addresses' && m === 'PUT') {
    const body = (await request.json().catch(() => null)) as Partial<SavedAddress> | null;
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    if (address.length < 3 || address.length > 300) return json({ error: 'invalid_address', field: 'address' }, 400);
    const label = (typeof body?.label === 'string' ? body.label.trim() : '').slice(0, 40) || address.split(',')[0].slice(0, 40);
    const lat = typeof body?.lat === 'number' && Number.isFinite(body.lat) ? body.lat : null;
    const lng = typeof body?.lng === 'number' && Number.isFinite(body.lng) ? body.lng : null;
    if ((lat == null) !== (lng == null)) return json({ error: 'lat_lng_pair', field: 'lat' }, 400);
    const id = typeof body?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(body.id) ? body.id : crypto.randomUUID().slice(0, 8);
    const addresses = (user.addresses ?? []).filter((a) => a.id !== id);
    if (addresses.length >= MAX_ADDRESSES) return json({ error: 'too_many', field: 'addresses' }, 400);
    addresses.unshift({ id, label, address, lat, lng });
    await store.patchUser(user.uid, { addresses });
    return json({ addresses });
  }

  const am = /^\/api\/me\/addresses\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (am && m === 'DELETE') {
    const addresses = (user.addresses ?? []).filter((a) => a.id !== am[1]);
    await store.patchUser(user.uid, { addresses });
    return json({ addresses });
  }

  return json({ error: 'not_found' }, 404);
}

// ── Owner-only report actions (routed from api.ts after auth) ──

export async function editReport(id: string, request: Request, store: Store, auth: AuthUser): Promise<Response> {
  const r = await store.fetchReport(id);
  if (!r) return json({ error: 'not_found' }, 404);
  if (r.ownerUid !== auth.uid) return json({ error: 'not_owner' }, 403);
  if (!EDITABLE.has(r.status)) return json({ error: 'not_editable', status: r.status }, 409);
  const body = (await request.json().catch(() => null)) as { description?: unknown } | null;
  if (!body || typeof body.description !== 'string') return json({ error: 'invalid_body', field: 'description' }, 400);
  const description = body.description.trim().slice(0, 2000);
  await store.patchReport(id, { description: description || null, editedAt: new Date().toISOString() });
  return json({ ok: true, description: description || null });
}

export async function cancelReport(id: string, store: Store, auth: AuthUser): Promise<Response> {
  const r = await store.fetchReport(id);
  if (!r) return json({ error: 'not_found' }, 404);
  if (r.ownerUid !== auth.uid) return json({ error: 'not_owner' }, 403);
  // 'processing' = a browser is mid-wizard; never yank it. An earlier attempt's portalDraft is harmless (undeletable anyway).
  if (!EDITABLE.has(r.status)) return json({ error: 'not_cancellable', status: r.status }, 409);
  await store.updateReportStatus(id, 'rejected', 'Cancelled by reporter');
  await store.patchReport(id, { cancelledByReporter: true, review: { ...(r.review ?? {}), decision: 'rejected', by: 'reporter', decidedAt: new Date().toISOString() } });
  return json({ ok: true, status: 'rejected' });
}

/** Per-account trust: clean history (≥ n filed, 0 rejected) or an admin `trusted` flag. Used by hitl.ts. */
export async function accountTrusted(store: Store, uid: string, n: number): Promise<boolean> {
  const u = await store.getUser(uid);
  if (u?.trusted) return true;
  const [sent, rejected] = await Promise.all([store.countOwnerByStatus(uid, 'submitted'), store.countOwnerByStatus(uid, 'rejected')]);
  return sent >= n && rejected === 0;
}
