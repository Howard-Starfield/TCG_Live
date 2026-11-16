// Pure permission checker: given what Discord says the bot has (GuildPermissionView) and what is enabled
// or configured (PermissionConfig), lists the issues of the enabled features only. No discord.js objects
// here, so tests and the demo build views by hand; live.ts builds one from a real guild.
import { PermissionFlagsBits } from 'discord.js';
import { PRIVILEGED_INTENT_NAMES, PRIVILEGED_INTENT_PORTAL_LABELS, type AdminToolsSettingsBodyDto, type PermissionIssueDto,
  type PermissionReportDto, type PermissionScopeDto, type PrivilegedIntentName, type PrivilegedIntentState } from '@tcg-live/core';
import { ALL_FEATURE_PERMISSIONS, FEATURE_PERMISSIONS, inviteUrl, permissionBits, permissionLabel, requirement,
  type FeatureRequirement, type PermissionKey } from './table.js';

export interface ChannelView {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'category' | 'other';
  /** The bot's effective permissions in the channel (role permissions, then overwrites; Administrator/owner = all). */
  permissions: bigint;
}
export interface RoleView { id: string; name: string; position: number; managed: boolean; mentionable: boolean }

export interface GuildPermissionView {
  guildId: string;
  /** The bot's server-wide permissions (the union of its roles). */
  guildPermissions: bigint;
  botTopRole: { id: string; name: string; position: number } | null;
  channels: readonly ChannelView[];
  roles: readonly RoleView[];
}

export interface StickyNeed { channelId: string; embed: boolean }
export interface PanelNeed { channelId: string; embed: boolean; roleIds: string[] }
export interface AnnouncementNeed { channelId: string; embed: boolean; mentionEveryone: boolean; mentionRoleIds: string[] }
/** An LFG channel and every role a card posted there may ping (game, channel and global ping roles). */
export interface LfgChannelNeed { channelId: string; pingRoleIds: string[] }

/** What is enabled or configured right now; null sections are off/unknown. */
export interface PermissionConfig {
  tournament: { signupChannelId: string; matchChannelIds: string[]; publicMatchRooms: boolean; signupMode: boolean } | null;
  moderation: { textEnabled: boolean; timeoutRules: boolean; voiceEnabled: boolean; voiceNoticeChannelId: string | null } | null;
  adminTools: {
    settings: AdminToolsSettingsBodyDto;
    stickies: StickyNeed[];
    panels: PanelNeed[];
    /** Roles of queued/running bulk role jobs. */
    bulkRoleIds: string[];
    /** Scheduled announcements only. */
    announcements: AnnouncementNeed[];
  } | null;
  intents: { wanted: Record<PrivilegedIntentName, boolean>; state: Record<PrivilegedIntentName, PrivilegedIntentState> } | null;
  /** LFG channels while LFG is enabled; null/absent when off or unknown. */
  lfg?: { channels: LfgChannelNeed[] } | null;
  /** The saved TCG Organizer and TCG Judge role IDs (null for one that is not created yet); null/absent when unknown. */
  tournamentRoles?: { organizerRoleId: string | null; judgeRoleId: string | null } | null;
  /** The match room pool: its categories and rooms (bot-created or adopted); null/absent when unknown or not in use. */
  matchRooms?: { categoryIds: string[]; roomChannelIds: string[] } | null;
}

