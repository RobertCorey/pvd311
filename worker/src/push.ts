/**
 * push.ts — Web Push for "Notify me on this phone": the same moments that send email (your own report's city status
 * moving, the city asking you a question, a followed city case moving, the Monday street + week digests) also reach
 * the phone(s) a signed-in resident subscribed from the app. Email is never replaced; a push that fails never breaks a
 * sync or a digest (every send is caught and counted).
 *
 * Pure WebCrypto, no npm dependency:
 *   - VAPID (RFC 8292): the signing key is MINTED HERE on first use and kept in Firestore meta/vapid (public key as
 *     the base64url raw P-256 point, private key as a JWK) — no secret to set by hand. GET /api/push/key hands the
 *     public key to the app for PushManager.subscribe({ applicationServerKey }).
 *   - Payload encryption (RFC 8291 + RFC 8188 aes128gcm): fresh ECDH P-256 key + 16-byte salt per message, one record
 *     (rs 4096), padding delimiter 0x02. `encrypt` takes an injectable key pair + salt so the RFC's Appendix A
 *     known-answer test runs against it (test/push.test.ts).
 *
 * Opt-in = having a subscription: users/{uid}.push[] (≤ MAX_PUSH_SUBS per account, newest first; POST/DELETE
 * /api/me/push in me.ts). A push service answering 404/410 means the browser dropped the subscription — pushAll
 * removes it. Payload JSON: { title, body, url, tag } (the app's service worker shows it and opens `url` on tap).
 */
import type { PushSub, Store, UserDoc } from './contracts.js';
import { logEvent } from './health.js';

export type { PushSub };
export const VAPID_META = 'vapid';
export const VAPID_SUBJECT = 'mailto:rob@fixmypvd.org';
export const VAPID_TTL_S = 12 * 3600;
export const MAX_PUSH_SUBS = 5;
export const PUSH_TTL_S = 86_400;
export const PUSH_FETCH_TIMEOUT_MS = 10_000;
export const RECORD_SIZE = 4096;
export const HEADER_LEN = 86;                                // salt 16 + rs 4 + idlen 1 + sender public key 65
export const MAX_PLAINTEXT = RECORD_SIZE - HEADER_LEN - 17;  // one record: plaintext + 0x02 + 16-byte tag must fit rs
const P256_POINT_LEN = 65;
const AUTH_LEN = 16;

export interface PushPayload { title: string; body: string; url: string; tag: string }
export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }
export interface PushResult { ok: boolean; status: number; gone: boolean }

// ── base64url (no padding) ─────────────────────────────────────────────────────────────

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts base64url or plain base64, padded or not; throws on anything else. */
export function fromB64url(s: string): Uint8Array {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) throw new Error('bad base64url');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const buf = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

// ── VAPID keys (meta/vapid) ────────────────────────────────────────────────────────────

/** The raw uncompressed point (0x04 || x || y) of an EC JWK. */
export function rawPublicKeyFromJwk(jwk: JsonWebKey): Uint8Array {
  if (!jwk.x || !jwk.y) throw new Error('jwk without x/y');
  return concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y));
}

/** Load the VAPID key pair, minting and storing one on the very first call. Two isolates minting at once converge on
 *  whichever write landed last (both re-read after writing), so a subscription made with the served key stays valid. */
export async function ensureVapid(store: Store): Promise<VapidKeys> {
  const stored = await store.getMeta<Partial<VapidKeys>>(VAPID_META);
  if (stored?.privateJwk?.d) return { publicKey: stored.publicKey || b64url(rawPublicKeyFromJwk(stored.privateJwk)), privateJwk: stored.privateJwk };
  // A record that exists but carries no usable private key is a damaged one, not a missing one: re-minting over it
  // would silently orphan every subscription made with the old public key. Fail loudly (pushAll counts it as 0 sent).
  if (stored && Object.keys(stored).length) throw new Error('meta/vapid is malformed (no privateJwk.d); restore it or delete it to re-mint');
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicKey = b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  await store.setMeta(VAPID_META, { publicKey, privateJwk, createdAt: new Date().toISOString() });
  const again = await store.getMeta<Partial<VapidKeys>>(VAPID_META).catch(() => null);
  if (again?.privateJwk?.d && again.publicKey) return { publicKey: again.publicKey, privateJwk: again.privateJwk };
  return { publicKey, privateJwk };
}

