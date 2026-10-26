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
export const adminAct = (id: string, action: AdminAction, body: { reason?: string } = {}) => call<AdminReport>(`/api/admin/reports/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
export interface AdminProof { name: string; createdAt: string | null; contentType: string }
export const adminProofs = (id: string) => call<AdminProof[]>(`/api/admin/reports/${encodeURIComponent(id)}/proofs`);
/** Proof images need the bearer, so <img src> can't load them directly: fetch → object URL (caller revokes). */
export async function adminProofBlobUrl(id: string, name: string): Promise<string> {
  const resp = await apiFetch(`/api/admin/reports/${encodeURIComponent(id)}/proofs/${encodeURIComponent(name)}`, { headers: await authHeaders() });
  if (!resp.ok) throw await parseError(resp);
  return URL.createObjectURL(await resp.blob());
}
export interface AdminUser { uid: string; email: string | null; provider: string; trusted: boolean; submitted: number; rejected: number; createdAt: string | null }
export const adminUser = (uid: string) => call<AdminUser>(`/api/admin/users/${encodeURIComponent(uid)}`);
export const adminTrust = (uid: string, trusted: boolean) => call<AdminUser>(`/api/admin/users/${encodeURIComponent(uid)}/trust`, { method: 'POST', body: JSON.stringify({ trusted }) });
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
  engine: AdminEngine & { locked: boolean };
  subsystems: Subsystem[];
  counts: Record<string, number>; users: number; ai: { intakeToday: number; dailyCap: number }; cityFeed: { fetchedAt: string | null; items: number };
  sync: AdminSync;
  canary?: AdminCanary;
  events: AdminEvent[];
}
export const adminHealth = (events = 100) => call<AdminHealth>(`/api/admin/health?events=${events}`);

// ── Learn/monitor endpoints (9-tab admin) ──
export interface Paged<T> { items: T[]; next: string | null }
export interface AdminReportsQuery { status?: string; category?: string; q?: string; before?: string | null; limit?: number }
export const adminReports = (p: AdminReportsQuery = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v != null && v !== '') q.set(k, String(v));
  return call<Paged<AdminReport>>(`/api/admin/reports?${q}`);
};
export interface AdminCityCase {
  id: string; caseType: string; category: string; street: string; status: string; createdAt: string | null; firstSeenAt?: string; detailAt?: string;
  statusSeen?: Record<string, string>;
  detail?: { status: string | null; address: string | null; receivedOn: string | null; routedOn: string | null; workCompletedOn: string | null;
    resolutionDate: string | null; resolution: string | null; answers: Record<string, string | true>; labels?: Record<string, string> };
}
export const adminCityCases = (p: AdminReportsQuery = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v != null && v !== '') q.set(k, String(v));
  return call<Paged<AdminCityCase> & { syncedAt: string | null; tracked: number }>(`/api/admin/city-cases?${q}`);
};
export type CityOutcome = 'work_done' | 'enforcement' | 'referred' | 'logged_elsewhere' | 'info_only' | 'no_action' | 'cancelled' | 'open';
export interface CityStats { n: number; routed: number; medRouteHours: number | null; closed: number; medCloseDays: number | null; closeSample: number; openOver7d: number; outcomes: Record<CityOutcome, number> }
export interface CityInsights {
  at: string; days: number; since: string; trackedSince: string | null; total: CityStats;
  groups: (CityStats & { group: string; types: (CityStats & { caseType: string; examples: { text: string; n: number }[] })[] })[];
}
export const adminCityInsights = (days: number) => call<CityInsights>(`/api/admin/city-cases/insights?days=${days}`);
export interface AdminAccount {
  uid: string; email: string | null; displayName: string | null; provider: string; emailVerified: boolean;
  createdAt: string | null; lastSeenAt: string | null; trusted: boolean; emailUpdates: boolean; following: number; addresses: number;
  submitted: number; rejected: number; awaitingReview: number; autoFiles: boolean;
}
export const adminUsers = (before?: string | null, limit = 50) => call<Paged<AdminAccount>>(`/api/admin/users?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
export interface AdminEventsQuery { level?: string; kind?: string; reportId?: string; before?: string | null; limit?: number }
export const adminEvents = (p: AdminEventsQuery = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v != null && v !== '') q.set(k, String(v));
  return call<Paged<AdminEvent>>(`/api/admin/events?${q}`);
};
export interface AdminCategory {
  key: string; label: string; portalCaseTypeName: string | null; portalCaseTypeGuid: string | null; portalSearchTerm: string | null; requestType: string | null;
  photoRequired: boolean; seasonal: string | null; fields: Record<string, unknown> | null;
  golden: { source: 'live' | 'sim' | null; at: string | null; lastLiveAt: string | null; drifted: boolean } | null;
  counts: { submitted: number; rejected: number };
}
export const adminCategories = () => call<{ items: AdminCategory[] }>('/api/admin/categories');
export interface AdminConfigItem { key: string; value: string | number | boolean | null; what: string }
export const adminConfig = () => call<{ items: AdminConfigItem[] }>('/api/admin/config');
export interface ExplainSection { key: string; title: string; summary: string; details: string[]; live?: Record<string, string | number | boolean | null>; links?: { label: string; href: string }[] }
export const adminExplain = () => call<{ sections: ExplainSection[] }>('/api/admin/explain');

