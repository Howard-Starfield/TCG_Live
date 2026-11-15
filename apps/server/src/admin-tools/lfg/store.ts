// LFG posts (tcg_lfg_posts) and their joiners (tcg_lfg_players, no cap). Creating a post checks the member's
// open-post limit and cooldown and decides the role ping (ping cooldown) atomically; join/leave are idempotent
// (a primary key per post and member), so rapid or duplicate clicks never double-count.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { LfgGameStatsDto, LfgPostDto, LfgPostStatus, LfgStatsDto } from '@tcg-live/core';
import { OpsInputError } from '../../ops/errors.js';
import { SNOWFLAKE, UUID } from '../../ops/http.js';
import { transaction, withClient } from '../../rehearsal/store.js';
import { requireLfgSchema } from '../schema.js';

export interface CreateLfgPostInput {
  guildId: string; channelId: string; authorId: string; game: string; format: string | null; note: string | null;
  voiceChannelId: string | null; nowMs: number; expiresAtMs: number;
  /** 0 = no cooldown. */
  cooldownMs: number;
  /** 0 = unlimited. */
  maxOpen: number;
  /** The role this post would ping, or null. */
  pingRoleId: string | null;
  pingCooldownMs: number;
}
export type CreateLfgPostResult =
  | { kind: 'created'; post: LfgPostDto }
  | { kind: 'cooldown'; retryAtMs: number }
  | { kind: 'max-open'; open: number; max: number };

export type JoinResult = { kind: 'joined' | 'already' | 'author' | 'closed'; post: LfgPostDto } | { kind: 'missing' };
export type LeaveResult = { kind: 'left' | 'not-joined' | 'author' | 'closed'; post: LfgPostDto } | { kind: 'missing' };
export type CloseStatus = 'closed' | 'expired' | 'deleted';

export interface LfgPostQuery { status?: LfgPostStatus | 'active' | null; game?: string | null; limit: number }

export interface LfgPostStore {
  create(input: CreateLfgPostInput): Promise<CreateLfgPostResult>;
  /** posting -> open with its card. Null when it is gone or no longer posting. */
  setMessage(guildId: string, id: string, messageId: string): Promise<LfgPostDto | null>;
  /** Removes a post whose card could not be sent (frees the cooldown and the ping cooldown). */
  discard(guildId: string, id: string): Promise<void>;
  get(guildId: string, id: string): Promise<LfgPostDto | null>;
  join(guildId: string, id: string, userId: string, nowMs: number): Promise<JoinResult>;
  leave(guildId: string, id: string, userId: string): Promise<LeaveResult>;
  /**
   * Ends a post. 'closed' / 'expired' only from posting/open; 'deleted' from any status except deleted.
   * Null when the post is missing or already in a final state (so concurrent closes act once).
   */
  close(guildId: string, id: string, status: CloseStatus, by: string, nowMs: number): Promise<LfgPostDto | null>;
  /** Open or posting posts whose card is one of these messages, or that live in this channel. */
  findActive(guildId: string, where: { messageIds?: readonly string[]; channelId?: string }): Promise<LfgPostDto[]>;
  /** Open/posting posts expiring at or before nowMs, oldest first. */
  due(guildId: string, nowMs: number, limit?: number): Promise<LfgPostDto[]>;
  list(guildId: string, query: LfgPostQuery): Promise<LfgPostDto[]>;
  stats(guildId: string, sinceMs: number): Promise<LfgStatsDto>;
}

export const LFG_PAGE_LIMIT = 200;
const ACTIVE: readonly LfgPostStatus[] = ['posting', 'open'];
const checkGuild = (guildId: string) => { if (!SNOWFLAKE.test(guildId)) throw new OpsInputError('The Discord server is not configured.'); };

