/**
 * me.ts — account endpoints (/api/me/*) + owner-only report actions. Every handler here runs AFTER
 * auth.ts verified a Firebase ID token; the public tracking reads in api.ts need none.
 *
 *   GET    /api/me                      profile + prefs + saved addresses (each with its effective Monday-digest flag) + following + reporter quota (upserts users/{uid})
 *   PATCH  /api/me                      { displayName?, prefs? }   prefs: emailUpdates · weekDigest (the Monday "This week in Providence" mail, week.ts)
 *   GET    /api/me/reports              reports owned by this account (newest first)
 *   GET    /api/me/following            followed reports
 *   PUT    /api/me/following/:id        follow   (204)
 *   DELETE /api/me/following/:id        unfollow (204)
 *   GET    /api/me/city                 followed public city cases → { items: FollowedCase[] } (cityfollow.ts)
 *   PUT    /api/me/city/:guid           follow a city case   (204; 404 when cityCases/{guid} does not exist)
 *   DELETE /api/me/city/:guid           unfollow             (204)
 *   POST   /api/me/push                 { endpoint, keys: { p256dh, auth }, ua? } → 204: this phone hears pushes (push.ts; upsert by endpoint, ≤ 5 per account, oldest dropped)
 *   DELETE /api/me/push                 { endpoint } → 204 (idempotent)
 *   PUT    /api/me/addresses            { id?, label, address, lat?, lng?, digest? } → { addresses }   digest: this address in the Monday street digest (street.ts)
 *   DELETE /api/me/addresses/:id        → { addresses }
 *   PATCH  /api/reports/:id             { description } owner-only, while still pending
 *   POST   /api/reports/:id/cancel      owner-only, while still pending → status 'rejected' ("Cancelled by reporter"); refunds its quota slot
 */
import type { Env, ReportDoc, SavedAddress, Store, UserDoc } from './contracts.js';
import type { AuthUser } from './auth.js';
import { quotaFor, refundQuota, type QuotaView } from './quota.js';
import { CITY_GUID_RE, MAX_CASE_FOLLOWERS, MAX_CITY_FOLLOWING, followedCaseView } from './cityfollow.js';
import { claimPushEndpoint, parsePushSub, upsertPushSub } from './push.js';
import { addressDigest } from './street.js';

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
    return { ...existing, ...(patch as Partial<UserDoc>), prefs: existing.prefs ?? { emailUpdates: true }, addresses: existing.addresses ?? [], following: existing.following ?? [], cityFollowing: existing.cityFollowing ?? [] };
  }
  const doc: UserDoc = {
    uid: u.uid, email: u.email, emailVerified: u.emailVerified, displayName: u.name, provider: u.provider,
    createdAt: now, lastSeenAt: now, prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [],
  };
  await store.patchUser(u.uid, { ...doc });
  return doc;
}

function projectMe(u: UserDoc, admin: boolean, quota: QuotaView) {
  return {
    admin, uid: u.uid, email: u.email, emailVerified: !!u.emailVerified, displayName: u.displayName ?? null, provider: u.provider,
    prefs: { emailUpdates: u.prefs?.emailUpdates !== false, weekDigest: u.prefs?.weekDigest === true },
    addresses: (u.addresses ?? []).map((a) => ({ ...a, digest: addressDigest(a, u) })), following: u.following ?? [],
    cityFollowing: (u.cityFollowing ?? []).slice(0, MAX_CITY_FOLLOWING), createdAt: u.createdAt,
    push: { endpoints: (u.push ?? []).map((s) => s.endpoint) }, // the app matches its own PushSubscription.endpoint to show on/off
    quota,
  };
}
const meQuota = (store: Store, u: UserDoc) => quotaFor(store, u.uid, u.email);

