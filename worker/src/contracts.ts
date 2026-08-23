/**
 * Shared contracts for the Worker port. Each module implements one of these; index.ts wires them.
 * Runtime: Cloudflare Workers (nodejs_compat) + Browser Run. No KV/R2 — state lives in Firestore/Storage.
 */
import type { Report, ReportStatus } from '../../shared/types.js';
import type { PortalControl } from './scout.js';

export interface Env {
  BROWSER: Fetcher;
  PORTAL_BASE_URL: string;            // var
  APP_NAME: string;                   // var, e.g. "PVD311 app"
  HITL_MODE: 'review' | 'ramp' | 'auto'; // var
  FIREBASE_PROJECT_ID: string;        // var: pvd-snow-report
  STORAGE_BUCKET: string;             // var: pvd-snow-report.firebasestorage.app
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
  REPORTER_EMAIL_ENABLED?: string;    // var: 'true' once the Resend sending domain is verified
  APP_BASE_URL?: string;              // var: public app origin for tracking links (default https://pvdsnow.org)
  ACCOUNT_TRUST_N?: string;           // var: per-account HITL ramp threshold (default 3)
  ADMIN_EMAILS?: string;              // var: comma-separated admin emails for /api/admin/* + in-app /admin (Google sign-in required)
  AUTH_FROM?: string;                 // var: From for sign-in link emails (Resend)
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
  countSubmittedByCategory(category: string, limit: number): Promise<number>;
  listSubmittedWithCaseId(): Promise<ReportDoc[]>;              // for the watcher
  countByStatus(status: ReportStatus): Promise<number>;
  findByStatus(status: ReportStatus, limit: number): Promise<ReportDoc[]>;
  findByClientId(clientId: string): Promise<ReportDoc | null>;   // idempotent create (outbox retries)
  getMeta<T>(docId: string): Promise<T | null>;                  // collection 'meta'
  setMeta(docId: string, data: Record<string, unknown>): Promise<void>; // merge
  /** Firebase Storage. Returns gs:// path, or a tokenized public download URL when opts.downloadToken is given. */
  uploadFile(path: string, bytes: Uint8Array, contentType: string, opts?: { downloadToken?: string }): Promise<string>;
  findReportsSince(hoursAgo: number, limit: number): Promise<ReportDoc[]>;      // public feed: any status except rejected
  /** Photos live in Firestore (photos/{id}) while the project is on Spark — no server-side bucket writes without billing. */
  putPhoto(id: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getPhoto(id: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  deletePhoto(id: string): Promise<void>;
  findResolvedBefore(date: Date, limit: number): Promise<ReportDoc[]>; // portalStatus Resolved|Cancelled, portalStatusUpdatedAt <= date, photo still present
  // Accounts (users/{uid}) — see me.ts
  getUser(uid: string): Promise<UserDoc | null>;
  patchUser(uid: string, fields: Record<string, unknown>): Promise<void>;
  findReportsByOwner(uid: string, limit: number): Promise<ReportDoc[]>;        // newest first
  findReportsByEmail(email: string, limit: number): Promise<ReportDoc[]>;      // reporterEmail == email (any status)
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
  saveProof?: (name: string, png: Uint8Array) => Promise<string | void>;
}
export interface SubmitResult {
  mode: SubmitMode;
  caseId?: string;
  proofPath?: string;
  controls?: PortalControl[];
  scouted?: Record<string, string>;
}

/** portal.ts — the wizard driver on @cloudflare/playwright. One instance per cron tick; always close(). */
export interface Portal {
  launch(): Promise<void>;
  close(): Promise<void>;
  ensureLoggedIn(force?: boolean): Promise<void>;
  submitReport(report: ReportDoc, opts?: SubmitOptions): Promise<SubmitResult>;
  /** Read-only checks (canary/watcher). Never clicks Next/Submit. */
  readMyRequests(): Promise<{ caseId: string; status: string; street: string; createdOn: string }[]>;
  canary(): Promise<{ ok: boolean; missing: string[]; notes: string[] }>;
}

/** email.ts */
export interface Mailer {
  send(subject: string, html: string): Promise<string | null>;
  alert(subject: string, html: string): Promise<void>;   // never throws
  sendTo(to: string, subject: string, html: string): Promise<void>; // reporter-facing; gated; never throws
}
