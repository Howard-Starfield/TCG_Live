// Storage for the match room pool (migration 017): the guild's naming settings, the categories the pool uses and one row
// per room ("table"). The transcripts table of the same migration belongs to the transcripts module.
import type pg from 'pg';
import { MATCH_ROOM_DEFAULT_TEMPLATE } from '@tcg-live/core';
import { OpsConflictError } from '../../ops/errors.js';
import { RuleError } from '../../rehearsal/domain.js';
import { transaction, withClient } from '../../rehearsal/store.js';
import { requireMatchRoomsSchema } from '../schema.js';

export interface MatchRoomSettingsRow {
  guildId: string;
  version: number;
  template: string;
  categoryId: string | null;
  pendingCategoryName: string | null;
  baselineChannelIds: string[];
  baselineCapturedAtMs: number | null;
  updatedAtMs: number;
}

export interface MatchRoomCategoryRow {
  guildId: string;
  categoryId: string;
  rangeFrom: number;
  rangeTo: number;
  origin: 'created' | 'configured';
  createdAtMs: number;
}

export interface MatchRoomRow {
  guildId: string;
  channelId: string;
  applicationId: string;
  tableNo: number;
  categoryId: string | null;
  origin: 'created' | 'adopted';
  /** A name the organizer chose, or a rename made in Discord. Wins over the template. */
  customName: string | null;
  /** The name the bot last set (or saw): what the channel is believed to be called. */
  appliedName: string | null;
  /** A rename waiting for its turn in the queue. */
  desiredName: string | null;
  /** An adopted room's name before the bot first renamed it. */
  originalName: string | null;
  /** The last (at most 4) times a rename of this channel was sent or seen, oldest first. */
  renameLog: number[];
  nextRenameAtMs: number | null;
  renameError: string | null;
  missingSinceMs: number | null;
  createdAtMs: number;
}

export type MatchRoomSettingsChange = Pick<MatchRoomSettingsRow, 'template' | 'categoryId' | 'pendingCategoryName' | 'baselineChannelIds'>;
export type MatchRoomSettingsPatch = Partial<Pick<MatchRoomSettingsRow, 'categoryId' | 'pendingCategoryName' | 'baselineChannelIds' | 'baselineCapturedAtMs'>>;
/** A fixed patch, or a function of the current row (the row is locked while it runs); null changes nothing. */
export type MatchRoomRowUpdate = Partial<Omit<MatchRoomRow, 'guildId' | 'channelId'>> | ((row: MatchRoomRow) => Partial<Omit<MatchRoomRow, 'guildId' | 'channelId'>> | null);

export interface MatchRoomStore {
  readonly kind: 'postgres' | 'memory';
  /** Throws (a RuleError) when the storage is not available, for example migration 017 has not run. */
  available(): Promise<void>;
  /** The saved settings, or the defaults (version 1) when none were saved. */
  settings(guildId: string): Promise<MatchRoomSettingsRow>;
  /** OpsConflictError when expectedVersion is not the current version. Bumps the version. */
  saveSettings(guildId: string, expectedVersion: number, change: MatchRoomSettingsChange, now: number): Promise<MatchRoomSettingsRow>;
  /** A system write (setup, baseline capture, a category the bot just created): no version change. */
  patchSettings(guildId: string, patch: MatchRoomSettingsPatch, now: number): Promise<MatchRoomSettingsRow>;
  categories(guildId: string): Promise<MatchRoomCategoryRow[]>;
  saveCategory(row: MatchRoomCategoryRow): Promise<void>;
  removeCategory(guildId: string, categoryId: string): Promise<void>;
  rooms(guildId: string): Promise<MatchRoomRow[]>;
  /** RuleError when the channel or its table number is already in the pool. */
  insertRoom(row: MatchRoomRow): Promise<void>;
  updateRoom(guildId: string, channelId: string, update: MatchRoomRowUpdate): Promise<MatchRoomRow | null>;
  removeRoom(guildId: string, channelId: string): Promise<boolean>;
}

export function defaultMatchRoomSettings(guildId: string, now = 0): MatchRoomSettingsRow {
  return { guildId, version: 1, template: MATCH_ROOM_DEFAULT_TEMPLATE, categoryId: null, pendingCategoryName: null,
    baselineChannelIds: [], baselineCapturedAtMs: null, updatedAtMs: now };
}

/**
 * The rooms of one bot application. Rows of another application in the same server are neither listed nor changed, so they are
 * never treated as ours (adopted by migration, shown, renamed or deleted by clean-up).
 */
