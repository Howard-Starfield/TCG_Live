// What the match room pool needs from Discord, behind one interface: the live implementation over the gateway client,
// and the demo's, which acts on the synthetic DemoGuild. Renames are a separate transport (RoomRenamer), because they go
// through a dedicated REST instance that rejects instead of waiting on a rate limit.
import { ChannelType, OverwriteType, Routes, type Client, type Guild, type GuildBasedChannel, type REST } from 'discord.js';
import type { MemberDto } from '@tcg-live/core';
import type { RoomOverwrite } from '../../discord/match-rooms.js';
import type { DemoGuild } from '../demo-guild.js';

export interface RoomChannel {
  id: string;
  name: string;
  kind: 'voice' | 'stage' | 'category' | 'text' | 'other';
  parentId: string | null;
}

export interface CreateVoiceRoomInput {
  name: string;
  parentId: string | null;
  overwrites: RoomOverwrite[];
  reason: string;
}

export interface MatchRoomDiscord {
  readonly guildId: string;
  botUserId(): string | null;
  /** The server's AFK voice channel: never a match room. */
  afkChannelId(): string | null;
  /** Whether the bot has Manage Channels server-wide (the pool needs it to create rooms and categories). */
  canManageChannels(): boolean;
  /** Every channel in the server, fresh. Its length is what counts against Discord's 500 channel limit. */
  list(): Promise<RoomChannel[]>;
  /** The channel, or null when it no longer exists. Other failures throw. */
  get(channelId: string): Promise<RoomChannel | null>;
  createCategory(name: string, reason: string): Promise<RoomChannel>;
  createVoice(input: CreateVoiceRoomInput): Promise<RoomChannel>;
  overwrites(channelId: string): Promise<RoomOverwrite[]>;
  setOverwrites(channelId: string, overwrites: RoomOverwrite[], reason: string): Promise<void>;
  deleteChannel(channelId: string, reason: string): Promise<void>;
  /** Who is connected, or null when voice states are not available. */
  occupants(channelId: string): MemberDto[] | null;
}

/** Sends one rename and resolves when Discord accepted it. Rejects with a rate limit error instead of waiting. */
export interface RoomRenamer {
  rename(channelId: string, name: string, reason: string): Promise<void>;
}

const UNKNOWN_CHANNEL = 10003;
const codeOf = (error: unknown): number | undefined => (error as { code?: number } | null)?.code;

function kindOf(type: ChannelType): RoomChannel['kind'] {
  return type === ChannelType.GuildVoice ? 'voice' : type === ChannelType.GuildStageVoice ? 'stage'
    : type === ChannelType.GuildCategory ? 'category' : type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement ? 'text' : 'other';
}

const roomChannel = (channel: GuildBasedChannel): RoomChannel => ({ id: channel.id, name: channel.name, kind: kindOf(channel.type),
  parentId: 'parentId' in channel ? channel.parentId : null });

/** The dedicated REST instance renames use: `rejectOnRateLimit` makes a limited channel throw at once (see discord/sdk.ts). */
export function liveRoomRenamer(rest: Pick<REST, 'patch'>): RoomRenamer {
  return {
    async rename(channelId, name, reason) { await rest.patch(Routes.channel(channelId), { body: { name }, reason }); }
  };
}

export function liveMatchRoomDiscord(client: () => Client, guildId: string, voiceStates: boolean): MatchRoomDiscord {
  const guild = async (): Promise<Guild> => client().guilds.cache.get(guildId) ?? client().guilds.fetch(guildId);
  const cachedGuild = (): Guild | undefined => client().guilds.cache.get(guildId);
  const raw = (overwrites: RoomOverwrite[]) => overwrites.map(row => ({ id: row.id, type: row.type as OverwriteType,
    allow: BigInt(row.allow), deny: BigInt(row.deny) }));
  const fetchTarget = async (channelId: string) => {
    const channel = await (await guild()).channels.fetch(channelId, { force: true }).catch(error => {
      if (codeOf(error) === UNKNOWN_CHANNEL) return null;
      throw error;
    });
    return channel;
  };
  return {
    guildId,
    botUserId: () => client().user?.id ?? null,
    afkChannelId: () => cachedGuild()?.afkChannelId ?? null,
    canManageChannels: () => cachedGuild()?.members.me?.permissions.has('ManageChannels') ?? false,
    async list() {
      // The gateway keeps the channel cache current; it is read often (every dashboard refresh), so no REST call when it is filled.
      const found = await guild();
      const channels = found.channels.cache.size ? found.channels.cache : await found.channels.fetch();
      return [...channels.values()].flatMap(channel => channel ? [roomChannel(channel)] : []);
    },
    async get(channelId) {
      const channel = await fetchTarget(channelId);
      return channel ? roomChannel(channel) : null;
    },
    async createCategory(name, reason) {
      return roomChannel(await (await guild()).channels.create({ name, type: ChannelType.GuildCategory, reason }));
    },
    async createVoice(input) {
      // One call with the final name and permissions: the room never needs a rename (or a second call) after creation.
      return roomChannel(await (await guild()).channels.create({ name: input.name, type: ChannelType.GuildVoice,
        ...(input.parentId ? { parent: input.parentId } : {}), permissionOverwrites: raw(input.overwrites), reason: input.reason }));
    },
    async overwrites(channelId) {
      const channel = await fetchTarget(channelId);
      if (!channel || !('permissionOverwrites' in channel)) return [];
      return [...channel.permissionOverwrites.cache.values()].map(overwrite => ({ id: overwrite.id, type: overwrite.type,
        allow: overwrite.allow.bitfield.toString(), deny: overwrite.deny.bitfield.toString() }));
    },
    async setOverwrites(channelId, overwrites, reason) {
      const channel = await fetchTarget(channelId);
      if (!channel || !('permissionOverwrites' in channel)) return;
      await channel.permissionOverwrites.set(raw(overwrites), reason);
    },
    async deleteChannel(channelId, reason) {
      const channel = await fetchTarget(channelId);
      if (channel) await channel.delete(reason);
    },
    occupants(channelId) {
      const found = cachedGuild();
      if (!voiceStates || !found) return null;
      return [...found.voiceStates.cache.values()].filter(state => state.channelId === channelId && !state.member?.user.bot)
        .map(state => ({ id: state.id, displayName: state.member?.displayName ?? null,
          avatarUrl: state.member?.displayAvatarURL({ size: 64 }) ?? null }));
    }
  };
}