/** Administrator bypasses every permission check (not the role hierarchy). */
export function hasPermission(bits: bigint, key: PermissionKey): boolean {
  if ((bits & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) return true;
  const flag = PermissionFlagsBits[key];
  return (bits & flag) === flag;
}

export interface Overwrite { allow: bigint; deny: bigint }
/**
 * Discord's documented algorithm for a member's channel permissions: base (roles), then @everyone
 * overwrite, then role overwrites combined, then the member overwrite. Administrator short-circuits.
 * The live checker uses discord.js permissionsFor(); this is for the demo and tests.
 */
export function channelPermissions(input: { base: bigint; everyone?: Overwrite; roles?: readonly Overwrite[]; member?: Overwrite }): bigint {
  const all = Object.values(PermissionFlagsBits).reduce((bits, flag) => bits | flag, 0n);
  if ((input.base & PermissionFlagsBits.Administrator) !== 0n) return all;
  let bits = input.base;
  if (input.everyone) bits = (bits & ~input.everyone.deny) | input.everyone.allow;
  const roleDeny = (input.roles ?? []).reduce((acc, item) => acc | item.deny, 0n);
  const roleAllow = (input.roles ?? []).reduce((acc, item) => acc | item.allow, 0n);
  bits = (bits & ~roleDeny) | roleAllow;
  if (input.member) bits = (bits & ~input.member.deny) | input.member.allow;
  return bits;
}

interface ChannelTarget { kind: 'channel'; id: string }
interface RoleTarget { kind: 'role'; id: string }
type Target = ChannelTarget | RoleTarget | { kind: 'guild' };

const channel = (id: string | null | undefined): ChannelTarget[] => id ? [{ kind: 'channel', id }] : [];

/** Which targets each requirement has under the current config; [] means the feature is off. */
function targetsFor(req: FeatureRequirement, config: PermissionConfig, view: GuildPermissionView): Target[] {
  const t = config.tournament;
  const m = config.moderation;
  const a = config.adminTools;
  const guild: Target[] = [{ kind: 'guild' }];
  const unique = <T extends Target>(list: T[]): T[] => {
    const seen = new Set<string>();
    return list.filter(item => { const key = 'id' in item ? item.id : 'guild'; if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const roleIds = a ? [...a.panels.flatMap(panel => panel.roleIds), ...a.bulkRoleIds,
    ...(a.settings.logging.autoRole.enabled ? a.settings.logging.autoRole.roleIds : [])] : [];
  switch (req.id) {
    case 'tournament.signup': return t ? channel(t.signupChannelId) : [];
    case 'tournament.pin': return t?.signupMode ? channel(t.signupChannelId) : [];
    case 'tournament.matchRoom': return t ? unique(t.matchChannelIds.flatMap(id => channel(id))) : [];
    case 'tournament.publicRoom': return t?.publicMatchRooms ? unique(t.matchChannelIds.flatMap(id => channel(id))) : [];
    case 'tournament.roundRooms': return t?.publicMatchRooms ? guild : [];
    case 'tournament.roomCategory': return t?.publicMatchRooms && config.matchRooms ? unique(config.matchRooms.categoryIds.flatMap(id => channel(id))) : [];
    case 'tournament.roomChat': return t?.publicMatchRooms && config.matchRooms ? unique(config.matchRooms.roomChannelIds.flatMap(id => channel(id))) : [];
    case 'automod.manage': return m?.textEnabled ? guild : [];
    case 'automod.timeout': return m?.textEnabled && m.timeoutRules ? guild : [];
    case 'voice.rooms': case 'voice.notice': return m?.voiceEnabled && t ? unique(t.matchChannelIds.flatMap(id => channel(id))) : [];
    case 'voice.organizer': return m?.voiceEnabled ? channel(m.voiceNoticeChannelId) : [];
    case 'members.ban': case 'members.kick': case 'members.timeout': case 'members.audit':
    case 'channels.lock': case 'channels.slowmode': case 'channels.purge': return a ? guild : [];
    case 'cases.log': return a ? channel(a.settings.cases.logChannelId) : [];
    case 'stickies.post': return a ? unique(a.stickies.flatMap(item => channel(item.channelId))) : [];
    case 'stickies.embed': return a ? unique(a.stickies.filter(item => item.embed).flatMap(item => channel(item.channelId))) : [];
    case 'tickets.panel': return a?.settings.tickets.enabled ? channel(a.settings.tickets.supportChannelId) : [];
    case 'tickets.category': return a?.settings.tickets.enabled ? channel(a.settings.tickets.categoryId) : [];
    case 'roles.manage': return roleIds.length ? guild : [];
    case 'roles.hierarchy': return unique(roleIds.filter(id => id !== view.guildId).map(id => ({ kind: 'role' as const, id })));
    case 'roles.panel': return a ? unique(a.panels.flatMap(item => channel(item.channelId))) : [];
    case 'roles.panelEmbed': return a ? unique(a.panels.filter(item => item.embed).flatMap(item => channel(item.channelId))) : [];
    case 'announcements.post': return a ? unique(a.announcements.flatMap(item => channel(item.channelId))) : [];
    case 'announcements.embed': return a ? unique(a.announcements.filter(item => item.embed).flatMap(item => channel(item.channelId))) : [];
    case 'announcements.mention': {
      if (!a) return [];
      const unmentionable = (id: string) => { const role = view.roles.find(item => item.id === id); return !!role && !role.mentionable; };
      return unique(a.announcements.filter(item => item.mentionEveryone || item.mentionRoleIds.some(unmentionable))
        .flatMap(item => channel(item.channelId)));
    }
    case 'logging.joinLeave': return a?.settings.logging.joinLeave.enabled ? channel(a.settings.logging.joinLeave.channelId) : [];
    case 'logging.welcome': return a?.settings.logging.welcome.enabled ? channel(a.settings.logging.welcome.channelId) : [];
    case 'logging.messageLog': return a?.settings.logging.messageLog.enabled ? channel(a.settings.logging.messageLog.channelId) : [];
    case 'logging.messageSources': {
      if (!a?.settings.logging.messageLog.enabled) return [];
      const ignored = new Set(a.settings.logging.messageLog.ignoredChannelIds);
      return view.channels.filter(item => item.type === 'text' && !ignored.has(item.id)).map(item => ({ kind: 'channel', id: item.id }));
    }
    case 'tournamentRoles.manage': return config.tournamentRoles ? guild : [];
    case 'tournamentRoles.hierarchy': return unique([config.tournamentRoles?.organizerRoleId, config.tournamentRoles?.judgeRoleId]
      .filter((id): id is string => !!id).map(id => ({ kind: 'role' as const, id })));
    case 'tournamentRoles.created': return config.tournamentRoles && !(config.tournamentRoles.organizerRoleId && config.tournamentRoles.judgeRoleId) ? guild : [];
    case 'lfg.channel': return config.lfg ? unique(config.lfg.channels.flatMap(item => channel(item.channelId))) : [];
    case 'lfg.mention': {
      if (!config.lfg) return [];
      // @everyone, or a role that is not mentionable: the ping notifies nobody without Mention Everyone.
      const silent = (id: string) => { if (id === view.guildId) return true; const role = view.roles.find(item => item.id === id); return !!role && !role.mentionable; };
      return unique(config.lfg.channels.filter(item => item.pingRoleIds.some(silent)).flatMap(item => channel(item.channelId)));
    }
    default: return [];
  }
}

/** Logged channels the bot cannot see are listed individually up to this many. */
export const MESSAGE_SOURCE_ISSUE_LIMIT = 10;

const scopeName = (scope: PermissionScopeDto) => scope.kind === 'guild' ? 'the server' : scope.kind === 'channel' ? `#${scope.name}` : `@${scope.name}`;

export interface PermissionCheckResult {
  issues: PermissionIssueDto[];
  /** Permissions every enabled feature needs (for the invite link). */
  enabledBits: bigint;
}

export function checkPermissions(view: GuildPermissionView, config: PermissionConfig): PermissionCheckResult {
  const issues: PermissionIssueDto[] = [];
  let enabledBits = 0n;
  const botRole = view.botTopRole?.name ?? 'the bot\'s role';
  for (const req of FEATURE_PERMISSIONS) {
    const targets = targetsFor(req, config, view);
    if (!targets.length) continue;
    enabledBits |= permissionBits(req.permissions);
    const base = { severity: req.severity, featureId: req.id, feature: req.group } as const;
    let sourceIssues = 0;
    for (const target of targets) {
      if (target.kind === 'guild') {
        if (req.id === 'tournamentRoles.created') {
          const roles = config.tournamentRoles!;
          const names = [roles.organizerRoleId ? null : 'TCG Organizer', roles.judgeRoleId ? null : 'TCG Judge'].filter(Boolean).join(' and ');
          issues.push({ ...base, kind: 'missing', permission: names, scope: { kind: 'guild' }, why: req.why,
            fix: 'In the dashboard, open Admin tools > Settings > Tournament roles and use Create TCG roles.' });
          continue;
        }
        const missing = req.permissions.filter(key => !hasPermission(view.guildPermissions, key));
        if (missing.length) issues.push({ ...base, kind: 'permission', permission: missing.map(key => permissionLabel(key)).join(', '),
          scope: { kind: 'guild' }, why: req.why, fix: 'Use "Grant missing permissions" and authorize the bot again.' });
        continue;
      }
      if (target.kind === 'role') {
        const role = view.roles.find(item => item.id === target.id);
        if (!role) {
          const own = req.group === 'Tournament roles';
          issues.push({ ...base, kind: 'missing', permission: 'Role', scope: { kind: 'role', id: target.id, name: target.id },
            why: own ? 'A TCG role was deleted in Discord.' : 'A configured role was deleted.',
            fix: own ? 'In the dashboard, open Admin tools > Settings > Tournament roles and use Create TCG roles.' : 'Choose another role where it is configured.' });
        } else if (role.managed) {
          issues.push({ ...base, kind: 'hierarchy', permission: 'Role order', scope: { kind: 'role', id: role.id, name: role.name },
            why: `@${role.name} is managed by an integration, so no bot can give it.`,
            fix: req.group === 'Tournament roles' ? 'In the dashboard, open Admin tools > Settings > Tournament roles and use Create TCG roles to make a new one.'
              : 'Choose another role where it is configured.' });
        } else if (!view.botTopRole || role.position >= view.botTopRole.position) {
          issues.push({ ...base, kind: 'hierarchy', permission: 'Role order', scope: { kind: 'role', id: role.id, name: role.name },
            why: `${req.why} @${role.name} is not below ${botRole}.`,
            fix: `In Server Settings → Roles, drag ${botRole} above @${role.name}.` });
        }
        continue;
      }
      const found = view.channels.find(item => item.id === target.id);
      if (!found) {
        issues.push({ ...base, kind: 'missing', permission: permissionLabel('ViewChannel', 'channel'),
          scope: { kind: 'channel', id: target.id, name: target.id },
          why: 'A configured channel was deleted or the bot cannot see it.', fix: 'Choose another channel where it is configured.' });
        continue;
      }
      const scope: PermissionScopeDto = { kind: 'channel', id: found.id, name: found.name };
      // Without View Channel Discord denies everything else in the channel: report that alone.
      const missing = hasPermission(found.permissions, 'ViewChannel') || !req.permissions.includes('ViewChannel')
        ? req.permissions.filter(key => !hasPermission(found.permissions, key)) : ['ViewChannel' as const];
      if (!missing.length) continue;
      if (req.id === 'logging.messageSources' && ++sourceIssues > MESSAGE_SOURCE_ISSUE_LIMIT) continue;
      const serverWide = missing.every(key => hasPermission(view.guildPermissions, key));
      const names = missing.map(key => permissionLabel(key, 'channel')).join(', ');
      issues.push({ ...base, kind: serverWide ? 'overwrite' : 'permission', permission: names, scope, why: req.why,
        fix: serverWide ? `Edit ${scopeName(scope)} → Permissions and allow ${names} for ${botRole} (or remove the deny).`
          : `Use "Grant missing permissions"; if ${scopeName(scope)} still denies it, allow it for ${botRole} in the channel's Permissions.` });
    }
    if (req.id === 'logging.messageSources' && sourceIssues > MESSAGE_SOURCE_ISSUE_LIMIT) {
      issues.push({ ...base, kind: 'overwrite', permission: permissionLabel('ViewChannel', 'channel'), scope: { kind: 'guild' },
        why: `${sourceIssues - MESSAGE_SOURCE_ISSUE_LIMIT} more logged channels are hidden from the bot.`,
        fix: 'Allow View Channel for the bot there, or add them to the message log\'s ignored channels.' });
    }
  }
  if (config.intents) {
    for (const name of PRIVILEGED_INTENT_NAMES) {
      if (!config.intents.wanted[name]) continue;
      const label = PRIVILEGED_INTENT_PORTAL_LABELS[name];
      const feature = name === 'guildMembers' ? 'Join/leave log, welcome and auto-role' : 'Message log, full ticket transcripts and room chat text';
      if (config.intents.state[name] === 'missing') {
        issues.push({ severity: 'blocking', kind: 'intent', featureId: `intent.${name}`, feature: 'Logging', permission: label,
          scope: { kind: 'guild' }, why: `Discord refused the ${label}; ${feature} stay idle.`,
          fix: 'Developer Portal → your application → Bot → Privileged Gateway Intents: switch it on, then restart the bot.' });
      } else if (config.intents.state[name] === 'off') {
        issues.push({ severity: 'warning', kind: 'intent', featureId: `intent.${name}`, feature: 'Logging', permission: label,
          scope: { kind: 'guild' }, why: `The running bot did not request the ${label}; ${feature} stay idle until a restart.`,
          fix: 'Make sure it is on in the Developer Portal (Bot → Privileged Gateway Intents), then restart the bot.' });
      }
    }
  }
  const order = (issue: PermissionIssueDto) => (issue.severity === 'blocking' ? 0 : 1000) +
    Math.max(0, FEATURE_PERMISSIONS.findIndex(item => item.id === issue.featureId));
  issues.sort((left, right) => order(left) - order(right));
  return { issues, enabledBits };
}

export interface ReportInput {
  applicationId: string | null;
  guildId: string | null;
  checkedAtMs: number;
  botRoleName: string | null;
}

export function permissionReport(result: PermissionCheckResult, input: ReportInput): PermissionReportDto {
  const invite = (permissions: bigint) => input.applicationId
    ? inviteUrl({ applicationId: input.applicationId, guildId: input.guildId, permissions }) : null;
  return { checkedAtMs: input.checkedAtMs, ok: result.issues.length === 0, issues: result.issues,
    inviteUrl: invite(result.enabledBits), inviteUrlAll: invite(ALL_FEATURE_PERMISSIONS),
    permissionsInteger: result.enabledBits.toString(), permissionsIntegerAll: ALL_FEATURE_PERMISSIONS.toString(),
    botRoleName: input.botRoleName, unavailable: null };
}

export function unavailableReport(message: string, input: Omit<ReportInput, 'checkedAtMs' | 'botRoleName'>): PermissionReportDto {
  const base = permissionReport({ issues: [], enabledBits: 0n }, { ...input, checkedAtMs: 0, botRoleName: null });
  return { ...base, checkedAtMs: null, ok: false, inviteUrl: base.inviteUrlAll, permissionsInteger: base.permissionsIntegerAll,
    unavailable: message };
}

export { requirement };
