// Accounts are REQUIRED to report (optional to browse). Identity = Firebase Auth driven over its REST API (no SDK); the Worker verifies the ID token.
// Providers: email link (Worker-minted, sent via Resend) and Google (GIS credential → signInWithIdp, when VITE_GOOGLE_CLIENT_ID is set).
// Session = { idToken, refreshToken, expiresAt, uid, email } in localStorage; refreshed ~5 min before expiry.
import { useEffect, useState } from 'react';

const API_KEY: string = (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined) ?? 'AIzaSyCPT2YK0Pkao-oj6rvDDdpcZLNhqf_Ga2Q';
export const GOOGLE_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '224841506687-4jjb1vnse4b7t567ur7apd8pahn82kc2.apps.googleusercontent.com';
const IDP = 'https://identitytoolkit.googleapis.com/v1';
const SESSION_KEY = 'fixmypvd.session';
const PENDING_EMAIL_KEY = 'fixmypvd.pendingEmail';
const RETURN_TO_KEY = 'fixmypvd.returnTo';

export interface Session { uid: string; email: string | null; idToken: string; refreshToken: string; expiresAt: number; provider: 'email' | 'google' }

export class AuthError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
/** Map an auth failure to the i18n suffix both sign-in surfaces use (`account.error.*` / `gate.error.*`). */
export function authErrorKey(e: unknown): 'email' | 'link' | 'rate' | 'generic' {
  const code = e instanceof AuthError ? e.code : '';
  if (/INVALID_EMAIL|MISSING_EMAIL/.test(code)) return 'email';
  if (/INVALID_OOB_CODE|EXPIRED_OOB_CODE|INVALID_LOGIN_CREDENTIALS/.test(code)) return 'link';
  if (/TOO_MANY_ATTEMPTS|QUOTA|RATE/.test(code)) return 'rate';
  return 'generic';
}

let session: Session | null = load();
const listeners = new Set<(s: Session | null) => void>();
function load(): Session | null {
  try { const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null; return s && s.refreshToken ? s : null; } catch { return null; }
}
function set(s: Session | null) {
  session = s;
  try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  listeners.forEach((fn) => fn(s));
}

export const getSession = () => session;
export const isSignedIn = () => !!session;
export function onAuthChange(fn: (s: Session | null) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function useSession(): Session | null {
  const [s, setS] = useState(session);
  useEffect(() => onAuthChange(setS), []);
  return s;
}
/** Reactive identity for gates: `user` is null when signed out. `loading` is false after the first render. */
export function useAuth(): { user: { uid: string; email: string | null } | null; loading: boolean } {
  const s = useSession();
  return { user: s ? { uid: s.uid, email: s.email } : null, loading: false };
}

async function idp<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${IDP}/accounts:${method}?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!resp.ok) throw new AuthError((data.error?.message ?? `http_${resp.status}`).split(' ')[0].split(':')[0]);
  return data;
}

function fromTokens(d: { localId?: string; email?: string; idToken: string; refreshToken: string; expiresIn: string }, provider: Session['provider']): Session {
  return { uid: d.localId ?? session?.uid ?? '', email: d.email ?? session?.email ?? null, idToken: d.idToken, refreshToken: d.refreshToken, expiresAt: Date.now() + Number(d.expiresIn) * 1000, provider };
}

// ── Email link ──
/** Step 1: the Worker mints the link and emails it (Resend) — it lands on /account?returnTo=…&oobCode=…
 *  (Firebase's own sender is dropped by Gmail for this project, so we never call sendOobCode from the client.) */