export function scopedToApplication(store: MatchRoomStore, applicationId: string): MatchRoomStore {
  const mine = (row: MatchRoomRow) => row.applicationId === applicationId;
  return {
    kind: store.kind,
    available: () => store.available(),
    settings: guildId => store.settings(guildId),
    saveSettings: (guildId, version, change, now) => store.saveSettings(guildId, version, change, now),
    patchSettings: (guildId, patch, now) => store.patchSettings(guildId, patch, now),
    categories: guildId => store.categories(guildId),
    saveCategory: row => store.saveCategory(row),
    removeCategory: (guildId, categoryId) => store.removeCategory(guildId, categoryId),
    async rooms(guildId) { return (await store.rooms(guildId)).filter(mine); },
    insertRoom: row => store.insertRoom(row),
    updateRoom: (guildId, channelId, update) => store.updateRoom(guildId, channelId, current => {
      if (!mine(current)) return null;
      return typeof update === 'function' ? update(current) : update;
    }).then(async row => row && mine(row) ? row : null),
    async removeRoom(guildId, channelId) {
      const found = (await store.rooms(guildId)).find(row => row.channelId === channelId);
      return found && mine(found) ? store.removeRoom(guildId, channelId) : false;
    }
  };
}

const STALE = 'Room settings changed in another tab. Review the current settings and save again.';
const TAKEN = 'That room or table number is already in the pool.';

function applyUpdate(row: MatchRoomRow, update: MatchRoomRowUpdate): MatchRoomRow | null {
  const patch = typeof update === 'function' ? update(row) : update;
  return patch ? { ...row, ...patch } : null;
}

/** In-memory store: the fallback when migration 017 has not run, the demo and tests. */
export class MemoryMatchRoomStore implements MatchRoomStore {
  readonly kind = 'memory' as const;
  private readonly settingsByGuild = new Map<string, MatchRoomSettingsRow>();
  private readonly categoryRows = new Map<string, MatchRoomCategoryRow>();
  private readonly roomRows = new Map<string, MatchRoomRow>();

  async available(): Promise<void> {}

  async settings(guildId: string): Promise<MatchRoomSettingsRow> {
    const saved = this.settingsByGuild.get(guildId);
    return saved ? { ...saved, baselineChannelIds: [...saved.baselineChannelIds] } : defaultMatchRoomSettings(guildId);
  }

  async saveSettings(guildId: string, expectedVersion: number, change: MatchRoomSettingsChange, now: number): Promise<MatchRoomSettingsRow> {
    const current = await this.settings(guildId);
    if (current.version !== expectedVersion) throw new OpsConflictError(STALE);
    const next: MatchRoomSettingsRow = { ...current, ...change, baselineChannelIds: [...change.baselineChannelIds],
      version: current.version + 1, updatedAtMs: now };
    this.settingsByGuild.set(guildId, next);
    return { ...next, baselineChannelIds: [...next.baselineChannelIds] };
  }

  async patchSettings(guildId: string, patch: MatchRoomSettingsPatch, now: number): Promise<MatchRoomSettingsRow> {
    const current = await this.settings(guildId);
    const next = { ...current, ...patch, updatedAtMs: now };
    this.settingsByGuild.set(guildId, next);
    return { ...next, baselineChannelIds: [...next.baselineChannelIds] };
  }

  async categories(guildId: string): Promise<MatchRoomCategoryRow[]> {
    return [...this.categoryRows.values()].filter(row => row.guildId === guildId).sort((a, b) => a.rangeFrom - b.rangeFrom);
  }
  async saveCategory(row: MatchRoomCategoryRow): Promise<void> { this.categoryRows.set(`${row.guildId}:${row.categoryId}`, { ...row }); }
  async removeCategory(guildId: string, categoryId: string): Promise<void> { this.categoryRows.delete(`${guildId}:${categoryId}`); }

  async rooms(guildId: string): Promise<MatchRoomRow[]> {
    return [...this.roomRows.values()].filter(row => row.guildId === guildId).sort((a, b) => a.tableNo - b.tableNo)
      .map(row => ({ ...row, renameLog: [...row.renameLog] }));
  }

  async insertRoom(row: MatchRoomRow): Promise<void> {
    for (const other of this.roomRows.values())
      if (other.guildId === row.guildId && (other.channelId === row.channelId || other.tableNo === row.tableNo)) throw new RuleError(TAKEN);
    this.roomRows.set(`${row.guildId}:${row.channelId}`, { ...row, renameLog: [...row.renameLog] });
  }

