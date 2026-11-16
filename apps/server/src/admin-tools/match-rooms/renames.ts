// The room rename queue. Discord allows 2 renames per 10 minutes per channel, and a rename that hits the limit would make a
// normal REST client wait up to 10 minutes, so renames go out on a dedicated REST instance that rejects instead
// (sdk.ts matchRoomRenameRest). Requests only record the wanted name; the queue sends when the channel's budget allows,
// coalescing several requests into one PATCH with the latest name. Everything it needs to resume lives on the room row.
import { MATCH_ROOM_LIMITS, type MatchRoomRenameState } from '@tcg-live/core';
import type { OpsAuditStore } from '../../ops/audit.js';
import type { MatchRoomRow, MatchRoomStore } from './store.js';
import type { RoomRenamer } from './port.js';

export interface QueueClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realQueueClock: QueueClock = {
  now: () => Date.now(),
  setTimeout(callback, ms) { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
  clearTimeout(handle) { clearTimeout(handle as NodeJS.Timeout); }
};

/** Kept past the window so the next attempt never lands a hair early. */
const WINDOW_SLACK_MS = 1_000;
/** A forbidden rename is retried after this long (an admin may have fixed the permission). */
export const FORBIDDEN_RETRY_MS = 600_000;
/** Other failures (network, 5xx) retry sooner. */
const TRANSIENT_RETRY_MS = 30_000;
const LOG_KEEP = 4;
export const RATE_LIMITED_NOTE = 'Discord is limiting renames for this room; trying again shortly.';
export const TRANSIENT_NOTE = 'The rename could not be sent; trying again shortly.';
const FORBIDDEN_NOTE = 'The bot is not allowed to rename this room. Give it Manage Channels there.';

export type RenameFailure =
  | { kind: 'rateLimit'; retryAfterMs: number }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'other' };

/** Classifies what the REST instance threw: discord.js' RateLimitError (by shape, so tests need no REST) or a DiscordAPIError code. */
export function classifyRenameError(error: unknown): RenameFailure {
  const value = error as { name?: unknown; code?: unknown; retryAfter?: unknown; timeToReset?: unknown; status?: unknown } | null;
  if (value?.name === 'RateLimitError' || value?.status === 429) {
    const wait = typeof value.retryAfter === 'number' ? value.retryAfter : typeof value.timeToReset === 'number' ? value.timeToReset : 0;
    return { kind: 'rateLimit', retryAfterMs: Math.max(0, wait) };
  }
  if (value?.code === 10003) return { kind: 'missing' };
  if (value?.code === 50013 || value?.code === 50001) return { kind: 'forbidden' };
  return { kind: 'other' };
}

/** Renames inside the window, oldest first. */
export function recentRenames(log: readonly number[], now: number): number[] {
  return log.filter(at => at > now - MATCH_ROOM_LIMITS.renameWindowMs).sort((a, b) => a - b);
}

/**
 * The earliest time a rename of this channel fits the budget: now when fewer than 2 renames are inside the window, else
 * the moment enough old ones age out (for 2 entries, the oldest + 10 minutes + 1 second).
 */
export function budgetOpensAt(log: readonly number[], now: number): number {
  const recent = recentRenames(log, now);
  const over = recent.length - (MATCH_ROOM_LIMITS.renamesPerWindow - 1);
  return over <= 0 ? now : recent[over - 1]! + MATCH_ROOM_LIMITS.renameWindowMs + WINDOW_SLACK_MS;
}

export function renameStateOf(room: Pick<MatchRoomRow, 'desiredName' | 'renameError' | 'missingSinceMs'>): MatchRoomRenameState {
  if (room.desiredName === null) return room.renameError && room.missingSinceMs === null ? 'failed' : 'synced';
  if (room.renameError === RATE_LIMITED_NOTE || room.renameError === TRANSIENT_NOTE) return 'retrying';
  return room.renameError ? 'failed' : 'queued';
}

export interface RenameQueueDeps {
  guildId: string;
  store: MatchRoomStore;
  renamer: RoomRenamer;
  audit?: Pick<OpsAuditStore, 'append'>;
  clock?: QueueClock;
  /** A room's rename state changed (the dashboard may want to refresh). */
  onChange?: (channelId: string) => void;
  log?: (message: string) => void;
}

export class RoomRenameQueue {
  private readonly clock: QueueClock;
  private timer: unknown;
  private timerAt = 0;
  private started = false;
  private running: Promise<void> | undefined;
  private again = false;
  /** The name each channel is being renamed to right now: its own channelUpdate echo is not a rename "made in Discord". */
  private readonly inflight = new Map<string, string>();

  constructor(private readonly deps: RenameQueueDeps) { this.clock = deps.clock ?? realQueueClock; }

  /** Resumes from the stored rows: rooms with a wanted name get their turn per their saved budget. */
  async start(): Promise<void> {
    this.started = true;
    await this.arm();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }

  /**
   * Records the name a room should have. Never awaits Discord. A name the room already has clears any waiting rename;
   * a later request replaces an earlier one that has not been sent.
   */
  async request(channelId: string, name: string): Promise<MatchRoomRow | null> {
    const now = this.clock.now();
    const row = await this.deps.store.updateRoom(this.deps.guildId, channelId, current => {
      if (current.missingSinceMs !== null) return null;
      if (name === current.appliedName) return { desiredName: null, nextRenameAtMs: null, renameError: null };
      if (current.desiredName === name) return null;
      return { desiredName: name, nextRenameAtMs: Math.max(current.nextRenameAtMs ?? 0, budgetOpensAt(current.renameLog, now)),
        renameError: null };
    });
    this.deps.onChange?.(channelId);
    await this.arm();
    return row;
  }

