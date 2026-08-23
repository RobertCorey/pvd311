// One composed-but-unsent report, persisted across the sign-in round trip
// (email-link opens a new page) and across an accidental reload. Photo is stored
// as a Blob for the sign-in park; autosave omits it (a reload just re-asks).
import { idbTx, type StoreSpec } from './idb';

const SPEC: StoreSpec = { db: 'fixmypvd-draft', store: 'draft' };
const KEY = 'current';

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
  /**
   * Why it was parked. 'sign_in' = the send round trip (photo kept);
   * 'autosave' = debounced while composing, restored on reload (photo dropped).
   */
  reason: 'sign_in' | 'autosave';
}

const tx = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => idbTx<T>(SPEC, mode, fn);

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const draftStore = {
  /** Resolves true when the draft is durably stored; false when IndexedDB is unavailable (private mode, quota). */
  save: (d: Omit<Draft, 'savedAt'>): Promise<boolean> => tx<IDBValidKey>('readwrite', (s) => s.put({ ...d, savedAt: Date.now() } satisfies Draft, KEY)).then(() => true).catch(() => false),
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
