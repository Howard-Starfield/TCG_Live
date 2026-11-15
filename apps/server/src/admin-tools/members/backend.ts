// Discord access for the members module (agent A): member search and lookup, bans, moderation actions,
// DMs, case-log posts and the server audit log. One live implementation (discord.js, no privileged
// intents: member search and single-member fetches are REST calls) and one demo implementation that
// mutates the synthetic DemoGuild in memory.
import { AuditLogEvent, DiscordAPIError, PermissionFlagsBits, type Guild, type GuildMember, type User } from 'discord.js';
import type { ModCaseKind } from '@tcg-live/core';
import { HttpError } from '../../admin/http/respond.js';
import type { DemoGuild } from '../demo-guild.js';
import type { AdminToolsDiscord } from '../module.js';

export interface MemberRecord {
  id: string; username: string; displayName: string | null; avatarUrl: string | null;
  roleIds: string[]; joinedAtMs: number | null; accountCreatedAtMs: number; bot: boolean;
  timedOutUntilMs: number | null;
  /** False for a known Discord user who is not (or no longer) in the server. */
  inGuild: boolean;
}
export interface BanRecord { userId: string; username: string; avatarUrl: string | null; reason: string | null }

export interface BotPermissions { ban: boolean; kick: boolean; moderate: boolean; viewAuditLog: boolean }
/** What the hierarchy checks need about a target. */
export interface TargetInfo {
  inGuild: boolean;
  isOwner: boolean;
  isBotSelf: boolean;
  /** Highest role position of the target (0 = @everyone only); null when not in the server. */
  targetTop: number | null;
  botTop: number;
  bot: BotPermissions;
  timedOutUntilMs: number | null;
  banned: boolean;
}

export type BackendAction =
  | { kind: 'timeout'; untilMs: number }
  | { kind: 'untimeout' }
  | { kind: 'kick' }
  | { kind: 'ban'; deleteMessageSeconds: number }
  | { kind: 'unban' };

export interface ExternalAuditRecord {
  id: string; kind: ModCaseKind; targetId: string | null; moderatorId: string | null; reason: string | null; occurredAtMs: number;
}
export type ExternalAuditState = 'ok' | 'missing-permission' | 'unavailable';

export interface MembersBackend {
  readonly botUserId: string | null;
  search(query: string, limit: number): Promise<MemberRecord[]>;
  /** In the server, or a known user outside it (inGuild false); null when Discord does not know the ID. */
  member(id: string): Promise<MemberRecord | null>;
  /** Discord order (ascending user ID) after `after`. */
  bans(after: string | null, limit: number): Promise<BanRecord[]>;
  ban(userId: string): Promise<BanRecord | null>;
  target(userId: string): Promise<TargetInfo>;
  apply(userId: string, action: BackendAction, auditReason: string): Promise<void>;
  /** Best effort; resolves false when the member's DMs are closed. */
  dm(userId: string, text: string): Promise<boolean>;
  /** Best effort post to the case log channel. */
  postLog(channelId: string, text: string): Promise<void>;
  /** Ban/unban/kick/timeout entries done outside the bot, newest first, older than beforeMs. */
  externalAudit(beforeMs: number, limit: number): Promise<{ entries: ExternalAuditRecord[]; state: ExternalAuditState }>;
}

const discordCode = (error: unknown): number | null => error instanceof DiscordAPIError && typeof error.code === 'number' ? error.code : null;
/** Discord REST failures as safe dashboard errors. */
export function discordHttpError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const code = discordCode(error);
  if (code === 50013) throw new HttpError(422, 'rule', 'Discord refused: the bot is missing a permission or its role is too low for this member.');
  if (code === 10007 || code === 10013) throw new HttpError(404, 'not_found', 'Discord does not know that member.');
  if (code === 10026) throw new HttpError(404, 'not_found', 'That user is not banned.');
  if (code === 50007) throw new HttpError(422, 'rule', 'Discord refused to message that member.');
  throw new HttpError(503, 'unavailable', 'Discord did not answer. Try again in a moment.');
}

// ------------------------------------------------------------------ live (discord.js)

function fromMember(member: GuildMember): MemberRecord {
  const until = member.communicationDisabledUntilTimestamp;
  return { id: member.id, username: member.user.username, displayName: member.nickname ?? member.user.globalName ?? null,
    avatarUrl: member.displayAvatarURL({ size: 128 }), roleIds: member.roles.cache.filter(role => role.id !== member.guild.id).map(role => role.id),
    joinedAtMs: member.joinedTimestamp ?? null, accountCreatedAtMs: member.user.createdTimestamp, bot: member.user.bot,
    timedOutUntilMs: until && until > Date.now() ? until : null, inGuild: true };
}
function fromUser(user: User): MemberRecord {
  return { id: user.id, username: user.username, displayName: user.globalName ?? null, avatarUrl: user.displayAvatarURL({ size: 128 }),
    roleIds: [], joinedAtMs: null, accountCreatedAtMs: user.createdTimestamp, bot: user.bot, timedOutUntilMs: null, inGuild: false };
}
const DISCORD_EPOCH = 1_420_070_400_000n;
export const snowflakeFromMs = (ms: number): string => String((BigInt(Math.max(ms, 1_420_070_400_001)) - DISCORD_EPOCH) << 22n);

