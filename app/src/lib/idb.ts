// Minimal IndexedDB helper shared by the outbox and the draft store: one
// database per concern, one object store, short-lived connections (closed
// when the transaction completes so a future version bump is never blocked).
export interface StoreSpec { db: string; store: string; version?: number; options?: IDBObjectStoreParameters }

// Privacy browsers stub IndexedDB: DuckDuckGo on iOS fired upgradeneeded with `result` undefined (Sentry
// JAVASCRIPT-8, 2026-10-16), and a stub may also throw on open() or never fire any event. Every one of those
// rejects here — callers already treat a rejection as "unavailable" — so nothing crashes and Send never hangs
// waiting on a draft that can't be stored.
const OPEN_TIMEOUT_MS = 3_000;

function open(spec: StoreSpec): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => settle(() => rej(new Error('indexeddb timeout'))), OPEN_TIMEOUT_MS);
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(spec.db, spec.version ?? 1);
    } catch (e) {
      settle(() => rej(e));
      return;
    }
    r.onupgradeneeded = () => {
      try {
        const db = r.result;
        if (!db) throw new Error('indexeddb unavailable');
        if (!db.objectStoreNames.contains(spec.store)) db.createObjectStore(spec.store, spec.options);
      } catch (e) {
        try { r.transaction?.abort(); } catch { /* stub without a transaction */ }
        settle(() => rej(e));
      }
    };
    r.onsuccess = () => settle(() => (r.result ? res(r.result) : rej(new Error('indexeddb unavailable'))));
    r.onerror = () => settle(() => rej(r.error));
    r.onblocked = () => settle(() => rej(new Error('indexeddb blocked')));
  });
}

export function idbTx<T>(spec: StoreSpec, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open(spec).then((db) => new Promise<T>((res, rej) => {
    try {
      const t = db.transaction(spec.store, mode);
      t.oncomplete = () => db.close();
      t.onabort = () => db.close();
      t.onerror = () => db.close();
      const req = fn(t.objectStore(spec.store));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    } catch (e) {
      try { db.close(); } catch { /* already closed */ }
      rej(e);
    }
  }));
}
