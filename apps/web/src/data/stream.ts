import { ADMIN_API_VERSION, formatStreamId, parseStreamId, type StreamCursor,
  type StreamEventDto } from '@tcg-live/core';
import type { ApiClient } from './client';
import { ApiError, isAbortError } from './errors';
import { SseParser, type SseMessage } from './sse';
import type { KeyValueStorage } from './storage';

/** Connection state of the live stream, for banners and the sidebar indicator. */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'signed-out';

/** Immutable snapshot of the stream connection, for `useSyncExternalStore`. */
export interface StreamConnection {
  state: ConnectionState;
  /** From `hello` and later `change` events; null when no event is active (or before hello). */
  activeEventId: string | null;
  /** True once a `hello` arrived on the current sign-in. */
  helloReceived: boolean;
  bootId: string | null;
  buildId: string | null;
  /** `Last-Event-ID` that the next reconnect will send. */
  lastEventId: string | null;
  /** The last connection failure, cleared by the next `hello`. */
  lastError: ApiError | null;
  /** When the next reconnect attempt is due (local epoch ms), while reconnecting. */
  retryAtMs: number | null;
  /** Consecutive failed attempts since the last `hello`. */
  attempt: number;
}

/** Extra context passed with each stream event. */
export interface StreamEventInfo {
  /** For `change`: whether `audit` extends the cached list or must replace it (new boot or event). */
  auditMode: 'append' | 'replace';
  /** For `hello`: the server restarted since the previous hello; caches must be refetched. */
  bootChanged: boolean;
  /** Local time the message was parsed, for clock offset samples. */
  receivedAtMs: number;
}

export interface StreamClientOptions {
  api: Pick<ApiClient, 'openStream'>;
  /** Receives every parsed event, in wire order. */
  onEvent: (event: StreamEventDto, info: StreamEventInfo) => void;
  /** Called when the server rejects the stream with 401 (the API client may also have signed out). */
  onUnauthorized?: (error: ApiError) => void;
  /** Reloads the page; defaults to `location.reload()`. */
  reload?: () => void;
  /** Expected build; when null the first `hello` sets it and any later different build reloads. */
  expectedBuildId?: string | null;
  /** Used to avoid reload loops when an injected build never matches. Defaults to memory. */
  storage?: KeyValueStorage;
  /** Defaults to `navigator.onLine`. */
  isOnline?: () => boolean;
  /** Target for `online`/`offline` events; defaults to `window`, null disables. */
  eventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** [0, 1) source for backoff jitter. */
  random?: () => number;
  /** Reconnect when nothing (data or ping) arrives for this long. Default 45 s. */
  watchdogMs?: number;
  /** First backoff step. Default 1 s. */
  backoffBaseMs?: number;
  /** Backoff cap. Default 30 s. */
  backoffMaxMs?: number;
  /** Local clock. */
  now?: () => number;
}

export const STREAM_WATCHDOG_MS = 45_000;
export const STREAM_BACKOFF_BASE_MS = 1_000;
export const STREAM_BACKOFF_MAX_MS = 30_000;
const RELOAD_GUARD_KEY = 'tcg-admin.reloaded-for-build.v1';

/** Jittered exponential backoff: half the step fixed, half random, capped. */
export function backoffDelay(attempt: number, random: () => number,
  baseMs = STREAM_BACKOFF_BASE_MS, maxMs = STREAM_BACKOFF_MAX_MS): number {
  const step = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(step / 2 + random() * (step / 2));
}

const INITIAL: StreamConnection = {
  state: 'signed-out', activeEventId: null, helloReceived: false, bootId: null, buildId: null,
  lastEventId: null, lastError: null, retryAtMs: null, attempt: 0
};

function isStreamEvent(value: unknown): value is StreamEventDto {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'hello' || type === 'change' || type === 'status' || type === 'heartbeat';
}

/**
 * The live `/api/v1/stream` reader. Uses fetch (EventSource cannot send the bearer header), resumes
 * with `Last-Event-ID`, reconnects with jittered backoff, and watches for silent connections.
 */
export class StreamClient {
  private snapshot: StreamConnection = INITIAL;
  private readonly listeners = new Set<() => void>();
  private running = false;
  private generation = 0;
  private abortController: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private cursor: StreamCursor | null = null;
  private expectedBuildId: string | null;
  private readonly storage: KeyValueStorage | undefined;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly watchdogMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly eventTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;

