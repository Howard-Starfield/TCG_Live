// Announcements (tcg_announcements): validation, mention-safe message building, storage and the
// scheduler shared by the Discord feature and the demo. The opt-in @everyone flag rides in the body jsonb
// next to { content, embed } (the table has no column for it).
import type pg from 'pg';
import { ADMIN_TOOLS_LIMITS as L, type AnnouncementStatus, type MessageBodyDto, type OpsAuditKind } from '@tcg-live/core';
import { OpsConflictError, OpsNotFoundError } from '../../ops/errors.js';
import { withClient } from '../../rehearsal/store.js';
import { requireAdminToolsSchema } from '../schema.js';
import { bool, fail, int, messageBody, shapedObject, snowflake, snowflakeList } from '../validate.js';
import { discordFailure, type OutgoingMessage, type RolesGuildPort } from '../roles/guild-port.js';
import { embedToApi } from '../roles/render.js';
import { ANNOUNCEMENT_GRACE_MS, ANNOUNCEMENT_SCHEDULE_MAX_MS, MISSED_PREFIX, type AnnouncementViewDto } from './types.js';

export interface AnnouncementInput {
  channelId: string; body: MessageBodyDto; mentionRoleIds: string[]; mentionEveryone: boolean;
  scheduledAtMs: number | null; draft: boolean;
}
export interface StoredAnnouncement {
  id: string; guildId: string; channelId: string; body: MessageBodyDto; mentionRoleIds: string[]; mentionEveryone: boolean;
  scheduledAtMs: number | null; status: AnnouncementStatus; messageId: string | null; sentAtMs: number | null; error: string | null;
  createdAtMs: number; updatedAtMs: number;
}

/** The mention line put in front of the text: role pings and the opt-in @everyone. */
export function mentionPrefix(mentionRoleIds: readonly string[], mentionEveryone: boolean): string {
  return [...(mentionEveryone ? ['@everyone'] : []), ...mentionRoleIds.map(id => `<@&${id}>`)].join(' ');
}

/** Strict parse. Embed limits (title 256, description 4096, 25 fields, 6000 total) and https-only images come from validate.embed. */
export function parseAnnouncementInput(input: unknown, guildId: string, nowMs: number): AnnouncementInput {
  const value = shapedObject(input, ['channelId', 'body', 'mentionRoleIds', 'scheduledAtMs'], ['mentionEveryone', 'draft'], 'Announcement');
  const body = messageBody(value.body, 'Announcement');
  const mentionRoleIds = snowflakeList(value.mentionRoleIds, L.announcementMentionRoles, 'Mentioned roles');
  if (mentionRoleIds.includes(guildId)) fail('Use the @everyone switch instead of the @everyone role.');
  const mentionEveryone = value.mentionEveryone === undefined ? false : bool(value.mentionEveryone, 'Mention @everyone');
  const draft = value.draft === undefined ? false : bool(value.draft, 'Draft');
  if (value.scheduledAtMs !== null && (typeof value.scheduledAtMs !== 'number' || value.scheduledAtMs <= nowMs))
    fail('Choose a scheduled time in the future.');
  const scheduledAtMs = value.scheduledAtMs === null ? null
    : int(value.scheduledAtMs, nowMs + 1, nowMs + ANNOUNCEMENT_SCHEDULE_MAX_MS, 'Scheduled time');
  const prefix = mentionPrefix(mentionRoleIds, mentionEveryone);
  const length = [...prefix].length + (prefix && body.content ? 1 : 0) + (body.content ? [...body.content].length : 0);
  if (length > L.messageContentLength) fail(`Text plus mentions must fit in ${L.messageContentLength} characters.`);
  return { channelId: snowflake(value.channelId, 'Channel'), body, mentionRoleIds, mentionEveryone, scheduledAtMs, draft };
}

/**
 * The outgoing message. allowedMentions is always explicit: only the listed roles, and @everyone only
 * when opted in. With no mentions chosen, nothing in the text (an "@everyone" typed in it) can ping.
 */
export function announcementMessage(item: Pick<StoredAnnouncement, 'body' | 'mentionRoleIds' | 'mentionEveryone'>): OutgoingMessage {
  const prefix = mentionPrefix(item.mentionRoleIds, item.mentionEveryone);
  const content = [prefix, item.body.content ?? ''].filter(Boolean).join(' ') || null;
  return { content, embeds: item.body.embed ? [embedToApi(item.body.embed)] : [], components: [],
    allowedMentions: { parse: item.mentionEveryone ? ['everyone'] : [], roles: [...item.mentionRoleIds], users: [] } };
}

export const announcementView = (item: StoredAnnouncement): AnnouncementViewDto => ({ ...structuredClone(item),
  missed: item.status === 'failed' && (item.error ?? '').startsWith(MISSED_PREFIX) });

