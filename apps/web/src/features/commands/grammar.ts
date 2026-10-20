// Composer grammar (L10): the `/tcg-test` subcommands as console slash commands, with parsing,
// context-aware suggestions and seat/member mentions resolved against the snapshot.
//
//   /publish | /signup-close | /signup-reopen | /refresh
//   /signup-remove <member>
//   /resolve <match> <winner> <reason…>      /correct <match> <winner> <reason…>
//   /judge-resume <match> <reason…>
//
// Arguments are positional or named with the Discord option names (`match:M2`, `winner:C`,
// `member-id:…`, `reason:…`). The reason is everything after the other arguments. A leading
// `/tcg-test` is accepted, so a Discord command pasted as typed also works.
import { SEATS, type EventAdminAction, type EventSnapshotDto, type MatchAdminAction, type MatchDto, type MatchId,
  type Seat, type SessionDto, type Snowflake } from '@tcg-live/core';
import { memberName } from '../../data';
import { seatWithName } from '../shell/labels';
import { availableEventActions, availableMatchActions, canRefreshPanels, canRun, checkReason, isWritable,
  MATCH_ACTION_LABEL, type CommandType } from './model';

type ArgName = 'match' | 'winner' | 'member' | 'reason';

export interface CommandSpec {
  /** Subcommand name as in Discord, e.g. `judge-resume`. */
  name: string;
  kind: CommandType | 'refresh';
  description: string;
  args: ArgName[];
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: 'publish', kind: 'publish', description: 'Publish the round', args: [] },
  { name: 'signup-close', kind: 'signupClose', description: 'Close signup and assign seats A–D', args: [] },
  { name: 'signup-reopen', kind: 'signupReopen', description: 'Reopen signup before publication', args: [] },
  { name: 'signup-remove', kind: 'signupRemove', description: 'Remove a member from the open signup', args: ['member'] },
  { name: 'refresh', kind: 'refresh', description: 'Create or repair the Discord cards', args: [] },
  { name: 'resolve', kind: 'resolve', description: 'Resolve a match', args: ['match', 'winner', 'reason'] },
  { name: 'correct', kind: 'correct', description: 'Correct a final result', args: ['match', 'winner', 'reason'] },
  { name: 'judge-resume', kind: 'judgeResume', description: 'Override a pause and resume play', args: ['match', 'reason'] }
];

/** Named option keys, Discord's first. */
const KEYS: Record<string, ArgName> = { match: 'match', winner: 'winner', 'member-id': 'member', member: 'member', reason: 'reason' };

const ARG_LABEL: Record<ArgName, string> = { match: 'match', winner: 'winner', member: 'member', reason: 'reason' };

/** `/resolve <match> <winner> <reason>`. */
export function usage(spec: CommandSpec): string {
  return [`/${spec.name}`, ...spec.args.map(arg => `<${ARG_LABEL[arg]}>`)].join(' ');
}

export interface ComposerContext {
  snapshot: EventSnapshotDto;
  session: Pick<SessionDto, 'commandsEnabled' | 'capabilities'> | null;
}

export type ComposerIntent =
  | { kind: 'event'; type: 'publish' | 'signupClose' | 'signupReopen' }
  | { kind: 'refresh' }
  | { kind: 'remove'; memberId: Snowflake }
  /** `winner` is null when the command did not name one; `reason` is null when it gave none. */
  | { kind: 'match'; action: MatchAdminAction; matchId: MatchId; winner: Seat | null; reason: string | null };

export type ParseResult =
  | { kind: 'empty' }
  | { kind: 'error'; message: string; spec?: CommandSpec }
  | { kind: 'ok'; spec: CommandSpec; intent: ComposerIntent };

// ---------------------------------------------------------------- mentions

/** Mention token for a member: `@Cy_Park`, or `@<id>` when the name is missing or ambiguous. */
export function mentionFor(snapshot: Pick<EventSnapshotDto, 'members'>, memberId: Snowflake): string {
  const name = snapshot.members[memberId]?.displayName?.trim();
  if (!name) return `@${memberId}`;
  const slug = slugOf(name);
  const clash = /^[a-d]$/i.test(slug) || Object.values(snapshot.members)
    .some(member => member.id !== memberId && member.displayName && slugOf(member.displayName) === slug);
  return clash ? `@${memberId}` : `@${slug}`;
}

function slugOf(name: string): string {
  return name.trim().replace(/\s+/g, '_');
}

type Mention = { seat: Seat } | { memberId: Snowflake } | { error: string };

