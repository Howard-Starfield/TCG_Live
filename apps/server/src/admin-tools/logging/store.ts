// Storage for (D) logging: member events (tcg_member_events), the message edit/delete log (tcg_message_log)
// and the bounded local message copy (tcg_message_store) the log needs to show deleted or edited text.
// Message rows are purged by retention (hourly) and can be wiped by hand ("Delete stored message history").
import type pg from 'pg';
import type { LogEntryDto, LogPageDto } from '@tcg-live/core';
import { withClient } from '../../rehearsal/store.js';
import { requireAdminToolsSchema } from '../schema.js';
import type { LogQuery, MemberEventInput, MessageEventInput, MessageHistoryDeletedDto, MessageStoreStatsDto,
  StoredMessage } from './types.js';

/** Column limits from migration 013. */
export const STORED_CONTENT_MAX = 4000;
const clip = (value: string | null) => value === null ? null : [...value].slice(0, STORED_CONTENT_MAX).join('');

export interface LoggingStore {
  recordMemberEvent(guildId: string, input: MemberEventInput): Promise<LogEntryDto>;
  recordMessageEvent(guildId: string, input: MessageEventInput): Promise<LogEntryDto>;
  /** Insert or replace the local copy of one message. */
  storeMessage(guildId: string, message: StoredMessage): Promise<void>;
  getMessage(guildId: string, messageId: string): Promise<StoredMessage | null>;
  /** Removes and returns the stored copies of these messages (a delete moves the text into the log). */
  takeMessages(guildId: string, messageIds: readonly string[]): Promise<StoredMessage[]>;
  list(guildId: string, query: LogQuery): Promise<LogPageDto>;
  /** Retention: drops message copies created and log entries recorded before the cutoff. */
  purgeMessagesBefore(guildId: string, cutoffMs: number): Promise<MessageHistoryDeletedDto>;
  /** Wipes every stored message copy and message-log entry of the guild. */
  deleteMessageHistory(guildId: string): Promise<MessageHistoryDeletedDto>;
  messageStats(guildId: string): Promise<MessageStoreStatsDto>;
}

function matches(entry: LogEntryDto, query: LogQuery): boolean {
  if (entry.stream !== query.stream) return false;
  if (query.userId && entry.userId !== query.userId) return false;
  if (query.kind && entry.kind !== query.kind) return false;
  if (query.channelId && (entry.stream !== 'message' || entry.channelId !== query.channelId)) return false;
  if (query.fromMs !== null && entry.occurredAtMs < query.fromMs) return false;
  if (query.toMs !== null && entry.occurredAtMs > query.toMs) return false;
  return true;
}

function page(entries: LogEntryDto[], query: LogQuery): LogPageDto {
  if (query.order === 'oldest') return { entries, nextAfter: entries.at(-1)?.id ?? query.after };
  return { entries, nextAfter: entries.length === query.limit ? entries.at(-1)!.id : 0 };
}

/** In-memory store for tests and the demo. */
export class MemoryLoggingStore implements LoggingStore {
  readonly entries: LogEntryDto[] = [];
  readonly messages = new Map<string, StoredMessage & { guildId: string }>();
  private memberId = 0;
  private messageId = 0;

