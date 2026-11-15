// General sticky messages (tcg_sticky_messages): one per channel, strict validation, last posted copy kept
// so a restart can tell whether the sticky is still at the bottom. Audit rows are written by the routes.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ADMIN_TOOLS_LIMITS as L, type EmbedDto, type SaveStickyRequestDto, type StickyMessageDto } from '@tcg-live/core';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { SNOWFLAKE, UUID } from '../../ops/http.js';
import { withClient } from '../../rehearsal/store.js';
import { requireAdminToolsSchema } from '../schema.js';
import { bool, exactObject, int, messageBody, snowflake } from '../validate.js';

export interface StickyStore {
  list(guildId: string): Promise<StickyMessageDto[]>;
  get(guildId: string, id: string): Promise<StickyMessageDto | null>;
  /** Creates (id null) or replaces a sticky. One sticky per channel (409 otherwise). */
  save(guildId: string, id: string | null, input: SaveStickyRequestDto): Promise<StickyMessageDto>;
  delete(guildId: string, id: string): Promise<StickyMessageDto>;
  /** Records the bot's current copy (null when removed). Never bumps updatedAtMs. */
  setLastMessageId(guildId: string, id: string, messageId: string | null): Promise<void>;
}

export function parseStickyRequest(input: unknown): SaveStickyRequestDto {
  const value = exactObject(input, ['channelId', 'enabled', 'debounceMs', 'content', 'embed'], 'Sticky message');
  const body = messageBody({ content: value.content, embed: value.embed }, 'Sticky message');
  return { channelId: snowflake(value.channelId, 'Channel'), enabled: bool(value.enabled, 'Enabled'),
    debounceMs: int(value.debounceMs, L.stickyDebounceMsMin, L.stickyDebounceMsMax, 'Re-post delay (ms)'), ...body };
}

const checkGuild = (guildId: string) => { if (!SNOWFLAKE.test(guildId)) throw new OpsInputError('The Discord server is not configured.'); };
const checkId = (id: string) => { if (!UUID.test(id)) throw new OpsNotFoundError('That sticky message does not exist.'); };
const duplicate = () => new OpsConflictError('That channel already has a sticky message. Edit it instead.');
const tooMany = () => new OpsConflictError(`At most ${L.stickies} sticky messages are allowed.`);

interface Row { id: string; guild_id: string; channel_id: string; content: string | null; embed: EmbedDto | null; enabled: boolean;
  debounce_ms: number; last_message_id: string | null; updated_at_ms: string }
const fromRow = (row: Row): StickyMessageDto => ({ id: row.id, guildId: row.guild_id, channelId: row.channel_id, content: row.content,
  embed: row.embed, enabled: row.enabled, debounceMs: row.debounce_ms, lastMessageId: row.last_message_id, updatedAtMs: Number(row.updated_at_ms) });
const COLUMNS = 'id::text AS id, guild_id, channel_id, content, embed, enabled, debounce_ms, last_message_id, updated_at_ms';

