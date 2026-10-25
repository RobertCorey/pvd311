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
