import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_REASON_MAX_LENGTH, CAPABILITIES, COMMAND_CAPABILITY, type AdminCommandDto } from '@tcg-live/core';
import { createFixture, createSignupFixture, RuleError } from '../rehearsal/domain.js';
import { commandContent, parseCommandRequest, parsePanelRefreshRequest, preconditionHolds, requiredCapability,
  sessionCapabilities, toDomainCommand, webCommandId } from './commands.js';
import { HttpError } from './http/respond.js';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EVENT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '800000000000000015';
const paused = { matchId: 'M1', phase: 'paused', proposalRevision: null, finalWinner: null, pauseGeneration: 1 };
const final = { matchId: 'M2', phase: 'final', proposalRevision: 2, finalWinner: 'D', pauseGeneration: 0 };

/** One valid request per command type. */
function valid(): Record<AdminCommandDto['type'], Record<string, unknown>> {
  const base = { commandId: UUID, eventId: EVENT };
  const signup = { signup: { status: 'open', rosterSize: 4 } };
  return {
    publish: { ...base, command: { type: 'publish' }, precondition: { eventVersion: 4 } },
    signupClose: { ...base, command: { type: 'signupClose' }, precondition: signup },
    signupReopen: { ...base, command: { type: 'signupReopen' }, precondition: { signup: { status: 'assigned', rosterSize: 4 } } },
    signupRemove: { ...base, command: { type: 'signupRemove', memberId: MEMBER }, precondition: signup },
    judgeResume: { ...base, command: { type: 'judgeResume', matchId: 'M1', reason: 'Board checked.' }, precondition: { match: paused } },
    resolve: { ...base, command: { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'Ruling.' }, precondition: { match: paused } },
    correct: { ...base, command: { type: 'correct', matchId: 'M2', winner: 'C', reason: 'Score sheet.' }, precondition: { match: final } }
  };
}

function rejects(body: unknown, pattern: RegExp, label: string): void {
  assert.throws(() => parseCommandRequest(body), (error: unknown) => {
    assert.ok(error instanceof HttpError, label);
    assert.equal(error.status, 400, label);
    assert.equal(error.code, 'bad_request', label);
    assert.match(error.message, pattern, label);
    return true;
  }, label);
}

test('every command type parses; the reason is trimmed and the command ID lowercased', () => {
  for (const [type, body] of Object.entries(valid())) {
    const parsed = parseCommandRequest(body);
    assert.equal(parsed.command.type, type);
    assert.deepEqual(parsed, body, type);
  }
  const padded = parseCommandRequest({ ...valid().resolve, commandId: UUID.toUpperCase(),
    command: { type: 'resolve', matchId: 'M1', winner: 'A', reason: `  ${'r'.repeat(ADMIN_REASON_MAX_LENGTH)}\n ` } });
  assert.equal(padded.commandId, UUID);
  assert.equal(padded.command.type === 'resolve' && padded.command.reason, 'r'.repeat(ADMIN_REASON_MAX_LENGTH));
  assert.equal(webCommandId(UUID.toUpperCase()), `web:${UUID}`);
});

test('equal content hashes equally regardless of key order; other content differs', () => {
  const body = valid().resolve;
  const reordered = { precondition: { match: { pauseGeneration: 1, finalWinner: null, proposalRevision: null, phase: 'paused', matchId: 'M1' } },
    command: { reason: ' Ruling. ', winner: 'A', matchId: 'M1', type: 'resolve' }, eventId: EVENT, commandId: UUID };
  assert.equal(commandContent(parseCommandRequest(reordered)), commandContent(parseCommandRequest(body)));
  const other = { ...body, precondition: { match: { ...paused, pauseGeneration: 2 } } };
  assert.notEqual(commandContent(parseCommandRequest(other)), commandContent(parseCommandRequest(body)));
});

