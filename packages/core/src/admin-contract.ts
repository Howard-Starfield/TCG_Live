// Admin API contract v1, shared by apps/server and apps/web.
// Changes during a wave go through the contract-change procedure in docs/ADMIN_DASHBOARD_PLAN.md.

export const ADMIN_API_VERSION = 1 as const;

export type Snowflake = string;               // Discord IDs never become numbers
export const SEATS = ['A', 'B', 'C', 'D'] as const;
export type Seat = typeof SEATS[number];
export const MATCH_IDS = ['M1', 'M2'] as const;
export type MatchId = typeof MATCH_IDS[number];
export type CardSlot = 'checkin' | MatchId;
export type MatchPhase = 'setup' | 'running' | 'paused' | 'expired' | 'final';

export const CAPABILITIES = ['dashboard.read', 'event.publish', 'signup.manage',
  'match.judge', 'match.correct', 'panels.refresh'] as const;
export type Capability = typeof CAPABILITIES[number];

export interface PrincipalDto { kind: 'local'; id: 'local-admin'; label: string }
export interface SessionDto {
  principal: PrincipalDto; capabilities: Capability[];
  expiresAtMs: number; idleExpiresAtMs: number;
  mode: 'discord' | 'demo'; commandsEnabled: boolean;
}
export interface SessionGrantDto { token: string; session: SessionDto }   // bearer token; kept in sessionStorage

export interface RuntimeStatusDto {
  mode: 'discord' | 'demo'; bootId: string; buildId: string;
  serverTimeMs: number; startedAtMs: number;
  gateway: 'ready' | 'connecting' | 'reconnecting' | 'offline' | 'not_applicable';
  database: 'ready' | 'unavailable' | 'not_configured';
  lease: 'held' | 'lost' | 'not_applicable';
  cards: { updatePending: boolean };
  rooms: { enabled: boolean; warning: string | null };
  commandsEnabled: boolean;
}

export interface EventSummaryDto {            // session-backed events only; CLI rehearsal events are not listed
  eventId: string; status: 'active' | 'retired'; kind: 'legacy' | 'signup';
  createdAtMs: number; retiredAtMs: number | null; version: number;
}

export interface MemberDto { id: Snowflake; displayName: string | null; avatarUrl: string | null }

export type JudgeReason = 'dispute' | 'called' | 'expired';
export type MatchAdminAction = 'resolve' | 'correct' | 'judgeResume';
export type EventAdminAction = 'publish' | 'signupClose' | 'signupReopen' | 'signupRemove';

export interface ClockDto {
  durationMs: number; remainingMs: number; runningSinceMs: number | null;
  state: 'running' | 'frozen' | 'interrupted';  // interrupted: persisted running clock owned by another process
}

export interface MatchJudgeDto { reasons: JudgeReason[]; sinceMs: number; raisedBy: Seat[] }

export interface ProposalDto { revision: number; winner: Seat; reporter: Seat; decision: 'open' | 'disputed' }

export interface MatchDto {
  id: MatchId; seats: [Seat, Seat]; mode: 'CAM'; phase: MatchPhase;
  ready: Seat[]; clock: ClockDto;
  pauseGeneration: number; resumeConsents: Seat[];
  judge: MatchJudgeDto | null;                 // null exactly when judgeAttention is false
  proposal: ProposalDto | null;
  finalWinner: Seat | null;
  finalSource: null | 'agreed' | 'admin';      // confirmedBy present -> agreed
  confirmedBy: Seat | null;
  adminActions: MatchAdminAction[];            // computed from the domain rules
}

export interface StandingDto { seat: Seat; points: number; rating: number }

export type EventStage = 'signup' | 'checkin' | 'live' | 'complete';

export interface DiscordCardDto { messageId: Snowflake | null; repostSuspended: boolean }

export interface EventSnapshotDto {
  eventId: string; version: number; panelRevision: number;
  status: 'active' | 'retired'; kind: 'legacy' | 'signup';
  createdAtMs: number; retiredAtMs: number | null;
  game: string; durationMs: number; points: { win: number; loss: number };
  stage: EventStage;
  signup: null | { status: 'open' | 'assigned'; capacity: 4; roster: Snowflake[] };
  seats: Record<Seat, Snowflake | null>;
  adminId: Snowflake;
  members: Record<Snowflake, MemberDto>;       // roster, seats, admin, and members named in the audit
  checkins: Seat[]; published: boolean;
  matches: MatchDto[];
  standings: StandingDto[];
  adminActions: EventAdminAction[];
  discord: {
    guildId: Snowflake; channelId: Snowflake;
    matchChannels: Record<MatchId, Snowflake> | null; publicMatchRooms: boolean;
    cards: Record<CardSlot, DiscordCardDto>;
  };
}

