// Live Discord side of the permission check: a GuildPermissionView from discord.js (permissionsFor()
// applies overwrites, Administrator and the owner), the enabled-features config from the stores, and the
// gateway events that trigger a re-check.
import { ChannelType, Events, type Client, type Guild, type GuildMember } from 'discord.js';
import type { AdminToolsSettingsBodyDto, LfgSettingsBodyDto, ModerationSettingsDto, PermissionReportDto } from '@tcg-live/core';
import type { AnnouncementStore } from '../admin-tools/announcements/announcements.js';
import type { StickyStore } from '../admin-tools/channels/sticky-store.js';
import type { BulkRoleJobStore } from '../admin-tools/roles/bulk.js';
import type { ButtonRolePanelStore } from '../admin-tools/roles/panels.js';
import { checkPermissions, permissionReport, unavailableReport, type ChannelView, type GuildPermissionView,
  type PermissionConfig } from './checker.js';
import { PermissionMonitor } from './monitor.js';

const TYPES: Partial<Record<ChannelType, ChannelView['type']>> = {
  [ChannelType.GuildText]: 'text', [ChannelType.GuildAnnouncement]: 'text', [ChannelType.GuildForum]: 'text',
  [ChannelType.GuildVoice]: 'voice', [ChannelType.GuildStageVoice]: 'voice', [ChannelType.GuildCategory]: 'category'
};

export function liveGuildView(guild: Guild, me: GuildMember): GuildPermissionView {
  const top = me.roles.highest;
  return {
    guildId: guild.id,
    guildPermissions: me.permissions.bitfield,
    botTopRole: top ? { id: top.id, name: top.name, position: top.position } : null,
    channels: [...guild.channels.cache.values()].flatMap(channel => 'permissionsFor' in channel && !channel.isThread() ? [{
      id: channel.id, name: channel.name, type: TYPES[channel.type] ?? 'other',
      permissions: channel.permissionsFor(me)?.bitfield ?? 0n }] : []),
    roles: [...guild.roles.cache.values()].map(role => ({ id: role.id, name: role.name, position: role.position,
      managed: role.managed, mentionable: role.mentionable }))
  };
}

/** Moderation needs: AutoMod when text moderation is on, voice when the runtime and the settings both have it on. */
export function moderationNeeds(settings: ModerationSettingsDto | null, voiceRuntime: boolean): PermissionConfig['moderation'] {
  if (!settings) return voiceRuntime ? { textEnabled: false, timeoutRules: false, voiceEnabled: false, voiceNoticeChannelId: null } : null;
  const text = settings.text;
  return { textEnabled: text.enabled,
    timeoutRules: text.enabled && text.customLists.some(list => list.enabled && list.action === 'timeout'),
    voiceEnabled: voiceRuntime && settings.voice.enabled,
    voiceNoticeChannelId: settings.voice.notifyDiscord ? settings.voice.notifyChannelId : null };
}

/** LFG needs: each LFG channel and the roles its cards may ping, while LFG is enabled. */
export function lfgNeeds(settings: LfgSettingsBodyDto | null): PermissionConfig['lfg'] {
  if (!settings?.enabled || !settings.channels.length) return null;
  return { channels: settings.channels.map(channel => {
    const games = channel.games.length ? settings.games.filter(game => channel.games.includes(game.name)) : settings.games;
    const fallback = channel.pingRoleId ?? settings.pingRoleId;
    // As lfgChannelConfig().pingRoleFor: a game's own role wins, else the channel's, else the global one.
    // With no game list members type any game, which always uses the fallback.
    const roles = games.length ? games.map(game => game.pingRoleId ?? fallback) : [fallback];
    return { channelId: channel.channelId, pingRoleIds: [...new Set(roles.filter((id): id is string => !!id))] };
  }) };
}

export interface AdminToolsNeedStores {
  stickies: Pick<StickyStore, 'list'>;
  panels: Pick<ButtonRolePanelStore, 'list'>;
  bulk: Pick<BulkRoleJobStore, 'open'>;
  announcements: Pick<AnnouncementStore, 'list'>;
}

/** What the saved admin-tools data needs. A store that fails (schema missing, database down) counts as empty. */
export async function adminToolsNeeds(guildId: string, settings: AdminToolsSettingsBodyDto,
  stores: AdminToolsNeedStores): Promise<NonNullable<PermissionConfig['adminTools']>> {
  const safe = async <T>(run: () => Promise<T[]>): Promise<T[]> => { try { return await run(); } catch { return []; } };
  const [stickies, panels, jobs, announcements] = await Promise.all([safe(() => stores.stickies.list(guildId)),
    safe(() => stores.panels.list(guildId)), safe(() => stores.bulk.open(guildId)), safe(() => stores.announcements.list(guildId, 200))]);
  return {
    settings,
    stickies: stickies.filter(item => item.enabled).map(item => ({ channelId: item.channelId, embed: !!item.embed })),
    panels: panels.map(panel => ({ channelId: panel.channelId, embed: !!panel.body.embed, roleIds: panel.buttons.map(button => button.roleId) })),
    bulkRoleIds: jobs.map(job => job.roleId),
    announcements: announcements.filter(item => item.status === 'scheduled').map(item => ({ channelId: item.channelId,
      embed: !!item.body.embed, mentionEveryone: item.mentionEveryone, mentionRoleIds: item.mentionRoleIds }))
  };
}