  async updateRoom(guildId: string, channelId: string, update: MatchRoomRowUpdate): Promise<MatchRoomRow | null> {
    const key = `${guildId}:${channelId}`;
    const current = this.roomRows.get(key);
    if (!current) return null;
    const next = applyUpdate({ ...current, renameLog: [...current.renameLog] }, update);
    if (!next) return { ...current, renameLog: [...current.renameLog] };
    this.roomRows.set(key, next);
    return { ...next, renameLog: [...next.renameLog] };
  }

  async removeRoom(guildId: string, channelId: string): Promise<boolean> { return this.roomRows.delete(`${guildId}:${channelId}`); }
}

type SettingsSql = { guild_id: string; version: number; template: string; category_id: string | null; pending_category_name: string | null;
  baseline_channel_ids: string[]; baseline_captured_at_ms: string | null; updated_at_ms: string };
type CategorySql = { guild_id: string; category_id: string; range_from: number; range_to: number; origin: 'created' | 'configured'; created_at_ms: string };
type RoomSql = { guild_id: string; channel_id: string; application_id: string; table_no: number; category_id: string | null;
  origin: 'created' | 'adopted'; custom_name: string | null; applied_name: string | null; desired_name: string | null;
  original_name: string | null; rename_log: string[]; next_rename_at_ms: string | null; rename_error: string | null;
  missing_since_ms: string | null; created_at_ms: string };

const num = (value: string | null): number | null => value === null ? null : Number(value);
const settingsOf = (row: SettingsSql): MatchRoomSettingsRow => ({ guildId: row.guild_id, version: row.version, template: row.template,
  categoryId: row.category_id, pendingCategoryName: row.pending_category_name, baselineChannelIds: row.baseline_channel_ids ?? [],
  baselineCapturedAtMs: num(row.baseline_captured_at_ms), updatedAtMs: Number(row.updated_at_ms) });
const categoryOf = (row: CategorySql): MatchRoomCategoryRow => ({ guildId: row.guild_id, categoryId: row.category_id,
  rangeFrom: row.range_from, rangeTo: row.range_to, origin: row.origin, createdAtMs: Number(row.created_at_ms) });
const roomOf = (row: RoomSql): MatchRoomRow => ({ guildId: row.guild_id, channelId: row.channel_id, applicationId: row.application_id,
  tableNo: row.table_no, categoryId: row.category_id, origin: row.origin, customName: row.custom_name, appliedName: row.applied_name,
  desiredName: row.desired_name, originalName: row.original_name, renameLog: (row.rename_log ?? []).map(Number),
  nextRenameAtMs: num(row.next_rename_at_ms), renameError: row.rename_error, missingSinceMs: num(row.missing_since_ms),
  createdAtMs: Number(row.created_at_ms) });

const ROOM_COLUMNS = `guild_id, channel_id, application_id, table_no, category_id, origin, custom_name, applied_name, desired_name,
  original_name, rename_log, next_rename_at_ms, rename_error, missing_since_ms, created_at_ms`;
const roomValues = (row: MatchRoomRow) => [row.guildId, row.channelId, row.applicationId, row.tableNo, row.categoryId, row.origin,
  row.customName, row.appliedName, row.desiredName, row.originalName, row.renameLog, row.nextRenameAtMs, row.renameError,
  row.missingSinceMs, row.createdAtMs];

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === '23505' || (error as { cause?: { code?: unknown } })?.cause?.code === '23505';
}