  /**
   * A channelUpdate reported this name. Our own renames (and their echoes) are ignored; any other name was set in Discord and
   * becomes the room's custom name, and counts against the rename budget like any rename.
   */
  async observed(channelId: string, name: string): Promise<void> {
    if (this.inflight.get(channelId) === name) return;
    const now = this.clock.now();
    let custom = false;
    const row = await this.deps.store.updateRoom(this.deps.guildId, channelId, current => {
      if (name === current.appliedName) return null;
      if (name === current.desiredName) return { appliedName: name, desiredName: null, nextRenameAtMs: null, renameError: null,
        renameLog: [...current.renameLog, now].slice(-LOG_KEEP) };
      custom = true;
      return { customName: name, appliedName: name, desiredName: null, nextRenameAtMs: null, renameError: null,
        missingSinceMs: null, renameLog: [...current.renameLog, now].slice(-LOG_KEEP) };
    });
    if (!row) return;
    if (custom) await this.audit('match_rooms.renamed', { channelId, name, source: 'discord' });
    this.deps.onChange?.(channelId);
  }

  /** One pass over every room that is due. Exposed for tests; the timer calls it. */
  tick(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again && this.started);
      } finally { this.running = undefined; }
      await this.arm();
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    const rows = (await this.deps.store.rooms(this.deps.guildId)).filter(row => row.desiredName !== null && row.missingSinceMs === null);
    for (const row of rows) {
      if (!this.started) return;
      const now = this.clock.now();
      if ((row.nextRenameAtMs ?? 0) > now || budgetOpensAt(row.renameLog, now) > now) continue;
      await this.send(row);
    }
  }

  private async send(row: MatchRoomRow): Promise<void> {
    const name = row.desiredName!;
    const channelId = row.channelId;
    if (name === row.appliedName) {
      await this.deps.store.updateRoom(this.deps.guildId, channelId, current => current.desiredName === name
        ? { desiredName: null, nextRenameAtMs: null, renameError: null } : null);
      this.deps.onChange?.(channelId);
      return;
    }
    this.inflight.set(channelId, name);
    try {
      await this.deps.renamer.rename(channelId, name, 'TCG Live match room name');
      const sentAt = this.clock.now();
      // Coalescing: a newer request that arrived while this one was in flight stays wanted.
      await this.deps.store.updateRoom(this.deps.guildId, channelId, current => {
        const log = [...current.renameLog, sentAt].slice(-LOG_KEEP);
        const stillWanted = current.desiredName !== null && current.desiredName !== name;
        return { appliedName: name, renameLog: log, renameError: null,
          desiredName: stillWanted ? current.desiredName : null,
          nextRenameAtMs: stillWanted ? budgetOpensAt(log, sentAt) : null };
      });
      await this.audit('match_rooms.renamed', { channelId, name, source: 'queue' });
    } catch (error) {
      await this.failed(channelId, name, error);
    } finally { this.inflight.delete(channelId); }
    this.deps.onChange?.(channelId);
  }

  private async failed(channelId: string, name: string, error: unknown): Promise<void> {
    const failure = classifyRenameError(error);
    const now = this.clock.now();
    await this.deps.store.updateRoom(this.deps.guildId, channelId, current => {
      switch (failure.kind) {
        case 'missing': return { missingSinceMs: now, desiredName: null, nextRenameAtMs: null, renameError: null };
        case 'forbidden': return { renameError: FORBIDDEN_NOTE, nextRenameAtMs: now + FORBIDDEN_RETRY_MS };
        case 'rateLimit': return { renameError: RATE_LIMITED_NOTE,
          nextRenameAtMs: Math.max(now + failure.retryAfterMs + WINDOW_SLACK_MS, budgetOpensAt(current.renameLog, now)) };
        default: return { renameError: TRANSIENT_NOTE, nextRenameAtMs: now + TRANSIENT_RETRY_MS };
      }
    });
    this.deps.log?.(`Room rename of ${channelId} to "${name}" ${failure.kind === 'rateLimit' ? 'was rate limited' : failure.kind === 'missing' ? 'found no channel' :
      failure.kind === 'forbidden' ? 'was refused' : 'failed'}.`);
  }

  /** One timer, for the earliest room that has a wanted name. */
  private async arm(): Promise<void> {
    if (!this.started) return;
    const rows = (await this.deps.store.rooms(this.deps.guildId)).filter(row => row.desiredName !== null && row.missingSinceMs === null);
    if (this.timer !== undefined) { this.clock.clearTimeout(this.timer); this.timer = undefined; }
    if (!rows.length) return;
    const now = this.clock.now();
    const due = Math.min(...rows.map(row => Math.max(row.nextRenameAtMs ?? 0, budgetOpensAt(row.renameLog, now))));
    this.timerAt = Math.max(due, now);
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; void this.tick().catch(error => {
      this.deps.log?.(`Room rename queue failed: ${error instanceof Error ? error.message : 'unknown error'}.`);
    }); }, Math.max(0, this.timerAt - now));
  }

  private async audit(kind: 'match_rooms.renamed', payload: Record<string, unknown>): Promise<void> {
    try { await this.deps.audit?.append({ kind, actor: { kind: 'bot', id: 'bot' }, guildId: this.deps.guildId, payload }); }
    catch { /* The audit never blocks a rename. */ }
  }
}
