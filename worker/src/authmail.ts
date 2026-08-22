/**
 * authmail.ts — sign-in links minted by the Worker and delivered by Resend.
 * Firebase's own sender (noreply@<project>.firebaseapp.com) is silently dropped by Gmail for this project, so the
 * client asks us instead: POST /api/auth/link { email, returnTo? }. We mint the email-link oobCode through the
 * Identity Toolkit admin API (service account, returnOobLink) and mail it from AUTH_FROM. The link itself is the
 * standard Firebase action URL → redirects to APP_BASE_URL/account?oobCode=… → client completes signInWithEmailLink.
 * Rate-limited per email (3 / 15 min) and per IP (12 / hour). Always answers 200 {sent:true} for a well-formed email
 * so the endpoint can't be used to enumerate accounts.
 */
import type { Env, Store } from './contracts.js';
import { getAccessToken } from './firestore.js';

const PER_EMAIL = { n: 3, windowMs: 15 * 60_000 };
const PER_IP = { n: 12, windowMs: 60 * 60_000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Sliding-window counter in meta/. Returns false when over the limit; commits the hit otherwise. */
async function allow(store: Store, key: string, lim: { n: number; windowMs: number }): Promise<boolean> {
  const id = `authlink_${key}`;
  const now = Date.now();
  const rec = (await store.getMeta<{ hits?: number[] }>(id)) ?? {};
  const hits = (rec.hits ?? []).filter((t) => now - t < lim.windowMs);
  if (hits.length >= lim.n) return false;
  await store.setMeta(id, { hits: [...hits, now] });
  return true;
}

function safeReturnTo(v: unknown): string {
  return typeof v === 'string' && /^\/[A-Za-z0-9_\-./?=&%]*$/.test(v) && !v.startsWith('//') ? v.slice(0, 200) : '/';
}

export async function sendSignInLink(request: Request, env: Env, store: Store): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: unknown; returnTo?: unknown; lang?: unknown } | null;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 200) return Response.json({ error: 'invalid_email', field: 'email' }, { status: 400 });
  const ip = request.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  const lang = body?.lang === 'es' ? 'es' : 'en';

  if (!(await allow(store, `ip_${await sha(ip)}`, PER_IP)) || !(await allow(store, `em_${await sha(email)}`, PER_EMAIL))) {
    return Response.json({ error: 'rate_limited', retryAfterSec: 900 }, { status: 429, headers: { 'retry-after': '900' } });
  }

  // Send the reporter back to the origin they were on (pvdsnow.org today, fixmypvd.org once connected) — any
  // https origin on our domains or Firebase Hosting; otherwise APP_BASE_URL.
  const origin = request.headers.get('origin') ?? '';
  const ours = /^https:\/\/(www\.)?(fixmypvd\.org|fixmypvd\.com|pvdsnow\.org|snappvd\.org)$|^https:\/\/pvd-snow-report\.(web\.app|firebaseapp\.com)$|^http:\/\/localhost(:\d+)?$/.test(origin);
  const appBase = (ours ? origin : (env.APP_BASE_URL ?? 'https://fixmypvd.org')).replace(/\/+$/, '');
  const continueUrl = `${appBase}/account?returnTo=${encodeURIComponent(safeReturnTo(body?.returnTo))}`;
  const token = await getAccessToken(env);
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goog-user-project': env.FIREBASE_PROJECT_ID },
    body: JSON.stringify({ requestType: 'EMAIL_SIGNIN', email, continueUrl, canHandleCodeInApp: true, returnOobLink: true, targetProjectId: env.FIREBASE_PROJECT_ID }),
  });
  const d = (await r.json().catch(() => ({}))) as { oobLink?: string; error?: { message?: string } };
  if (!r.ok || !d.oobLink) {
    console.error('[authmail] mint failed', r.status, d.error?.message);
    return Response.json({ error: 'internal' }, { status: 500 });
  }

  const from = (env as unknown as { AUTH_FROM?: string }).AUTH_FROM || 'FixMyPVD <updates@fixmypvd.org>';
  const copy = lang === 'es'
    ? { subject: 'Tu enlace para entrar a FixMyPVD', lead: 'Toca el botón para entrar a FixMyPVD en este dispositivo.', btn: 'Entrar a FixMyPVD', note: 'El enlace funciona una sola vez. Si no lo pediste, ignora este correo.', alt: 'Si el botón no funciona, copia este enlace en tu navegador:' }
    : { subject: 'Your FixMyPVD sign-in link', lead: 'Tap the button to sign in to FixMyPVD on this device.', btn: 'Sign in to FixMyPVD', note: "The link works once. If you didn't ask for it, ignore this email.", alt: "If the button doesn't work, paste this link into your browser:" };
  const link = d.oobLink;
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:0 auto;padding:1.5rem 1rem;color:#1b1b1b">`
    + `<p style="font-size:1.05rem">${copy.lead}</p>`
    + `<p style="margin:1.5rem 0"><a href="${link}" style="display:inline-block;padding:12px 20px;background:#E8622C;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">${copy.btn}</a></p>`
    + `<p style="color:#555">${copy.note}</p>`
    + `<p style="color:#888;font-size:.85rem">${copy.alt}<br><a href="${link}" style="color:#888;word-break:break-all">${link}</a></p>`
    + `<p style="color:#999;font-size:.8rem;margin-top:2rem">FixMyPVD is an independent community project, not affiliated with the City of Providence.</p></div>`;
  const text = `${copy.lead}\n\n${link}\n\n${copy.note}`;

  if (!env.RESEND_API_KEY) { console.log(`[authmail] (no RESEND_API_KEY) link for ${email}: ${link}`); return Response.json({ sent: true }); }
  const m = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject: copy.subject, html, text }),
  });
  if (!m.ok) { console.error('[authmail] resend failed', m.status, await m.text().catch(() => '')); return Response.json({ error: 'internal' }, { status: 500 }); }
  return Response.json({ sent: true });
}
