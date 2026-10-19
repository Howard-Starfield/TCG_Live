import { randomUUID } from 'node:crypto';
import { AUDIT_PAGE_LIMIT, type AuditEntryDto, type EventSnapshotDto, type EventSummaryDto,
  type RuntimeStatusDto } from '@tcg-live/core';
import type { ControllerChange, ControllerStatus } from '../../discord/controller.js';
import { RuleError } from '../../rehearsal/domain.js';
import { AdminNotFoundError, AdminUnavailableError, type AdminRuntime, type AdminRuntimeChange,
  type AdminRuntimeListener } from '../runtime-types.js';
import { IdentityCache, type MemberFetcher } from './identity.js';
import { defaultBuildId, ListenerSet } from './listeners.js';
import { mapAuditRow, mapSnapshot, mapSummary, memberIdsFor } from './mappers.js';
import { pgAdminStore, type AdminStore } from './queries.js';

export type GatewayState = 'ready' | 'connecting' | 'reconnecting' | 'offline';

/** The gateway as the admin runtime sees it; discordGateway() adapts a discord.js Client. */
export interface AdminGateway {
  isReady(): boolean;
  /** Reports lifecycle changes; returns a detach function. */
  watch(onChange: (state: GatewayState) => void): () => void;
}

/** The controller surface the admin runtime reads (PrivateDiscordController satisfies it). */
export interface AdminController {
  subscribe(listener: (change: ControllerChange) => void): () => void;
  status(): ControllerStatus;
}

/** The room reconciler surface (MatchRoomReconciler satisfies it). */
export interface AdminRooms {
  trigger(explicit?: boolean, changedMemberId?: string): Promise<void>;
}

export interface IntervalScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realScheduler: IntervalScheduler = {
  setInterval(callback, ms) { const handle = setInterval(callback, ms); handle.unref?.(); return handle; },
  clearInterval(handle) { clearInterval(handle as NodeJS.Timeout); }
};

export interface DiscordAdminRuntimeOptions {
  /** Process runner; decides running versus interrupted clocks. */
  runnerId: string;
  commandsEnabled: boolean;
  publicMatchRooms: boolean;
  lease?: { isLost(): boolean };
  store?: AdminStore;
  identities?: IdentityCache;
  now?: () => number;
  /** Safety-net version check while subscribed. */
  pollIntervalMs?: number;
  scheduler?: IntervalScheduler;
  bootId?: string;
  buildId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roomMessage(error: unknown): string {
  return error instanceof RuleError ? error.message : 'Public match room setup failed.';
}

/**
 * Admin read model over the live bot. Created before the HTTP server starts (database reads work, status
 * `connecting`); the gateway, controller and room reconciler attach as they become ready.
 */
export class DiscordAdminRuntime implements AdminRuntime {
  readonly mode = 'discord' as const;
  readonly bootId: string;
  readonly buildId: string;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly store: AdminStore;
  private readonly identities: IdentityCache;
  private readonly scheduler: IntervalScheduler;
  private readonly pollIntervalMs: number;
  private readonly listeners = new ListenerSet<AdminRuntimeChange>();
  private database: RuntimeStatusDto['database'] = 'ready';
  private gatewayState: GatewayState = 'connecting';
  private detachGateway: (() => void) | undefined;
  private controller: AdminController | undefined;
  private unsubscribeController: (() => void) | undefined;
  private roomWarning: string | null = null;
  private pollHandle: unknown;
  private polling = false;
  private lastVersionKey: string | undefined;
  private lastStatusKey: string;
  private closed = false;

  constructor(private readonly options: DiscordAdminRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    this.bootId = options.bootId ?? randomUUID();
    this.buildId = options.buildId ?? defaultBuildId();
    this.store = options.store ?? pgAdminStore();
    this.identities = options.identities ?? new IdentityCache({ now: this.now });
    this.scheduler = options.scheduler ?? realScheduler;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.lastStatusKey = this.statusKey();
  }

  // Late binding ---------------------------------------------------------------------------------

  attachGateway(gateway: AdminGateway, members: MemberFetcher | null): void {
    if (this.closed) return;
    this.detachGateway?.();
    this.identities.attach(members);
    this.gatewayState = gateway.isReady() ? 'ready' : 'connecting';
    this.detachGateway = gateway.watch(state => {
      if (this.closed) return;
      this.gatewayState = state;
      this.statusMaybeChanged();
    });
    this.statusMaybeChanged();
  }

  attachController(controller: AdminController): void {
    if (this.closed) return;
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    this.controller = controller;
    if (this.listeners.size) this.subscribeController();
    this.statusMaybeChanged();
  }

  /**
   * Observes reconciler outcomes for the rooms status without changing them: the same promise is returned
   * to every caller, and the observation handles its own rejection.
   */
  attachRooms(rooms: AdminRooms): void {
    if (this.closed) return;
    const original = rooms.trigger.bind(rooms);
    rooms.trigger = (explicit?: boolean, changedMemberId?: string) => {
      const task = original(explicit, changedMemberId);
      task.then(() => this.setRoomWarning(null), error => this.setRoomWarning(roomMessage(error)));
      return task;
    };
  }

  private setRoomWarning(warning: string | null): void {
    if (this.closed) return;
    try {
      this.roomWarning = warning;
      this.statusMaybeChanged();
    } catch { /* Observation only. */ }
  }

  // AdminRuntime ---------------------------------------------------------------------------------

