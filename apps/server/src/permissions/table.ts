// The single source of truth for what each bot feature needs from Discord. The checker (checker.ts), the
// invite link, the setup wizard (onboarding/) and README's permission table all read FEATURE_PERMISSIONS.
// Verified against the Discord API docs (endpoint "Requires ..." notes) and the discord.js 14 typings; the
// entries marked UNCERTAIN in a comment are best understanding, not documented guarantees.
import { PermissionFlagsBits } from 'discord.js';

export type PermissionKey = keyof typeof PermissionFlagsBits;

/** Discord's own UI names. ManageRoles reads "Manage Permissions" in a channel's settings. */
const LABELS: Partial<Record<PermissionKey, string>> = {
  ViewChannel: 'View Channel', SendMessages: 'Send Messages', ReadMessageHistory: 'Read Message History',
  EmbedLinks: 'Embed Links', AttachFiles: 'Attach Files', PinMessages: 'Pin Messages', Connect: 'Connect',
  ManageRoles: 'Manage Roles', ManageChannels: 'Manage Channels', MoveMembers: 'Move Members',
  ManageGuild: 'Manage Server', ModerateMembers: 'Timeout Members', BanMembers: 'Ban Members',
  KickMembers: 'Kick Members', ViewAuditLog: 'View Audit Log', ManageMessages: 'Manage Messages',
  MentionEveryone: 'Mention @everyone, @here, and All Roles', Administrator: 'Administrator'
};

