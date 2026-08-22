// Offline outbox: reports composed while offline are stored in IndexedDB (photo
// Blob included) and sent when the app is next open online. Turnstile tokens
// expire, so queued items are re-verified at send time with a fresh token —
// the flush therefore runs from the Report screen where a widget can mount.
import type { ReportSubmission } from '../api/types';

import { idbTx, type StoreSpec } from './idb';

const SPEC: StoreSpec = { db: 'snappvd', store: 'outbox', options: { keyPath: 'id', autoIncrement: true } };
export interface OutboxItem {
  id?: number;
  queuedAt: number;
  /** Idempotency key sent as `clientId` so a crash between send and delete can't double-file. */
  clientId: string;
  attempts: number;
  lastError?: string;
  report: Omit<ReportSubmission, 'turnstileToken'>;
}
export const MAX_ATTEMPTS = 3;

const tx = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => idbTx<T>(SPEC, mode, fn);

export const outbox = {
  add: (report: OutboxItem['report']) => tx<IDBValidKey>('readwrite', (s) => s.add({ queuedAt: Date.now(), clientId: crypto.randomUUID(), attempts: 0, report } satisfies OutboxItem)),
  put: (item: OutboxItem) => tx<IDBValidKey>('readwrite', (s) => s.put(item)),
  /** Items still eligible for sending. */
  pending: () => tx<OutboxItem[]>('readonly', (s) => s.getAll()).then((all) => all.filter((i) => (i.attempts ?? 0) < MAX_ATTEMPTS)),
  all: () => tx<OutboxItem[]>('readonly', (s) => s.getAll()),
  remove: (id: number) => tx<undefined>('readwrite', (s) => s.delete(id)),
  count: () => tx<number>('readonly', (s) => s.count()),
};

let flushing = false;
// After a failed send we pause until the app explicitly resumes (next 'online'
// event / next open), so a permanently-rejected item can't loop.
let paused = false;
export const resumeOutbox = () => { paused = false; };
export const isOutboxPaused = () => paused;
/**
 * Send eligible items oldest-first (at most `max`); stops at the first failure and
 * records the attempt so a permanently-rejected item is retried at most MAX_ATTEMPTS
 * times (then it stays in the store, flagged, instead of looping).
 */
export async function flushOutbox(send: (r: OutboxItem['report'], clientId: string) => Promise<unknown>, max = Infinity): Promise<{ sent: number; failed: number; remaining: number }> {
  if (flushing || paused) return { sent: 0, failed: 0, remaining: (await outbox.pending().catch(() => [])).length };
  flushing = true;
  let sent = 0, failed = 0;
  try {
    const items = (await outbox.pending()).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const it of items) {
      if (sent >= max) break;
      try {
        await send(it.report, it.clientId);
        await outbox.remove(it.id!);
        sent++;
      } catch (e) {
        failed++;
        paused = true;
        await outbox.put({ ...it, attempts: (it.attempts ?? 0) + 1, lastError: (e as Error)?.message?.slice(0, 120) }).catch(() => {});
        break;
      }
    }
    return { sent, failed, remaining: (await outbox.pending()).length };
  } finally { flushing = false; }
}
