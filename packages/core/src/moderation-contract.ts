// Moderation contract v1, shared by apps/server and apps/web. See docs/VIDEO_EVIDENCE_AND_MODERATION_PLAN.md.
import type { MatchId, Snowflake } from './admin-contract.js';
import { EVIDENCE_REPLY_AUDIT_KINDS } from './evidence-contract.js';
import { ADMIN_TOOLS_AUDIT_KINDS } from './admin-tools-contract.js';
import { LOCAL_SETTINGS_AUDIT_KINDS } from './local-settings-contract.js';
import { LFG_AUDIT_KINDS } from './lfg-contract.js';

// ---- Text moderation (Discord AutoMod-backed) ----

export const KEYWORD_PRESETS = ['profanity', 'sexual', 'slurs'] as const;
export type KeywordPreset = typeof KEYWORD_PRESETS[number];
/** 'flag' alerts only; 'block' stops the message; 'timeout' blocks and times the author out (custom lists only). */
export const KEYWORD_ACTIONS = ['flag', 'block', 'timeout'] as const;
export type KeywordAction = typeof KEYWORD_ACTIONS[number];

/** Discord allows one preset rule per server; its actions cannot include a timeout. */
export interface PresetKeywordRuleDto {
  enabled: boolean;
  presets: Record<KeywordPreset, boolean>;
  action: Exclude<KeywordAction, 'timeout'>;
  /** Words that never trigger the preset lists. */
  allowList: string[];
}

export interface CustomKeywordListDto {
  /** Client-chosen stable ID: 1-32 of [a-z0-9-]. */
  id: string;
  name: string;
  enabled: boolean;
  words: string[];
  regexPatterns: string[];
  allowList: string[];
  action: KeywordAction;
  /** Used only when action is 'timeout'. */
  timeoutSeconds: number;
}

export interface TextModerationSettingsDto {
  enabled: boolean;
  preset: PresetKeywordRuleDto;
  customLists: CustomKeywordListDto[];
  /** Discord channel that receives AutoMod alert messages; null sends dashboard flags only. */
  alertChannelId: Snowflake | null;
  /** Shown to a member whose message was blocked. */
  blockMessage: string;
  /** AutoMod supports exemptions only: "match rooms only" means exempting every other channel. */
  exemptChannelIds: Snowflake[];
  exemptRoleIds: Snowflake[];
}

// ---- Voice loudness ----

export const VOICE_SENSITIVITIES = ['low', 'medium', 'high', 'custom'] as const;
export type VoiceSensitivity = typeof VOICE_SENSITIVITIES[number];
/** Presets fill threshold and sustain; 'custom' keeps the advanced values as sent. */
export const VOICE_SENSITIVITY_PRESETS: Readonly<Record<Exclude<VoiceSensitivity, 'custom'>, { thresholdDbfs: number; sustainMs: number }>> = {
  low: { thresholdDbfs: -4, sustainMs: 600 },
  medium: { thresholdDbfs: -8, sustainMs: 400 },
  high: { thresholdDbfs: -14, sustainMs: 250 }
};
export const VOICE_MONITOR_SCOPES = ['judge-call', 'always'] as const;
export type VoiceMonitorScope = typeof VOICE_MONITOR_SCOPES[number];

/** Loudness spikes are flagged only; the bot never mutes anyone. */
export interface VoiceLoudnessSettingsDto {
  enabled: boolean;
  /** 'judge-call': only rooms with an open judge call or dispute. 'always': every covered match room. */
  scope: VoiceMonitorScope;
  sensitivity: VoiceSensitivity;
  thresholdDbfs: number;
  sustainMs: number;
  cooldownMs: number;
  /** Also post a rate-limited notice to the organizer in Discord. */
  notifyDiscord: boolean;
  /** Where the notice goes; null uses the organizer's signup channel. */
  notifyChannelId: Snowflake | null;
  /** Per voice room policy keyed by voice channel ID (rooms outlive events). Absent or {} = every room 'auto'. */
  rooms?: Record<Snowflake, VoiceRoomPolicyDto>;
}

// ---- Per-room voice policy ----

