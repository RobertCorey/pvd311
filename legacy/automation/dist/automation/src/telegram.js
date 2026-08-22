/** Minimal Telegram Bot API client (fetch-based, no deps). Inert when TELEGRAM_BOT_TOKEN is unset. */
import { config } from './config.js';
import { emailEnabled, alert as emailAlert } from './email.js';
const API = () => `https://api.telegram.org/bot${config.telegramBotToken}`;
export const telegramEnabled = () => !!config.telegramBotToken && !!config.telegramChatId;
async function call(method, body) {
    const resp = await fetch(`${API()}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = (await resp.json());
    if (!data.ok)
        throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
}
export async function sendMessage(text, buttons) {
    const r = await call('sendMessage', {
        chat_id: config.telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    return r.message_id;
}
export async function sendPhoto(photoUrl, caption, buttons) {
    const r = await call('sendPhoto', {
        chat_id: config.telegramChatId, photo: photoUrl, caption, parse_mode: 'HTML',
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    return r.message_id;
}
export async function editButtons(messageId, buttons) {
    await call('editMessageReplyMarkup', {
        chat_id: config.telegramChatId, message_id: messageId,
        reply_markup: { inline_keyboard: buttons ?? [] },
    }).catch(() => { });
}
export async function answerCallback(callbackId, text) {
    await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }).catch(() => { });
}
/** Poll once for callback-button presses. */
export async function getCallbacks(offset, timeoutSec = 0) {
    const updates = await call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['callback_query'] });
    return updates
        .filter((u) => u.callback_query)
        .map((u) => ({
        updateId: u.update_id,
        callbackId: u.callback_query.id,
        data: u.callback_query.data,
        messageId: u.callback_query.message?.message_id,
        fromId: u.callback_query.from?.id,
    }));
}
/** Fire-and-forget alert; never throws. Email first (Rob's preference), Telegram only if configured. */
export async function alert(text) {
    const plain = text.replace(/<[^>]+>/g, '');
    if (emailEnabled()) {
        await emailAlert(plain.split('\n')[0].slice(0, 80), text.replace(/\n/g, '<br>'));
        return;
    }
    if (!telegramEnabled()) {
        console.log(`[alert] ${plain}`);
        return;
    }
    await sendMessage(text).catch((e) => console.error('[telegram] alert failed:', e));
}
