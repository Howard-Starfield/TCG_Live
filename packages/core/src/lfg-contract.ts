// LFG (looking for a game) contract, shared by apps/server and apps/web: settings, posts, limits, defaults,
// audit kinds and the pure template renderer (the dashboard preview and the bot render with the same code).
import type { Snowflake } from './admin-contract.js';

export const LFG_AUDIT_KINDS = ['lfg.settings', 'lfg.posted', 'lfg.joined', 'lfg.left', 'lfg.closed', 'lfg.expired',
  'lfg.deleted', 'lfg.panel'] as const;
export type LfgAuditKind = typeof LFG_AUDIT_KINDS[number];

// ---------------------------------------------------------------- settings

export interface LfgPanelDto {
  title: string;
  /** Embed description of the sticky panel (markdown). */
  text: string;
  color: number | null;
  buttonLabel: string;
  /** Unicode emoji or custom emoji ID; null for none. */
  emoji: string | null;
}
/** The form members fill in (a Discord modal): its title, labels and placeholders. */
export interface LfgFormDto {
  title: string;
  gameLabel: string; gamePlaceholder: string;
  formatLabel: string; formatPlaceholder: string;
  noteLabel: string; notePlaceholder: string;
  voiceLabel: string; voicePlaceholder: string;
}
/** Every member-facing text. Templates take the placeholders in LFG_PLACEHOLDERS ({role} only in pingText). */
export interface LfgMessagesDto {
  cardTitle: string;
  cardBody: string;
  cardColor: number | null;
  joinLabel: string; leaveLabel: string; closeLabel: string;
  /** Card text once the author or staff closed it. */
  closedText: string;
  /** Card text once it expired. */
  expiredText: string;
  /** Private answers to the member who clicked. */
  postedText: string; joinedText: string; leftText: string;
  /** Message text above the card when the LFG role is pinged; must contain {role}. */
  pingText: string;
}
export interface LfgGameDto {
  name: string;
  emoji: string | null;
  /** Ping this role for this game (overrides the channel and global role). */
  pingRoleId: Snowflake | null;
}
export interface LfgChannelDto {
  channelId: Snowflake;
  /** Own panel for this channel; null uses the default panel. */
  panel: LfgPanelDto | null;
  /** Game names allowed here; [] allows every game. */
  games: string[];
  /** Ping role for this channel; null uses the global ping role. */
  pingRoleId: Snowflake | null;
  /** Voice rooms offered here; null uses the global list. */
  voiceChannelIds: Snowflake[] | null;
}
export interface LfgSettingsBodyDto {
  enabled: boolean;
  channels: LfgChannelDto[];
  /** [] lets members type any game. */
  games: LfgGameDto[];
  /** [] lets members type any format (optional field). */
  formats: string[];
  panel: LfgPanelDto;
  form: LfgFormDto;
  messages: LfgMessagesDto;
  /** A card closes itself after this many minutes. */
  expiryMinutes: number;
  /** Minutes between two posts of the same member; 0 for none. */
  cooldownMinutes: number;
  /** Open posts per member at once; 0 = unlimited. There is never a cap on joiners. */
  maxOpenPerUser: number;
  pingRoleId: Snowflake | null;
  /** Minutes between two pings of the same role; 0 for none. */
  pingCooldownMinutes: number;
  /** Voice rooms members may pick (optional); [] hides the voice field. */
  voiceChannelIds: Snowflake[];
  /** Names shown on the card before "+N more" (all joiners are stored). */
  playerListLimit: number;
}
/** GET/PUT /api/v1/admin-tools/lfg/settings (PUT body: { expectedVersion, settings }). */
export interface LfgSettingsDto extends LfgSettingsBodyDto { guildId: Snowflake; version: number; updatedAtMs: number | null }
export interface LfgSettingsConflictDto { error: { code: 'conflict'; message: string }; current: LfgSettingsDto }

// ---------------------------------------------------------------- posts

