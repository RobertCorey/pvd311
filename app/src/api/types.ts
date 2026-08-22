// Worker API v1 — contract from alice (2026-08-22). Keep in sync with worker/.
export type ReportStatus = 'received' | 'awaiting_review' | 'sending' | 'sent' | 'failed' | 'needs_attention' | 'rejected';
export type PortalStatus = 'Submitted' | 'Assigned' | 'Resolved' | 'Cancelled';
export type IntakeFlag = 'spam' | 'abuse' | 'personal_info' | 'not_311' | 'emergency';

export interface ReportSubmission {
  category: string;
  description: string;
  address: string;
  lat?: number | null;
  lng?: number | null;
  extra?: Record<string, string> | null;
  email?: string;
  name?: string;
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

export interface TimelineEntry { at: string | null; label: string; }

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
  timeline: TimelineEntry[];
  nextUpdateHint: string | null;
  hasEmail?: boolean;
  /** Present when the caller is signed in (see docs/api.md Accounts). */
  owned?: boolean; cancelledByReporter?: boolean; mine?: boolean; following?: boolean; editable?: boolean; description?: string | null;
}

export interface FeedItem {
  id: string; category: string; categoryLabel: string; lat: number; lng: number;
  address: string; createdAt: string | null; status: ReportStatus | 'city'; portalStatus: PortalStatus | string | null;
  /** 'snappvd' = ours (id is a tracking token); 'city' = the city's public feed (id = 'city:<hash>', approximate location) */
  source?: 'snappvd' | 'city';
}
export interface NearbyItem extends FeedItem { distanceM: number; }
export interface NearbyResponse { items: NearbyItem[]; }
export interface FeedResponse { items: FeedItem[]; }

export class ApiError extends Error {
  status: number; code: string; field?: string; retryAfterSec?: number;
  constructor(status: number, code: string, field?: string, retryAfterSec?: number) {
    super(code);
    this.status = status; this.code = code; this.field = field; this.retryAfterSec = retryAfterSec;
  }
}
