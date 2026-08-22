/** Minimal Telegram Bot API client (fetch-based, no deps). Inert when TELEGRAM_BOT_TOKEN is unset. */
import { config } from './config.js';
import { emailEnabled, alert as emailAlert } from './email.js';

const API = () => `https://api.telegram.org/bot${config.telegramBotToken}`;

export const telegramEnabled = (): boolean => !!config.telegramBotToken && !!config.telegramChatId;

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

export interface InlineButton { text: string; callback_data: string }

export async function sendMessage(text: string, buttons?: InlineButton[][]): Promise<number> {
  const r = await call<{ message_id: number }>('sendMessage', {
    chat_id: config.telegramChatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  return r.message_id;
}

export async function sendPhoto(photoUrl: string, caption: string, buttons?: InlineButton[][]): Promise<number> {
  const r = await call<{ message_id: number }>('sendPhoto', {
    chat_id: config.telegramChatId, photo: photoUrl, caption, parse_mode: 'HTML',
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  return r.message_id;
}

export async function editButtons(messageId: number, buttons: InlineButton[][] | null): Promise<void> {
  await call('editMessageReplyMarkup', {
    chat_id: config.telegramChatId, message_id: messageId,
    reply_markup: { inline_keyboard: buttons ?? [] },
  }).catch(() => {});
}

export async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }).catch(() => {});
}

export interface CallbackUpdate { updateId: number; callbackId: string; data: string; messageId: number; fromId: number }

/** Poll once for callback-button presses. */
export async function getCallbacks(offset: number, timeoutSec = 0): Promise<CallbackUpdate[]> {
  const updates = await call<any[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['callback_query'] });
  return updates
    .filter((u) => u.callback_query)
    .map((u) => ({
      updateId: u.update_id,
      callbackId: u.callback_query.id,
      data: u.callback_query.data as string,
      messageId: u.callback_query.message?.message_id as number,
      fromId: u.callback_query.from?.id as number,
    }));
}

/** Fire-and-forget alert; never throws. Email first (Rob's preference), Telegram only if configured. */
export async function alert(text: string): Promise<void> {
  const plain = text.replace(/<[^>]+>/g, '');
  if (emailEnabled()) { await emailAlert(plain.split('\n')[0].slice(0, 80), text.replace(/\n/g, '<br>')); return; }
  if (!telegramEnabled()) { console.log(`[alert] ${plain}`); return; }
  await sendMessage(text).catch((e) => console.error('[telegram] alert failed:', e));
}
