// Admin tools contract v1 (Carl-bot style server tools), shared by apps/server and apps/web.
// Spec: docs/ADMIN_TOOLS_PROPOSAL.md ("Decisions"). The foundation owns this file; feature agents add
// feature-local types in their own files and use only what is declared here on the wire.
import type { MatchId, Snowflake } from './admin-contract.js';

// ---------------------------------------------------------------- shared building blocks

/** Discord embed as the dashboard edits it (stickies, announcements, ticket panel previews). */
export interface EmbedFieldDto { name: string; value: string; inline: boolean }
export interface EmbedDto {
  title: string | null;
  description: string | null;
  /** 0xRRGGBB, or null for Discord's default. */
  color: number | null;
  url: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  footer: string | null;
  fields: EmbedFieldDto[];
}

/** One message body: plain content, an embed, or both (at least one is required). */
export interface MessageBodyDto { content: string | null; embed: EmbedDto | null }

export const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'] as const;
export type ButtonStyleName = typeof BUTTON_STYLES[number];

/** Who did it: the dashboard's local admin, a Discord member (slash command / button), the bot, or outside the bot. */
export type AdminToolsActorKind = 'admin' | 'member' | 'bot' | 'external';

// ---------------------------------------------------------------- guild metadata (pickers)

export interface GuildRoleDto {
  id: Snowflake; name: string; color: number; position: number;
  /** Managed by an integration (bot roles, boosts): cannot be assigned. */
  managed: boolean;
  /** At or above the bot's highest role: the bot cannot assign or remove it. */
  aboveBot: boolean;
  /** Carries a staff permission (Administrator, Manage Server, Ban Members...): never handed out by panels, bulk jobs or auto-role. Optional for older servers. */
  elevated?: boolean;
}
export interface GuildChannelDto {
  id: Snowflake; name: string;
  type: 'text' | 'voice' | 'category' | 'announcement' | 'forum' | 'stage';
  parentId: Snowflake | null;
  position: number;
  /** Used by the tournament (signup/control channel, match rooms): stickies and ticket panels may not live here. */
  reserved: boolean;
}
export interface GuildEmojiDto { id: Snowflake; name: string; animated: boolean }
/** GET /api/v1/admin-tools/guild */
export interface GuildMetaDto {
  guildId: Snowflake; name: string; memberCount: number | null;
  roles: GuildRoleDto[]; channels: GuildChannelDto[]; emojis: GuildEmojiDto[];
}

// ---------------------------------------------------------------- members, bans, cases, notes (agent A)

export interface MemberFlagsDto {
  banned: boolean;
  /** Communication disabled until this time, or null. */
  timedOutUntilMs: number | null;
  /** Account younger than the join/leave log's newAccountDays. */
  newAccount: boolean;
  bot: boolean;
  /** Left the server (profile kept from logs/cases). */
  left: boolean;
}
export interface MemberSummaryDto {
  id: Snowflake;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  roleIds: Snowflake[];
  joinedAtMs: number | null;
  accountCreatedAtMs: number;
  flags: MemberFlagsDto;
  caseCount: number;
  noteCount: number;
}
export interface TournamentHistoryRefDto {
  eventId: string; name: string | null; status: 'active' | 'retired' | 'draft';
  createdAtMs: number; role: 'player' | 'roster' | 'admin';
}
export interface MemberProfileDto extends MemberSummaryDto {
  cases: ModCaseDto[];
  notes: ModNoteDto[];
  tournaments: TournamentHistoryRefDto[];
}
/** GET /api/v1/admin-tools/members?q=&limit= (prefix search on username / display name, or an exact ID). */
export interface MemberSearchDto { members: MemberSummaryDto[]; truncated: boolean }

export interface BanEntryDto {
  userId: Snowflake; username: string; avatarUrl: string | null;
  reason: string | null;
  /** The case that created the ban, when the bot did it. */
  caseNumber: number | null;
  /** Tempban expiry, or null for permanent. */
  expiresAtMs: number | null;
}
/** GET /api/v1/admin-tools/bans?q=&after= */
export interface BanListDto { bans: BanEntryDto[]; nextAfter: Snowflake | null }

export const MOD_CASE_KINDS = ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'] as const;
export type ModCaseKind = typeof MOD_CASE_KINDS[number];
export const MOD_CASE_SOURCES = ['dashboard', 'discord', 'external'] as const;
export type ModCaseSource = typeof MOD_CASE_SOURCES[number];

