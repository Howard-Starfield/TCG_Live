// `npm run admin:demo`: a synthetic bot whose permissions have a couple of realistic gaps, so the
// permission card, the banner and the invite link have something to show. The bot lacks Manage Roles
// server-wide, and #general denies it Send Messages while a sticky lives there.
import { PermissionFlagsBits } from 'discord.js';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type PermissionReportDto } from '@tcg-live/core';
import { DEMO_CHANNEL_IDS, DEMO_ROLE_IDS, type DemoGuild } from '../admin-tools/demo-guild.js';
import { adminToolsBody, type AdminToolsSettingsStore } from '../admin-tools/settings.js';
import { channelPermissions, checkPermissions, permissionReport, unavailableReport, type GuildPermissionView,
  type PermissionConfig } from './checker.js';
import { PermissionMonitor } from './monitor.js';
import { ALL_FEATURE_PERMISSIONS } from './table.js';

/** A made-up application ID: the demo invite link never points at a real bot. */
export const DEMO_APPLICATION_ID = '100000000000000999';

export function demoPermissionView(demo: DemoGuild): GuildPermissionView {
  const base = ALL_FEATURE_PERMISSIONS & ~PermissionFlagsBits.ManageRoles;
  const botRole = demo.roles.find(role => role.id === DEMO_ROLE_IDS.bot);
  // Public match rooms give the bot Manage Permissions in the room itself (see discord/match-rooms.ts).
  const roomOverwrite = { allow: PermissionFlagsBits.ManageRoles | PermissionFlagsBits.MoveMembers, deny: 0n };
  return {
    guildId: demo.id,
    guildPermissions: base,
    botTopRole: botRole ? { id: botRole.id, name: botRole.name, position: botRole.position } : null,
    channels: demo.channels.map(channel => ({ id: channel.id, name: channel.name,
      type: channel.type === 'category' ? 'category' : channel.type === 'voice' || channel.type === 'stage' ? 'voice' : 'text',
      permissions: channel.id === DEMO_CHANNEL_IDS.general
        ? channelPermissions({ base, roles: [{ allow: 0n, deny: PermissionFlagsBits.SendMessages }] })
        : channel.id === DEMO_CHANNEL_IDS.matchM1 || channel.id === DEMO_CHANNEL_IDS.matchM2
          ? channelPermissions({ base, member: roomOverwrite }) : base })),
    roles: demo.roles.map(role => ({ id: role.id, name: role.name, position: role.position, managed: role.managed,
      mentionable: role.id !== DEMO_ROLE_IDS.season3 }))
  };
}

/** The demo's configured features: its saved settings plus a sticky in #general and a role panel in #rules. */
export function demoPermissionConfig(settings: AdminToolsSettingsBodyDto): PermissionConfig {
  return {
    tournament: { signupChannelId: DEMO_CHANNEL_IDS.signup, matchChannelIds: [DEMO_CHANNEL_IDS.matchM1, DEMO_CHANNEL_IDS.matchM2],
      publicMatchRooms: true, signupMode: true },
    moderation: { textEnabled: true, timeoutRules: false, voiceEnabled: false, voiceNoticeChannelId: null },
    adminTools: {
      settings,
      stickies: [{ channelId: DEMO_CHANNEL_IDS.general, embed: false }],
      panels: [{ channelId: DEMO_CHANNEL_IDS.info, embed: true, roleIds: [DEMO_ROLE_IDS.lfg, DEMO_ROLE_IDS.season3] }],
      bulkRoleIds: [],
      announcements: []
    },
    intents: null
  };
}

export function demoPermissionMonitor(demo: DemoGuild, settings: AdminToolsSettingsStore, now: () => number = Date.now): PermissionMonitor {
  const ids = { applicationId: DEMO_APPLICATION_ID, guildId: demo.id };
  return new PermissionMonitor({
    debounceMs: 250,
    async check(): Promise<PermissionReportDto> {
      const saved = await settings.get(demo.id).then(adminToolsBody,
        () => structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto);
      const view = demoPermissionView(demo);
      return permissionReport(checkPermissions(view, demoPermissionConfig(saved)),
        { ...ids, checkedAtMs: now(), botRoleName: view.botTopRole?.name ?? null });
    },
    onError: () => unavailableReport('The demo permission check failed.', ids)
  });
}
