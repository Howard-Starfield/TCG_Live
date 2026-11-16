// Match room chat transcripts: the store (tcg_match_room_transcripts, migration 017), the archive-then-clear
// flow, the live and demo RoomChatPorts and the retention sweep. Attachments are kept as URL and metadata only;
// nothing is downloaded. Message text never goes into the audit.
import { randomUUID } from 'node:crypto';
import { ChannelType, GatewayIntentBits, SnowflakeUtil, type Guild, type Message } from 'discord.js';
import type pg from 'pg';
import type { MatchId, MatchRoomTranscriptDto, MatchRoomTranscriptMessageDto, MatchRoomTranscriptSummaryDto, OpsAuditKind } from '@tcg-live/core';
import type { OpsActor } from '../../ops/audit.js';
import { UUID } from '../../ops/http.js';
import { transaction, withClient } from '../../rehearsal/store.js';
import { discordErrorKind } from '../channels/sticky-engine.js';
import { requireAdminToolsSchema } from '../schema.js';

export type TranscriptReason = MatchRoomTranscriptDto['reason'];
export type AuditFn = (kind: OpsAuditKind, payload: Record<string, unknown>, actor: OpsActor) => Promise<unknown>;

export const DAY_MS = 24 * 60 * 60_000;
/** Discord only bulk deletes messages younger than 14 days; a minute of margin covers clock skew. */
export const BULK_DELETE_WINDOW_MS = 14 * DAY_MS - 60_000;
export const TRANSCRIPT_MAX_MESSAGES = 5_000;
/** Raw JSON size kept under the table's pg_column_size(messages) < 4,000,000 check. */
export const TRANSCRIPT_MAX_BYTES = 3_500_000;
const CONTENT_MAX = 4_000;
const BOT_ACTOR: OpsActor = { kind: 'bot', id: 'bot' };
const RETENTION_ACTOR: OpsActor = { kind: 'system', id: 'retention' };

export interface RoomChatPort {
  /** Oldest first; only messages created at or after sinceMs (null: everything, up to the cap). contentAvailable is false without the Message Content intent. */
  fetchMessages(channelId: string, sinceMs: number | null): Promise<{ messages: MatchRoomTranscriptMessageDto[]; contentAvailable: boolean }>;
  /** Deletes what Discord allows (under 14 days old); older ids are counted, not touched. */
  bulkDelete(channelId: string, ids: string[]): Promise<{ deleted: number; skippedOld: number }>;
}

// ---- Store ----

export interface TranscriptInput {
  eventId: string; matchId: MatchId; channelId: string; channelName: string | null; startedAtMs: number | null;
  archivedAtMs?: number; reason: TranscriptReason; contentAvailable: boolean; skippedOld?: number;
  messages: MatchRoomTranscriptMessageDto[];
}

/** One guild's transcripts. */
export interface TranscriptStore {
  save(input: TranscriptInput): Promise<MatchRoomTranscriptSummaryDto>;
  setSkippedOld(id: string, skippedOld: number): Promise<void>;
  /** Newest first; purged rows are not listed. */
  list(eventId: string, matchId?: MatchId): Promise<MatchRoomTranscriptSummaryDto[]>;
  get(id: string): Promise<MatchRoomTranscriptDto | null>;
  /** False when the transcript does not exist. */
  setHold(id: string, hold: boolean): Promise<boolean>;
  /** Purges (soft delete, messages emptied) transcripts archived before the cutoff, never held ones. Returns their IDs. */
  purgeExpired(cutoffMs: number, limit: number): Promise<string[]>;
}

/** Fits a message into the table's limits; text is dropped entirely when the intent is missing. */
export function clampTranscriptMessage(message: MatchRoomTranscriptMessageDto, contentAvailable: boolean): MatchRoomTranscriptMessageDto {
  return { id: message.id, authorId: message.authorId,
    authorName: message.authorName === null ? null : [...message.authorName].slice(0, 100).join(''),
    createdAtMs: message.createdAtMs,
    content: contentAvailable && message.content !== null ? [...message.content].slice(0, CONTENT_MAX).join('') : null,
    attachments: message.attachments.slice(0, 10).map(item => ({ name: item.name.slice(0, 200), url: item.url.slice(0, 2048), size: item.size })) };
}

