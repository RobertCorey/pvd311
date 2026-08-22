export declare const telegramEnabled: () => boolean;
export interface InlineButton {
    text: string;
    callback_data: string;
}
export declare function sendMessage(text: string, buttons?: InlineButton[][]): Promise<number>;
export declare function sendPhoto(photoUrl: string, caption: string, buttons?: InlineButton[][]): Promise<number>;
export declare function editButtons(messageId: number, buttons: InlineButton[][] | null): Promise<void>;
export declare function answerCallback(callbackId: string, text?: string): Promise<void>;
export interface CallbackUpdate {
    updateId: number;
    callbackId: string;
    data: string;
    messageId: number;
    fromId: number;
}
/** Poll once for callback-button presses. */
export declare function getCallbacks(offset: number, timeoutSec?: number): Promise<CallbackUpdate[]>;
/** Fire-and-forget alert; never throws. Email first (Rob's preference), Telegram only if configured. */
export declare function alert(text: string): Promise<void>;