function statsFrom(rows: Array<{ game: string; posts: number; joins: number; open: number }>, sinceMs: number): LfgStatsDto {
  const games: LfgGameStatsDto[] = rows.map(row => ({ game: row.game, posts: Number(row.posts), joins: Number(row.joins), open: Number(row.open) }))
    .sort((a, b) => b.posts - a.posts || a.game.localeCompare(b.game));
  return { sinceMs, posts: games.reduce((sum, game) => sum + game.posts, 0), joins: games.reduce((sum, game) => sum + game.joins, 0),
    open: games.reduce((sum, game) => sum + game.open, 0), games };
}

// ---------------------------------------------------------------- memory

export class MemoryLfgPostStore implements LfgPostStore {
  private readonly posts = new Map<string, Omit<LfgPostDto, 'players'>>();
  private readonly players = new Map<string, Array<{ userId: string; joinedAtMs: number }>>();

  private view(post: Omit<LfgPostDto, 'players'>): LfgPostDto {
    return structuredClone({ ...post, players: (this.players.get(post.id) ?? []).map(item => item.userId) });
  }
  private find(guildId: string, id: string) { const post = this.posts.get(id.toLowerCase()); return post?.guildId === guildId ? post : undefined; }

  async create(input: CreateLfgPostInput): Promise<CreateLfgPostResult> {
    checkGuild(input.guildId);
    const mine = [...this.posts.values()].filter(post => post.guildId === input.guildId && post.authorId === input.authorId);
    const open = mine.filter(post => ACTIVE.includes(post.status)).length;
    if (input.maxOpen > 0 && open >= input.maxOpen) return { kind: 'max-open', open, max: input.maxOpen };
    const last = Math.max(Number.NEGATIVE_INFINITY, ...mine.map(post => post.createdAtMs));
    if (input.cooldownMs > 0 && last + input.cooldownMs > input.nowMs) return { kind: 'cooldown', retryAtMs: last + input.cooldownMs };
    let pinged: string | null = null;
    if (input.pingRoleId) {
      const lastPing = Math.max(Number.NEGATIVE_INFINITY, ...[...this.posts.values()]
        .filter(post => post.guildId === input.guildId && post.pingedRoleId === input.pingRoleId).map(post => post.createdAtMs));
      if (lastPing + input.pingCooldownMs <= input.nowMs) pinged = input.pingRoleId;
    }
    const post: Omit<LfgPostDto, 'players'> = { id: randomUUID(), guildId: input.guildId, channelId: input.channelId, messageId: null,
      authorId: input.authorId, game: input.game, format: input.format, note: input.note, voiceChannelId: input.voiceChannelId, status: 'posting',
      pingedRoleId: pinged, createdAtMs: input.nowMs, expiresAtMs: input.expiresAtMs, closedAtMs: null, closedBy: null };
    this.posts.set(post.id, post);
    return { kind: 'created', post: this.view(post) };
  }
  async setMessage(guildId: string, id: string, messageId: string) {
    const post = this.find(guildId, id);
    if (!post || post.status !== 'posting') return null;
    post.status = 'open'; post.messageId = messageId;
    return this.view(post);
  }
  async discard(guildId: string, id: string) { if (this.find(guildId, id)) { this.posts.delete(id); this.players.delete(id); } }
  async get(guildId: string, id: string) { const post = UUID.test(id) ? this.find(guildId, id) : undefined; return post ? this.view(post) : null; }
  async join(guildId: string, id: string, userId: string, nowMs: number): Promise<JoinResult> {
    const post = this.find(guildId, id);
    if (!post) return { kind: 'missing' };
    if (post.status !== 'open') return { kind: 'closed', post: this.view(post) };
    if (post.authorId === userId) return { kind: 'author', post: this.view(post) };
    const list = this.players.get(post.id) ?? [];
    this.players.set(post.id, list);
    if (list.some(item => item.userId === userId)) return { kind: 'already', post: this.view(post) };
    list.push({ userId, joinedAtMs: nowMs });
    return { kind: 'joined', post: this.view(post) };
  }
  async leave(guildId: string, id: string, userId: string): Promise<LeaveResult> {
    const post = this.find(guildId, id);
    if (!post) return { kind: 'missing' };
    if (post.status !== 'open') return { kind: 'closed', post: this.view(post) };
    if (post.authorId === userId) return { kind: 'author', post: this.view(post) };
    const list = this.players.get(post.id) ?? [];
    const index = list.findIndex(item => item.userId === userId);
    if (index < 0) return { kind: 'not-joined', post: this.view(post) };
    list.splice(index, 1);
    return { kind: 'left', post: this.view(post) };
  }
  async close(guildId: string, id: string, status: CloseStatus, by: string, nowMs: number) {
    const post = this.find(guildId, id);
    if (!post) return null;
    if (status === 'deleted' ? post.status === 'deleted' : !ACTIVE.includes(post.status)) return null;
    post.status = status; post.closedBy = by;
    post.closedAtMs ??= nowMs;
    return this.view(post);
  }
  async findActive(guildId: string, where: { messageIds?: readonly string[]; channelId?: string }) {
    return [...this.posts.values()].filter(post => post.guildId === guildId && ACTIVE.includes(post.status) &&
      ((where.messageIds && post.messageId !== null && where.messageIds.includes(post.messageId)) || (where.channelId && post.channelId === where.channelId)))
      .map(post => this.view(post));
  }
  async due(guildId: string, nowMs: number, limit = 50) {
    return [...this.posts.values()].filter(post => post.guildId === guildId && ACTIVE.includes(post.status) && post.expiresAtMs <= nowMs)
      .sort((a, b) => a.expiresAtMs - b.expiresAtMs).slice(0, limit).map(post => this.view(post));
  }
  async list(guildId: string, query: LfgPostQuery) {
    checkGuild(guildId);
    return [...this.posts.values()].filter(post => post.guildId === guildId
      && (!query.status || (query.status === 'active' ? ACTIVE.includes(post.status) : post.status === query.status))
      && (!query.game || post.game === query.game))
      .sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, query.limit).map(post => this.view(post));
  }
  async stats(guildId: string, sinceMs: number) {
    const rows = new Map<string, { game: string; posts: number; joins: number; open: number }>();
    for (const post of this.posts.values()) {
      if (post.guildId !== guildId || post.createdAtMs < sinceMs || post.status === 'posting') continue;
      const row = rows.get(post.game) ?? { game: post.game, posts: 0, joins: 0, open: 0 };
      row.posts += 1; row.joins += (this.players.get(post.id) ?? []).length; row.open += post.status === 'open' ? 1 : 0;
      rows.set(post.game, row);
    }
    return statsFrom([...rows.values()], sinceMs);
  }
}

