// Pure mappers from the persisted rehearsal model to the admin contract (docs/ADMIN_DASHBOARD_PLAN.md, Appendix A).
import type {
  ActorDto, AuditEntryDto, AuditVia, CardSlot, ClockDto, CommandDto, EventAdminAction, EventSnapshotDto, EventStage,
  EventSummaryDto, JudgeReason, MatchAdminAction, MatchDto, MatchId, MatchJudgeDto, MemberDto, Seat, Snowflake
} from '@tcg-live/core';
import { deriveFixture, PLAYERS, type EventState, type MatchState } from '../../rehearsal/domain.js';
import type { Outcome } from '../../rehearsal/domain.js';
import type { SessionIdentity } from '../../discord/session.js';

const SNOWFLAKE = /^[1-9]\d{14,21}$/;
const SLOTS: CardSlot[] = ['checkin', 'M1', 'M2'];

/** An audit row as read by admin queries: store.ts columns plus the principal columns of migration 002. */
export interface AdminAuditRow {
  sequence: number | string;
  command_id: string;
  actor_id: string;
  action: unknown;
  outcome: Outcome | { result?: unknown } | null;
  occurred_at_ms: number | string;     // bigint; cast to float8 in SQL and again here
  mode: string | null;
  principal_kind: string | null;
  principal_id: string | null;
}

/** A session row with its timestamps (bigint columns, cast to numbers). */
export interface AdminSessionRow {
  event_id: string;
  application_id: string;
  guild_id: string;
  channel_id: string;
  identity_map: SessionIdentity;
  status: 'active' | 'retired';
  checkin_message_id: string | null;
  m1_message_id: string | null;
  m2_message_id: string | null;
  created_at_ms: number | string;
  retired_at_ms: number | string | null;
}

function num(value: number | string | null | undefined): number {
  const result = typeof value === 'string' ? Number(value) : value ?? Number.NaN;
  if (!Number.isFinite(result)) throw new Error('Invalid numeric column.');
  return result;
}

function isSeat(value: unknown): value is Seat {
  return typeof value === 'string' && (PLAYERS as readonly string[]).includes(value);
}

