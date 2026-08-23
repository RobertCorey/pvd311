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

// ── System view (/api/admin/health) ──
export type Light = 'ok' | 'warn' | 'error' | 'unknown';
export interface Subsystem { key: string; label: string; what: string; status: Light; lastOkAt: string | null; lastErrorAt: string | null; lastError: string | null; lastDetail: string | null; okToday: number; errToday: number; expectedEvery: string | null }
export interface AdminEvent { id: string; at: string; level: 'info' | 'warn' | 'error'; kind: string; msg: string; reportId: string | null; data: Record<string, unknown> | null }
// DB ↔ city-portal agreement. reconcile = the nightly job that matches our DB against the portal (null before it first runs).
export interface AdminReconcile { at: string | null; scanned: number; adopted: number; stranded: number; missing: number; error: string | null }
export interface AdminSync { status: 'ok' | 'warn' | 'error'; caseIdPending: number; caseIdPendingOldestAt: string | null; reconcile: AdminReconcile | null }
// Portal form-drift canary. The daily 7 am resume walk diffs the city's Step-3 controls against a golden per category.
// goldenSource 'sim'|null = no live baseline yet (first live dump mints it); drifted = the city changed the form.
export interface AdminCanaryCategory { category: string; goldenSource: 'live' | 'sim' | null; goldenAt: string | null; lastLiveAt: string | null; drifted: boolean }
export interface AdminCanary { enabled: boolean; categories: AdminCanaryCategory[] }
export interface AdminHealth {
  generatedAt: string; overall: 'ok' | 'warn' | 'error';
  engine: AdminEngine & { locked: boolean; reporterEmailEnabled: boolean };
  subsystems: Subsystem[];
  counts: Record<string, number>; users: number; ai: { intakeToday: number; dailyCap: number }; cityFeed: { fetchedAt: string | null; items: number };
  sync: AdminSync;
  canary?: AdminCanary;
  events: AdminEvent[];
}
export const adminHealth = (events = 100) => call<AdminHealth>(`/api/admin/health?events=${events}`);