export interface AnnouncementStore {
  list(guildId: string, limit: number): Promise<StoredAnnouncement[]>;
  get(guildId: string, id: string): Promise<StoredAnnouncement | null>;
  create(item: StoredAnnouncement): Promise<StoredAnnouncement>;
  /** OpsNotFoundError when gone; OpsConflictError when `expectedStatus` is given and the stored status differs (claimed by a send). */
  update(item: StoredAnnouncement, expectedStatus?: AnnouncementStatus): Promise<StoredAnnouncement>;
  delete(guildId: string, id: string): Promise<boolean>;
  /** Scheduled and due at `nowMs`, oldest first. */
  due(guildId: string, nowMs: number): Promise<StoredAnnouncement[]>;
  /** scheduled -> sent (message ID pending). Null when someone else claimed or it changed. */
  claim(guildId: string, id: string, nowMs: number): Promise<StoredAnnouncement | null>;
}

const gone = () => new OpsNotFoundError('That announcement no longer exists.');
const changed = () => new OpsConflictError('That announcement changed meanwhile (it may have just been sent). Reload and try again.');

export class MemoryAnnouncementStore implements AnnouncementStore {
  private readonly items = new Map<string, StoredAnnouncement>();
  private find(guildId: string, id: string) { const item = this.items.get(id); return item?.guildId === guildId ? item : undefined; }
  async list(guildId: string, limit: number) {
    return [...this.items.values()].filter(item => item.guildId === guildId)
      .sort((a, b) => (b.sentAtMs ?? b.scheduledAtMs ?? b.createdAtMs) - (a.sentAtMs ?? a.scheduledAtMs ?? a.createdAtMs))
      .slice(0, limit).map(item => structuredClone(item));
  }
  async get(guildId: string, id: string) { const item = this.find(guildId, id); return item ? structuredClone(item) : null; }
  async create(item: StoredAnnouncement) { this.items.set(item.id, structuredClone(item)); return structuredClone(item); }
  async update(item: StoredAnnouncement, expectedStatus?: AnnouncementStatus) {
    const current = this.find(item.guildId, item.id);
    if (!current) throw gone();
    if (expectedStatus && current.status !== expectedStatus) throw changed();
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }
  async delete(guildId: string, id: string) { return !!this.find(guildId, id) && this.items.delete(id); }
  async due(guildId: string, nowMs: number) {
    return [...this.items.values()].filter(item => item.guildId === guildId && item.status === 'scheduled' &&
      item.scheduledAtMs !== null && item.scheduledAtMs <= nowMs).sort((a, b) => a.scheduledAtMs! - b.scheduledAtMs!).map(item => structuredClone(item));
  }
  async claim(guildId: string, id: string, nowMs: number) {
    const item = this.find(guildId, id);
    if (!item || item.status !== 'scheduled') return null;
    Object.assign(item, { status: 'sent', sentAtMs: nowMs, updatedAtMs: nowMs, messageId: null, error: null });
    return structuredClone(item);
  }
}

interface AnnouncementRow { id: string; guild_id: string; channel_id: string; body: MessageBodyDto & { mentionEveryone?: boolean };
  mention_role_ids: string[]; scheduled_at_ms: string | null; status: AnnouncementStatus; message_id: string | null;
  sent_at_ms: string | null; error: string | null; created_at_ms: string; updated_at_ms: string }
const ms = (value: string | null) => value === null ? null : Number(value);
const fromRow = (row: AnnouncementRow): StoredAnnouncement => ({ id: row.id, guildId: row.guild_id, channelId: row.channel_id,
  body: { content: row.body.content ?? null, embed: row.body.embed ?? null }, mentionRoleIds: row.mention_role_ids,
  mentionEveryone: row.body.mentionEveryone === true, scheduledAtMs: ms(row.scheduled_at_ms), status: row.status, messageId: row.message_id,
  sentAtMs: ms(row.sent_at_ms), error: row.error, createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) });
const COLUMNS = 'id, guild_id, channel_id, body, mention_role_ids, scheduled_at_ms, status, message_id, sent_at_ms, error, created_at_ms, updated_at_ms';
const values = (item: StoredAnnouncement) => [item.id, item.guildId, item.channelId,
  JSON.stringify({ ...item.body, mentionEveryone: item.mentionEveryone }), JSON.stringify(item.mentionRoleIds), item.scheduledAtMs, item.status,
  item.messageId, item.sentAtMs, item.error?.slice(0, 500) ?? null, item.createdAtMs, item.updatedAtMs];

