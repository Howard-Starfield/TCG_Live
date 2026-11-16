// Post-event clean-up of the match room pool: the preview (buildCleanupPlan) and the confirmed run (executeCleanup).
// Only rooms and categories the bot created (origin 'created') and that are not in the server baseline are deleted;
// adopted rooms get their original name and overwrites back; everything else is kept. Each room's chat is archived
// before the room is deleted, and a category is deleted only once it is empty.
import { createHash } from 'node:crypto';
import type { CleanupPlanDto, CleanupPlanItemDto, CleanupResultDto } from '@tcg-live/core';
import type { OpsActor } from '../../ops/audit.js';
import { RuleError } from '../../rehearsal/domain.js';
import { discordErrorKind } from '../channels/sticky-engine.js';
import { archiveAndClear, type ArchiveBinding, type AuditFn, type RoomChatPort, type TranscriptStore } from './transcripts.js';

export interface CleanupRoomInput {
  channelId: string;
  name: string | null;
  origin: 'created' | 'adopted';
  categoryId: string | null;
  /** The name an adopted room had before the bot renamed it. */
  originalName: string | null;
  missing?: boolean;
  /** The event this room is currently bound to, or null. */
  boundEventId: string | null;
  /** The room's latest match binding (for archiving its chat), or null when it never hosted a match. */
  binding: ArchiveBinding | null;
}
export interface CleanupCategoryInput {
  categoryId: string;
  name: string | null;
  origin: 'created' | 'configured';
  missing?: boolean;
}
export interface CleanupPlanInput {
  rooms: readonly CleanupRoomInput[];
  categories: readonly CleanupCategoryInput[];
  /** Server baseline channel and category IDs. */
  baselineIds: readonly string[];
  activeEventId: string | null;
  /** Members connected per room. A missing or null entry means unknown, which is treated as occupied. */
  occupancy: Readonly<Record<string, number | null | undefined>>;
  /** Overwrite backups by channel ID; only whether one exists matters to the preview. */
  overwriteBackups: Readonly<Record<string, unknown>>;
}

/** The token covers what will happen to which channel; names and reasons can change without invalidating it. */
export function cleanupPlanToken(eventId: string | null, items: readonly CleanupPlanItemDto[]): string {
  const rows = items.map(item => [item.kind, item.channelId, item.action, item.restoreName ?? null])
    .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
  return createHash('sha256').update(JSON.stringify({ eventId, rows })).digest('hex');
}

export function buildCleanupPlan(input: CleanupPlanInput): CleanupPlanDto {
  const baseline = new Set(input.baselineIds);
  const items: CleanupPlanItemDto[] = [];
  const roomAction = new Map<string, CleanupPlanItemDto['action']>();
  let transcripts = 0;
  for (const room of input.rooms) {
    const item = (action: CleanupPlanItemDto['action'], reason: string, extra: Partial<CleanupPlanItemDto> = {}) => {
      items.push({ channelId: room.channelId, name: room.name, kind: 'room', action, reason, ...extra });
      roomAction.set(room.channelId, action);
    };
    const occupied = input.occupancy[room.channelId];
    const active = room.boundEventId !== null && room.boundEventId === input.activeEventId;
    if (room.origin === 'created' && baseline.has(room.channelId)) { item('keep', 'In the server baseline.'); continue; }
    if (active) { item('skip', 'Bound to the active event.'); continue; }
    if (occupied === undefined || occupied === null) { item('skip', "Couldn't check who is connected."); continue; }
    if (occupied > 0) { item('skip', `${occupied} ${occupied === 1 ? 'person is' : 'people are'} connected.`); continue; }
    if (room.origin === 'adopted') {
      if (room.missing) { item('skip', 'The channel no longer exists. Use Remove from pool to drop it.'); continue; }
      const hasBackup = input.overwriteBackups[room.channelId] !== undefined;
      const restoreName = room.originalName;
      item('restore', [restoreName ? `Gets its original name back (${restoreName}).` : 'Keeps its current name (the original was not recorded).',
        hasBackup ? 'Permissions are restored from the backup.' : 'No permission backup was recorded.'].join(' '), { restoreName });
      continue;
    }
    if (room.binding) transcripts++;
    item('delete', room.missing ? 'Already gone from Discord; the record is dropped.' : 'Created by the bot and not in the baseline.');
  }
  for (const category of input.categories) {
    const add = (action: CleanupPlanItemDto['action'], reason: string) =>
      items.push({ channelId: category.categoryId, name: category.name, kind: 'category', action, reason });
    if (category.origin !== 'created') { add('keep', 'Chosen by you, not created by the bot.'); continue; }
    if (baseline.has(category.categoryId)) { add('keep', 'In the server baseline.'); continue; }
    const staying = input.rooms.filter(room => room.categoryId === category.categoryId && roomAction.get(room.channelId) !== 'delete').length;
    if (staying > 0) { add('skip', `Still holds ${staying} room${staying === 1 ? '' : 's'} that stay in place.`); continue; }
    add('delete', 'Created by the bot, empty after clean-up and not in the baseline.');
  }
  return { eventId: input.activeEventId, items, transcriptsToArchive: transcripts, planToken: cleanupPlanToken(input.activeEventId, items) };
}

