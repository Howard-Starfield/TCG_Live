// The small slice of Discord that button roles, bulk roles and announcements need, behind one interface:
// the live guild in the Discord runtime, the synthetic demo server in the demo and tests.
import { PermissionFlagsBits, type APIActionRowComponent, type APIButtonComponent, type APIEmbed, type Guild,
  type MessageCreateOptions } from 'discord.js';
import type { GuildRoleDto } from '@tcg-live/core';
import type { DemoGuild } from '../demo-guild.js';

export interface OutgoingAllowedMentions { parse: Array<'everyone' | 'roles' | 'users'>; roles: string[]; users: string[] }
/** One message as the bot sends or edits it. */
export interface OutgoingMessage {
  content: string | null;
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIButtonComponent>[];
  allowedMentions: OutgoingAllowedMentions;
}

export interface PortRole {
  id: string; name: string; position: number; managed: boolean;
  /** Carries a staff permission (ELEVATED_ROLE_PERMISSIONS): never handed out by panels, bulk jobs or auto-role. */
  elevated?: boolean;
}

/** Permissions that make a role a staff role. Self-service and automated role grants refuse such roles. */
export const ELEVATED_ROLE_PERMISSIONS: readonly bigint[] = [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageGuildExpressions, PermissionFlagsBits.ManageEvents, PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers];

/** True when a role's permission bitfield carries any elevated permission (Administrator included). */
export function isElevatedPermissions(bitfield: bigint): boolean {
  return ELEVATED_ROLE_PERMISSIONS.some(bit => (bitfield & bit) === bit);
}

/** 'missing': the message or channel no longer exists (Discord 10003 / 10008). */
export type EditOutcome = 'ok' | 'missing';

export interface RolesGuildPort {
  readonly guildId: string;
  /** Roles plus the bot's highest role position (for hierarchy checks). */
  roles(): Promise<{ roles: PortRole[]; botTopPosition: number }>;
  send(channelId: string, message: OutgoingMessage): Promise<string>;
  edit(channelId: string, messageId: string, message: OutgoingMessage): Promise<EditOutcome>;
  /** Resolves 'missing' when it was already gone. */
  remove(channelId: string, messageId: string): Promise<EditOutcome>;
  exists(channelId: string, messageId: string): Promise<boolean>;
  /** Role IDs of a member, or null when the user is not in the server. */
  memberRoles(userId: string): Promise<string[] | null>;
  addRole(userId: string, roleId: string, reason: string): Promise<void>;
  removeRole(userId: string, roleId: string, reason: string): Promise<void>;
}

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
export const isMissing = (error: unknown) => code(error) === 10008 || code(error) === 10003;

/** A short, safe message for a failed Discord call (never raw API payloads). */
export function discordFailure(error: unknown): string {
  switch (code(error)) {
    case 10007: case 10013: return 'Not in the server.';
    case 10011: return 'The role no longer exists.';
    case 10003: return 'The channel no longer exists.';
    case 10008: return 'The message no longer exists.';
    case 50001: return 'The bot cannot see that channel.';
    case 50013: return 'The bot is missing permissions (Manage Roles, or the role is above the bot).';
    case 50035: return 'Discord rejected the message (check lengths and links).';
    default: return 'Discord did not accept the request.';
  }
}

/**
 * Manageable = assignable by the bot: not @everyone, not managed, strictly below the bot's top role, and not
 * a staff role (any ELEVATED_ROLE_PERMISSIONS bit: Administrator, Manage Server, Ban Members...).
 */
export function roleProblem(role: Pick<PortRole, 'id' | 'managed' | 'position' | 'elevated'> | undefined, guildId: string,
  botTopPosition: number): string | null {
  if (!role) return 'unknown';
  if (role.id === guildId) return 'everyone';
  if (role.managed) return 'managed';
  if (role.position >= botTopPosition) return 'above-bot';
  if (role.elevated) return 'elevated';
  return null;
}

function toCreate(message: OutgoingMessage): MessageCreateOptions {
  return { ...(message.content ? { content: message.content } : {}), embeds: message.embeds, components: message.components,
    allowedMentions: { parse: message.allowedMentions.parse, roles: message.allowedMentions.roles, users: message.allowedMentions.users } };
}

