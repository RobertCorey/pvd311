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

describe('PATCH /api/me prefs.streetWatch (streetwatch.ts)', () => {
  const patch = (s: ReturnType<typeof memStore>, token: string, body: unknown) =>
    handleApi(new Request('https://api.test/api/me', { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { store: s.store }) as Promise<Response>;

  /** memStore merges shallowly; the route writes Firestore dotted paths ('prefs.streetWatch'), so nest them here as the Store would. */
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

  it('is off by default, turns on and off as a boolean, and leaves the other prefs alone', async () => {
    const s = withDottedPatch(memStore());
    expect(((await (await call(s, 'alice', '/api/me')).json()) as any).prefs).toEqual({ emailUpdates: true, streetDigest: false, weekDigest: false, streetWatch: false, watchGroups: [] });
    let me = (await (await patch(s, 'alice', { prefs: { streetWatch: true } })).json()) as any;
    expect(me.prefs).toEqual({ emailUpdates: true, streetDigest: false, weekDigest: false, streetWatch: true, watchGroups: [] });
    expect(s.users.get('uid_alice')!.prefs).toEqual({ emailUpdates: true, streetWatch: true }); // written as the dotted path 'prefs.streetWatch'
    me = (await (await patch(s, 'alice', { prefs: { streetDigest: true } })).json()) as any;
    expect(me.prefs).toMatchObject({ streetDigest: true, streetWatch: true });
    me = (await (await patch(s, 'alice', { prefs: { streetWatch: 'yes' } })).json()) as any; // anything but true is off
    expect(me.prefs.streetWatch).toBe(false);
  });

  describe('prefs.watchGroups — "Only tell me about…" (watchgroups.ts)', () => {
    const ALL = ['trash', 'streets', 'traffic', 'trees', 'property', 'lights', 'nuisance', 'water', 'animals', 'other'];

    it('defaults to [] (everything), stores the known groups deduped in GROUP_ORDER as the dotted path prefs.watchGroups, and leaves the other prefs alone', async () => {
      const s = withDottedPatch(memStore());
      expect(((await (await call(s, 'alice', '/api/me')).json()) as any).prefs.watchGroups).toEqual([]);
      await patch(s, 'alice', { prefs: { streetWatch: true } });
      let me = (await (await patch(s, 'alice', { prefs: { watchGroups: ['streets', 'trash', 'streets', 'bogus', 7, null] } })).json()) as any;
      expect(me.prefs).toEqual({ emailUpdates: true, streetDigest: false, weekDigest: false, streetWatch: true, watchGroups: ['trash', 'streets'] }); // deduped, unknowns dropped, GROUP_ORDER
      expect(s.users.get('uid_alice')!.prefs).toEqual({ emailUpdates: true, streetWatch: true, watchGroups: ['trash', 'streets'] });
      me = (await (await patch(s, 'alice', { prefs: { streetDigest: true } })).json()) as any; // another pref: the selection stays
      expect(me.prefs).toMatchObject({ streetDigest: true, watchGroups: ['trash', 'streets'] });
      expect(((await (await call(s, 'alice', '/api/me')).json()) as any).prefs.watchGroups).toEqual(['trash', 'streets']);
    });

    it('[] and null clear it back to everything; all ten (with repeats) store exactly the ten, never more', async () => {
      const s = withDottedPatch(memStore());
      await patch(s, 'alice', { prefs: { watchGroups: ['lights'] } });
      expect(((await (await patch(s, 'alice', { prefs: { watchGroups: [] } })).json()) as any).prefs.watchGroups).toEqual([]);
      await patch(s, 'alice', { prefs: { watchGroups: ['lights'] } });
      expect(((await (await patch(s, 'alice', { prefs: { watchGroups: null } })).json()) as any).prefs.watchGroups).toEqual([]);
      expect(s.users.get('uid_alice')!.prefs.watchGroups).toEqual([]);
      const me = (await (await patch(s, 'alice', { prefs: { watchGroups: [...ALL, ...ALL, 'nope'].reverse() } })).json()) as any;
      expect(me.prefs.watchGroups).toEqual(ALL);
      expect(me.prefs.watchGroups).toHaveLength(10);
    });

    it('anything that is not an array is 400 invalid_groups and writes nothing — not even the other prefs in the same body', async () => {
      const s = withDottedPatch(memStore());
      await patch(s, 'alice', { prefs: { watchGroups: ['water'] } });
      for (const bad of ['streets', 1, { streets: true }, true]) {
        const r = await patch(s, 'alice', { prefs: { watchGroups: bad, streetWatch: true } });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'invalid_groups', field: 'watchGroups' });
      }
      expect(s.users.get('uid_alice')!.prefs).toEqual({ emailUpdates: true, watchGroups: ['water'] }); // streetWatch never landed
    });

    it('a corrupt stored value reads as everything', async () => {
      const s = withDottedPatch(memStore());
      await call(s, 'alice', '/api/me');
      const u = s.users.get('uid_alice')!;
      s.users.set('uid_alice', { ...u, prefs: { ...u.prefs, watchGroups: 'streets' as unknown as never } });
      expect(((await (await call(s, 'alice', '/api/me')).json()) as any).prefs.watchGroups).toEqual([]);
    });
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
