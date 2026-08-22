import { type Report } from '../../shared/types.js';
export type HitlMode = 'review' | 'ramp' | 'auto';
type R = Report & {
    id: string;
};
/** Decide whether this report can go straight to the portal. */
export declare function needsHumanApproval(report: R): Promise<boolean>;
/** Park a report for review and ping the phone. */
export declare function requestReview(report: R): Promise<void>;
export declare function approve(reportId: string, by: string): Promise<void>;
export declare function reject(reportId: string, by: string): Promise<void>;
/** Drain pending button presses. Call from the engine's poll tick. */
export declare function processCallbacks(): Promise<void>;
export {};
