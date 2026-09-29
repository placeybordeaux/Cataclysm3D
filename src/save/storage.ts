// Storage backends for saves. The save manager only needs an async key/value store of
// structured-cloneable values; the browser uses IndexedDB, tests use MemoryBackend.
// localStorage is only the synchronous last resort on page unload (see manager.ts).

export interface KVBackend {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** All keys starting with `prefix`. */
  keys(prefix?: string): Promise<string[]>;
}

export class MemoryBackend implements KVBackend {
  readonly store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    // structuredClone mimics IndexedDB: callers never share objects with the store.
    const v = this.store.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async keys(prefix = ''): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

const DB_NAME = 'cdda3d';
const STORE = 'kv';

export class IndexedDbBackend implements KVBackend {
  private db: Promise<IDBDatabase> | null = null;

  static available(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
        req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
      });
      // A failed open must not poison every later call.
      this.db.catch(() => (this.db = null));
    }
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      let result: T;
      req.onsuccess = () => (result = req.result);
      // Resolve on commit, not on request success: a put isn't durable until then.
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.run('readonly', (s) => s.get(key))) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.run('readwrite', (s) => s.put(value, key));
  }
  async delete(key: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(key));
  }
  async keys(prefix = ''): Promise<string[]> {
    const all = (await this.run('readonly', (s) => s.getAllKeys())) as IDBValidKey[];
    return all.map(String).filter((k) => k.startsWith(prefix));
  }
}

/** Minimal synchronous storage (window.localStorage shape) for the unload fallback. */
export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function browserLocalStorage(): SyncStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
