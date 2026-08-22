// PVD 311 — offline outbox (IndexedDB).
// Queues reports composed while offline and flushes them oldest-first when a
// connection returns. Exposes window.PVDOutbox. Works on iOS Safari (no
// Background Sync dependency — the page drives the flush on 'online'/load).

(function () {
  const DB_NAME = 'pvd311-outbox';
  const STORE = 'outbox';
  const VERSION = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function withStore(mode, fn) {
    return openDB().then((db) =>
      new Promise((resolve, reject) => {
        const txn = db.transaction(STORE, mode);
        const store = txn.objectStore(STORE);
        let result;
        const r = fn(store);
        if (r) {
          r.onsuccess = () => { result = r.result; };
          r.onerror = () => reject(r.error);
        }
        txn.oncomplete = () => { db.close(); resolve(result); };
        txn.onerror = () => { db.close(); reject(txn.error); };
        txn.onabort = () => { db.close(); reject(txn.error); };
      })
    );
  }

  function enqueue(item) {
    const rec = Object.assign({ queuedAt: Date.now() }, item);
    return withStore('readwrite', (store) => store.add(rec));
  }

  function all() {
    return withStore('readonly', (store) => store.getAll()).then((rows) =>
      (rows || []).slice().sort((a, b) => a.id - b.id)
    );
  }

  function remove(id) {
    return withStore('readwrite', (store) => store.delete(id));
  }

  function count() {
    return withStore('readonly', (store) => store.count());
  }

  // Serialized flush: only one runs at a time. Sends oldest-first, removes each
  // item on success, stops on the first failure. Returns {sent, remaining}.
  let flushing = false;
  async function flush(sendFn) {
    if (flushing) {
      return { sent: 0, remaining: await count().catch(() => 0) };
    }
    flushing = true;
    let sent = 0;
    let items = [];
    try {
      items = await all();
      for (const item of items) {
        try {
          await sendFn(item.payload, item.photoDataUrl);
        } catch (e) {
          return { sent, remaining: items.length - sent };
        }
        await remove(item.id);
        sent += 1;
      }
      return { sent, remaining: 0 };
    } catch (e) {
      return { sent, remaining: Math.max(0, items.length - sent) };
    } finally {
      flushing = false;
    }
  }

  window.PVDOutbox = { enqueue, all, remove, count, flush };
})();