  async recordMemberEvent(guildId: string, input: MemberEventInput): Promise<LogEntryDto> {
    const entry: LogEntryDto = { id: ++this.memberId, guildId, userId: input.userId, occurredAtMs: input.occurredAtMs,
      stream: 'member', kind: input.kind, detail: structuredClone(input.detail) };
    this.entries.push(entry);
    return structuredClone(entry);
  }
  async recordMessageEvent(guildId: string, input: MessageEventInput): Promise<LogEntryDto> {
    const entry: LogEntryDto = { id: ++this.messageId, guildId, userId: input.authorId, occurredAtMs: input.occurredAtMs,
      stream: 'message', kind: input.kind, channelId: input.channelId, messageId: input.messageId,
      before: clip(input.before), after: clip(input.after), attachmentCount: input.attachmentCount };
    this.entries.push(entry);
    return structuredClone(entry);
  }
  async storeMessage(guildId: string, message: StoredMessage) {
    this.messages.set(`${guildId}:${message.messageId}`, { ...message, content: clip(message.content)!, guildId });
  }
  async getMessage(guildId: string, messageId: string) {
    const found = this.messages.get(`${guildId}:${messageId}`);
    if (!found) return null;
    const { guildId: _, ...message } = found;
    return structuredClone(message);
  }
  async takeMessages(guildId: string, messageIds: readonly string[]) {
    const taken: StoredMessage[] = [];
    for (const id of messageIds) {
      const found = await this.getMessage(guildId, id);
      if (found) { taken.push(found); this.messages.delete(`${guildId}:${id}`); }
    }
    return taken;
  }
  async list(guildId: string, query: LogQuery) {
    const all = this.entries.filter(entry => entry.guildId === guildId && matches(entry, query));
    const ordered = query.order === 'oldest'
      ? all.filter(entry => entry.id > query.after).sort((a, b) => a.id - b.id)
      : all.filter(entry => query.before === 0 || entry.id < query.before).sort((a, b) => b.id - a.id);
    return page(ordered.slice(0, query.limit).map(entry => structuredClone(entry)), query);
  }
  async purgeMessagesBefore(guildId: string, cutoffMs: number) {
    let storedMessages = 0;
    for (const [key, message] of this.messages) {
      if (message.guildId === guildId && message.createdAtMs < cutoffMs) { this.messages.delete(key); storedMessages++; }
    }
    const before = this.entries.length;
    this.removeEntries(entry => entry.guildId === guildId && entry.stream === 'message' && entry.occurredAtMs < cutoffMs);
    return { storedMessages, loggedEntries: before - this.entries.length };
  }
  async deleteMessageHistory(guildId: string) { return this.purgeMessagesBefore(guildId, Number.MAX_SAFE_INTEGER); }
  async messageStats(guildId: string) {
    const stored = [...this.messages.values()].filter(message => message.guildId === guildId);
    const logged = this.entries.filter(entry => entry.guildId === guildId && entry.stream === 'message');
    const times = [...stored.map(message => message.createdAtMs), ...logged.map(entry => entry.occurredAtMs)];
    return { storedMessages: stored.length, loggedEntries: logged.length, oldestMs: times.length ? Math.min(...times) : null };
  }
  private removeEntries(drop: (entry: LogEntryDto) => boolean) {
    const kept = this.entries.filter(entry => !drop(entry));
    this.entries.splice(0, this.entries.length, ...kept);
  }
}

interface MemberRow { id: string; guild_id: string; kind: string; user_id: string; detail: Record<string, unknown>; occurred_at_ms: string }
interface MessageLogRow {
  id: string; guild_id: string; kind: string; channel_id: string; message_id: string; author_id: string | null;
  content_before: string | null; content_after: string | null; attachment_count: number; occurred_at_ms: string;
}
interface StoreRow {
  message_id: string; channel_id: string; author_id: string; content: string; attachment_count: number;
  created_at_ms: string; edited_at_ms: string | null;
}
const memberEntry = (row: MemberRow): LogEntryDto => ({ id: Number(row.id), guildId: row.guild_id, userId: row.user_id,
  occurredAtMs: Number(row.occurred_at_ms), stream: 'member', kind: row.kind as 'join', detail: row.detail });
const messageEntry = (row: MessageLogRow): LogEntryDto => ({ id: Number(row.id), guildId: row.guild_id, userId: row.author_id,
  occurredAtMs: Number(row.occurred_at_ms), stream: 'message', kind: row.kind as 'edit', channelId: row.channel_id,
  messageId: row.message_id, before: row.content_before, after: row.content_after, attachmentCount: row.attachment_count });
const stored = (row: StoreRow): StoredMessage => ({ messageId: row.message_id, channelId: row.channel_id, authorId: row.author_id,
  content: row.content, attachmentCount: row.attachment_count, createdAtMs: Number(row.created_at_ms),
  editedAtMs: row.edited_at_ms === null ? null : Number(row.edited_at_ms) });

