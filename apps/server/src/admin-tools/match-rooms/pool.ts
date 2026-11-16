// The match room pool: numbered "tables" of public voice rooms, reused across rounds and events. Table k serves match Mk.
// provision() runs when a round publishes (and on refresh) and binds every match to a room or throws.
import { MATCH_ROOM_LIMITS, categoryRangeForTable, renderMatchRoomName, type MatchId } from '@tcg-live/core';
import { botHasManageRoles, roomPlan, sameOverwrites, type RoomOverwrite } from '../../discord/match-rooms.js';
import type { OpsAuditStore } from '../../ops/audit.js';
import { RuleError } from '../../rehearsal/domain.js';
import type { RoomCategories } from './categories.js';
import { legacyCreatedName } from './migrate.js';
import type { MatchRoomDiscord, RoomChannel } from './port.js';
import type { MatchRoomRow, MatchRoomStore } from './store.js';

/** Where a pooled room served a match before this event: what the transcripts module archives before the room is reused. */
export interface PreviousBinding { eventId: string; matchId: MatchId; startedAtMs: number | null }

export interface RoomBindings {
  /** Writes the per-event binding (identity_map.roundRooms). */
  bind(eventId: string, matchId: MatchId, channelId: string): Promise<void>;
  /** The most recent other event this channel served a match in, or null. */
  previous(channelId: string, exceptEventId: string): Promise<PreviousBinding | null>;
}

export interface PoolDeps {
  guildId: string;
  applicationId: string;
  adminId: string;
  store: MatchRoomStore;
  discord: MatchRoomDiscord;
  categories: RoomCategories;
  queue: { request(channelId: string, name: string): Promise<unknown> };
  bindings: RoomBindings;
  /** The frozen legacy rooms (`config.matchChannels`), tried after the saved binding. */
  legacyChannels?: () => Partial<Record<MatchId, string>> | undefined;
  /** First copy of a room's original overwrites (discord/match-rooms.ts backupRoomOverwrites). */
  backup: (guildId: string, channelId: string, overwrites: readonly RoomOverwrite[]) => Promise<void>;
  /** Archives and clears the room chat of the match a room is leaving (the transcripts module's archiveAndClear). */
  onReassign?: (room: { channelId: string; name: string | null; origin: 'created' | 'adopted' }, previous: PreviousBinding, reason: 'reassigned') =>
    Promise<{ warning?: string | null } | void>;
  /** A match was bound to a room (the runtime emits matchRoomAssigned). */
  onBound?: (eventId: string, matchId: MatchId, channelId: string) => void;
  audit?: Pick<OpsAuditStore, 'append'>;
  warn?: (message: string) => void;
  /** Throws when the runtime is stopping, so a long provision stops between Discord calls. */
  ensureActive?: () => void;
  now?: () => number;
}

export interface ProvisionInput {
  eventId: string;
  eventName: string | null;
  gameLabel: string | null;
  round: number;
  matches: Array<{ id: MatchId; pair: string[] }>;
  /** identity_map.roundRooms of the session. */
  savedRooms: Partial<Record<MatchId, string>>;
}

export interface RoomNaming { eventName: string | null; gameLabel: string | null; round: number }

const tableOf = (matchId: MatchId): number => Number(matchId.slice(1));

type Step =
  | { kind: 'skip'; match: MatchId; channelId: string }
  | { kind: 'use'; match: MatchId; pair: string[]; channel: RoomChannel; row: MatchRoomRow | null; register: boolean }
  | { kind: 'create'; match: MatchId; pair: string[]; replaces: MatchRoomRow | null };

export class MatchRoomPool {
  private readonly bound = new Map<MatchId, string>();
  private boundEventId: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PoolDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private active(): void { this.deps.ensureActive?.(); }