export type ActorDto =
  | { kind: 'player'; seat: Seat }
  | { kind: 'member'; memberId: Snowflake }
  | { kind: 'admin' }
  | { kind: 'system'; source: 'timer' };      // mapped from principal_kind = 'system'

export interface CommandDto {                  // sanitized copy of the stored domain command
  type: string; matchId?: MatchId; winner?: Seat; reason?: string; memberId?: Snowflake;
  revision?: number; expectedRevision?: number; pauseGeneration?: number;
}

export type AuditVia = 'discord' | 'web' | 'system' | 'cli';

export interface AuditEntryDto {              // applied commands only
  sequence: number; commandId: string; occurredAtMs: number; actor: ActorDto;
  via: AuditVia;                              // principal_kind; null -> 'cli'
  principalId: string | null;
  command: CommandDto; result: string; mode: 'CAM' | null;
}

export type StreamEventDto =
  | { type: 'hello'; apiVersion: typeof ADMIN_API_VERSION; buildId: string; bootId: string;
      status: RuntimeStatusDto; activeEventId: string | null }
  | { type: 'change'; eventId: string; version: number; panelRevision: number;
      snapshot: EventSnapshotDto; audit: AuditEntryDto[] }
  | { type: 'status'; status: RuntimeStatusDto }
  | { type: 'heartbeat'; serverTimeMs: number };

export type StreamEventType = StreamEventDto['type'];

/** Stream event IDs are `<bootId>.<eventId>.<version>.<panelRevision>`. */
export interface StreamCursor { bootId: string; eventId: string; version: number; panelRevision: number }

export function formatStreamId(cursor: StreamCursor): string {
  return `${cursor.bootId}.${cursor.eventId}.${cursor.version}.${cursor.panelRevision}`;
}

export function parseStreamId(raw: string | null | undefined): StreamCursor | null {
  if (!raw) return null;
  const match = /^([A-Za-z0-9-]{1,64})\.([A-Za-z0-9-]{1,64})\.(\d{1,9})\.(\d{1,9})$/.exec(raw.trim());
  if (!match) return null;
  return { bootId: match[1]!, eventId: match[2]!, version: Number(match[3]), panelRevision: Number(match[4]) };
}

// Wave 3
export type AdminCommandDto =
  | { type: 'publish' }
  | { type: 'signupClose' }
  | { type: 'signupReopen' }
  | { type: 'signupRemove'; memberId: Snowflake }
  | { type: 'judgeResume'; matchId: MatchId; reason: string }
  | { type: 'resolve'; matchId: MatchId; winner: Seat; reason: string }
  | { type: 'correct'; matchId: MatchId; winner: Seat; reason: string };

export interface CommandPreconditionDto {
  eventVersion?: number;                                     // publish
  match?: { matchId: MatchId; phase: MatchPhase; proposalRevision: number | null;
            finalWinner: Seat | null; pauseGeneration: number };  // judgeResume, resolve, correct
  signup?: { status: 'open' | 'assigned'; rosterSize: number };   // signup commands
}

export interface AdminCommandRequestDto {
  commandId: string;                                         // UUID v4 from the browser
  eventId: string; command: AdminCommandDto; precondition: CommandPreconditionDto;
}
export interface AdminCommandResultDto {
  applied: boolean; result: string; version: number;
  cards: 'updated' | 'pending'; roomWarning: string | null;
}
export interface PanelRefreshResultDto { cards: 'refreshed' | 'pending'; roomWarning: string | null }

export const COMMAND_CAPABILITY: Record<AdminCommandDto['type'], Capability> = {
  publish: 'event.publish', signupClose: 'signup.manage', signupReopen: 'signup.manage',
  signupRemove: 'signup.manage', judgeResume: 'match.judge', resolve: 'match.judge',
  correct: 'match.correct'
};

export type ErrorCode = 'unauthenticated' | 'forbidden' | 'bad_host' | 'bad_origin'
  | 'bad_request' | 'not_found' | 'method_not_allowed' | 'conflict' | 'rule'
  | 'unavailable' | 'too_many_requests';
export interface ErrorDto { error: { code: ErrorCode; message: string }; snapshot?: EventSnapshotDto }

export const API_PREFIX = '/api/v1' as const;
export const AUDIT_PAGE_LIMIT = 500;
export const STREAM_RESUME_AUDIT_LIMIT = 200;
