import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '../src/auth';

// /api/me/city — following public city cases (cityfollow.ts), through handleApi with the token check swapped for a table.
const TOKENS: Record<string, AuthUser> = {
  alice: { uid: 'uid_alice', email: 'alice@example.com', emailVerified: true, name: null, provider: 'google.com' },
  bob: { uid: 'uid_bob', email: 'bob@example.com', emailVerified: true, name: null, provider: 'password' },
};
vi.mock('../src/auth', async (orig) => ({
  ...(await orig<typeof import('../src/auth')>()),
  userFromRequest: async (_env: unknown, req: Request) => TOKENS[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')] ?? null,
}));

import { handleApi } from '../src/api';
import type { Store, UserDoc } from '../src/contracts';

const G = (n: number) => `${n.toString(16).padStart(8, '0')}-05c8-f111-a3d0-001dd804b975`;
const A = G(0xa); const B = G(0xb); const C = G(0xc);
const cityCase = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  caseType: 'Pothole', category: 'pothole', street: '12 Angell St', status: 'Assigned', createdAt: '2026-10-10T12:00:00.000Z', statusAt: '2026-10-11T12:00:00.000Z',
  firstSeenAt: '2026-10-10T12:30:00.000Z', statusSeen: { Assigned: '2026-10-11T12:00:00.000Z' }, lat: 41.8282, lng: -71.4005, detail: { resolution: null, resolutionDate: null }, ...o,
});

function memStore(cases: Record<string, Record<string, unknown>> = {}) {
  const meta = new Map<string, unknown>();
  const users = new Map<string, UserDoc>();
  const store = {
    getMeta: async (id: string) => (meta.has(id) ? structuredClone(meta.get(id)) : null),
    setMeta: async (id: string, v: unknown) => { meta.set(id, structuredClone(v)); },
    getUser: async (uid: string) => (users.has(uid) ? structuredClone(users.get(uid)!) : null),
    patchUser: async (uid: string, f: Record<string, unknown>) => { users.set(uid, { ...(users.get(uid) ?? {}), ...f } as UserDoc); },
    getCityCase: vi.fn(async (id: string) => (cases[id] ? structuredClone({ ...cases[id], id }) : null)),
    // Firestore's batchGet does not keep the request order — hand the docs back reversed so the route has to sort.
    fetchCityCases: vi.fn(async (ids: string[]) => ids.filter((id) => cases[id]).reverse().map((id) => structuredClone({ ...cases[id], id }))),
    patchCityCase: vi.fn(async (id: string, f: Record<string, unknown>) => { cases[id] = { ...(cases[id] ?? {}), ...f }; }),
    countOwnerByStatus: async () => 0,
  };
  return { store: store as unknown as Store, users, cases };
}
const env = {} as any;
const call = (s: ReturnType<typeof memStore>, token: string, path: string, method = 'GET') =>
  handleApi(new Request(`https://api.test${path}`, { method, headers: { authorization: `Bearer ${token}` } }), env, { store: s.store }) as Promise<Response>;