/** Resolves `C`, `@C`, `@Cy_Park`, `@900…`, `<@900…>` and a bare member ID. */
export function resolveMention(snapshot: Pick<EventSnapshotDto, 'members'>, raw: string): Mention {
  const seat = /^@?([a-d])$/i.exec(raw);
  if (seat) return { seat: seat[1]!.toUpperCase() as Seat };
  const id = /^<@!?(\d{5,20})>$/.exec(raw) ?? /^@?(\d{5,20})$/.exec(raw);
  if (id) return { memberId: id[1]! };
  if (raw.startsWith('@') && raw.length > 1) {
    const wanted = raw.slice(1).toLowerCase();
    const found = Object.values(snapshot.members).filter(member => member.displayName && slugOf(member.displayName).toLowerCase() === wanted);
    if (found.length === 1) return { memberId: found[0]!.id };
    if (found.length > 1) return { error: `Several members are called ${raw}; use their member ID.` };
    return { error: `No member called ${raw} in this event.` };
  }
  return { error: `"${raw}" is not a seat or a member. Use A–D, or @ to mention someone.` };
}

// ---------------------------------------------------------------- scanning

interface Token { text: string; start: number; end: number }

function tokenize(text: string): Token[] {
  return Array.from(text.matchAll(/\S+/g), match => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

interface Scan {
  spec: CommandSpec | null;
  /** Error before any argument (unknown command and the like). */
  error: string | null;
  values: Partial<Record<Exclude<ArgName, 'reason'>, string>>;
  /** Free-text reason, or null when none started. */
  reason: string | null;
  extra: string | null;
}

/** Splits `text` (up to `limit`) into the command and its arguments, without resolving them. */
function scan(text: string, limit = text.length): Scan {
  const tokens = tokenize(text.slice(0, limit));
  const result: Scan = { spec: null, error: null, values: {}, reason: null, extra: null };
  const first = tokens[0];
  if (!first) return result;
  if (!first.text.startsWith('/')) {
    result.error = 'Commands start with /. Type / to see them.';
    return result;
  }
  let index = 1;
  let name = first.text.slice(1).toLowerCase();
  if (name === 'tcg-test') {
    name = tokens[1]?.text.toLowerCase() ?? '';
    index = 2;
    if (!name) {
      result.error = 'Add a subcommand after /tcg-test, for example /tcg-test publish.';
      return result;
    }
  }
  const spec = COMMAND_SPECS.find(item => item.name === name) ?? null;
  if (!spec) {
    result.error = `Unknown command /${name}. Type / to see the commands.`;
    return result;
  }
  result.spec = spec;
  const positional = spec.args.filter((arg): arg is Exclude<ArgName, 'reason'> => arg !== 'reason');
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const named = /^([a-z-]+):(.*)$/i.exec(token.text);
    const key = named ? KEYS[named[1]!.toLowerCase()] : undefined;
    if (key && spec.args.includes(key)) {
      if (key === 'reason') {
        result.reason = (named![2]! + text.slice(token.end, limit)).trim();
        break;
      }
      result.values[key] = named![2]!;
      continue;
    }
    const next = positional.find(arg => result.values[arg] === undefined);
    if (next) {
      result.values[next] = token.text;
      continue;
    }
    if (spec.args.includes('reason')) {
      result.reason = text.slice(token.start, limit).trim();
    } else {
      result.extra = token.text;
    }
    break;
  }
  return result;
}

// ---------------------------------------------------------------- parsing

const UNAVAILABLE_HINT: Record<EventAdminAction, string> = {
  publish: 'It needs all four check-ins and an unpublished round.',
  signupClose: 'It needs exactly four members in an open signup.',
  signupReopen: 'It works after signup closed, before the round is published or any match starts.',
  signupRemove: 'It works only while signup is open.'
};

type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };
const accept = <T,>(value: T): Resolved<T> => ({ ok: true, value });
const reject = <T,>(error: string): Resolved<T> => ({ ok: false, error });

function resolveMatch(snapshot: EventSnapshotDto, raw: string): Resolved<MatchDto> {
  const id = /^m?([12])$/i.exec(raw);
  const match = id ? snapshot.matches.find(item => item.id === `M${id[1]}`) : undefined;
  return match ? accept(match)
    : reject(`Unknown match "${raw}". Use ${snapshot.matches.map(item => item.id).join(' or ') || 'M1 or M2'}.`);
}

function resolveWinner(snapshot: EventSnapshotDto, match: MatchDto, raw: string): Resolved<Seat> {
  const mention = resolveMention(snapshot, raw);
  if ('error' in mention) return reject(mention.error);
  if ('memberId' in mention) {
    const seat = SEATS.find(item => snapshot.seats[item] === mention.memberId);
    if (!seat) return reject(`${memberName(snapshot, mention.memberId)} has no seat.`);
    return match.seats.includes(seat) ? accept(seat)
      : reject(`${memberName(snapshot, mention.memberId)} (Seat ${seat}) does not play in ${match.id}.`);
  }
  return match.seats.includes(mention.seat) ? accept(mention.seat)
    : reject(`Seat ${mention.seat} does not play in ${match.id} (${match.seats.join(' vs ')}).`);
}