export function discordGuildPort(guild: Guild): RolesGuildPort {
  const textChannel = async (channelId: string) => {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) throw Object.assign(new Error('Not a text channel.'), { code: 10003 });
    return channel;
  };
  return {
    guildId: guild.id,
    async roles() {
      const [roles, me] = await Promise.all([guild.roles.fetch(), guild.members.fetchMe()]);
      return { botTopPosition: me.roles.highest.position,
        roles: [...roles.values()].map(role => ({ id: role.id, name: role.name, position: role.position, managed: role.managed,
          elevated: isElevatedPermissions(role.permissions.bitfield) })) };
    },
    async send(channelId, message) { return (await (await textChannel(channelId)).send(toCreate(message))).id; },
    async edit(channelId, messageId, message) {
      try {
        const channel = await textChannel(channelId);
        await channel.messages.edit(messageId, { content: message.content ?? '', embeds: message.embeds, components: message.components,
          allowedMentions: toCreate(message).allowedMentions! });
        return 'ok';
      } catch (error) { if (isMissing(error)) return 'missing'; throw error; }
    },
    async remove(channelId, messageId) {
      try { await (await textChannel(channelId)).messages.delete(messageId); return 'ok'; }
      catch (error) { if (isMissing(error)) return 'missing'; throw error; }
    },
    async exists(channelId, messageId) {
      try { await (await textChannel(channelId)).messages.fetch(messageId); return true; }
      catch (error) { if (isMissing(error)) return false; throw error; }
    },
    async memberRoles(userId) {
      try { return [...(await guild.members.fetch(userId)).roles.cache.keys()]; }
      catch (error) { if (code(error) === 10007 || code(error) === 10013) return null; throw error; }
    },
    async addRole(userId, roleId, reason) { await guild.members.addRole({ user: userId, role: roleId, reason: reason.slice(0, 512) }); },
    async removeRole(userId, roleId, reason) { await guild.members.removeRole({ user: userId, role: roleId, reason: reason.slice(0, 512) }); }
  };
}

export interface DemoSentMessage { channelId: string; message: OutgoingMessage }

/** In-memory port over the demo server. `messages` is exposed so tests can delete a posted panel. */
export class DemoRolesGuildPort implements RolesGuildPort {
  readonly messages = new Map<string, DemoSentMessage>();
  /** Calls made to addRole/removeRole, in order (tests check pacing and resume). */
  readonly roleCalls: Array<{ userId: string; roleId: string; action: 'add' | 'remove'; atMs: number }> = [];
  /** Users whose role change fails (tests). */
  readonly failingUsers = new Set<string>();
  private sequence = 0;
  constructor(private readonly demo: DemoGuild, private readonly now: () => number = Date.now) {}
  get guildId() { return this.demo.id; }
  private channel(channelId: string) {
    const channel = this.demo.channels.find(item => item.id === channelId && item.type !== 'category');
    if (!channel) throw Object.assign(new Error('Unknown channel'), { code: 10003 });
  }
  private botTop(roles: readonly GuildRoleDto[]) {
    return Math.min(...roles.filter(role => role.aboveBot).map(role => role.position), Number.MAX_SAFE_INTEGER);
  }
  async roles() {
    return { botTopPosition: this.botTop(this.demo.roles),
      roles: this.demo.roles.map(role => ({ id: role.id, name: role.name, position: role.position, managed: role.managed,
        elevated: role.elevated === true })) };
  }
  async send(channelId: string, message: OutgoingMessage) {
    this.channel(channelId);
    const id = `3${String(++this.sequence).padStart(17, '0')}`;
    this.messages.set(id, { channelId, message: structuredClone(message) });
    return id;
  }
  async edit(channelId: string, messageId: string, message: OutgoingMessage): Promise<EditOutcome> {
    const sent = this.messages.get(messageId);
    if (!sent || sent.channelId !== channelId) return 'missing';
    sent.message = structuredClone(message);
    return 'ok';
  }
  async remove(channelId: string, messageId: string): Promise<EditOutcome> {
    const sent = this.messages.get(messageId);
    if (!sent || sent.channelId !== channelId) return 'missing';
    this.messages.delete(messageId);
    return 'ok';
  }
  async exists(channelId: string, messageId: string) { return this.messages.get(messageId)?.channelId === channelId; }
  async memberRoles(userId: string) { return this.demo.members.find(member => member.id === userId)?.roleIds.slice() ?? null; }
  private change(userId: string, roleId: string, action: 'add' | 'remove') {
    this.roleCalls.push({ userId, roleId, action, atMs: this.now() });
    if (this.failingUsers.has(userId)) throw Object.assign(new Error('Missing permissions'), { code: 50013 });
    const member = this.demo.members.find(item => item.id === userId);
    if (!member) throw Object.assign(new Error('Unknown member'), { code: 10007 });
    const role = this.demo.roles.find(item => item.id === roleId);
    if (!role) throw Object.assign(new Error('Unknown role'), { code: 10011 });
    if (role.managed || role.aboveBot || role.id === this.demo.id) throw Object.assign(new Error('Missing permissions'), { code: 50013 });
    member.roleIds = action === 'add' ? [...new Set([...member.roleIds, roleId])] : member.roleIds.filter(id => id !== roleId);
  }
  async addRole(userId: string, roleId: string) { this.change(userId, roleId, 'add'); }
  async removeRole(userId: string, roleId: string) { this.change(userId, roleId, 'remove'); }
}