export function pgStickyStore(now: () => number = Date.now): StickyStore {
  const run = <T>(operation: (client: pg.Client) => Promise<T>) =>
    withClient(async client => { await requireAdminToolsSchema(client); return operation(client); });
  const one = async (client: pg.Client, guildId: string, id: string) =>
    (await client.query<Row>(`SELECT ${COLUMNS} FROM public.tcg_sticky_messages WHERE guild_id = $1 AND id = $2`, [guildId, id])).rows[0];
  return {
    list: async guildId => { checkGuild(guildId); return run(async client =>
      (await client.query<Row>(`SELECT ${COLUMNS} FROM public.tcg_sticky_messages WHERE guild_id = $1 ORDER BY updated_at_ms, id`, [guildId])).rows.map(fromRow)); },
    get: async (guildId, id) => { checkGuild(guildId); if (!UUID.test(id)) return null;
      return run(async client => { const row = await one(client, guildId, id); return row ? fromRow(row) : null; }); },
    async save(guildId, id, input) {
      checkGuild(guildId);
      const value = parseStickyRequest(input);
      if (id !== null) checkId(id);
      return run(async client => {
        try {
          if (id === null) {
            const count = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM public.tcg_sticky_messages WHERE guild_id = $1', [guildId]);
            if ((count.rows[0]?.n ?? 0) >= L.stickies) throw tooMany();
            const inserted = await client.query<Row>(`INSERT INTO public.tcg_sticky_messages (id, guild_id, channel_id, content, embed, enabled,
              debounce_ms, last_message_id, updated_at_ms) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NULL, $8) RETURNING ${COLUMNS}`,
            [randomUUID(), guildId, value.channelId, value.content, value.embed ? JSON.stringify(value.embed) : null, value.enabled, value.debounceMs, now()]);
            return fromRow(inserted.rows[0]!);
          }
          // Moving a sticky to another channel forgets the old copy (the feature removes it).
          const updated = await client.query<Row>(`UPDATE public.tcg_sticky_messages SET channel_id = $3, content = $4, embed = $5::jsonb, enabled = $6,
            debounce_ms = $7, updated_at_ms = $8, last_message_id = CASE WHEN channel_id = $3 THEN last_message_id ELSE NULL END
            WHERE guild_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
          [guildId, id, value.channelId, value.content, value.embed ? JSON.stringify(value.embed) : null, value.enabled, value.debounceMs, now()]);
          if (!updated.rows[0]) throw new OpsNotFoundError('That sticky message does not exist.');
          return fromRow(updated.rows[0]);
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw duplicate();
          throw error;
        }
      });
    },
    async delete(guildId, id) {
      checkGuild(guildId); checkId(id);
      return run(async client => {
        const row = (await client.query<Row>(`DELETE FROM public.tcg_sticky_messages WHERE guild_id = $1 AND id = $2 RETURNING ${COLUMNS}`, [guildId, id])).rows[0];
        if (!row) throw new OpsNotFoundError('That sticky message does not exist.');
        return fromRow(row);
      });
    },
    async setLastMessageId(guildId, id, messageId) {
      checkGuild(guildId);
      if (!UUID.test(id) || (messageId !== null && !SNOWFLAKE.test(messageId))) return;
      await run(client => client.query('UPDATE public.tcg_sticky_messages SET last_message_id = $3 WHERE guild_id = $1 AND id = $2', [guildId, id, messageId]));
    }
  };
}

export class MemoryStickyStore implements StickyStore {
  private readonly rows = new Map<string, StickyMessageDto>();
  constructor(private readonly now: () => number = Date.now) {}
  async list(guildId: string) {
    checkGuild(guildId);
    return [...this.rows.values()].filter(row => row.guildId === guildId).sort((a, b) => a.updatedAtMs - b.updatedAtMs).map(row => structuredClone(row));
  }
  async get(guildId: string, id: string) { const row = this.rows.get(id); return row && row.guildId === guildId ? structuredClone(row) : null; }
  async save(guildId: string, id: string | null, input: SaveStickyRequestDto) {
    checkGuild(guildId);
    const value = parseStickyRequest(input);
    if (id !== null) checkId(id);
    const existing = id === null ? null : this.rows.get(id);
    if (id !== null && (!existing || existing.guildId !== guildId)) throw new OpsNotFoundError('That sticky message does not exist.');
    if ([...this.rows.values()].some(row => row.guildId === guildId && row.channelId === value.channelId && row.id !== id)) throw duplicate();
    if (!existing && [...this.rows.values()].filter(row => row.guildId === guildId).length >= L.stickies) throw tooMany();
    const saved: StickyMessageDto = { id: existing?.id ?? randomUUID(), guildId, ...value,
      lastMessageId: existing && existing.channelId === value.channelId ? existing.lastMessageId : null, updatedAtMs: this.now() };
    this.rows.set(saved.id, saved);
    return structuredClone(saved);
  }
  async delete(guildId: string, id: string) {
    checkId(id);
    const row = this.rows.get(id);
    if (!row || row.guildId !== guildId) throw new OpsNotFoundError('That sticky message does not exist.');
    this.rows.delete(id);
    return structuredClone(row);
  }
  async setLastMessageId(guildId: string, id: string, messageId: string | null) {
    const row = this.rows.get(id);
    if (row && row.guildId === guildId) row.lastMessageId = messageId;
  }
}
