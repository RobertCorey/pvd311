export declare const emailEnabled: () => boolean;
export declare function sendEmail(subject: string, html: string, text?: string): Promise<string | null>;
/** Fire-and-forget alert; never throws. */
export declare function alert(subject: string, html: string): Promise<void>;
/** Signed approve/reject link for HITL emails (verified by the Worker / server endpoint). */
export declare function signAction(action: 'approve' | 'reject', reportId: string): string;
export declare function actionUrl(action: 'approve' | 'reject', reportId: string): string;