/** Clamps, then keeps the newest messages that fit the count and size limits. */
export function fitTranscriptMessages(messages: readonly MatchRoomTranscriptMessageDto[], contentAvailable: boolean):
  { kept: MatchRoomTranscriptMessageDto[]; dropped: number } {
  let kept = messages.map(message => clampTranscriptMessage(message, contentAvailable));
  if (kept.length > TRANSCRIPT_MAX_MESSAGES) kept = kept.slice(kept.length - TRANSCRIPT_MAX_MESSAGES);
  let bytes = Buffer.byteLength(JSON.stringify(kept));
  let from = 0;
  while (bytes > TRANSCRIPT_MAX_BYTES && from < kept.length - 1) {
    bytes -= Buffer.byteLength(JSON.stringify(kept[from])) + 1;
    from++;
  }
  if (from > 0) kept = kept.slice(from);
  return { kept, dropped: messages.length - kept.length };
}

const summaryOf = (row: MatchRoomTranscriptDto): MatchRoomTranscriptSummaryDto => {
  const { messages: _messages, ...summary } = row;
  return summary;
};

interface Row {
  id: string; event_id: string; match_id: string; channel_id: string; channel_name: string | null; started_at_ms: string | null;
  archived_at_ms: string; reason: TranscriptReason; message_count: number; content_available: boolean; skipped_old: number; hold: boolean;
  messages?: MatchRoomTranscriptMessageDto[];
}
const SUMMARY_COLUMNS = `id::text AS id, event_id::text AS event_id, match_id, channel_id, channel_name, started_at_ms, archived_at_ms, reason,
  message_count, content_available, skipped_old, hold`;
const fromRow = (row: Row): MatchRoomTranscriptDto => ({ id: row.id, eventId: row.event_id, matchId: row.match_id as MatchId, channelId: row.channel_id,
  channelName: row.channel_name, startedAtMs: row.started_at_ms === null ? null : Number(row.started_at_ms), archivedAtMs: Number(row.archived_at_ms),
  reason: row.reason, messageCount: row.message_count, contentAvailable: row.content_available, skippedOld: row.skipped_old, hold: row.hold,
  messages: Array.isArray(row.messages) ? row.messages : [] });

export function pgTranscriptStore(guildId: string, now: () => number = Date.now): TranscriptStore {
  const run = <T>(operation: (client: pg.Client) => Promise<T>) =>
    withClient(async client => { await requireAdminToolsSchema(client); return operation(client); });
  return {
    async save(input) {
      const id = randomUUID();
      const archivedAtMs = input.archivedAtMs ?? now();
      const skippedOld = input.skippedOld ?? 0;
      await run(client => client.query(`INSERT INTO public.tcg_match_room_transcripts (id, guild_id, event_id, match_id, channel_id, channel_name,
        started_at_ms, archived_at_ms, reason, message_count, content_available, messages, skipped_old, hold)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, false)`,
      [id, guildId, input.eventId, input.matchId, input.channelId, input.channelName?.slice(0, 100) ?? null, input.startedAtMs, archivedAtMs,
        input.reason, input.messages.length, input.contentAvailable, JSON.stringify(input.messages), skippedOld]));
      return summaryOf(fromRow({ id, event_id: input.eventId, match_id: input.matchId, channel_id: input.channelId, channel_name: input.channelName ?? null,
        started_at_ms: input.startedAtMs === null ? null : String(input.startedAtMs), archived_at_ms: String(archivedAtMs), reason: input.reason,
        message_count: input.messages.length, content_available: input.contentAvailable, skipped_old: skippedOld, hold: false }));
    },
    async setSkippedOld(id, skippedOld) {
      if (!UUID.test(id)) return;
      await run(client => client.query('UPDATE public.tcg_match_room_transcripts SET skipped_old = $3 WHERE guild_id = $1 AND id = $2', [guildId, id, skippedOld]));
    },
    async list(eventId, matchId) {
      if (!UUID.test(eventId)) return [];
      return run(async client => (await client.query<Row>(`SELECT ${SUMMARY_COLUMNS} FROM public.tcg_match_room_transcripts
        WHERE guild_id = $1 AND event_id = $2 AND ($3::text IS NULL OR match_id = $3) AND deleted_at_ms IS NULL
        ORDER BY archived_at_ms DESC, id LIMIT 500`, [guildId, eventId, matchId ?? null])).rows.map(row => summaryOf(fromRow(row))));
    },
    async get(id) {
      if (!UUID.test(id)) return null;
      return run(async client => {
        const row = (await client.query<Row>(`SELECT ${SUMMARY_COLUMNS}, messages FROM public.tcg_match_room_transcripts
          WHERE guild_id = $1 AND id = $2 AND deleted_at_ms IS NULL`, [guildId, id])).rows[0];
        return row ? fromRow(row) : null;
      });
    },
    async setHold(id, hold) {
      if (!UUID.test(id)) return false;
      return run(async client => (await client.query('UPDATE public.tcg_match_room_transcripts SET hold = $3 WHERE guild_id = $1 AND id = $2 AND deleted_at_ms IS NULL',
        [guildId, id, hold])).rowCount === 1);
    },
    async purgeExpired(cutoffMs, limit) {
      return run(client => transaction(client, async () => {
        const rows = await client.query<{ id: string }>(`UPDATE public.tcg_match_room_transcripts SET deleted_at_ms = $2, messages = '[]'::jsonb
          WHERE id IN (SELECT id FROM public.tcg_match_room_transcripts WHERE guild_id = $1 AND hold = false AND deleted_at_ms IS NULL
            AND archived_at_ms <= $3 ORDER BY archived_at_ms LIMIT $4 FOR UPDATE)
          RETURNING id::text AS id`, [guildId, now(), cutoffMs, limit]);
        return rows.rows.map(row => row.id);
      }));
    }
  };
}

