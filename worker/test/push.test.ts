import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthUser } from '../src/auth';

// Routes go through handleApi with the token check swapped for a table (as in me.test.ts).
const TOKENS: Record<string, AuthUser> = {
  alice: { uid: 'uid_alice', email: 'alice@example.com', emailVerified: true, name: null, provider: 'google.com' },
};
vi.mock('../src/auth', async (orig) => ({
  ...(await orig<typeof import('../src/auth')>()),
  userFromRequest: async (_env: unknown, req: Request) => TOKENS[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')] ?? null,
}));

import { handleApi } from '../src/api';
import {
  b64url, fromB64url, encrypt, ecdhPairFromRaw, ensureVapid, vapidAuthHeader, sendPush, pushAll, parsePushSub, upsertPushSub, pushEndpointId, claimPushEndpoint,
  VAPID_SUBJECT, VAPID_META, MAX_PUSH_SUBS, HEADER_LEN, type VapidKeys, type PushPayload,
} from '../src/push.js';
import { notifyCityFollowers } from '../src/citycases.js';
import { cityFollowPush, pushFollowers } from '../src/cityfollow.js';
import { runWeekDigest, resetWeekCache, weekDigestPush, weekSummary } from '../src/week.js';
import { runStreetDigest, resetStreetCache, streetUrl, streetDigestPush, nearbyCases } from '../src/street.js';
import type { Env, Mailer, PushSub, Store, UserDoc } from '../src/contracts.js';

// ── RFC 8291 Appendix A, verbatim (whitespace removed) ────────────────────────────────────────────────────────
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  // intermediate values
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  // outputs
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // Section 5: the header and ciphertext concatenated
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** The browser's side of RFC 8291, written independently of src/push.ts: open a message with the receiver's private key. */
async function decryptAsBrowser(message: Uint8Array, ua: { publicRaw: string; privateScalar: string; auth: string }): Promise<string> {
  const salt = message.subarray(0, 16);
  const rs = new DataView(ab(message.subarray(16, 20))).getUint32(0);
  const idlen = message[20];
  expect(rs).toBe(4096); expect(idlen).toBe(65);
  const senderPub = message.subarray(21, 21 + idlen);
  const record = message.subarray(21 + idlen);
  const uaPub = fromB64url(ua.publicRaw);
  const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64url(uaPub.subarray(1, 33)), y: b64url(uaPub.subarray(33)), d: ua.privateScalar }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('raw', ab(senderPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = async (saltB: Uint8Array, ikmB: ArrayBuffer | Uint8Array, info: Uint8Array, len: number) => {
    const k = await crypto.subtle.importKey('raw', ikmB instanceof Uint8Array ? ab(ikmB) : ikmB, 'HKDF', false, ['deriveBits']);
    return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ab(saltB), info: ab(info) }, k, len * 8);
  };
  const keyInfo = new Uint8Array([...utf8('WebPush: info\0'), ...uaPub, ...senderPub]);
  const ikm = await hk(fromB64url(ua.auth), secret, keyInfo, 32);
  const cek = await hk(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, ab(record)));
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2); // last record delimiter
  return text(padded.subarray(0, end));
}
const UA = { publicRaw: RFC.uaPublic, privateScalar: RFC.uaPrivate, auth: RFC.authSecret };
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: RFC.uaPublic, auth: RFC.authSecret };

