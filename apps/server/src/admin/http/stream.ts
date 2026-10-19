import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADMIN_API_VERSION, AUDIT_PAGE_LIMIT, formatStreamFrame, formatStreamId, parseStreamId, STREAM_RESUME_AUDIT_LIMIT,
  type AuditEntryDto, type EventSnapshotDto, type RuntimeStatusDto, type StreamCursor,
  type StreamEventDto } from '@tcg-live/core';
import { AdminNotFoundError, AdminUnavailableError, type AdminRuntime, type AdminRuntimeChange } from '../runtime-types.js';
import { HttpError, SECURITY_HEADERS, unavailable } from './respond.js';
import type { Session, SessionStore } from './sessions.js';

export interface StreamTimings {
  coalesceMs: number;
  pingMs: number;
  heartbeatMs: number;
  versionCheckMs: number;
  /** How long close() waits for streams to end before destroying them. */
  closeGraceMs: number;
}

export const DEFAULT_STREAM_TIMINGS: StreamTimings = {
  coalesceMs: 50, pingMs: 15_000, heartbeatMs: 30_000, versionCheckMs: 5_000, closeGraceMs: 250
};
export const MAX_STREAMS = 20;
const MAX_BUFFERED_BYTES = 1024 * 1024;

export const STREAM_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store',
  Connection: 'close',
  'X-Accel-Buffering': 'no'
};

interface Connection {
  readonly response: ServerResponse;
  readonly session: Session;
  ready: boolean;
  ended: boolean;
  released: boolean;
  eventId: string | null;
  version: number;
  panelRevision: number;
}

export const frame: (event: StreamEventDto, id?: string) => string = formatStreamFrame;

const statusKey = (status: RuntimeStatusDto) => JSON.stringify({ ...status, serverTimeMs: 0 });
const auditFloor = (snapshot: EventSnapshotDto) => Math.max(0, snapshot.version - STREAM_RESUME_AUDIT_LIMIT);

/** Audit entries after this sequence go with a change for `snapshot`, given what the client last saw. */
export function resumeAfter(seen: Pick<StreamCursor, 'eventId' | 'version'> | null, snapshot: EventSnapshotDto): number {
  const floor = auditFloor(snapshot);
  if (!seen || seen.eventId !== snapshot.eventId || seen.version > snapshot.version) return floor;
  return Math.max(seen.version, floor);
}

const newer = (snapshot: EventSnapshotDto, connection: Connection) =>
  connection.eventId !== snapshot.eventId || snapshot.version > connection.version ||
  (snapshot.version === connection.version && snapshot.panelRevision > connection.panelRevision);

/**
 * Fans one snapshot read per change out to every open stream. Subscribes to the runtime and runs
 * timers only while at least one stream is open.
 */
export class StreamManager {
  private readonly connections = new Set<Connection>();
  private unsubscribe: (() => void) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private flushAgain = false;
  private changes = 0;
  /** A snapshot read failed with the store unavailable; ticks and status changes retry it. */
  private retryPending = false;
  private lastStatus = '';
  private closed = false;
  private drained: (() => void) | null = null;

  constructor(
    private readonly runtime: AdminRuntime,
    private readonly sessions: SessionStore,
    private readonly timings: StreamTimings,
    private readonly now: () => number
  ) {}

  get size(): number {
    return this.connections.size;
  }

  get subscribed(): boolean {
    return this.unsubscribe !== null;
  }

  /** Starts a stream. Rejects with an HttpError, before any stream bytes are written, when it cannot. */
  async open(request: IncomingMessage, response: ServerResponse, session: Session): Promise<void> {
    if (this.closed) throw unavailable();
    if (this.connections.size >= MAX_STREAMS) throw new HttpError(429, 'too_many_requests', 'Too many open streams.');
    const connection: Connection = {
      response, session, ready: false, ended: false, released: false, eventId: null, version: 0, panelRevision: 0
    };
    this.connections.add(connection);
    this.sessions.streamOpened(session);
    response.on('close', () => this.release(connection));
    this.start();
    try {
      const marker = this.changes;
      const bootId = this.runtime.status().bootId;
      let snapshot: EventSnapshotDto | null = null;
      let audit: AuditEntryDto[] = [];
      try {
        snapshot = await this.activeSnapshot();
        const cursor = parseStreamId(firstHeader(request.headers['last-event-id']));
        const seen = cursor && cursor.bootId === bootId ? cursor : null;
        if (snapshot) audit = await this.readAudit(snapshot, resumeAfter(seen, snapshot));
      } catch (error) {
        // During an outage the stream still opens, so the client learns the database state from
        // hello; the snapshot follows as a change once a retry succeeds.
        if (!(error instanceof AdminUnavailableError)) throw error;
        snapshot = null;
        audit = [];
        this.retryPending = true;
      }
      // Read after the snapshot: the read itself can change the status (database ready or unavailable).
      const status = this.runtime.status();
      if (this.closed) throw unavailable();
      if (connection.ended || !this.sessions.isLive(session)) throw new HttpError(401, 'unauthenticated', 'Sign in again.');
      if (response.destroyed) return;
      response.writeHead(200, STREAM_HEADERS);
      response.flushHeaders();
      this.write(connection, frame({
        type: 'hello', apiVersion: ADMIN_API_VERSION, buildId: status.buildId, bootId: status.bootId,
        status, activeEventId: snapshot?.eventId ?? null
      }));
      if (snapshot) this.sendChange(connection, snapshot, audit);
      connection.ready = true;
      if (marker !== this.changes) this.scheduleFlush();
    } catch (error) {
      this.release(connection);
      throw error;
    }
  }

