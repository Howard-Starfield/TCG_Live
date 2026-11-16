// Channel controls: lock/unlock (the @everyone Send Messages overwrite, restoring exactly what was there),
// slowmode, and purge (by count or by user, within Discord's 14-day bulk-delete limit). Discord I/O goes
// through ChannelGateway so the demo and tests use the same logic as the live bot.
import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type GuildTextBasedChannel } from 'discord.js';
import { ADMIN_TOOLS_LIMITS as L, type ChannelCreateRequestDto, type ChannelPurgeRequestDto, type ChannelPurgeResultDto, type ChannelStateDto,
  type GuildChannelDto } from '@tcg-live/core';
import type pg from 'pg';
import type { OpsAuditStore } from '../../ops/audit.js';
import { OpsInputError } from '../../ops/errors.js';
import { withClient } from '../../rehearsal/store.js';
import { requireAdminToolsSchema } from '../schema.js';
import { discordErrorKind } from './sticky-engine.js';

/** The @everyone overwrite's Send Messages bit. */
export type PermissionBit = 'allow' | 'deny' | 'neutral';
export interface RecentMessage { id: string; authorId: string; createdAtMs: number }

export interface ChannelGateway {
  /** Null when the channel is missing or not a text channel. */
  state(channelId: string): Promise<{ everyoneSend: PermissionBit; slowmodeSeconds: number } | null>;
  /** Sets only the Send Messages bit of the @everyone overwrite; an overwrite left empty is removed. */
  setEveryoneSend(channelId: string, value: PermissionBit, reason: string): Promise<void>;
  setSlowmode(channelId: string, seconds: number, reason: string): Promise<void>;
  /** Newest first, at most `limit` (paged by the gateway). */
  recentMessages(channelId: string, limit: number): Promise<RecentMessage[]>;
  /** Deletes messages younger than 14 days; returns how many were deleted. */
  bulkDelete(channelId: string, ids: readonly string[], reason: string): Promise<number>;
  /** Creates a text or voice channel (inside `parentId` when it is a category of this server). */
  createChannel(spec: ChannelCreateRequestDto): Promise<GuildChannelDto>;
}

const notCategory = () => new OpsInputError('Choose a category from this server, or no category.');

/** What a lock replaced, so unlock restores it exactly. Stored in the channel.lock audit payload. */
export interface LockPrior { everyoneSend: PermissionBit }
export interface LockLedger { lastLock(guildId: string, channelId: string): Promise<LockPrior | null> }

const isBit = (value: unknown): value is PermissionBit => value === 'allow' || value === 'deny' || value === 'neutral';
function priorFrom(payload: Record<string, unknown> | null | undefined): LockPrior | null {
  const prior = payload?.prior as { everyoneSend?: unknown } | undefined;
  return prior && isBit(prior.everyoneSend) ? { everyoneSend: prior.everyoneSend } : null;
}

/** Reads the newest lock/unlock row for the channel from tcg_ops_audit; only an unmatched lock counts. */
export function pgLockLedger(): LockLedger {
  return {
    lastLock: (guildId, channelId) => withClient(async (client: pg.Client) => {
      await requireAdminToolsSchema(client);
      const result = await client.query<{ kind: string; payload: Record<string, unknown> }>(
        `SELECT kind, payload FROM public.tcg_ops_audit WHERE guild_id = $1 AND kind IN ('channel.lock', 'channel.unlock')
         AND payload->>'channelId' = $2 ORDER BY id DESC LIMIT 1`, [guildId, channelId]);
      const row = result.rows[0];
      return row?.kind === 'channel.lock' ? priorFrom(row.payload) : null;
    })
  };
}

/** Scans an in-memory audit store (demo and tests). */
export function auditLockLedger(audit: OpsAuditStore): LockLedger {
  return {
    async lastLock(guildId, channelId) {
      let after = 0;
      let found: LockPrior | null = null;
      for (;;) {
        const page = await audit.list({ after, limit: 500 });
        for (const entry of page.entries) {
          if (entry.guildId !== guildId || entry.payload.channelId !== channelId) continue;
          if (entry.kind === 'channel.lock') found = priorFrom(entry.payload);
          else if (entry.kind === 'channel.unlock') found = null;
        }
        if (page.entries.length < 500) return found;
        after = page.nextAfter;
      }
    }
  };
}