  status(): RuntimeStatusDto {
    let cards = { updatePending: false };
    try { if (this.controller) cards = { updatePending: this.controller.status().updatePending }; }
    catch { /* A read-only getter; keep the default. */ }
    let lease: RuntimeStatusDto['lease'] = 'held';
    try { if (this.options.lease?.isLost()) lease = 'lost'; } catch { lease = 'lost'; }
    return {
      mode: 'discord', bootId: this.bootId, buildId: this.buildId,
      serverTimeMs: this.now(), startedAtMs: this.startedAtMs,
      gateway: this.closed ? 'offline' : this.gatewayState,
      database: this.database, lease, cards,
      rooms: { enabled: this.options.publicMatchRooms, warning: this.roomWarning },
      commandsEnabled: this.options.commandsEnabled
    };
  }

  async listEvents(): Promise<EventSummaryDto[]> {
    return (await this.read(store => store.listEvents())).map(mapSummary);
  }

  async activeEventId(): Promise<string | null> {
    return this.read(store => store.activeEventId());
  }

  async snapshot(eventId?: string): Promise<EventSnapshotDto> {
    const id = eventId ?? await this.activeEventId();
    if (!id) throw new AdminNotFoundError('No active event.');
    if (!UUID.test(id)) throw new AdminNotFoundError('Unknown event.');
    const record = await this.read(store => store.readEvent(id));
    if (!record) throw new AdminNotFoundError('Unknown event.');
    const audit = record.audit.map(mapAuditRow);
    await this.identities.resolve(memberIdsFor(record.state, record.session.identity_map, audit));
    let panelRevision = 0;
    try { panelRevision = this.controller?.status().panelRevision ?? 0; } catch { /* Keep zero. */ }
    return mapSnapshot({ state: record.state, session: record.session, audit, runnerId: this.options.runnerId,
      panelRevision, members: member => this.identities.get(member) });
  }

  async audit(eventId: string, afterSequence: number, limit: number): Promise<AuditEntryDto[]> {
    if (!UUID.test(eventId)) throw new AdminNotFoundError('Unknown event.');
    const after = Number.isSafeInteger(afterSequence) && afterSequence > 0 ? afterSequence : 0;
    const size = Number.isSafeInteger(limit) ? Math.min(AUDIT_PAGE_LIMIT, Math.max(1, limit)) : AUDIT_PAGE_LIMIT;
    const rows = await this.read(store => store.readAudit(eventId, after, size));
    if (!rows) throw new AdminNotFoundError('Unknown event.');
    return rows.map(mapAuditRow);
  }

  subscribe(listener: AdminRuntimeListener): () => void {
    if (this.closed) return () => {};
    const remove = this.listeners.add(listener);
    if (this.listeners.size === 1) this.startWatching();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      remove();
      if (!this.listeners.size) this.stopWatching();
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    this.listeners.clear();
    this.detachGateway?.();
    this.detachGateway = undefined;
    this.identities.attach(null);
    this.identities.clear();
  }

  // Internals ------------------------------------------------------------------------------------

  private async read<T>(operation: (store: AdminStore) => Promise<T>): Promise<T> {
    let value: T;
    try { value = await operation(this.store); }
    catch {
      this.setDatabase('unavailable');
      throw new AdminUnavailableError('The rehearsal database is unavailable.');
    }
    this.setDatabase('ready');
    return value;
  }

  private setDatabase(state: RuntimeStatusDto['database']): void {
    if (this.database === state) return;
    this.database = state;
    this.statusMaybeChanged();
  }

  private statusKey(): string {
    const { serverTimeMs: _time, ...stable } = this.status();
    return JSON.stringify(stable);
  }

  private statusMaybeChanged(): void {
    const key = this.statusKey();
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.listeners.emit({ type: 'status' });
  }

  private subscribeController(): void {
    if (!this.controller || this.unsubscribeController) return;
    try {
      this.unsubscribeController = this.controller.subscribe(change => this.onControllerChange(change));
    } catch { /* Polling still covers changes. */ }
  }

  private onControllerChange(change: ControllerChange): void {
    if (this.closed) return;
    if (change.type === 'status') { this.statusMaybeChanged(); return; }
    // The poll keeps its own baseline: re-baselining here would hide an out-of-process write
    // (the rehearsal CLI) landing before the next poll. A repeated notice costs one snapshot read
    // and the stream manager drops versions it already sent.
    this.listeners.emit({ type: change.type, eventId: change.eventId });
  }

  private startWatching(): void {
    this.subscribeController();
    if (this.pollHandle === undefined) {
      this.pollHandle = this.scheduler.setInterval(() => { void this.poll(); }, this.pollIntervalMs);
      void this.poll();
    }
  }

  private stopWatching(): void {
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    if (this.pollHandle !== undefined) this.scheduler.clearInterval(this.pollHandle);
    this.pollHandle = undefined;
    this.lastVersionKey = undefined;
  }

  /** The 5-second safety net: version changes the controller did not report, plus status drift (lease, database). */
  private async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const active = await this.read(store => store.readActiveVersion());
      if (this.closed || this.pollHandle === undefined) return;
      const key = active ? `${active.eventId}:${active.version}` : 'none';
      const previous = this.lastVersionKey;
      this.lastVersionKey = key;
      // The first poll notifies too: a write can land between a subscriber's own first read and
      // this baseline, and subscribers ignore versions they already have.
      if (previous !== key)
        this.listeners.emit(active ? { type: 'event', eventId: active.eventId } : { type: 'status' });
    } catch { /* Database status already reflects the failure. */ }
    finally {
      this.polling = false;
      if (!this.closed) this.statusMaybeChanged();
    }
  }
}
