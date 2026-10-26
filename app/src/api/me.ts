// Account endpoints (/api/me/*) — see docs/api.md "Accounts". All calls need a session (authHeaders()).
import { apiFetch, parseError, withTimeout } from './client';
import type { Quota, ReportView } from './types';
import { authHeaders } from '../lib/auth';

export interface SavedAddress { id: string; label: string; address: string; lat: number | null; lng: number | null }
export interface Me {
  uid: string; email: string | null; emailVerified: boolean; displayName: string | null; provider: string;
  /** `streetWatch`: push-only "tell me right away" for new city cases within 300 m of a saved address (no email; the
   *  Worker pushes nothing to an account without subscriptions, so the app only lets it on while push is on). */
  prefs: { emailUpdates: boolean; streetDigest?: boolean; weekDigest?: boolean; streetWatch?: boolean }; addresses: SavedAddress[]; following: string[]; createdAt: string;
  /** City case GUIDs this account follows (cityCases, newest first, ≤ 100). Read it with `?? []`: an older Worker omits it. */
  cityFollowing: string[];
  /** True for an allow-listed Google-verified email (docs/api.md Admin). */
  admin?: boolean;
  /** Reporter quota (docs/quota.md); absent from an older Worker. */
  quota?: Quota;
  /** Web push subscriptions on this account (users.push[], ≤ 5): the endpoints only, so the app can tell whether
   *  this browser's own PushSubscription is registered. Absent from an older Worker. */
  push?: { endpoints: string[] };
}
/** ReportView plus the signed-in extras the Worker adds. */
export interface MyReportView extends ReportView { mine?: boolean; following?: boolean; editable?: boolean; description?: string | null; owned?: boolean }
/** One followed city case as GET /api/me/city returns it: the case's current state plus when it was followed.
 *  `open` = status ∉ {Resolved, Closed, Cancelled, Merged}; `closedAt` = the city's resolutionDate, else the watched
 *  close; `resolution` = the city's own Resolution Message; `updatedAt` = statusAt. lat/lng null when unplaced. */
export interface FollowedCase {
  id: string; caseType: string; category: string; street: string; status: string; open: boolean;
  createdAt: string | null; closedAt: string | null; resolution: string | null; lat: number | null; lng: number | null;
  followedAt: string | null; updatedAt: string | null;
}

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
/** The Worker's VAPID public key (base64url, 65 raw P-256 bytes; minted on first call). Public, cached an hour. */
export async function getPushKey(): Promise<{ publicKey: string }> {
  const t = withTimeout(10_000);
  try {
    const resp = await apiFetch('/api/push/key', { signal: t.signal });
    if (!resp.ok) throw await parseError(resp);
    const d = (await resp.json()) as { publicKey?: unknown };
    if (typeof d.publicKey !== 'string' || !d.publicKey) throw new Error('bad_push_key');
    return { publicKey: d.publicKey };
  } finally { t.done(); }
}
/** One browser's PushSubscription as POST /api/me/push stores it (upsert by endpoint). */
export interface PushRegistration { endpoint: string; keys: { p256dh: string; auth: string }; ua?: string }
/** Register this browser for push (204). Having a subscription on the account = opted in; no separate pref. */
export const registerPush = (sub: PushRegistration) => call<void>('/api/me/push', { method: 'POST', body: JSON.stringify(sub) });
/** Forget one subscription by endpoint (204, idempotent). */
export const unregisterPush = (endpoint: string) => call<void>('/api/me/push', { method: 'DELETE', body: JSON.stringify({ endpoint }) });
export const updateMe = (patch: { displayName?: string | null; prefs?: { emailUpdates?: boolean; streetDigest?: boolean; weekDigest?: boolean; streetWatch?: boolean } }) => call<Me>('/api/me', { method: 'PATCH', body: JSON.stringify(patch) });
export const myReports = () => call<{ items: MyReportView[] }>('/api/me/reports');
export const followingReports = () => call<{ items: MyReportView[] }>('/api/me/following');
export const follow = (id: string) => call<void>(`/api/me/following/${encodeURIComponent(id)}`, { method: 'PUT' });
export const unfollow = (id: string) => call<void>(`/api/me/following/${encodeURIComponent(id)}`, { method: 'DELETE' });
/** Follow / unfollow one of the city's public cases (cityCases/{guid}); both idempotent, 204. The Worker mails the
 *  account once per status change (kind city_follow) while followed. */
export const followCity = (guid: string) => call<void>(`/api/me/city/${encodeURIComponent(guid)}`, { method: 'PUT' });
export const unfollowCity = (guid: string) => call<void>(`/api/me/city/${encodeURIComponent(guid)}`, { method: 'DELETE' });
/** The followed city cases with their current status, in cityFollowing order (vanished cases skipped). */
export const followedCases = () => call<{ items: FollowedCase[] }>('/api/me/city');
export const saveAddress = (a: Partial<SavedAddress> & { address: string }) => call<{ addresses: SavedAddress[] }>('/api/me/addresses', { method: 'PUT', body: JSON.stringify(a) });
export const deleteAddress = (id: string) => call<{ addresses: SavedAddress[] }>(`/api/me/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
/** Owner-only, while the report is still pending. */
export const editDescription = (id: string, description: string) => call<{ ok: true; description: string | null }>(`/api/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ description }) });
export const cancelReport = (id: string) => call<{ ok: true; status: 'rejected' }>(`/api/reports/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
/** Owner-only: answer the city's request for more information; the Worker mails it to the city (docs/api.md). */
export const answerCity = (id: string, text: string, askId?: string) =>
  call<{ ok: true; answer: { at: string; via: 'app'; status: 'sent'; text: string } }>(`/api/reports/${encodeURIComponent(id)}/answer`, { method: 'POST', body: JSON.stringify({ text, ...(askId ? { askId } : {}) }) });
