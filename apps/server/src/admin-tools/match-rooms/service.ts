// The match rooms service: what the dashboard routes (and the runtime, and the demo) talk to. It assembles the pool, the
// rename queue, the categories, the clean-up and the transcripts behind MatchRoomService (service-port.ts).
//
// Audit split: this module and the pool audit what the bot does by itself (rooms it creates, renames the queue sends or sees,
// clean-up, transcripts). The routes audit what a person asks for (settings, custom names, adopt, forget, ensure), with the
// actor of the request.
import { MATCH_ROOM_LIMITS, renderMatchRoomName, validMatchRoomName, validateMatchRoomTemplate, type BaselineChannelDto,
  type CleanupPlanDto, type CleanupResultDto, type MatchId, type MatchRoomCategoryDto, type MatchRoomDto, type MatchRoomsDto,
  type MatchRoomTranscriptDto, type MatchRoomTranscriptSummaryDto, type SaveMatchRoomSettingsRequestDto, type SetupMatchRoomsDto,
  type Snowflake, type VoiceRoomStatus } from '@tcg-live/core';
import type { Client, Guild } from 'discord.js';
import { backupRoomOverwrites, readRoomOverwritesBackup, type RoomOverwrite } from '../../discord/match-rooms.js';
import type { PrivateDiscordConfig } from '../../discord/config.js';
import { bindRoundRoom, getSessionState } from '../../discord/session.js';
import type { ModerationSettingsStore } from '../../moderation/settings.js';
import type { OpsAuditStore } from '../../ops/audit.js';
import { OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { SNOWFLAKE } from '../../ops/http.js';
import { RuleError, signupTournamentComplete } from '../../rehearsal/domain.js';
import { withClient } from '../../rehearsal/store.js';
import { RoomCategories } from './categories.js';
import { buildCleanupPlan, executeCleanup, type CleanupPlanInput, type CleanupRoomInput } from './cleanup.js';
import { captureBaseline, migrateLegacyRooms } from './migrate.js';
import { demoMatchRoomDiscord, demoRoomRenamer, liveMatchRoomDiscord, liveRoomRenamer, type MatchRoomDiscord, type RoomChannel,
  type RoomRenamer } from './port.js';
import { MatchRoomPool, type PreviousBinding, type RoomBindings, type RoomNaming } from './pool.js';
import { renameStateOf, RoomRenameQueue, type QueueClock } from './renames.js';
import type { MatchRoomSetupSink, MatchRoomService } from './service-port.js';
import { MemoryMatchRoomStore, pgMatchRoomStore, scopedToApplication, type MatchRoomRow, type MatchRoomStore } from './store.js';
import { archiveAndClear, liveRoomChatPort, type AuditFn, type RoomChatPort, type TranscriptStore } from './transcripts.js';

export const GAME_LABELS: Record<string, string> = { pokemon: 'Pokémon', 'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man' };
export const MEMORY_STORAGE_HINT = 'Room settings are not saved yet: run npm start (or npm run db:admin-tools-setup) to set up room storage.';
const NO_EVENT = '00000000-0000-0000-0000-000000000000';

/** What the service needs to know about the running tournament. */
export interface ActiveEventInfo {
  eventId: string;
  eventName: string | null;
  gameLabel: string | null;
  round: number;
  roundRooms: Partial<Record<MatchId, string>>;
  /** Every match is final. A finished event stays the active session until the next signup, but its rooms are free. */
  finished?: boolean;
}

export interface MatchRoomSystemInput {
  guildId: string;
  applicationId: string;
  adminId: string;
  store: MatchRoomStore;
  discord: MatchRoomDiscord;
  renamer: RoomRenamer;
  bindings: RoomBindings;
  legacyChannels?: () => Partial<Record<MatchId, string>> | undefined;
  activeEvent: () => Promise<ActiveEventInfo | null>;
  backup?: (guildId: string, channelId: string, overwrites: readonly RoomOverwrite[]) => Promise<void>;
  readBackup?: (guildId: string, channelId: string) => Promise<RoomOverwrite[] | null>;
  chat: RoomChatPort;
  transcripts: TranscriptStore;
  audit: Pick<OpsAuditStore, 'append'>;
  /** The voice runtime's recording state for a room, when it knows. */
  recording?: (channelId: string) => VoiceRoomStatus | null;
  /** Drops the per-room voice settings of a room that was deleted (the Bots tab policies). */
  forgetVoiceRoom?: (channelId: string) => Promise<void>;
  onBound?: (eventId: string, matchId: MatchId, channelId: string) => void;
  /** The pool's rooms or categories changed (the runtime re-checks permissions). */
  onChange?: () => void;
  ensureActive?: () => void;
  warn?: (message: string) => void;
  clock?: QueueClock;
  now?: () => number;
  /** The demo keeps its rooms in memory on purpose: no "run npm start" hint. */
  demo?: boolean;
}

export interface MatchRoomSystem {
  service: MatchRoomService;
  pool: MatchRoomPool;
  queue: RoomRenameQueue;
  store: MatchRoomStore;
  /** Migrates the legacy rooms, captures the baseline, and starts the rename queue. Never throws. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The pool's room and category IDs as of the last refresh (synchronous, for the reserved-channel and permission checks). */
  channelIds(): string[];
  poolIds(): { categoryIds: string[]; roomChannelIds: string[] };
  refresh(): Promise<void>;
  /** A channelUpdate reported a new name for this channel. */
  observedRename(channelId: string, name: string): Promise<void>;
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

export function createMatchRoomSystem(input: MatchRoomSystemInput): MatchRoomSystem {
  const { guildId, discord } = input;
  const store = scopedToApplication(input.store, input.applicationId);
  const now = input.now ?? Date.now;
  const backup = input.backup ?? backupRoomOverwrites;
  const readBackup = input.readBackup ?? readRoomOverwritesBackup;
  const auditFn: AuditFn = (kind, payload, actor) => input.audit.append({ kind, actor, guildId, payload });
  let pooled = { categoryIds: [] as string[], roomChannelIds: [] as string[] };
  const refresh = async () => {
    try {
      const settings = await store.settings(guildId);
      pooled = { roomChannelIds: unique((await store.rooms(guildId)).map(row => row.channelId)),
        categoryIds: unique([...(await store.categories(guildId)).map(row => row.categoryId), ...(settings.categoryId ? [settings.categoryId] : [])]) };
    } catch { /* Keeps the last list. */ }
    input.onChange?.();
  };
  const queue = new RoomRenameQueue({ guildId, store, renamer: input.renamer, audit: input.audit,
    ...(input.clock ? { clock: input.clock } : {}), ...(input.warn ? { log: input.warn } : {}) });
  const categories = new RoomCategories({ guildId, store, discord, now, ...(input.warn ? { log: input.warn } : {}) });
  const pool = new MatchRoomPool({ guildId, applicationId: input.applicationId, adminId: input.adminId, store, discord, categories, queue,
    bindings: input.bindings, backup, audit: input.audit, now,
    ...(input.legacyChannels ? { legacyChannels: input.legacyChannels } : {}),
    ...(input.onBound ? { onBound: input.onBound } : {}),
    ...(input.warn ? { warn: input.warn } : {}),
    ...(input.ensureActive ? { ensureActive: input.ensureActive } : {}),
    // Before a reused room gets its next match, its chat is archived as a transcript and cleared.
    onReassign: (room, previous) => archiveAndClear({
      // An adopted room is the community's too: without a reliable start for that match its chat is archived but never cleared.
      chat: room.origin === 'adopted' && previous.startedAtMs === null
        ? { fetchMessages: (id, since) => input.chat.fetchMessages(id, since), bulkDelete: async () => ({ deleted: 0, skippedOld: 0 }) } : input.chat,
      store: input.transcripts, audit: auditFn }, room, previous, 'reassigned') });
  const service = new MatchRoomServiceImpl(input, { store, discord, categories, pool, queue, backup, readBackup, auditFn, refresh, now });
  return {
    service, pool, queue, store,
    async start() {
      try {
        const event = await input.activeEvent().catch(() => null);
        const migrated = await migrateLegacyRooms({ guildId, applicationId: input.applicationId, store, discord, backup,
          ...(input.legacyChannels?.() ? { legacyChannels: input.legacyChannels()! } : {}),
          ...(event ? { activeRoundRooms: event.roundRooms } : {}), now,
          ...(input.warn ? { log: input.warn } : {}) });
        if (migrated.adopted || migrated.created) input.warn?.(`Match rooms: ${migrated.adopted} existing room(s) adopted, ${migrated.created} found.`);
        await captureBaseline({ guildId, store, discord, now });
      } catch (error) { input.warn?.(`Match room setup is pending: ${error instanceof Error ? error.message : 'unknown error'}.`); }
      await refresh();
      await queue.start().catch(() => {});
    },
    async stop() { await queue.stop(); },
    channelIds: () => [...pooled.roomChannelIds, ...pooled.categoryIds],
    poolIds: () => ({ categoryIds: [...pooled.categoryIds], roomChannelIds: [...pooled.roomChannelIds] }),
    refresh,
    observedRename: (channelId, name) => queue.observed(channelId, name).catch(() => {})
  };
}

interface Parts {
  store: MatchRoomStore; discord: MatchRoomDiscord; categories: RoomCategories; pool: MatchRoomPool; queue: RoomRenameQueue;
  backup: NonNullable<MatchRoomSystemInput['backup']>; readBackup: NonNullable<MatchRoomSystemInput['readBackup']>;
  auditFn: AuditFn; refresh: () => Promise<void>; now: () => number;
}

class MatchRoomServiceImpl implements MatchRoomService {
  constructor(private readonly input: MatchRoomSystemInput, private readonly parts: Parts) {}

  private get guildId() { return this.input.guildId; }

  private async context(): Promise<{ event: ActiveEventInfo | null; naming: RoomNaming }> {
    const found = await this.input.activeEvent().catch(() => null);
    // A finished event's rooms are no longer in use: clean-up may take them, and they may be removed.
    const event = found?.finished ? { ...found, roundRooms: {} } : found;
    return { event, naming: { eventName: event?.eventName ?? null, gameLabel: event?.gameLabel ?? null, round: event?.round ?? 1 } };
  }

  private async channels(): Promise<RoomChannel[] | null> {
    try { return await this.parts.discord.list(); } catch { return null; }
  }

  private roomDto(row: MatchRoomRow, template: string, ctx: { event: ActiveEventInfo | null; naming: RoomNaming }, channels: RoomChannel[] | null): MatchRoomDto {
    const found = channels?.find(channel => channel.id === row.channelId) ?? null;
    const missing = row.missingSinceMs !== null || (channels !== null && !found);
    const assigned = ctx.event ? (Object.entries(ctx.event.roundRooms).find(([, id]) => id === row.channelId)?.[0] as MatchId | undefined) ?? null : null;
    const connected = missing ? null : this.parts.discord.occupants(row.channelId);
    const state = renameStateOf(row);
    const blocked = assigned ? `In use by ${assigned} in the active event.` : connected?.length ? 'Someone is connected to this room.' : null;
    return { channelId: row.channelId, table: row.tableNo, categoryId: found?.parentId ?? row.categoryId, origin: row.origin,
      name: found?.name ?? (channels ? null : row.appliedName), missing, customName: row.customName,
      templateName: renderMatchRoomName(template, { matchId: `M${row.tableNo}` as MatchId, table: row.tableNo, round: ctx.naming.round,
        eventName: ctx.naming.eventName, gameLabel: ctx.naming.gameLabel }),
      pendingName: row.desiredName,
      rename: { state, nextAttemptAtMs: row.desiredName === null ? null : row.nextRenameAtMs, error: state === 'failed' ? row.renameError : null },
      assignedMatch: assigned, connected, recording: this.input.recording?.(row.channelId) ?? null, removeBlockedReason: blocked };
  }

  async describe(): Promise<MatchRoomsDto> {
    const { store, discord } = this.parts;
    const [settings, categoryRows, rows, ctx, channels] = await Promise.all([store.settings(this.guildId), store.categories(this.guildId),
      store.rooms(this.guildId), this.context(), this.channels()]);
    const byId = new Map((channels ?? []).map(channel => [channel.id, channel]));
    const canManage = discord.canManageChannels();
    const problem = channels === null ? 'Discord is not reachable right now, so room names may be out of date.'
      : !canManage ? 'The bot needs Manage Channels to create match rooms.'
        : store.kind === 'memory' && !this.input.demo ? MEMORY_STORAGE_HINT : null;
    const createdRooms = new Set(rows.filter(row => row.origin === 'created').map(row => row.channelId));
    const createdCategories = new Set(categoryRows.filter(row => row.origin === 'created').map(row => row.categoryId));
    const pooled: MatchRoomCategoryDto[] = categoryRows.map(row => ({ categoryId: row.categoryId, name: byId.get(row.categoryId)?.name ?? null,
      from: row.rangeFrom, to: row.rangeTo, origin: row.origin, missing: channels !== null && !byId.has(row.categoryId) }));
    const baseline: BaselineChannelDto[] = (channels ?? []).flatMap(channel => channel.kind === 'voice' || channel.kind === 'stage' || channel.kind === 'category'
      ? [{ id: channel.id, name: channel.name, type: channel.kind, inBaseline: settings.baselineChannelIds.includes(channel.id),
        botCreated: createdRooms.has(channel.id) || createdCategories.has(channel.id) }] : []);
    return { guildId: this.guildId, storage: store.kind === 'postgres' ? 'postgres' : this.input.demo ? 'demo' : 'memory', canManageChannels: canManage, problem,
      activeEventId: ctx.event?.eventId ?? null, eventName: ctx.event?.eventName ?? null, gameLabel: ctx.event?.gameLabel ?? null,
      round: ctx.naming.round, freeChannelSlots: channels ? Math.max(0, MATCH_ROOM_LIMITS.serverChannels - channels.length) : null,
      settings: { version: settings.version, template: settings.template, categoryId: settings.categoryId,
        categoryName: settings.categoryId ? byId.get(settings.categoryId)?.name ?? null : null,
        pendingCategoryName: settings.pendingCategoryName, baselineChannelIds: [...settings.baselineChannelIds],
        baselineCapturedAtMs: settings.baselineCapturedAtMs },
      categories: pooled, rooms: rows.map(row => this.roomDto(row, settings.template, ctx, channels)), baseline };
  }

  async saveSettings(req: SaveMatchRoomSettingsRequestDto): Promise<MatchRoomsDto> {
    const { store, discord, categories, queue } = this.parts;
    if (!req || typeof req !== 'object') throw new OpsInputError('Send the room settings.');
    if (!Number.isInteger(req.expectedVersion) || req.expectedVersion < 1) throw new OpsInputError('Reload the room settings and try again.');
    const templateProblem = validateMatchRoomTemplate(req.template);
    if (templateProblem) throw new OpsInputError(templateProblem);
    const template = req.template.trim();
    if (req.categoryId !== null && (typeof req.categoryId !== 'string' || !SNOWFLAKE.test(req.categoryId))) throw new OpsInputError('Choose a category from the list.');
    let pendingName: string | null = null;
    if (req.createCategory !== null) {
      if (req.categoryId !== null) throw new OpsInputError('Choose a category or create one, not both.');
      const problem = validMatchRoomName(req.createCategory);
      if (problem) throw new OpsInputError(`Category name: ${problem}`);
      pendingName = req.createCategory.trim();
    }
    if (!Array.isArray(req.baselineChannelIds) || req.baselineChannelIds.length > 2_000 ||
        req.baselineChannelIds.some(id => typeof id !== 'string' || !SNOWFLAKE.test(id))) throw new OpsInputError('The server baseline must be a list of channel IDs.');
    if (req.categoryId) {
      const channel = await discord.get(req.categoryId).catch(() => null);
      if (channel?.kind !== 'category') throw new OpsInputError('That is not a category in this server.');
    }
    const before = await store.settings(this.guildId);
    const saved = await store.saveSettings(this.guildId, req.expectedVersion, { template, categoryId: req.categoryId,
      pendingCategoryName: pendingName, baselineChannelIds: unique(req.baselineChannelIds) }, this.parts.now());
    await categories.configure(saved.categoryId);
    if (before.template !== saved.template) {
      // A template change renames right away, through the queue (never faster than Discord allows).
      const ctx = await this.context();
      for (const row of await store.rooms(this.guildId)) {
        if (row.customName || row.missingSinceMs !== null) continue;
        // Adopted rooms that are not in a running match settle at their next binding: a restore must not be undone.
        if (row.origin !== 'created' && !Object.values(ctx.event?.roundRooms ?? {}).includes(row.channelId)) continue;
        await queue.request(row.channelId, renderMatchRoomName(saved.template, { matchId: `M${row.tableNo}` as MatchId, table: row.tableNo,
          round: ctx.naming.round, eventName: ctx.naming.eventName, gameLabel: ctx.naming.gameLabel }));
      }
    }
    await this.parts.refresh();
    return this.describe();
  }

  private async find(channelId: string): Promise<MatchRoomRow> {
    if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) throw new OpsInputError('That is not a channel ID.');
    const row = (await this.parts.store.rooms(this.guildId)).find(item => item.channelId === channelId);
    if (!row) throw new OpsNotFoundError('That room is not in the pool.');
    return row;
  }

  async setCustomName(channelId: string, customName: string | null): Promise<MatchRoomDto> {
    const { store, queue } = this.parts;
    const row = await this.find(channelId);
    const name = customName === null ? null : customName.trim();
    if (name !== null) {
      const problem = validMatchRoomName(name);
      if (problem) throw new OpsInputError(problem);
    }
    await store.updateRoom(this.guildId, channelId, { customName: name });
    const [settings, ctx] = await Promise.all([store.settings(this.guildId), this.context()]);
    // Never awaits Discord: the queue sends it when the channel's rename budget allows.
    await queue.request(channelId, name ?? renderMatchRoomName(settings.template, { matchId: `M${row.tableNo}` as MatchId, table: row.tableNo,
      round: ctx.naming.round, eventName: ctx.naming.eventName, gameLabel: ctx.naming.gameLabel }));
    const updated = (await store.rooms(this.guildId)).find(item => item.channelId === channelId)!;
    return this.roomDto(updated, settings.template, ctx, await this.channels());
  }

  async ensureTables(count: number): Promise<{ created: Snowflake[]; rooms: MatchRoomsDto }> {
    if (!Number.isInteger(count) || count < 1 || count > MATCH_ROOM_LIMITS.serverChannels) throw new OpsInputError(`Choose between 1 and ${MATCH_ROOM_LIMITS.serverChannels} tables.`);
    const created = await this.parts.pool.ensureTables(count, (await this.context()).naming);
    await this.parts.refresh();
    return { created, rooms: await this.describe() };
  }

  async adopt(channelId: string): Promise<MatchRoomDto> {
    const { store, discord } = this.parts;
    if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) throw new OpsInputError('That is not a channel ID.');
    const rows = await store.rooms(this.guildId);
    if (rows.some(row => row.channelId === channelId)) throw new RuleError('That room is already in the pool.');
    const channel = await discord.get(channelId);
    if (!channel) throw new OpsNotFoundError('That channel was not found in this server.');
    if (channel.kind !== 'voice') throw new OpsInputError('Only voice channels can be match rooms.');
    if (channel.id === discord.afkChannelId()) throw new OpsInputError('The AFK channel cannot be a match room.');
    let table = 1;
    while (rows.some(row => row.tableNo === table)) table += 1;
    // The room's own name and permissions are saved first, so clean-up can put them back.
    try { await this.parts.backup(this.guildId, channel.id, await discord.overwrites(channel.id)); }
    catch { throw new RuleError('The room permissions could not be saved first, so the room was not added.'); }
    await store.insertRoom({ guildId: this.guildId, channelId: channel.id, applicationId: this.input.applicationId, tableNo: table,
      categoryId: channel.parentId, origin: 'adopted', customName: null, appliedName: channel.name, desiredName: null,
      originalName: channel.name, renameLog: [], nextRenameAtMs: null, renameError: null, missingSinceMs: null, createdAtMs: this.parts.now() });
    await this.parts.refresh();
    const [settings, ctx] = await Promise.all([store.settings(this.guildId), this.context()]);
    return this.roomDto((await store.rooms(this.guildId)).find(item => item.channelId === channel.id)!, settings.template, ctx, await this.channels());
  }

  async forget(channelId: string): Promise<void> {
    const row = await this.find(channelId);
    const ctx = await this.context();
    const dto = this.roomDto(row, (await this.parts.store.settings(this.guildId)).template, ctx, await this.channels());
    if (dto.removeBlockedReason) throw new RuleError(dto.removeBlockedReason);
    await this.parts.store.removeRoom(this.guildId, channelId);
    await this.parts.refresh();
  }

  // ---- Clean-up ----

  private async cleanupInput(): Promise<CleanupPlanInput> {
    const { store, discord } = this.parts;
    const [settings, rows, categoryRows, ctx] = await Promise.all([store.settings(this.guildId), store.rooms(this.guildId),
      store.categories(this.guildId), this.context()]);
    const rooms: CleanupRoomInput[] = [];
    const occupancy: Record<string, number | null> = {};
    const backups: Record<string, unknown> = {};
    for (const row of rows) {
      let channel: RoomChannel | null | undefined;
      try { channel = await discord.get(row.channelId); } catch { channel = undefined; }
      const missing = row.missingSinceMs !== null || channel === null;
      occupancy[row.channelId] = channel === undefined ? null : missing ? 0 : discord.occupants(row.channelId)?.length ?? null;
      if (row.origin === 'adopted' && await this.parts.readBackup(this.guildId, row.channelId)) backups[row.channelId] = true;
      rooms.push({ channelId: row.channelId, name: channel?.name ?? row.appliedName, origin: row.origin, categoryId: row.categoryId,
        originalName: row.originalName, missing,
        boundEventId: ctx.event && Object.values(ctx.event.roundRooms).includes(row.channelId) ? ctx.event.eventId : null,
        binding: await this.input.bindings.previous(row.channelId, NO_EVENT).catch(() => null) });
    }
    const cleanupCategories = [];
    for (const row of categoryRows) {
      let channel: RoomChannel | null | undefined;
      try { channel = await discord.get(row.categoryId); } catch { channel = undefined; }
      cleanupCategories.push({ categoryId: row.categoryId, name: channel?.name ?? null, origin: row.origin, missing: channel === null });
    }
    return { rooms, categories: cleanupCategories, baselineIds: settings.baselineChannelIds, activeEventId: ctx.event?.eventId ?? null,
      occupancy, overwriteBackups: backups };
  }

  async cleanupPlan(): Promise<CleanupPlanDto> { return buildCleanupPlan(await this.cleanupInput()); }

  async cleanupConfirm(planToken: string, actor?: Parameters<typeof executeCleanup>[3]): Promise<CleanupResultDto> {
    if (typeof planToken !== 'string' || !planToken) throw new OpsInputError('Review the clean-up preview first.');
    // Never at the same time as a round provisioning rooms or tables being created.
    return this.parts.pool.exclusive(() => this.cleanupNow(planToken, actor));
  }

  private async cleanupNow(planToken: string, actor?: Parameters<typeof executeCleanup>[3]): Promise<CleanupResultDto> {
    const { store, discord, queue } = this.parts;
    // Rebuilt from the current state; executeCleanup refuses the token when the plan changed since the preview.
    const plan = await this.cleanupPlan();
    const result = await executeCleanup({
      chat: this.input.chat, store: this.input.transcripts, audit: this.parts.auditFn,
      channels: {
        deleteChannel: (channelId, reason) => discord.deleteChannel(channelId, reason),
        async childCount(categoryId) {
          if (!await discord.get(categoryId)) return null;
          return (await discord.list()).filter(channel => channel.parentId === categoryId).length;
        }
      },
      bindingOf: channelId => this.input.bindings.previous(channelId, NO_EVENT),
      renames: { request: async (channelId, name) => { await queue.request(channelId, name); } },
      restoreOverwrites: async channelId => {
        const saved = await this.parts.readBackup(this.guildId, channelId);
        if (saved) await discord.setOverwrites(channelId, saved, 'TCG Live clean-up');
      },
      dropRoom: async channelId => {
        await store.removeRoom(this.guildId, channelId);
        await this.input.forgetVoiceRoom?.(channelId).catch(() => {});
      },
      dropCategory: async categoryId => {
        await store.removeCategory(this.guildId, categoryId);
        const settings = await store.settings(this.guildId);
        if (settings.categoryId === categoryId) await store.patchSettings(this.guildId, { categoryId: null }, this.parts.now());
      }
    }, plan, planToken, actor);
    await this.parts.refresh();
    return result;
  }

  // ---- Transcripts ----

  async transcripts(eventId: string, matchId?: MatchId): Promise<MatchRoomTranscriptSummaryDto[]> {
    if (typeof eventId !== 'string' || !eventId) throw new OpsInputError('Choose an event.');
    return this.input.transcripts.list(eventId, matchId);
  }

  async transcript(id: string): Promise<MatchRoomTranscriptDto> {
    const found = await this.input.transcripts.get(id);
    if (!found) throw new OpsNotFoundError('That transcript does not exist (it may have passed its retention).');
    return found;
  }

  async setTranscriptHold(id: string, hold: boolean): Promise<void> {
    if (typeof hold !== 'boolean') throw new OpsInputError('Choose whether to hold the transcript.');
    if (!await this.input.transcripts.setHold(id, hold)) throw new OpsNotFoundError('That transcript does not exist (it may have passed its retention).');
  }
}

