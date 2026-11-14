// Runtime seam for optional Discord features (evidence submit, AutoMod, voice pool, loudness, recording).
// A feature is registered in feature-registry.ts and receives everything it needs through
// DiscordFeatureContext, so adding one never edits controller.ts or runtime.ts.
import type { Client, GatewayIntentBits } from 'discord.js';
import type { MatchId, ModerationFlagDto, ModerationSettingsDto, OpsAuditEntryDto } from '@tcg-live/core';
import type { EvidenceStore } from '../evidence/store.js';
import type { ModerationFlagInput } from '../moderation/flags.js';
import type { OpsAuditInput } from '../ops/audit.js';
import type { VoicePoolLiveState } from '../voice/pool.js';
import type { VoiceBotRegistry } from '../voice/tokens.js';

/** Committed match transitions, emitted by the controller after the store commit. */
export type MatchLifecycleEvent =
  /** A player pressed Call judge ('called') or the match clock expired ('expired'). */
  | { type: 'judgeCalled'; eventId: string; matchId: MatchId; reason: 'called' | 'expired'; requestedBy: string | null; occurredAtMs: number }
  /** A player disputed the reported result. */
  | { type: 'disputeOpened'; eventId: string; matchId: MatchId; revision: number; requestedBy: string | null; occurredAtMs: number }
  /** The admin resumed a match after a judge call. */
  | { type: 'judgeResumed'; eventId: string; matchId: MatchId; occurredAtMs: number }
  /** The match reached its final result (confirmed by players, or resolved/corrected by the admin). */
  | { type: 'matchResolved'; eventId: string; matchId: MatchId; winner: string | null; source: 'agreed' | 'admin'; occurredAtMs: number };

export type DiscordFeatureEvent =
  | MatchLifecycleEvent
  /** A round's voice room was created or re-bound for a match. */
  | { type: 'matchRoomAssigned'; eventId: string; matchId: MatchId; channelId: string; occurredAtMs: number }
  /** The dashboard saved moderation settings. */
  | { type: 'moderationSettingsChanged'; settings: ModerationSettingsDto }
  /** The dashboard added or removed a helper voice bot. */
  | { type: 'voiceBotsChanged' };
export type DiscordFeatureEventType = DiscordFeatureEvent['type'];
export type DiscordFeatureListener<T extends DiscordFeatureEventType> = (event: Extract<DiscordFeatureEvent, { type: T }>) => void;

/** Typed bus. Listeners run in isolated microtasks: a throwing feature never affects Discord handling. */
export class DiscordFeatureEvents {
  private readonly listeners = new Map<DiscordFeatureEventType, Set<(event: DiscordFeatureEvent) => void>>();

  on<T extends DiscordFeatureEventType>(type: T, listener: DiscordFeatureListener<T>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    this.listeners.set(type, set);
    const wrapped = listener as (event: DiscordFeatureEvent) => void;
    set.add(wrapped);
    return () => { set.delete(wrapped); };
  }

  emit(event: DiscordFeatureEvent): void {
    for (const listener of [...this.listeners.get(event.type) ?? []]) {
      queueMicrotask(() => {
        try { listener(event); } catch { /* Features never affect the emitter. */ }
      });
    }
  }
}

export interface MatchRoomInfo {
  eventId: string;
  matchId: MatchId;
  /** The match's voice room, or null when the event has none. */
  voiceChannelId: string | null;
  /** Discord IDs of the two seated players only; never spectators. */
  playerIds: string[];
  /** Match phase ('final' once resolved), when known. */
  phase?: string;
  /** An open judge call or dispute, when known. */
  judgeCall?: boolean;
}

export interface DiscordFeatureContext {
  readonly client: Client;
  readonly guildId: string;
  /** The organizer's Discord ID (config.adminId). */
  readonly adminId: string;
  /** False once the runtime is stopping or the database lease is lost: stop acting. */
  isActive(): boolean;
  moderationSettings(): Promise<ModerationSettingsDto>;
  /** Appends a flag and its ops-audit row. */
  appendFlag(input: ModerationFlagInput): Promise<ModerationFlagDto>;
  appendAudit(input: OpsAuditInput): Promise<OpsAuditEntryDto>;
  readonly evidence: EvidenceStore;
  /** Helper voice-bot credentials; getTokens() returns secrets, never log them. */
  readonly voiceBots: Pick<VoiceBotRegistry, 'list' | 'getTokens'>;
  /** Publishes the pool state shown by GET /api/v1/moderation/voice-bots; null when voice is off. */
  publishVoicePool(state: VoicePoolLiveState | null): void;
  on<T extends DiscordFeatureEventType>(type: T, listener: DiscordFeatureListener<T>): () => void;
  /** Room and seated players of a match in the active event, or null. */
  matchRoom(matchId: MatchId): Promise<MatchRoomInfo | null>;
  /** Every match of the active event, with its room and players. */
  activeMatchRooms(): Promise<MatchRoomInfo[]>;
  /** Token-free operator line on stderr. */
  log(message: string): void;
}

export interface DiscordFeature {
  readonly name: string;
  /** Extra non-privileged Gateway intents (for example GuildVoiceStates, AutoModerationExecution). */
  readonly intents?: readonly GatewayIntentBits[];
  start(context: DiscordFeatureContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

export function featureIntents(features: readonly DiscordFeature[]): GatewayIntentBits[] {
  return [...new Set(features.flatMap(feature => feature.intents ?? []))];
}

const STOP_BUDGET_MS = 1_500;

/**
 * Starts each feature in isolation: a failing feature is logged by name and skipped, the bot keeps
 * running. stop() runs in reverse order with a per-feature time budget and never rejects.
 */
export async function startDiscordFeatures(features: readonly DiscordFeature[], context: DiscordFeatureContext):
  Promise<{ readonly started: string[]; stop(): Promise<void> }> {
  const running: DiscordFeature[] = [];
  for (const feature of features) {
    if (!context.isActive()) break;
    try {
      await feature.start(context);
      running.push(feature);
    } catch {
      context.log(`Discord feature ${feature.name} could not start; continuing without it.`);
      try { await feature.stop(); } catch { /* Partial start cleanup is best effort. */ }
    }
  }
  let stopping: Promise<void> | undefined;
  return {
    started: running.map(feature => feature.name),
    stop() {
      stopping ??= (async () => {
        for (const feature of [...running].reverse()) {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([Promise.resolve().then(() => feature.stop()),
              new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_BUDGET_MS); timer.unref(); })]);
          } catch { context.log(`Discord feature ${feature.name} did not stop cleanly.`); }
          finally { if (timer) clearTimeout(timer); }
        }
      })();
      return stopping;
    }
  };
}

/** Holder behind ModerationRouteOptions.voicePool and DiscordFeatureContext.publishVoicePool. */
export class VoicePoolState {
  private state: VoicePoolLiveState | null = null;
  live(): VoicePoolLiveState | null { return this.state; }
  publish(state: VoicePoolLiveState | null): void { this.state = state; }
}