/** GET /api/admin/usage — first-party analytics (Worker ui.ts → Analytics Engine). */
export interface AdminUsage {
  configured: boolean; days: number;
  totals: { visitors: number; sessions: number; pageViews: number };
  funnel: { event: string; visitors: number; count: number }[];
  daily: { day: string; visitors: number; reports: number }[];
  pages: { path: string; views: number }[];
  sources: { source: string; visitors: number }[];
  countries: { country: string; visitors: number }[];
  devices: { device: string; visitors: number }[];
  categories: { category: string; visitors: number }[];
}
export const adminUsage = (days: number) => call<AdminUsage>(`/api/admin/usage?days=${days}`);

/** GET /api/admin/city-questions — docs/city-questions.md phase 1 (read-only). Mirrors worker/src/cityquestions.ts buildAdminView. */
export type CityQuestionFlagKind = 'new_question' | 'gone' | 'options_changed' | 'app_option_stale';
export interface AdminCityQuestionFlag { kind: CityQuestionFlagKind; questionId: string; label: string; added?: string[]; removed?: string[]; firstAt: string; lastAt: string }
export interface AdminCityQuestion {
  id: string; cityLabel: string; cityOptions: string[]; type: 'select' | 'radio' | 'checkbox' | 'text' | 'textarea' | 'toggle';
  inSeed: boolean; lastSeenLive: string | null; counts: { app: number; ai: number; blank: number };
  mode: 'app' | 'ai'; appOptions: string[] | null; seedLabel: string | null; seedOptions: string[] | null;
}
export interface AdminCityQuestionsItem {
  category: string; label: string; demand: number; caseTypeName: string; caseTypeGuid: string; note: string | null;
  questions: AdminCityQuestion[]; flags: AdminCityQuestionFlag[]; lastFiledAt: string | null; filings: number; blanks: number; score: number;
}
export interface AdminCityQuestions { generatedAt: string; seed: { generatedAt: string; dump: string; notes: string[] }; items: AdminCityQuestionsItem[] }
export const adminCityQuestions = () => call<AdminCityQuestions>('/api/admin/city-questions');

// ── Email log (worker/src/emaillog.ts) ─────────────────────────────────────────────
export type EmailKind =
  | 'signin_link' | 'filed' | 'status' | 'city_copy' | 'ask' | 'ask_reminder' | 'answer_receipt' | 'not_sent' | 'street_digest' | 'city_follow' | 'week_digest' | 'reporter_other'
  | 'to_city' | 'admin_review' | 'admin_alert' | 'admin_digest' | 'city_in' | 'reply_in' | 'unmatched_in' | 'dropped_in';
