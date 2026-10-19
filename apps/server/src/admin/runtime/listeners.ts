import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Listeners are invoked from isolated microtasks inside try/catch and never awaited. */
export class ListenerSet<T> {
  private readonly listeners = new Set<(value: T) => void>();

  get size(): number { return this.listeners.size; }

  add(listener: (value: T) => void): () => void {
    const entry = (value: T) => listener(value);
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      queueMicrotask(() => {
        if (!this.listeners.has(listener)) return;
        try { listener(value); } catch { /* A failing subscriber never affects the runtime. */ }
      });
    }
  }

  clear(): void { this.listeners.clear(); }
}

/** Identifies the compiled server build: changes on every `npm run build`, stable across restarts of one build. */
export function defaultBuildId(): string {
  try { return `b${Math.trunc(statSync(fileURLToPath(import.meta.url)).mtimeMs).toString(36)}`; }
  catch { return 'unknown'; }
}