const missing = () => new OpsInputError('That channel does not exist or is not a text channel.');

export async function channelState(gateway: ChannelGateway, channelId: string): Promise<ChannelStateDto> {
  const state = await gateway.state(channelId);
  if (!state) throw missing();
  return { channelId, locked: state.everyoneSend === 'deny', slowmodeSeconds: state.slowmodeSeconds };
}

/**
 * Lock: remember the current bit, then deny. Unlock: put back the remembered bit (allow or neutral), or
 * neutral when the channel was locked outside the bot. Other bits of the overwrite are never touched.
 * Returns the audit payload (with `prior` for locks), or null when nothing changed.
 */
export async function setChannelLock(gateway: ChannelGateway, ledger: LockLedger, guildId: string, channelId: string, locked: boolean,
  reason: string): Promise<{ state: ChannelStateDto; changed: boolean; payload: Record<string, unknown> }> {
  const before = await gateway.state(channelId);
  if (!before) throw missing();
  if (locked) {
    if (before.everyoneSend === 'deny') return { state: { channelId, locked: true, slowmodeSeconds: before.slowmodeSeconds }, changed: false, payload: {} };
    await gateway.setEveryoneSend(channelId, 'deny', reason);
    return { state: { channelId, locked: true, slowmodeSeconds: before.slowmodeSeconds }, changed: true,
      payload: { channelId, reason, prior: { everyoneSend: before.everyoneSend } } };
  }
  if (before.everyoneSend !== 'deny') return { state: { channelId, locked: false, slowmodeSeconds: before.slowmodeSeconds }, changed: false, payload: {} };
  const prior = await ledger.lastLock(guildId, channelId);
  const restore: PermissionBit = prior && prior.everyoneSend !== 'deny' ? prior.everyoneSend : 'neutral';
  await gateway.setEveryoneSend(channelId, restore, reason);
  return { state: { channelId, locked: false, slowmodeSeconds: before.slowmodeSeconds }, changed: true,
    payload: { channelId, reason, restored: { everyoneSend: restore }, remembered: prior !== null } };
}

export async function setChannelSlowmode(gateway: ChannelGateway, channelId: string, seconds: number, reason: string): Promise<ChannelStateDto> {
  const before = await gateway.state(channelId);
  if (!before) throw missing();
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > L.slowmodeSecondsMax) throw new OpsInputError(`Slowmode must be 0-${L.slowmodeSecondsMax} seconds.`);
  await gateway.setSlowmode(channelId, seconds, reason);
  return { channelId, locked: before.everyoneSend === 'deny', slowmodeSeconds: seconds };
}

/** How far back a by-user purge looks for that user's messages. */
export const PURGE_USER_SCAN = 500;
/** A safety margin so a message does not age past 14 days between the check and the request. */
const AGE_MARGIN_MS = 60_000;

/**
 * Deletes the newest matching messages younger than 14 days. Messages by `protectedAuthorIds` (the bot: tournament
 * cards, ticket and role panels, stickies, announcements) are never deleted, so a purge cannot break those.
 */
export async function purgeChannel(gateway: ChannelGateway, request: ChannelPurgeRequestDto, now: number,
  protectedAuthorIds: readonly string[] = []): Promise<ChannelPurgeResultDto> {
  if (!(await gateway.state(request.channelId))) throw missing();
  const scanned = await gateway.recentMessages(request.channelId, request.mode === 'count' ? request.count : PURGE_USER_SCAN);
  const candidates = scanned.filter(message => !protectedAuthorIds.includes(message.authorId));
  const picked = (request.mode === 'user' ? candidates.filter(message => message.authorId === request.userId) : candidates).slice(0, request.count);
  const fresh = picked.filter(message => now - message.createdAtMs < L.bulkDeleteMaxAgeMs - AGE_MARGIN_MS);
  const deleted = fresh.length ? await gateway.bulkDelete(request.channelId, fresh.map(message => message.id), request.reason) : 0;
  return { deleted, skippedTooOld: picked.length - fresh.length };
}