describe('RFC 8291 known-answer test (Appendix A)', () => {
  it('the plaintext is the watermelon line, 41 bytes', () => {
    expect(text(fromB64url(RFC.plaintext))).toBe('When I grow up, I want to be a watermelon');
    expect(fromB64url(RFC.plaintext)).toHaveLength(41);
    expect(b64url(fromB64url(RFC.plaintext))).toBe(RFC.plaintext); // base64url round trip, no padding
  });

  it('with the RFC receiver keys, sender key and salt, encrypt() produces the exact header + ciphertext of the RFC', async () => {
    const ephemeral = await ecdhPairFromRaw(RFC.asPublic, RFC.asPrivate);
    const out = await encrypt(fromB64url(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.authSecret }, { ephemeral, salt: fromB64url(RFC.salt) });
    expect(out).toHaveLength(HEADER_LEN + 41 + 1 + 16);
    expect(b64url(out.subarray(0, HEADER_LEN))).toBe(RFC.header);
    expect(b64url(out.subarray(HEADER_LEN))).toBe(RFC.ciphertext);
    expect(b64url(out)).toBe(RFC.message);
    expect(out.subarray(0, 16)).toEqual(fromB64url(RFC.salt));
    expect(Array.from(out.subarray(16, 21))).toEqual([0, 0, 0x10, 0, 65]); // rs 4096, idlen 65
    expect(b64url(out.subarray(21, 86))).toBe(RFC.asPublic);
  });

  it('the intermediate values match too (ECDH secret, IKM, CEK, NONCE), checked from the receiver side', async () => {
    const ephemeral = await ecdhPairFromRaw(RFC.asPublic, RFC.asPrivate);
    const uaPub = fromB64url(RFC.uaPublic);
    const receiver = await crypto.subtle.importKey('raw', ab(uaPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, ephemeral.privateKey, 256));
    expect(b64url(secret)).toBe(RFC.ecdhSecret);
    const hk = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) =>
      new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ab(salt), info: ab(info) }, await crypto.subtle.importKey('raw', ab(ikm), 'HKDF', false, ['deriveBits']), len * 8));
    const ikm = await hk(fromB64url(RFC.authSecret), secret, new Uint8Array([...utf8('WebPush: info\0'), ...uaPub, ...fromB64url(RFC.asPublic)]), 32);
    expect(b64url(ikm)).toBe(RFC.ikm);
    expect(b64url(await hk(fromB64url(RFC.salt), ikm, utf8('Content-Encoding: aes128gcm\0'), 16))).toBe(RFC.cek);
    expect(b64url(await hk(fromB64url(RFC.salt), ikm, utf8('Content-Encoding: nonce\0'), 12))).toBe(RFC.nonce);
  });

  it('production path: a fresh ephemeral key and salt every time, and the browser can open each one', async () => {
    const p = utf8(JSON.stringify({ title: 'City update: Pothole', body: '12 Angell St — Assigned → Resolved', url: 'https://fixmypvd.org/street?case=x', tag: 'case:x' }));
    const a = await encrypt(p, SUB);
    const b = await encrypt(p, SUB);
    expect(a).toHaveLength(HEADER_LEN + p.length + 17);
    expect(b64url(a.subarray(0, 16))).not.toBe(b64url(b.subarray(0, 16)));   // salt
    expect(b64url(a.subarray(21, 86))).not.toBe(b64url(b.subarray(21, 86))); // sender key
    expect(await decryptAsBrowser(a, UA)).toBe(text(p));
    expect(await decryptAsBrowser(b, UA)).toBe(text(p));
  });

  it('rejects a bad subscription or an oversize payload instead of sending garbage', async () => {
    await expect(encrypt(utf8('x'), { p256dh: RFC.uaPublic.slice(0, 40), auth: RFC.authSecret })).rejects.toThrow(/p256dh/);
    await expect(encrypt(utf8('x'), { p256dh: RFC.uaPublic, auth: 'AQID' })).rejects.toThrow(/auth/);
    await expect(encrypt(utf8('x'), { p256dh: RFC.uaPublic, auth: 'short' })).rejects.toThrow(/base64/);
    await expect(encrypt(new Uint8Array(4096), SUB)).rejects.toThrow(/too large/);
    expect(() => fromB64url('not base64!')).toThrow();
    expect(fromB64url('AQID')).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromB64url('AQID==')).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromB64url(RFC.uaPublic.replace(/-/g, '+').replace(/_/g, '/'))).toEqual(fromB64url(RFC.uaPublic)); // plain base64 too
  });
});

// ── stores ──────────────────────────────────────────────────────────────────────────────────────────────
function memStore(opts: { cases?: Record<string, Record<string, unknown>>; users?: Record<string, UserDoc>; rows?: Record<string, unknown>[] } = {}) {
  const meta = new Map<string, Record<string, unknown>>();
  const users = new Map<string, UserDoc>(Object.entries(opts.users ?? {}));
  const cases = opts.cases ?? {};
  const events: Record<string, unknown>[] = [];
  const owners = new Map<string, string>(); // pushEndpoints/{sha256(endpoint)} → uid
  const store = {
    getPushOwner: vi.fn(async (id: string) => (owners.has(id) ? { uid: owners.get(id)! } : null)),
    setPushOwner: vi.fn(async (id: string, uid: string) => { owners.set(id, uid); }),
    getMeta: vi.fn(async (id: string) => (meta.has(id) ? structuredClone(meta.get(id)) : null)),
    setMeta: vi.fn(async (id: string, v: Record<string, unknown>) => { meta.set(id, { ...(meta.get(id) ?? {}), ...structuredClone(v) }); }),
    getUser: vi.fn(async (uid: string) => (users.has(uid) ? structuredClone(users.get(uid)!) : null)),
    patchUser: vi.fn(async (uid: string, f: Record<string, unknown>) => { users.set(uid, { ...(users.get(uid) ?? {}), ...structuredClone(f) } as UserDoc); }),
    getCityCase: vi.fn(async (id: string) => (cases[id] ? structuredClone({ ...cases[id], id }) : null)),
    patchCityCase: vi.fn(async (id: string, f: Record<string, unknown>) => { cases[id] = { ...(cases[id] ?? {}), ...f }; }),
    addEvent: vi.fn(async (ev: Record<string, unknown>) => { events.push(ev); }),
    countOwnerByStatus: async () => 0,
    listCityCasesSince: vi.fn(async () => opts.rows ?? []),
    listWeekDigestUsers: vi.fn(async () => [...users.values()]),
    listStreetDigestUsers: vi.fn(async () => [...users.values()]),
  };
  return { store: store as unknown as Store, meta, users, cases, events, owners };
}
const env = { APP_BASE_URL: 'https://fixmypvd.org' } as Env;
const sub = (n: number, o: Partial<PushSub> = {}): PushSub => ({ endpoint: `https://push.test/${n}`, p256dh: RFC.uaPublic, auth: RFC.authSecret, ua: 'test', createdAt: `2026-10-0${n}T00:00:00.000Z`, ...o });
const user = (uid: string, o: Partial<UserDoc> = {}): UserDoc => ({
  uid, email: `${uid}@example.com`, emailVerified: true, displayName: null, provider: 'google', createdAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z',
  prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [], ...o,
});

