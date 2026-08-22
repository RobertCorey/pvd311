// One composed-but-unsent report, persisted across the sign-in round trip
// (email-link opens a new page). Photo is stored as a Blob; IndexedDB handles it.
const DB = 'fixmypvd-draft', STORE = 'draft', KEY = 'current';

export interface Draft {
  savedAt: number;
  category: string;
  address: string;
  lat: number | null;
  lng: number | null;
  extra: Record<string, string>;
  description: string;
  descriptionOriginal: string | null;
  photo: Blob | null;
  /** Why it was parked — lets the Report screen resume the right step. */
  reason: 'sign_in';
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode);
    t.oncomplete = () => db.close(); t.onabort = () => db.close();
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const draftStore = {
  save: (d: Omit<Draft, 'savedAt'>) => tx<IDBValidKey>('readwrite', (s) => s.put({ ...d, savedAt: Date.now() } satisfies Draft, KEY)).then(() => undefined).catch(() => undefined),
  load: async (): Promise<Draft | null> => {
    try {
      const d = await tx<Draft | undefined>('readonly', (s) => s.get(KEY));
      if (!d) return null;
      if (Date.now() - d.savedAt > MAX_AGE_MS) { await draftStore.clear(); return null; }
      return d;
    } catch { return null; }
  },
  clear: () => tx<undefined>('readwrite', (s) => s.delete(KEY)).then(() => undefined).catch(() => undefined),
};
