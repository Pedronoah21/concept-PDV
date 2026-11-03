/**
 * Banco local do caixa (IndexedDB). Guarda o catálogo para vender sem internet
 * e a fila de vendas que ainda não chegaram ao servidor.
 */
const DB_NAME = 'concept-pdv';
const VERSION = 1;
export type StoreName = 'kv' | 'outbox';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export const kv = {
  get: <T>(key: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  set: (key: string, value: unknown) => run('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key: string) => run('kv', 'readwrite', (s) => s.delete(key)),
};

export const outbox = {
  all: <T>() => run<T[]>('outbox', 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  put: (value: unknown) => run('outbox', 'readwrite', (s) => s.put(value)),
  del: (id: string) => run('outbox', 'readwrite', (s) => s.delete(id)),
  count: () => run<number>('outbox', 'readonly', (s) => s.count()),
};