export interface ModCaseDto {
  guildId: Snowflake;
  /** Per-guild, gap-free, allocated transactionally (tcg_admin_counters 'case'). */
  number: number;
  kind: ModCaseKind;
  targetId: Snowflake;
  moderatorKind: AdminToolsActorKind;
  /** 'local-admin', a Discord user ID, or 'bot'. */
  moderatorId: string;
  reason: string;
  /** Match evidence (tcg_evidence) IDs. */
  evidenceIds: string[];
  /** Tournament context, when the action came from a match card. */
  eventId: string | null;
  matchId: MatchId | null;
  source: ModCaseSource;
  createdAtMs: number;
  /** Tempban / long timeout end, or null. */
  expiresAtMs: number | null;
  /** When the expiry was carried out (unban, timeout lifted); catch-up runs on restart. */
  expiryHandledAtMs: number | null;
}
/** GET /api/v1/admin-tools/cases?targetId=&kind=&after=&limit= — newest first by number. */
export interface ModCasePageDto { cases: ModCaseDto[]; nextBefore: number | null }

export interface ModNoteDto {
  id: number; guildId: Snowflake; targetId: Snowflake;
  authorId: string; body: string; createdAtMs: number; updatedAtMs: number;
}
export interface ModNoteRequestDto { targetId: Snowflake; body: string }

interface ModActionBase {
  userId: Snowflake;
  /** Required, 1-ADMIN_TOOLS_LIMITS.reasonLength after trimming. */
  reason: string;
  evidenceIds?: string[];
  eventId?: string | null;
  matchId?: MatchId | null;
}
/** POST /api/v1/admin-tools/actions */
export type ModActionRequestDto =
  | ModActionBase & { action: 'warn' }
  | ModActionBase & { action: 'timeout'; durationMs: number }
  | ModActionBase & { action: 'untimeout' }
  | ModActionBase & { action: 'kick' }
  /** durationMs null = permanent; otherwise a tempban lifted by the bot (catch-up on restart). */
  | ModActionBase & { action: 'ban'; deleteMessageSeconds: number; durationMs: number | null }
  | ModActionBase & { action: 'unban' };
export type ModAction = ModActionRequestDto['action'];
export interface ModActionResultDto {
  case: ModCaseDto;
  /** Whether the member was told by DM (best effort; closed DMs fail). */
  dm: 'sent' | 'failed' | 'skipped';
}

/** GET /api/v1/admin-tools/mod-audit — our cases merged with the Discord audit log (bans done outside the bot). */
export interface ModAuditEntryDto {
  id: string; kind: ModCaseKind | 'role' | 'nick' | 'other';
  targetId: Snowflake | null; moderatorId: string | null; reason: string | null;
  caseNumber: number | null; source: ModCaseSource; occurredAtMs: number;
}
export interface ModAuditPageDto { entries: ModAuditEntryDto[]; nextBefore: number | null }

// ---------------------------------------------------------------- stickies and channel controls (agent B)

/**
 * A general sticky re-posted at the bottom of its channel (debounced). Stored in tcg_sticky_messages, not
 * in the settings document. Rule: never on a reserved channel (the tournament signup/control channel owns
 * its own card sticky logic in discord/controller.ts); the routes reject it with 400.
 */
export interface StickyMessageDto extends MessageBodyDto {
  id: string;
  guildId: Snowflake;
  channelId: Snowflake;
  enabled: boolean;
  debounceMs: number;
  /** The bot's current copy at the bottom of the channel, when posted. */
  lastMessageId: Snowflake | null;
  updatedAtMs: number;
}
export interface SaveStickyRequestDto extends MessageBodyDto { channelId: Snowflake; enabled: boolean; debounceMs: number }

/** POST /api/v1/admin-tools/channels/lock */
export interface ChannelLockRequestDto { channelId: Snowflake; locked: boolean; reason: string }
/** POST /api/v1/admin-tools/channels/slowmode — 0 turns slowmode off. */
export interface ChannelSlowmodeRequestDto { channelId: Snowflake; seconds: number; reason: string }
/** POST /api/v1/admin-tools/channels/purge — by count, or the last `count` messages of one user. */
export type ChannelPurgeRequestDto =
  | { channelId: Snowflake; mode: 'count'; count: number; reason: string }
  | { channelId: Snowflake; mode: 'user'; userId: Snowflake; count: number; reason: string };
