import { RuleError, type MatchId, type Player } from '../rehearsal/domain.js';

interface BaseDiscordConfig {
  applicationId: string;
  guildId: string;
  channelId: string;
  matchChannels?: Record<MatchId, string>;
  publicMatchRooms?: boolean;
  adminId: string;
  token?: string;
}
export type PrivateDiscordConfig = (BaseDiscordConfig & { mode?: 'legacy'; players: Record<Player, string> }) |
  (BaseDiscordConfig & { mode: 'signup'; players?: never });

const SNOWFLAKE = /^[1-9]\d{14,21}$/;

export function readPrivateDiscordConfig(env?: NodeJS.ProcessEnv, requireToken?: boolean): BaseDiscordConfig & { mode: 'legacy'; players: Record<Player, string> };
export function readPrivateDiscordConfig(env: NodeJS.ProcessEnv, requireToken: boolean, mode: 'signup'): BaseDiscordConfig & { mode: 'signup'; players?: never };
export function readPrivateDiscordConfig(env: NodeJS.ProcessEnv, requireToken: boolean, mode: 'legacy'): BaseDiscordConfig & { mode: 'legacy'; players: Record<Player, string> };
export function readPrivateDiscordConfig(env: NodeJS.ProcessEnv = process.env, requireToken = false,
  mode: 'legacy' | 'signup' = 'legacy'): PrivateDiscordConfig {
  const getId = (key: string): string => {
    const value = env[key] ?? '';
    if (!SNOWFLAKE.test(value)) throw new RuleError(`Invalid private Discord setting: ${key}.`);
    return value;
  };
  const playerKeys = ['TCG_DISCORD_PLAYER_A_ID', 'TCG_DISCORD_PLAYER_B_ID',
    'TCG_DISCORD_PLAYER_C_ID', 'TCG_DISCORD_PLAYER_D_ID'] as const;
  if (mode === 'signup' && playerKeys.some(key => !!env[key]?.trim()))
    throw new RuleError('Signup mode refuses preset player IDs.');
  const players = mode === 'legacy' ? {
    A: getId(playerKeys[0]), B: getId(playerKeys[1]),
    C: getId(playerKeys[2]), D: getId(playerKeys[3])
  } : undefined;
  const adminId = getId('TCG_DISCORD_ADMIN_ID');
  if (players && new Set([...Object.values(players), adminId]).size !== 5) {
    throw new RuleError('Private Discord player and admin IDs must be distinct.');
  }
  const token = env.TCG_DISCORD_TOKEN?.trim() ? env.TCG_DISCORD_TOKEN : env.DISCORD_BOT_TOKEN;
  const m1 = env.TCG_DISCORD_M1_CHANNEL_ID;
  const m2 = env.TCG_DISCORD_M2_CHANNEL_ID;
  const publicFlag = env.TCG_DISCORD_PUBLIC_MATCH_ROOMS?.trim() ?? '';
  if (!['', '0', '1'].includes(publicFlag)) throw new RuleError('Invalid private Discord setting: TCG_DISCORD_PUBLIC_MATCH_ROOMS.');
  const publicMatchRooms = publicFlag === '1';
  if (publicMatchRooms && (!m1 || !m2)) throw new RuleError('Public match rooms require both match channel IDs.');
  if (!!m1 !== !!m2) throw new RuleError('Both private Discord match channels must be configured together.');
  const matchChannels = m1 && m2 ? {
    M1: getId('TCG_DISCORD_M1_CHANNEL_ID'), M2: getId('TCG_DISCORD_M2_CHANNEL_ID')
  } : undefined;
  if (matchChannels && matchChannels.M1 === matchChannels.M2)
    throw new RuleError('Private Discord match channels must be distinct.');
  if (requireToken && (!token || !token.trim()))
    throw new RuleError('TCG_DISCORD_TOKEN or DISCORD_BOT_TOKEN is required.');
  const base = {
    applicationId: getId('TCG_DISCORD_APPLICATION_ID'),
    guildId: getId('TCG_DISCORD_GUILD_ID'),
    channelId: getId('TCG_DISCORD_CHANNEL_ID'),
    ...(matchChannels ? { matchChannels } : {}),
    ...(publicMatchRooms ? { publicMatchRooms: true } : {}),
    adminId, ...(token?.trim() ? { token } : {})
  };
  return mode === 'signup' ? { ...base, mode: 'signup' } : { ...base, mode: 'legacy', players: players! };
}

export function publicConfig(config: PrivateDiscordConfig): Omit<PrivateDiscordConfig, 'token'> {
  const { token: _token, ...safe } = config;
  return safe;
}

export function sameIdentityMap(
  saved: { kind?: 'legacy' | 'signup'; players?: Record<Player, string>; adminId: string;
    matchChannels?: Record<MatchId, string>; publicMatchRooms?: boolean }, config: PrivateDiscordConfig
): boolean {
  const savedKind = saved.kind ?? 'legacy';
  return savedKind === (config.mode ?? 'legacy') && saved.adminId === config.adminId &&
    !!saved.publicMatchRooms === !!config.publicMatchRooms &&
    (savedKind === 'signup' || (['A', 'B', 'C', 'D'] as const).every(player => saved.players?.[player] === config.players?.[player])) &&
    (['M1', 'M2'] as const).every(slot =>
      (saved.matchChannels?.[slot] ?? config.channelId) === channelForSlot(config, slot));
}

export function channelForSlot(config: PrivateDiscordConfig, slot: 'checkin' | MatchId): string {
  return slot === 'checkin' ? config.channelId : config.matchChannels?.[slot] ?? config.channelId;
}