/** fetch → the push service: records every POST (decrypting it as the RFC browser) and answers per endpoint. */
function stubPushService(answer: (endpoint: string) => number | Error = () => 201) {
  const posts: { endpoint: string; headers: Record<string, string>; bodyLen: number; payload: PushPayload }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = new Uint8Array(init.body as ArrayBuffer);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    posts.push({ endpoint: url, headers, bodyLen: body.length, payload: JSON.parse(await decryptAsBrowser(body, UA)) });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return new Response(null, { status: a });
  }));
  return posts;
}
afterEach(() => vi.unstubAllGlobals());

describe('VAPID (RFC 8292)', () => {
  it('ensureVapid mints a P-256 pair into meta/vapid once and reuses it', async () => {
    const s = memStore();
    const k1 = await ensureVapid(s.store);
    expect(fromB64url(k1.publicKey)).toHaveLength(65);
    expect(fromB64url(k1.publicKey)[0]).toBe(4);
    expect(k1.privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256', d: expect.any(String), x: expect.any(String), y: expect.any(String) });
    expect((s.store.setMeta as any).mock.calls).toHaveLength(1);
    expect((s.store.setMeta as any).mock.calls[0][0]).toBe(VAPID_META);
    const k2 = await ensureVapid(s.store);
    expect(k2).toEqual(k1);
    expect((s.store.setMeta as any).mock.calls).toHaveLength(1);
    // a record from before publicKey was stored still works: the point is rebuilt from the JWK
    s.meta.set(VAPID_META, { privateJwk: k1.privateJwk });
    expect((await ensureVapid(s.store)).publicKey).toBe(k1.publicKey);
    // a damaged record (there, but no private key) is never silently re-minted over — that would orphan every subscription
    s.meta.set(VAPID_META, { publicKey: k1.publicKey, createdAt: '2026-10-26T00:00:00Z' });
    await expect(ensureVapid(s.store)).rejects.toThrow(/malformed/);
    expect((s.store.setMeta as any).mock.calls).toHaveLength(1);
    s.meta.set(VAPID_META, {});
    expect(fromB64url((await ensureVapid(s.store)).publicKey)).toHaveLength(65); // an empty doc counts as missing
    expect((s.store.setMeta as any).mock.calls).toHaveLength(2);
  });

  it('the Authorization header is `vapid t=<ES256 JWT>, k=<public key>` with aud = the push service origin and exp 12 h out, verifiable with the public key', async () => {
    const s = memStore();
    const keys = await ensureVapid(s.store);
    const now = Date.parse('2026-10-26T12:00:00Z');
    const h = await vapidAuthHeader('https://fcm.googleapis.com', VAPID_SUBJECT, keys, now);
    const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(h)!;
    expect(m).toBeTruthy();
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(text(fromB64url(m[1])))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(text(fromB64url(m[2])));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:rob@fixmypvd.org' });
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(12 * 3600);
    expect(fromB64url(m[3])).toHaveLength(64); // raw r||s
    const pub = await crypto.subtle.importKey('raw', ab(fromB64url(m[4])), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, ab(fromB64url(m[3])), utf8(`${m[1]}.${m[2]}`))).toBe(true);
    const forged = b64url(utf8(JSON.stringify({ ...claims, aud: 'https://evil.test' })));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, ab(fromB64url(m[3])), utf8(`${m[1]}.${forged}`))).toBe(false);
  });
});

