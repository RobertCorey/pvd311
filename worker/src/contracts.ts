/**
 * Shared contracts for the Worker port. Each module implements one of these; index.ts wires them.
 * Runtime: Cloudflare Workers (nodejs_compat) + Browser Run. No KV/R2 — state lives in Firestore/Storage.
 */
import type { Report, ReportStatus } from '../../shared/types.js';
import type { PortalControl } from './scout.js';

export interface Env {
  BROWSER: Fetcher;
  PORTAL_BASE_URL: string;            // var
  APP_NAME: string;                   // var: "FixMyPVD" — the description tag on every filed case
  HITL_MODE: 'review' | 'ramp' | 'auto'; // var
  FIREBASE_PROJECT_ID: string;        // var: pvd-snow-report
  NOTIFY_EMAIL: string;               // var
  NOTIFY_FROM: string;                // var
  // secrets
  PORTAL_EMAIL: string;
  PORTAL_PASSWORD: string;
  CANARY_TOKEN: string;
  FIREBASE_SERVICE_ACCOUNT: string;   // the service-account JSON, as a string
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY: string;
  HITL_SECRET: string;
  TURNSTILE_SECRET: string;
  APP_ORIGINS?: string;               // var: comma-separated allowed CORS origins (optional)
  ALLOW_NO_TURNSTILE?: string;        // var: '1' opens report creation without Turnstile (tests/dev ONLY; prod fails closed)
  APP_BASE_URL?: string;              // var: public app origin for tracking links (default https://fixmypvd.org)
  ACCOUNT_TRUST_N?: string;           // var: per-account HITL ramp threshold (default 3)
  ADMIN_EMAILS?: string;              // var: comma-separated admin emails for /api/admin/* + in-app /admin (Google sign-in required)
  AUTH_FROM?: string;                 // var: From for sign-in link emails (Resend)
  RECONCILE_ENABLED?: string;         // var: '1'|'true' enables the watcher's reconcile pass (adopt/stranded/missing); default off
  DRIFT_CANARY_ENABLED?: string;      // var: '1'|'true' arms the golden-controls Step-3 drift canary in runDaily; default off
  RELAY_ADDRESS?: string;             // var: the portal account's contact address, routed to email() (relay.ts); default cases@fixmypvd.org
  CITY_SENDER_DOMAINS?: string;       // var: comma-separated sender domains treated as the city (default providenceri.gov)
  RELAY_FALLBACK_TO?: string;         // var: verified Email Routing destination that receives the raw mail if relay handling throws
  PORTAL_NOTIFY_METHOD?: string;      // var: #cop_methodofupdate value — '585680002' Email (relay live) | '585680003' No Contact Necessary (default)
}

export type ReportDoc = Report & { id: string };

/** users/{uid} — account profile + preferences. Created lazily on first authenticated call. */
export interface SavedAddress { id: string; label: string; address: string; lat: number | null; lng: number | null }
export interface UserDoc {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  provider: string;
  createdAt: string;
  lastSeenAt: string;
  prefs: { emailUpdates: boolean };       // city-status emails for own + followed reports
  addresses: SavedAddress[];               // ≤ 10
  following: string[];                     // report ids (≤ 200)
  trusted?: boolean;                       // admin override for the per-account trust ramp
}
export type PortalDraft = NonNullable<Report['portalDraft']>;