test('every malformed request is a 400 bad_request', () => {
  const v = valid();
  const resolve = v.resolve as { command: Record<string, unknown>; precondition: Record<string, unknown> };
  const withCommand = (command: unknown, precondition: unknown = resolve.precondition) => ({ ...v.resolve, command, precondition });
  const withPrecondition = (body: Record<string, unknown>, precondition: unknown) => ({ ...body, precondition });
  const cases: Array<[unknown, RegExp, string]> = [
    [undefined, /required/, 'empty body'],
    [[], /JSON object/, 'array body'],
    ['publish', /JSON object/, 'string body'],
    [null, /JSON object/, 'null body'],
    [{ ...v.publish, extra: 1 }, /unknown fields/, 'extra top-level field'],
    [{ eventId: EVENT, command: { type: 'publish' }, precondition: { eventVersion: 1 } }, /missing commandId/, 'missing commandId'],
    [{ commandId: UUID, eventId: EVENT, command: { type: 'publish' } }, /missing precondition/, 'missing precondition'],
    [{ ...v.publish, commandId: 'not-a-uuid' }, /UUID v4/, 'commandId not a UUID'],
    [{ ...v.publish, commandId: 'c232ab00-9414-11ec-b3c8-9f6bdeced846' }, /UUID v4/, 'UUID v1'],
    [{ ...v.publish, commandId: '0f8fad5b-d9cb-469f-c165-70867728950e' }, /UUID v4/, 'bad UUID variant'],
    [{ ...v.publish, commandId: 42 }, /UUID v4/, 'numeric commandId'],
    [{ ...v.publish, eventId: 'a/b' }, /event ID/, 'event ID with a slash'],
    [{ ...v.publish, eventId: 'e'.repeat(65) }, /event ID/, 'event ID too long'],
    [{ ...v.publish, eventId: 7 }, /event ID/, 'numeric event ID'],
    [{ ...v.publish, command: 'publish' }, /command must be a JSON object/, 'command not an object'],
    [{ ...v.publish, command: { type: 'checkin' } }, /Unknown command type/, 'player command type'],
    [{ ...v.publish, command: { type: 'clockCheck', matchId: 'M1' } }, /Unknown command type/, 'timer command type'],
    [{ ...v.publish, command: { type: 'toString' } }, /Unknown command type/, 'prototype key as type'],
    [{ ...v.publish, command: {} }, /Unknown command type/, 'missing type'],
    [{ ...v.publish, command: { type: 'publish', matchId: 'M1' } }, /unknown fields/, 'extra command field'],
    [{ ...v.signupClose, command: { type: 'signupClose', adminId: MEMBER } }, /unknown fields/, 'signupClose with adminId'],
    [withCommand({ type: 'resolve', matchId: 'M1', reason: 'x' }), /missing winner/, 'resolve without winner'],
    [withCommand({ type: 'resolve', matchId: 'M3', winner: 'A', reason: 'x' }), /M1 or M2/, 'bad matchId'],
    [withCommand({ type: 'resolve', matchId: 'M1', winner: 'E', reason: 'x' }), /seat/, 'bad seat'],
    [withCommand({ type: 'resolve', matchId: 'M1', winner: 'a', reason: 'x' }), /seat/, 'lowercase seat'],
    [withCommand({ type: 'resolve', matchId: 'M1', winner: 'A' }), /missing reason/, 'missing reason'],
    [withCommand({ type: 'resolve', matchId: 'M1', winner: 'A', reason: 5 }), /reason must be a string/, 'numeric reason'],
    [withCommand({ type: 'resolve', matchId: 'M1', winner: 'A', reason: ' \n\t ' }), /reason is required/, 'blank reason'],
    [withCommand({ type: 'resolve', matchId: 'M1', winner: 'A', reason: 'r'.repeat(ADMIN_REASON_MAX_LENGTH + 1) }), /at most 500/, 'long reason'],
    [{ ...v.signupRemove, command: { type: 'signupRemove', memberId: '123' } }, /member ID/, 'short member ID'],
    [{ ...v.signupRemove, command: { type: 'signupRemove', memberId: 800000000000000015 } }, /member ID/, 'numeric member ID'],
    [{ ...v.signupRemove, command: { type: 'signupRemove' } }, /missing memberId/, 'missing member ID'],
    [withPrecondition(v.publish, []), /precondition must be a JSON object/, 'precondition array'],
    [withPrecondition(v.publish, { eventVersion: 1, phase: 'x' }), /precondition has unknown fields/, 'extra precondition key'],
    [withPrecondition(v.publish, {}), /publish needs precondition.eventVersion/, 'publish without version'],
    [withPrecondition(v.publish, { signup: { status: 'assigned', rosterSize: 4 } }), /publish needs precondition.eventVersion/, 'publish with only signup'],
    [withPrecondition(v.publish, { eventVersion: -1 }), /eventVersion must be an integer/, 'negative version'],
    [withPrecondition(v.publish, { eventVersion: 1.5 }), /eventVersion must be an integer/, 'fractional version'],
    [withPrecondition(v.publish, { eventVersion: '3' }), /eventVersion must be an integer/, 'string version'],
    [withPrecondition(v.publish, { eventVersion: null }), /eventVersion must be an integer/, 'null version'],
    [withPrecondition(v.resolve, { eventVersion: 3 }), /resolve needs precondition.match for M1/, 'resolve without match'],
    [withPrecondition(v.resolve, { match: { ...paused, matchId: 'M2' } }), /resolve needs precondition.match for M1/, 'match for the other match'],
    [withPrecondition(v.judgeResume, { match: { matchId: 'M1', phase: 'paused', proposalRevision: null, finalWinner: null } }),
      /missing pauseGeneration/, 'match missing a field'],
    [withPrecondition(v.judgeResume, { match: { ...paused, clock: 1 } }), /match has unknown fields/, 'match extra field'],
    [withPrecondition(v.judgeResume, { match: { ...paused, phase: 'over' } }), /phase/, 'bad phase'],
    [withPrecondition(v.judgeResume, { match: { ...paused, proposalRevision: 0 } }), /proposalRevision/, 'revision zero'],
    [withPrecondition(v.judgeResume, { match: { ...paused, finalWinner: 'E' } }), /finalWinner/, 'bad final winner'],
    [withPrecondition(v.judgeResume, { match: { ...paused, pauseGeneration: -1 } }), /pauseGeneration/, 'negative generation'],
    [withPrecondition(v.signupClose, { eventVersion: 2 }), /signupClose needs precondition.signup/, 'signup command without signup'],
    [withPrecondition(v.signupRemove, {}), /signupRemove needs precondition.signup/, 'remove without signup'],
    [withPrecondition(v.signupClose, { signup: { status: 'closed', rosterSize: 4 } }), /status/, 'bad signup status'],
    [withPrecondition(v.signupClose, { signup: { status: 'open', rosterSize: 5 } }), /rosterSize/, 'roster too large'],
    [withPrecondition(v.signupClose, { signup: { status: 'open' } }), /missing rosterSize/, 'signup missing size']
  ];
  for (const [body, pattern, label] of cases) rejects(body, pattern, label);
});