export const LFG_POST_STATUSES = ['posting', 'open', 'closed', 'expired', 'deleted'] as const;
export type LfgPostStatus = typeof LFG_POST_STATUSES[number];
export interface LfgPostDto {
  id: string; guildId: Snowflake; channelId: Snowflake; messageId: Snowflake | null; authorId: Snowflake;
  game: string; format: string | null; note: string | null; voiceChannelId: Snowflake | null;
  status: LfgPostStatus;
  /** The role pinged when it was posted (null: none, or the ping was on cooldown). */
  pingedRoleId: Snowflake | null;
  createdAtMs: number; expiresAtMs: number; closedAtMs: number | null;
  /** 'expired', 'author', 'staff', 'dashboard', 'message-deleted'... */
  closedBy: string | null;
  /** Joiners in join order (the author is not included). */
  players: Snowflake[];
}
/** GET /api/v1/admin-tools/lfg/posts?status=&game=&limit= */
export interface LfgPostListDto { posts: LfgPostDto[] }
export interface LfgGameStatsDto { game: string; posts: number; joins: number; open: number }
/** GET /api/v1/admin-tools/lfg/stats?days= */
export interface LfgStatsDto { sinceMs: number; posts: number; joins: number; open: number; games: LfgGameStatsDto[] }
export type LfgPanelState = 'posted' | 'waiting' | 'missing-permissions' | 'channel-missing' | 'reserved' | 'failed' | 'disabled' | 'conflict';
export interface LfgPanelStatusDto { channelId: Snowflake; state: LfgPanelState; message: string | null; atMs: number }
/** GET /api/v1/admin-tools/lfg/panels */
export interface LfgPanelListDto { panels: LfgPanelStatusDto[] }

// ---------------------------------------------------------------- limits and defaults

export const LFG_LIMITS = {
  channels: 10, games: 25, formats: 25, voiceChannels: 25,
  gameNameLength: 60, formatLength: 60, noteLength: 300,
  expiryMinutesMin: 30, expiryMinutesMax: 1440,
  cooldownMinutesMax: 1440, maxOpenPerUserMax: 25, pingCooldownMinutesMax: 1440,
  playerListLimitMin: 5, playerListLimitMax: 50,
  /** Characters the {players} list may take (Discord embed limits). */
  playersTextMax: 1000,
  panelTitleLength: 256, panelTextLength: 2000, buttonLabelLength: 80,
  /** Discord modal: title 45, labels 45, placeholders 100. */
  modalTitleLength: 45, modalLabelLength: 45, modalPlaceholderLength: 100,
  cardTitleLength: 256, cardBodyLength: 4096, cardTemplateLength: 2000,
  replyLength: 1000, pingLength: 1000, contentLength: 2000
} as const;

export const DEFAULT_LFG_SETTINGS: Readonly<LfgSettingsBodyDto> = Object.freeze<LfgSettingsBodyDto>({
  enabled: false, channels: [], games: [], formats: [],
  panel: { title: 'Looking for a game?', text: 'Press the button, pick your game and format, and others can join you.',
    color: 0x22c55e, buttonLabel: 'Looking for a game', emoji: '🎮' },
  form: { title: 'Looking for a game', gameLabel: 'Game', gamePlaceholder: 'Which game?', formatLabel: 'Format',
    formatPlaceholder: 'Standard, casual, draft…', noteLabel: 'Note', notePlaceholder: 'Anything others should know (optional)',
    voiceLabel: 'Voice room', voicePlaceholder: 'Optional voice room' },
  messages: {
    cardTitle: '{game}: looking for players',
    cardBody: '**Host:** {author}\n**Format:** {format}\n**Voice:** {voice}\n**Closes:** {expires}\n\n{note}\n\n**Players ({count}):** {players}',
    cardColor: 0x22c55e, joinLabel: 'Join', leaveLabel: 'Leave', closeLabel: 'Close',
    closedText: 'This game is closed. Players ({count}): {players}',
    expiredText: 'This post expired. Players ({count}): {players}',
    postedText: 'Your {game} post is up. It closes {expires}.',
    joinedText: "You joined {author}'s {game} game.",
    leftText: "You left {author}'s {game} game.",
    pingText: '{role} {author} is looking for a {game} game.'
  },
  expiryMinutes: 120, cooldownMinutes: 5, maxOpenPerUser: 1, pingRoleId: null, pingCooldownMinutes: 30,
  voiceChannelIds: [], playerListLimit: 20
});

// ---------------------------------------------------------------- templates

export const LFG_PLACEHOLDERS = ['author', 'game', 'format', 'note', 'voice', 'count', 'players', 'expires'] as const;
export type LfgPlaceholder = typeof LFG_PLACEHOLDERS[number] | 'role';
export type LfgTemplateValues = Partial<Record<LfgPlaceholder, string>>;

