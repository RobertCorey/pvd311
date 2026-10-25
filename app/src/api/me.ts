// Account endpoints (/api/me/*) — see docs/api.md "Accounts". All calls need a session (authHeaders()).
import { apiFetch, parseError, withTimeout } from './client';
import type { Quota, ReportView } from './types';
import { authHeaders } from '../lib/auth';

export interface SavedAddress { id: string; label: string; address: string; lat: number | null; lng: number | null }
export interface Me {
  uid: string; email: string | null; emailVerified: boolean; displayName: string | null; provider: string;
  prefs: { emailUpdates: boolean; streetDigest?: boolean }; addresses: SavedAddress[]; following: string[]; createdAt: string;
  /** True for an allow-listed Google-verified email (docs/api.md Admin). */
  admin?: boolean;
  /** Reporter quota (docs/quota.md); absent from an older Worker. */
  quota?: Quota;
}
/** ReportView plus the signed-in extras the Worker adds. */
export interface MyReportView extends ReportView { mine?: boolean; following?: boolean; editable?: boolean; description?: string | null; owned?: boolean }

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const t = withTimeout(timeoutMs);
  try {
    const headers: Record<string, string> = { ...(await authHeaders()), ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
    const resp = await apiFetch(path, { ...init, headers, signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    return (resp.status === 204 ? undefined : await resp.json()) as T;
  } finally { t.done(); }
}

export const getMe = () => call<Me>('/api/me');
export const updateMe = (patch: { displayName?: string | null; prefs?: { emailUpdates?: boolean; streetDigest?: boolean } }) => call<Me>('/api/me', { method: 'PATCH', body: JSON.stringify(patch) });
export const myReports = () => call<{ items: MyReportView[] }>('/api/me/reports');
export const followingReports = () => call<{ items: MyReportView[] }>('/api/me/following');
export const follow = (id: string) => call<void>(`/api/me/following/${encodeURIComponent(id)}`, { method: 'PUT' });
export const unfollow = (id: string) => call<void>(`/api/me/following/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const saveAddress = (a: Partial<SavedAddress> & { address: string }) => call<{ addresses: SavedAddress[] }>('/api/me/addresses', { method: 'PUT', body: JSON.stringify(a) });
export const deleteAddress = (id: string) => call<{ addresses: SavedAddress[] }>(`/api/me/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
/** Owner-only, while the report is still pending. */
export const editDescription = (id: string, description: string) => call<{ ok: true; description: string | null }>(`/api/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ description }) });
export const cancelReport = (id: string) => call<{ ok: true; status: 'rejected' }>(`/api/reports/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
/** Owner-only: answer the city's request for more information; the Worker mails it to the city (docs/api.md). */
export const answerCity = (id: string, text: string, askId?: string) =>
  call<{ ok: true; answer: { at: string; via: 'app'; status: 'sent'; text: string } }>(`/api/reports/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ text, ...(askId ? { askId } : {}) }) });