function resolveMember(snapshot: EventSnapshotDto, raw: string): Resolved<Snowflake> {
  const mention = resolveMention(snapshot, raw);
  if ('error' in mention) return reject(mention.error);
  if ('seat' in mention) {
    const memberId = snapshot.seats[mention.seat];
    if (!memberId) return reject(`Seat ${mention.seat} has nobody in it yet; mention the member by name.`);
    return resolveMember(snapshot, memberId);
  }
  return snapshot.signup?.roster.includes(mention.memberId) ? accept(mention.memberId)
    : reject(`${memberName(snapshot, mention.memberId)} is not in the signup roster.`);
}

/** Parses a composer line against the snapshot and the session's rights. */
export function parseCommand(text: string, context: ComposerContext): ParseResult {
  if (text.trim().length === 0) return { kind: 'empty' };
  const { snapshot, session } = context;
  const scanned = scan(text);
  if (scanned.error || !scanned.spec) return { kind: 'error', message: scanned.error ?? 'Type / to see the commands.' };
  const spec = scanned.spec;
  const fail = (message: string): ParseResult => ({ kind: 'error', message, spec });
  if (scanned.extra) return fail(`/${spec.name} takes no ${spec.args.length ? 'more ' : ''}options ("${scanned.extra}"). Usage: ${usage(spec)}`);
  if (!isWritable(snapshot)) return fail('This event is history; it takes no commands.');

  if (spec.kind === 'refresh') {
    return canRefreshPanels(session) ? { kind: 'ok', spec, intent: { kind: 'refresh' } }
      : fail('This console session cannot refresh the Discord panels.');
  }
  if (!canRun(session, spec.kind)) return fail(`This console session cannot run /${spec.name}.`);

  switch (spec.kind) {
    case 'publish':
    case 'signupClose':
    case 'signupReopen':
    case 'signupRemove': {
      if (!availableEventActions(session, snapshot).includes(spec.kind)) {
        return fail(`/${spec.name} is not available right now. ${UNAVAILABLE_HINT[spec.kind]}`);
      }
      if (spec.kind !== 'signupRemove') return { kind: 'ok', spec, intent: { kind: 'event', type: spec.kind } };
      const raw = scanned.values.member;
      if (!raw) return fail(`Name the member to remove: ${usage(spec)}, for example @ and a name.`);
      const member = resolveMember(snapshot, raw);
      return member.ok ? { kind: 'ok', spec, intent: { kind: 'remove', memberId: member.value } } : fail(member.error);
    }
    case 'resolve':
    case 'correct':
    case 'judgeResume': {
      const action = spec.kind;
      const rawMatch = scanned.values.match;
      if (!rawMatch) return fail(`Name the match: ${usage(spec)}.`);
      const resolvedMatch = resolveMatch(snapshot, rawMatch);
      if (!resolvedMatch.ok) return fail(resolvedMatch.error);
      const match = resolvedMatch.value;
      if (!availableMatchActions(session, snapshot, match).includes(action)) {
        return fail(`${MATCH_ACTION_LABEL[action]} is not available for ${match.id} right now (it is ${match.phase}).`);
      }
      let winner: Seat | null = null;
      if (spec.args.includes('winner') && scanned.values.winner) {
        const resolved = resolveWinner(snapshot, match, scanned.values.winner);
        if (!resolved.ok) return fail(resolved.error);
        winner = resolved.value;
      }
      let reason: string | null = null;
      if (scanned.reason) {
        const check = checkReason(scanned.reason);
        if (!check.ok) return fail(check.error);
        reason = check.reason;
      }
      return { kind: 'ok', spec, intent: { kind: 'match', action, matchId: match.id, winner, reason } };
    }
  }
}

// ---------------------------------------------------------------- suggestions

export interface Suggestion {
  id: string;
  label: string;
  description?: string;
  /** Replaces the word at the caret; a space follows. */
  insertText: string;
}

export interface SuggestionList {
  heading: string;
  /** Range of `text` the chosen suggestion replaces. */
  start: number;
  end: number;
  items: Suggestion[];
}