const AUDIT_KINDS: Partial<Record<number, ModCaseKind>> = {
  [AuditLogEvent.MemberBanAdd]: 'ban', [AuditLogEvent.MemberBanRemove]: 'unban', [AuditLogEvent.MemberKick]: 'kick'
};

export function liveMembersBackend(discord: AdminToolsDiscord): MembersBackend {
  const guild = async (): Promise<Guild> => discord.guild();
  const wrap = async <T>(run: () => Promise<T>): Promise<T> => { try { return await run(); } catch (error) { return discordHttpError(error); } };
  const missing = (error: unknown) => { const code = discordCode(error); return code === 10007 || code === 10013 || code === 10026; };
  return {
    get botUserId() { return discord.botUserId(); },
    async search(query, limit) {
      const server = await guild();
      return wrap(async () => [...(await server.members.search({ query, limit, cache: false })).values()].map(fromMember));
    },
    async member(id) {
      const server = await guild();
      try { return fromMember(await server.members.fetch({ user: id, force: true, cache: false })); }
      catch (error) { if (!missing(error)) return discordHttpError(error); }
      try { return fromUser(await server.client.users.fetch(id)); }
      catch (error) { if (missing(error)) return null; return discordHttpError(error); }
    },
    async bans(after, limit) {
      const server = await guild();
      return wrap(async () => [...(await server.bans.fetch({ limit, cache: false, ...(after ? { after } : {}) })).values()]
        .map(ban => ({ userId: ban.user.id, username: ban.user.username, avatarUrl: ban.user.displayAvatarURL({ size: 64 }), reason: ban.reason ?? null })));
    },
    async ban(userId) {
      const server = await guild();
      try {
        const ban = await server.bans.fetch({ user: userId, force: true, cache: false });
        return { userId, username: ban.user.username, avatarUrl: ban.user.displayAvatarURL({ size: 64 }), reason: ban.reason ?? null };
      } catch (error) { if (missing(error)) return null; return discordHttpError(error); }
    },
    async target(userId) {
      const server = await guild();
      return wrap(async () => {
        const me = await server.members.fetchMe();
        let member: GuildMember | null = null;
        try { member = await server.members.fetch({ user: userId, force: true, cache: false }); }
        catch (error) { if (!missing(error)) throw error; }
        let banned = false;
        try { await server.bans.fetch({ user: userId, force: true, cache: false }); banned = true; }
        catch (error) { if (!missing(error) && discordCode(error) !== 50013) throw error; }
        const until = member?.communicationDisabledUntilTimestamp ?? null;
        return {
          inGuild: !!member, isOwner: server.ownerId === userId, isBotSelf: me.id === userId,
          targetTop: member ? member.roles.highest.position : null, botTop: me.roles.highest.position,
          bot: { ban: me.permissions.has(PermissionFlagsBits.BanMembers), kick: me.permissions.has(PermissionFlagsBits.KickMembers),
            moderate: me.permissions.has(PermissionFlagsBits.ModerateMembers), viewAuditLog: me.permissions.has(PermissionFlagsBits.ViewAuditLog) },
          timedOutUntilMs: until && until > Date.now() ? until : null, banned
        };
      });
    },
    async apply(userId, action, reason) {
      const server = await guild();
      await wrap(async () => {
        switch (action.kind) {
          case 'timeout': await server.members.edit(userId, { communicationDisabledUntil: new Date(action.untilMs), reason }); return;
          case 'untimeout': await server.members.edit(userId, { communicationDisabledUntil: null, reason }); return;
          case 'kick': await server.members.kick(userId, reason); return;
          case 'ban': await server.bans.create(userId, { reason, deleteMessageSeconds: action.deleteMessageSeconds }); return;
          case 'unban': await server.bans.remove(userId, reason); return;
        }
      });
    },
    async dm(userId, text) {
      try {
        const server = await guild();
        await server.client.users.send(userId, { content: text, allowedMentions: { parse: [] } });
        return true;
      } catch { return false; }
    },
    async postLog(channelId, text) {
      const server = await guild();
      const channel = await server.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) await channel.send({ content: text, allowedMentions: { parse: [] } });
    },
    async externalAudit(beforeMs, limit) {
      let server: Guild;
      try { server = await guild(); } catch { return { entries: [], state: 'unavailable' }; }
      try {
        const me = await server.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return { entries: [], state: 'missing-permission' };
        const logs = await server.fetchAuditLogs({ limit: 100, before: snowflakeFromMs(beforeMs) });
        const entries: ExternalAuditRecord[] = [];
        for (const entry of logs.entries.values()) {
          if (entry.executorId && entry.executorId === me.id) continue;   // ours: already a case
          let kind = AUDIT_KINDS[entry.action] ?? null;
          if (entry.action === AuditLogEvent.MemberUpdate) {
            const change = entry.changes.find(item => item.key === 'communication_disabled_until');
            if (change) kind = change.new ? 'timeout' : 'untimeout';
          }
          if (!kind) continue;
          entries.push({ id: entry.id, kind, targetId: entry.targetId ?? null, moderatorId: entry.executorId ?? null,
            reason: entry.reason ?? null, occurredAtMs: entry.createdTimestamp });
          if (entries.length >= limit) break;
        }
        return { entries, state: 'ok' };
      } catch (error) {
        return { entries: [], state: discordCode(error) === 50013 ? 'missing-permission' : 'unavailable' };
      }
    }
  };
}