/** 'auto' follows the global scope and recording rules; 'always' keeps a bot there; 'never' never covers it. */
export const VOICE_ROOM_COVERAGES = ['auto', 'always', 'never'] as const;
export type VoiceRoomCoverage = typeof VOICE_ROOM_COVERAGES[number];
/** 'inherit' uses settings.recording.mode; anything else overrides it for this room (it may record more). */
export const VOICE_ROOM_RECORDINGS = ['inherit', 'off', 'judge-call', 'always'] as const;
export type VoiceRoomRecording = typeof VOICE_ROOM_RECORDINGS[number];
export const VOICE_ROOM_PRIORITIES = ['normal', 'high'] as const;
export type VoiceRoomPriority = typeof VOICE_ROOM_PRIORITIES[number];
export interface VoiceRoomPolicyDto {
  coverage: VoiceRoomCoverage;
  recording: VoiceRoomRecording;
  /** 'high' rooms are covered before 'normal' ones, after judge calls. */
  priority: VoiceRoomPriority;
  /** Preferred bot ('main' or a helper ID); free for other rooms while this one needs none. */
  pinnedBotId: string | null;
}
export const DEFAULT_VOICE_ROOM_POLICY: Readonly<VoiceRoomPolicyDto> = Object.freeze<VoiceRoomPolicyDto>(
  { coverage: 'auto', recording: 'inherit', priority: 'normal', pinnedBotId: null });

// ---- Audio recording and retention ----

export const RECORDING_MODES = ['off', 'judge-call', 'always'] as const;
export type RecordingMode = typeof RECORDING_MODES[number];
/** Stored as the original Opus packets in Ogg, one file per player, without re-encoding. */
export interface RecordingSettingsDto {
  mode: RecordingMode;
  /** Players who declined recording: never subscribed, recorded or loudness-checked. Absent means []. */
  optOutUserIds?: Snowflake[];
}

/** null keeps evidence until deleted by hand. Held items are never deleted automatically. */
export interface RetentionSettingsDto { days: number | null }
export const RETENTION_PRESET_DAYS = [7, 30, null] as const;

export interface ModerationSettingsBodyDto {
  text: TextModerationSettingsDto;
  voice: VoiceLoudnessSettingsDto;
  recording: RecordingSettingsDto;
  retention: RetentionSettingsDto;
  /** Overrides the default notice shown on signup cards and match rooms while monitoring is active. */
  noticeText: string | null;
}

/** GET /api/v1/moderation/settings */
export interface ModerationSettingsDto extends ModerationSettingsBodyDto {
  guildId: Snowflake;
  /** Optimistic concurrency: 0 until the first save. */
  version: number;
  updatedAtMs: number | null;
}

/** PUT /api/v1/moderation/settings. A stale expectedVersion answers 409 with ModerationSettingsConflictDto. */
export interface SaveModerationSettingsRequestDto { expectedVersion: number; settings: ModerationSettingsBodyDto }
export interface ModerationSettingsConflictDto {
  error: { code: 'conflict'; message: string };
  current: ModerationSettingsDto;
}

/** POST /api/v1/moderation/automod/sync */
export interface AutoModSyncResultDto {
  status: 'synced' | 'pending' | 'disabled';
  /** The server already has a preset rule the bot does not own; only custom lists are managed. */
  presetManagedElsewhere: boolean;
  ruleIds: Snowflake[];
  message?: string;
}

// ---- Flags ----

export const MODERATION_FLAG_KINDS = ['keyword', 'volume'] as const;
export type ModerationFlagKind = typeof MODERATION_FLAG_KINDS[number];

export interface KeywordFlagDetailDto {
  ruleId: Snowflake | null;
  ruleName: string;
  action: KeywordAction;
  matchedKeyword: string | null;
  /** Usually empty: AutoMod sends content only with the Message Content intent, which the bot does not use. */
  matchedContent: string | null;
}
export interface VolumeFlagDetailDto {
  peakDbfs: number;
  rmsDbfs: number;
  sustainedMs: number;
  thresholdDbfs: number;
  /** Milliseconds into the match recording when one was running, else absent or null. */
  recordingOffsetMs?: number | null;
}

interface ModerationFlagBase {
  /** Monotonic; use as the `after` cursor. */
  id: number;
  guildId: Snowflake;
  channelId: Snowflake | null;
  eventId: string | null;
  matchId: MatchId | null;
  userId: Snowflake | null;
  occurredAtMs: number;
  /** The admin's triage; absent or null while the flag is still open. */
  review?: ModerationFlagReviewDto | null;
}
export type ModerationFlagDto =
  | ModerationFlagBase & { kind: 'keyword'; detail: KeywordFlagDetailDto }
  | ModerationFlagBase & { kind: 'volume'; detail: VolumeFlagDetailDto };