// ---- Setup ----

/** Setup's way to hand the category choice to the room settings. Store only: it works before the bot is connected. */
export function matchRoomSetupSink(store: MatchRoomStore, now: () => number = Date.now): MatchRoomSetupSink {
  return {
    async applySetup(guildId, _applicationId, choice: SetupMatchRoomsDto) {
      const current = await store.settings(guildId);
      if (choice.categoryId) await store.patchSettings(guildId, { categoryId: choice.categoryId, pendingCategoryName: null }, now());
      else if (choice.createCategory && !current.categoryId) await store.patchSettings(guildId, { pendingCategoryName: 'TCG Live — Matches' }, now());
    }
  };
}

/** Drops a deleted room's per-room voice settings (the Bots tab policies) from the moderation settings. */
export function voiceRoomPolicyDropper(settings: Pick<ModerationSettingsStore, 'get' | 'put'>, guildId: string): (channelId: string) => Promise<void> {
  return async channelId => {
    const current = await settings.get(guildId);
    const rooms = current.voice.rooms;
    if (!rooms?.[channelId]) return;
    const { [channelId]: _dropped, ...rest } = rooms;
    await settings.put(guildId, current.version, { ...current, voice: { ...current.voice, rooms: rest } }, { kind: 'bot', id: 'bot' });
  };
}

