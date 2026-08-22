export interface PortalRow {
    caseId: string;
    caseType: string;
    street: string;
    status: string;
    createdOn: string;
}
export interface PortalActivity {
    subject: string;
    createdOn: string | null;
    fetchedAt: string;
}
/** A detected status transition for one report, returned to the caller (engine → reporter notification). */
export interface Change {
    reportId: string;
    caseId: string;
    from: string | null;
    to: string;
    reporterEmail: string | null;
    activity?: PortalActivity | null;
}
/** Turn one grid row (its cell texts) into a PortalRow, using header names when present, heuristics otherwise. */
export declare function parseRow(headers: string[], cells: string[]): PortalRow | null;
/** Best-effort extraction of the latest activity {subject, createdOn} from a GetActivities response body. */
export declare function parseActivities(body: string): {
    subject: string;
    createdOn: string | null;
} | null;
/**
 * One watch pass: scrape My Requests, diff every `submitted` report's portal status against the last
 * recorded `portalStatus`, persist changes, and return the transitions found.
 */
export declare function runWatcher(): Promise<Change[]>;