/**
 * Gateway events that can change what the bot may do. All arrive with the non-privileged Guilds intent,
 * except guildMemberUpdate for the bot itself, which Discord may only send with the Server Members intent
 * (role changes on the bot's own role still arrive as roleUpdate).
 */
export function watchPermissionEvents(client: Client, guildId: string, schedule: () => void): () => void {
  const inGuild = (id: string | undefined | null) => { if (id === guildId) schedule(); };
  const handlers: Array<[string, (...args: never[]) => void]> = [
    [Events.GuildUpdate, ((_before: Guild, after: Guild) => inGuild(after.id)) as never],
    [Events.GuildRoleCreate, ((role: { guild: Guild }) => inGuild(role.guild.id)) as never],
    [Events.GuildRoleUpdate, ((_before: unknown, role: { guild: Guild }) => inGuild(role.guild.id)) as never],
    [Events.GuildRoleDelete, ((role: { guild: Guild }) => inGuild(role.guild.id)) as never],
    [Events.ChannelCreate, ((channel: { guildId?: string }) => inGuild(channel.guildId)) as never],
    [Events.ChannelUpdate, ((_before: unknown, channel: { guildId?: string }) => inGuild(channel.guildId)) as never],
    [Events.ChannelDelete, ((channel: { guildId?: string }) => inGuild(channel.guildId)) as never],
    [Events.GuildMemberUpdate, ((_before: unknown, member: GuildMember) => {
      if (member.id === client.user?.id) inGuild(member.guild.id);
    }) as never],
    [Events.ShardReady, (() => schedule()) as never],
    [Events.ShardResume, (() => schedule()) as never]
  ];
  for (const [event, handler] of handlers) client.on(event, handler as (...args: unknown[]) => void);
  return () => { for (const [event, handler] of handlers) client.off(event, handler as (...args: unknown[]) => void); };
}

export interface LivePermissionDeps {
  /** The current client (replaced at login). */
  client(): Client;
  guildId: string;
  applicationId: string;
  tournament(): PermissionConfig['tournament'];
  moderation(): Promise<ModerationSettingsDto | null>;
  voiceRuntime: boolean;
  adminToolsSettings(): Promise<AdminToolsSettingsBodyDto>;
  /** Wanted vs granted privileged intents for these settings; null while the gateway is not running. */
  intents(settings: AdminToolsSettingsBodyDto): PermissionConfig['intents'];
  stores: AdminToolsNeedStores;
  /** Saved LFG settings; null when unavailable (schema missing, database down). */
  lfgSettings?(): Promise<LfgSettingsBodyDto | null>;
  /** The saved TCG Organizer and TCG Judge role IDs (profileTournamentRoleStore); null/absent when unknown. */
  tournamentRoles?(): Promise<PermissionConfig['tournamentRoles']>;
  /** The match room pool's categories and rooms; null/absent when unknown (memory pool, schema missing). */
  matchRooms?(): Promise<PermissionConfig['matchRooms']>;
  now?(): number;
  debounceMs?: number;
}

export const LIVE_UNAVAILABLE = 'Discord is not connected or did not answer. Re-check when the bot is online.';

export async function livePermissionReport(deps: LivePermissionDeps): Promise<PermissionReportDto> {
  const client = deps.client();
  if (!client.isReady()) throw new Error('Discord is not ready.');
  const guild = await client.guilds.fetch(deps.guildId);
  const me = await guild.members.fetchMe();
  const view = liveGuildView(guild, me);
  const [moderation, settings] = await Promise.all([deps.moderation().catch(() => null), deps.adminToolsSettings()]);
  const config: PermissionConfig = {
    tournament: deps.tournament(),
    moderation: moderationNeeds(moderation, deps.voiceRuntime),
    adminTools: await adminToolsNeeds(deps.guildId, settings, deps.stores),
    intents: deps.intents(settings),
    lfg: lfgNeeds(await (deps.lfgSettings?.() ?? Promise.resolve(null)).catch(() => null)),
    tournamentRoles: await (deps.tournamentRoles?.() ?? Promise.resolve(null)).catch(() => null),
    matchRooms: await (deps.matchRooms?.() ?? Promise.resolve(null)).catch(() => null)
  };
  return permissionReport(checkPermissions(view, config), { applicationId: deps.applicationId, guildId: deps.guildId,
    checkedAtMs: (deps.now ?? Date.now)(), botRoleName: view.botTopRole?.name ?? null });
}

export function livePermissionMonitor(deps: LivePermissionDeps): PermissionMonitor {
  return new PermissionMonitor({
    ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
    check: () => livePermissionReport(deps),
    onError: () => unavailableReport(LIVE_UNAVAILABLE, { applicationId: deps.applicationId, guildId: deps.guildId })
  });
}
