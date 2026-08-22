import { type Page } from 'playwright';
import { type Report } from '../../shared/types.js';
import { type PortalControl } from './scout.js';
export type SubmitMode = 'live' | 'inspect';
export interface SubmitOptions {
    /** 'live' submits; 'inspect' walks to Step 3, dumps the controls, screenshots, and stops (costs one draft). */
    mode?: SubmitMode;
    /** Called after each wizard step so the caller can persist draft bookkeeping (draft-resume on retry). */
    onDraft?: (draft: NonNullable<Report['portalDraft']>) => Promise<void>;
}
export interface SubmitResult {
    mode: SubmitMode;
    caseId?: string;
    proofPath?: string;
    /** Step-3 controls that were visible (inspect mode, or when the scout ran). */
    controls?: PortalControl[];
    /** Field values the scout proposed (if it ran). */
    scouted?: Record<string, string>;
}
export declare class PortalSubmitter {
    private browser;
    private context;
    private page;
    private loggedIn;
    launch(): Promise<void>;
    close(): Promise<void>;
    private getPage;
    /** Read-only page access for the canary/watcher. Callers must never click Next/Submit. */
    pageForReadOnlyChecks(): Page;
    ensureLoggedIn(force?: boolean): Promise<void>;
    /** True when the portal bounced us to the sign-in page mid-flow. */
    private sessionLost;
    submitReport(report: Report & {
        id: string;
    }, opts?: SubmitOptions): Promise<SubmitResult>;
    private runWizard;
    private saveDraft;
    private tryResumeDraft;
    private fillStep1;
    private fillStep2;
    private fillStep2Autocomplete;
    private arcgisReverseGeocode;
    /** Dump the visible, fillable Step-3 controls (excluding the always-present description/address/case-type). */
    private dumpControls;
    private setControl;
    private fillStep3;
    private screenshot;
    private uploadPhoto;
    private extractCaseId;
}
