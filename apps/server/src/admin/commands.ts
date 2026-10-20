// Wave 3 admin console commands: strict request validation, capabilities, preconditions, and the mapping
// from the contract's AdminCommandDto to the domain command the store applies. Shared by both runtimes.
import { ADMIN_REASON_MAX_LENGTH, CAPABILITIES, COMMAND_CAPABILITY, MATCH_IDS, SEATS, type AdminCommandDto,
  type AdminCommandRequestDto, type Capability, type CommandPreconditionDto, type MatchId, type MatchPhase,
  type PanelRefreshRequestDto, type Seat } from '@tcg-live/core';
import { createFixture, RuleError, type Command, type EventState } from '../rehearsal/domain.js';
import { HttpError } from './http/respond.js';
import type { AdminPrincipal } from './runtime-types.js';

/** 409 messages, shared by both runtimes. Safe to show. */
export const CONFLICT = {
  inactive: 'This event is no longer active.',
  changed: 'The event changed since this action was prepared; review the latest state.',
  reused: 'This command ID was already used for a different command.'
} as const;

/** The only console principal until multi-user login. */
export const LOCAL_ADMIN: AdminPrincipal = { kind: 'local', id: 'local-admin' };

/**
 * Decision 4: a console session counts as the configured admin only when commands are enabled
 * (TCG_ADMIN_COMMANDS=1 in Discord mode, always in the demo). Otherwise it may only read.
 */
export function sessionCapabilities(commandsEnabled: boolean): Capability[] {
  return commandsEnabled ? [...CAPABILITIES] : ['dashboard.read'];
}

export function requiredCapability(command: AdminCommandDto): Capability {
  return COMMAND_CAPABILITY[command.type];
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const SNOWFLAKE = /^[1-9]\d{14,21}$/;
const PHASES: readonly MatchPhase[] = ['setup', 'running', 'paused', 'expired', 'final'];
/** Fields each command type carries besides `type`, in contract order. */
const COMMAND_FIELDS: Record<AdminCommandDto['type'], readonly string[]> = {
  publish: [], signupClose: [], signupReopen: [], signupRemove: ['memberId'],
  judgeResume: ['matchId', 'reason'], resolve: ['matchId', 'winner', 'reason'], correct: ['matchId', 'winner', 'reason']
};
/** The fixture's fixed pairings (domain.ts createFixture): M1 is A v B, M2 is C v D. */
const PAIRINGS = createFixture('pairings').matches;
const MATCH_SEATS: Record<MatchId, readonly Seat[]> = {
  M1: PAIRINGS.find(match => match.id === 'M1')!.players, M2: PAIRINGS.find(match => match.id === 'M2')!.players
};

const bad = (message: string) => new HttpError(400, 'bad_request', message);

function fields(value: unknown, name: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad(`${name} must be a JSON object.`);
  const keys = Object.keys(value);
  if (keys.some(key => !required.includes(key) && !optional.includes(key))) throw bad(`${name} has unknown fields.`);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (missing.length) throw bad(`${name} is missing ${missing.join(', ')}.`);
  return value as Record<string, unknown>;
}

function matchId(value: unknown, name: string): MatchId {
  if (typeof value !== 'string' || !(MATCH_IDS as readonly string[]).includes(value)) throw bad(`${name} must be M1 or M2.`);
  return value as MatchId;
}

function seat(value: unknown, name: string): Seat {
  if (typeof value !== 'string' || !(SEATS as readonly string[]).includes(value)) throw bad(`${name} must be a seat A to D.`);
  return value as Seat;
}

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw bad(`${name} must be an integer from ${min}${max === Number.MAX_SAFE_INTEGER ? '' : ` to ${max}`}.`);
  return value;
}

/** Trimmed; 1 to ADMIN_REASON_MAX_LENGTH characters after trimming. */
function reason(value: unknown): string {
  if (typeof value !== 'string') throw bad('command.reason must be a string.');
  const trimmed = value.trim();
  if (!trimmed) throw bad('A reason is required.');
  if (trimmed.length > ADMIN_REASON_MAX_LENGTH) throw bad(`A reason may be at most ${ADMIN_REASON_MAX_LENGTH} characters.`);
  return trimmed;
}

function parseCommand(value: unknown): AdminCommandDto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad('command must be a JSON object.');
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== 'string' || !Object.hasOwn(COMMAND_FIELDS, type)) throw bad('Unknown command type.');
  const kind = type as AdminCommandDto['type'];
  const source = fields(value, 'command', ['type', ...COMMAND_FIELDS[kind]]);
  switch (kind) {
    case 'publish': case 'signupClose': case 'signupReopen': return { type: kind };
    case 'signupRemove': {
      if (typeof source.memberId !== 'string' || !SNOWFLAKE.test(source.memberId)) throw bad('command.memberId must be a Discord member ID.');
      return { type: kind, memberId: source.memberId };
    }
    case 'judgeResume': return { type: kind, matchId: matchId(source.matchId, 'command.matchId'), reason: reason(source.reason) };
    case 'resolve': case 'correct':
      return { type: kind, matchId: matchId(source.matchId, 'command.matchId'), winner: seat(source.winner, 'command.winner'),
        reason: reason(source.reason) };
  }
}