describe('sendPush', () => {
  const payload: PushPayload = { title: 'This week in Providence', body: '12 requests · 5 closed', url: 'https://fixmypvd.org/week?until=2026-10-25', tag: 'week' };
  let keys: VapidKeys;
  beforeEach(async () => { keys = await ensureVapid(memStore().store); });

  it('POSTs the aes128gcm message with the VAPID, TTL and Urgency headers; body = plaintext + 1 + 16 + 86', async () => {
    const posts = stubPushService(() => 201);
    const r = await sendPush(SUB, payload, keys);
    expect(r).toEqual({ ok: true, status: 201, gone: false });
    expect(posts).toHaveLength(1);
    expect(posts[0].endpoint).toBe(SUB.endpoint);
    expect((fetch as any).mock.calls[0][1].method).toBe('POST');
    expect(posts[0].headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' });
    expect(posts[0].headers.authorization).toMatch(new RegExp(`^vapid t=[A-Za-z0-9_.-]+, k=${keys.publicKey}$`));
    const claims = JSON.parse(text(fromB64url(posts[0].headers.authorization.split(' ')[1].split('.')[1])));
    expect(claims.aud).toBe('https://fcm.googleapis.com'); // the push service's origin, not ours
    expect(posts[0].bodyLen).toBe(utf8(JSON.stringify(payload)).length + 1 + 16 + 86);
    expect(posts[0].payload).toEqual(payload);
    expect((fetch as any).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal); // bounded: a hung push service cannot stall a sync
  });

  it('201 is ok; 404 and 410 are gone; other errors are neither; a network failure is status 0', async () => {
    stubPushService((u) => (u.endsWith('/410') ? 410 : u.endsWith('/404') ? 404 : u.endsWith('/500') ? 500 : u.endsWith('/boom') ? new Error('ECONNRESET') : 201));
    expect(await sendPush({ ...SUB, endpoint: 'https://push.test/410' }, payload, keys)).toEqual({ ok: false, status: 410, gone: true });
    expect(await sendPush({ ...SUB, endpoint: 'https://push.test/404' }, payload, keys)).toEqual({ ok: false, status: 404, gone: true });
    expect(await sendPush({ ...SUB, endpoint: 'https://push.test/500' }, payload, keys)).toEqual({ ok: false, status: 500, gone: false });
    expect(await sendPush({ ...SUB, endpoint: 'https://push.test/boom' }, payload, keys)).toEqual({ ok: false, status: 0, gone: false });
  });
});

describe('pushAll', () => {
  const payload: PushPayload = { title: 't', body: 'b', url: 'https://fixmypvd.org/', tag: 'x' };

  it('sends to every subscription, removes the gone ones from the account and keeps the rest (stamped lastUsedAt)', async () => {
    const s = memStore({ users: { u: user('u', { push: [sub(1), sub(2), sub(3)] }) } });
    const posts = stubPushService((u) => (u.endsWith('/2') ? 410 : 201));
    expect(await pushAll(s.store, s.users.get('u')!, payload)).toBe(2);
    expect(posts.map((p) => p.endpoint).sort()).toEqual(['https://push.test/1', 'https://push.test/2', 'https://push.test/3']);
    const kept = s.users.get('u')!.push!;
    expect(kept.map((x) => x.endpoint)).toEqual(['https://push.test/1', 'https://push.test/3']);
    expect(kept[0].lastUsedAt).toMatch(/^\d{4}-/);
    expect(kept[0]).toMatchObject({ p256dh: RFC.uaPublic, auth: RFC.authSecret, ua: 'test', createdAt: '2026-10-01T00:00:00.000Z' });
    expect((s.store.patchUser as any).mock.calls).toHaveLength(1);
    expect(s.meta.has(VAPID_META)).toBe(true); // minted on the way
  });

  it('nothing gone → no write; a failure counts as not sent and keeps the subscription; no subscriptions → no fetch, no meta read', async () => {
    const s = memStore({ users: { u: user('u', { push: [sub(1), sub(2)] }), none: user('none') } });
    await ensureVapid(s.store); // minted up front (the mint itself reads meta twice: miss, then the re-read after writing)
    const reads = () => (s.store.getMeta as any).mock.calls.filter((c: unknown[]) => c[0] === VAPID_META).length;
    const before = reads();
    stubPushService((u) => (u.endsWith('/2') ? new Error('down') : 201));
    expect(await pushAll(s.store, s.users.get('u')!, payload)).toBe(1);
    expect((s.store.patchUser as any).mock.calls).toHaveLength(0);
    expect(s.users.get('u')!.push).toHaveLength(2);
    expect(reads()).toBe(before + 1); // one key read per pushAll without caller-supplied keys
    expect(await pushAll(s.store, s.users.get('none')!, payload)).toBe(0);
    expect((fetch as any).mock.calls).toHaveLength(2);
    expect(reads()).toBe(before + 1); // no subscriptions → no key read
  });

  it('a VAPID store failure is swallowed (0 sent), never thrown into a sync', async () => {
    const s = memStore({ users: { u: user('u', { push: [sub(1)] }) } });
    (s.store.getMeta as any).mockImplementation(async () => { throw new Error('meta down'); });
    stubPushService();
    expect(await pushAll(s.store, s.users.get('u')!, payload)).toBe(0);
    expect((fetch as any).mock.calls).toHaveLength(0);
  });
});

describe('subscription helpers', () => {
  it('parsePushSub accepts a browser subscription and rejects http, short keys and junk', () => {
    const good = parsePushSub({ endpoint: SUB.endpoint, keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret }, ua: ' Safari/iOS ' });
    expect(good).toEqual({ endpoint: SUB.endpoint, p256dh: RFC.uaPublic, auth: RFC.authSecret, ua: 'Safari/iOS' });
    expect(parsePushSub({ endpoint: SUB.endpoint, keys: { p256dh: RFC.uaPublic + '=', auth: RFC.authSecret.replace(/_/g, '/') } })!.p256dh).toBe(RFC.uaPublic); // normalised
    expect(parsePushSub({ endpoint: SUB.endpoint, keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret } })!.ua).toBeNull();
    expect(parsePushSub(null)).toBeNull();
    expect(parsePushSub({ endpoint: 'http://push.test/1', keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret } })).toBeNull();
    expect(parsePushSub({ endpoint: 'nope', keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret } })).toBeNull();
    expect(parsePushSub({ endpoint: SUB.endpoint, keys: { p256dh: RFC.uaPublic.slice(1), auth: RFC.authSecret } })).toBeNull();
    expect(parsePushSub({ endpoint: SUB.endpoint, keys: { p256dh: RFC.uaPublic, auth: 'AQID' } })).toBeNull();
    expect(parsePushSub({ endpoint: SUB.endpoint, keys: { p256dh: RFC.uaPublic, auth: 'not base64!!!!!!!!!!!!' } })).toBeNull();
    expect(parsePushSub({ endpoint: SUB.endpoint })).toBeNull();
  });

  it('upsertPushSub keeps one entry per endpoint (its createdAt), newest first, and drops the oldest past 5', () => {
    const now = '2026-10-26T00:00:00.000Z';
    const input = (n: number) => ({ endpoint: `https://push.test/${n}`, p256dh: RFC.uaPublic, auth: RFC.authSecret, ua: null });
    let list = upsertPushSub(undefined, input(1), '2026-10-01T00:00:00.000Z');
    for (let n = 2; n <= 6; n++) list = upsertPushSub(list, input(n), `2026-10-0${n}T00:00:00.000Z`);
    expect(list).toHaveLength(MAX_PUSH_SUBS);
    expect(list.map((s) => s.endpoint)).toEqual([6, 5, 4, 3, 2].map((n) => `https://push.test/${n}`));
    const again = upsertPushSub(list, input(3), now);
    expect(again.map((s) => s.endpoint)).toEqual([3, 6, 5, 4, 2].map((n) => `https://push.test/${n}`));
    expect(again[0].createdAt).toBe('2026-10-03T00:00:00.000Z');
    expect(again[0]).toEqual({ endpoint: 'https://push.test/3', p256dh: RFC.uaPublic, auth: RFC.authSecret, ua: null, createdAt: '2026-10-03T00:00:00.000Z', lastUsedAt: null });
  });
});

