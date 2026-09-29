/**
 * Shared types for FixMyPVD — used by the PWA (app/) and the Worker (worker/).
 */

export { CATEGORIES, isCategory, resolveField, type Category, type CategoryConfig, type FieldSource } from './categories.js';
import type { Category } from './categories.js';

export type ReportStatus =
  | 'pending'        // Created by PWA, waiting for automation
  | 'awaiting_review' // Parked for human approval (HITL mode)
  | 'processing'     // Automation has picked it up
  | 'submitted'      // Successfully submitted to 311 portal
  | 'failed'         // Automation failed (see statusDetail)
  | 'rejected'       // Manually rejected (spam, duplicate, etc.)
  | 'auto-rejected'; // Auto-mode rejected (failed verification gate)

export interface Report {
  /** Firestore document ID (not stored in doc, used as reference) */
  id?: string;

  /** Server timestamp of creation */
  timestamp: FirebaseFirestore.Timestamp | null;

  /** Issue category */
  category: Category;

  /** Human-readable address string */
  address: string;

  /** GPS latitude (may be null if manually entered) */
  lat: number | null;

  /** GPS longitude (may be null if manually entered) */
  lng: number | null;

  /** Optional description from the reporter */
  description: string | null;

  /** Photo URL (Cloud Storage download URL, or legacy base64 data URL) */
  photo: string | null;

  /** AI intake (M6): the reporter-approved description is `description`; the original is kept if it changed; flags feed review gates */
  descriptionOriginal?: string | null;
  intakeFlags?: ('spam' | 'abuse' | 'personal_info' | 'not_311' | 'emergency')[] | null;

  /** Per-category answers from the PWA (e.g. { size: 'Medium (~28in)' }) */
  extra?: Record<string, string> | null;

  /** Portal draft bookkeeping so retries resume the same draft instead of orphaning a new one */
  portalDraft?: { url: string; entityId: string | null; step: 2 | 3; savedAt: string; caseId?: string | null } | null; // caseId: the PVD number the portal assigns at draft creation (input#title)
  /** PVD number read from the draft before Submit; used to confirm/reconcile when the post-submit read fails */
  portalCaseIdCandidate?: string | null;

  /** Automatic retry bookkeeping */
  retries?: number;
  retryAfter?: string | null;

  /** Last status seen on the city portal for this case (set by the status watcher) */
  portalStatus?: string | null;
  portalStatusUpdatedAt?: FirebaseFirestore.Timestamp | null;
  portalLastActivity?: { subject: string; createdOn: string | null; fetchedAt: string } | null;
  /** City emails about this case relayed to the reporter (relay.ts); newest last, capped at 20 */
  cityMessages?: { at: string; from: string; subject: string; text: string; caseId: string | null }[] | null;
  lastCityEmailAt?: string | null;

  /** Set when a human (or the trust ramp) approved this report for submission */
  approvedAt?: string | null;
  /** ISO when the Worker ran its own moderation pass (server-side; independent of client intake) */
  moderatedAt?: string | null;
  /** true when the portal accepted the submission but we could not read the PVD case number yet (watcher reconciles by GUID) */
  caseIdPending?: boolean | null;

  /** HITL bookkeeping */
  review?: { requestedAt: string; telegramMessageId: number | null; emailed?: boolean; mode: string; decision?: 'approved' | 'rejected'; by?: string; decidedAt?: string; reason?: string } | null;

  /** Account (Firebase Auth uid, Worker-verified) that filed this report. Accounts are mandatory. */
  ownerUid?: string | null;

  /** Accounts following this report (signed-in follow); they get city-status mail. */
  followerUids?: string[] | null;

  /** Set when the reporter cancelled a still-pending report from the app (status becomes 'rejected'). */
  cancelledByReporter?: boolean | null;

  /** Optional reporter name */
  reporterName: string | null;

  /** Optional reporter email */
  reporterEmail: string | null;

  /** Processing status for the automation pipeline */
  status: ReportStatus;

  /** Human-readable detail about status (e.g. error message, case ID) */
  statusDetail: string | null;

  /** PVD 311 case ID if successfully submitted (e.g. "PVD2026-72841") */
  portalCaseId: string | null;

  /** Timestamp of last status update by automation */
  statusUpdatedAt: FirebaseFirestore.Timestamp | null;
}

