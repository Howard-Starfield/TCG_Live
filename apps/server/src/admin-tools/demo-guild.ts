// Synthetic Discord server for `npm run admin:demo` and tests: members, bans, roles, channels and emojis.
// Mutable on purpose: demo route modules apply bans, timeouts and role changes to it in memory.
import type { GuildChannelDto, GuildEmojiDto, GuildRoleDto } from '@tcg-live/core';

export interface DemoMember {
  id: string; username: string; displayName: string | null; avatarUrl: string | null;
  roleIds: string[]; joinedAtMs: number; accountCreatedAtMs: number; bot: boolean;
  timedOutUntilMs: number | null;
}
export interface DemoBan { userId: string; username: string; reason: string | null }

export interface DemoGuild {
  id: string;
  name: string;
  roles: GuildRoleDto[];
  channels: GuildChannelDto[];
  emojis: GuildEmojiDto[];
  members: DemoMember[];
  bans: DemoBan[];
}

const DAY = 86_400_000;
/** Fixed epoch so demo data and tests are stable (2026-11-01T00:00:00Z). */
export const DEMO_EPOCH_MS = Date.UTC(2026, 10, 1);
const id = (n: number) => `2000000000000${String(n).padStart(5, '0')}`;

const NAMES = ['ash', 'misty', 'brock', 'kaiba', 'yugi', 'joey', 'mai', 'luffy', 'zoro', 'nami', 'sanji', 'robin',
  'usopp', 'chopper', 'franky', 'brook', 'jinbe', 'law', 'kid', 'ace', 'sabo', 'yamato', 'carrot', 'vivi',
  'hancock', 'perona', 'buggy', 'mihawk', 'shanks', 'garp'];

export const DEMO_ROLE_IDS = { admin: id(201), judge: id(202), player: id(203), season3: id(204), lfg: id(205), bot: id(206),
  moderator: id(207) } as const;
export const DEMO_CHANNEL_IDS = {
  info: id(301), general: id(302), signup: id(303), support: id(304), modLog: id(305), welcome: id(306),
  announcements: id(307), tickets: id(308), matchM1: id(309), matchM2: id(310)
} as const;

/** A fresh copy each call, so tests and demo processes never share state. */
export function createDemoGuild(guildId: string): DemoGuild {
  const roles: GuildRoleDto[] = [
    { id: guildId, name: '@everyone', color: 0, position: 0, managed: false, aboveBot: false, elevated: false },
    { id: DEMO_ROLE_IDS.lfg, name: 'LFG', color: 0x22c55e, position: 1, managed: false, aboveBot: false, elevated: false },
    { id: DEMO_ROLE_IDS.season3, name: 'Season 3', color: 0xf59e0b, position: 2, managed: false, aboveBot: false, elevated: false },
    { id: DEMO_ROLE_IDS.player, name: 'Player', color: 0x3b82f6, position: 3, managed: false, aboveBot: false, elevated: false },
    { id: DEMO_ROLE_IDS.judge, name: 'Judge', color: 0xa855f7, position: 4, managed: false, aboveBot: false, elevated: false },
    // Below the bot but staff-level (Ban Members): never offered by panels, bulk jobs or auto-role.
    { id: DEMO_ROLE_IDS.moderator, name: 'Moderator', color: 0x14b8a6, position: 5, managed: false, aboveBot: false, elevated: true },
    { id: DEMO_ROLE_IDS.bot, name: 'TCG Live', color: 0, position: 6, managed: true, aboveBot: true, elevated: true },
    { id: DEMO_ROLE_IDS.admin, name: 'Admin', color: 0xef4444, position: 7, managed: false, aboveBot: true, elevated: true }
  ];
  const category = (n: number, name: string, position: number): GuildChannelDto =>
    ({ id: id(n), name, type: 'category', parentId: null, position, reserved: false });
  const channel = (channelId: string, name: string, parent: string, position: number, extra: Partial<GuildChannelDto> = {}): GuildChannelDto =>
    ({ id: channelId, name, type: 'text', parentId: parent, position, reserved: false, ...extra });
  const info = id(401), play = id(402), staff = id(403), ticketCategory = id(404);
  const channels: GuildChannelDto[] = [
    category(401, 'Info', 0), category(402, 'Play', 1), category(403, 'Staff', 2), category(404, 'Tickets', 3),
    channel(DEMO_CHANNEL_IDS.info, 'rules', info, 0),
    channel(DEMO_CHANNEL_IDS.announcements, 'announcements', info, 1, { type: 'announcement' }),
    channel(DEMO_CHANNEL_IDS.welcome, 'welcome', info, 2),
    channel(DEMO_CHANNEL_IDS.general, 'general', play, 0),
    channel(DEMO_CHANNEL_IDS.signup, 'tournament-signup', play, 1, { reserved: true }),
    channel(DEMO_CHANNEL_IDS.support, 'support', play, 2),
    channel(DEMO_CHANNEL_IDS.matchM1, 'TCG Match M1', play, 3, { type: 'voice', reserved: true }),
    channel(DEMO_CHANNEL_IDS.matchM2, 'TCG Match M2', play, 4, { type: 'voice', reserved: true }),
    channel(DEMO_CHANNEL_IDS.modLog, 'mod-log', staff, 0),
    channel(DEMO_CHANNEL_IDS.tickets, 'ticket-log', ticketCategory, 0)
  ];
  const members: DemoMember[] = NAMES.map((name, index) => ({
    id: id(index + 1), username: name, displayName: index % 3 === 0 ? `${name[0]!.toUpperCase()}${name.slice(1)} TCG` : null,
    avatarUrl: null,
    roleIds: [DEMO_ROLE_IDS.player, ...(index < 2 ? [DEMO_ROLE_IDS.judge] : []), ...(index % 4 === 0 ? [DEMO_ROLE_IDS.lfg] : [])],
    joinedAtMs: DEMO_EPOCH_MS - (NAMES.length - index) * 3 * DAY,
    // The last two joined with brand-new accounts (new-account flag demo).
    accountCreatedAtMs: index >= NAMES.length - 2 ? DEMO_EPOCH_MS - (NAMES.length - index) * 3 * DAY - DAY : DEMO_EPOCH_MS - (400 + index * 10) * DAY,
    bot: false, timedOutUntilMs: index === 5 ? DEMO_EPOCH_MS + 2 * DAY : null
  }));
  members.push({ id: id(99), username: 'tcg-live', displayName: 'TCG Live', avatarUrl: null, roleIds: [DEMO_ROLE_IDS.bot],
    joinedAtMs: DEMO_EPOCH_MS - 120 * DAY, accountCreatedAtMs: DEMO_EPOCH_MS - 130 * DAY, bot: true, timedOutUntilMs: null });
  const bans: DemoBan[] = [
    { userId: id(101), username: 'spam-bot-3000', reason: 'Spam links in #general' },
    { userId: id(102), username: 'noshow-repeat', reason: 'Third tournament no-show this season' },
    { userId: id(103), username: 'old-ban', reason: null }
  ];
  const emojis: GuildEmojiDto[] = [{ id: id(501), name: 'tcg_ticket', animated: false }, { id: id(502), name: 'gg', animated: true }];
  return { id: guildId, name: 'TCG Live Demo Server', roles, channels, emojis, members, bans };
}
