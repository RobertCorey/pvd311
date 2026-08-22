export interface AutoLogEntry {
    time: string;
    reportId: string;
    action: 'submitted' | 'auto-rejected' | 'failed';
    detail: string;
}
export interface AutoState {
    enabled: boolean;
    paused: boolean;
    consecutiveFailures: number;
    submissionsThisHour: number;
    lastSubmissionTime: string | null;
    log: AutoLogEntry[];
}
export declare class AutoSubmitter {
    private isSubmissionActive;
    private setSubmissionActive;
    private enabled;
    private paused;
    private consecutiveFailures;
    private submissionTimestamps;
    private lastSubmissionTime;
    private log;
    private timer;
    private busy;
    /** Callback so index.ts can check/set activeSubmission */
    constructor(isSubmissionActive: () => boolean, setSubmissionActive: (id: string | null) => void);
    getState(): AutoState;
    setEnabled(on: boolean): void;
    resume(): void;
    start(): void;
    private restoreState;
    private persistState;
    stop(): void;
    private addLog;
    private lastDailyRun;
    private lastWatcherRun;
    /** Every ~30 min: poll the portal for status changes on submitted cases (read-only). */
    private watcherTick;
    /** Once per day (first poll after 06:00 local): selector canary + digest. Never creates drafts. */
    private dailyTasks;
    private poll;
    private verify;
    private submitReport;
}