export function permissionLabel(key: PermissionKey, scope: 'guild' | 'channel' = 'guild'): string {
  if (key === 'ManageRoles' && scope === 'channel') return 'Manage Permissions';
  return LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function permissionBits(keys: readonly PermissionKey[]): bigint {
  return keys.reduce((bits, key) => bits | PermissionFlagsBits[key], 0n);
}

/** Bits by human name, for code that used to keep its own name -> flag map (onboarding discovery). */
export function permissionFlagByLabel(label: string): bigint | null {
  for (const key of Object.keys(PermissionFlagsBits) as PermissionKey[]) {
    if (permissionLabel(key, 'channel') === label || permissionLabel(key, 'guild') === label) return PermissionFlagsBits[key];
  }
  return null;
}

export type FeatureGroup = 'Tournament' | 'AutoMod keyword filters' | 'Voice monitoring' | 'Moderation tools' | 'Cases' |
  'Sticky messages' | 'Tickets' | 'Roles' | 'Announcements' | 'Logging' | 'LFG';

/**
 * Where a requirement is checked: server-wide, in each target channel (overwrites apply), or for each
 * target role against the bot's highest role.
 */
export type RequirementScope = 'guild' | 'channel' | 'role-hierarchy';

export interface FeatureRequirement {
  /** Stable key (PermissionIssueDto.featureId). */
  id: string;
  group: FeatureGroup;
  scope: RequirementScope;
  permissions: readonly PermissionKey[];
  severity: 'blocking' | 'warning';
  /** One sentence: what breaks without it. */
  why: string;
  /** Shown in README and the guide: when the requirement applies. */
  when: string;
}

const TEXT_CORE: readonly PermissionKey[] = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks', 'AttachFiles'];

export const FEATURE_PERMISSIONS: readonly FeatureRequirement[] = [
  // ---- Tournament (discord/runtime.ts asserts these at startup)
  { id: 'tournament.signup', group: 'Tournament', scope: 'channel', permissions: TEXT_CORE, severity: 'blocking',
    when: 'Signup/control text channel', why: 'The bot cannot post or update the signup, check-in and match cards.' },
  { id: 'tournament.pin', group: 'Tournament', scope: 'channel', permissions: ['PinMessages'], severity: 'warning',
    when: 'Signup tournaments', why: 'The check-in card cannot be pinned in the signup channel.' },
  { id: 'tournament.matchRoom', group: 'Tournament', scope: 'channel', permissions: [...TEXT_CORE, 'Connect'], severity: 'blocking',
    when: 'Each match voice room', why: 'Match cards cannot be posted in the voice room chat.' },
  // PUT channel permissions requires Manage Roles; Move Members moves players into their room.
  { id: 'tournament.publicRoom', group: 'Tournament', scope: 'channel', permissions: ['ManageRoles', 'ManageChannels', 'MoveMembers'],
    severity: 'blocking', when: 'Public match rooms',
    why: 'Public match rooms cannot set who may talk or move players into their room.' },
  // UNCERTAIN: the room plan grants the bot Manage Permissions on rooms it creates; Discord documents that
  // granting Manage Roles in a channel overwrite at creation may need Administrator.
  { id: 'tournament.roundRooms', group: 'Tournament', scope: 'guild', permissions: ['ManageChannels', 'ManageRoles'], severity: 'warning',
    when: 'Rounds with more than two matches', why: 'Rounds with more than two matches cannot create their extra voice rooms.' },

  // ---- AutoMod (Manage Server is required for every auto-moderation endpoint and execution event)
  { id: 'automod.manage', group: 'AutoMod keyword filters', scope: 'guild', permissions: ['ManageGuild'], severity: 'blocking',
    when: 'Text moderation enabled', why: 'Keyword filters cannot be synced to Discord AutoMod and no flags arrive.' },
  { id: 'automod.timeout', group: 'AutoMod keyword filters', scope: 'guild', permissions: ['ModerateMembers'], severity: 'blocking',
    when: 'A keyword list uses the timeout action', why: 'Discord rejects AutoMod rules with a timeout action.' },

  // ---- Voice monitoring (TCG_DISCORD_VOICE=1): joins self-muted, never speaks, so no Speak.
  { id: 'voice.rooms', group: 'Voice monitoring', scope: 'channel', permissions: ['ViewChannel', 'Connect'], severity: 'blocking',
    when: 'TCG_DISCORD_VOICE=1 and voice monitoring on', why: 'The monitor cannot join this match room to measure loudness or record evidence.' },
  { id: 'voice.notice', group: 'Voice monitoring', scope: 'channel', permissions: ['SendMessages'], severity: 'warning',
    when: 'TCG_DISCORD_VOICE=1 and voice monitoring on', why: 'The "this room is monitored" notice cannot be posted in the voice room chat.' },
  { id: 'voice.organizer', group: 'Voice monitoring', scope: 'channel', permissions: ['ViewChannel', 'SendMessages'], severity: 'warning',
    when: 'Discord notice channel set', why: 'Loudness alerts cannot be posted to the notice channel.' },

  // ---- On-demand moderation tools (always available on the dashboard)
  { id: 'members.ban', group: 'Moderation tools', scope: 'guild', permissions: ['BanMembers'], severity: 'warning',
    when: 'Always (Members, Bans)', why: 'Ban, unban, temporary-ban expiry and the bans list do not work.' },
  { id: 'members.kick', group: 'Moderation tools', scope: 'guild', permissions: ['KickMembers'], severity: 'warning',
    when: 'Always (Members)', why: 'Kick does not work.' },
  { id: 'members.timeout', group: 'Moderation tools', scope: 'guild', permissions: ['ModerateMembers'], severity: 'warning',
    when: 'Always (Members)', why: 'Timeouts do not work.' },
  { id: 'members.audit', group: 'Moderation tools', scope: 'guild', permissions: ['ViewAuditLog'], severity: 'warning',
    when: 'Always (Cases)', why: 'Moderation history cannot include actions taken outside the dashboard.' },
  // Edit Channel Permissions requires Manage Roles (shown as Manage Permissions on the channel).
  { id: 'channels.lock', group: 'Moderation tools', scope: 'guild', permissions: ['ManageRoles'], severity: 'warning',
    when: 'Always (Channels)', why: 'Channel lock cannot change who may send messages.' },
  { id: 'channels.slowmode', group: 'Moderation tools', scope: 'guild', permissions: ['ManageChannels'], severity: 'warning',
    when: 'Always (Channels)', why: 'Slowmode cannot be changed.' },
  { id: 'channels.create', group: 'Moderation tools', scope: 'guild', permissions: ['ManageChannels'], severity: 'warning',
    when: 'Always (Channels > Create, setup wizard)', why: 'New text channels and voice rooms cannot be created from the dashboard.' },
  { id: 'channels.purge', group: 'Moderation tools', scope: 'guild', permissions: ['ManageMessages', 'ReadMessageHistory'], severity: 'warning',
    when: 'Always (Channels)', why: 'Purge cannot read or delete messages.' },

  // ---- Cases: the case log posts plain text (no embed).
  { id: 'cases.log', group: 'Cases', scope: 'channel', permissions: ['ViewChannel', 'SendMessages'], severity: 'blocking',
    when: 'Case log channel set', why: 'New cases are not posted to the case log channel.' },

  // ---- Stickies: the bot deletes only its own previous copy (no Manage Messages needed) and reads the newest message.
  { id: 'stickies.post', group: 'Sticky messages', scope: 'channel', permissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
    severity: 'blocking', when: 'Each enabled sticky', why: 'The sticky cannot be reposted at the bottom of this channel.' },
  { id: 'stickies.embed', group: 'Sticky messages', scope: 'channel', permissions: ['EmbedLinks'], severity: 'warning',
    when: 'Stickies with an embed', why: 'The sticky\'s embed may not be shown.' },

  // ---- Tickets. Creating a channel with overwrites only allows bits the bot itself has in the category;
  // Manage Roles is not needed for that (only for editing overwrites later, which tickets never do).
  { id: 'tickets.panel', group: 'Tickets', scope: 'channel', permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'],
    severity: 'blocking', when: 'Tickets enabled (support channel)', why: 'The ticket panel cannot be posted in the support channel.' },
  { id: 'tickets.category', group: 'Tickets', scope: 'channel',
    permissions: ['ViewChannel', 'ManageChannels', 'SendMessages', 'ReadMessageHistory', 'EmbedLinks', 'AttachFiles'],
    severity: 'blocking', when: 'Tickets enabled (ticket category)', why: 'Ticket channels cannot be created in this category.' },

  // ---- Roles (button roles, bulk role jobs, auto-role)
  { id: 'roles.manage', group: 'Roles', scope: 'guild', permissions: ['ManageRoles'], severity: 'blocking',
    when: 'Button role panels, bulk role jobs or auto-role', why: 'The bot cannot add or remove roles.' },
  { id: 'roles.hierarchy', group: 'Roles', scope: 'role-hierarchy', permissions: [], severity: 'blocking',
    when: 'Each role the bot gives', why: 'The bot can only give roles below its own highest role.' },
  { id: 'roles.panel', group: 'Roles', scope: 'channel', permissions: ['ViewChannel', 'SendMessages'], severity: 'blocking',
    when: 'Each button role panel channel', why: 'The role panel cannot be posted or updated.' },
  { id: 'roles.panelEmbed', group: 'Roles', scope: 'channel', permissions: ['EmbedLinks'], severity: 'warning',
    when: 'Panels with an embed', why: 'The panel\'s embed may not be shown.' },

  // ---- Announcements (scheduled ones)
  { id: 'announcements.post', group: 'Announcements', scope: 'channel', permissions: ['ViewChannel', 'SendMessages'], severity: 'blocking',
    when: 'Each scheduled announcement', why: 'The scheduled announcement cannot be sent.' },
  { id: 'announcements.embed', group: 'Announcements', scope: 'channel', permissions: ['EmbedLinks'], severity: 'warning',
    when: 'Announcements with an embed', why: 'The announcement\'s embed may not be shown.' },
  { id: 'announcements.mention', group: 'Announcements', scope: 'channel', permissions: ['MentionEveryone'], severity: 'warning',
    when: '@everyone switch or a non-mentionable role ping', why: 'The @everyone or role ping is sent but notifies nobody.' },

  // ---- Logging
  { id: 'logging.joinLeave', group: 'Logging', scope: 'channel', permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
    severity: 'blocking', when: 'Join/leave log enabled', why: 'Joins, leaves and member updates are not posted.' },
  { id: 'logging.welcome', group: 'Logging', scope: 'channel', permissions: ['ViewChannel', 'SendMessages'], severity: 'blocking',
    when: 'Welcome message enabled', why: 'Welcome and leave messages are not posted.' },
  { id: 'logging.messageLog', group: 'Logging', scope: 'channel', permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
    severity: 'blocking', when: 'Message log channel set', why: 'Edit and delete entries are not posted to the message log channel.' },
  // Gateway edit/delete events only arrive for channels the bot can see.
  { id: 'logging.messageSources', group: 'Logging', scope: 'channel', permissions: ['ViewChannel'], severity: 'warning',
    when: 'Message log enabled (each logged channel)', why: 'Edits and deletions in this channel are not logged.' },

  // ---- LFG: the panel is a sticky (the bot deletes only its own previous copy); cards are edited, never deleted by others.
  { id: 'lfg.channel', group: 'LFG', scope: 'channel', permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'],
    severity: 'blocking', when: 'LFG enabled (each LFG channel)', why: 'The LFG panel and game cards cannot be posted or updated.' },
  { id: 'lfg.mention', group: 'LFG', scope: 'channel', permissions: ['MentionEveryone'], severity: 'warning',
    when: 'An LFG ping role that is not mentionable', why: 'The LFG ping is sent but notifies nobody.' }
];

export function requirement(id: string): FeatureRequirement {
  const found = FEATURE_PERMISSIONS.find(item => item.id === id);
  if (!found) throw new Error(`Unknown permission requirement ${id}.`);
  return found;
}

/** Every permission any feature may need: the "all features" invite. */
export const ALL_FEATURE_PERMISSIONS: bigint = permissionBits(FEATURE_PERMISSIONS.flatMap(item => item.permissions));

/** A helper voice bot's invite: only what joining a match room needs (the voice.rooms requirement). Helpers never speak or post. */
export function voiceHelperInviteBits(): bigint {
  return permissionBits(requirement('voice.rooms').permissions);
}

/** The setup wizard's per-slot lists (human names), from the same table. */
export const SETUP_CHANNEL_PERMISSIONS = {
  text: requirement('tournament.signup').permissions.map(key => permissionLabel(key, 'channel')),
  voice: requirement('tournament.matchRoom').permissions.map(key => permissionLabel(key, 'channel')),
  public: [...requirement('tournament.matchRoom').permissions, ...requirement('tournament.publicRoom').permissions]
    .map(key => permissionLabel(key, 'channel'))
} as const;

/** Every channel permission the setup discovery reports, as human name -> bit. */
export const SETUP_DISCOVERY_FLAGS: Readonly<Record<string, bigint>> = Object.fromEntries(
  [...new Set([...requirement('tournament.matchRoom').permissions, ...requirement('tournament.publicRoom').permissions])]
    .map(key => [permissionLabel(key, 'channel'), PermissionFlagsBits[key]]));

export interface InviteOptions { applicationId: string; guildId?: string | null; permissions: bigint }

/** OAuth2 bot invite. Never carries a token; re-authorizing an installed bot updates its managed role. */
export function inviteUrl({ applicationId, guildId, permissions }: InviteOptions): string {
  const params = [`client_id=${encodeURIComponent(applicationId)}`, 'scope=bot%20applications.commands',
    `permissions=${permissions.toString()}`];
  if (guildId) params.push(`guild_id=${encodeURIComponent(guildId)}`, 'disable_guild_select=true');
  return `https://discord.com/oauth2/authorize?${params.join('&')}`;
}