export function purgeSummary(result: ChannelPurgeResultDto): string {
  const base = `Deleted ${result.deleted} message${result.deleted === 1 ? '' : 's'}.`;
  return result.skippedTooOld ? `${base} ${result.skippedTooOld} older than 14 days could not be bulk-deleted (Discord limit); delete those by hand.` : base;
}

/** Maps Discord errors from channel controls to messages safe to show. */
export function channelControlError(error: unknown): never {
  const kind = discordErrorKind(error);
  if (kind === 'missing-permissions') throw new OpsInputError('The bot lacks permission here: it needs Manage Channels (create, slowmode), Manage Permissions (lock) or Manage Messages and Read Message History (purge).');
  if (kind === 'channel-missing') throw missing();
  if (kind === 'too-old') throw new OpsInputError('Discord refused: messages older than 14 days cannot be bulk-deleted.');
  throw error;
}

/** Limits only channel creation can hit; anything else goes through channelControlError unchanged. */
export function createChannelError(error: unknown): unknown {
  const code = (error as { code?: unknown })?.code;
  if (code === 30013) return new OpsInputError('This server already has the maximum of 500 channels. Delete one in Discord first.');
  if (code === 50035) return new OpsInputError('Discord refused the channel: the category may be full (50 channels) or the name is not allowed.');
  return error;
}

// ---------------------------------------------------------------- live Discord gateway

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

export function liveChannelGateway(guild: Guild): ChannelGateway {
  const text = async (channelId: string): Promise<GuildTextBasedChannel & { setRateLimitPerUser(seconds: number, reason?: string): Promise<unknown> } | null> => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    return channel && TEXT_TYPES.has(channel.type) ? channel as never : null;
  };
  return {
    async state(channelId) {
      const channel = await text(channelId);
      if (!channel || !('permissionOverwrites' in channel)) return null;
      const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      const everyoneSend: PermissionBit = overwrite?.deny.has(PermissionFlagsBits.SendMessages) ? 'deny'
        : overwrite?.allow.has(PermissionFlagsBits.SendMessages) ? 'allow' : 'neutral';
      return { everyoneSend, slowmodeSeconds: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser ?? 0 : 0 };
    },
    async setEveryoneSend(channelId, value, reason) {
      const channel = await text(channelId);
      if (!channel || !('permissionOverwrites' in channel)) throw missing();
      const everyone = guild.roles.everyone.id;
      const reasonText = reason.slice(0, L.discordReasonLength);
      await channel.permissionOverwrites.edit(everyone, { SendMessages: value === 'neutral' ? null : value === 'allow' }, { reason: reasonText, type: OverwriteType.Role });
      // An overwrite emptied by restoring 'neutral' is removed, so the channel looks exactly as before the lock.
      const after = channel.permissionOverwrites.cache.get(everyone);
      if (value === 'neutral' && after && after.allow.bitfield === 0n && after.deny.bitfield === 0n) await after.delete(reasonText);
    },
    async setSlowmode(channelId, seconds, reason) {
      const channel = await text(channelId);
      if (!channel) throw missing();
      await channel.setRateLimitPerUser(seconds, reason.slice(0, L.discordReasonLength));
    },
    async recentMessages(channelId, limit) {
      const channel = await text(channelId);
      if (!channel) throw missing();
      const out: RecentMessage[] = [];
      let before: string | undefined;
      while (out.length < limit) {
        const page = await channel.messages.fetch({ limit: Math.min(100, limit - out.length), ...(before ? { before } : {}) });
        if (!page.size) break;
        for (const message of page.values()) out.push({ id: message.id, authorId: message.author.id, createdAtMs: message.createdTimestamp });
        before = page.last()?.id;
        if (page.size < 100) break;
      }
      return out;
    },
    async bulkDelete(channelId, ids, reason) {
      const channel = await text(channelId);
      if (!channel || !('bulkDelete' in channel)) throw missing();
      let deleted = 0;
      for (let index = 0; index < ids.length; index += 100) {
        const chunk = ids.slice(index, index + 100);
        if (chunk.length === 1) { await channel.messages.delete(chunk[0]!); deleted += 1; continue; }
        deleted += (await channel.bulkDelete(chunk, true)).size;
      }
      void reason; // Discord's bulk-delete endpoint accepts a reason header only through raw REST; the audit row keeps it.
      return deleted;
    },
    async createChannel(spec) {
      if (spec.parentId) {
        // Only "not found here" means a wrong category; missing access and network errors keep their own message.
        const parent = await guild.channels.fetch(spec.parentId).catch((error: unknown) => {
          const code = (error as { code?: unknown })?.code;
          if (code === 10003 || code === 'GuildChannelUnowned') return null;
          throw error;
        });
        if (parent?.type !== ChannelType.GuildCategory) throw notCategory();
      }
      try {
        const channel = await guild.channels.create({ name: spec.name, type: spec.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
          parent: spec.parentId, reason: spec.reason.slice(0, L.discordReasonLength) });
        return { id: channel.id, name: channel.name, type: spec.type, parentId: channel.parentId, position: channel.position, reserved: false };
      } catch (error) { throw createChannelError(error); }
    }
  };
}