function isMatchId(value: unknown): value is MatchId {
  return value === 'M1' || value === 'M2';
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Sanitized copy of a stored domain command: known keys only, typed values only (signupClose drops adminId). */
export function sanitizeCommand(raw: unknown): CommandDto {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const command: CommandDto = { type: typeof source.type === 'string' ? source.type.slice(0, 64) : 'unknown' };
  if (isMatchId(source.matchId)) command.matchId = source.matchId;
  if (isSeat(source.winner)) command.winner = source.winner;
  if (typeof source.reason === 'string') command.reason = source.reason.slice(0, 500);
  if (typeof source.memberId === 'string' && SNOWFLAKE.test(source.memberId)) command.memberId = source.memberId;
  if (isInt(source.revision)) command.revision = source.revision;
  if (isInt(source.expectedRevision)) command.expectedRevision = source.expectedRevision;
  if (isInt(source.pauseGeneration)) command.pauseGeneration = source.pauseGeneration;
  return command;
}

export function mapActor(actorId: string, principalKind: string | null): ActorDto {
  // Timer rows carry the admin actor (store.ts:276) but principal_kind 'system' (store.ts:316).
  if (principalKind === 'system') return { kind: 'system', source: 'timer' };
  const player = /^player:([ABCD])$/.exec(actorId)?.[1];
  if (isSeat(player)) return { kind: 'player', seat: player };
  const member = /^member:([1-9]\d{14,21})$/.exec(actorId)?.[1];
  if (member) return { kind: 'member', memberId: member };
  // The domain applies only player, member and admin actors (domain.ts:98-105, 152).
  return { kind: 'admin' };
}

export function mapVia(principalKind: string | null): AuditVia {
  return principalKind === 'discord' || principalKind === 'web' || principalKind === 'system' ? principalKind : 'cli';
}

export function mapAuditRow(row: AdminAuditRow): AuditEntryDto {
  const result = row.outcome && typeof row.outcome === 'object' && typeof row.outcome.result === 'string'
    ? row.outcome.result : '';
  return {
    sequence: num(row.sequence),
    commandId: row.command_id,
    occurredAtMs: num(row.occurred_at_ms),
    actor: mapActor(row.actor_id, row.principal_kind),
    via: mapVia(row.principal_kind),
    principalId: row.principal_id ?? null,
    command: sanitizeCommand(row.action),
    result,
    mode: row.mode === 'CAM' ? 'CAM' : null
  };
}

export function eventKind(identity: Pick<SessionIdentity, 'kind'> | null, state: Pick<EventState, 'schemaVersion'>): 'legacy' | 'signup' {
  if (identity?.kind === 'signup' || identity?.kind === 'legacy') return identity.kind;
  return state.schemaVersion === 2 ? 'signup' : 'legacy';
}

export function deriveStage(state: EventState): EventStage {
  if (state.signup?.status === 'open') return 'signup';
  if (!state.published) return 'checkin';
  return state.matches.every(match => match.phase === 'final') ? 'complete' : 'live';
}

/** A persisted running clock owned by another process; every command is refused until prepare --replace (store.ts:273). */
export function isInterrupted(match: MatchState, runnerId: string): boolean {
  return match.phase === 'running' && match.runnerId !== runnerId;
}

export function mapClock(match: MatchState, durationMs: number, runnerId: string, retired: boolean): ClockDto {
  const persistedRunning = match.phase === 'running';
  const state = retired || !persistedRunning ? 'frozen' : match.runnerId === runnerId ? 'running' : 'interrupted';
  return {
    durationMs, remainingMs: match.remainingMs,
    // An interrupted clock keeps its persisted start for display; remainingMsAt() ignores it.
    runningSinceMs: state === 'frozen' ? null : match.startedAtMs,
    state
  };
}

const CLEARS_ATTENTION = new Set(['confirm', 'resolve', 'correct']);

/**
 * Judge details from the match's audit since attention was last cleared by confirm, resolve or correct.
 * Null exactly when judgeAttention is false. A new proposal after a dispute does not clear attention
 * (domain.ts:259-268), so the dispute stays the reason until a judge decides.
 */
export function deriveJudge(match: MatchState, audit: readonly AuditEntryDto[], fallbackMs: number): MatchJudgeDto | null {
  if (!match.judgeAttention) return null;
  const entries = audit.filter(entry => entry.command.matchId === match.id)
    .sort((left, right) => left.sequence - right.sequence);
  let start = 0;
  entries.forEach((entry, index) => { if (CLEARS_ATTENTION.has(entry.command.type)) start = index + 1; });
  const since = entries.slice(start);
  const reasons = new Set<JudgeReason>();
  const raisedBy: Seat[] = [];
  let sinceMs: number | null = null;
  for (const entry of since) {
    let reason: JudgeReason | null = null;
    if (entry.command.type === 'dispute') reason = 'dispute';
    else if (entry.command.type === 'callJudge') reason = 'called';
    else if (entry.actor.kind === 'system' && entry.command.type === 'clockCheck') reason = 'expired';
    if (!reason) continue;
    reasons.add(reason);
    sinceMs ??= entry.occurredAtMs;
    if (entry.actor.kind === 'player' && reason !== 'expired' && !raisedBy.includes(entry.actor.seat)) raisedBy.push(entry.actor.seat);
  }
  // Any command on a running match can materialize an expiry (domain.ts:117-131); the phase records it.
  if (match.phase === 'expired') reasons.add('expired');
  sinceMs ??= since[0]?.occurredAtMs ?? entries.at(-1)?.occurredAtMs ?? fallbackMs;
  const order: JudgeReason[] = ['dispute', 'called', 'expired'];
  return { reasons: order.filter(reason => reasons.has(reason)), sinceMs, raisedBy };
}

/** Admin actions the domain rules would accept now (domain.ts:247-316). */
export function matchAdminActions(match: MatchState, blocked: boolean): MatchAdminAction[] {
  if (blocked) return [];
  const actions: MatchAdminAction[] = [];
  if (match.phase !== 'setup' && match.phase !== 'final') actions.push('resolve');
  if (match.phase === 'final') actions.push('correct');
  if (match.phase === 'paused') actions.push('judgeResume');
  return actions;
}

/** Event-level admin actions by their guards (domain.ts:163-201). */
export function eventAdminActions(state: EventState, adminId: string, blocked: boolean): EventAdminAction[] {
  if (blocked) return [];
  const actions: EventAdminAction[] = [];
  const signup = state.signup;
  if ((!signup || signup.status === 'assigned') && !state.published && state.checkins.length === 4) actions.push('publish');
  if (signup?.status === 'open' && signup.roster.length === 4 && new Set(signup.roster).size === 4 &&
      !signup.roster.includes(adminId)) actions.push('signupClose');
  if (signup?.status === 'assigned' && !state.published && state.matches.every(match => match.phase === 'setup'))
    actions.push('signupReopen');
  if (signup?.status === 'open' && signup.roster.length > 0) actions.push('signupRemove');
  return actions;
}

export function seatsFor(state: EventState, identity: SessionIdentity): Record<Seat, Snowflake | null> {
  const players = identity.kind === 'signup' || state.signup
    ? state.signup?.status === 'assigned' ? state.signup.assignment ?? null : null
    : identity.players ?? null;
  return { A: players?.A ?? null, B: players?.B ?? null, C: players?.C ?? null, D: players?.D ?? null };
}

/** Members the snapshot names: admin, roster, seats, and members named in the audit. */
export function memberIdsFor(state: EventState, identity: SessionIdentity, audit: readonly AuditEntryDto[]): Snowflake[] {
  const ids = new Set<string>([identity.adminId]);
  for (const id of state.signup?.roster ?? []) ids.add(id);
  for (const id of Object.values(seatsFor(state, identity))) if (id) ids.add(id);
  for (const entry of audit) {
    if (entry.actor.kind === 'member') ids.add(entry.actor.memberId);
    if (entry.command.memberId) ids.add(entry.command.memberId);
    if (entry.via === 'discord' && entry.principalId) ids.add(entry.principalId);
  }
  return [...ids].filter(id => SNOWFLAKE.test(id));
}

export interface SnapshotInput {
  state: EventState;
  session: AdminSessionRow;
  /** Every applied audit entry of the event, mapped. */
  audit: readonly AuditEntryDto[];
  /** This process's runner; decides running versus interrupted clocks. */
  runnerId: string;
  panelRevision: number;
  /** Known identities; unknown members map to a null display name. */
  members: (id: Snowflake) => MemberDto | undefined;
}

export function mapMatch(match: MatchState, input: SnapshotInput, blocked: boolean): MatchDto {
  const retired = input.session.status === 'retired';
  return {
    id: match.id, seats: [match.players[0], match.players[1]], mode: match.mode, phase: match.phase,
    ready: [...match.ready],
    clock: mapClock(match, input.state.durationMs, input.runnerId, retired),
    pauseGeneration: match.pauseGeneration, resumeConsents: [...match.resumeConsents],
    judge: deriveJudge(match, input.audit, num(input.session.created_at_ms)),
    proposal: match.proposal ? { ...match.proposal } : null,
    finalWinner: match.finalWinner,
    finalSource: match.phase !== 'final' || !match.finalWinner ? null : match.confirmedBy ? 'agreed' : 'admin',
    confirmedBy: match.confirmedBy ?? null,
    adminActions: matchAdminActions(match, blocked)
  };
}

export function mapSnapshot(input: SnapshotInput): EventSnapshotDto {
  const { state, session } = input;
  const identity = session.identity_map;
  const retired = session.status === 'retired';
  const blocked = retired || state.matches.some(match => isInterrupted(match, input.runnerId));
  const members: Record<Snowflake, MemberDto> = {};
  for (const id of memberIdsFor(state, identity, input.audit))
    members[id] = input.members(id) ?? { id, displayName: null, avatarUrl: null };
  const suspended = identity.stickySuspended ?? [];
  const messageIds: Record<CardSlot, string | null> = {
    checkin: session.checkin_message_id, M1: session.m1_message_id, M2: session.m2_message_id
  };
  const cards = Object.fromEntries(SLOTS.map(slot =>
    [slot, { messageId: messageIds[slot], repostSuspended: suspended.includes(slot) }])) as EventSnapshotDto['discord']['cards'];
  return {
    eventId: state.id, version: state.version, panelRevision: retired ? 0 : input.panelRevision,
    status: session.status, kind: eventKind(identity, state),
    createdAtMs: num(session.created_at_ms),
    retiredAtMs: session.retired_at_ms === null ? null : num(session.retired_at_ms),
    game: state.game, durationMs: state.durationMs, points: { ...state.points },
    stage: deriveStage(state),
    signup: state.signup ? { status: state.signup.status, capacity: 4, roster: [...state.signup.roster] } : null,
    seats: seatsFor(state, identity),
    adminId: identity.adminId,
    members,
    checkins: [...state.checkins], published: state.published,
    matches: state.matches.map(match => mapMatch(match, input, blocked)),
    standings: deriveFixture(state).map(row => ({ seat: row.player, points: row.points, rating: row.rating })),
    adminActions: eventAdminActions(state, identity.adminId, blocked),
    discord: {
      guildId: session.guild_id, channelId: session.channel_id,
      matchChannels: identity.matchChannels ? { ...identity.matchChannels } : null,
      publicMatchRooms: !!identity.publicMatchRooms,
      cards
    }
  };
}

export interface SummaryRow {
  event_id: string;
  status: 'active' | 'retired';
  kind: string | null;
  schema_version: number | string | null;
  created_at_ms: number | string;
  retired_at_ms: number | string | null;
  version: number | string;
}

export function mapSummary(row: SummaryRow): EventSummaryDto {
  const kind = row.kind === 'signup' || row.kind === 'legacy' ? row.kind : num(row.schema_version ?? 1) === 2 ? 'signup' : 'legacy';
  return {
    eventId: row.event_id, status: row.status, kind,
    createdAtMs: num(row.created_at_ms),
    retiredAtMs: row.retired_at_ms === null ? null : num(row.retired_at_ms),
    version: num(row.version)
  };
}