/** Commands this session can run on this snapshot right now. */
export function availableSpecs(context: ComposerContext): CommandSpec[] {
  const { snapshot, session } = context;
  if (!isWritable(snapshot)) return [];
  const events = availableEventActions(session, snapshot);
  return COMMAND_SPECS.filter(spec => {
    switch (spec.kind) {
      case 'refresh': return canRefreshPanels(session);
      case 'publish':
      case 'signupClose':
      case 'signupReopen':
      case 'signupRemove': return events.includes(spec.kind);
      default: {
        const action = spec.kind;
        return snapshot.matches.some(match => availableMatchActions(session, snapshot, match).includes(action));
      }
    }
  });
}

function matchesQuery(query: string, ...candidates: string[]): boolean {
  const wanted = query.toLowerCase();
  return candidates.some(candidate => candidate.toLowerCase().startsWith(wanted));
}

/** What the word at the caret could become: a command, a match, a seat or a member. Null when nothing fits. */
export function suggest(text: string, caret: number, context: ComposerContext): SuggestionList | null {
  const { snapshot } = context;
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  const word = text.slice(start, caret);
  const before = text.slice(0, start);

  if (before.trim().length === 0) {
    if (!word.startsWith('/')) return null;
    const query = word.slice(1).toLowerCase();
    // Prefix matches first, then (from two letters on) names containing the query: `/res` finds judge-resume.
    const specs = availableSpecs(context);
    const items = [...specs.filter(spec => spec.name.startsWith(query)),
      ...specs.filter(spec => !spec.name.startsWith(query) && query.length > 1 && spec.name.includes(query))]
      .map(spec => ({ id: `command-${spec.name}`, label: `/${spec.name}`, description: spec.description, insertText: `/${spec.name}` }));
    return items.length ? { heading: 'Commands', start, end: caret, items } : null;
  }

  const scanned = scan(text, start);
  const spec = scanned.spec;
  if (!spec || scanned.error || scanned.reason !== null || scanned.extra) return null;
  const named = /^([a-z-]+):(.*)$/i.exec(word);
  const namedArg = named ? KEYS[named[1]!.toLowerCase()] : undefined;
  const prefix = namedArg ? `${named![1]}:` : '';
  const query = namedArg ? named![2]! : word;
  const arg = namedArg && spec.args.includes(namedArg) ? namedArg
    : spec.args.find(item => item !== 'reason' && scanned.values[item] === undefined);
  if (!arg || arg === 'reason') return null;

  let items: Suggestion[] = [];
  if (arg === 'match') {
    const action = spec.kind as MatchAdminAction;
    items = snapshot.matches
      .filter(match => availableMatchActions(context.session, snapshot, match).includes(action))
      .filter(match => matchesQuery(query, match.id, match.id.slice(1)))
      .map(match => ({ id: `match-${match.id}`, label: match.id, insertText: `${prefix}${match.id}`,
        description: `${match.seats.join(' vs ')} · ${match.phase}${match.judge ? ' · needs a judge' : ''}` }));
  } else if (arg === 'winner') {
    const resolved = scanned.values.match ? resolveMatch(snapshot, scanned.values.match) : null;
    if (!resolved?.ok) return null;
    const match = resolved.value;
    const bare = query.replace(/^@/, '');
    items = match.seats
      .filter(seat => matchesQuery(bare, seat, slugOf(memberName(snapshot, snapshot.seats[seat]))))
      .map(seat => ({ id: `seat-${seat}`, label: `@${seat}`, insertText: `${prefix}@${seat}`,
        description: `${seatWithName(snapshot, seat)}${match.finalWinner === seat ? ' · current winner' : ''}` }));
  } else {
    const bare = query.replace(/^@/, '');
    items = (snapshot.signup?.roster ?? [])
      .filter(memberId => matchesQuery(bare, slugOf(memberName(snapshot, memberId)), memberId))
      .map((memberId, index) => ({ id: `member-${memberId}`, label: mentionFor(snapshot, memberId), insertText: `${prefix}${mentionFor(snapshot, memberId)}`,
        description: `${memberName(snapshot, memberId)} · joined #${(snapshot.signup?.roster.indexOf(memberId) ?? index) + 1}` }));
  }
  const heading = arg === 'match' ? 'Matches' : arg === 'winner' ? 'Winner' : 'Members';
  return items.length ? { heading, start, end: caret, items } : null;
}

/** The argument the caret is on, for the usage hint (`null` before or outside a known command). */
export function currentArg(text: string, caret: number): { spec: CommandSpec; arg: ArgName | null } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  const scanned = scan(text, start);
  if (!scanned.spec) {
    const whole = scan(text);
    return whole.spec ? { spec: whole.spec, arg: null } : null;
  }
  const spec = scanned.spec;
  if (scanned.reason !== null) return { spec, arg: 'reason' };
  if (text.slice(0, start).trim().length === 0) return { spec, arg: null };
  return { spec, arg: spec.args.find(item => item === 'reason' || scanned.values[item] === undefined) ?? null };
}