/** Triage states: acknowledged (seen, handled) or dismissed (not a problem). */
export const MODERATION_FLAG_REVIEW_STATES = ['acknowledged', 'dismissed'] as const;
export type ModerationFlagReviewState = typeof MODERATION_FLAG_REVIEW_STATES[number];
export interface ModerationFlagReviewDto { state: ModerationFlagReviewState; atMs: number; by: string }
/** PATCH /api/v1/moderation/flags/:id — null reopens the flag. Answers the updated ModerationFlagDto; audited as moderation.flag.reviewed. */
export interface UpdateModerationFlagRequestDto { state: ModerationFlagReviewState | null }

/** GET /api/v1/moderation/flags?after=&limit= — oldest first after the cursor. */
export interface ModerationFlagPageDto { flags: ModerationFlagDto[]; nextAfter: number }

// ---- Voice bot pool ----

/** Never carries a token. The main bot is id 'main'; helper bots use their stored UUID. */
export interface VoiceBotStatusDto {
  id: string;
  label: string;
  kind: 'main' | 'helper';
  /** Discord user ID decoded from the token's public first segment, when known. */
  userId: Snowflake | null;
  connected: boolean;
  assignedChannelId: Snowflake | null;
  assignedMatchId: MatchId | null;
  addedAtMs: number | null;
  /** Runtime detail; 'login failed' affects only that bot. Absent while the runtime is disabled. */
  status?: VoiceBotRuntimeStatus;
  /** Helpers only: a disabled helper is never logged in or assigned. The main bot is always enabled. */
  enabled?: boolean;
  /** Public application ID (from GET /applications/@me when the helper was added or verified). */
  applicationId?: Snowflake | null;
  /** OAuth2 invite with only the voice-room permissions; null until the application ID is known. */
  inviteUrl?: string | null;
  /** Per-server nickname the helper sets on itself; null keeps its username. */
  nickname?: string | null;
  lastReadyAtMs?: number | null;
  lastErrorCode?: VoiceBotErrorCode | null;
  consecutiveFailures?: number;
}
/** Fixed error codes: never library text, never anything derived from a token. */
export const VOICE_BOT_ERROR_CODES = ['invalid-token', 'network', 'timeout', 'not-in-server', 'join-failed', 'disconnected',
  'missing-permissions', 'rate-limited', 'unknown'] as const;
export type VoiceBotErrorCode = typeof VOICE_BOT_ERROR_CODES[number];
export const VOICE_BOT_RUNTIME_STATUSES = ['idle', 'logging-in', 'ready', 'connecting', 'connected', 'login failed',
  'not in server', 'error'] as const;
export type VoiceBotRuntimeStatus = typeof VOICE_BOT_RUNTIME_STATUSES[number];
export type VoiceRoomStatus = 'monitored' | 'recording' | 'unmonitored';
export interface VoiceRoomCoverageDto { matchId: MatchId; channelId: Snowflake; botId: string | null; status?: VoiceRoomStatus }
/** GET /api/v1/moderation/voice-bots and the answer to POST/DELETE. */
export interface VoiceBotPoolDto {
  /** 'disabled' until the voice runtime is enabled; statuses then show connected false. */
  runtime: 'running' | 'disabled';
  bots: VoiceBotStatusDto[];
  /** Match rooms that need monitoring; botId null means no free bot, so the room is not monitored. */
  rooms: VoiceRoomCoverageDto[];
}
/** POST /api/v1/moderation/voice-bots. The token is stored only in data/voice-bots.json. */
export interface AddVoiceBotRequestDto { label: string; token: string }
/** PATCH /api/v1/moderation/voice-bots/:id (helpers only); every field optional. */
export interface UpdateVoiceBotRequestDto { label?: string; enabled?: boolean; nickname?: string | null }
/** PUT /api/v1/moderation/voice-bots/:id/token: a new token for the SAME bot user (rotation). */
export interface ReplaceVoiceBotTokenRequestDto { token: string }
/** POST /api/v1/moderation/voice-bots/:id/verify. channelIds default to the current and configured match rooms. */
export interface VerifyVoiceBotRequestDto { channelIds?: Snowflake[] }
export type VoiceBotCheckState = 'ok' | 'problem' | 'unknown';
export interface VoiceBotChannelCheckDto { channelId: Snowflake; viewChannel: boolean; connect: boolean; state: VoiceBotCheckState }
/** Token-free answer to verify. */
export interface VoiceBotVerifyReportDto {
  botId: string;
  checkedAtMs: number;
  tokenValid: boolean;
  applicationId: Snowflake | null;
  inServer: boolean;
  /** null when unknown or unset. */
  nickname: string | null;
  channels: VoiceBotChannelCheckDto[];
  /** Short fixed explanations (Public Bot on, Administrator or Manage Server granted, ...). */
  warnings: string[];
  problems: string[];
  errorCode: VoiceBotErrorCode | null;
  inviteUrl: string | null;
}
/** POST /api/v1/moderation/recording-opt-outs { userId, optedOut } answers the current list. */
export interface RecordingOptOutRequestDto { userId: Snowflake; optedOut: boolean }
export interface RecordingOptOutListDto { userIds: Snowflake[]; version: number }