describe('PUT / DELETE /api/me/city/:guid', () => {
  it('follows and unfollows a public city case on both sides, idempotently', async () => {
    const s = memStore({ [A]: cityCase() });
    expect((await call(s, 'alice', `/api/me/city/${A}`, 'PUT')).status).toBe(204);
    expect(s.users.get('uid_alice')).toMatchObject({ cityFollowing: [A] });
    expect(s.users.get('uid_alice')!.cityFollowedAt![A]).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(s.cases[A].followerUids).toEqual(['uid_alice']);
    expect((await (await call(s, 'alice', '/api/me')).json() as any).cityFollowing).toEqual([A]);

    expect((await call(s, 'alice', `/api/me/city/${A}`, 'PUT')).status).toBe(204); // again: still once on each side
    expect(s.users.get('uid_alice')!.cityFollowing).toEqual([A]);
    expect(s.cases[A].followerUids).toEqual(['uid_alice']);

    expect((await call(s, 'bob', `/api/me/city/${A}`, 'PUT')).status).toBe(204);
    expect(s.cases[A].followerUids).toEqual(['uid_alice', 'uid_bob']);

    expect((await call(s, 'alice', `/api/me/city/${A}`, 'DELETE')).status).toBe(204);
    expect(s.users.get('uid_alice')).toMatchObject({ cityFollowing: [], cityFollowedAt: {} });
    expect(s.cases[A].followerUids).toEqual(['uid_bob']);
    expect((await call(s, 'alice', `/api/me/city/${A}`, 'DELETE')).status).toBe(204); // idempotent
    expect(s.cases[A].followerUids).toEqual(['uid_bob']);
  });

  it('404s a case the public list never had, and anything that is not a lowercase GUID', async () => {
    const s = memStore({ [A]: cityCase() });
    const r = await call(s, 'alice', `/api/me/city/${B}`, 'PUT');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
    expect((await call(s, 'alice', `/api/me/city/${A.toUpperCase()}`, 'PUT')).status).toBe(404);
    expect((await call(s, 'alice', '/api/me/city/m3hPCS9K2-UfxNBB6Fscbg', 'PUT')).status).toBe(404);
    expect(s.users.get('uid_alice')!.cityFollowing).toEqual([]);
    expect((await call(s, 'alice', `/api/me/city/${A}`, 'POST')).status).toBe(404);
  });

  it('DELETE still clears a case whose record has since vanished', async () => {
    const s = memStore({ [A]: cityCase() });
    await call(s, 'alice', `/api/me/city/${A}`, 'PUT');
    delete s.cases[A];
    expect((await call(s, 'alice', `/api/me/city/${A}`, 'DELETE')).status).toBe(204);
    expect(s.users.get('uid_alice')!.cityFollowing).toEqual([]);
    expect(s.cases[A]).toBeUndefined(); // nothing recreated
  });

  it('caps the list at 100, newest first; the follow that falls off also leaves that case', async () => {
    const cases: Record<string, Record<string, unknown>> = {};
    for (let i = 1; i <= 101; i++) cases[G(i)] = cityCase();
    const s = memStore(cases);
    for (let i = 1; i <= 101; i++) expect((await call(s, 'alice', `/api/me/city/${G(i)}`, 'PUT')).status).toBe(204);
    const u = s.users.get('uid_alice')!;
    expect(u.cityFollowing).toHaveLength(100);
    expect(u.cityFollowing![0]).toBe(G(101));
    expect(u.cityFollowing![99]).toBe(G(2));
    expect(u.cityFollowing).not.toContain(G(1));
    expect(Object.keys(u.cityFollowedAt!)).toHaveLength(100);
    expect(u.cityFollowedAt![G(1)]).toBeUndefined();
    expect(s.cases[G(1)].followerUids).toEqual([]);
    expect(s.cases[G(2)].followerUids).toEqual(['uid_alice']);
    expect((await (await call(s, 'alice', '/api/me')).json() as any).cityFollowing).toHaveLength(100);
  });
});

