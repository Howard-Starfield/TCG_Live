// Voice bot pool status for the dashboard. The main bot covers one voice room; each helper bot covers
// one more room concurrently. Rooms without a free bot are reported with botId null (not monitored).
import type { MatchId, VoiceBotErrorCode, VoiceBotPoolDto, VoiceBotRuntimeStatus, VoiceBotStatusDto, VoiceRoomCoverageDto,
  VoiceRoomPriority, VoiceRoomStatus } from '@tcg-live/core';
import { voiceHelperInviteBits } from '../permissions/table.js';
import type { VoiceBotSummary } from './tokens.js';

export const MAIN_VOICE_BOT_ID = 'main';

/** Live state of one bot published by the voice runtime; never carries a token. */
export interface VoiceBotLiveState {
  connected: boolean;
  assignedChannelId: string | null;
  assignedMatchId: VoiceBotStatusDto['assignedMatchId'];
  status?: VoiceBotRuntimeStatus;
  lastReadyAtMs?: number | null;
  lastErrorCode?: VoiceBotErrorCode | null;
  consecutiveFailures?: number;
}
/** Live state published by the voice runtime. Absent means the runtime is disabled. */
export interface VoicePoolLiveState {
  bots: Partial<Record<string, VoiceBotLiveState>>;
  rooms: VoiceRoomCoverageDto[];
}
export interface VoicePoolStatusSource { live(): VoicePoolLiveState | null }

/** OAuth2 invite for a helper: only the permissions the voice-room requirement lists, for this server. */
export function helperInviteUrl(applicationId: string, guildId: string | null): string {
  const params = [`client_id=${encodeURIComponent(applicationId)}`, 'scope=bot', `permissions=${voiceHelperInviteBits().toString()}`];
  if (guildId) params.push(`guild_id=${encodeURIComponent(guildId)}`, 'disable_guild_select=true');
  return `https://discord.com/oauth2/authorize?${params.join('&')}`;
}

export function describeVoicePool(helpers: VoiceBotSummary[], live: VoicePoolLiveState | null,
  main: { userId: string | null; label?: string } = { userId: null }, guildId: string | null = null): VoiceBotPoolDto {
  const state = (id: string): VoiceBotLiveState => live?.bots[id] ?? { connected: false, assignedChannelId: null, assignedMatchId: null };
  const bots: VoiceBotStatusDto[] = [
    { id: MAIN_VOICE_BOT_ID, label: main.label ?? 'Main bot', kind: 'main', userId: main.userId, addedAtMs: null, ...state(MAIN_VOICE_BOT_ID) },
    ...helpers.map(helper => ({ id: helper.id, label: helper.label, kind: 'helper' as const, userId: helper.userId,
      addedAtMs: helper.addedAtMs, ...state(helper.id), enabled: helper.enabled, applicationId: helper.applicationId,
      nickname: helper.nickname, inviteUrl: helper.applicationId ? helperInviteUrl(helper.applicationId, guildId) : null }))
  ];
  return { runtime: live ? 'running' : 'disabled', bots, rooms: live ? live.rooms.map(room => ({ ...room })) : [] };
}

// ---- Assignment policy (pure) ----

export interface CoverageRoom {
  matchId: MatchId;
  channelId: string;
  /** An open judge call or dispute: covered before every other room. */
  judgeCall: boolean;
  record: boolean;
  monitor: boolean;
  /** 'high' rooms come after judge calls and before 'normal' ones. Absent is 'normal'. */
  priority?: VoiceRoomPriority;
  /** Preferred bot; ignored when that bot is not available. */
  pinnedBotId?: string | null;
}
export interface AssignmentResult {
  /** matchId -> botId, or null when no free bot is left (not monitored). */
  rooms: Map<MatchId, string | null>;
  /** botId -> matchId for every assigned bot. */
  bots: Map<string, MatchId>;
}

const rank = (room: CoverageRoom) => room.judgeCall ? 0 : room.priority === 'high' ? 1 : 2;

/**
 * Assigns `available` bots (in preference order: main first) to `rooms`. Order: judge-call rooms, then
 * 'high', then 'normal' (then match number). A pinned bot goes to its room whenever that room needs
 * coverage; otherwise current assignments are kept so a bot never hops needlessly. A room left without a
 * bot takes one from the lowest-ranked room below it; a pinned bot is taken only by a judge-call room.
 * Callers drop 'never' rooms and disabled helpers before planning.
 */
export function planVoiceAssignments(rooms: readonly CoverageRoom[], available: readonly string[],
  current: ReadonlyMap<string, MatchId>): AssignmentResult {
  const ordered = [...rooms].sort((a, b) => rank(a) - rank(b) || Number(a.matchId.slice(1)) - Number(b.matchId.slice(1)));
  const usable = new Set(available);
  // First covered room (in order) that pins a bot owns that pin.
  const pinOwner = new Map<string, MatchId>();
  for (const room of ordered) if (room.pinnedBotId && usable.has(room.pinnedBotId) && !pinOwner.has(room.pinnedBotId))
    pinOwner.set(room.pinnedBotId, room.matchId);
  const assigned = new Map<MatchId, { botId: string; pinned: boolean }>();
  const used = new Set<string>();
  const take = (room: CoverageRoom, botId: string, pinned: boolean) => { used.add(botId); assigned.set(room.matchId, { botId, pinned }); };
  const reservedElsewhere = (botId: string, room: CoverageRoom) => { const owner = pinOwner.get(botId); return owner !== undefined && owner !== room.matchId; };
  // Pass 1: pins, then sticky assignments.
  for (const room of ordered) {
    const pinned = room.pinnedBotId ?? null;
    if (pinned && pinOwner.get(pinned) === room.matchId) take(room, pinned, true);
  }
  const stickyOf = new Map<MatchId, string>();
  for (const [botId, matchId] of current) if (usable.has(botId)) stickyOf.set(matchId, botId);
  for (const room of ordered) {
    if (assigned.has(room.matchId)) continue;
    const sticky = stickyOf.get(room.matchId);
    if (sticky && !used.has(sticky) && !reservedElsewhere(sticky, room)) take(room, sticky, false);
  }
  // Pass 2: free bots in room order; then a room still without one reclaims from the lowest-ranked room below it.
  for (const room of ordered) {
    if (assigned.has(room.matchId)) continue;
    const free = available.find(id => !used.has(id) && !reservedElsewhere(id, room));
    if (free) { take(room, free, false); continue; }
    for (const victim of [...ordered].reverse()) {
      if (rank(victim) <= rank(room)) break;
      const holding = assigned.get(victim.matchId);
      if (!holding || (holding.pinned && !room.judgeCall)) continue;
      assigned.delete(victim.matchId);
      assigned.set(room.matchId, { botId: holding.botId, pinned: false });
      break;
    }
  }
  const result: AssignmentResult = { rooms: new Map(), bots: new Map() };
  for (const room of ordered) {
    const holding = assigned.get(room.matchId);
    result.rooms.set(room.matchId, holding?.botId ?? null);
    if (holding) result.bots.set(holding.botId, room.matchId);
  }
  return result;
}

/** Dashboard status of a covered room. */
export function roomStatus(room: Pick<CoverageRoom, 'record'>, botId: string | null): VoiceRoomStatus {
  return botId === null ? 'unmonitored' : room.record ? 'recording' : 'monitored';
}