// ---- Operations audit (evidence and moderation; separate from the domain audit) ----

export const OPS_AUDIT_KINDS = ['evidence.submitted', 'evidence.viewed', 'evidence.deleted', 'evidence.hold',
  'evidence.failed', 'evidence.retention', 'moderation.settings', 'moderation.voice_bot.added',
  'moderation.voice_bot.removed', 'automod.synced', 'automod.executed', 'voice.spike',
  'voice.recording.start', 'voice.recording.stop', 'voice.notice_failed', 'voice.recording.stopped_storage',
  'moderation.voice_bot.updated', 'voice.recording.gap', 'voice.recording.partial', 'voice.recording.opt_out',
  'moderation.flag.reviewed',
  ...EVIDENCE_REPLY_AUDIT_KINDS, ...ADMIN_TOOLS_AUDIT_KINDS, ...LOCAL_SETTINGS_AUDIT_KINDS, ...LFG_AUDIT_KINDS] as const;
export type OpsAuditKind = typeof OPS_AUDIT_KINDS[number];
export type OpsActorKind = 'admin' | 'player' | 'bot' | 'system';

export interface OpsAuditEntryDto {
  id: number;
  eventId: string | null;
  guildId: Snowflake | null;
  kind: OpsAuditKind;
  actorKind: OpsActorKind;
  actorId: string;
  payload: Record<string, unknown>;
  occurredAtMs: number;
}
/** GET /api/v1/ops/audit?after=&limit=&eventId= — oldest first after the cursor. */
export interface OpsAuditPageDto { entries: OpsAuditEntryDto[]; nextAfter: number }

// ---- Limits (Discord AutoMod limits where they apply) ----

export const MODERATION_LIMITS = {
  customLists: 6,
  listNameLength: 40,
  wordsPerList: 1000,
  wordLength: 60,
  regexPerList: 10,
  regexLength: 260,
  allowListPerCustomList: 100,
  allowListPreset: 1000,
  exemptChannels: 50,
  exemptRoles: 20,
  blockMessageLength: 150,
  timeoutSecondsMin: 60,
  timeoutSecondsMax: 2_419_200,
  thresholdDbfsMin: -30,
  thresholdDbfsMax: 0,
  sustainMsMin: 100,
  sustainMsMax: 3000,
  cooldownMsMin: 5000,
  cooldownMsMax: 600_000,
  retentionDaysMin: 1,
  retentionDaysMax: 365,
  noticeTextLength: 300,
  voiceBotLabelLength: 40,
  voiceHelperBots: 10,
  voiceRoomPolicies: 50,
  recordingOptOuts: 500,
  voiceBotNicknameLength: 32
} as const;
export const MODERATION_FLAG_PAGE_LIMIT = 200;
export const OPS_AUDIT_PAGE_LIMIT = 500;

export const DEFAULT_MODERATION_NOTICE =
  'Match rooms may be audio-monitored and recorded when a judge is called. Recordings are deleted automatically.';

export const DEFAULT_MODERATION_SETTINGS: Readonly<ModerationSettingsBodyDto> = Object.freeze<ModerationSettingsBodyDto>({
  text: {
    enabled: false,
    preset: { enabled: true, presets: { profanity: true, sexual: true, slurs: true }, action: 'block', allowList: [] },
    customLists: [],
    alertChannelId: null,
    blockMessage: 'This message was blocked by the tournament filter.',
    exemptChannelIds: [],
    exemptRoleIds: []
  },
  voice: {
    enabled: false, scope: 'judge-call', sensitivity: 'medium',
    ...VOICE_SENSITIVITY_PRESETS.medium, cooldownMs: 60_000, notifyDiscord: false, notifyChannelId: null, rooms: {}
  },
  recording: { mode: 'judge-call', optOutUserIds: [] },
  retention: { days: 30 },
  noticeText: null
});
