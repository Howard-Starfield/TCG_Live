// Pure command rules for the console (L10): who may act, on what, with which precondition, and how
// results and errors read. No React here; the hook and components build on these.
import { ADMIN_REASON_MAX_LENGTH, COMMAND_CAPABILITY, type AdminCommandDto, type AdminCommandResultDto,
  type CommandPreconditionDto, type EventAdminAction, type EventSnapshotDto, type MatchAdminAction, type MatchDto,
  type MatchId, type PanelRefreshResultDto, type SessionDto, type Snowflake } from '@tcg-live/core';
import { memberName, type ApiError } from '../../data';
import { seatWithName } from '../shell/labels';

export type CommandType = AdminCommandDto['type'];
type Gate = Pick<SessionDto, 'commandsEnabled' | 'capabilities'> | null | undefined;

// ---------------------------------------------------------------- gating (decision 4)

/** The server lets this session act at all (`TCG_ADMIN_COMMANDS=1`, or the demo). */
export function commandsEnabled(session: Gate): boolean {
  return !!session?.commandsEnabled;
}

/** The session holds the capability the command needs. */
export function canRun(session: Gate, type: CommandType): boolean {
  return commandsEnabled(session) && session!.capabilities.includes(COMMAND_CAPABILITY[type]);
}

export function canRefreshPanels(session: Gate): boolean {
  return commandsEnabled(session) && session!.capabilities.includes('panels.refresh');
}

/** Any action at all is possible for this session (decides whether the composer exists). */
export function canRunAny(session: Gate): boolean {
  return canRefreshPanels(session) || (Object.keys(COMMAND_CAPABILITY) as CommandType[]).some(type => canRun(session, type));
}

/** Only the active event takes commands; retired events are read-only history. */
export function isWritable(snapshot: Pick<EventSnapshotDto, 'status'>): boolean {
  return snapshot.status === 'active';
}

/** Event actions the session may run now: allowed by the domain (`adminActions`) and the capabilities. */
export function availableEventActions(session: Gate, snapshot: EventSnapshotDto): EventAdminAction[] {
  if (!isWritable(snapshot)) return [];
  return snapshot.adminActions.filter(action => canRun(session, action));
}

/** Match actions the session may run now, in display order. */
export function availableMatchActions(session: Gate, snapshot: EventSnapshotDto, match: MatchDto): MatchAdminAction[] {
  if (!isWritable(snapshot)) return [];
  return MATCH_ACTION_ORDER.filter(action => match.adminActions.includes(action) && canRun(session, action));
}

const MATCH_ACTION_ORDER: MatchAdminAction[] = ['resolve', 'judgeResume', 'correct'];

/** The member can be removed from the open signup now. */
export function canRemoveMember(session: Gate, snapshot: EventSnapshotDto, memberId: Snowflake | null): boolean {
  return !!memberId && availableEventActions(session, snapshot).includes('signupRemove')
    && !!snapshot.signup?.roster.includes(memberId);
}

// ---------------------------------------------------------------- requests

/** What the admin saw when deciding; the server refuses with 409 when it no longer holds. */
export function preconditionFor(snapshot: EventSnapshotDto, command: AdminCommandDto): CommandPreconditionDto {
  switch (command.type) {
    case 'publish':
      return { eventVersion: snapshot.version };
    case 'signupClose':
    case 'signupReopen':
    case 'signupRemove': {
      const signup = signupPrecondition(snapshot);
      return signup ? { signup } : {};
    }
    case 'judgeResume':
    case 'resolve':
    case 'correct': {
      const match = matchPrecondition(snapshot, command.matchId);
      return match ? { match } : {};
    }
  }
}

export function matchPrecondition(snapshot: EventSnapshotDto, matchId: MatchId): CommandPreconditionDto['match'] | null {
  const match = snapshot.matches.find(item => item.id === matchId);
  if (!match) return null;
  return { matchId: match.id, phase: match.phase, proposalRevision: match.proposal?.revision ?? null,
    finalWinner: match.finalWinner, pauseGeneration: match.pauseGeneration };
}

export function signupPrecondition(snapshot: EventSnapshotDto): CommandPreconditionDto['signup'] | null {
  return snapshot.signup ? { status: snapshot.signup.status, rosterSize: snapshot.signup.roster.length } : null;
}

