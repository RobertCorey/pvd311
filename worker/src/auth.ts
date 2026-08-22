/**
 * auth.ts — verifies Firebase Auth ID tokens server-side (the client drives Firebase Auth over REST; the
 * Worker is the only thing that trusts the result). RS256 against Google's securetoken JWKS, cached in
 * module scope per the response's max-age. No Firebase SDK anywhere.
 *
 * Accounts are optional: every public endpoint keeps working without a token. Anonymous-provider tokens
 * are rejected — an "account" means a verified email (email link) or a Google identity.
 */
import type { Env } from './contracts.js';

export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  provider: string;      // 'password' (email link) | 'google.com' | …
}

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SEC = 60;

interface Jwk { kid: string; kty: string; alg: string; n: string; e: string; use?: string }
let jwksCache: { keys: Map<string, CryptoKey>; expiresAt: number } | null = null;

async function loadJwks(force = false): Promise<Map<string, CryptoKey>> {
  if (!force && jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const resp = await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
  if (!resp.ok) throw new Error(`jwks ${resp.status}`);
  const { keys } = (await resp.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const k of keys) {
    if (k.kty !== 'RSA') continue;
    map.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  const maxAge = Number(/max-age=(\d+)/.exec(resp.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  jwksCache = { keys: map, expiresAt: Date.now() + Math.max(300, Math.min(maxAge, 86_400)) * 1000 };
  return map;
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as Record<string, unknown>;

interface Claims {
  iss?: string; aud?: string; sub?: string; exp?: number; iat?: number; auth_time?: number;
  email?: string; email_verified?: boolean; name?: string;
  firebase?: { sign_in_provider?: string };
}

/** Verify a Firebase ID token. Returns null for any invalid/expired/anonymous token (never throws). */
export async function verifyIdToken(env: Env, token: string | null | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson(parts[0]) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' || !header.kid) return null;
    let keys = await loadJwks();
    let key = keys.get(header.kid);
    if (!key) { keys = await loadJwks(true); key = keys.get(header.kid); } // key rotation
    if (!key) return null;
    const ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const c = decodeJson(parts[1]) as Claims;
    const now = Math.floor(Date.now() / 1000);
    if (c.aud !== env.FIREBASE_PROJECT_ID) return null;
    if (c.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) return null;
    if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_SEC < now) return null;
    if (typeof c.iat !== 'number' || c.iat - CLOCK_SKEW_SEC > now) return null;
    if (!c.sub || c.sub.length > 128) return null;
    const provider = c.firebase?.sign_in_provider ?? 'unknown';
    if (provider === 'anonymous') return null;
    return {
      uid: c.sub,
      email: typeof c.email === 'string' ? c.email.toLowerCase() : null,
      emailVerified: c.email_verified === true,
      name: typeof c.name === 'string' ? c.name.slice(0, 120) : null,
      provider,
    };
  } catch {
    return null;
  }
}

/** Pull the bearer token from a request (Authorization: Bearer …). */
export function bearerToken(request: Request): string | null {
  const h = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+([A-Za-z0-9_\-.]+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Optional identity for a request: null when no/invalid token. Never throws. */
export const userFromRequest = (env: Env, request: Request) => verifyIdToken(env, bearerToken(request));
