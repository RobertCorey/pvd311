// Offline outbox: reports composed while offline are stored in IndexedDB (photo
// Blob included) and sent when the app is next open online. Turnstile tokens
// expire, so queued items are re-verified at send time with a fresh token —
// the flush therefore runs from the Report screen where a widget can mount.
import type { ReportSubmission } from '../api/types';

const DB = 'snappvd', STORE = 'outbox';
export interface OutboxItem { id?: number; queuedAt: number; report: Omit<ReportSubmission, 'turnstileToken'>; }

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

export const outbox = {
  add: (report: OutboxItem['report']) => tx<IDBValidKey>('readwrite', (s) => s.add({ queuedAt: Date.now(), report } satisfies OutboxItem)),
  all: () => tx<OutboxItem[]>('readonly', (s) => s.getAll()),
  remove: (id: number) => tx<undefined>('readwrite', (s) => s.delete(id)),
  count: () => tx<number>('readonly', (s) => s.count()),
};

let flushing = false;
/** Send queued items oldest-first (at most `max`); stops at the first failure. */
export async function flushOutbox(send: (r: OutboxItem['report']) => Promise<unknown>, max = Infinity): Promise<{ sent: number; remaining: number }> {
  if (flushing) return { sent: 0, remaining: await outbox.count().catch(() => 0) };
  flushing = true;
  let sent = 0;
  try {
    const items = (await outbox.all()).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const it of items) {
      if (sent >= max) break;
      try { await send(it.report); await outbox.remove(it.id!); sent++; } catch { break; }
    }
    return { sent, remaining: await outbox.count() };
  } finally { flushing = false; }
}
