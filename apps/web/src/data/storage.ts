// Storage access that never throws: private modes, disabled storage and quota errors degrade to no-ops.

/** The subset of the Web Storage API the data layer uses; tests pass an in-memory implementation. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage, used as a fallback when the browser's storage is unavailable. */
export function createMemoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); }
  };
}

function resolve(kind: 'sessionStorage' | 'localStorage'): KeyValueStorage | null {
  try {
    const storage = typeof window === 'undefined' ? undefined : window[kind];
    return storage ?? null;
  } catch {
    return null;   // a SecurityError when storage is disabled
  }
}

/** Wraps a storage so that every call swallows exceptions. */
export function safeStorage(storage: KeyValueStorage | null): KeyValueStorage {
  const target = storage ?? createMemoryStorage();
  return {
    getItem(key) {
      try { return target.getItem(key); } catch { return null; }
    },
    setItem(key, value) {
      try { target.setItem(key, value); } catch { /* quota or disabled storage */ }
    },
    removeItem(key) {
      try { target.removeItem(key); } catch { /* disabled storage */ }
    }
  };
}

/** The tab's sessionStorage (per-origin, port included), or memory when unavailable. */
export function browserSessionStorage(): KeyValueStorage {
  return safeStorage(resolve('sessionStorage'));
}

/** The origin's localStorage, or memory when unavailable. */
export function browserLocalStorage(): KeyValueStorage {
  return safeStorage(resolve('localStorage'));
}