export function pgAnnouncementStore(): AnnouncementStore {
  const run = <T>(work: (client: pg.Client) => Promise<T>) => withClient(async client => { await requireAdminToolsSchema(client); return work(client); });
  const many = async (client: pg.Client, sql: string, params: unknown[]) => (await client.query<AnnouncementRow>(sql, params)).rows.map(fromRow);
  return {
    list: (guildId, limit) => run(client => many(client, `SELECT ${COLUMNS} FROM public.tcg_announcements WHERE guild_id = $1
      ORDER BY COALESCE(sent_at_ms, scheduled_at_ms, created_at_ms) DESC LIMIT $2`, [guildId, limit])),
    get: (guildId, id) => run(async client => (await many(client, `SELECT ${COLUMNS} FROM public.tcg_announcements WHERE guild_id = $1 AND id = $2`,
      [guildId, id]))[0] ?? null),
    create: item => run(async client => {
      await client.query(`INSERT INTO public.tcg_announcements (${COLUMNS}) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`, values(item));
      return item;
    }),
    update: (item, expectedStatus) => run(async client => {
      const result = await client.query(`UPDATE public.tcg_announcements SET channel_id = $3, body = $4::jsonb, mention_role_ids = $5::jsonb,
        scheduled_at_ms = $6, status = $7, message_id = $8, sent_at_ms = $9, error = $10, updated_at_ms = $12
        WHERE id = $1 AND guild_id = $2 AND created_at_ms = $11 AND ($13::text IS NULL OR status = $13)`, [...values(item), expectedStatus ?? null]);
      if (result.rowCount !== 1) {
        if (!expectedStatus) throw gone();
        const exists = await client.query('SELECT 1 FROM public.tcg_announcements WHERE guild_id = $1 AND id = $2', [item.guildId, item.id]);
        throw exists.rowCount ? changed() : gone();
      }
      return item;
    }),
    delete: (guildId, id) => run(async client =>
      ((await client.query('DELETE FROM public.tcg_announcements WHERE guild_id = $1 AND id = $2', [guildId, id])).rowCount ?? 0) === 1),
    due: (guildId, nowMs) => run(client => many(client, `SELECT ${COLUMNS} FROM public.tcg_announcements WHERE guild_id = $1
      AND status = 'scheduled' AND scheduled_at_ms <= $2 ORDER BY scheduled_at_ms`, [guildId, nowMs])),
    claim: (guildId, id, nowMs) => run(async client => (await many(client, `UPDATE public.tcg_announcements SET status = 'sent', sent_at_ms = $3,
      updated_at_ms = $3, message_id = NULL, error = NULL WHERE guild_id = $1 AND id = $2 AND status = 'scheduled' RETURNING ${COLUMNS}`,
    [guildId, id, nowMs]))[0] ?? null)
  };
}

export type AuditFn = (kind: OpsAuditKind, payload: Record<string, unknown>) => Promise<unknown>;

/** Sends a claimed or new announcement and records the outcome (sent with its message ID, or failed). */
export async function deliverAnnouncement(store: AnnouncementStore, port: RolesGuildPort, item: StoredAnnouncement, nowMs: number,
  audit: AuditFn, persist: 'create' | 'update'): Promise<StoredAnnouncement> {
  let next: StoredAnnouncement;
  try {
    const messageId = await port.send(item.channelId, announcementMessage(item));
    next = { ...item, status: 'sent', messageId, sentAtMs: nowMs, error: null, updatedAtMs: nowMs };
  } catch (error) {
    next = { ...item, status: 'failed', messageId: null, sentAtMs: null, error: discordFailure(error), updatedAtMs: nowMs };
  }
  await (persist === 'create' ? store.create(next) : store.update(next));
  await audit(next.status === 'sent' ? 'announcement.sent' : 'announcement.failed',
    { announcementId: next.id, channelId: next.channelId, ...(next.error ? { error: next.error } : { messageId: next.messageId }),
      mentions: next.mentionRoleIds.length, everyone: next.mentionEveryone }).catch(() => {});
  return next;
}

export interface SchedulerOptions {
  store: AnnouncementStore; guildId: string; port(): Promise<RolesGuildPort>; now?(): number; graceMs?: number; audit: AuditFn;
}

/**
 * Sends due scheduled announcements. One rule covers both a running bot and a restart: up to graceMs
 * late it is sent, later it is marked missed (status failed, error "Missed: ...") and never sent.
 */
export class AnnouncementScheduler {
  private running: Promise<number> | null = null;
  constructor(private readonly options: SchedulerOptions) {}

  /** Resolves with the number of announcements handled (sent, failed or missed). Overlapping calls share one pass. */
  tick(): Promise<number> {
    this.running ??= this.pass().finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<number> {
    const { store, guildId, audit } = this.options;
    const now = this.options.now ?? Date.now;
    const grace = this.options.graceMs ?? ANNOUNCEMENT_GRACE_MS;
    const due = await store.due(guildId, now());
    if (!due.length) return 0;
    let port: RolesGuildPort | null = null;
    let handled = 0;
    for (const item of due) {
      const at = now();
      if (at - item.scheduledAtMs! > grace) {
        const missed: StoredAnnouncement = { ...item, status: 'failed', updatedAtMs: at,
          error: `${MISSED_PREFIX} the bot was offline at the scheduled time (more than ${Math.round(grace / 60_000)} minutes late).` };
        try { await store.update(missed, 'scheduled'); } catch (error) { if (error instanceof OpsConflictError) continue; throw error; }
        await audit('announcement.failed', { announcementId: item.id, missed: true, scheduledAtMs: item.scheduledAtMs }).catch(() => {});
        handled += 1;
        continue;
      }
      try { port ??= await this.options.port(); } catch { return handled; /* Discord offline: retried on the next tick. */ }
      const claimed = await store.claim(guildId, item.id, at);
      if (!claimed) continue;
      await deliverAnnouncement(store, port, claimed, at, audit, 'update');
      handled += 1;
    }
    return handled;
  }
}