/** GET /api/push/key → { publicKey } (public; cacheable for an hour — the key never changes once minted). */
export async function handlePushKey(store: Store): Promise<Response> {
  const { publicKey } = await ensureVapid(store);
  return new Response(JSON.stringify({ publicKey }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
}

/**
 * RFC 8292 Authorization header: `vapid t=<JWT>, k=<public key>`. JWT = ES256 over { aud: the push service origin,
 * exp: now + 12 h, sub }; WebCrypto's ECDSA P-256/SHA-256 signature is already the raw r||s that JWS wants.
 */
export async function vapidAuthHeader(audience: string, subject: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + VAPID_TTL_S, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ── Message encryption (RFC 8291 → RFC 8188 aes128gcm) ─────────────────────────────────

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** An ECDH P-256 pair from its raw public point + private scalar (base64url) — the RFC's test vectors, nothing else. */
export async function ecdhPairFromRaw(publicRaw: string, privateScalar: string): Promise<CryptoKeyPair> {
  const pub = fromB64url(publicRaw);
  if (pub.length !== P256_POINT_LEN || pub[0] !== 4) throw new Error('bad P-256 point');
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: privateScalar, ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, ECDH, true, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('raw', buf(pub), ECDH, true, []);
  return { privateKey, publicKey };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, bytes * 8));
}

/**
 * Encrypt one push message for a subscription (its `p256dh` = the browser's P-256 public key, `auth` = its 16-byte
 * secret), both base64url. Returns header (86 bytes) || one aes128gcm record (plaintext || 0x02 || 16-byte tag).
 *   IKM  = ECDH(sender ephemeral private, receiver public)
 *   IKM' = HKDF(salt = auth, IKM, "WebPush: info\0" || receiver public || sender public, 32)     (RFC 8291 §3.4)
 *   CEK  = HKDF(salt, IKM', "Content-Encoding: aes128gcm\0", 16), NONCE = HKDF(salt, IKM', "Content-Encoding: nonce\0", 12)
 * `opts.ephemeral` / `opts.salt` exist for the known-answer test; production draws both fresh.
 */
export async function encrypt(plaintext: Uint8Array, sub: { p256dh: string; auth: string }, opts: { ephemeral?: CryptoKeyPair; salt?: Uint8Array } = {}): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push payload too large (${plaintext.length} > ${MAX_PLAINTEXT} bytes)`);
  const receiverPub = fromB64url(sub.p256dh);
  if (receiverPub.length !== P256_POINT_LEN || receiverPub[0] !== 4) throw new Error('bad p256dh');
  const authSecret = fromB64url(sub.auth);
  if (authSecret.length !== AUTH_LEN) throw new Error('bad auth secret');
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('bad salt');

  const ephemeral = opts.ephemeral ?? ((await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair);
  const senderPub = new Uint8Array((await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer);
  const receiverKey = await crypto.subtle.importKey('raw', buf(receiverPub), ECDH, false, []);
  // WebCrypto's EcdhKeyDeriveParams is { name, public }; @cloudflare/workers-types spells the field `$public`, hence the cast.
  const ecdhParams = { name: 'ECDH', public: receiverKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0];
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, ephemeral.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(utf8('WebPush: info\0'), receiverPub, senderPub), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const header = concat(salt, new Uint8Array([(RECORD_SIZE >>> 24) & 255, (RECORD_SIZE >>> 16) & 255, (RECORD_SIZE >>> 8) & 255, RECORD_SIZE & 255]), new Uint8Array([senderPub.length]), senderPub);
  const aes = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), tagLength: 128 }, aes, buf(concat(plaintext, new Uint8Array([2])))));
  return concat(header, record);
}

// ── Sending ────────────────────────────────────────────────────────────────────────────

export const encodePayload = (p: PushPayload): Uint8Array => utf8(JSON.stringify(p));

/**
 * POST one encrypted message to a subscription's push service. `audience` is the VAPID `aud` — the push service's
 * origin, derived from the endpoint unless given. Network errors come back as { ok: false, status: 0 }.
 * `gone` (404 / 410) = the browser dropped the subscription — the caller removes it.
 */
export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload | Uint8Array, keys: VapidKeys, audience?: string): Promise<PushResult> {
  const aud = audience ?? new URL(sub.endpoint).origin;
  const body = await encrypt(payload instanceof Uint8Array ? payload : encodePayload(payload), sub);
  const headers = {
    authorization: await vapidAuthHeader(aud, VAPID_SUBJECT, keys),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(PUSH_TTL_S),
    urgency: 'normal',
  };
  try {
    // Bounded: a hung push service must not hold a sync (and its notifiedStatus write) or a digest past the cron's budget.
    const r = await fetch(sub.endpoint, { method: 'POST', headers, body: buf(body), signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT_MS) });
    await r.body?.cancel().catch(() => {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) {
    console.warn('[push] send failed:', e instanceof Error ? e.message : e);
    return { ok: false, status: 0, gone: false };
  }
}

export const isPushSub = (x: unknown): x is PushSub =>
  !!x && typeof x === 'object' && typeof (x as PushSub).endpoint === 'string' && typeof (x as PushSub).p256dh === 'string' && typeof (x as PushSub).auth === 'string';
export const hasPush = (u: UserDoc | null | undefined): boolean => (u?.push ?? []).some(isPushSub);

/**
 * Send `payload` to every subscription of one account (in parallel, ≤ MAX_PUSH_SUBS), drop the ones the push service
 * says are gone, and return how many were accepted. Never throws; a failure is logged to the console and counted
 * by the caller as "not sent". `keys` saves a meta read when the caller pushes to many accounts in one run.
 */
export async function pushAll(store: Store, user: UserDoc, payload: PushPayload, keys?: VapidKeys): Promise<number> {
  const subs = (user.push ?? []).filter(isPushSub).slice(0, MAX_PUSH_SUBS);
  if (!subs.length) return 0;
  let k: VapidKeys;
  try { k = keys ?? await ensureVapid(store); } catch (e) { console.error('[push] no VAPID keys:', e instanceof Error ? e.message : e); return 0; }
  const results = await Promise.all(subs.map((s) => sendPush(s, payload, k).catch((e): PushResult => { console.warn('[push] send threw:', e instanceof Error ? e.message : e); return { ok: false, status: 0, gone: false }; })));
  const gone = new Set(subs.filter((_, i) => results[i].gone).map((s) => s.endpoint));
  const sent = results.filter((r) => r.ok).length;
  if (gone.size) {
    // One write, only when the list changed: the kept subscriptions, the ones that just worked stamped lastUsedAt.
    const now = new Date().toISOString();
    const kept = subs.flatMap((s, i) => (results[i].gone ? [] : [results[i].ok ? { ...s, lastUsedAt: now } : s]));
    await store.patchUser(user.uid, { push: kept }).catch((e) => console.warn('[push] prune failed:', e instanceof Error ? e.message : e));
  }
  for (const [i, r] of results.entries()) if (!r.ok && !r.gone) console.warn(`[push] ${r.status || 'network'} from ${new URL(subs[i].endpoint).host} for ${user.uid}`);
  return sent;
}

/**
 * A report owner's own event (its city status moved — engine.ts; the city asked them a question — cityask.ts) on every
 * phone the account turned on, right after the mail. Email settings do not apply: a subscription is its own opt-in.
 * Reads the account; nothing without a uid, an account or a subscription. Never throws. `users` (0 or 1: the account
 * has a subscription) and `sent` (phones that accepted) are what the caller hands logPushes.
 */
export async function pushOwner(store: Store, uid: string | null | undefined, payload: PushPayload): Promise<{ users: number; sent: number }> {
  if (!uid) return { users: 0, sent: 0 };
  try {
    const u = await store.getUser(uid);
    if (!u || !hasPush(u)) return { users: 0, sent: 0 };
    return { users: 1, sent: await pushAll(store, u, payload) };
  } catch (e) {
    console.error('[push] owner push failed:', e instanceof Error ? e.message : e);
    return { users: 0, sent: 0 };
  }
}

/** One log line per run that reached at least one subscribed account: kind 'push.sent', data { source, users, sent, ... }. */
export async function logPushes(store: Store, source: string, o: { users: number; sent: number } & Record<string, unknown>): Promise<void> {
  if (!o.users) return;
  await logEvent(store, { level: 'info', kind: 'push.sent', msg: `Push (${source}): ${o.sent} sent to ${o.users} subscribed account${o.users === 1 ? '' : 's'}`, data: { source, ...o } });
}

// ── Subscriptions (users/{uid}.push, routes in me.ts) ─────────────────────────────────

export interface PushSubInput { endpoint: string; p256dh: string; auth: string; ua: string | null }

/** Validate a POST /api/me/push body: an https endpoint, a 65-byte P-256 point and a 16-byte auth secret (base64url). */
export function parsePushSub(body: unknown): PushSubInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; ua?: unknown };
  if (typeof b.endpoint !== 'string' || b.endpoint.length > 2048) return null;
  let url: URL;
  try { url = new URL(b.endpoint); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
  const auth = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
  try {
    const pt = fromB64url(p256dh);
    if (pt.length !== P256_POINT_LEN || pt[0] !== 4 || fromB64url(auth).length !== AUTH_LEN) return null;
  } catch { return null; }
  const ua = typeof b.ua === 'string' ? b.ua.trim().slice(0, 200) || null : null;
  return { endpoint: b.endpoint, p256dh: b64url(fromB64url(p256dh)), auth: b64url(fromB64url(auth)), ua };
}

/** The document id of an endpoint's owner record: hex SHA-256 of the endpoint URL (endpoints are up to 2 KB and hold
 *  `/`, which a Firestore document id cannot). */
export async function pushEndpointId(endpoint: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(endpoint)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Make `endpoint` belong to `uid` alone: pushEndpoints/{sha256(endpoint)} names the owning account, and when it names
 * another one — a different account used this phone and did not turn push off before signing out — that account's
 * push[] loses the endpoint (one extra read + one patch, best effort), so the phone only gets the pushes of whoever is
 * signed in on it. Returns the previous owner's uid when one was displaced, else null. The index entry is left in
 * place by DELETE and by pushAll's 410 pruning: a stale entry only costs the next claim one getUser that finds
 * nothing to strip.
 */
export async function claimPushEndpoint(store: Store, uid: string, endpoint: string): Promise<string | null> {
  const id = await pushEndpointId(endpoint);
  const owner = await store.getPushOwner(id);
  if (owner?.uid === uid) return null;
  let displaced: string | null = null;
  if (owner?.uid) {
    displaced = owner.uid;
    try {
      const prev = await store.getUser(owner.uid);
      const list = prev?.push ?? [];
      const kept = list.filter((s) => !isPushSub(s) || s.endpoint !== endpoint);
      if (prev && kept.length !== list.length) await store.patchUser(owner.uid, { push: kept });
    } catch (e) { console.warn('[push] could not strip the previous owner:', e instanceof Error ? e.message : e); }
  }
  await store.setPushOwner(id, uid);
  return displaced;
}

/** Upsert by endpoint (a re-registration keeps its createdAt), newest first, the oldest beyond MAX_PUSH_SUBS dropped. Pure. */
export function upsertPushSub(list: PushSub[] | undefined, sub: PushSubInput, nowIso: string): PushSub[] {
  const prev = (list ?? []).filter(isPushSub);
  const same = prev.find((s) => s.endpoint === sub.endpoint);
  const entry: PushSub = { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, ua: sub.ua, createdAt: same?.createdAt ?? nowIso, lastUsedAt: same?.lastUsedAt ?? null };
  return [entry, ...prev.filter((s) => s.endpoint !== sub.endpoint)].slice(0, MAX_PUSH_SUBS);
}