export interface ChannelPurgeResultDto {
  deleted: number;
  /** Messages older than 14 days cannot be bulk-deleted. */
  skippedTooOld: number;
}
export interface ChannelStateDto { channelId: Snowflake; locked: boolean; slowmodeSeconds: number }
/** Creates a text or voice channel, optionally inside a category. Returns the new channel's GuildChannelDto. */
export interface ChannelCreateRequestDto { name: string; type: 'text' | 'voice'; parentId: Snowflake | null; reason: string }

// ---------------------------------------------------------------- tickets (agent B)

export interface TicketPanelDto {
  title: string; text: string;
  /** Unicode emoji or a custom emoji ID; null for none. */
  emoji: string | null;
  buttonLabel: string;
  color: number | null;
}
export interface TicketSettingsDto {
  enabled: boolean;
  /** Where the sticky "Create ticket" panel lives. Must not be a reserved tournament channel. */
  supportChannelId: Snowflake | null;
  /** Category the private ticket channels are created under. */
  categoryId: Snowflake | null;
  staffRoleIds: Snowflake[];
  panel: TicketPanelDto;
  /** Channel name pattern; {name} is the member's username, {n} the ticket number. */
  namingPattern: string;
  /** Fixed at 1 by the decisions; kept explicit for the UI. */
  maxOpenPerUser: 1;
  /** null keeps transcripts until deleted by hand. */
  transcriptRetentionDays: number | null;
}
export const TICKET_STATUSES = ['open', 'closed', 'deleted'] as const;
export type TicketStatus = typeof TICKET_STATUSES[number];
export interface TicketDto {
  id: string;
  guildId: Snowflake;
  number: number;
  openerId: Snowflake;
  name: string;
  /** Null once the channel is deleted. */
  channelId: Snowflake | null;
  status: TicketStatus;
  createdAtMs: number;
  closedAtMs: number | null;
  closedBy: string | null;
  /** Staff may reopen from the dashboard until this time (closedAtMs + 24 h). */
  reopenableUntilMs: number | null;
  messageCount: number;
}
export interface TranscriptAttachmentDto { name: string; url: string; size: number | null }
export interface TranscriptMessageDto {
  seq: number;
  messageId: Snowflake;
  authorId: Snowflake;
  authorName: string;
  authorBot: boolean;
  content: string;
  attachments: TranscriptAttachmentDto[];
  createdAtMs: number;
}
/** GET /api/v1/admin-tools/tickets/:id/transcript */
export interface TranscriptDto { ticket: TicketDto; messages: TranscriptMessageDto[] }
export interface TicketPageDto { tickets: TicketDto[]; nextBefore: number | null }

// ---------------------------------------------------------------- roles and announcements (agent C)

export const BUTTON_ROLE_MODES = ['toggle', 'unique'] as const;
export type ButtonRoleMode = typeof BUTTON_ROLE_MODES[number];
export interface ButtonRoleButtonDto { roleId: Snowflake; label: string; emoji: string | null; style: ButtonStyleName }
export interface ButtonRolePanelDto {
  id: string;
  guildId: Snowflake;
  channelId: Snowflake;
  /** The posted panel; null until published. */
  messageId: Snowflake | null;
  body: MessageBodyDto;
  /** 'toggle': each button adds/removes its role. 'unique': picking one removes the panel's other roles. */
  mode: ButtonRoleMode;
  buttons: ButtonRoleButtonDto[];
  updatedAtMs: number;
}
export interface SaveButtonRolePanelRequestDto {
  channelId: Snowflake; body: MessageBodyDto; mode: ButtonRoleMode; buttons: ButtonRoleButtonDto[];
}

export const BULK_ROLE_TARGET_KINDS = ['checked-in', 'roster', 'event-players', 'ids'] as const;
export type BulkRoleTarget =
  | { kind: 'checked-in' | 'roster' | 'event-players'; eventId: string }
  | { kind: 'ids'; userIds: Snowflake[] };