export async function sendSignInLink(email: string, returnTo = '/'): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AuthError('INVALID_EMAIL');
  const { apiFetch } = await import('../api/client');
  const resp = await apiFetch('/api/auth/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, returnTo, lang: document.documentElement.lang || 'en' }) });
  if (!resp.ok) {
    const d = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new AuthError(resp.status === 429 ? 'TOO_MANY_ATTEMPTS' : d.error === 'invalid_email' ? 'INVALID_EMAIL' : 'SEND_FAILED');
  }
  try { localStorage.setItem(PENDING_EMAIL_KEY, e); localStorage.setItem(RETURN_TO_KEY, returnTo); } catch { /* ignore */ }
}
export function pendingEmail(): string | null { try { return localStorage.getItem(PENDING_EMAIL_KEY); } catch { return null; } }
/** Where to go after sign-in: the URL's returnTo (survives a link opened in another tab) → the remembered one → fallback. Same-origin paths only. */
export function takeReturnTo(fallback = '/my'): string {
  let v: string | null = null;
  try { v = new URL(location.href).searchParams.get('returnTo'); } catch { /* ignore */ }
  if (!v) { try { v = localStorage.getItem(RETURN_TO_KEY); localStorage.removeItem(RETURN_TO_KEY); } catch { /* ignore */ } }
  return v && /^\/(?!\/)[A-Za-z0-9_\-./?=&%]*$/.test(v) ? v : fallback;
}
/** True when the current URL carries an email-link oobCode. */
export function isSignInLink(url = location.href): boolean {
  const q = new URL(url).searchParams; return q.get('mode') === 'signIn' && !!q.get('oobCode');
}
/** Step 2: complete the link. Needs the email it was sent to (stored on this device, or asked from the user). */
export async function completeSignInLink(email: string, url = location.href): Promise<Session> {
  const oobCode = new URL(url).searchParams.get('oobCode');
  if (!oobCode) throw new AuthError('INVALID_OOB_CODE');
  const d = await idp<{ localId: string; email: string; idToken: string; refreshToken: string; expiresIn: string }>('signInWithEmailLink', { oobCode, email: email.trim().toLowerCase() });
  try { localStorage.removeItem(PENDING_EMAIL_KEY); } catch { /* ignore */ }
  const s = fromTokens(d, 'email'); set(s); return s;
}

// ── Google (GIS) ──
type Gsi = { accounts: { id: { initialize: (o: Record<string, unknown>) => void; renderButton: (el: HTMLElement, o: Record<string, unknown>) => void; prompt: () => void } } };
let gsiLoading: Promise<Gsi> | null = null;
export function loadGsi(): Promise<Gsi> {
  const w = window as unknown as { google?: Gsi };
  if (w.google?.accounts?.id) return Promise.resolve(w.google);
  if (!gsiLoading) gsiLoading = new Promise<Gsi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = () => (w.google ? resolve(w.google) : reject(new AuthError('GSI_LOAD')));
    s.onerror = () => reject(new AuthError('GSI_LOAD'));
    document.head.appendChild(s);
  });
  return gsiLoading;
}
/** Exchange a Google ID token (from the GIS button) for a Firebase session. */
export async function signInWithGoogleCredential(credential: string): Promise<Session> {
  const d = await idp<{ localId: string; email: string; idToken: string; refreshToken: string; expiresIn: string }>('signInWithIdp', {
    postBody: `id_token=${encodeURIComponent(credential)}&providerId=google.com`, requestUri: location.origin, returnSecureToken: true, returnIdpCredential: false,
  });
  const s = fromTokens(d, 'google'); set(s); return s;
}

// ── Tokens ──
let refreshing: Promise<string | null> | null = null;
/** A fresh ID token for the Worker, or null when signed out. Refreshes when within 5 min of expiry; signs out on a dead refresh token. */
export async function getIdToken(): Promise<string | null> {
  const s = session;
  if (!s) return null;
  if (s.expiresAt - Date.now() > 5 * 60_000) return s.idToken;
  if (!refreshing) refreshing = (async () => {
    try {
      const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken }),
      });
      if (resp.status === 400 || resp.status === 401) { set(null); return null; } // revoked/expired → signed out
      if (!resp.ok) return s.idToken; // transient: keep using the current token
      const d = (await resp.json()) as { id_token: string; refresh_token: string; expires_in: string; user_id: string };
      set({ ...s, idToken: d.id_token, refreshToken: d.refresh_token, expiresAt: Date.now() + Number(d.expires_in) * 1000, uid: d.user_id || s.uid });
      return d.id_token;
    } catch { return s.idToken; } finally { refreshing = null; }
  })();
  return refreshing;
}
/** `{ Authorization }` for authenticated calls; `{}` when signed out. Never throws. */
export async function authHeaders(): Promise<Record<string, string>> {
  const t = await getIdToken().catch(() => null);
  return t ? { Authorization: `Bearer ${t}` } : {};
}
export function signOut(): void { set(null); }