const send = (s: ReturnType<typeof memStore>, token: string, method: string, path: string, body?: unknown) =>
  handleApi(new Request(`https://api.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, { store: s.store }) as Promise<Response>;

/** memStore merges shallowly; the routes write Firestore dotted paths ('prefs.weekDigest'), so nest them here as the Store would. */
const withDottedPatch = (s: ReturnType<typeof memStore>) => {
  (s.store as unknown as { patchUser: Store['patchUser'] }).patchUser = async (uid, f) => {
    const u: Record<string, unknown> = { ...(s.users.get(uid) ?? {}) };
    for (const [k, v] of Object.entries(f)) {
      const dot = k.indexOf('.');
      if (dot < 0) { u[k] = v; continue; }
      const [head, tail] = [k.slice(0, dot), k.slice(dot + 1)];
      u[head] = { ...((u[head] ?? {}) as Record<string, unknown>), [tail]: v };
    }
    s.users.set(uid, u as unknown as UserDoc);
  };
  return s;
};

describe('PATCH /api/me prefs', () => {
  it('GET answers emailUpdates + weekDigest only; the cut street watch\'s keys and the old account-wide streetDigest are ignored, not stored', async () => {
    const s = withDottedPatch(memStore());
    expect(((await (await call(s, 'alice', '/api/me')).json()) as any).prefs).toEqual({ emailUpdates: true, weekDigest: false });
    const me = (await (await send(s, 'alice', 'PATCH', '/api/me', { prefs: { streetWatch: true, watchGroups: ['streets'], streetDigest: true, weekDigest: true } })).json()) as any;
    expect(me.prefs).toEqual({ emailUpdates: true, weekDigest: true });
    expect(s.users.get('uid_alice')!.prefs).toEqual({ emailUpdates: true, weekDigest: true });
  });

  it('a stored stale street-watch pref is never returned', async () => {
    const s = withDottedPatch(memStore());
    await call(s, 'alice', '/api/me');
    const u = s.users.get('uid_alice')!;
    s.users.set('uid_alice', { ...u, prefs: { ...u.prefs, streetWatch: true, watchGroups: ['streets'] } as UserDoc['prefs'] });
    expect(((await (await call(s, 'alice', '/api/me')).json()) as any).prefs).toEqual({ emailUpdates: true, weekDigest: false });
  });
});

describe('the Monday street digest, per saved address (PUT / DELETE /api/me/addresses)', () => {
  const HOME = { label: 'Home', address: '12 Angell St', lat: 41.8282, lng: -71.4005 };
  const WORK = { label: 'Work', address: '1 Dorrance St', lat: 41.821, lng: -71.412 };
  const put = async (s: ReturnType<typeof memStore>, body: unknown) => (await (await send(s, 'alice', 'PUT', '/api/me/addresses', body)).json()) as any;
  const flags = (list: { id: string; digest?: boolean }[]) => list.map((a) => `${a.id}:${a.digest}`);
  /** An account from before per-address flags: one prefs.streetDigest for all its places. */
  const legacy = (s: ReturnType<typeof memStore>, streetDigest: boolean) => {
    s.users.set('uid_alice', {
      uid: 'uid_alice', email: 'alice@example.com', emailVerified: true, displayName: null, provider: 'google.com', createdAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z',
      prefs: { emailUpdates: true, streetDigest }, addresses: [{ id: 'home', ...HOME }, { id: 'work', ...WORK }], following: [],
    });
    return s;
  };

  it('a new address starts off (saving a place does not subscribe it); digest:true turns one on, and prefs.streetDigest says "some address is on"', async () => {
    const s = withDottedPatch(memStore());
    let r = await put(s, { id: 'home', ...HOME });
    expect(r.addresses).toEqual([{ id: 'home', ...HOME, digest: false }]);
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(false);
    r = await put(s, { id: 'work', ...WORK, digest: true });
    expect(flags(r.addresses)).toEqual(['work:true', 'home:false']); // a new one goes first
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(true);
    const me = (await (await call(s, 'alice', '/api/me')).json()) as any;
    expect(me.addresses).toEqual([{ id: 'work', ...WORK, digest: true }, { id: 'home', ...HOME, digest: false }]);
    expect(me.prefs).not.toHaveProperty('streetDigest');
  });

  it('an edit stays in place and keeps its flag unless the body sets one; anything but true is off', async () => {
    const s = withDottedPatch(memStore());
    await put(s, { id: 'home', ...HOME, digest: true });
    await put(s, { id: 'work', ...WORK });
    let r = await put(s, { id: 'home', ...HOME, label: 'House' }); // no digest in the body: still on, still second
    expect(r.addresses.map((a: any) => `${a.id}:${a.label}:${a.digest}`)).toEqual(['work:Work:false', 'home:House:true']);
    r = await put(s, { id: 'home', ...HOME, digest: 'yes' });
    expect(flags(r.addresses)).toEqual(['work:false', 'home:false']);
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(false);
  });

  it('migration: an old account-wide "on" means every address it had; the first write pins that on each, and a new address still starts off', async () => {
    const s = withDottedPatch(legacy(memStore(), true));
    expect(flags(((await (await call(s, 'alice', '/api/me')).json()) as any).addresses)).toEqual(['home:true', 'work:true']);
    let r = await put(s, { id: 'park', label: 'Park', address: '1 Hope St' });
    expect(flags(r.addresses)).toEqual(['park:false', 'home:true', 'work:true']);
    expect(flags(s.users.get('uid_alice')!.addresses)).toEqual(['park:false', 'home:true', 'work:true']); // stored explicit, not just answered
    r = await put(s, { id: 'home', ...HOME, digest: false });
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(true); // work is still on
    r = await put(s, { id: 'work', ...WORK, digest: false });
    expect(flags(r.addresses)).toEqual(['park:false', 'home:false', 'work:false']);
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(false);
  });

  it('migration: an old "off" stays off for every address when another is turned on (the new flag does not leak through the account-wide value)', async () => {
    const s = withDottedPatch(legacy(memStore(), false));
    const r = await put(s, { id: 'park', label: 'Park', address: '1 Hope St', lat: 41.83, lng: -71.40, digest: true });
    expect(flags(r.addresses)).toEqual(['park:true', 'home:false', 'work:false']);
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(true);
    expect(flags(((await (await call(s, 'alice', '/api/me')).json()) as any).addresses)).toEqual(['park:true', 'home:false', 'work:false']);
  });

  it('DELETE of the last address that was on clears prefs.streetDigest; the rest keep explicit flags', async () => {
    const s = withDottedPatch(legacy(memStore(), true));
    let r = (await (await send(s, 'alice', 'DELETE', '/api/me/addresses/home')).json()) as any;
    expect(r.addresses).toEqual([{ id: 'work', ...WORK, digest: true }]);
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(true);
    r = (await (await send(s, 'alice', 'DELETE', '/api/me/addresses/work')).json()) as any;
    expect(r.addresses).toEqual([]);
    expect(s.users.get('uid_alice')!.prefs.streetDigest).toBe(false);
  });

  it('still caps the list at 10 — an edit of a saved one is not a new one', async () => {
    const s = withDottedPatch(memStore());
    for (let i = 0; i < 10; i++) await put(s, { id: `a${i}`, label: `A${i}`, address: `${i} Hope St` });
    expect((await send(s, 'alice', 'PUT', '/api/me/addresses', { id: 'a10', label: 'A10', address: '10 Hope St' })).status).toBe(400);
    expect(flags((await put(s, { id: 'a3', label: 'A3', address: '3 Hope St', digest: true })).addresses)[6]).toBe('a3:true');
  });
});

describe('GET /api/me/city', () => {
  it('returns the followed cases in cityFollowing order (newest follow first), skipping vanished records', async () => {
    const s = memStore({
      [A]: cityCase({ status: 'Resolved', statusAt: '2026-10-13T15:00:00.000Z', detail: { resolution: ' Pothole filled. ', resolutionDate: '2026-10-13T15:00:00Z' } }),
      [B]: cityCase(),
      [C]: cityCase({ caseType: 'Street Light Out', street: '', lat: null, lng: null }),
    });
    await call(s, 'alice', `/api/me/city/${C}`, 'PUT');
    await call(s, 'alice', `/api/me/city/${B}`, 'PUT');
    await call(s, 'alice', `/api/me/city/${A}`, 'PUT');
    delete s.cases[B];
    const r = await call(s, 'alice', '/api/me/city');
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as any;
    expect(s.store.fetchCityCases).toHaveBeenCalledWith([A, B, C]);
    expect(items.map((i: any) => i.id)).toEqual([A, C]);
    expect(items[0]).toEqual({
      id: A, caseType: 'Pothole', category: 'pothole', street: '12 Angell St', status: 'Resolved', open: false,
      createdAt: '2026-10-10T12:00:00.000Z', closedAt: '2026-10-13T15:00:00.000Z', resolution: 'Pothole filled.', lat: 41.8282, lng: -71.4005,
      followedAt: s.users.get('uid_alice')!.cityFollowedAt![A], updatedAt: '2026-10-13T15:00:00.000Z',
    });
    expect(items[1]).toMatchObject({ id: C, caseType: 'Street Light Out', street: '', open: true, closedAt: null, lat: null, lng: null, updatedAt: '2026-10-11T12:00:00.000Z' });
    expect(items[1].followedAt < items[0].followedAt || items[1].followedAt === items[0].followedAt).toBe(true);
  });

  it('is empty for an account that follows nothing, and only yours', async () => {
    const s = memStore({ [A]: cityCase() });
    await call(s, 'bob', `/api/me/city/${A}`, 'PUT');
    expect(await (await call(s, 'alice', '/api/me/city')).json()).toEqual({ items: [] });
    expect(((await (await call(s, 'bob', '/api/me/city')).json()) as any).items.map((i: any) => i.id)).toEqual([A]);
  });

  it('needs an account', async () => {
    const s = memStore();
    expect((await handleApi(new Request('https://api.test/api/me/city'), env, { store: s.store }) as Response).status).toBe(401);
  });
});
