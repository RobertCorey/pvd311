// Minimal IndexedDB helper shared by the outbox and the draft store: one
// database per concern, one object store, short-lived connections (closed
// when the transaction completes so a future version bump is never blocked).
export interface StoreSpec { db: string; store: string; version?: number; options?: IDBObjectStoreParameters }

function open(spec: StoreSpec): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(spec.db, spec.version ?? 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(spec.store)) r.result.createObjectStore(spec.store, spec.options); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('indexeddb blocked'));
  });
}

export function idbTx<T>(spec: StoreSpec, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open(spec).then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(spec.store, mode);
    t.oncomplete = () => db.close();
    t.onabort = () => db.close();
    t.onerror = () => db.close();
    const req = fn(t.objectStore(spec.store));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}