// ---- Live ----

/** The setup profile's way into the room settings (guided setup calls applySetup at finish). */
export const pgMatchRoomSetupSink = (): MatchRoomSetupSink => matchRoomSetupSink(pgMatchRoomStore());

export const gameLabelOf = (game: string | null | undefined): string | null => game ? GAME_LABELS[game] ?? game : null;

/** The tournament that is running, from the session (null when there is none or the database is down). */
export function liveActiveEvent(config: PrivateDiscordConfig): () => Promise<ActiveEventInfo | null> {
  return async () => {
    try {
      const { session, state } = await getSessionState(config);
      return { eventId: state.id, eventName: session.tournament?.name ?? null, gameLabel: gameLabelOf(session.tournament?.game ?? state.game),
        round: 1, roundRooms: { ...session.identity_map.roundRooms }, finished: signupTournamentComplete(state) };
    } catch { return null; }
  };
}

/** The per-event binding stays where it always was: identity_map.roundRooms of the session. */
export function liveRoomBindings(config: PrivateDiscordConfig): RoomBindings {
  return {
    bind: (eventId, matchId, channelId) => bindRoundRoom(config, eventId, matchId, channelId),
    async previous(channelId, exceptEventId) {
      const found = await withClient(client => client.query<{ event_id: string; match_id: string; bound_at_ms: string | null }>(
        `SELECT s.event_id, r.key AS match_id, s.identity_map->'roundRoomBoundAtMs'->>r.key AS bound_at_ms
         FROM public.tcg_rehearsal_sessions s, LATERAL jsonb_each_text(COALESCE(s.identity_map->'roundRooms', '{}'::jsonb)) r
         WHERE r.value = $1 AND s.event_id <> $2::uuid ORDER BY s.created_at_ms DESC LIMIT 1`, [channelId, exceptEventId]));
      const row = found.rows[0];
      // The time the room was bound to that match; sessions from before it was recorded have none (null: no reliable start).
      return row ? { eventId: row.event_id, matchId: row.match_id as MatchId, startedAtMs: row.bound_at_ms === null ? null : Number(row.bound_at_ms) } : null;
    }
  };
}