test('panel refresh requests take exactly an event ID', () => {
  assert.deepEqual(parsePanelRefreshRequest({ eventId: EVENT }), { eventId: EVENT });
  for (const body of [undefined, {}, { eventId: 5 }, { eventId: EVENT, force: true }, { eventId: '../x' }, []])
    assert.throws(() => parsePanelRefreshRequest(body), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test('capabilities: each type needs its contract capability; decision 4 limits disabled sessions to reading', () => {
  for (const [type, body] of Object.entries(valid()))
    assert.equal(requiredCapability(parseCommandRequest(body).command), COMMAND_CAPABILITY[type as AdminCommandDto['type']]);
  assert.deepEqual(sessionCapabilities(false), ['dashboard.read']);
  assert.deepEqual(sessionCapabilities(true), [...CAPABILITIES]);
});

test('domain mapping matches the slash command: signup close carries the admin, and the winner must play', () => {
  const v = valid();
  assert.deepEqual(toDomainCommand(parseCommandRequest(v.signupClose).command, MEMBER), { type: 'signupClose', adminId: MEMBER });
  assert.deepEqual(toDomainCommand(parseCommandRequest(v.resolve).command, MEMBER),
    { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'Ruling.' });
  assert.deepEqual(toDomainCommand(parseCommandRequest(v.signupRemove).command, MEMBER), { type: 'signupRemove', memberId: MEMBER });
  assert.throws(() => toDomainCommand({ type: 'correct', matchId: 'M2', winner: 'A', reason: 'x' }, MEMBER),
    (error: unknown) => error instanceof RuleError && error.message === 'Winner is not in the selected match.');
});

test('preconditions compare every part the admin sent with the aggregate', () => {
  const state = createSignupFixture(EVENT);
  state.version = 4;
  state.signup!.roster = ['800000000000000011', '800000000000000012'];
  assert.equal(preconditionHolds(state, { signup: { status: 'open', rosterSize: 2 } }), true);
  assert.equal(preconditionHolds(state, { signup: { status: 'open', rosterSize: 3 } }), false);
  assert.equal(preconditionHolds(state, { signup: { status: 'assigned', rosterSize: 2 } }), false);
  assert.equal(preconditionHolds(state, { eventVersion: 4, signup: { status: 'open', rosterSize: 2 } }), true);
  assert.equal(preconditionHolds(state, { eventVersion: 3, signup: { status: 'open', rosterSize: 2 } }), false);
  assert.equal(preconditionHolds(createFixture(EVENT), { signup: { status: 'open', rosterSize: 0 } }), false, 'legacy event has no signup');

  const live = createFixture(EVENT);
  live.matches[0] = { ...live.matches[0], phase: 'paused', pauseGeneration: 1 };
  const match = { matchId: 'M1' as const, phase: 'paused' as const, proposalRevision: null, finalWinner: null, pauseGeneration: 1 };
  assert.equal(preconditionHolds(live, { match }), true);
  assert.equal(preconditionHolds(live, { match: { ...match, phase: 'running' } }), false);
  assert.equal(preconditionHolds(live, { match: { ...match, pauseGeneration: 2 } }), false);
  assert.equal(preconditionHolds(live, { match: { ...match, proposalRevision: 1 } }), false);
  assert.equal(preconditionHolds(live, { match: { ...match, finalWinner: 'A' } }), false);
  live.matches[0].proposal = { revision: 1, winner: 'A', reporter: 'A', decision: 'disputed' };
  assert.equal(preconditionHolds(live, { match: { ...match, proposalRevision: 1 } }), true);
});