  closeSession(session: Session): void {
    for (const connection of this.connections) if (connection.session === session) this.end(connection);
  }

  /** Ends every stream and stops all work. Idempotent; resolves once streams are gone. */
  close(): Promise<void> {
    this.closed = true;
    this.stop();
    for (const connection of this.connections) this.end(connection);
    if (this.connections.size === 0) return Promise.resolve();
    return new Promise<void>(resolve => {
      const grace = setTimeout(() => {
        for (const connection of this.connections) connection.response.destroy();
      }, this.timings.closeGraceMs);
      grace.unref();
      const previous = this.drained;
      this.drained = () => {
        clearTimeout(grace);
        previous?.();
        resolve();
      };
    });
  }

  private start(): void {
    if (this.unsubscribe) return;
    try {
      this.lastStatus = statusKey(this.runtime.status());
    } catch {
      this.lastStatus = '';
    }
    this.unsubscribe = this.runtime.subscribe(change => this.onChange(change));
    const every = (ms: number, task: () => void) => {
      const timer = setInterval(() => {
        try { task(); } catch { /* a tick must never take the process down */ }
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.timings.pingMs, () => this.broadcast(': ping\n\n'));
    every(this.timings.heartbeatMs, () => this.broadcast(frame({ type: 'heartbeat', serverTimeMs: this.now() })));
    // The runtime reports version changes itself (its own poll included), so the tick reads a
    // snapshot again only after a failed read.
    every(this.timings.versionCheckMs, () => {
      this.sessions.sweep();
      this.checkStatus();
      if (this.retryPending) this.scheduleFlush();
    });
  }

  private stop(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushAgain = false;
    this.retryPending = false;
    try { unsubscribe?.(); } catch { /* the runtime owns its own cleanup */ }
  }

  private onChange(change: AdminRuntimeChange): void {
    if (this.closed || !this.unsubscribe) return;
    this.changes += 1;
    try {
      if (change.type === 'status') {
        this.checkStatus();
        if (this.retryPending) this.scheduleFlush();
      } else this.scheduleFlush();
    } catch {
      this.scheduleFlush();
    }
  }

  private checkStatus(): void {
    const status = this.runtime.status();
    const key = statusKey(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.broadcast(frame({ type: 'status', status }));
  }

  private scheduleFlush(): void {
    if (this.closed || !this.unsubscribe || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.timings.coalesceMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      await this.flushOnce();
      this.retryPending = false;
    } catch {
      this.retryPending = true;   // the next tick or status change retries
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.scheduleFlush();
      }
    }
  }

  private async flushOnce(): Promise<void> {
    this.checkStatus();
    if (!this.live().length) return;
    const snapshot = await this.activeSnapshot();
    if (!snapshot || this.closed) return;
    const targets = this.live().filter(connection => newer(snapshot, connection));
    if (!targets.length) return;
    const afterOf = (connection: Connection) => resumeAfter(
      connection.eventId === null ? null : { eventId: connection.eventId, version: connection.version }, snapshot);
    const audit = await this.readAudit(snapshot, Math.min(...targets.map(afterOf)));
    if (this.closed) return;
    for (const connection of targets) {
      if (!connection.ready || connection.ended || !newer(snapshot, connection)) continue;
      const after = afterOf(connection);
      this.sendChange(connection, snapshot, audit.filter(entry => entry.sequence > after));
    }
  }

  private async activeSnapshot(): Promise<EventSnapshotDto | null> {
    try {
      return await this.runtime.snapshot();
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  }

  private async readAudit(snapshot: EventSnapshotDto, after: number): Promise<AuditEntryDto[]> {
    if (snapshot.version <= after) return [];
    const entries = await this.runtime.audit(snapshot.eventId, after, Math.min(AUDIT_PAGE_LIMIT, snapshot.version - after));
    return entries.filter(entry => entry.sequence > after && entry.sequence <= snapshot.version);
  }

  private sendChange(connection: Connection, snapshot: EventSnapshotDto, audit: AuditEntryDto[]): void {
    const cursor = { bootId: this.runtime.status().bootId, eventId: snapshot.eventId,
      version: snapshot.version, panelRevision: snapshot.panelRevision };
    this.write(connection, frame({
      type: 'change', eventId: snapshot.eventId, version: snapshot.version, panelRevision: snapshot.panelRevision,
      snapshot, audit
    }, formatStreamId(cursor)));
    connection.eventId = snapshot.eventId;
    connection.version = snapshot.version;
    connection.panelRevision = snapshot.panelRevision;
  }

  private live(): Connection[] {
    return [...this.connections].filter(connection => connection.ready && !connection.ended);
  }

  private broadcast(chunk: string): void {
    for (const connection of this.live()) this.write(connection, chunk);
  }

  private write(connection: Connection, chunk: string): void {
    const { response } = connection;
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength > MAX_BUFFERED_BYTES) {
      response.destroy();
      return;
    }
    response.write(chunk);
  }

  private end(connection: Connection): void {
    if (connection.ended) return;
    connection.ended = true;
    const { response } = connection;
    if (response.headersSent && !response.writableEnded) response.end();
  }

  private release(connection: Connection): void {
    if (connection.released) return;
    connection.released = true;
    connection.ended = true;
    this.connections.delete(connection);
    this.sessions.streamClosed(connection.session);
    if (this.connections.size > 0) return;
    this.stop();
    const drained = this.drained;
    this.drained = null;
    drained?.();
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