export interface LiveMatchRoomInput {
  client: () => Client;
  guild: Guild;
  config: PrivateDiscordConfig;
  store: MatchRoomStore;
  transcripts: TranscriptStore;
  audit: Pick<OpsAuditStore, 'append'>;
  /** Room renames: the dedicated REST instance (sdk.ts matchRoomRenameRest). */
  rest: Parameters<typeof liveRoomRenamer>[0];
  voiceStates: boolean;
  recording?: MatchRoomSystemInput['recording'];
  forgetVoiceRoom?: MatchRoomSystemInput['forgetVoiceRoom'];
  onBound?: MatchRoomSystemInput['onBound'];
  onChange?: MatchRoomSystemInput['onChange'];
  ensureActive?: () => void;
  warn?: (message: string) => void;
}

/** The pool, its rename queue and the service over the live Discord client. */
export function liveMatchRoomService(input: LiveMatchRoomInput): MatchRoomSystem {
  const { config } = input;
  return createMatchRoomSystem({ guildId: config.guildId, applicationId: config.applicationId, adminId: config.adminId, store: input.store,
    discord: liveMatchRoomDiscord(input.client, config.guildId, input.voiceStates), renamer: liveRoomRenamer(input.rest),
    bindings: liveRoomBindings(config), legacyChannels: () => config.matchChannels, activeEvent: liveActiveEvent(config),
    chat: liveRoomChatPort(input.guild), transcripts: input.transcripts, audit: input.audit,
    ...(input.recording ? { recording: input.recording } : {}), ...(input.forgetVoiceRoom ? { forgetVoiceRoom: input.forgetVoiceRoom } : {}),
    ...(input.onBound ? { onBound: input.onBound } : {}), ...(input.onChange ? { onChange: input.onChange } : {}),
    ...(input.ensureActive ? { ensureActive: input.ensureActive } : {}), ...(input.warn ? { warn: input.warn } : {}) });
}

