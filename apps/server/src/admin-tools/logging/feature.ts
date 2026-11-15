// (D) Discord feature: join/leave/role/nick log, welcome, auto-role and the message edit/delete log.
// Listens to raw gateway packets so uncached members and messages are still seen (the client has no partials);
// the previous member/message state is read from the discord.js cache synchronously, before discord.js
// applies the packet. Privileged intents are opt-in through adminToolsPrivilegedIntents.
import type { Client, Guild, GuildMember } from 'discord.js';
import type { LoggingSettingsDto } from '@tcg-live/core';
import type { DiscordFeature, DiscordFeatureContext } from '../../discord/features.js';
import { adminToolsPrivilegedIntents } from '../discord-feature.js';
import { LoggingProcessor, type LoggingDeps, type MemberSnapshot } from './processor.js';
import { pgLoggingStore, type LoggingStore } from './store.js';
import { snowflakeTimeMs } from './template.js';
import { isElevatedPermissions } from '../roles/guild-port.js';

export const PURGE_INTERVAL_MS = 60 * 60_000;
export const PURGE_FIRST_RUN_MS = 60_000;

/** A raw gateway dispatch ({ t, d }). */
export interface RawPacket { t?: string | null; d?: any }

type Cache = {
  member(guildId: string, userId: string): MemberSnapshot | null;
  message(channelId: string, messageId: string): string | null;
};

export function clientCache(client: Client): Cache {
  return {
    member(guildId, userId) {
      const member: GuildMember | undefined = client.guilds.cache.get(guildId)?.members.cache.get(userId);
      return member ? { roleIds: [...member.roles.cache.keys()].filter(id => id !== guildId), nick: member.nickname } : null;
    },
    message(channelId, messageId) {
      const channel = client.channels.cache.get(channelId) as { messages?: { cache: Map<string, { content: string }> } } | undefined;
      return channel?.messages?.cache.get(messageId)?.content ?? null;
    }
  };
}

const username = (user: any): string => String(user?.global_name ?? user?.username ?? 'unknown').slice(0, 100);

/**
 * Turns one raw packet into processor calls. Reads cached "before" state synchronously and returns the work
 * as a promise (or null when the packet is not ours).
 */
export function dispatchRawPacket(packet: RawPacket, processor: LoggingProcessor, guildId: string, cache: Cache, now: () => number): Promise<unknown> | null {
  const d = packet.d;
  if (!d || typeof d !== 'object') return null;
  switch (packet.t) {
    case 'GUILD_MEMBER_ADD':
      if (d.guild_id !== guildId || !d.user?.id) return null;
      return processor.memberJoined({ userId: d.user.id, username: username(d.user), bot: !!d.user.bot, accountCreatedAtMs: snowflakeTimeMs(d.user.id) });
    case 'GUILD_MEMBER_REMOVE':
      if (d.guild_id !== guildId || !d.user?.id) return null;
      return processor.memberLeft({ userId: d.user.id, username: username(d.user), bot: !!d.user.bot });
    case 'GUILD_MEMBER_UPDATE': {
      if (d.guild_id !== guildId || !d.user?.id) return null;
      const before = cache.member(guildId, d.user.id);
      return processor.memberUpdated({ userId: d.user.id, before,
        after: { roleIds: Array.isArray(d.roles) ? d.roles : [], nick: typeof d.nick === 'string' ? d.nick : null } });
    }
    case 'MESSAGE_CREATE':
      return processor.messageCreated({ guildId: d.guild_id ?? null, messageId: d.id, channelId: d.channel_id, authorId: d.author?.id,
        bot: !!d.author?.bot, webhook: !!d.webhook_id, content: typeof d.content === 'string' ? d.content : '',
        attachmentCount: Array.isArray(d.attachments) ? d.attachments.length : 0,
        createdAtMs: d.timestamp ? Date.parse(d.timestamp) : now() });
    case 'MESSAGE_UPDATE': {
      const cachedBefore = cache.message(d.channel_id, d.id);
      return processor.messageUpdated({ guildId: d.guild_id ?? null, messageId: d.id, channelId: d.channel_id,
        content: typeof d.content === 'string' ? d.content : undefined,
        attachmentCount: Array.isArray(d.attachments) ? d.attachments.length : undefined,
        authorId: d.author?.id ?? null, bot: !!d.author?.bot || !!d.webhook_id, cachedBefore,
        editedAtMs: d.edited_timestamp ? Date.parse(d.edited_timestamp) : now() });
    }
    case 'MESSAGE_DELETE':
      return processor.messagesDeleted({ guildId: d.guild_id ?? null, channelId: d.channel_id, messageIds: [d.id], bulk: false });
    case 'MESSAGE_DELETE_BULK':
      return processor.messagesDeleted({ guildId: d.guild_id ?? null, channelId: d.channel_id,
        messageIds: Array.isArray(d.ids) ? d.ids : [], bulk: true });
    default:
      return null;
  }
}