  constructor(private readonly options: StreamClientOptions) {
    this.expectedBuildId = options.expectedBuildId ?? null;
    this.storage = options.storage;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => Date.now());
    this.watchdogMs = options.watchdogMs ?? STREAM_WATCHDOG_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? STREAM_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? STREAM_BACKOFF_MAX_MS;
    this.eventTarget = options.eventTarget === undefined
      ? (typeof window === 'undefined' ? null : window)
      : options.eventTarget;
  }

  /** Current connection snapshot (stable reference until something changes). */
  readonly getSnapshot = (): StreamConnection => this.snapshot;

  /** Subscribes to connection changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Sets the build this page was loaded with; a `hello` with another build reloads the page. */
  setExpectedBuildId(buildId: string | null): void {
    this.expectedBuildId = buildId;
  }

  /** Starts (or keeps) the connection. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.eventTarget?.addEventListener('online', this.handleOnline);
    this.eventTarget?.addEventListener('offline', this.handleOffline);
    this.connect();
  }

  /** Stops the connection and forgets the cursor; the state becomes `signed-out`. Idempotent. */
  stop(): void {
    this.running = false;
    this.eventTarget?.removeEventListener('online', this.handleOnline);
    this.eventTarget?.removeEventListener('offline', this.handleOffline);
    this.teardown();
    this.clearRetry();
    this.cursor = null;
    this.update({ ...INITIAL, buildId: this.snapshot.buildId });
  }

  /** Drops the current connection and reconnects now (for a manual "Reconnect" action). */
  reconnectNow(): void {
    if (!this.running) return;
    this.teardown();
    this.clearRetry();
    this.update({ attempt: 0 });
    this.connect();
  }

  private isOnline(): boolean {
    if (this.options.isOnline) return this.options.isOnline();
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  private readonly handleOnline = (): void => {
    if (!this.running || this.snapshot.state !== 'offline') return;
    this.clearRetry();
    this.update({ attempt: 0 });
    this.connect();
  };

  private readonly handleOffline = (): void => {
    if (!this.running) return;
    this.teardown();
    this.clearRetry();
    this.update({ state: 'offline', retryAtMs: null });
  };

  private update(patch: Partial<StreamConnection>): void {
    const next = { ...this.snapshot, ...patch };
    const changed = (Object.keys(next) as (keyof StreamConnection)[]).some(key => next[key] !== this.snapshot[key]);
    if (!changed) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /** Invalidates the current connection attempt and releases it. */
  private teardown(): void {
    this.generation += 1;
    this.clearWatchdog();
    const controller = this.abortController;
    const reader = this.reader;
    this.abortController = null;
    this.reader = null;
    controller?.abort();
    reader?.cancel().catch(() => undefined);
  }

  private connect(): void {
    if (!this.running) return;
    if (!this.isOnline()) {
      this.update({ state: 'offline', retryAtMs: null });
      return;
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    this.update({
      state: this.snapshot.helloReceived || this.snapshot.attempt > 0 ? 'reconnecting' : 'connecting',
      retryAtMs: null
    });
    void this.run(generation, controller);
  }

  private scheduleReconnect(minimumDelayMs = 0): void {
    if (!this.running) return;
    this.clearRetry();
    if (!this.isOnline()) {
      this.update({ state: 'offline', retryAtMs: null });
      return;
    }
    const delay = Math.max(minimumDelayMs,
      backoffDelay(this.snapshot.attempt, this.random, this.backoffBaseMs, this.backoffMaxMs));
    this.update({ state: 'reconnecting', attempt: this.snapshot.attempt + 1, retryAtMs: this.now() + delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private armWatchdog(generation: number): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.teardown();
      this.scheduleReconnect();
    }, this.watchdogMs);
  }

  private async run(generation: number, controller: AbortController): Promise<void> {
    const current = () => generation === this.generation && this.running;
    try {
      // Also a connect timeout: the server sends no headers until its first snapshot read, and a
      // half-open socket (sleep or wake) would otherwise hang here with no reconnect.
      this.armWatchdog(generation);
      const response = await this.options.api.openStream({ lastEventId: this.snapshot.lastEventId, signal: controller.signal });
      if (!current()) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const reader = response.body!.getReader();
      this.reader = reader;
      const decoder = new TextDecoder();
      const parser = new SseParser({ onMessage: message => this.handleMessage(generation, message) });
      this.armWatchdog(generation);
      for (;;) {
        const { done, value } = await reader.read();
        if (!current()) return;
        if (done) break;
        this.armWatchdog(generation);   // any bytes, pings included, prove the connection alive
        parser.feed(decoder.decode(value, { stream: true }));
        if (!current()) return;          // a message (bad build, sign-out) may have stopped us
      }
      parser.feed(decoder.decode());
      parser.reset();                    // an unterminated final message is discarded
      this.clearWatchdog();
      this.reader = null;
      this.abortController = null;
      this.scheduleReconnect();          // the server ended the stream (logout, expiry, shutdown)
    } catch (error) {
      if (!current()) return;
      this.clearWatchdog();
      this.reader = null;
      this.abortController = null;
      if (isAbortError(error)) {
        this.scheduleReconnect();
        return;
      }
      const apiError = error instanceof ApiError ? error
        : new ApiError({ code: 'network', status: 0, message: 'The live stream was interrupted.', cause: error });
      this.update({ lastError: apiError });
      if (apiError.status === 401) {
        this.options.onUnauthorized?.(apiError);
        this.stop();
        return;
      }
      this.scheduleReconnect(apiError.retryAfterMs ?? 0);
    }
  }

  private handleMessage(generation: number, message: SseMessage): void {
    if (generation !== this.generation || !this.running) return;
    let event: unknown;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;   // a malformed message is skipped; the next change carries a full snapshot anyway
    }
    if (!isStreamEvent(event)) return;
    const receivedAtMs = this.now();
    switch (event.type) {
      case 'hello': {
        if (this.buildMismatch(event)) return;
        const bootChanged = this.snapshot.bootId !== null && this.snapshot.bootId !== event.bootId;
        if (bootChanged) this.cursor = null;
        // During a database outage the server cannot read the active event and reports none. Keep
        // the one we already know (same boot), so the console keeps showing its last state.
        const activeEventId = event.activeEventId === null && event.status.database === 'unavailable' && !bootChanged
          ? this.snapshot.activeEventId : event.activeEventId;
        this.update({
          state: 'live', helloReceived: true, attempt: 0, lastError: null, retryAtMs: null,
          bootId: event.bootId, buildId: event.buildId, activeEventId,
          ...(bootChanged ? { lastEventId: null } : {})
        });
        this.options.onEvent(event, { auditMode: 'replace', bootChanged, receivedAtMs });
        return;
      }
      case 'change': {
        const bootId = this.snapshot.bootId ?? '';
        const cursor = parseStreamId(message.id)
          ?? { bootId, eventId: event.eventId, version: event.version, panelRevision: event.panelRevision };
        const previous = this.cursor;
        const auditMode = previous && previous.bootId === cursor.bootId && previous.eventId === cursor.eventId
          ? 'append' : 'replace';
        this.cursor = cursor;
        const active = this.snapshot.activeEventId;
        const retired = event.snapshot.status === 'retired';
        this.update({
          lastEventId: message.id ?? (bootId ? formatStreamId(cursor) : null),
          // A retired event stops being the active one; any other change names the active event.
          activeEventId: retired ? (active === event.eventId ? null : active) : event.eventId
        });
        this.options.onEvent(event, { auditMode, bootChanged: false, receivedAtMs });
        return;
      }
      default:
        this.options.onEvent(event, { auditMode: 'replace', bootChanged: false, receivedAtMs });
    }
  }

  /** Handles a build or API version change; returns true when the page is reloading. */
  private buildMismatch(hello: Extract<StreamEventDto, { type: 'hello' }>): boolean {
    const expected = this.expectedBuildId;
    if (expected === null && hello.apiVersion === ADMIN_API_VERSION) {
      this.expectedBuildId = hello.buildId;   // latch the build this page first saw
      return false;
    }
    if (hello.buildId === expected && hello.apiVersion === ADMIN_API_VERSION) return false;
    const marker = `${hello.buildId}:${hello.apiVersion}`;
    if (this.storage?.getItem(RELOAD_GUARD_KEY) === marker) {
      // We already reloaded once for this build and still do not match (an injected build ID that
      // never matches): accept it rather than loop.
      this.expectedBuildId = hello.buildId;
      return false;
    }
    this.storage?.setItem(RELOAD_GUARD_KEY, marker);
    this.stop();
    (this.options.reload ?? (() => window.location.reload()))();
    return true;
  }
}