// ---- Demo ----

/** In-memory bindings for the demo: which event a demo room served which match in last. */
export class MemoryRoomBindings implements RoomBindings {
  private readonly history: Array<{ channelId: string } & PreviousBinding> = [];
  constructor(private readonly clock: () => number = Date.now) {}
  async bind(eventId: string, matchId: MatchId, channelId: string): Promise<void> {
    this.history.push({ channelId, eventId, matchId, startedAtMs: this.clock() });
  }
  async previous(channelId: string, exceptEventId: string): Promise<PreviousBinding | null> {
    const found = [...this.history].reverse().find(item => item.channelId === channelId && item.eventId !== exceptEventId);
    return found ? { eventId: found.eventId, matchId: found.matchId, startedAtMs: found.startedAtMs } : null;
  }
}

export interface DemoMatchRoomInput {
  demo: Parameters<typeof demoMatchRoomDiscord>[0];
  applicationId: string;
  adminId: string;
  botId: string;
  audit: Pick<OpsAuditStore, 'append'>;
  chat: RoomChatPort;
  transcripts: TranscriptStore;
  activeEvent: () => Promise<ActiveEventInfo | null>;
  /** Rooms the demo server already has: they join the pool as table 1, 2, … with these names. */
  seed?: Array<{ channelId: string; table: number }>;
  forgetVoiceRoom?: MatchRoomSystemInput['forgetVoiceRoom'];
  clock?: QueueClock;
  /** How long a demo rename takes before it shows (default 1.5 s, so "queued" is visible). */
  renameDelayMs?: number;
  onChange?: MatchRoomSystemInput['onChange'];
}

