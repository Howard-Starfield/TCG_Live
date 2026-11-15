// Voice bot pool status for the dashboard. The main bot covers one voice room; each helper bot covers
// one more room concurrently. Rooms without a free bot are reported with botId null (not monitored).
import type { MatchId, VoiceBotPoolDto, VoiceBotRuntimeStatus, VoiceBotStatusDto, VoiceRoomCoverageDto,
  VoiceRoomStatus } from '@tcg-live/core';
import type { VoiceBotSummary } from './tokens.js';

export const MAIN_VOICE_BOT_ID = 'main';

/** Live state published by the voice runtime. Absent means the runtime is disabled. */
export interface VoicePoolLiveState {
  bots: Partial<Record<string, { connected: boolean; assignedChannelId: string | null;
    assignedMatchId: VoiceBotStatusDto['assignedMatchId']; status?: VoiceBotRuntimeStatus }>>;
  rooms: VoiceRoomCoverageDto[];
}
export interface VoicePoolStatusSource { live(): VoicePoolLiveState | null }

export function describeVoicePool(helpers: VoiceBotSummary[], live: VoicePoolLiveState | null,
  main: { userId: string | null; label?: string } = { userId: null }): VoiceBotPoolDto {
  const state = (id: string) => live?.bots[id] ?? { connected: false, assignedChannelId: null, assignedMatchId: null };
  const bots: VoiceBotStatusDto[] = [
    { id: MAIN_VOICE_BOT_ID, label: main.label ?? 'Main bot', kind: 'main', userId: main.userId, addedAtMs: null, ...state(MAIN_VOICE_BOT_ID) },
    ...helpers.map(helper => ({ id: helper.id, label: helper.label, kind: 'helper' as const, userId: helper.userId,
      addedAtMs: helper.addedAtMs, ...state(helper.id) }))
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
}
export interface AssignmentResult {
  /** matchId -> botId, or null when no free bot is left (not monitored). */
  rooms: Map<MatchId, string | null>;
  /** botId -> matchId for every assigned bot. */
  bots: Map<string, MatchId>;
}

/**
 * Assigns `available` bots (in preference order: main first) to `rooms`. Judge-call rooms come first
 * and may take a bot from a room without one; otherwise current assignments are kept so a bot never
 * hops between rooms needlessly.
 */
export function planVoiceAssignments(rooms: readonly CoverageRoom[], available: readonly string[],
  current: ReadonlyMap<string, MatchId>): AssignmentResult {
  const ordered = [...rooms].sort((a, b) => Number(b.judgeCall) - Number(a.judgeCall) ||
    Number(a.matchId.slice(1)) - Number(b.matchId.slice(1)));
  const sticky = new Map<MatchId, string>();
  for (const [botId, matchId] of current)
    if (available.includes(botId) && rooms.some(room => room.matchId === matchId)) sticky.set(matchId, botId);
  const used = new Set<string>();
  const result: AssignmentResult = { rooms: new Map(), bots: new Map() };
  const take = (room: CoverageRoom, botId: string) => { used.add(botId); result.rooms.set(room.matchId, botId); result.bots.set(botId, room.matchId); };
  // Pass 1: judge rooms keep their bot. Pass 2: other rooms keep theirs unless a judge room is left without one.
  for (const room of ordered) if (room.judgeCall && sticky.has(room.matchId)) take(room, sticky.get(room.matchId)!);
  const freeCount = available.filter(id => !used.has(id) && ![...sticky.values()].includes(id)).length;
  const judgeNeeding = ordered.filter(room => room.judgeCall && !result.rooms.has(room.matchId)).length;
  let reclaim = Math.max(0, judgeNeeding - freeCount);
  // Reclaim from the lowest-priority (last) non-judge rooms first.
  const reclaimed = new Set<MatchId>();
  for (const room of [...ordered].reverse()) {
    if (reclaim === 0) break;
    if (!room.judgeCall && sticky.has(room.matchId)) { reclaimed.add(room.matchId); reclaim -= 1; }
  }
  for (const room of ordered) if (!room.judgeCall && sticky.has(room.matchId) && !reclaimed.has(room.matchId))
    take(room, sticky.get(room.matchId)!);
  for (const room of ordered) {
    if (result.rooms.has(room.matchId)) continue;
    const free = available.find(id => !used.has(id));
    if (free) take(room, free); else result.rooms.set(room.matchId, null);
  }
  return result;
}

/** Dashboard status of a covered room. */
export function roomStatus(room: Pick<CoverageRoom, 'record'>, botId: string | null): VoiceRoomStatus {
  return botId === null ? 'unmonitored' : room.record ? 'recording' : 'monitored';
}