/** discord.js-backed processor dependencies. */
export function liveLoggingDeps(ctx: DiscordFeatureContext, store: LoggingStore, settings: () => Promise<LoggingSettingsDto>): LoggingDeps {
  const guild = (): Promise<Guild> => ctx.guild();
  return {
    guildId: ctx.guildId, store, settings,
    intents: () => ctx.privilegedIntents(),
    async post(channelId, message) {
      const channel = await (await guild()).channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) throw new Error('Not a text channel the bot can see.');
      await channel.send(message);
    },
    serverName: async () => (await guild()).name,
    memberCount: async () => (await guild()).memberCount ?? null,
    async manageableRoles(roleIds) {
      const g = await guild();
      const [roles, me] = await Promise.all([g.roles.fetch(), g.members.fetchMe()]);
      const top = me.roles.highest.position;
      const ok: string[] = [], skipped: string[] = [];
      for (const id of roleIds) {
        const role = roles.get(id);
        // Staff roles (Administrator, Ban Members...) are never auto-assigned.
        (role && !role.managed && id !== g.id && role.position < top && !isElevatedPermissions(role.permissions.bitfield) ? ok : skipped).push(id);
      }
      return { ok, skipped };
    },
    async addRoles(userId, roleIds, reason) {
      const member = await (await guild()).members.fetch(userId);
      await member.roles.add([...roleIds], reason);
    },
    audit: (kind, payload) => ctx.audit(kind, payload),
    log: message => ctx.log(message),
    now: Date.now
  };
}

export interface LoggingFeatureOptions {
  store?: LoggingStore;
  /** Test seam: replaces the discord.js-backed dependencies. */
  deps?(ctx: DiscordFeatureContext, store: LoggingStore, settings: () => Promise<LoggingSettingsDto>): LoggingDeps;
  purgeIntervalMs?: number;
  purgeFirstRunMs?: number;
}

export type LoggingFeature = DiscordFeature & {
  /** Feeds one raw packet (tests); resolves when its work is done. */
  handleRaw(packet: RawPacket): Promise<void>;
  purgeNow(): Promise<void>;
};

export function loggingFeature(options: LoggingFeatureOptions = {}): LoggingFeature {
  const stops: Array<() => void> = [];
  let processor: LoggingProcessor | null = null;
  let ctx: DiscordFeatureContext | null = null;
  let cache: Cache | null = null;
  let failing = false;
  const report = (error: unknown) => {
    if (failing) return;
    failing = true;
    ctx?.log(`Logging: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
  };
  const handle = (packet: RawPacket): Promise<void> => {
    if (!processor || !ctx || !ctx.isActive() || !cache) return Promise.resolve();
    let work: Promise<unknown> | null;
    try { work = dispatchRawPacket(packet, processor, ctx.guildId, cache, Date.now); } catch (error) { report(error); return Promise.resolve(); }
    return (work ?? Promise.resolve()).then(() => { failing = false; }, report);
  };
  const purge = async () => {
    if (!processor || !ctx?.isActive()) return;
    try { await processor.purge(); failing = false; } catch (error) { report(error); }
  };
  return {
    name: 'logging',
    intentsFor: adminToolsPrivilegedIntents,
    async start(context) {
      ctx = context;
      const store = options.store ?? pgLoggingStore();
      let settings: LoggingSettingsDto = (await context.adminToolsSettings()).logging;
      stops.push(context.on('adminToolsSettingsChanged', event => { settings = event.settings.logging; }));
      const read = async () => settings;
      processor = new LoggingProcessor((options.deps ?? liveLoggingDeps)(context, store, read));
      const intents = context.privilegedIntents();
      const idle = [settings.joinLeave.enabled || settings.welcome.enabled || settings.autoRole.enabled ? intents.guildMembers === 'on' ? null : 'Server Members Intent' : null,
        settings.messageLog.enabled && intents.messageContent !== 'on' ? 'Message Content Intent' : null].filter(Boolean);
      if (idle.length) context.log(`Logging: idle until the ${idle.join(' and ')} is turned on in the Discord Developer Portal and the bot restarts.`);
      if (!options.deps) {
        cache = clientCache(context.client);
        const listener = (packet: RawPacket) => { void handle(packet); };
        context.client.on('raw', listener);
        stops.push(() => { context.client.off('raw', listener); });
        // Fill the member cache so role/nickname changes have a "before" (needs the Server Members Intent).
        if (intents.guildMembers === 'on' && settings.joinLeave.enabled && settings.joinLeave.memberUpdates)
          void context.guild().then(guild => guild.members.fetch()).catch(() => {});
      } else cache = { member: () => null, message: () => null };
      const first = setTimeout(() => { void purge(); }, options.purgeFirstRunMs ?? PURGE_FIRST_RUN_MS);
      const every = setInterval(() => { void purge(); }, options.purgeIntervalMs ?? PURGE_INTERVAL_MS);
      first.unref(); every.unref();
      stops.push(() => { clearTimeout(first); clearInterval(every); });
    },
    stop() { for (const stop of stops.splice(0)) stop(); processor = null; },
    handleRaw: handle,
    purgeNow: purge
  };
}

/** Test seam: lets tests provide a member/message cache for raw dispatch. */
export type LoggingCache = Cache;