/** The match moved on a field the precondition carries (what a dialog opened on is no longer true). */
export function matchChangedSince(seen: EventSnapshotDto, live: EventSnapshotDto, matchId: MatchId): boolean {
  return seen.eventId !== live.eventId
    || JSON.stringify(matchPrecondition(seen, matchId)) !== JSON.stringify(matchPrecondition(live, matchId));
}

/** The signup moved: its precondition fields, or who is in the roster. */
export function signupChangedSince(seen: EventSnapshotDto, live: EventSnapshotDto): boolean {
  return seen.eventId !== live.eventId
    || JSON.stringify(signupPrecondition(seen)) !== JSON.stringify(signupPrecondition(live))
    || (seen.signup?.roster ?? []).join() !== (live.signup?.roster ?? []).join();
}

/** A fresh UUID v4 per user intent. Loopback origins are secure contexts, so randomUUID exists there. */
export function newCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Pending-state key: one in-flight request per action target. */
export function actionKey(command: AdminCommandDto | { type: 'refresh' }): string {
  switch (command.type) {
    case 'signupRemove': return `signupRemove:${command.memberId}`;
    case 'judgeResume':
    case 'resolve':
    case 'correct': return `${command.type}:${command.matchId}`;
    default: return command.type;
  }
}

export const REFRESH_KEY = actionKey({ type: 'refresh' });

export function matchActionKey(action: MatchAdminAction, matchId: MatchId): string {
  return `${action}:${matchId}`;
}

// ---------------------------------------------------------------- reasons

export function needsReason(type: CommandType): boolean {
  return type === 'judgeResume' || type === 'resolve' || type === 'correct';
}

export type ReasonCheck = { ok: true; reason: string } | { ok: false; error: string; length: number };

/** Same rule as the server: 1 to ADMIN_REASON_MAX_LENGTH characters after trimming. */
export function checkReason(raw: string): ReasonCheck {
  const reason = raw.trim();
  // Same rule as the server: whitespace and invisible format characters (zero-width space, BOM) alone
  // are no reason. Only whitespace is trimmed from the value and the count.
  if (!/[^\s\p{Cf}]/u.test(reason)) return { ok: false, error: 'Enter a reason. It is stored in the audit log.', length: 0 };
  if (reason.length > ADMIN_REASON_MAX_LENGTH) {
    return { ok: false, error: `Keep the reason to ${ADMIN_REASON_MAX_LENGTH} characters (it has ${reason.length}).`, length: reason.length };
  }
  return { ok: true, reason };
}

// ---------------------------------------------------------------- wording

export const MATCH_ACTION_LABEL: Record<MatchAdminAction, string> = {
  resolve: 'Resolve',
  judgeResume: 'Resume play',
  correct: 'Correct result'
};

export function matchLine(snapshot: Pick<EventSnapshotDto, 'members' | 'seats'>, match: Pick<MatchDto, 'seats'>): string {
  return `${seatWithName(snapshot, match.seats[0])} vs ${seatWithName(snapshot, match.seats[1])}`;
}

/** Short infinitive for failure titles: "Could not publish the round". */
export function commandVerb(snapshot: EventSnapshotDto, command: AdminCommandDto): string {
  switch (command.type) {
    case 'publish': return 'publish the round';
    case 'signupClose': return 'close signup';
    case 'signupReopen': return 'reopen signup';
    case 'signupRemove': return `remove ${memberName(snapshot, command.memberId)}`;
    case 'judgeResume': return `resume ${command.matchId}`;
    case 'resolve': return `resolve ${command.matchId}`;
    case 'correct': return `correct ${command.matchId}`;
  }
}

/** Success title once the server applied the command. */
export function commandDone(snapshot: EventSnapshotDto, command: AdminCommandDto): string {
  switch (command.type) {
    case 'publish': return 'Round published';
    case 'signupClose': return 'Signup closed and seats assigned';
    case 'signupReopen': return 'Signup reopened';
    case 'signupRemove': return `Removed ${memberName(snapshot, command.memberId)} from the signup`;
    case 'judgeResume': return `${command.matchId} resumed by judge override`;
    case 'resolve': return `${command.matchId} resolved: ${seatWithName(snapshot, command.winner)} wins`;
    case 'correct': return `${command.matchId} corrected: ${seatWithName(snapshot, command.winner)} wins`;
  }
}