function parsePrecondition(value: unknown, command: AdminCommandDto): CommandPreconditionDto {
  const source = fields(value, 'precondition', [], ['eventVersion', 'match', 'signup']);
  const precondition: CommandPreconditionDto = {};
  if (Object.hasOwn(source, 'eventVersion')) precondition.eventVersion = integer(source.eventVersion, 'precondition.eventVersion', 0);
  if (Object.hasOwn(source, 'match')) {
    const match = fields(source.match, 'precondition.match', ['matchId', 'phase', 'proposalRevision', 'finalWinner', 'pauseGeneration']);
    if (typeof match.phase !== 'string' || !(PHASES as readonly string[]).includes(match.phase))
      throw bad('precondition.match.phase must be a match phase.');
    precondition.match = {
      matchId: matchId(match.matchId, 'precondition.match.matchId'),
      phase: match.phase as MatchPhase,
      proposalRevision: match.proposalRevision === null ? null : integer(match.proposalRevision, 'precondition.match.proposalRevision', 1),
      finalWinner: match.finalWinner === null ? null : seat(match.finalWinner, 'precondition.match.finalWinner'),
      pauseGeneration: integer(match.pauseGeneration, 'precondition.match.pauseGeneration', 0)
    };
  }
  if (Object.hasOwn(source, 'signup')) {
    const signup = fields(source.signup, 'precondition.signup', ['status', 'rosterSize']);
    if (signup.status !== 'open' && signup.status !== 'assigned') throw bad('precondition.signup.status must be open or assigned.');
    precondition.signup = { status: signup.status, rosterSize: integer(signup.rosterSize, 'precondition.signup.rosterSize', 0, 4) };
  }
  switch (command.type) {
    case 'publish':
      if (precondition.eventVersion === undefined) throw bad('publish needs precondition.eventVersion.');
      break;
    case 'judgeResume': case 'resolve': case 'correct':
      if (precondition.match?.matchId !== command.matchId) throw bad(`${command.type} needs precondition.match for ${command.matchId}.`);
      break;
    default:
      if (!precondition.signup) throw bad(`${command.type} needs precondition.signup.`);
  }
  return precondition;
}

/**
 * Validates a POST /api/v1/commands body strictly and returns it normalized: the command ID lowercased,
 * the reason trimmed, objects rebuilt in contract key order (so equal content hashes equally).
 * Throws HttpError 400 `bad_request`.
 */
export function parseCommandRequest(body: unknown): AdminCommandRequestDto {
  if (body === undefined) throw bad('Request body is required.');
  const source = fields(body, 'Request body', ['commandId', 'eventId', 'command', 'precondition']);
  if (typeof source.commandId !== 'string' || !UUID_V4.test(source.commandId)) throw bad('commandId must be a UUID v4.');
  if (typeof source.eventId !== 'string' || !EVENT_ID.test(source.eventId)) throw bad('Invalid event ID.');
  const command = parseCommand(source.command);
  return { commandId: source.commandId.toLowerCase(), eventId: source.eventId, command,
    precondition: parsePrecondition(source.precondition, command) };
}

/** Validates a POST /api/v1/panels/refresh body. Throws HttpError 400 `bad_request`. */
export function parsePanelRefreshRequest(body: unknown): PanelRefreshRequestDto {
  if (body === undefined) throw bad('Request body is required.');
  const source = fields(body, 'Request body', ['eventId']);
  if (typeof source.eventId !== 'string' || !EVENT_ID.test(source.eventId)) throw bad('Invalid event ID.');
  return { eventId: source.eventId };
}

/** The stored command ID of a console command. */
export function webCommandId(commandId: string): string {
  return `web:${commandId.toLowerCase()}`;
}

/** Canonical content of a normalized request; the same command ID with other content is a conflict. */
export function commandContent(request: AdminCommandRequestDto): string {
  return JSON.stringify([request.eventId, request.command, request.precondition]);
}

/**
 * The domain command for a console command, as the slash command builds it (controller.ts commandFor):
 * signup close carries the configured admin, and a winner must play in the selected match (a RuleError,
 * reported as 422 like the slash command's reply).
 */
export function toDomainCommand(command: AdminCommandDto, adminId: string): Command {
  switch (command.type) {
    case 'publish': return { type: 'publish' };
    case 'signupClose': return { type: 'signupClose', adminId };
    case 'signupReopen': return { type: 'signupReopen' };
    case 'signupRemove': return { type: 'signupRemove', memberId: command.memberId };
    case 'judgeResume': return { type: 'judgeResume', matchId: command.matchId, reason: command.reason };
    case 'resolve': case 'correct':
      if (!MATCH_SEATS[command.matchId].includes(command.winner)) throw new RuleError('Winner is not in the selected match.');
      return { type: command.type, matchId: command.matchId, winner: command.winner, reason: command.reason };
  }
}

/** Every part the admin sent must still describe the aggregate. Checked under the event lock. */
export function preconditionHolds(state: EventState, precondition: CommandPreconditionDto): boolean {
  if (precondition.eventVersion !== undefined && state.version !== precondition.eventVersion) return false;
  if (precondition.match) {
    const expected = precondition.match;
    const match = state.matches.find(item => item.id === expected.matchId);
    if (!match || match.phase !== expected.phase || (match.proposal?.revision ?? null) !== expected.proposalRevision ||
        match.finalWinner !== expected.finalWinner || match.pauseGeneration !== expected.pauseGeneration) return false;
  }
  if (precondition.signup) {
    const signup = state.signup;
    if (!signup || signup.status !== precondition.signup.status || signup.roster.length !== precondition.signup.rosterSize) return false;
  }
  return true;
}