interface MemoryRow { dto: MatchRoomTranscriptDto; deletedAtMs: number | null }

export class MemoryTranscriptStore implements TranscriptStore {
  private readonly rows = new Map<string, MemoryRow>();
  constructor(private readonly now: () => number = Date.now) {}
  async save(input: TranscriptInput) {
    const dto: MatchRoomTranscriptDto = { id: randomUUID(), eventId: input.eventId, matchId: input.matchId, channelId: input.channelId,
      channelName: input.channelName?.slice(0, 100) ?? null, startedAtMs: input.startedAtMs, archivedAtMs: input.archivedAtMs ?? this.now(),
      reason: input.reason, messageCount: input.messages.length, contentAvailable: input.contentAvailable, skippedOld: input.skippedOld ?? 0,
      hold: false, messages: structuredClone(input.messages) };
    this.rows.set(dto.id, { dto, deletedAtMs: null });
    return summaryOf(structuredClone(dto));
  }
  async setSkippedOld(id: string, skippedOld: number) { const row = this.rows.get(id); if (row) row.dto.skippedOld = skippedOld; }
  async list(eventId: string, matchId?: MatchId) {
    return [...this.rows.values()].filter(row => row.deletedAtMs === null && row.dto.eventId === eventId && (!matchId || row.dto.matchId === matchId))
      .map(row => row.dto).sort((a, b) => b.archivedAtMs - a.archivedAtMs).map(dto => summaryOf(structuredClone(dto)));
  }
  async get(id: string) { const row = this.rows.get(id); return row && row.deletedAtMs === null ? structuredClone(row.dto) : null; }
  async setHold(id: string, hold: boolean) {
    const row = this.rows.get(id);
    if (!row || row.deletedAtMs !== null) return false;
    row.dto.hold = hold;
    return true;
  }
  async purgeExpired(cutoffMs: number, limit: number) {
    const due = [...this.rows.values()].filter(row => row.deletedAtMs === null && !row.dto.hold && row.dto.archivedAtMs <= cutoffMs)
      .sort((a, b) => a.dto.archivedAtMs - b.dto.archivedAtMs).slice(0, limit);
    for (const row of due) { row.deletedAtMs = this.now(); row.dto.messages = []; }
    return due.map(row => row.dto.id);
  }
  /** Test helper: includes purged rows. */
  raw(id: string): MemoryRow | undefined { return this.rows.get(id); }
}

