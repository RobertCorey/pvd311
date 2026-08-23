import { APP_VERSION } from '../brand';
import type { FeedResponse, IntakeRequest, IntakeResult, NearbyResponse, ReportCreated, ReportSubmission, ReportView } from './types';
import { ApiError } from './types';
import { authHeaders } from '../lib/auth';

// Primary API host with a fallback: if the custom domain is unreachable (DNS/cert
// propagation, outage) we switch to the workers.dev origin for the session.
// Tests abort the primary host (`page.route('https://api.fixmypvd.org/**', r => r.abort())`)
// so specs keep hitting the mocked workers.dev origin.
const FALLBACK_BASE = 'https://pvd311-worker.pvd311-worker.workers.dev';
const PRIMARY_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'https://api.fixmypvd.org';
let activeBase = PRIMARY_BASE;
/** @deprecated use apiFetch(); kept for modules that build URLs themselves. */
export const API_BASE: string = PRIMARY_BASE;
export const apiBase = () => activeBase;

/** fetch() against the API with host fallback on a network-level failure of the primary host. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = activeBase; // capture: a concurrent call may flip activeBase while this one is in flight
  try {
    return await fetch(`${base}${path}`, init);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || base === FALLBACK_BASE) throw err;
    activeBase = FALLBACK_BASE;
    return fetch(`${FALLBACK_BASE}${path}`, init);
  }
}

/** Stable per-device id (pacing on the server). Never PII. */
export function deviceId(): string {
  try {
    const k = 'pvd311.deviceId';
    let v = localStorage.getItem(k);
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v); }
    return v;
  } catch { return 'ephemeral-' + Math.random().toString(36).slice(2); }
}

export async function parseError(resp: Response): Promise<ApiError> {
  let body: { error?: string; field?: string; retryAfterSec?: number } = {};
  try { body = await resp.json(); } catch { /* non-JSON error */ }
  return new ApiError(resp.status, body.error ?? `http_${resp.status}`, body.field, body.retryAfterSec);
}

export function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

export async function submitReport(r: ReportSubmission, clientId?: string): Promise<ReportCreated> {
  const fd = new FormData();
  if (clientId) fd.set('clientId', clientId); // idempotency key (outbox retries)
  fd.set('category', r.category);
  fd.set('description', r.description);
  fd.set('address', r.address);
  if (r.lat != null && r.lng != null) { fd.set('lat', String(r.lat)); fd.set('lng', String(r.lng)); }
  if (r.extra && Object.keys(r.extra).length) fd.set('extra', JSON.stringify(r.extra));
  if (r.email) fd.set('email', r.email);
  if (r.name) fd.set('name', r.name);
  fd.set('turnstileToken', r.turnstileToken);
  fd.set('deviceId', deviceId());
  fd.set('appVersion', APP_VERSION);
  if (r.descriptionOriginal) fd.set('descriptionOriginal', r.descriptionOriginal);
  if (r.intakeFlags?.length) fd.set('intakeFlags', JSON.stringify(r.intakeFlags));
  if (r.photo) fd.set('photo', r.photo, 'photo.jpg');
  const t = withTimeout(45_000);
  try {
    const resp = await apiFetch(`/api/report`, { method: 'POST', body: fd, signal: t.signal, headers: await authHeaders() }); // bearer only when signed in
    if (!resp.ok) throw await parseError(resp);
    return (await resp.json()) as ReportCreated;
  } finally { t.done(); }
}

/** Moderation + optional polish. Never throws — null means "no suggestion". */
export async function intake(req: Omit<IntakeRequest, 'appVersion'>, turnstileToken?: string | null): Promise<IntakeResult | null> {
  const t = withTimeout(6_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (turnstileToken) headers['X-Turnstile-Token'] = turnstileToken;
    const resp = await apiFetch(`/api/intake`, {
      method: 'POST', headers, signal: t.signal,
      body: JSON.stringify({ ...req, appVersion: APP_VERSION } satisfies IntakeRequest),
    });
    if (!resp.ok) return null;
    const d = (await resp.json()) as Partial<IntakeResult>;
    const flags = Array.isArray(d.flags) ? d.flags.filter((f): f is IntakeResult['flags'][number] =>
      ['spam', 'abuse', 'personal_info', 'not_311', 'emergency'].includes(String(f))).slice(0, 5) : [];
    return {
      polishedDescription: typeof d.polishedDescription === 'string' && d.polishedDescription.trim() ? d.polishedDescription.trim().slice(0, 600) : null,
      flags,
      note: typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 200) : null,
      model: typeof d.model === 'string' ? d.model : undefined,
    };
  } catch { return null; } finally { t.done(); }
}

export async function getReport(id: string): Promise<ReportView> {
  const t = withTimeout(15_000);
  try {
    const resp = await apiFetch(`/api/reports/${encodeURIComponent(id)}`, { signal: t.signal, headers: await authHeaders() });
    if (!resp.ok) throw await parseError(resp);
    return (await resp.json()) as ReportView;
  } finally { t.done(); }
}

/** Attach a reporter email after submit (confirmation screen). 204 on success. */
export async function attachEmail(id: string, email: string, turnstileToken?: string | null): Promise<void> {
  const t = withTimeout(15_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (turnstileToken) headers['X-Turnstile-Token'] = turnstileToken;
    const resp = await apiFetch(`/api/reports/${encodeURIComponent(id)}/email`, { method: 'POST', headers, signal: t.signal, body: JSON.stringify({ email }) });
    if (!resp.ok) throw await parseError(resp);
  } finally { t.done(); }
}

/** Follow someone else's report (dedupe path): same city-status emails as the reporter. 204. */
export async function followReport(id: string, email: string): Promise<void> {
  const t = withTimeout(15_000);
  try {
    const resp = await apiFetch(`/api/reports/${encodeURIComponent(id)}/follow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: t.signal, body: JSON.stringify({ email }) });
    if (!resp.ok) throw await parseError(resp);
  } finally { t.done(); }
}

export async function getFeed(bbox: [number, number, number, number], limit = 100): Promise<FeedResponse> {
  const t = withTimeout(15_000);
  try {
    const resp = await apiFetch(`/api/public-feed?bbox=${bbox.join(',')}&limit=${limit}`, { signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    return (await resp.json()) as FeedResponse;
  } finally { t.done(); }
}

/** Dedupe check: reports (ours + city) within radiusM of a point, last 14 days, nearest-first. Never throws. */
export async function getNearby(lat: number, lng: number, category?: string | null, radiusM = 75): Promise<NearbyResponse> {
  const t = withTimeout(8_000);
  try {
    const q = new URLSearchParams({ lat: String(lat), lng: String(lng), radiusM: String(radiusM) });
    if (category) q.set('category', category);
    const resp = await apiFetch(`/api/nearby?${q}`, { signal: t.signal });
    if (!resp.ok) return { items: [] };
    return (await resp.json()) as NearbyResponse;
  } catch { return { items: [] }; } finally { t.done(); }
}
