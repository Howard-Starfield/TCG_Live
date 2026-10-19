import type { AuditEntryDto, EventSnapshotDto, EventSummaryDto, RuntimeStatusDto } from '@tcg-live/core';
import type { AdminMode } from './config.js';

/** What changed. The stream manager reads one snapshot per change and fans it out. */
export type AdminRuntimeChange =
  | { type: 'event'; eventId: string }       // committed command, timer application
  | { type: 'panels'; eventId: string }      // card or panel change (panelRevision moved)
  | { type: 'status' };                      // gateway, lease, database, cards or rooms status

export type AdminRuntimeListener = (change: AdminRuntimeChange) => void;

/** Unknown event, or no active event when one was implied. Maps to 404. */
export class AdminNotFoundError extends Error {}
/** The backing store cannot be read right now. Maps to 503. */
export class AdminUnavailableError extends Error {}

/**
 * Server-internal read model behind the admin HTTP layer.
 * Implemented by DiscordAdminRuntime (live bot) and DemoAdminRuntime (in-memory scenario).
 * Wave 3 adds applyAdminCommand() and refreshPanels().
 */
export interface AdminRuntime {
  readonly mode: AdminMode;
  /** Cached, synchronous status; never performs I/O. */
  status(): RuntimeStatusDto;
  /** Session-backed events, newest first. */
  listEvents(): Promise<EventSummaryDto[]>;
  /** The active event's ID, or null when none is active. */
  activeEventId(): Promise<string | null>;
  /** Snapshot of `eventId`, or of the active event when omitted. Throws AdminNotFoundError. */
  snapshot(eventId?: string): Promise<EventSnapshotDto>;
  /** Applied audit entries with sequence > afterSequence, ascending, at most `limit`. Throws AdminNotFoundError. */
  audit(eventId: string, afterSequence: number, limit: number): Promise<AuditEntryDto[]>;
  /**
   * Listeners are invoked from a microtask inside try/catch and never awaited.
   * The runtime polls only while it has at least one subscriber.
   */
  subscribe(listener: AdminRuntimeListener): () => void;
  /** Stops timers and polling. Idempotent. */
  close(): Promise<void>;
}
