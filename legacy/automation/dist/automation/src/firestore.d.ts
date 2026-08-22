import { type Firestore } from 'firebase-admin/firestore';
import type { Report, ReportStatus } from '../../shared/types.js';
/** Invalidate caches (call after any status update so next read is fresh). */
export declare function invalidateCache(): void;
export declare function initFirestore(): Firestore;
/** Fetch recent reports, newest first (capped at 200, cached 60s). */
export declare function getDb(): Firestore;
export declare function fetchAllReports(): Promise<(Report & {
    id: string;
})[]>;
/** Fetch a single report by ID. */
export declare function fetchReport(id: string): Promise<(Report & {
    id: string;
}) | null>;
/** Fetch pending reports ordered oldest-first (FIFO, cached 60s). */
export declare function fetchPendingReports(): Promise<(Report & {
    id: string;
})[]>;
/** Reports stuck in 'processing' longer than N minutes (engine crashed mid-submit). */
export declare function findStuckProcessing(minutes: number): Promise<(Report & {
    id: string;
})[]>;
/** Requeue a failed report for another attempt (draft bookkeeping is kept so the retry resumes the draft). */
export declare function requeueReport(reportId: string, retries: number, detail: string, retryAfter: Date): Promise<void>;
export interface EngineState {
    paused: boolean;
    consecutiveFailures: number;
    submissionTimestamps: number[];
    lastSubmissionTime: number | null;
}
export declare function loadEngineState(): Promise<EngineState | null>;
export declare function saveEngineState(state: EngineState): Promise<void>;
/** Fetch submitted reports from the last N hours (for duplicate detection). */
export declare function findRecentSubmissions(windowHours: number): Promise<(Report & {
    id: string;
})[]>;
/** Update a report's status. */
export declare function updateReportStatus(reportId: string, status: ReportStatus, detail?: string, portalCaseId?: string): Promise<void>;
/** Persist wizard draft bookkeeping so a retry resumes the same portal draft instead of orphaning a new one. */
export declare function saveReportDraft(reportId: string, draft: NonNullable<Report['portalDraft']>): Promise<void>;