// ---- Demo ------------------------------------------------------------------------------------------------------

export interface DemoRenameClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
}

const realClock: DemoRenameClock = { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms) };

/** A synthetic server's channels, changed in place. Channel IDs come from the demo's snowflake range. */
export function demoMatchRoomDiscord(demo: DemoGuild, options: { botId?: string; nextId?: () => string;
  /** Who is connected to a room; the demo has nobody connected unless a test says otherwise. */
  occupants?: (channelId: string) => MemberDto[] | null } = {}): MatchRoomDiscord & {
  /** Applies a rename to the synthetic server (what the demo rename transport calls once its delay has passed). */
  rename(channelId: string, name: string): void } {
  let counter = 0n;
  const nextId = options.nextId ?? (() => { counter += 1n; return (930000000000000000n + counter).toString(); });
  const overwriteRows = new Map<string, RoomOverwrite[]>();
  const kind = (type: DemoGuild['channels'][number]['type']): RoomChannel['kind'] =>
    type === 'voice' ? 'voice' : type === 'stage' ? 'stage' : type === 'category' ? 'category' : type === 'text' || type === 'announcement' ? 'text' : 'other';
  const view = (id: string): RoomChannel | null => {
    const found = demo.channels.find(channel => channel.id === id);
    return found ? { id: found.id, name: found.name, kind: kind(found.type), parentId: found.parentId } : null;
  };
  const add = (name: string, type: 'voice' | 'category', parentId: string | null, reserved: boolean): RoomChannel => {
    const id = nextId();
    const position = demo.channels.reduce((most, channel) => Math.max(most, channel.position), -1) + 1;
    demo.channels.push({ id, name, type, parentId, position, reserved });
    return view(id)!;
  };
  return {
    guildId: demo.id,
    botUserId: () => options.botId ?? null,
    afkChannelId: () => null,
    canManageChannels: () => true,
    async list() { return demo.channels.map(channel => view(channel.id)!); },
    async get(channelId) { return view(channelId); },
    async createCategory(name) { return add(name, 'category', null, false); },
    async createVoice(input) {
      const room = add(input.name, 'voice', input.parentId, true);
      overwriteRows.set(room.id, input.overwrites);
      return room;
    },
    async overwrites(channelId) { return overwriteRows.get(channelId) ?? []; },
    async setOverwrites(channelId, overwrites) { overwriteRows.set(channelId, overwrites); },
    async deleteChannel(channelId) {
      const index = demo.channels.findIndex(channel => channel.id === channelId);
      if (index >= 0) demo.channels.splice(index, 1);
      overwriteRows.delete(channelId);
    },
    occupants(channelId) { return options.occupants ? options.occupants(channelId) : []; },
    rename(channelId, name) {
      const found = demo.channels.find(channel => channel.id === channelId);
      if (found) found.name = name;
    }
  };
}

/**
 * The demo's rename transport: applies a rename after a short delay (so "queued" is visible) and enforces Discord's
 * limit of 2 renames per 10 minutes per channel on the real clock, like the live REST instance does.
 */
export function demoRoomRenamer(apply: (channelId: string, name: string) => void, options: { delayMs?: number; clock?: DemoRenameClock;
  perWindow?: number; windowMs?: number } = {}): RoomRenamer {
  const clock = options.clock ?? realClock;
  const delay = options.delayMs ?? 1_500;
  const perWindow = options.perWindow ?? 2;
  const windowMs = options.windowMs ?? 600_000;
  const log = new Map<string, number[]>();
  return {
    async rename(channelId, name) {
      const recent = (log.get(channelId) ?? []).filter(at => clock.now() - at < windowMs);
      if (recent.length >= perWindow) {
        const retryAfter = recent[recent.length - perWindow]! + windowMs - clock.now();
        throw Object.assign(new Error('You are being rate limited.'), { name: 'RateLimitError', retryAfter, timeToReset: retryAfter });
      }
      log.set(channelId, [...recent, clock.now()]);
      await new Promise<void>(resolve => { clock.setTimeout(resolve, delay); });
      apply(channelId, name);
    }
  };
}