// ---- Archive, then clear ----

export interface ArchiveDeps { chat: RoomChatPort; store: TranscriptStore; audit: AuditFn }
export interface ArchiveBinding { eventId: string; matchId: MatchId; startedAtMs: number | null }
export interface ArchiveResult { transcriptId: string | null; warning: string | null }

const inFlight = new Set<string>();
const NO_ACCESS = "The bot can't read this room's chat (it needs View Channel, Read Message History and Manage Messages).";

/**
 * Saves the match's room chat as a transcript, then deletes the archived messages from the room. Nothing is cleared
 * unless the transcript was saved, and only messages that made it into the transcript are cleared.
 * `transcriptId: null` with a null warning means there was nothing to archive (or the room no longer exists);
 * `transcriptId: null` with a warning means the chat could not be archived and was left as it was.
 * A warning with a transcript ID means the archive is safe but something minor failed (for example clearing).
 */
export async function archiveAndClear(deps: ArchiveDeps, room: { channelId: string; name: string | null }, binding: ArchiveBinding,
  reason: TranscriptReason): Promise<ArchiveResult> {
  if (inFlight.has(room.channelId)) return { transcriptId: null, warning: "This room's chat is already being archived." };
  inFlight.add(room.channelId);
  try {
    let fetched: Awaited<ReturnType<RoomChatPort['fetchMessages']>>;
    try { fetched = await deps.chat.fetchMessages(room.channelId, binding.startedAtMs); }
    catch (error) {
      const kind = discordErrorKind(error);
      if (kind === 'channel-missing') return { transcriptId: null, warning: null };
      return { transcriptId: null, warning: kind === 'missing-permissions' ? NO_ACCESS : "The room's chat could not be read, so it was left as it was." };
    }
    if (fetched.messages.length === 0) return { transcriptId: null, warning: null };
    const { kept, dropped } = fitTranscriptMessages(fetched.messages, fetched.contentAvailable);
    let saved: MatchRoomTranscriptSummaryDto;
    try {
      saved = await deps.store.save({ eventId: binding.eventId, matchId: binding.matchId, channelId: room.channelId, channelName: room.name,
        startedAtMs: binding.startedAtMs, reason, contentAvailable: fetched.contentAvailable, messages: kept });
    } catch { return { transcriptId: null, warning: "The room's chat could not be saved, so it was left as it was." }; }
    const warnings: string[] = [];
    if (dropped > 0) warnings.push(`${dropped} older message(s) were too large to archive and were left in the room.`);
    let skippedOld = 0;
    let deleted = 0;
    try {
      const cleared = await deps.chat.bulkDelete(room.channelId, kept.map(message => message.id));
      skippedOld = cleared.skippedOld;
      deleted = cleared.deleted;
      if (skippedOld > 0) {
        warnings.push(`${skippedOld} message(s) older than 14 days could not be bulk deleted and were left in the room.`);
        await deps.store.setSkippedOld(saved.id, skippedOld).catch(() => {});
      }
    } catch (error) {
      warnings.push(discordErrorKind(error) === 'missing-permissions' ? "Archived, but the bot can't clear the chat (it needs Manage Messages)."
        : 'Archived, but the chat could not be cleared.');
    }
    // IDs and counts only: never message text or author names.
    await deps.audit('match_rooms.transcript', { transcriptId: saved.id, eventId: binding.eventId, matchId: binding.matchId,
      channelId: room.channelId, reason, messageCount: kept.length, deleted, skippedOld, contentAvailable: fetched.contentAvailable }, BOT_ACTOR).catch(() => {});
    return { transcriptId: saved.id, warning: warnings.length ? warnings.join(' ') : null };
  } finally { inFlight.delete(room.channelId); }
}

// ---- Retention ----

export interface TranscriptRetentionOptions {
  store: Pick<TranscriptStore, 'purgeExpired'>;
  /** The evidence retention setting: days, or null for never. */
  settings(): Promise<{ retention: { days: number | null } }>;
  audit?: AuditFn;
  now?: () => number;
}
const RETENTION_BATCH = 200;

