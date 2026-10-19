// Stub AdminRuntime for the HTTP tests, backed by @tcg-live/core fixtures.
import type { AuditEntryDto, EventSnapshotDto, EventSummaryDto, RuntimeStatusDto } from '@tcg-live/core';
import { auditTimeline, FIXTURE_BOOT_ID, FIXTURE_EVENT_ID, FIXTURE_NOW_MS, liveDispute } from '@tcg-live/core/fixtures';
import { AdminNotFoundError, type AdminRuntime, type AdminRuntimeChange,
  type AdminRuntimeListener } from '../runtime-types.js';

export const SECOND_EVENT_ID = '0a1b2c3d-0000-4000-8000-000000000002';

export function fixtureStatus(overrides: Partial<RuntimeStatusDto> = {}): RuntimeStatusDto {
  return {
    mode: 'demo', bootId: FIXTURE_BOOT_ID, buildId: 'test-build',
    serverTimeMs: FIXTURE_NOW_MS, startedAtMs: FIXTURE_NOW_MS - 3_600_000,
    gateway: 'not_applicable', database: 'not_configured', lease: 'not_applicable',
    cards: { updatePending: false }, rooms: { enabled: false, warning: null },
    commandsEnabled: true, ...overrides
  };
}

interface StoredEvent { snapshot: EventSnapshotDto; audit: AuditEntryDto[] }

export class StubRuntime implements AdminRuntime {
  readonly mode = 'demo' as const;
  statusValue = fixtureStatus();
  activeId: string | null = FIXTURE_EVENT_ID;
  readonly events = new Map<string, StoredEvent>([
    [FIXTURE_EVENT_ID, { snapshot: structuredClone(liveDispute), audit: structuredClone(auditTimeline) }]
  ]);
  readonly reads = { snapshot: 0, audit: 0, list: 0 };
  readonly listeners = new Set<AdminRuntimeListener>();
  /** Thrown by the next reads while set. */
  failure: Error | null = null;
  /** While set, snapshot reads wait for it. */
  gate: Promise<void> | null = null;
  closed = 0;

  status(): RuntimeStatusDto {
    return { ...this.statusValue, serverTimeMs: Date.now() };
  }

  async listEvents(): Promise<EventSummaryDto[]> {
    this.reads.list += 1;
    if (this.failure) throw this.failure;
    return [...this.events.values()].map(({ snapshot }) => ({
      eventId: snapshot.eventId, status: snapshot.status, kind: snapshot.kind,
      createdAtMs: snapshot.createdAtMs, retiredAtMs: snapshot.retiredAtMs, version: snapshot.version
    })).reverse();
  }

  async activeEventId(): Promise<string | null> {
    return this.activeId;
  }

  async snapshot(eventId?: string): Promise<EventSnapshotDto> {
    this.reads.snapshot += 1;
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    const stored = this.events.get(eventId ?? this.activeId ?? '');
    if (!stored) throw new AdminNotFoundError('No such event.');
    return structuredClone(stored.snapshot);
  }

  async audit(eventId: string, afterSequence: number, limit: number): Promise<AuditEntryDto[]> {
    this.reads.audit += 1;
    if (this.failure) throw this.failure;
    const stored = this.events.get(eventId);
    if (!stored) throw new AdminNotFoundError('No such event.');
    return structuredClone(stored.audit.filter(entry => entry.sequence > afterSequence).slice(0, limit));
  }

  subscribe(listener: AdminRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(change: AdminRuntimeChange): void {
    for (const listener of this.listeners) queueMicrotask(() => {
      try { listener(change); } catch { /* isolated like the real runtimes */ }
    });
  }

  /** Applies one more audited command to `eventId` and notifies subscribers. */
  advance(eventId = this.activeId ?? FIXTURE_EVENT_ID, notify = true): EventSnapshotDto {
    const stored = this.events.get(eventId)!;
    const version = stored.snapshot.version + 1;
    stored.snapshot = { ...stored.snapshot, version };
    stored.audit.push({ ...stored.audit.at(-1)!, sequence: version, commandId: `test:${version}` });
    if (notify) this.emit({ type: 'event', eventId });
    return stored.snapshot;
  }

  bumpPanels(eventId = this.activeId ?? FIXTURE_EVENT_ID): void {
    const stored = this.events.get(eventId)!;
    stored.snapshot = { ...stored.snapshot, panelRevision: stored.snapshot.panelRevision + 1 };
    this.emit({ type: 'panels', eventId });
  }

  /** A second event with `count` audit entries, made active. */
  addEvent(eventId: string, count: number): void {
    const audit = Array.from({ length: count }, (_, index) => ({
      ...auditTimeline[0]!, sequence: index + 1, commandId: `test:${eventId}:${index + 1}`
    }));
    this.events.set(eventId, { snapshot: { ...structuredClone(liveDispute), eventId, version: count, panelRevision: 0 }, audit });
    this.activeId = eventId;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}