  /** One provision (or table creation) at a time. */
  /** One provision, table creation or clean-up at a time. */
  exclusive<T>(work: () => Promise<T>): Promise<T> { return this.serial(work); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => {});
    return run;
  }

  /** The name table k's room gets from the template (a custom name wins when the room has one). */
  async nameFor(table: number, matchId: MatchId, naming: RoomNaming, row?: MatchRoomRow | null): Promise<string> {
    if (row?.customName) return row.customName;
    const { template } = await this.deps.store.settings(this.deps.guildId);
    return renderMatchRoomName(template, { matchId, table, round: naming.round, eventName: naming.eventName, gameLabel: naming.gameLabel });
  }

  provision(input: ProvisionInput): Promise<Partial<Record<MatchId, string>>> {
    return this.serial(() => this.provisionNow(input));
  }

  private async provisionNow(input: ProvisionInput): Promise<Partial<Record<MatchId, string>>> {
    const { store, discord, guildId } = this.deps;
    if (this.boundEventId !== input.eventId) { this.bound.clear(); this.boundEventId = input.eventId; }
    const rows = await store.rooms(guildId);
    const steps: Step[] = [];
    for (const match of input.matches) {
      this.active();
      const savedId = input.savedRooms[match.id];
      if (savedId && this.bound.get(match.id) === savedId) { steps.push({ kind: 'skip', match: match.id, channelId: savedId }); continue; }
      const table = tableOf(match.id);
      const tableRow = rows.find(row => row.tableNo === table) ?? null;
      const voice = async (channelId: string | undefined): Promise<RoomChannel | null> => {
        if (!channelId) return null;
        const channel = await discord.get(channelId);
        return channel?.kind === 'voice' ? channel : null;
      };
      const taken = (channelId: string) => steps.some(step => step.kind !== 'create' && (step.kind === 'skip' ? step.channelId : step.channel.id) === channelId);
      let picked = await voice(savedId);
      if (!picked) picked = await voice(this.deps.legacyChannels?.()?.[match.id]);
      if (picked && taken(picked.id)) picked = null;
      if (!picked && tableRow) {
        picked = await voice(tableRow.channelId);
        if (picked && taken(picked.id)) picked = null;
        if (!picked && tableRow.missingSinceMs === null)
          await store.updateRoom(guildId, tableRow.channelId, { missingSinceMs: this.now(), desiredName: null, nextRenameAtMs: null });
      }
      if (picked) {
        const row = rows.find(item => item.channelId === picked!.id) ?? null;
        // A channel the pool does not know yet joins it as table k, unless that table already has another room.
        steps.push({ kind: 'use', match: match.id, pair: match.pair, channel: picked, row, register: !row && !tableRow });
      } else steps.push({ kind: 'create', match: match.id, pair: match.pair,
        replaces: tableRow });
    }
    await this.checkCapacity(steps, input);
    const result: Partial<Record<MatchId, string>> = {};
    const botId = discord.botUserId();
    if (!botId) throw new RuleError('The bot is not connected to Discord yet.');
    for (const step of steps) {
      this.active();
      if (step.kind === 'skip') { result[step.match] = step.channelId; continue; }
      const channelId = step.kind === 'create' ? await this.create(step, input, botId) : await this.use(step, input, botId);
      this.bound.set(step.match, channelId);
      result[step.match] = channelId;
    }
    const unbound = input.matches.filter(match => !result[match.id]);
    if (unbound.length) throw new RuleError(`Match rooms could not be assigned for ${unbound.map(match => match.id).join(', ')}.`);
    return result;
  }

  /** Refuses before creating anything when the server would pass Discord's channel limit. */
  private async checkCapacity(steps: Step[], input: ProvisionInput): Promise<void> {
    const creating = steps.filter((step): step is Extract<Step, { kind: 'create' }> => step.kind === 'create');
    if (!creating.length) return;
    const { discord, categories } = this.deps;
    const first = creating[0]!.match;
    if (!discord.canManageChannels()) throw new RuleError(`The bot needs Manage Channels to create the ${first} voice room.`);
    const categoriesNeeded = await categories.missingCount(creating.map(step => tableOf(step.match)));
    const free = MATCH_ROOM_LIMITS.serverChannels - (await discord.list()).length;
    const needed = creating.length + categoriesNeeded;
    if (needed > free) throw new RuleError(`Discord allows ${MATCH_ROOM_LIMITS.serverChannels} channels per server and ${free <= 0 ? 'none' : `only ${free}`} ` +
      `${free === 1 ? 'is' : 'are'} free; this round needs ${needed} new ${needed === 1 ? 'channel' : 'channels'} for ${input.matches.length} match rooms. ` +
      'Delete channels you do not need, or clean up old match rooms, then try again.');
  }

  private async create(step: Extract<Step, { kind: 'create' }>, input: ProvisionInput, botId: string): Promise<string> {
    const table = tableOf(step.match);
    const room = await this.createRoom(table, step.match, step.pair, input, botId, step.replaces);
    // A room made for this match has no earlier match to archive and needs no rename: it was born with its name.
    await this.deps.bindings.bind(input.eventId, step.match, room.channelId);
    this.deps.onBound?.(input.eventId, step.match, room.channelId);
    return room.channelId;
  }

  /** Creates table k's room with its name and permissions in one call, in the table's category, and records it in the pool. */
  private async createRoom(table: number, matchId: MatchId, pair: string[], naming: RoomNaming, botId: string,
    replaces: MatchRoomRow | null): Promise<{ channelId: string; name: string }> {
    const { discord, store, guildId } = this.deps;
    const name = await this.nameFor(table, matchId, naming);
    const categoryId = await this.deps.categories.ensure(categoryRangeForTable(table).index, naming.gameLabel);
    this.active();
    const channel = await discord.createVoice({ name, parentId: categoryId, reason: 'TCG Live match room',
      overwrites: roomPlan(guildId, botId, this.deps.adminId, pair) }).catch(error => {
      // 30013: Discord's limit of 50 channels in one category.
      if ((error as { code?: number } | null)?.code === 30013) throw new RuleError('The room category is full: Discord allows 50 channels in a category. Move some channels out of it, or choose another category in Settings.');
      throw error;
    });
    // The replaced (missing) room frees its table number.
    if (replaces) await store.removeRoom(guildId, replaces.channelId);
    await store.insertRoom({ guildId, channelId: channel.id, applicationId: this.deps.applicationId, tableNo: table, categoryId,
      origin: 'created', customName: null, appliedName: channel.name, desiredName: null, originalName: null, renameLog: [],
      nextRenameAtMs: null, renameError: null, missingSinceMs: null, createdAtMs: this.now() });
    await this.audit('match_rooms.created', { channelId: channel.id, table, categoryId, ...(replaces ? { replaced: replaces.channelId } : {}) });
    return { channelId: channel.id, name: channel.name };
  }

  private async use(step: Extract<Step, { kind: 'use' }>, input: ProvisionInput, botId: string): Promise<string> {
    const { discord, store, guildId } = this.deps;
    const { channel } = step;
    const table = tableOf(step.match);
    const savedId = input.savedRooms[step.match];
    const newlyBound = channel.id !== savedId;
    let row = step.row;
    if (step.register) {
      row = { guildId, channelId: channel.id, applicationId: this.deps.applicationId, tableNo: table, categoryId: channel.parentId,
        origin: legacyCreatedName(this.deps.applicationId).test(channel.name) ? 'created' : 'adopted', customName: null,
        appliedName: channel.name, desiredName: null, originalName: channel.name, renameLog: [], nextRenameAtMs: null,
        renameError: null, missingSinceMs: null, createdAtMs: this.now() };
      await store.insertRoom(row);
      await this.audit('match_rooms.adopted', { channelId: channel.id, table });
    }
    if (newlyBound) {
      const previous = await this.deps.bindings.previous(channel.id, input.eventId).catch(() => {
        this.deps.warn?.(`The earlier match of room ${channel.name} could not be looked up, so its chat was not archived.`);
        return null;
      });
      if (previous && this.deps.onReassign) {
        try {
          const outcome = await this.deps.onReassign({ channelId: channel.id, name: channel.name, origin: row?.origin ?? 'adopted' }, previous, 'reassigned');
          if (outcome?.warning) this.deps.warn?.(outcome.warning);
        } catch (error) {
          this.deps.warn?.(`The chat of room ${channel.name} could not be archived before it was reused: ${error instanceof Error ? error.message : 'unknown error'}.`);
        }
      }
    }
    const current = await discord.overwrites(channel.id);
    const desired = roomPlan(guildId, botId, this.deps.adminId, step.pair, botHasManageRoles(current, botId));
    if (!sameOverwrites(current, desired)) {
      await this.deps.backup(guildId, channel.id, current);
      this.active();
      await discord.setOverwrites(channel.id, desired, 'TCG Live match room policy');
    }
    if (newlyBound) {
      await this.deps.bindings.bind(input.eventId, step.match, channel.id);
      this.deps.onBound?.(input.eventId, step.match, channel.id);
    }
    if (row) await this.settle(row, channel, step.match, table, input, newlyBound);
    return channel.id;
  }

  /**
   * Keeps the pool row in step with the channel. A rename is queued only when the room is newly bound to this event:
   * restarting in the middle of a round never renames anything.
   */
  private async settle(row: MatchRoomRow, channel: RoomChannel, matchId: MatchId, table: number, naming: RoomNaming, newlyBound: boolean): Promise<void> {
    const { store, guildId } = this.deps;
    await store.updateRoom(guildId, row.channelId, current => ({
      categoryId: channel.parentId, missingSinceMs: null,
      originalName: current.originalName ?? (current.origin === 'adopted' ? channel.name : null),
      appliedName: current.appliedName ?? channel.name
    }));
    if (!newlyBound) return;
    const desired = await this.nameFor(table, matchId, naming, row);
    if (desired === channel.name) {
      await store.updateRoom(guildId, row.channelId, { appliedName: channel.name, desiredName: null, nextRenameAtMs: null, renameError: null });
    } else {
      // The queue compares with the applied name, which is what Discord shows right now.
      await store.updateRoom(guildId, row.channelId, { appliedName: channel.name });
      await this.deps.queue.request(row.channelId, desired);
    }
  }

  /** Creates the missing tables 1..count (replacing rooms that are gone), without binding them to any match. */
  ensureTables(count: number, naming: RoomNaming): Promise<string[]> {
    return this.serial(async () => {
      const { store, discord, guildId } = this.deps;
      const rows = await store.rooms(guildId);
      const todo: Array<{ table: number; replaces: MatchRoomRow | null }> = [];
      for (let table = 1; table <= count; table++) {
        this.active();
        const row = rows.find(item => item.tableNo === table) ?? null;
        if (row) {
          const channel = await discord.get(row.channelId);
          if (channel?.kind === 'voice') continue;
          if (row.missingSinceMs === null) await store.updateRoom(guildId, row.channelId, { missingSinceMs: this.now(), desiredName: null, nextRenameAtMs: null });
        }
        todo.push({ table, replaces: row });
      }
      if (!todo.length) return [];
      const botId = discord.botUserId();
      if (!botId) throw new RuleError('The bot is not connected to Discord yet.');
      if (!discord.canManageChannels()) throw new RuleError('The bot needs Manage Channels to create match rooms.');
      const needed = todo.length + await this.deps.categories.missingCount(todo.map(item => item.table));
      const free = MATCH_ROOM_LIMITS.serverChannels - (await discord.list()).length;
      if (needed > free) throw new RuleError(`Discord allows ${MATCH_ROOM_LIMITS.serverChannels} channels per server and ${free <= 0 ? 'none' : `only ${free}`} ` +
        `${free === 1 ? 'is' : 'are'} free; creating ${count} tables needs ${needed} new channels.`);
      const created: string[] = [];
      for (const item of todo) {
        this.active();
        created.push((await this.createRoom(item.table, `M${item.table}` as MatchId, [], naming, botId, item.replaces)).channelId);
      }
      return created;
    });
  }

  private async audit(kind: 'match_rooms.created' | 'match_rooms.adopted', payload: Record<string, unknown>): Promise<void> {
    try { await this.deps.audit?.append({ kind, actor: { kind: 'bot', id: 'bot' }, guildId: this.deps.guildId, payload }); }
    catch { /* The audit never blocks provisioning. */ }
  }
}
