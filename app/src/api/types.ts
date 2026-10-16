// Worker API v1 — contract from alice (2026-08-22). Keep in sync with worker/.
export type ReportStatus = 'received' | 'awaiting_review' | 'sending' | 'sent' | 'failed' | 'needs_attention' | 'rejected';
/** The city's Status Reason values seen on the portal grid. In Progress and Merged showed up on real cases (Oct 2026). */
export type PortalStatus = 'Submitted' | 'Assigned' | 'In Progress' | 'Department Responded' | 'Resolved' | 'Cancelled' | 'Merged';
export type IntakeFlag = 'spam' | 'abuse' | 'personal_info' | 'not_311' | 'emergency';

export interface ReportSubmission {
  category: string;
  description: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
  extra?: Record<string, string> | null;
  turnstileToken: string;
  descriptionOriginal?: string;
  intakeFlags?: IntakeFlag[];
  photo?: Blob | null;
}

export interface ReportCreated {
  id: string;            // also the tracking token
  trackingUrl: string;   // "/r/{id}"
  category: string;
  createdAt: string;
}

export interface IntakeRequest {
  category: string | null;
  description: string;
  address: string;
  extra?: Record<string, string> | null;
  hasPhoto: boolean;
  appVersion: string;
}

export interface IntakeResult {
  polishedDescription: string | null;
  flags: IntakeFlag[];
  note: string | null;
  model?: string;
}

/** `kind` marks rows the app words itself (`label` is the server's English fallback):
 *  city_message = a city email (label carries its subject) · city_receipt = the city's receipt · city_routed = routed, `vars.dept`
 *  · city_ask = the city asked for more information · city_answer = the reporter's answer went to the city
 *  · work_order = the city's work order changed, `vars.number` / `vars.status` (the city's words).
 *  `text` = the city's (or the owner's) words, sent only to the report's owner on GET /api/reports/:id — never public, never in lists. */
export type TimelineKind = 'city_message' | 'city_receipt' | 'city_routed' | 'city_ask' | 'city_answer' | 'work_order';
export interface TimelineEntry { at: string | null; label: string; kind?: TimelineKind; text?: string; vars?: Record<string, string>; }

/** The city's work order on the case, verbatim (its status is the work order's, not the case's). */
export interface WorkOrder { number: string | null; status: string; completedAt: string | null }

/** The newest time the city asked the reporter for more information (docs/api.md). Public: that it asked + whether it was answered.
 *  Owner adds id/canAnswer/expiresAt, and on the single-report read the city's words + every answer attempt. */
export interface CityAskView {
  askedAt: string; open: boolean; answered: boolean; answeredAt: string | null;
  id?: string; canAnswer?: boolean; expiresAt?: string;
  text?: string; answers?: { at: string; via: 'app' | 'email'; status: 'sent' | 'blocked' | 'failed'; text: string }[];
}

export interface ReportView {
  id: string;
  category: string;
  categoryLabel: string;
  address: string;
  lat: number | null;
  lng: number | null;
  photoUrl: string | null;
  createdAt: string;
  status: ReportStatus;
  portalCaseId: string | null;
  portalStatus: PortalStatus | null;
  /** The city's own "Resolution Message" for the case, verbatim (public); null when the city left none. */
  resolutionMessage?: string | null;
  timeline: TimelineEntry[];
  /** The city's work order, when the case has one */
  workOrder?: WorkOrder | null;
  /** Where the city sent the case ("Department Assigned:"), verbatim */
  department?: string | null;
  cityAsk?: CityAskView | null;
  nextUpdateHint: string | null;
  /** Set whenever the report will not / did not reach the city (docs/api.md GET /api/reports/:id). */
  notFiled?: { code: string; text: string; duplicateOf?: string | null } | null;
  /** Present when the caller is signed in (see docs/api.md Accounts). */
  cancelledByReporter?: boolean; mine?: boolean; following?: boolean; editable?: boolean; description?: string | null;
}

export interface FeedItem {
  id: string; category: string; categoryLabel: string; lat: number; lng: number;
  address: string; createdAt: string | null; status: ReportStatus | 'city'; portalStatus: PortalStatus | string | null;
  /** 'ours' = a FixMyPVD report (id is a tracking token); 'city' = the city's public feed (id = 'city:<hash>', approximate location) */
  source?: 'ours' | 'city';
}
export interface NearbyItem extends FeedItem { distanceM: number; }
export interface NearbyResponse { items: NearbyItem[]; }
/** GET /api/stats — public counter for the home trust line. No resolved count (Rob, 2026-10-16). */
export interface Stats { filed: number }

/** Reporter quota (docs/quota.md) — server-computed; the app only displays it. Times are ISO UTC. */
export interface Quota {
  dayUsed: number; dayLimit: number; weekUsed: number; weekLimit: number;
  dayResetsAt: string; weekResetsAt: string; nextAllowedAt: string | null;
}
export type QuotaReason = 'gap' | 'day' | 'week' | 'ip';

export class ApiError extends Error {
  status: number; code: string; field?: string; retryAfterSec?: number;
  /** On 429 rate_limited from POST /api/report. */
  reason?: QuotaReason; quota?: Quota;
  constructor(status: number, code: string, field?: string, retryAfterSec?: number, extra: { reason?: QuotaReason; quota?: Quota } = {}) {
    super(code);
    this.status = status; this.code = code; this.field = field; this.retryAfterSec = retryAfterSec;
    this.reason = extra.reason; this.quota = extra.quota;
  }
}