/** Placeholders a template uses that it may not ({role} is allowed only in the ping text). */
export function unknownLfgPlaceholders(template: string, allowRole = false): string[] {
  const allowed = new Set<string>([...LFG_PLACEHOLDERS, ...(allowRole ? ['role'] : [])]);
  return [...new Set([...template.matchAll(/\{([a-zA-Z_]+)\}/g)].map(match => match[1]!).filter(name => !allowed.has(name)))];
}

/**
 * Member text made inert: markdown is escaped and @ / # mentions are broken with a zero-width space, so a note
 * cannot ping, link a role, hide text or fake formatting. allowedMentions is still the hard guard.
 */
export function escapeLfgText(value: string): string {
  return value.replace(/[\\*_~`|<>[\]()#]/g, match => `\\${match}`).replace(/@/g, '@\u200b');
}

/** Single pass: values are never scanned for placeholders again, so "{author}" typed in a note stays literal. */
export function renderLfgTemplate(template: string, values: LfgTemplateValues): string {
  return template.replace(/\{([a-zA-Z_]+)\}/g, (whole, name: string) => {
    const value = values[name as LfgPlaceholder];
    return value === undefined ? whole : value;
  }).replace(/\n{3,}/g, '\n\n').trim();
}

/** Code-point safe cut with an ellipsis. */
export function clipLfg(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** "<@a>, <@b> +3 more": at most `limit` names and LFG_LIMITS.playersTextMax characters. */
export function lfgPlayersText(playerIds: readonly string[], limit: number, empty = 'nobody yet'): string {
  if (!playerIds.length) return empty;
  const shown: string[] = [];
  let length = 0;
  for (const id of playerIds) {
    const mention = `<@${id}>`;
    if (shown.length >= limit || length + mention.length + 2 > LFG_LIMITS.playersTextMax - 16) break;
    shown.push(mention);
    length += mention.length + 2;
  }
  const more = playerIds.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` +${more} more` : ''}`;
}

export interface LfgCardFacts {
  authorId: string; game: string; format: string | null; note: string | null; voiceChannelId: string | null;
  expiresAtMs: number; players: readonly string[];
}

/** Values for every placeholder. Member text (game, format, note) is escaped; IDs become mentions. */
export function lfgTemplateValues(facts: LfgCardFacts, playerListLimit: number, roleId: string | null = null): LfgTemplateValues {
  const all = [facts.authorId, ...facts.players.filter(id => id !== facts.authorId)];
  return {
    author: `<@${facts.authorId}>`, game: escapeLfgText(facts.game), format: facts.format ? escapeLfgText(facts.format) : 'any',
    note: facts.note ? escapeLfgText(facts.note) : '', voice: facts.voiceChannelId ? `<#${facts.voiceChannelId}>` : 'none',
    count: String(all.length), players: lfgPlayersText(all, playerListLimit), expires: `<t:${Math.floor(facts.expiresAtMs / 1000)}:R>`,
    ...(roleId ? { role: `<@&${roleId}>` } : {})
  };
}

/**
 * Longest possible value of each placeholder for these settings (escaping can double member text), used to
 * check that a template can never exceed a Discord limit.
 */
export function lfgWorstCaseValues(settings: Pick<LfgSettingsBodyDto, 'games' | 'formats'>): LfgTemplateValues {
  const longest = (items: readonly string[], fallback: number) =>
    items.length ? Math.max(...items.map(item => [...escapeLfgText(item)].length)) : fallback * 2;
  const pad = (n: number) => 'x'.repeat(n);
  return {
    author: pad(23), game: pad(longest(settings.games.map(game => game.name), LFG_LIMITS.gameNameLength)),
    format: pad(Math.max(3, longest(settings.formats, LFG_LIMITS.formatLength))), note: pad(LFG_LIMITS.noteLength * 2),
    voice: pad(23), count: pad(7), players: pad(LFG_LIMITS.playersTextMax), expires: pad(16), role: pad(24)
  };
}

/** Rendered length with the longest possible values. */
export function lfgWorstCaseLength(template: string, settings: Pick<LfgSettingsBodyDto, 'games' | 'formats'>): number {
  return [...renderLfgTemplate(template, lfgWorstCaseValues(settings))].length;
}

/** Sample facts for previews. */
export const LFG_PREVIEW_FACTS: LfgCardFacts = {
  authorId: '100000000000000010', game: 'Pokémon TCG', format: 'Standard', note: 'Chill games, new players welcome.',
  voiceChannelId: null, expiresAtMs: Date.UTC(2026, 10, 15, 20), players: ['100000000000000011', '100000000000000012']
};
