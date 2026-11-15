// Feature-local types for (D) logging: join/leave/role/nick log, welcome, auto-role, message edit/delete log.
// Wire DTOs (LogEntryDto, LogPageDto, LoggingSettingsDto) come from @tcg-live/core; these are additive.
import type { LogEntryDto, MemberLogKind, MessageLogKind } from '@tcg-live/core';

export type LogStream = LogEntryDto['stream'];
export type LogKind = MemberLogKind | MessageLogKind;

/**
 * GET /api/v1/admin-tools/logs query. Contract params: stream, after, limit, userId (oldest first after the
 * cursor). Additive filters: kind, channelId (message stream), fromMs/toMs (occurred time, inclusive).
 * `order=newest` pages newest first instead: pass the previous page's `nextAfter` as `before`; a nextAfter of
 * 0 means there are no older entries.
 */
export interface LogQuery {
  stream: LogStream;
  order: 'oldest' | 'newest';
  after: number;
  /** Newest-first cursor (0 = start at the newest). */
  before: number;
  limit: number;
  userId: string | null;
  kind: LogKind | null;
  channelId: string | null;
  fromMs: number | null;
  toMs: number | null;
}

/** GET /api/v1/admin-tools/logs/message-store: what the message log keeps locally (privacy notice). */
export interface MessageStoreStatsDto { storedMessages: number; loggedEntries: number; oldestMs: number | null }
/** DELETE /api/v1/admin-tools/logs/messages: rows removed from the message copy and the edit/delete log. */
export interface MessageHistoryDeletedDto { storedMessages: number; loggedEntries: number }

/** A locally stored copy of a message (text and attachment count only; never DMs, bots or ignored channels). */
export interface StoredMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
  attachmentCount: number;
  createdAtMs: number;
  editedAtMs: number | null;
}

export interface MemberEventInput {
  kind: MemberLogKind;
  userId: string;
  detail: Extract<LogEntryDto, { stream: 'member' }>['detail'];
  occurredAtMs: number;
}
export interface MessageEventInput {
  kind: MessageLogKind;
  channelId: string;
  messageId: string;
  authorId: string | null;
  before: string | null;
  after: string | null;
  attachmentCount: number;
  occurredAtMs: number;
}