describe('routes', () => {
  const call = (s: ReturnType<typeof memStore>, path: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
    handleApi(new Request(`https://api.test${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }), env, { store: s.store }) as Promise<Response>;
  const body = { endpoint: SUB.endpoint, keys: { p256dh: RFC.uaPublic, auth: RFC.authSecret }, ua: 'Chrome/Android' };

  it('GET /api/push/key is public, mints on the first call, reuses the key after, cacheable for an hour', async () => {
    const s = memStore();
    const r1 = await call(s, '/api/push/key');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('cache-control')).toBe('public, max-age=3600');
    const { publicKey } = await r1.json() as { publicKey: string };
    expect(fromB64url(publicKey)).toHaveLength(65);
    expect((s.store.setMeta as any).mock.calls).toHaveLength(1);
    const r2 = await call(s, '/api/push/key');
    expect(((await r2.json()) as any).publicKey).toBe(publicKey);
    expect((s.store.setMeta as any).mock.calls).toHaveLength(1);
    expect(s.meta.get(VAPID_META)).toMatchObject({ publicKey, privateJwk: { d: expect.any(String) } });
  });

  it('POST /api/me/push upserts by endpoint (≤ 5), DELETE is idempotent, GET /api/me lists the endpoints', async () => {
    const s = memStore();
    expect((await call(s, '/api/me/push', { method: 'POST', body })).status).toBe(401); // sign-in required
    expect((await call(s, '/api/me/push', { method: 'POST', token: 'alice', body })).status).toBe(204);
    let u = s.users.get('uid_alice')!;
    expect(u.push).toHaveLength(1);
    expect(u.push![0]).toMatchObject({ endpoint: SUB.endpoint, p256dh: RFC.uaPublic, auth: RFC.authSecret, ua: 'Chrome/Android', lastUsedAt: null });
    expect(u.push![0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const createdAt = u.push![0].createdAt;

    expect((await call(s, '/api/me/push', { method: 'POST', token: 'alice', body: { ...body, ua: 'Chrome/Android 2' } })).status).toBe(204); // same phone again
    u = s.users.get('uid_alice')!;
    expect(u.push).toHaveLength(1);
    expect(u.push![0]).toMatchObject({ createdAt, ua: 'Chrome/Android 2' });

    for (let n = 1; n <= 5; n++) expect((await call(s, '/api/me/push', { method: 'POST', token: 'alice', body: { ...body, endpoint: `https://push.test/${n}` } })).status).toBe(204);
    u = s.users.get('uid_alice')!;
    expect(u.push!.map((x) => x.endpoint)).toEqual(['https://push.test/5', 'https://push.test/4', 'https://push.test/3', 'https://push.test/2', 'https://push.test/1']); // the first phone fell off
    const me = await (await call(s, '/api/me', { token: 'alice' })).json() as any;
    expect(me.push).toEqual({ endpoints: ['https://push.test/5', 'https://push.test/4', 'https://push.test/3', 'https://push.test/2', 'https://push.test/1'] });

    expect((await call(s, '/api/me/push', { method: 'DELETE', token: 'alice', body: { endpoint: 'https://push.test/3' } })).status).toBe(204);
    expect(s.users.get('uid_alice')!.push!.map((x) => x.endpoint)).toEqual(['https://push.test/5', 'https://push.test/4', 'https://push.test/2', 'https://push.test/1']);
    const writes = (s.store.patchUser as any).mock.calls.length;
    expect((await call(s, '/api/me/push', { method: 'DELETE', token: 'alice', body: { endpoint: 'https://push.test/3' } })).status).toBe(204); // again: still 204, no write
    expect((s.store.patchUser as any).mock.calls.length).toBe(writes + 1); // ensureUser's lastSeenAt only
    expect(s.users.get('uid_alice')!.push).toHaveLength(4);
  });

  it('an endpoint has one owner: a second account registering the same phone takes it off the first (sign-out without Turn off; shared phones)', async () => {
    TOKENS.bob = { uid: 'uid_bob', email: 'bob@example.com', emailVerified: true, name: null, provider: 'google.com' };
    try {
      const s = memStore();
      const id = await pushEndpointId(SUB.endpoint);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(await pushEndpointId('https://push.test/other')).not.toBe(id);
      // Alice: this phone + another one.
      expect((await call(s, '/api/me/push', { method: 'POST', token: 'alice', body })).status).toBe(204);
      expect((await call(s, '/api/me/push', { method: 'POST', token: 'alice', body: { ...body, endpoint: 'https://push.test/alice-tablet' } })).status).toBe(204);
      expect(s.owners.get(id)).toBe('uid_alice');
      const setWrites = (s.store.setPushOwner as any).mock.calls.length;
      expect((await call(s, '/api/me/push', { method: 'POST', token: 'alice', body })).status).toBe(204); // same owner again: no index write
      expect((s.store.setPushOwner as any).mock.calls.length).toBe(setWrites);
      // Bob signs in on the same phone and taps Turn on: the endpoint moves; Alice keeps her tablet.
      expect((await call(s, '/api/me/push', { method: 'POST', token: 'bob', body: { ...body, ua: 'Chrome/Android (bob)' } })).status).toBe(204);
      expect(s.owners.get(id)).toBe('uid_bob');
      expect(s.users.get('uid_bob')!.push!.map((x) => x.endpoint)).toEqual([SUB.endpoint]);
      expect(s.users.get('uid_alice')!.push!.map((x) => x.endpoint)).toEqual(['https://push.test/alice-tablet']);
      const alice = await (await call(s, '/api/me', { token: 'alice' })).json() as any;
      expect(alice.push).toEqual({ endpoints: ['https://push.test/alice-tablet'] });
      // Alice's pushes no longer reach the phone; Bob's do.
      const posts = stubPushService();
      await pushAll(s.store, s.users.get('uid_alice')!, { title: 't', body: 'b', url: 'https://fixmypvd.org/', tag: 'x' });
      expect(posts.map((p) => p.endpoint)).toEqual(['https://push.test/alice-tablet']);
      // Bob turns it off, then Alice is back on the phone: the stale index entry costs one getUser that finds nothing to strip.
      expect((await call(s, '/api/me/push', { method: 'DELETE', token: 'bob', body: { endpoint: SUB.endpoint } })).status).toBe(204);
      expect(s.owners.get(id)).toBe('uid_bob');
      const bobReads = (s.store.getUser as any).mock.calls.filter((c: unknown[]) => c[0] === 'uid_bob').length;
      const patches = (s.store.patchUser as any).mock.calls.length;
      expect(await claimPushEndpoint(s.store, 'uid_alice', SUB.endpoint)).toBe('uid_bob');
      expect((s.store.getUser as any).mock.calls.filter((c: unknown[]) => c[0] === 'uid_bob').length).toBe(bobReads + 1);
      expect((s.store.patchUser as any).mock.calls.length).toBe(patches); // nothing to strip, no write
      expect(s.owners.get(id)).toBe('uid_alice');
      // The previous owner's doc being unreadable does not block the new owner's opt-in.
      (s.store.getUser as any).mockImplementationOnce(async () => { throw new Error('users down'); });
      expect(await claimPushEndpoint(s.store, 'uid_bob', SUB.endpoint)).toBe('uid_alice');
      expect(s.owners.get(id)).toBe('uid_bob');
    } finally { delete TOKENS.bob; }
  });

  it('400s a bad subscription or a DELETE without an endpoint; an account that never subscribed has push.endpoints = []', async () => {
    const s = memStore();
    const me = await (await call(s, '/api/me', { token: 'alice' })).json() as any;
    expect(me.push).toEqual({ endpoints: [] });
    const bad = await call(s, '/api/me/push', { method: 'POST', token: 'alice', body: { endpoint: 'http://push.test/1', keys: body.keys } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_subscription' });
    expect((await call(s, '/api/me/push', { method: 'POST', token: 'alice', body: { endpoint: SUB.endpoint, keys: { p256dh: 'AQID', auth: RFC.authSecret } } })).status).toBe(400);
    expect((await call(s, '/api/me/push', { method: 'DELETE', token: 'alice', body: {} })).status).toBe(400);
    expect((await call(s, '/api/me/push', { method: 'PUT', token: 'alice', body })).status).toBe(404);
    expect(s.users.get('uid_alice')!.push).toBeUndefined();
  });
});

describe('triggers', () => {
  const ID = 'ab400112-05c8-f111-a3d0-001dd804b975';
  const mockMailer = () => {
    const sent: { to: string; kind?: string }[] = [];
    return { sent, mailer: { sendTo: vi.fn(async (to: string, _s: string, _h: string, o?: { kind?: string }) => { sent.push({ to, kind: o?.kind }); }), alert: vi.fn(async () => {}) } as unknown as Mailer };
  };

  describe('a followed city case moves (notifyCityFollowers)', () => {
    const cityCase = () => ({ caseType: 'Pothole', category: 'pothole', street: '12 Angell St', status: 'Resolved', createdAt: '2026-10-10T12:00:00.000Z', statusAt: '2026-10-25T12:00:00.000Z', lat: 41.8282, lng: -71.4005, detail: { resolution: 'Filled the hole on the north side of the street, two more scheduled for next week.' }, followerUids: ['two', 'mailonly', 'pushonly', 'stale', 'ghost'] });
    const users = () => ({
      two: user('two', { cityFollowing: [ID], push: [sub(1), sub(2)] }),                                       // mail + two phones
      mailonly: user('mailonly', { cityFollowing: [ID] }),                                                        // mail only
      pushonly: user('pushonly', { cityFollowing: [ID], prefs: { emailUpdates: false }, push: [sub(3)] }),          // email off, but asked for the phone
      stale: user('stale', { cityFollowing: [], push: [sub(4)] }),                                                  // fell off a full list: nothing
    });

    it('pushes once per subscription of each follower who still follows, with the email still sent, then never again for that status', async () => {
      const s = memStore({ cases: { [ID]: cityCase() }, users: users() });
      const posts = stubPushService();
      const { mailer, sent } = mockMailer();
      expect(await notifyCityFollowers(env, s.store, mailer, [{ id: ID, from: 'Assigned', to: 'Resolved' }])).toBe(2);
      expect(sent.map((m) => m.to).sort()).toEqual(['mailonly@example.com', 'two@example.com']);
      expect(posts.map((p) => p.endpoint).sort()).toEqual(['https://push.test/1', 'https://push.test/2', 'https://push.test/3']);
      expect(posts[0].payload).toEqual({
        title: 'City update: Pothole',
        body: 'Filled the hole on the north side of the street, two more scheduled for next week.'.length > 80
          ? '12 Angell St — Assigned → Resolved · Filled the hole on the north side of the street, two more scheduled for next wee'
          : 'unreachable',
        url: `https://fixmypvd.org/street?case=${ID}&lat=41.82820&lng=-71.40050`,
        tag: `case:${ID}`,
      });
      expect(posts[0].payload.body.split(' · ')[1]).toHaveLength(80);
      expect(s.cases[ID].notifiedStatus).toBe('Resolved');
      const log = s.events.find((e) => e.kind === 'push.sent');
      expect(log).toMatchObject({ level: 'info', data: { source: 'city_follow', users: 2, sent: 3 } });
      // the same status again: nothing
      expect(await notifyCityFollowers(env, s.store, mailer, [{ id: ID, from: 'Assigned', to: 'Resolved' }])).toBe(0);
      expect(posts).toHaveLength(3);
    });

    it('a push service that is down costs nothing: the mails go out, notifiedStatus is written, a gone phone is dropped', async () => {
      const s = memStore({ cases: { [ID]: cityCase() }, users: users() });
      stubPushService((u) => (u.endsWith('/1') ? new Error('ECONNRESET') : u.endsWith('/2') ? 410 : 201));
      const { mailer, sent } = mockMailer();
      expect(await notifyCityFollowers(env, s.store, mailer, [{ id: ID, from: 'Assigned', to: 'Resolved' }])).toBe(2);
      expect(sent).toHaveLength(2);
      expect(s.cases[ID].notifiedStatus).toBe('Resolved');
      expect(s.users.get('two')!.push!.map((x) => x.endpoint)).toEqual(['https://push.test/1']); // 410 dropped, the failed one kept
      expect(s.events.find((e) => e.kind === 'push.sent')).toMatchObject({ data: { users: 2, sent: 1 } });
    });

    it('cityFollowPush wording: no street, no change, open status (no note), and pushFollowers eligibility', () => {
      const base = { caseType: 'Tree', street: '', from: null, to: 'Assigned', resolution: 'ignored while open', url: 'https://x', guid: 'g' };
      expect(cityFollowPush(base)).toEqual({ title: 'City update: Tree', body: 'Assigned', url: 'https://x', tag: 'case:g' });
      expect(cityFollowPush({ ...base, street: ' 1 Main St ', from: 'Submitted' }).body).toBe('1 Main St — Submitted → Assigned');
      expect(cityFollowPush({ ...base, from: 'Assigned', to: 'Closed', resolution: '  Done\n  and dusted ' }).body).toBe('Assigned → Closed · Done and dusted');
      expect(cityFollowPush({ ...base, to: 'Cancelled', resolution: null }).body).toBe('Cancelled');
      const u = users();
      expect(pushFollowers([u.two, u.mailonly, u.pushonly, u.stale, null, u.two], ID).map((x) => x.uid)).toEqual(['two', 'pushonly']);
    });
  });

  describe('the Monday digests', () => {
    const NOW = Date.parse('2026-10-25T12:00:00Z'); // Sunday: the week mailed is Oct 18 – Oct 24
    const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
    const HOME = { lat: 41.8282, lng: -71.4005 };
    const row = (id: string, o: Record<string, unknown> = {}) => ({ id, caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status: 'Assigned', createdAt: daysAgo(3), firstSeenAt: daysAgo(3), lat: 41.8283, lng: -71.4006, ...o });
    const rows = () => [row('p1'), row('p2', { caseType: 'Street Light Out', status: 'Resolved', detail: { resolutionDate: daysAgo(2), resolution: 'Bulb replaced' } })];
    beforeEach(() => { resetWeekCache(); resetStreetCache(); });

    it('runWeekDigest pushes "This week in Providence" to opted-in accounts with a subscription, alongside the mail', async () => {
      const s = memStore({ rows: rows(), users: {
        both: user('both', { prefs: { emailUpdates: true, weekDigest: true }, push: [sub(1)] }),
        mail: user('mail', { prefs: { emailUpdates: true, weekDigest: true } }),
        unverified: user('unverified', { emailVerified: false, prefs: { emailUpdates: true, weekDigest: true }, push: [sub(2)] }),
        off: user('off', { prefs: { emailUpdates: true, weekDigest: false }, push: [sub(3)] }), // a stale query hit
      } });
      const posts = stubPushService();
      const { mailer, sent } = mockMailer();
      expect(await runWeekDigest(env, s.store, mailer, { now: NOW })).toEqual({ users: 4, mailed: 2, pushed: 2, adminMailed: true });
      expect(sent.map((m) => m.to).sort()).toEqual(['both@example.com', 'mail@example.com']);
      expect(posts.map((p) => p.endpoint).sort()).toEqual(['https://push.test/1', 'https://push.test/2']);
      expect(posts[0].payload).toEqual({ title: 'This week in Providence', body: '2 requests · 1 closed', url: 'https://fixmypvd.org/week?until=2026-10-24', tag: 'week' });
      expect(s.events.find((e) => e.kind === 'push.sent')).toMatchObject({ data: { source: 'week_digest', users: 2, sent: 2 } });
      expect((s.store.listCityCasesSince as any).mock.calls).toHaveLength(1);
    });

    it('runWeekDigest: a quiet week pushes nothing; weekDigestPush pluralises', async () => {
      const s = memStore({ rows: [], users: { both: user('both', { prefs: { emailUpdates: true, weekDigest: true }, push: [sub(1)] }) } });
      stubPushService();
      expect(await runWeekDigest(env, s.store, mockMailer().mailer, { now: NOW })).toEqual({ users: 1, mailed: 0, pushed: 0, adminMailed: false });
      expect((fetch as any).mock.calls).toHaveLength(0);
      const one = weekSummary([row('only')], { now: NOW, until: '2026-10-24' });
      expect(weekDigestPush(one, { base: 'https://fixmypvd.org/' })).toEqual({ title: 'This week in Providence', body: '1 request · 0 closed', url: 'https://fixmypvd.org/week?until=2026-10-24', tag: 'week' });
    });

    it('runStreetDigest pushes one "This week near <label>" per address with activity, to subscribed phones only', async () => {
      const addr = (id: string, label: string, lat: number, lng: number) => ({ id, label, address: `${label} St`, lat, lng });
      const s = memStore({ rows: rows(), users: {
        both: user('both', { prefs: { emailUpdates: true, streetDigest: true }, addresses: [addr('a1', 'Home', HOME.lat, HOME.lng), addr('a2', 'Far', 41.84, -71.41)], push: [sub(1)] }),
        mail: user('mail', { prefs: { emailUpdates: true, streetDigest: true }, addresses: [addr('b1', 'Home', HOME.lat, HOME.lng)] }),
        quiet: user('quiet', { prefs: { emailUpdates: true, streetDigest: true }, addresses: [addr('c1', 'Far', 41.84, -71.41)], push: [sub(2)] }),
        pushonly: user('pushonly', { emailVerified: false, prefs: { emailUpdates: true, streetDigest: true }, addresses: [addr('d1', 'Work', HOME.lat, HOME.lng)], push: [sub(3)] }),
      } });
      const posts = stubPushService();
      const { mailer, sent } = mockMailer();
      expect(await runStreetDigest(env, s.store, mailer, { now: NOW })).toEqual({ users: 4, mailed: 2, pushed: 2 });
      expect(sent.map((m) => m.to).sort()).toEqual(['both@example.com', 'mail@example.com']);
      expect(posts.map((p) => p.endpoint)).toEqual(['https://push.test/1', 'https://push.test/3']);
      expect(posts[0].payload).toEqual({ title: 'This week near Home', body: '2 new · 1 closed', url: streetUrl('https://fixmypvd.org', { ...HOME, address: 'Home St' }), tag: 'street:a1' });
      expect(posts[1].payload.title).toBe('This week near Work');
      expect(s.events.find((e) => e.kind === 'push.sent')).toMatchObject({ data: { source: 'street_digest', users: 2, sent: 2 } });
    });

    it('streetDigestPush counts new and closed like the mail subject does', () => {
      const items = nearbyCases(rows(), { ...HOME, radiusM: 300, days: 7, now: NOW });
      expect(streetDigestPush({ id: 'a1', label: 'Home', address: '12 Angell St', url: 'https://x/1', items }, daysAgo(7))).toEqual({ title: 'This week near Home', body: '2 new · 1 closed', url: 'https://x/1', tag: 'street:a1' });
      expect(streetDigestPush({ label: '', address: '12 Angell St', url: 'https://x/1', items: [] }, daysAgo(7))).toEqual({ title: 'This week near 12 Angell St', body: '0 new · 0 closed', url: 'https://x/1', tag: 'street:' });
    });
  });
});