export const BULK_ROLE_JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type BulkRoleJobStatus = typeof BULK_ROLE_JOB_STATUSES[number];
/** POST /api/v1/admin-tools/bulk-roles */
export interface BulkRoleJobRequestDto { action: 'add' | 'remove'; roleId: Snowflake; target: BulkRoleTarget; reason: string }
export interface BulkRoleJobDto {
  id: string; guildId: Snowflake;
  action: 'add' | 'remove'; roleId: Snowflake; target: BulkRoleTarget; reason: string;
  status: BulkRoleJobStatus;
  total: number; done: number; failed: number;
  error: string | null;
  createdAtMs: number; startedAtMs: number | null; finishedAtMs: number | null;
}

export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'sent', 'failed'] as const;
export type AnnouncementStatus = typeof ANNOUNCEMENT_STATUSES[number];
export interface AnnouncementDto {
  id: string; guildId: Snowflake; channelId: Snowflake;
  body: MessageBodyDto;
  /**
   * Role IDs to ping (never the @everyone role ID). @everyone is pinged only when the announcement opts in
   * with the separate `mentionEveryone` switch (an extra wire field of the save request); text typed as
   * "@everyone" never pings on its own.
   */
  mentionRoleIds: Snowflake[];
  /** Null sends immediately; scheduled sends need the PC on (catch-up on restart if within the grace window). */
  scheduledAtMs: number | null;
  status: AnnouncementStatus;
  messageId: Snowflake | null;
  sentAtMs: number | null;
  error: string | null;
  createdAtMs: number; updatedAtMs: number;
}
export interface SaveAnnouncementRequestDto {
  channelId: Snowflake; body: MessageBodyDto; mentionRoleIds: Snowflake[]; scheduledAtMs: number | null;
}

// ---------------------------------------------------------------- logging, welcome, auto-role (agent D)

export interface JoinLeaveLogSettingsDto {
  enabled: boolean;
  channelId: Snowflake | null;
  /** Accounts younger than this many days are flagged on join. */
  newAccountDays: number;
  /** Also log role and nickname changes (#15). */
  memberUpdates: boolean;
}
export interface WelcomeSettingsDto {
  enabled: boolean;
  channelId: Snowflake | null;
  /** Placeholders: {user} (mention), {server}, {memberCount}. */
  message: string;
  /** Optional leave message with the same placeholders; null for none. */
  leaveMessage: string | null;
}
export interface AutoRoleSettingsDto {
  enabled: boolean; roleIds: Snowflake[];
  /** Skip bot accounts; absent means true (only human members get the auto-roles). */
  skipBots?: boolean;
}
export interface MessageLogSettingsDto {
  enabled: boolean;
  /** Also post edit/delete entries to this Discord channel; null logs to the dashboard only. */
  channelId: Snowflake | null;
  retentionDays: number;
  ignoredChannelIds: Snowflake[];
}
export interface LoggingSettingsDto {
  joinLeave: JoinLeaveLogSettingsDto;
  welcome: WelcomeSettingsDto;
  autoRole: AutoRoleSettingsDto;
  messageLog: MessageLogSettingsDto;
}

export const MEMBER_LOG_KINDS = ['join', 'leave', 'role', 'nick'] as const;
export type MemberLogKind = typeof MEMBER_LOG_KINDS[number];
export const MESSAGE_LOG_KINDS = ['edit', 'delete'] as const;
export type MessageLogKind = typeof MESSAGE_LOG_KINDS[number];
interface LogEntryBase { id: number; guildId: Snowflake; userId: Snowflake | null; occurredAtMs: number }
export type LogEntryDto =
  | LogEntryBase & { stream: 'member'; kind: MemberLogKind;
      detail: { newAccount?: boolean; accountCreatedAtMs?: number; addedRoleIds?: Snowflake[];
        removedRoleIds?: Snowflake[]; before?: string | null; after?: string | null } }
  | LogEntryBase & { stream: 'message'; kind: MessageLogKind; channelId: Snowflake; messageId: Snowflake;
      before: string | null; after: string | null; attachmentCount: number };
/** GET /api/v1/admin-tools/logs?stream=member|message&after=&limit=&userId= — oldest first after the cursor. */
export interface LogPageDto { entries: LogEntryDto[]; nextAfter: number }

// ---------------------------------------------------------------- settings document

export interface CaseSettingsDto {
  /** DM the member the reason when warned, timed out, kicked or banned (best effort). */
  dmMembers: boolean;
  /** Post each new case to this channel; null for none. */
  logChannelId: Snowflake | null;
  /**
   * Tournament staff roles (next wave): members with one of these roles may run the staff commands
   * (/tcg-staff and the /tcg-admin moderation subcommands). Absent on documents saved before it existed (= none).
   */
  staffRoleIds?: Snowflake[];
}

