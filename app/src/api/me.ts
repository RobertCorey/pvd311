// Account endpoints (/api/me/*) — see docs/api.md "Accounts". All calls need a session (authHeaders()).
import { apiFetch } from './client';
import type { ReportView } from './types';
import { ApiError } from './types';
import { authHeaders } from '../lib/auth';

export interface SavedAddress { id: string; label: string; address: string; lat: number | null; lng: number | null }
export interface Me {
  uid: string; email: string | null; emailVerified: boolean; displayName: string | null; provider: string;
  prefs: { emailUpdates: boolean }; addresses: SavedAddress[]; following: string[]; createdAt: string;
}
/** ReportView plus the signed-in extras the Worker adds. */
export interface MyReportView extends ReportView { mine?: boolean; following?: boolean; editable?: boolean; description?: string | null; owned?: boolean }

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { ...(await authHeaders()), ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
    const resp = await apiFetch(path, { ...init, headers, signal: c.signal });
    if (!resp.ok) {
      let body: { error?: string; field?: string; retryAfterSec?: number } = {};
      try { body = await resp.json(); } catch { /* non-JSON */ }
      throw new ApiError(resp.status, body.error ?? `http_${resp.status}`, body.field, body.retryAfterSec);
    }
    return (resp.status === 204 ? undefined : await resp.json()) as T;
  } finally { clearTimeout(timer); }
}

export const getMe = () => call<Me>('/api/me');
export const updateMe = (patch: { displayName?: string | null; prefs?: { emailUpdates?: boolean } }) => call<Me>('/api/me', { method: 'PATCH', body: JSON.stringify(patch) });
export const myReports = () => call<{ items: MyReportView[] }>('/api/me/reports');
export const claimReports = (ids: string[]) => call<{ claimed: string[]; skipped: string[] }>('/api/me/claim', { method: 'POST', body: JSON.stringify({ ids }) });
export const recoverReports = () => call<{ claimed: string[] }>('/api/me/recover', { method: 'POST', body: '{}' });
export const followingReports = () => call<{ items: MyReportView[] }>('/api/me/following');
export const follow = (id: string) => call<void>(`/api/me/following/${encodeURIComponent(id)}`, { method: 'PUT' });
export const unfollow = (id: string) => call<void>(`/api/me/following/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const saveAddress = (a: Partial<SavedAddress> & { address: string }) => call<{ addresses: SavedAddress[] }>('/api/me/addresses', { method: 'PUT', body: JSON.stringify(a) });
export const deleteAddress = (id: string) => call<{ addresses: SavedAddress[] }>(`/api/me/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
/** Owner-only, while the report is still pending. */
export const editDescription = (id: string, description: string) => call<{ ok: true; description: string | null }>(`/api/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ description }) });
export const cancelReport = (id: string) => call<{ ok: true; status: 'rejected' }>(`/api/reports/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
