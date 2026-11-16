// The match rooms service as the routes, the runtime and the demo see it. The Discord runtime (or the demo) attaches
// its implementation at start; with none attached the routes answer 503. Errors are RuleError (routes map to 409)
// or OpsInputError (400).
import type { CleanupPlanDto, CleanupResultDto, MatchId, MatchRoomDto, MatchRoomTranscriptDto, MatchRoomTranscriptSummaryDto,
  MatchRoomsDto, SaveMatchRoomSettingsRequestDto, SetupMatchRoomsDto, Snowflake } from '@tcg-live/core';

export interface MatchRoomService {
  describe(): Promise<MatchRoomsDto>;
  /** OpsConflictError on a stale version; a template change enqueues renames. */
  saveSettings(req: SaveMatchRoomSettingsRequestDto): Promise<MatchRoomsDto>;
  /** Enqueues the rename; never awaits a Discord rename. */
  setCustomName(channelId: string, customName: string | null): Promise<MatchRoomDto>;
  ensureTables(count: number): Promise<{ created: Snowflake[]; rooms: MatchRoomsDto }>;
  adopt(channelId: string): Promise<MatchRoomDto>;
  forget(channelId: string): Promise<void>;
  cleanupPlan(): Promise<CleanupPlanDto>;
  /** Refuses a stale token (the plan changed) with RuleError. */
  cleanupConfirm(planToken: string, actor?: { kind: 'admin' | 'player' | 'bot' | 'system'; id: string }): Promise<CleanupResultDto>;
  transcripts(eventId: string, matchId?: MatchId): Promise<MatchRoomTranscriptSummaryDto[]>;
  transcript(id: string): Promise<MatchRoomTranscriptDto>;
  setTranscriptHold(id: string, hold: boolean): Promise<void>;
}

/** Setup's way to hand the chosen category to the rooms settings. */
export interface MatchRoomSetupSink {
  applySetup(guildId: string, applicationId: string, input: SetupMatchRoomsDto): Promise<void>;
}

let attached: MatchRoomService | null = null;

export function attachMatchRoomService(s: MatchRoomService | null): void { attached = s; }
export function currentMatchRoomService(): MatchRoomService | null { return attached; }