export function pgLoggingStore(): LoggingStore {
  let schemaReady = false;
  const run = <T>(operation: (client: pg.Client) => Promise<T>) => withClient(async client => {
    if (!schemaReady) { await requireAdminToolsSchema(client); schemaReady = true; }
    return operation(client);
  });
  return {
    recordMemberEvent: (guildId, input) => run(async client => memberEntry((await client.query<MemberRow>(
      `INSERT INTO public.tcg_member_events (guild_id, kind, user_id, detail, occurred_at_ms) VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, guild_id, kind, user_id, detail, occurred_at_ms`,
      [guildId, input.kind, input.userId, JSON.stringify(input.detail), input.occurredAtMs])).rows[0]!)),
    recordMessageEvent: (guildId, input) => run(async client => messageEntry((await client.query<MessageLogRow>(
      `INSERT INTO public.tcg_message_log (guild_id, kind, channel_id, message_id, author_id, content_before, content_after,
         attachment_count, occurred_at_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [guildId, input.kind, input.channelId, input.messageId, input.authorId, clip(input.before), clip(input.after),
        input.attachmentCount, input.occurredAtMs])).rows[0]!)),
    storeMessage: (guildId, message) => run(async client => { await client.query(
      `INSERT INTO public.tcg_message_store (guild_id, message_id, channel_id, author_id, content, attachment_count, created_at_ms, edited_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (guild_id, message_id) DO UPDATE SET content = EXCLUDED.content,
       attachment_count = EXCLUDED.attachment_count, edited_at_ms = EXCLUDED.edited_at_ms`,
      [guildId, message.messageId, message.channelId, message.authorId, clip(message.content), message.attachmentCount,
        message.createdAtMs, message.editedAtMs]); }),
    getMessage: (guildId, messageId) => run(async client => {
      const row = (await client.query<StoreRow>('SELECT * FROM public.tcg_message_store WHERE guild_id = $1 AND message_id = $2',
        [guildId, messageId])).rows[0];
      return row ? stored(row) : null;
    }),
    takeMessages: (guildId, messageIds) => messageIds.length === 0 ? Promise.resolve([]) : run(async client =>
      (await client.query<StoreRow>('DELETE FROM public.tcg_message_store WHERE guild_id = $1 AND message_id = ANY($2::text[]) RETURNING *',
        [guildId, [...messageIds]])).rows.map(stored)),
    list: (guildId, query) => run(async client => {
      const table = query.stream === 'member' ? 'tcg_member_events' : 'tcg_message_log';
      const userColumn = query.stream === 'member' ? 'user_id' : 'author_id';
      const params: unknown[] = [guildId];
      const where = ['guild_id = $1'];
      const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
      if (query.order === 'oldest') add('id > ?', query.after); else if (query.before > 0) add('id < ?', query.before);
      if (query.userId) add(`${userColumn} = ?`, query.userId);
      if (query.kind) add('kind = ?', query.kind);
      if (query.channelId && query.stream === 'message') add('channel_id = ?', query.channelId);
      if (query.fromMs !== null) add('occurred_at_ms >= ?', query.fromMs);
      if (query.toMs !== null) add('occurred_at_ms <= ?', query.toMs);
      params.push(query.limit);
      const result = await client.query(`SELECT * FROM public.${table} WHERE ${where.join(' AND ')}
        ORDER BY id ${query.order === 'oldest' ? 'ASC' : 'DESC'} LIMIT $${params.length}`, params);
      const entries = query.stream === 'member' ? (result.rows as MemberRow[]).map(memberEntry) : (result.rows as MessageLogRow[]).map(messageEntry);
      return page(entries, query);
    }),
    purgeMessagesBefore: (guildId, cutoffMs) => run(async client => {
      const store = await client.query('DELETE FROM public.tcg_message_store WHERE guild_id = $1 AND created_at_ms < $2', [guildId, cutoffMs]);
      const log = await client.query('DELETE FROM public.tcg_message_log WHERE guild_id = $1 AND occurred_at_ms < $2', [guildId, cutoffMs]);
      return { storedMessages: store.rowCount ?? 0, loggedEntries: log.rowCount ?? 0 };
    }),
    deleteMessageHistory: guildId => run(async client => {
      const store = await client.query('DELETE FROM public.tcg_message_store WHERE guild_id = $1', [guildId]);
      const log = await client.query('DELETE FROM public.tcg_message_log WHERE guild_id = $1', [guildId]);
      return { storedMessages: store.rowCount ?? 0, loggedEntries: log.rowCount ?? 0 };
    }),
    messageStats: guildId => run(async client => {
      const row = (await client.query<{ stored: number; logged: number; oldest: string | null }>(
        `SELECT (SELECT count(*)::int FROM public.tcg_message_store WHERE guild_id = $1) AS stored,
                (SELECT count(*)::int FROM public.tcg_message_log WHERE guild_id = $1) AS logged,
                LEAST((SELECT min(created_at_ms) FROM public.tcg_message_store WHERE guild_id = $1),
                      (SELECT min(occurred_at_ms) FROM public.tcg_message_log WHERE guild_id = $1)) AS oldest`, [guildId])).rows[0]!;
      return { storedMessages: row.stored, loggedEntries: row.logged, oldestMs: row.oldest === null ? null : Number(row.oldest) };
    })
  };
}
