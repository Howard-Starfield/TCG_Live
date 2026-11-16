// Runtime seam for optional Discord features (evidence submit, AutoMod, voice pool, loudness, recording).
// A feature is registered in feature-registry.ts and receives everything it needs through
// DiscordFeatureContext, so adding one never edits controller.ts or runtime.ts.
import type { Client, GatewayIntentBits, Guild } from 'discord.js';
import type { AdminToolsSettingsBodyDto, AdminToolsSettingsDto, AdminToolsStatusDto, MatchId, ModerationFlagDto,
  ModerationSettingsDto, OpsAuditEntryDto, OpsAuditKind, PrivilegedIntentName, PrivilegedIntentState } from '@tcg-live/core';
import type { EvidenceStore } from '../evidence/store.js';
import type { ModerationFlagInput } from '../moderation/flags.js';
import type { OpsActor, OpsAuditInput } from '../ops/audit.js';
import type { FeatureInteractions } from './interactions.js';
import type { ResolvedStaff } from './staff.js';
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
  /** The admin closed a judge request with a note (the match is not final). */
  | { type: 'judgeClosed'; eventId: string; matchId: MatchId; occurredAtMs: number }
  /** The match reached its final result (confirmed by players, or resolved/corrected by the admin). */
  | { type: 'matchResolved'; eventId: string; matchId: MatchId; winner: string | null; source: 'agreed' | 'admin'; occurredAtMs: number };

export type DiscordFeatureEvent =
  | MatchLifecycleEvent
  /** A round's voice room was created or re-bound for a match. */
  | { type: 'matchRoomAssigned'; eventId: string; matchId: MatchId; channelId: string; occurredAtMs: number }
  /** The dashboard saved moderation settings. */
  | { type: 'moderationSettingsChanged'; settings: ModerationSettingsDto }
  /** The dashboard added or removed a helper voice bot. */
  | { type: 'voiceBotsChanged' }
  /** The dashboard saved admin-tools settings. Intent changes need a restart (see ctx.adminToolsStatus()). */
  | { type: 'adminToolsSettingsChanged'; settings: AdminToolsSettingsDto }
  /**
   * An admin-tools route changed feature data (a sticky, panel, job, announcement...). `area` is the
   * route module's name; `id` the changed row when there is one. Emitted after the commit.
   */
  | { type: 'adminToolsChanged'; area: string; id: string | null };
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

/** Tournament member sets for bulk roles; IDs are Discord user IDs, never seats. */
export interface TournamentMembers {
  eventId: string;
  /** Signup roster (signup tournaments), else the seated players. */
  roster: string[];
  /** Players who checked in. */
  checkedIn: string[];
  /** Players seated in matches of the event. */
  players: string[];
}

export interface DiscordFeatureContext {
  readonly client: Client;
  readonly guildId: string;
  /** The organizer's Discord ID (config.adminId): setup identity and contact only; it is not a staff source. */
  readonly adminId: string;
  /** The member's tournament staff role (server owner, TCG Organizer, TCG Judge, legacy staff role), or null. */
  staffRoleOf(input: { userId: string; roleIds: readonly string[]; ownerId?: string | null }): Promise<ResolvedStaff | null>;
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

  // ---- Admin tools seams (docs/ADMIN_TOOLS_PROPOSAL.md) ----
  /** The configured guild (fetched once, then cached by discord.js). */
  guild(): Promise<Guild>;
  /** Saved admin-tools settings (defaults when none or the database is down). */
  adminToolsSettings(): Promise<AdminToolsSettingsDto>;
  /** Intents, restart-required and feature states, as the dashboard shows them. */
  adminToolsStatus(): Promise<AdminToolsStatusDto>;
  /** What the running gateway has: 'off' (not requested), 'on', or 'missing' (refused by Discord). */
  privilegedIntents(): Readonly<Record<PrivilegedIntentName, PrivilegedIntentState>>;
  /** Appends a tcg_ops_audit row for this guild; the actor defaults to the bot. */
  audit(kind: OpsAuditKind, payload?: Record<string, unknown>, actor?: OpsActor): Promise<OpsAuditEntryDto>;
  /** Roster, check-ins and seated players of the active tournament, or null when there is none. */
  tournamentMembers(): Promise<TournamentMembers | null>;
  /**
   * Channels the tournament owns (signup/control channel with its card sticky, match rooms, round rooms).
   * General stickies and ticket panels must never be placed here; the routes reject it.
   */
  reservedChannelIds(): Promise<string[]>;
  /** Button/select/modal custom-id prefixes and `/tcg-admin` subcommands. */
  readonly interactions: FeatureInteractions;
}

export interface DiscordFeature {
  readonly name: string;
  /** Extra non-privileged Gateway intents (for example GuildVoiceStates, AutoModerationExecution). */
  readonly intents?: readonly GatewayIntentBits[];
  /**
   * Intents that depend on the saved admin-tools settings, read once at login. May include the privileged
   * GuildMembers / MessageContent (use privilegedIntentsForSettings from @tcg-live/core). When Discord
   * refuses them the feature still starts; ctx.privilegedIntents() then reports 'missing'.
   */
  intentsFor?(settings: AdminToolsSettingsBodyDto): readonly GatewayIntentBits[];
  start(context: DiscordFeatureContext): Promise<void> | void;
  stop(): Promise<void> | void;
  /** Time stop() may take at shutdown; defaults to STOP_BUDGET_MS (voice needs longer to finalize recordings). */
  readonly stopBudgetMs?: number;
}

/** Static intents only; conditional ones come from planIntents() in intents.ts. */
export function featureIntents(features: readonly DiscordFeature[]): GatewayIntentBits[] {
  return [...new Set(features.flatMap(feature => feature.intents ?? []))];
}

export const STOP_BUDGET_MS = 1_500;

/**
 * Starts each feature in isolation: a failing feature is logged by name and skipped, the bot keeps
 * running. stop() runs in reverse order with a per-feature time budget and never rejects.
 */
export async function startDiscordFeatures(features: readonly DiscordFeature[], context: DiscordFeatureContext):
  Promise<{ readonly started: string[]; readonly failed: string[]; stop(): Promise<void> }> {
  const running: DiscordFeature[] = [];
  const failed: string[] = [];
  for (const feature of features) {
    if (!context.isActive()) break;
    try {
      await feature.start(context);
      running.push(feature);
    } catch {
      failed.push(feature.name);
      context.log(`Discord feature ${feature.name} could not start; continuing without it.`);
      try { await feature.stop(); } catch { /* Partial start cleanup is best effort. */ }
    }
  }
  let stopping: Promise<void> | undefined;
  return {
    started: running.map(feature => feature.name),
    failed,
    stop() {
      stopping ??= (async () => {
        for (const feature of [...running].reverse()) {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([Promise.resolve().then(() => feature.stop()),
              new Promise<void>(resolve => { timer = setTimeout(resolve, feature.stopBudgetMs ?? STOP_BUDGET_MS); timer.unref(); })]);
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