/** firestore.ts — Firestore REST + Firebase Storage JSON API via service-account JWT. */
export interface Store {
  fetchPendingReports(): Promise<ReportDoc[]>;                 // status == 'pending', oldest first
  fetchReport(id: string): Promise<ReportDoc | null>;
  updateReportStatus(id: string, status: ReportStatus, detail?: string, portalCaseId?: string): Promise<void>; // sets statusUpdatedAt=now; clears portalDraft on 'submitted'
  patchReport(id: string, fields: Record<string, unknown>): Promise<void>; // shallow merge of arbitrary fields
  saveReportDraft(id: string, draft: PortalDraft): Promise<void>;
  requeueReport(id: string, retries: number, detail: string, retryAfterIso: string): Promise<void>;
  findStuckProcessing(minutes: number): Promise<ReportDoc[]>;
  findRecentSubmissions(hours: number): Promise<ReportDoc[]>;
  listSubmittedWithCaseId(): Promise<ReportDoc[]>;              // for the watcher
  countByStatus(status: ReportStatus): Promise<number>;
  findByStatus(status: ReportStatus, limit: number): Promise<ReportDoc[]>;
  findByClientId(clientId: string): Promise<ReportDoc | null>;   // idempotent create (outbox retries)
  findByPortalCaseId(caseId: string): Promise<ReportDoc | null>; // relay: city email → our report
  findByPortalCaseIdCandidate(caseId: string): Promise<ReportDoc | null>; // relay: a report still mid-submit (portalCaseIdCandidate / portalDraft.caseId), before portalCaseId is written
  getMeta<T>(docId: string): Promise<T | null>;                  // collection 'meta'
  setMeta(docId: string, data: Record<string, unknown>): Promise<void>; // merge
  findReportsSince(hoursAgo: number, limit: number): Promise<ReportDoc[]>;      // public feed: any status except rejected
  /** Photos live in Firestore (photos/{id}) while the project is on Spark — no server-side bucket writes without billing. */
  putPhoto(id: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getPhoto(id: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  deletePhoto(id: string): Promise<void>;
  findResolvedBefore(date: Date, limit: number): Promise<ReportDoc[]>; // portalStatus Resolved|Cancelled, portalStatusUpdatedAt <= date, photo still present
  // Accounts (users/{uid}) — see me.ts
  getUser(uid: string): Promise<UserDoc | null>;
  patchUser(uid: string, fields: Record<string, unknown>): Promise<void>;
  countUsers(): Promise<number>;
  /** Admin lists (newest first). `before` = ISO timestamp cursor. */
  listReports(opts: { status?: ReportStatus | null; category?: string | null; before?: string | null; limit: number }): Promise<ReportDoc[]>;
  listUsers(opts: { before?: string | null; limit: number }): Promise<UserDoc[]>;
  listEvents(opts: { level?: string | null; kind?: string | null; reportId?: string | null; before?: string | null; limit: number }): Promise<({ id: string; at: string; level: string; kind: string; msg: string; reportId?: string | null; data?: Record<string, unknown> | null })[]>;
  countResolved(): Promise<number>;                           // submitted AND portalStatus in the resolved set
  /** Atomic engine lock: succeeds only if no live lock exists; CAS on the meta doc's updateTime. */
  tryAcquireEngineLock(untilMs: number): Promise<boolean>;
  releaseEngineLock(): Promise<void>;
  /** Proof screenshots (JPEG) live in Firestore proofs/{reportId}_{name}; admin-only read. */
  putProof(reportId: string, name: string, bytes: Uint8Array, contentType: string): Promise<string>;
  listProofs(reportId: string): Promise<{ name: string; createdAt: string | null; contentType: string }[]>;
  getProof(reportId: string, name: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Submitted without a confirmed case id (watcher reconciles by entity GUID). */
  findSubmittedUnconfirmed(limit: number): Promise<ReportDoc[]>;
  // System visibility (health.ts)
  addEvent(ev: { at: string; level: string; kind: string; msg: string; reportId?: string | null; data?: Record<string, unknown> | null }): Promise<void>;
  recentEvents(limit: number): Promise<({ id: string; at: string; level: string; kind: string; msg: string; reportId?: string | null; data?: Record<string, unknown> | null })[]>;
  deleteEventsBefore(date: Date, limit: number): Promise<number>;
  findReportsByOwner(uid: string, limit: number): Promise<ReportDoc[]>;        // newest first
  fetchReports(ids: string[]): Promise<ReportDoc[]>;                           // batch get; missing ids skipped
  countOwnerByStatus(uid: string, status: ReportStatus): Promise<number>;
}

/** Portal auth state (Playwright storageState JSON) persisted in meta/portalAuth. */
export interface AuthStore {
  load(): Promise<Record<string, unknown> | null>;
  save(state: Record<string, unknown>): Promise<void>;
}

export type SubmitMode = 'live' | 'inspect';
export interface SubmitOptions {
  mode?: SubmitMode;
  onDraft?: (draft: PortalDraft) => Promise<void>;
  saveProof?: (name: string, bytes: Uint8Array) => Promise<string | void>;
}
export interface SubmitResult {
  mode: SubmitMode;
  caseId?: string;
  proofPath?: string;
  controls?: PortalControl[];
  scouted?: Record<string, string>;
  entityId?: string;          // the portal record GUID (== draft GUID); lets the watcher resolve a missing case id later
  caseIdConfirmed?: boolean;  // false → recorded as submitted-unconfirmed; watcher reconciles by GUID
  alreadyFiled?: boolean;     // check-before-create found the draft already converted; no wizard run
  caseIdCandidate?: string;   // PVD number read from the draft (input#title) before Submit
}

/** portal.ts — the wizard driver on @cloudflare/playwright. One instance per cron tick; always close(). */
export interface Portal {
  launch(): Promise<void>;
  close(): Promise<void>;
  ensureLoggedIn(force?: boolean): Promise<void>;
  submitReport(report: ReportDoc, opts?: SubmitOptions): Promise<SubmitResult>;
  /** Read-only checks (canary/watcher). Never clicks Next/Submit. */
  readMyRequests(opts?: { maxPages?: number }): Promise<{ caseId: string | null; entityId: string | null; status: string; street: string; createdOn: string }[]>;
  /** Like readMyRequests, plus whether the pager was exhausted (`complete: false` ⇒ truncated at the page cap). */
  readMyRequestsPaged(opts?: { maxPages?: number }): Promise<{ rows: { caseId: string | null; entityId: string | null; status: string; street: string; createdOn: string }[]; complete: boolean }>;
  findMyRequestByEntityId(entityId: string, maxPages?: number): Promise<{ caseId: string | null; entityId: string | null; status: string; street: string; createdOn: string } | null>;
  findMyRequestByCaseId(caseId: string, maxPages?: number): Promise<{ caseId: string | null; entityId: string | null; status: string; street: string; createdOn: string } | null>;
  canary(): Promise<{ ok: boolean; missing: string[]; notes: string[] }>;
  /** Every case type in the Step-1 lookup modal (all pages), read-only — the daily census. */
  listCaseTypes(): Promise<{ id: string; name: string }[]>;
  /** Account profile page (/profile/): dump its form controls, or set the contact email (the address the city notifies). */
  readProfile(): Promise<{ url: string; controls: { id: string; name: string; type: string; value: string; label: string; visible: boolean }[]; buttons: { id: string; text: string }[] }>;
  setProfile(fields: { email: string; firstname?: string; lastname?: string }): Promise<{ ok: boolean; before: string | null; after: string | null; notes: string[] }>;
  /** Click the profile page's "Confirm Email" action (the portal then emails the contact address a confirmation link). */
  confirmProfileEmail(): Promise<{ ok: boolean; notes: string[] }>;
  /** Drift canary (read-only): resume the designated existing record via Edit-Request and re-dump Step-3 controls WITHOUT submitting. Creates NO new draft; null if it can't resume to Step 3. */
  resumeAndDumpControls(entityId: string): Promise<PortalControl[] | null>;
  /** Read-only: open one case's detail modal from My Requests (grid search by PVD number → row → iframe) and dump its form fields + timeline. Null if the case is not in the grid. Never clicks Submit/Add comment. */
  readCaseDetail(caseId: string): Promise<CaseDetailRaw | null>;
}

/** What readCaseDetail scrapes; casedetail.ts turns it into Report.portalDetail. */
export interface CaseDetailRaw {
  fields: Record<string, { label: string; value: string; readonly: boolean }>;
  notes: { postedOn: string; modifiedOn: string | null; from: string; to: string | null; createdBy: string | null; text: string; attachments: string[] }[];
}

/** City statuses that end a case. Drives retention, "resolved" mail, and the admin terminal filter. */
export const TERMINAL_PORTAL_STATUS = /\b(resolved|closed|completed|cancel+ed|rejected|withdrawn)\b/i;

/** email.ts */
export interface Mailer {
  send(subject: string, html: string): Promise<string | null>;
  alert(subject: string, html: string): Promise<void>;   // never throws
  sendTo(to: string, subject: string, html: string, opts?: { replyTo?: string }): Promise<void>; // reporter-facing; gated; never throws
}