export interface CleanupDeps {
  chat: RoomChatPort;
  store: TranscriptStore;
  audit: AuditFn;
  channels: {
    /** An already-deleted channel is not an error. */
    deleteChannel(channelId: string, reason: string): Promise<void>;
    /** Channels currently inside the category (the pool's and anyone else's), or null when the category is gone. */
    childCount(categoryId: string): Promise<number | null>;
  };
  /** The room's latest match binding, or null when it never hosted one (nothing to archive). */
  bindingOf(channelId: string): Promise<ArchiveBinding | null>;
  /** A's rename queue: coalescing, 2 renames per 10 minutes. Never awaits Discord. */
  renames: { request(channelId: string, name: string): void | Promise<void> };
  /** Puts back the channel's permission overwrites from the backup taken before the bot changed them. */
  restoreOverwrites(channelId: string): Promise<void>;
  /** Drops a deleted room's pool row and its voice settings. */
  dropRoom(channelId: string): Promise<void>;
  /** Drops a deleted category's pool row. */
  dropCategory(categoryId: string): Promise<void>;
}

const REASON = 'Tournament clean-up';
const BOT: OpsActor = { kind: 'bot', id: 'bot' };

function failure(error: unknown, fallback: string): string {
  return discordErrorKind(error) === 'missing-permissions' ? 'The bot lacks the permission for this (Manage Channels).' : fallback;
}

/**
 * Runs a plan the caller just rebuilt from the current state. The token must match that plan, and the plan must still
 * hash to its own token, so a changed room list or an edited plan is refused. Failures skip the item, never the run.
 */
export async function executeCleanup(deps: CleanupDeps, plan: CleanupPlanDto, token: string, actor: OpsActor = BOT): Promise<CleanupResultDto> {
  if (token !== plan.planToken || cleanupPlanToken(plan.eventId, plan.items) !== plan.planToken) {
    throw new RuleError('The rooms changed; review again.');
  }
  const result: CleanupResultDto = { deleted: [], restored: [], skipped: [], archived: 0 };
  const skip = (channelId: string, reason: string) => result.skipped.push({ channelId, reason });
  for (const item of plan.items) if (item.action === 'skip') skip(item.channelId, item.reason);

  for (const item of plan.items.filter(entry => entry.kind === 'room' && entry.action === 'delete')) {
    try {
      const binding = await deps.bindingOf(item.channelId);
      if (binding) {
        const archived = await archiveAndClear(deps, { channelId: item.channelId, name: item.name }, binding, 'cleanup');
        if (archived.transcriptId) result.archived++;
        else if (archived.warning) { skip(item.channelId, `The room's chat could not be archived, so the room was kept. ${archived.warning}`); continue; }
      }
      await deps.channels.deleteChannel(item.channelId, REASON);
      await deps.dropRoom(item.channelId);
      result.deleted.push(item.channelId);
    } catch (error) { skip(item.channelId, failure(error, 'The room could not be deleted.')); }
  }

  for (const item of plan.items.filter(entry => entry.kind === 'room' && entry.action === 'restore')) {
    const problems: string[] = [];
    try { await deps.restoreOverwrites(item.channelId); }
    catch (error) { problems.push(failure(error, 'Permissions could not be restored.')); }
    if (item.restoreName) {
      try { await deps.renames.request(item.channelId, item.restoreName); }
      catch { problems.push('The original name could not be queued.'); }
    }
    if (problems.length) { skip(item.channelId, problems.join(' ')); continue; }
    result.restored.push(item.channelId);
    await deps.audit('match_rooms.restored', { channelId: item.channelId, renamedTo: item.restoreName ?? null }, BOT).catch(() => {});
  }

  for (const item of plan.items.filter(entry => entry.kind === 'category' && entry.action === 'delete')) {
    try {
      const children = await deps.channels.childCount(item.channelId);
      if (children !== null && children > 0) { skip(item.channelId, `Not empty (${children} channel${children === 1 ? '' : 's'} left), so it was kept.`); continue; }
      if (children !== null) await deps.channels.deleteChannel(item.channelId, REASON);
      await deps.dropCategory(item.channelId);
      result.deleted.push(item.channelId);
    } catch (error) { skip(item.channelId, failure(error, 'The category could not be deleted.')); }
  }

  await deps.audit('match_rooms.cleanup', { eventId: plan.eventId, deleted: result.deleted, restored: result.restored,
    skipped: result.skipped.map(entry => entry.channelId), archived: result.archived }, actor).catch(() => {});
  return result;
}
