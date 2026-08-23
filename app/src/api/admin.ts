// Admin endpoints (/api/admin/*) — docs/api.md "Admin". Caller must be signed in with Google as an allow-listed email.
import { apiFetch, parseError, withTimeout } from './client';
import { authHeaders } from '../lib/auth';

export interface AdminReport {
  id: string; status: string; statusDetail: string | null; category: string; categoryLabel: string;
  address: string; lat: number | null; lng: number | null; description: string | null; descriptionOriginal: string | null;
  extra: Record<string, string> | null; intakeFlags: string[]; moderatedAt: string | null;
  photoUrl: string | null; createdAt: string | null; statusUpdatedAt: string | null;
  reporterEmail: string | null; ownerUid: string | null; portalCaseId: string | null; portalStatus: string | null;
  retries: number; retryAfter: string | null; review: { decision?: string; by?: string; decidedAt?: string; requestedAt?: string } | null; approvedAt: string | null;
}
export interface AdminEngine { paused: boolean; consecutiveFailures: number; submissionsThisHour: number; lastSubmissionTime: string | null; hitlMode: string; accountTrustN: string }
export interface AdminOverview { engine: AdminEngine; awaitingReview: AdminReport[]; failed: AdminReport[]; pending: AdminReport[]; submitted7d: AdminReport[] }
export type AdminAction = 'approve' | 'reject' | 'requeue';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = withTimeout(20_000);
  try {
    const resp = await apiFetch(path, { ...init, headers: { ...(await authHeaders()), ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    return (await resp.json()) as T;
  } finally { t.done(); }
}

export const adminOverview = () => call<AdminOverview>('/api/admin/overview');
export const adminAct = (id: string, action: AdminAction) => call<AdminReport>(`/api/admin/reports/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
export const adminEngine = (op: 'pause' | 'resume') => call<{ ok: boolean; paused: boolean }>(`/api/admin/engine/${op}`, { method: 'POST', body: '{}' });