/**
 * A memory pool on the synthetic server. Renames go through a transport that applies them after a short delay and enforces
 * 2 per 10 minutes on the real clock, so the queued state is visible in the dashboard.
 */
export async function demoMatchRoomService(input: DemoMatchRoomInput): Promise<MatchRoomSystem> {
  const store = new MemoryMatchRoomStore();
  const discord = demoMatchRoomDiscord(input.demo, { botId: input.botId });
  const guildId = input.demo.id;
  const clock = input.clock;
  for (const seed of input.seed ?? []) {
    const channel = await discord.get(seed.channelId);
    if (channel?.kind !== 'voice') continue;
    await store.insertRoom({ guildId, channelId: channel.id, applicationId: input.applicationId, tableNo: seed.table, categoryId: channel.parentId,
      origin: 'created', customName: null, appliedName: channel.name, desiredName: null, originalName: null, renameLog: [],
      nextRenameAtMs: null, renameError: null, missingSinceMs: null, createdAtMs: Date.now() });
  }
  const renamer = demoRoomRenamer((channelId, name) => discord.rename(channelId, name),
    { ...(input.renameDelayMs !== undefined ? { delayMs: input.renameDelayMs } : {}), ...(clock ? { clock: { now: () => clock.now(), setTimeout: (cb, ms) => clock.setTimeout(cb, ms) } } : {}) });
  const system = createMatchRoomSystem({ guildId, applicationId: input.applicationId, adminId: input.adminId, store, discord, renamer,
    bindings: new MemoryRoomBindings(), activeEvent: input.activeEvent, backup: async () => {}, readBackup: async () => null,
    chat: input.chat, transcripts: input.transcripts, audit: input.audit,
    ...(input.forgetVoiceRoom ? { forgetVoiceRoom: input.forgetVoiceRoom } : {}),
    demo: true, ...(clock ? { clock } : {}), ...(input.onChange ? { onChange: input.onChange } : {}) });
  return system;
}