// ---------------------------------------------------------------- demo gateway (in memory)

interface DemoChannelState { everyoneSend: PermissionBit; slowmodeSeconds: number; messages: RecentMessage[] }
const demoStates = new WeakMap<object, Map<string, DemoChannelState>>();

/** Synthetic channel state for the demo: 40 messages per channel spread over 20 days. */
export function demoChannelGateway(demo: { channels: GuildChannelDto[]; members: ReadonlyArray<{ id: string; bot: boolean }> },
  now: () => number): ChannelGateway {
  let states = demoStates.get(demo);
  if (!states) { states = new Map(); demoStates.set(demo, states); }
  const store = states;
  const get = (channelId: string): DemoChannelState | null => {
    const channel = demo.channels.find(item => item.id === channelId && (item.type === 'text' || item.type === 'announcement'));
    if (!channel) return null;
    let state = store.get(channelId);
    if (!state) {
      const humans = demo.members.filter(member => !member.bot);
      const start = now();
      state = { everyoneSend: 'neutral', slowmodeSeconds: 0, messages: Array.from({ length: 40 }, (_, index) => ({
        id: `${BigInt(channelId) + BigInt(1000 + 40 - index)}`, authorId: humans[index % Math.max(1, Math.min(5, humans.length))]?.id ?? channelId,
        createdAtMs: start - index * 12 * 3_600_000 })) };
      store.set(channelId, state);
    }
    return state;
  };
  return {
    async state(channelId) { const state = get(channelId); return state ? { everyoneSend: state.everyoneSend, slowmodeSeconds: state.slowmodeSeconds } : null; },
    async setEveryoneSend(channelId, value) { const state = get(channelId); if (!state) throw missing(); state.everyoneSend = value; },
    async setSlowmode(channelId, seconds) { const state = get(channelId); if (!state) throw missing(); state.slowmodeSeconds = seconds; },
    async recentMessages(channelId, limit) { return structuredClone(get(channelId)?.messages.slice(0, limit) ?? []); },
    async bulkDelete(channelId, ids) {
      const state = get(channelId);
      if (!state) throw missing();
      const before = state.messages.length;
      state.messages = state.messages.filter(message => !ids.includes(message.id));
      return before - state.messages.length;
    },
    async createChannel(spec) {
      if (spec.parentId && !demo.channels.some(item => item.id === spec.parentId && item.type === 'category')) throw notCategory();
      const id = `${demo.channels.reduce((max, item) => BigInt(item.id) > max ? BigInt(item.id) : max, 0n) + 1n}`;
      // Discord lowercases text channel names and joins words with hyphens; voice names keep their spaces.
      const name = spec.type === 'text' ? spec.name.toLowerCase().replace(/\s+/g, '-') : spec.name;
      const position = demo.channels.filter(item => item.parentId === spec.parentId && item.type !== 'category').length;
      const created: GuildChannelDto = { id, name, type: spec.type, parentId: spec.parentId, position, reserved: false };
      demo.channels.push(created);
      return structuredClone(created);
    }
  };
}