/** List row: everything but the body (a preview instead). `lastEvent` = Resend delivery state (delivered / bounced …). */
export interface AdminEmailRow {
  id: string; at: string; dir: 'in' | 'out'; kind: EmailKind; from: string; to: string[]; subject: string;
  status: 'sent' | 'failed' | 'skipped' | 'received' | 'dropped'; error: string | null; lastEvent: string | null;
  reportId: string | null; caseId: string | null; cityKind: string | null; outcome: string | null; source: 'live' | 'import'; preview: string; hasText: boolean;
}
export interface AdminEmail extends AdminEmailRow {
  text: string | null; replyTo: string | null; messageId: string | null; resendId: string | null; lastEventAt: string | null;
  report: { id: string; categoryLabel: string; address: string; status: string; portalCaseId: string | null; portalStatus: string | null } | null;
  accounts: { uid: string; email: string | null }[];
}
export interface AdminEmailsQuery { dir?: string; kind?: string; q?: string; reportId?: string; uid?: string; before?: string | null; limit?: number }
export const adminEmails = (p: AdminEmailsQuery = {}) => {
  const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  return call<Paged<AdminEmailRow>>(`/api/admin/emails${qs.toString() ? `?${qs}` : ''}`);
};
export const adminEmail = (id: string) => call<AdminEmail>(`/api/admin/emails/${encodeURIComponent(id)}`);
export const adminEmailSync = () => call<{ scanned: number; imported: number; updated: number; unreadable?: boolean; cityImported: number }>('/api/admin/emails/sync', { method: 'POST', body: '{}' });

/** One person: account + their reports + their email (GET /api/admin/users/:uid/profile). */
export interface AdminProfile {
  user: Omit<AdminAccount, 'following' | 'awaitingReview'> & { following: string[] };
  reports: AdminReport[];
  emails: AdminEmailRow[];
}
export const adminProfile = (uid: string) => call<AdminProfile>(`/api/admin/users/${encodeURIComponent(uid)}/profile`);

// ── Engagement (GET /api/admin/engagement) ─────────────────────────────────────────
/** One digest or follow mail from the email log, body-less: `to` comes masked from the Worker. */
export interface AdminEngagementMail { id: string; at: string; kind: EmailKind; to: string; subject: string; status: AdminEmailRow['status'] }
/** meta/weekDigest (total + adminMailed) and meta/streetDigest, as the Monday runs leave them. */
export interface AdminDigestRun { at: string; users: number; mailed: number; pushed: number; total?: number; adminMailed?: boolean }
/**
 * Who opted into what, counted in memory from one scan of the users collection (≤ 500 — `scanned` says how many,
 * `truncated` that the scan hit the cap, so the counts are floors), plus the last Monday runs and the recent digest /
 * street-watch / push events and mails. Cached 60 s per Worker isolate.
 */
export interface AdminEngagement {
  at: string;
  accounts: {
    total: number; withPush: number; pushDevices: number; follows: { accounts: number; cases: number };
    streetDigest: number; weekDigest: number; streetWatch: number; watchGroupsSet: number;
    scanned: number; truncated: boolean;
    /** The three opt-ins from the equality queries the Monday jobs read (`prefs.X == true`, ≤ 500) — a cross-check
     *  that does not depend on the scan window; null when any of the queries failed. */
    queried?: { streetDigest: number; weekDigest: number; streetWatch: number } | null;
  };
  overnightHeld: number;
  vapidSince: string | null;
  lastWeekDigest: AdminDigestRun | null;
  lastStreetDigest: AdminDigestRun | null;
  recent: { events: AdminEvent[]; mails: AdminEngagementMail[] };
}
export const adminEngagement = () => call<AdminEngagement>('/api/admin/engagement');
