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

/** One entry of the portal case timeline (comments + the city's outbound emails). */
export interface PortalCaseNote {
  /** Absolute time when the portal exposes it (title attr), else the relative "a day ago" text */
  postedOn: string;
  modifiedOn: string | null;
  /** Sender / recipient as the timeline renders them ("PVD 311" → "RI Energy") */
  from: string;
  to: string | null;
  createdBy: string | null;
  text: string;
  attachments: string[];
}

export interface PortalCaseDetail {
  capturedAt: string;
  /** Content hash of fields + notes; equal ⇒ nothing changed since the last snapshot */
  hash: string;
  fields: Record<string, { label: string; value: string; readonly: boolean }>;
  /** Newest first, as the portal renders them; capped */
  notes: PortalCaseNote[];
  truncated?: boolean;
}

/** What a city email / portal note is, by the city's own templates (cityask.ts). */
export type CityMailKind = 'receipt' | 'routed' | 'ask' | 'update';

/** One answer the reporter gave to a city ask. `sent` = mailed to the city; `blocked` = moderation stopped it; `failed` = the send failed. */
export interface CityAskAnswer { at: string; via: 'app' | 'email'; text: string; status: 'sent' | 'blocked' | 'failed'; reason?: string | null; emailId?: string | null }

/** The city asked the reporter for more information (a city email or portal note). Answers go back to `from` as "RE: <subject>". */
export interface CityAsk {
  id: string;
  /** When the city asked (ISO) */
  at: string;
  source: 'email' | 'portal';
  /** The city's sender address; answers go here. Null for a portal-only ask (→ the default 311 address). */
  from: string | null;
  /** The city's subject, verbatim — carries the CRM token (PVD311:nnnnnnn) that threads a reply onto the case */
  subject: string;
  /** The city's words (image placeholders removed) */
  text: string;
  messageId?: string | null;
  /** Rules matched a city template, or the AI read a non-template staff email as a question to the resident */
  by: 'rule' | 'ai';
  /** When we emailed the reporter about it (null: not emailed — stale or the case was already closed) */
  notifiedAt: string | null;
  remindedAt?: string | null;
  answers?: CityAskAnswer[];
}

/** The city's work order (portal fields cop_workordernumber / cop_workorderstatus / cop_workcompletedon) when it changed. */
export interface WorkOrderSighting { number: string | null; status: string; completedAt: string | null; at: string }

export interface PortalRouting {
  dept: string;
  at: string | null;
  /** The city's internal ticket for that dispatch ("PVD311:0287190") */
  ticket: string | null;
}

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
  /** Every city status the watcher has seen, oldest first (capped at 20) — the Track timeline shows each one, not just the latest */
  portalStatusHistory?: { status: string; at: string }[] | null;
  portalLastActivity?: { subject: string; createdOn: string | null; fetchedAt: string } | null;
  /** Snapshot of the portal's case-detail modal (watcher: first sighting, on status change, daily while open). Raw by design — form fields + the comment/email timeline — because we don't yet know which parts matter. */
  portalDetail?: PortalCaseDetail | null;
  /** ISO of the last detail read attempt (changed or not) */
  portalDetailCheckedAt?: string | null;
  /** ISO of the watcher's first status read from the detail read's search row, for a case past My Requests' 12-row window
   *  (engine.ts applyOffGridStatuses, 2026-10-30). That first catch-up is the backlog and is silent; later moves mail as usual. */
  portalOffGridAt?: string | null;
  /** ISO of the last detail read whose grid search found no such case; cleared by the next read that finds it. Reconcile
   *  counts a case older than the grid's window as missing only while this is set. */
  portalSearchMissAt?: string | null;
  /** Departments the city dispatched this case to, derived from the timeline (PVD 311 → <dept> emails); oldest first */
  portalRouting?: PortalRouting[] | null;
  /** City emails about this case relayed to the reporter (relay.ts); newest last, capped at 20.
   *  kind/dept/by: cityask.classifyCityMail at arrival (older rows carry none — classified on read by the rules). */
  cityMessages?: { at: string; from: string; subject: string; text: string; caseId: string | null; kind?: CityMailKind; dept?: string | null; by?: 'rule' | 'ai'; messageId?: string | null }[] | null;
  /** Times the city asked the reporter for more information, and the answers we sent back (cityask.ts); oldest first */
  cityAsks?: CityAsk[] | null;
  /** The city's work order for this case as the watcher saw it change (casedetail.ts); oldest first */
  workOrderHistory?: WorkOrderSighting[] | null;
  lastCityEmailAt?: string | null;
  cityCaseId?: string | null;        // case number named by the city's own receipt email (relay) — confirms a submit we could not read back

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

  /** Reporter-quota buckets this report was counted in (worker/src/quota.ts); a reporter cancel refunds them. */
  quotaSlot?: { key: string; ipKey: string | null; day: string; week: string; refundedAt?: string } | null;

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