// ---------------------------------------------------------------- postgres

interface Row { id: string; guild_id: string; channel_id: string; message_id: string | null; author_id: string; game: string; format: string | null;
  note: string | null; voice_channel_id: string | null; status: LfgPostStatus; pinged_role_id: string | null; created_at_ms: string;
  expires_at_ms: string; closed_at_ms: string | null; closed_by: string | null; players: string[] | null }
const COLUMNS = `p.id::text AS id, p.guild_id, p.channel_id, p.message_id, p.author_id, p.game, p.format, p.note, p.voice_channel_id, p.status,
  p.pinged_role_id, p.created_at_ms, p.expires_at_ms, p.closed_at_ms, p.closed_by,
  ARRAY(SELECT l.user_id FROM public.tcg_lfg_players l WHERE l.post_id = p.id ORDER BY l.joined_at_ms, l.user_id) AS players`;
const fromRow = (row: Row): LfgPostDto => ({ id: row.id, guildId: row.guild_id, channelId: row.channel_id, messageId: row.message_id,
  authorId: row.author_id, game: row.game, format: row.format, note: row.note, voiceChannelId: row.voice_channel_id, status: row.status,
  pingedRoleId: row.pinged_role_id, createdAtMs: Number(row.created_at_ms), expiresAtMs: Number(row.expires_at_ms),
  closedAtMs: row.closed_at_ms === null ? null : Number(row.closed_at_ms), closedBy: row.closed_by, players: row.players ?? [] });