// ------------------------------------------------------------------ demo (in-memory DemoGuild)

export interface DemoMembersBackendOptions {
  /** Records DMs and log posts (tests); a user ID in `closedDms` fails its DM. */
  closedDms?: Set<string>;
  sent?: Array<{ to: string; text: string }>;
  now?(): number;
}

export function demoMembersBackend(demo: DemoGuild, options: DemoMembersBackendOptions = {}): MembersBackend {
  const now = options.now ?? Date.now;
  const botMember = () => demo.members.find(member => member.bot && member.roleIds.some(id => demo.roles.find(role => role.id === id)?.managed));
  const position = (roleIds: readonly string[]) => Math.max(0, ...roleIds.map(id => demo.roles.find(role => role.id === id)?.position ?? 0));
  const record = (id: string): MemberRecord | null => {
    const member = demo.members.find(item => item.id === id);
    if (member) return { ...structuredClone(member), timedOutUntilMs: member.timedOutUntilMs && member.timedOutUntilMs > now() ? member.timedOutUntilMs : null,
      inGuild: true };
    const ban = demo.bans.find(item => item.userId === id);
    if (ban) return { id, username: ban.username, displayName: null, avatarUrl: null, roleIds: [], joinedAtMs: null,
      // Snowflake timestamp of the ID.
      accountCreatedAtMs: Number((BigInt(id) >> 22n) + DISCORD_EPOCH), bot: false, timedOutUntilMs: null, inGuild: false };
    return null;
  };
  return {
    get botUserId() { return botMember()?.id ?? null; },
    async search(query, limit) {
      const q = query.toLowerCase();
      return demo.members.filter(member => member.username.toLowerCase().startsWith(q) || (member.displayName ?? '').toLowerCase().startsWith(q))
        .slice(0, limit).map(member => record(member.id)!);
    },
    async member(id) { return record(id); },
    async bans(after, limit) {
      return [...demo.bans].sort((a, b) => (BigInt(a.userId) < BigInt(b.userId) ? -1 : 1))
        .filter(ban => !after || BigInt(ban.userId) > BigInt(after)).slice(0, limit)
        .map(ban => ({ userId: ban.userId, username: ban.username, avatarUrl: null, reason: ban.reason }));
    },
    async ban(userId) {
      const ban = demo.bans.find(item => item.userId === userId);
      return ban ? { userId, username: ban.username, avatarUrl: null, reason: ban.reason } : null;
    },
    async target(userId) {
      const member = demo.members.find(item => item.id === userId);
      const bot = botMember();
      return { inGuild: !!member, isOwner: false, isBotSelf: bot?.id === userId, targetTop: member ? position(member.roleIds) : null,
        botTop: bot ? position(bot.roleIds) : 0, bot: { ban: true, kick: true, moderate: true, viewAuditLog: true },
        timedOutUntilMs: member?.timedOutUntilMs && member.timedOutUntilMs > now() ? member.timedOutUntilMs : null,
        banned: demo.bans.some(item => item.userId === userId) };
    },
    async apply(userId, action, reason) {
      const index = demo.members.findIndex(item => item.id === userId);
      const member = demo.members[index];
      switch (action.kind) {
        case 'timeout': if (member) member.timedOutUntilMs = action.untilMs; return;
        case 'untimeout': if (member) member.timedOutUntilMs = null; return;
        case 'kick': if (index >= 0) demo.members.splice(index, 1); return;
        case 'ban': {
          const username = member?.username ?? record(userId)?.username ?? userId;
          if (index >= 0) demo.members.splice(index, 1);
          if (!demo.bans.some(item => item.userId === userId)) demo.bans.push({ userId, username, reason });
          return;
        }
        case 'unban': {
          const at = demo.bans.findIndex(item => item.userId === userId);
          if (at < 0) throw new HttpError(404, 'not_found', 'That user is not banned.');
          demo.bans.splice(at, 1);
        }
      }
    },
    async dm(userId, text) {
      if (options.closedDms?.has(userId)) return false;
      options.sent?.push({ to: userId, text });
      return true;
    },
    async postLog(channelId, text) { options.sent?.push({ to: channelId, text }); },
    async externalAudit() { return { entries: [], state: 'ok' }; }
  };
}