/** One versioned document per guild (tcg_admin_tools_settings). Stickies, panels and jobs have their own tables. */
export interface AdminToolsSettingsBodyDto {
  cases: CaseSettingsDto;
  tickets: TicketSettingsDto;
  logging: LoggingSettingsDto;
}
export type AdminToolsSettingsSection = keyof AdminToolsSettingsBodyDto;
export const ADMIN_TOOLS_SETTINGS_SECTIONS = ['cases', 'tickets', 'logging'] as const satisfies readonly AdminToolsSettingsSection[];

/** GET /api/v1/admin-tools/settings */
export interface AdminToolsSettingsDto extends AdminToolsSettingsBodyDto {
  guildId: Snowflake;
  /** Optimistic concurrency: 0 until the first save. */
  version: number;
  updatedAtMs: number | null;
}
/** PUT /api/v1/admin-tools/settings. A stale expectedVersion answers 409 with AdminToolsSettingsConflictDto. */
export interface SaveAdminToolsSettingsRequestDto { expectedVersion: number; settings: AdminToolsSettingsBodyDto }
export interface AdminToolsSettingsConflictDto {
  error: { code: 'conflict'; message: string };
  current: AdminToolsSettingsDto;
}

// ---------------------------------------------------------------- privileged intents and status

export const PRIVILEGED_INTENT_NAMES = ['guildMembers', 'messageContent'] as const;
export type PrivilegedIntentName = typeof PRIVILEGED_INTENT_NAMES[number];
/** 'off': not requested. 'on': requested and granted. 'missing': requested, Discord refused (Disallowed intents). */
export type PrivilegedIntentState = 'off' | 'on' | 'missing';
export const PRIVILEGED_INTENT_PORTAL_LABELS: Readonly<Record<PrivilegedIntentName, string>> = {
  guildMembers: 'Server Members Intent',
  messageContent: 'Message Content Intent'
};

/**
 * Decisions: GuildMembers only while join/leave, welcome or auto-role is enabled; MessageContent only
 * while the message log is enabled.
 */
export function privilegedIntentsForSettings(settings: Pick<AdminToolsSettingsBodyDto, 'logging'>): Record<PrivilegedIntentName, boolean> {
  const { joinLeave, welcome, autoRole, messageLog } = settings.logging;
  return { guildMembers: joinLeave.enabled || welcome.enabled || autoRole.enabled, messageContent: messageLog.enabled };
}

export type AdminToolsFeatureState = 'running' | 'intent-missing' | 'failed' | 'stopped';
export interface AdminToolsFeatureStatusDto { name: string; state: AdminToolsFeatureState; missingIntents: PrivilegedIntentName[] }

/** GET /api/v1/admin-tools/status */
export interface AdminToolsStatusDto {
  /** 'demo' has no gateway; 'offline' before login or after shutdown. */
  runtime: 'running' | 'offline' | 'demo';
  privilegedIntents: Record<PrivilegedIntentName, PrivilegedIntentState>;
  /** What the saved settings ask for (may differ from what the running gateway requested). */
  wantedIntents: Record<PrivilegedIntentName, boolean>;
  /** Settings changed the intent set, or a missing intent was enabled since: restart the bot to apply. */
  restartRequired: boolean;
  restartReason: string | null;
  features: AdminToolsFeatureStatusDto[];
}

// ---------------------------------------------------------------- audit kinds (tcg_ops_audit)

/** Every admin-tools mutation appends one of these to tcg_ops_audit (kind ~ ^[a-z][a-z_.]{2,63}$). */
export const ADMIN_TOOLS_AUDIT_KINDS = ['admin_tools.settings', 'admin_tools.intents_missing',
  'member.warn', 'member.timeout', 'member.untimeout', 'member.kick', 'member.ban', 'member.unban', 'member.tempban_expired',
  'member.note.added', 'member.note.updated', 'member.note.deleted', 'member.case.updated',
  'sticky.saved', 'sticky.deleted', 'channel.lock', 'channel.unlock', 'channel.slowmode', 'channel.purge', 'channel.create',
  'ticket.opened', 'ticket.closed', 'ticket.reopened', 'ticket.deleted', 'ticket.settings',
  'button_roles.saved', 'button_roles.published', 'button_roles.deleted',
  'bulk_roles.queued', 'bulk_roles.finished', 'bulk_roles.cancelled',
  'announcement.saved', 'announcement.sent', 'announcement.failed', 'announcement.deleted',
  'logging.retention', 'welcome.failed', 'auto_role.failed'] as const;