export function pgMatchRoomStore(): MatchRoomStore {
  const read = async (client: pg.Client, guildId: string, lock: boolean): Promise<MatchRoomSettingsRow> => {
    const result = await client.query<SettingsSql>(`SELECT * FROM public.tcg_match_room_settings WHERE guild_id = $1${lock ? ' FOR UPDATE' : ''}`, [guildId]);
    return result.rows[0] ? settingsOf(result.rows[0]) : defaultMatchRoomSettings(guildId);
  };
  const write = async (client: pg.Client, row: MatchRoomSettingsRow): Promise<void> => {
    await client.query(`INSERT INTO public.tcg_match_room_settings
      (guild_id, version, template, category_id, pending_category_name, baseline_channel_ids, baseline_captured_at_ms, updated_at_ms)
      VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8)
      ON CONFLICT (guild_id) DO UPDATE SET version = EXCLUDED.version, template = EXCLUDED.template, category_id = EXCLUDED.category_id,
        pending_category_name = EXCLUDED.pending_category_name, baseline_channel_ids = EXCLUDED.baseline_channel_ids,
        baseline_captured_at_ms = EXCLUDED.baseline_captured_at_ms, updated_at_ms = EXCLUDED.updated_at_ms`,
    [row.guildId, row.version, row.template, row.categoryId, row.pendingCategoryName, row.baselineChannelIds,
      row.baselineCapturedAtMs, row.updatedAtMs]);
  };
  const locked = <T>(guildId: string, work: (client: pg.Client) => Promise<T>): Promise<T> => withClient(async client => {
    await requireMatchRoomsSchema(client);
    return transaction(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_match_rooms:' || $1))", [guildId]);
      return work(client);
    });
  });
  return {
    kind: 'postgres',
    async available() { await withClient(requireMatchRoomsSchema); },
    async settings(guildId) {
      return withClient(async client => { await requireMatchRoomsSchema(client); return read(client, guildId, false); });
    },
    async saveSettings(guildId, expectedVersion, change, now) {
      return locked(guildId, async client => {
        const current = await read(client, guildId, true);
        if (current.version !== expectedVersion) throw new OpsConflictError(STALE);
        const next = { ...current, ...change, version: current.version + 1, updatedAtMs: now };
        await write(client, next);
        return next;
      });
    },
    async patchSettings(guildId, patch, now) {
      return locked(guildId, async client => {
        const next = { ...await read(client, guildId, true), ...patch, updatedAtMs: now };
        await write(client, next);
        return next;
      });
    },
    async categories(guildId) {
      return withClient(async client => {
        await requireMatchRoomsSchema(client);
        return (await client.query<CategorySql>('SELECT * FROM public.tcg_match_room_categories WHERE guild_id = $1 ORDER BY range_from', [guildId])).rows.map(categoryOf);
      });
    },
    async saveCategory(row) {
      await withClient(async client => {
        await requireMatchRoomsSchema(client);
        await client.query(`INSERT INTO public.tcg_match_room_categories (guild_id, category_id, range_from, range_to, origin, created_at_ms)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (guild_id, category_id) DO UPDATE SET range_from = EXCLUDED.range_from,
          range_to = EXCLUDED.range_to, origin = EXCLUDED.origin`, [row.guildId, row.categoryId, row.rangeFrom, row.rangeTo, row.origin, row.createdAtMs]);
      });
    },
    async removeCategory(guildId, categoryId) {
      await withClient(async client => {
        await requireMatchRoomsSchema(client);
        await client.query('DELETE FROM public.tcg_match_room_categories WHERE guild_id = $1 AND category_id = $2', [guildId, categoryId]);
      });
    },
    async rooms(guildId) {
      return withClient(async client => {
        await requireMatchRoomsSchema(client);
        return (await client.query<RoomSql>('SELECT * FROM public.tcg_match_rooms WHERE guild_id = $1 ORDER BY table_no', [guildId])).rows.map(roomOf);
      });
    },
    async insertRoom(row) {
      await withClient(async client => {
        await requireMatchRoomsSchema(client);
        try {
          await client.query(`INSERT INTO public.tcg_match_rooms (${ROOM_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint[],$12,$13,$14,$15)`, roomValues(row));
        } catch (error) {
          if (isUniqueViolation(error)) throw new RuleError(TAKEN);
          throw error;
        }
      });
    },
    async updateRoom(guildId, channelId, update) {
      return withClient(async client => {
        await requireMatchRoomsSchema(client);
        return transaction(client, async () => {
          const found = await client.query<RoomSql>('SELECT * FROM public.tcg_match_rooms WHERE guild_id = $1 AND channel_id = $2 FOR UPDATE', [guildId, channelId]);
          if (!found.rows[0]) return null;
          const current = roomOf(found.rows[0]);
          const next = applyUpdate(current, update);
          if (!next) return current;
          await client.query(`UPDATE public.tcg_match_rooms SET table_no = $3, category_id = $4, origin = $5, custom_name = $6, applied_name = $7,
            desired_name = $8, original_name = $9, rename_log = $10::bigint[], next_rename_at_ms = $11, rename_error = $12, missing_since_ms = $13
            WHERE guild_id = $1 AND channel_id = $2`, [guildId, channelId, next.tableNo, next.categoryId, next.origin, next.customName,
            next.appliedName, next.desiredName, next.originalName, next.renameLog, next.nextRenameAtMs, next.renameError, next.missingSinceMs]);
          return next;
        });
      });
    },
    async removeRoom(guildId, channelId) {
      return withClient(async client => {
        await requireMatchRoomsSchema(client);
        return ((await client.query('DELETE FROM public.tcg_match_rooms WHERE guild_id = $1 AND channel_id = $2', [guildId, channelId])).rowCount ?? 0) > 0;
      });
    }
  };
}