export async function handleMe(request: Request, url: URL, env: Env, deps: MeDeps, auth: AuthUser): Promise<Response> {
  const { store } = deps;
  const path = url.pathname;
  const m = request.method;
  const user = await ensureUser(store, auth);
  const viewer: Viewer = { uid: user.uid, following: new Set(user.following ?? []) };

  if (path === '/api/me') {
    if (m === 'GET') return json(projectMe(user, !!deps.admin, await meQuota(store, user)));
    if (m === 'PATCH') {
      const body = (await request.json().catch(() => null)) as { displayName?: unknown; prefs?: { emailUpdates?: unknown; weekDigest?: unknown } } | null;
      if (!body) return json({ error: 'invalid_body' }, 400);
      const patch: Record<string, unknown> = {};
      if ('displayName' in body) {
        if (body.displayName !== null && typeof body.displayName !== 'string') return json({ error: 'invalid_name', field: 'displayName' }, 400);
        patch.displayName = body.displayName ? String(body.displayName).trim().slice(0, 80) || null : null;
      }
      // Any other key (streetDigest — now per address, PUT /api/me/addresses — or a stale client's streetWatch / watchGroups) is ignored.
      if (body.prefs && typeof body.prefs === 'object' && 'emailUpdates' in body.prefs) patch['prefs.emailUpdates'] = body.prefs.emailUpdates === true;
      if (body.prefs && typeof body.prefs === 'object' && 'weekDigest' in body.prefs) patch['prefs.weekDigest'] = body.prefs.weekDigest === true;
      if (Object.keys(patch).length) await store.patchUser(user.uid, patch);
      const fresh = (await store.getUser(user.uid)) ?? user;
      return json(projectMe(fresh, !!deps.admin, await meQuota(store, fresh)));
    }
    return json({ error: 'not_found' }, 404);
  }

  if (path === '/api/me/reports' && m === 'GET') {
    const items = (await store.findReportsByOwner(user.uid, 100)).map((r) => deps.project(r, viewer));
    return json({ items });
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

  // ── Public city cases (cityfollow.ts) — same shape as following our own reports, keyed by the city's GUID ──
  if (path === '/api/me/city' && m === 'GET') {
    const ids = (user.cityFollowing ?? []).slice(0, MAX_CITY_FOLLOWING);
    const docs = await store.fetchCityCases(ids); // a case whose doc vanished is simply not returned
    const order = new Map(ids.map((id, i) => [id, i]));
    docs.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
    const at = user.cityFollowedAt ?? {};
    return json({ items: docs.map((d) => followedCaseView(d, at[String(d.id)] ?? null)) });
  }

  const cm = /^\/api\/me\/city\/([0-9a-f-]{36})$/.exec(path);
  if (cm && CITY_GUID_RE.test(cm[1]) && (m === 'PUT' || m === 'DELETE')) {
    const id = cm[1];
    const c = await store.getCityCase(id);
    if (!c && m === 'PUT') return json({ error: 'not_found' }, 404); // DELETE of a vanished case still clears it from the list
    const cityFollowing = (user.cityFollowing ?? []).filter((x) => x !== id);
    const followedAt: Record<string, string> = { ...(user.cityFollowedAt ?? {}) };
    delete followedAt[id];
    if (m === 'PUT') { cityFollowing.unshift(id); followedAt[id] = new Date().toISOString(); }
    const kept = cityFollowing.slice(0, MAX_CITY_FOLLOWING);
    const dropped = cityFollowing.slice(MAX_CITY_FOLLOWING); // a full list lets the oldest follow go
    for (const d of dropped) delete followedAt[d];
    await store.patchUser(user.uid, { cityFollowing: kept, cityFollowedAt: followedAt });
    if (c) {
      const followerUids = (Array.isArray(c.followerUids) ? (c.followerUids as unknown[]).filter((x): x is string => typeof x === 'string') : []).filter((x) => x !== user.uid);
      if (m === 'PUT') followerUids.push(user.uid);
      await store.patchCityCase(id, { followerUids: followerUids.slice(0, MAX_CASE_FOLLOWERS) });
    }
    for (const d of dropped) await removeCityFollower(store, d, user.uid);
    return noContent();
  }

  // ── Web push (push.ts): a subscription on the list = "Notify me on this phone" is on; no separate pref ──
  if (path === '/api/me/push' && (m === 'POST' || m === 'DELETE')) {
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (m === 'POST') {
      const sub = parsePushSub(body);
      if (!sub) return json({ error: 'invalid_subscription' }, 400);
      await claimPushEndpoint(store, user.uid, sub.endpoint); // one owner per phone: a previous account on it loses the endpoint
      await store.patchUser(user.uid, { push: upsertPushSub(user.push, sub, new Date().toISOString()) });
      return noContent();
    }
    if (typeof body?.endpoint !== 'string' || !body.endpoint) return json({ error: 'invalid_body', field: 'endpoint' }, 400);
    const endpoint = body.endpoint;
    const kept = (user.push ?? []).filter((s) => s.endpoint !== endpoint);
    if (kept.length !== (user.push ?? []).length) await store.patchUser(user.uid, { push: kept });
    return noContent();
  }

  if (path === '/api/me/addresses' && m === 'PUT') {
    const body = (await request.json().catch(() => null)) as (Omit<Partial<SavedAddress>, 'digest'> & { digest?: unknown }) | null;
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    if (address.length < 3 || address.length > 300) return json({ error: 'invalid_address', field: 'address' }, 400);
    const label = (typeof body?.label === 'string' ? body.label.trim() : '').slice(0, 40) || address.split(',')[0].slice(0, 40);
    const lat = typeof body?.lat === 'number' && Number.isFinite(body.lat) ? body.lat : null;
    const lng = typeof body?.lng === 'number' && Number.isFinite(body.lng) ? body.lng : null;
    if ((lat == null) !== (lng == null)) return json({ error: 'lat_lng_pair', field: 'lat' }, 400);
    const id = typeof body?.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(body.id) ? body.id : crypto.randomUUID().slice(0, 8);
    const prev = user.addresses ?? [];
    const old = prev.find((a) => a.id === id);
    if (!old && prev.length >= MAX_ADDRESSES) return json({ error: 'too_many', field: 'addresses' }, 400);
    // A new place starts outside the Monday digest (saving a place to report from no longer subscribes it); an edit keeps
    // its flag unless the body sets one. An edit stays where it is in the list (a digest switch must not reorder it); a new one goes first.
    const digest = body && 'digest' in body ? body.digest === true : old ? addressDigest(old, user) : false;
    const entry: SavedAddress = { id, label, address, lat, lng, digest };
    return json({ addresses: await saveAddresses(store, user, old ? prev.map((a) => (a.id === id ? entry : a)) : [entry, ...prev]) });
  }

  const am = /^\/api\/me\/addresses\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (am && m === 'DELETE') {
    return json({ addresses: await saveAddresses(store, user, (user.addresses ?? []).filter((a) => a.id !== am[1])) });
  }

  return json({ error: 'not_found' }, 404);
}

/**
 * Write the saved addresses with every Monday-digest flag explicit — each address's addressDigest as it reads before
 * the write, which is the migration: an account from before per-address flags had one prefs.streetDigest covering every
 * address it had, and the first write pins that onto each of them — plus prefs.streetDigest = "some address is on". That
 * pref is no longer a setting (PATCH ignores it): it is the index runStreetDigest's equality query reads. Returns the list.
 */
async function saveAddresses(store: Store, user: UserDoc, list: SavedAddress[]): Promise<SavedAddress[]> {
  const addresses = list.map((a) => ({ ...a, digest: addressDigest(a, user) }));
  await store.patchUser(user.uid, { addresses, 'prefs.streetDigest': addresses.some((a) => a.digest) });
  return addresses;
}

/** Take this account off a case it no longer lists (trimmed past MAX_CITY_FOLLOWING), so it gets no mail for it. Best effort. */
async function removeCityFollower(store: Store, guid: string, uid: string): Promise<void> {
  try {
    const c = await store.getCityCase(guid);
    const uids = Array.isArray(c?.followerUids) ? (c.followerUids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (uids.includes(uid)) await store.patchCityCase(guid, { followerUids: uids.filter((x) => x !== uid) });
  } catch (e) { console.warn('[me] city unfollow (trim) failed:', e instanceof Error ? e.message : e); }
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
  const now = new Date().toISOString();
  // A cancel before filing gives the quota slot back (docs/quota.md) — once: the report is no longer cancellable after this.
  const slot = r.quotaSlot && !r.quotaSlot.refundedAt ? r.quotaSlot : null;
  await store.patchReport(id, { cancelledByReporter: true, review: { ...(r.review ?? {}), decision: 'rejected', by: 'reporter', decidedAt: now }, ...(slot ? { quotaSlot: { ...slot, refundedAt: now } } : {}) });
  if (slot) await refundQuota(store, slot);
  return json({ ok: true, status: 'rejected' });
}

/** Per-account standing for the HITL ramp (hitl.ts): 'trusted' = an admin `trusted` flag, or a clean history (≥ n filed,
 *  0 rejected by a human/auto gate); 'rejected' = any such rejection (the brake: every report reviewed); 'new' = clean but
 *  fewer than n filed (reviewed only when it looks off, since 2026-10-30). A report the reporter cancelled is NOT a rejection. */
export async function accountStanding(store: Store, uid: string, n: number): Promise<'trusted' | 'new' | 'rejected'> {
  const u = await store.getUser(uid);
  if (u?.trusted) return 'trusted';
  const mine = await store.findReportsByOwner(uid, 200);
  const sent = mine.filter((r) => r.status === 'submitted').length;
  const rejected = mine.filter((r) => (r.status === 'rejected' || r.status === 'auto-rejected') && !r.cancelledByReporter).length;
  if (rejected > 0) return 'rejected';
  return sent >= n ? 'trusted' : 'new';
}