export type AdminToolsAuditKind = typeof ADMIN_TOOLS_AUDIT_KINDS[number];

// ---------------------------------------------------------------- limits and defaults

export const ADMIN_TOOLS_LIMITS = {
  reasonLength: 500,
  /** Discord's audit-log reason header limit. */
  discordReasonLength: 512,
  noteLength: 2000,
  memberSearchLimit: 25,
  memberSearchQueryLength: 100,
  /** Discord timeouts end at 28 days; longer ones are re-applied by the bot. */
  timeoutMsMin: 60_000,
  timeoutMsMax: 365 * 86_400_000,
  discordTimeoutMsMax: 28 * 86_400_000,
  tempbanMsMin: 60_000,
  tempbanMsMax: 365 * 86_400_000,
  deleteMessageSecondsMax: 604_800,
  evidencePerCase: 10,
  stickies: 25,
  stickyDebounceMsMin: 5_000,
  stickyDebounceMsMax: 600_000,
  messageContentLength: 2000,
  embedTitleLength: 256,
  embedDescriptionLength: 4096,
  embedFields: 25,
  embedFieldNameLength: 256,
  embedFieldValueLength: 1024,
  embedFooterLength: 2048,
  urlLength: 2048,
  slowmodeSecondsMax: 21_600,
  purgeCountMax: 100,
  /** Discord's channel name limit. */
  channelNameLength: 100,
  /** Discord bulk delete only accepts messages younger than 14 days. */
  bulkDeleteMaxAgeMs: 14 * 86_400_000,
  ticketStaffRoles: 10,
  ticketPanelTitleLength: 100,
  ticketPanelTextLength: 1000,
  ticketButtonLabelLength: 80,
  ticketNamingPatternLength: 60,
  ticketReopenWindowMs: 24 * 3_600_000,
  transcriptMessages: 5000,
  retentionDaysMin: 1,
  retentionDaysMax: 365,
  buttonRolePanels: 25,
  buttonsPerPanel: 25,
  buttonLabelLength: 80,
  bulkRoleTargets: 5000,
  announcementMentionRoles: 10,
  newAccountDaysMin: 0,
  newAccountDaysMax: 365,
  welcomeMessageLength: 1000,
  autoRoles: 10,
  ignoredChannels: 50,
  logPageLimit: 500
} as const;

export const DEFAULT_TICKET_PANEL: Readonly<TicketPanelDto> = Object.freeze({
  title: 'Need help?', text: 'Press the button below to open a private ticket with the staff.',
  emoji: null, buttonLabel: 'Create ticket', color: null
});

export const DEFAULT_ADMIN_TOOLS_SETTINGS: Readonly<AdminToolsSettingsBodyDto> = Object.freeze<AdminToolsSettingsBodyDto>({
  cases: { dmMembers: true, logChannelId: null },
  tickets: {
    enabled: false, supportChannelId: null, categoryId: null, staffRoleIds: [],
    panel: { ...DEFAULT_TICKET_PANEL }, namingPattern: 'ticket-{name}-{n}', maxOpenPerUser: 1, transcriptRetentionDays: 90
  },
  logging: {
    joinLeave: { enabled: false, channelId: null, newAccountDays: 7, memberUpdates: false },
    welcome: { enabled: false, channelId: null, message: 'Welcome to {server}, {user}! You are member #{memberCount}.', leaveMessage: null },
    autoRole: { enabled: false, roleIds: [] },
    messageLog: { enabled: false, channelId: null, retentionDays: 30, ignoredChannelIds: [] }
  }
});

/** Fills the welcome placeholders. Unknown placeholders are left as typed. */
export function renderWelcomeMessage(template: string, values: { user: string; server: string; memberCount: number | null }): string {
  return template.replaceAll('{user}', values.user).replaceAll('{server}', values.server)
    .replaceAll('{memberCount}', values.memberCount === null ? '?' : String(values.memberCount));
}