/** Part of the hourly evidence retention sweep. Held transcripts are kept. Never throws (017 may not have run). */
export async function sweepTranscriptRetention(options: TranscriptRetentionOptions): Promise<number> {
  try {
    const days = (await options.settings()).retention.days;
    if (days === null || !Number.isSafeInteger(days) || days < 1) return 0;
    const now = (options.now ?? Date.now)();
    const ids = await options.store.purgeExpired(now - days * DAY_MS, RETENTION_BATCH);
    for (const id of ids) {
      await options.audit?.('match_rooms.transcript', { transcriptId: id, action: 'deleted', reason: 'retention' }, RETENTION_ACTOR).catch(() => {});
    }
    return ids.length;
  } catch { return 0; }
}

// ---- Ports ----

const snowflakeMs = (id: string): number => Number(SnowflakeUtil.timestampFrom(id));

function chatMessage(message: Message): MatchRoomTranscriptMessageDto {
  return { id: message.id, authorId: message.author.id, authorName: message.member?.displayName ?? message.author.username,
    createdAtMs: message.createdTimestamp, content: message.content,
    attachments: [...message.attachments.values()].map(item => ({ name: item.name, url: item.url, size: item.size ?? null })) };
}

/** The voice channel's own text chat. contentAvailable comes from the client's Message Content intent. */
export function liveRoomChatPort(guild: Guild, now: () => number = Date.now): RoomChatPort {
  const channelOf = async (channelId: string) => {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
      throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
    }
    return channel;
  };
  return {
    async fetchMessages(channelId, sinceMs) {
      const channel = await channelOf(channelId);
      // Without the intent Discord empties other members' text; the transcript keeps author, time and attachments only.
      const contentAvailable = guild.client.options.intents.has(GatewayIntentBits.MessageContent);
      const collected: MatchRoomTranscriptMessageDto[] = [];
      let before: string | undefined;
      scan: while (collected.length < TRANSCRIPT_MAX_MESSAGES) {
        const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!page.size) break;
        for (const message of page.values()) {
          if (sinceMs !== null && message.createdTimestamp < sinceMs) break scan;
          if (!message.system) collected.push(chatMessage(message));
        }
        before = page.last()?.id;
        if (page.size < 100) break;
      }
      return { messages: collected.slice(0, TRANSCRIPT_MAX_MESSAGES).reverse(), contentAvailable };
    },
    async bulkDelete(channelId, ids) {
      const channel = await channelOf(channelId);
      const cutoff = now() - BULK_DELETE_WINDOW_MS;
      const fresh = ids.filter(id => snowflakeMs(id) > cutoff);
      let deleted = 0;
      for (let index = 0; index < fresh.length; index += 100) {
        try { deleted += (await channel.bulkDelete(fresh.slice(index, index + 100), false)).size; }
        catch (error) { if (discordErrorKind(error) !== 'unknown-message') throw error; }
      }
      return { deleted, skippedOld: ids.length - fresh.length };
    }
  };
}

/** Demo: a short synthetic conversation per room, until it is cleared. */
export function demoRoomChatPort(now: () => number = Date.now): RoomChatPort {
  const cleared = new Set<string>();
  let counter = 0n;
  return {
    async fetchMessages(channelId, sinceMs) {
      if (cleared.has(channelId)) return { messages: [], contentAvailable: true };
      const base = now();
      const lines: Array<[string, string, string]> = [['Ready when you are.', 'Player A', '1001'], ['Good luck!', 'Player B', '1002'],
        ['Judge on the way.', 'Judge', '1003']];
      const messages = lines.map(([content, authorName, authorId], index) => {
        counter += 1n;
        return { id: `${900_000_000_000_000_000n + counter}`, authorId, authorName, createdAtMs: base - (lines.length - index) * 60_000, content,
          attachments: index === 1 ? [{ name: 'photo.png', url: 'https://example.invalid/photo.png', size: 1024 }] : [] };
      }).filter(message => sinceMs === null || message.createdAtMs >= sinceMs);
      return { messages, contentAvailable: true };
    },
    async bulkDelete(channelId, ids) { cleared.add(channelId); return { deleted: ids.length, skippedOld: 0 }; }
  };
}