export function pgLfgPostStore(): LfgPostStore {
  const run = <T>(operation: (client: pg.Client) => Promise<T>) => withClient(async client => { await requireLfgSchema(client); return operation(client); });
  const one = async (client: pg.Client, guildId: string, id: string, lock = false) => {
    const row = (await client.query<Row>(`SELECT ${COLUMNS} FROM public.tcg_lfg_posts p WHERE p.guild_id = $1 AND p.id = $2${lock ? ' FOR UPDATE OF p' : ''}`,
      [guildId, id])).rows[0];
    return row ? fromRow(row) : null;
  };
  const many = async (client: pg.Client, where: string, params: unknown[], tail = '') =>
    (await client.query<Row>(`SELECT ${COLUMNS} FROM public.tcg_lfg_posts p WHERE ${where} ${tail}`, params)).rows.map(fromRow);
  return {
    async create(input) {
      checkGuild(input.guildId);
      return run(client => transaction(client, async () => {
        // One creation at a time per member (limits and cooldown), and per pinged role (ping cooldown).
        await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_lfg_author:' || $1 || ':' || $2))", [input.guildId, input.authorId]);
        const mine = (await client.query<{ open: number; last: string | null }>(`SELECT count(*) FILTER (WHERE status IN ('posting', 'open'))::int AS open,
          max(created_at_ms) AS last FROM public.tcg_lfg_posts WHERE guild_id = $1 AND author_id = $2`, [input.guildId, input.authorId])).rows[0]!;
        if (input.maxOpen > 0 && mine.open >= input.maxOpen) return { kind: 'max-open' as const, open: mine.open, max: input.maxOpen };
        if (input.cooldownMs > 0 && mine.last !== null && Number(mine.last) + input.cooldownMs > input.nowMs)
          return { kind: 'cooldown' as const, retryAtMs: Number(mine.last) + input.cooldownMs };
        let pinged: string | null = null;
        if (input.pingRoleId) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_lfg_ping:' || $1 || ':' || $2))", [input.guildId, input.pingRoleId]);
          const last = (await client.query<{ last: string | null }>(`SELECT max(created_at_ms) AS last FROM public.tcg_lfg_posts
            WHERE guild_id = $1 AND pinged_role_id = $2`, [input.guildId, input.pingRoleId])).rows[0]?.last ?? null;
          if (last === null || Number(last) + input.pingCooldownMs <= input.nowMs) pinged = input.pingRoleId;
        }
        const id = randomUUID();
        await client.query(`INSERT INTO public.tcg_lfg_posts (id, guild_id, channel_id, message_id, author_id, game, format, note, voice_channel_id,
          status, pinged_role_id, created_at_ms, expires_at_ms) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, 'posting', $9, $10, $11)`,
        [id, input.guildId, input.channelId, input.authorId, input.game, input.format, input.note, input.voiceChannelId, pinged, input.nowMs, input.expiresAtMs]);
        return { kind: 'created' as const, post: (await one(client, input.guildId, id))! };
      }));
    },
    async setMessage(guildId, id, messageId) {
      return run(async client => {
        const updated = await client.query(`UPDATE public.tcg_lfg_posts SET status = 'open', message_id = $3 WHERE guild_id = $1 AND id = $2 AND status = 'posting'`,
          [guildId, id, messageId]);
        return updated.rowCount ? one(client, guildId, id) : null;
      });
    },
    async discard(guildId, id) {
      if (!UUID.test(id)) return;
      await run(client => client.query('DELETE FROM public.tcg_lfg_posts WHERE guild_id = $1 AND id = $2', [guildId, id]));
    },
    async get(guildId, id) { return UUID.test(id) ? run(client => one(client, guildId, id)) : null; },
    async join(guildId, id, userId, nowMs) {
      if (!UUID.test(id)) return { kind: 'missing' };
      return run(client => transaction(client, async () => {
        // FOR SHARE: a concurrent close waits for the join, and a join after the close sees it.
        const status = (await client.query<{ status: LfgPostStatus; author_id: string }>(
          'SELECT status, author_id FROM public.tcg_lfg_posts WHERE guild_id = $1 AND id = $2 FOR SHARE', [guildId, id])).rows[0];
        if (!status) return { kind: 'missing' as const };
        let kind: 'joined' | 'already' | 'author' | 'closed' = 'closed';
        if (status.status === 'open') {
          if (status.author_id === userId) kind = 'author';
          else {
            const inserted = await client.query(`INSERT INTO public.tcg_lfg_players (post_id, user_id, joined_at_ms) VALUES ($1, $2, $3)
              ON CONFLICT (post_id, user_id) DO NOTHING`, [id, userId, nowMs]);
            kind = inserted.rowCount ? 'joined' : 'already';
          }
        }
        return { kind, post: (await one(client, guildId, id))! };
      }));
    },
    async leave(guildId, id, userId) {
      if (!UUID.test(id)) return { kind: 'missing' };
      return run(client => transaction(client, async () => {
        const status = (await client.query<{ status: LfgPostStatus; author_id: string }>(
          'SELECT status, author_id FROM public.tcg_lfg_posts WHERE guild_id = $1 AND id = $2 FOR SHARE', [guildId, id])).rows[0];
        if (!status) return { kind: 'missing' as const };
        let kind: 'left' | 'not-joined' | 'author' | 'closed' = 'closed';
        if (status.status === 'open') {
          if (status.author_id === userId) kind = 'author';
          else kind = (await client.query('DELETE FROM public.tcg_lfg_players WHERE post_id = $1 AND user_id = $2', [id, userId])).rowCount ? 'left' : 'not-joined';
        }
        return { kind, post: (await one(client, guildId, id))! };
      }));
    },
    async close(guildId, id, status, by, nowMs) {
      if (!UUID.test(id)) return null;
      return run(async client => {
        const from = status === 'deleted' ? `status <> 'deleted'` : `status IN ('posting', 'open')`;
        const updated = await client.query(`UPDATE public.tcg_lfg_posts SET status = $3, closed_by = $4, closed_at_ms = COALESCE(closed_at_ms, $5)
          WHERE guild_id = $1 AND id = $2 AND ${from}`, [guildId, id, status, by.slice(0, 64), nowMs]);
        return updated.rowCount ? one(client, guildId, id) : null;
      });
    },
    async findActive(guildId, where) {
      return run(client => many(client, `p.guild_id = $1 AND p.status IN ('posting', 'open') AND (p.message_id = ANY($2::text[]) OR p.channel_id = $3)`,
        [guildId, [...(where.messageIds ?? [])], where.channelId ?? null]));
    },
    async due(guildId, nowMs, limit = 50) {
      return run(client => many(client, `p.guild_id = $1 AND p.status IN ('posting', 'open') AND p.expires_at_ms <= $2`, [guildId, nowMs],
        `ORDER BY p.expires_at_ms LIMIT ${Math.min(500, Math.max(1, Math.floor(limit)))}`));
    },
    async list(guildId, query) {
      checkGuild(guildId);
      const status = query.status === 'active' ? ['posting', 'open'] : query.status ? [query.status] : null;
      return run(client => many(client, `p.guild_id = $1 AND ($2::text[] IS NULL OR p.status = ANY($2::text[])) AND ($3::text IS NULL OR p.game = $3)`,
        [guildId, status, query.game ?? null], `ORDER BY p.created_at_ms DESC, p.id LIMIT ${Math.min(LFG_PAGE_LIMIT, Math.max(1, query.limit))}`));
    },
    async stats(guildId, sinceMs) {
      checkGuild(guildId);
      return run(async client => statsFrom((await client.query<{ game: string; posts: number; joins: number; open: number }>(
        `SELECT p.game, count(*)::int AS posts, coalesce(sum((SELECT count(*) FROM public.tcg_lfg_players l WHERE l.post_id = p.id)), 0)::int AS joins,
         count(*) FILTER (WHERE p.status = 'open')::int AS open FROM public.tcg_lfg_posts p
         WHERE p.guild_id = $1 AND p.created_at_ms >= $2 AND p.status <> 'posting' GROUP BY p.game`, [guildId, sinceMs])).rows, sinceMs));
    }
  };
}