/** `judge_already_called` → `judge already called`. */
export function humanizeResult(result: string): string {
  return result.replace(/[_:]+/g, ' ').trim();
}

export interface ToastSpec { title: string; description?: string; tone: 'neutral' | 'success' | 'danger'; duration?: number | null }

export const PENDING_DESCRIPTION = 'Saved. The Discord display is pending; the bot updates the cards when Discord answers.';

/** Toasts for a 200 command result: success or no-op, plus a sticky warning for a room problem. */
export function resultToasts(snapshot: EventSnapshotDto, command: AdminCommandDto, result: AdminCommandResultDto): ToastSpec[] {
  const toasts: ToastSpec[] = [];
  if (!result.applied) {
    toasts.push({ title: 'No change', description: `Nothing changed: ${humanizeResult(result.result)}.`, tone: 'neutral' });
  } else if (result.cards === 'pending') {
    toasts.push({ title: commandDone(snapshot, command), description: PENDING_DESCRIPTION, tone: 'neutral', duration: 8000 });
  } else {
    toasts.push({ title: commandDone(snapshot, command), tone: 'success' });
  }
  if (result.roomWarning) toasts.push(roomWarningToast(result.roomWarning));
  return toasts;
}

export function refreshToasts(result: PanelRefreshResultDto): ToastSpec[] {
  const toasts: ToastSpec[] = [result.cards === 'pending'
    ? { title: 'Panel refresh saved', description: PENDING_DESCRIPTION, tone: 'neutral', duration: 8000 }
    : { title: 'Discord panels refreshed', tone: 'success' }];
  if (result.roomWarning) toasts.push(roomWarningToast(result.roomWarning));
  return toasts;
}

/** The kit has no warning tone; a room problem stays until dismissed and is announced assertively. */
function roomWarningToast(text: string): ToastSpec {
  return { title: 'Match room warning', description: text, tone: 'danger', duration: null };
}

/** What a failed command tells the admin. Only rule errors carry server text (they are safe to show). */
export function errorMessage(error: ApiError): string {
  switch (error.code) {
    case 'rule': return error.message;
    case 'conflict': return 'The event changed before your action arrived. The console now shows the latest state; check it and decide again.';
    case 'forbidden': return 'This console session is not allowed to do that.';
    case 'not_found': return 'The server does not know this event or action. It may have been replaced; check the sidebar.';
    case 'method_not_allowed': return 'This server does not accept console actions.';
    case 'bad_request': return 'The server rejected the request as malformed. Nothing was changed.';
    // A 503 can follow a commit whose reply was lost (shutdown), so it is hedged like a network error.
    case 'unavailable': return 'The console server is unavailable (it may be shutting down). If the action went through, it appears in the activity stream; otherwise try again shortly.';
    case 'too_many_requests': return 'Too many requests. Wait a moment and try again.';
    case 'unauthenticated': return 'The console session ended. Sign in again.';
    case 'network': return 'The console server could not be reached. If the action went through, it appears in the activity stream.';
    default: return 'The server could not complete the action. If it went through, it appears in the activity stream.';
  }
}

/** Matches a 409 snapshot against the one the admin was looking at, for the "what changed" line. */
export function conflictSummary(before: EventSnapshotDto, after: EventSnapshotDto | undefined, matchId?: MatchId): string | null {
  if (!after) return null;
  if (after.eventId !== before.eventId) return 'Another event is active now.';
  if (matchId) {
    const was = before.matches.find(match => match.id === matchId);
    const now = after.matches.find(match => match.id === matchId);
    if (was && now && was.phase !== now.phase) return `${matchId} is ${now.phase} now (it was ${was.phase}).`;
    if (was && now && was.finalWinner !== now.finalWinner) return `${matchId}'s recorded winner is now ${now.finalWinner ?? 'none'}.`;
  }
  if (after.stage !== before.stage) return `The event moved on to ${after.stage}.`;
  return null;
}
