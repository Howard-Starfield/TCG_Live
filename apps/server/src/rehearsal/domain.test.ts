import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN, createFixture, deriveFixture, transition, type Command, type EventState
} from './domain.js';

const runner = 'runner-one';
let now = 1_000;

function apply(state: EventState, actor: string, command: Command, at = now, by = runner): EventState {
  return transition(state, actor, command, at, by).state;
}

function published(): EventState {
  let state = createFixture('fixture', 10_000);
  for (const player of ['A', 'B', 'C', 'D'] as const) {
    state = apply(state, `player:${player}`, { type: 'checkin' });
  }
  return apply(state, ADMIN, { type: 'publish' });
}

function started(): EventState {
  let state = published();
  state = apply(state, 'player:A', { type: 'ready', matchId: 'M1' });
  return apply(state, 'player:B', { type: 'ready', matchId: 'M1' });
}

test('check-in is idempotent, closes on publication, and fixtures start in setup', () => {
  let state = createFixture('fixture');
  const first = transition(state, 'player:A', { type: 'checkin' }, now, runner);
  state = first.state;
  const repeated = transition(state, 'player:A', { type: 'checkin' }, now, runner);
  assert.equal(repeated.outcome.applied, false);
  assert.equal(repeated.state.version, 1);
  assert.deepEqual(repeated.state.checkins, ['A']);
  assert.throws(() => apply(state, ADMIN, { type: 'publish' }), /four check-ins/);
  assert.throws(() => apply(state, 'player:E', { type: 'checkin' }), /denied/);
  state = published();
  assert.equal(state.published, true);
  assert(state.matches.every(match => match.phase === 'setup' && match.startedAtMs === null));
  assert.equal(transition(state, 'player:A', { type: 'checkin' }, now, runner).outcome.applied, false);
});

test('participant and admin mapping, both-ready start, pause generations, and judge override', () => {
  let state = published();
  assert.throws(() => apply(state, 'player:A', { type: 'publish' }), /denied/);
  assert.throws(() => apply(state, 'player:C', { type: 'ready', matchId: 'M1' }), /denied/);
  state = apply(state, 'player:A', { type: 'ready', matchId: 'M1' });
  assert.equal(state.matches[0].phase, 'setup');
  state = apply(state, 'player:B', { type: 'ready', matchId: 'M1' });
  assert.equal(state.matches[0].phase, 'running');
  state = apply(state, 'player:A', { type: 'pause', matchId: 'M1' }, now + 1_000);
  assert.equal(state.matches[0].remainingMs, 9_000);
  assert.equal(state.matches[0].pauseGeneration, 1);
  state = apply(state, 'player:A', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 });
  assert.equal(state.matches[0].phase, 'paused');
  assert.throws(() => apply(state, 'player:A', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 }), /unavailable/);
  state = apply(state, 'player:B', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 });
  assert.equal(state.matches[0].phase, 'running');
  state = apply(state, 'player:B', { type: 'pause', matchId: 'M1' }, now + 2_000);
  assert.equal(state.matches[0].pauseGeneration, 2);
  assert.deepEqual(state.matches[0].resumeConsents, []);
  assert.throws(() => apply(state, 'player:A', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 }), /Stale pause generation/);
  state = apply(state, 'player:A', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 2 });
  assert.equal(state.matches[0].phase, 'paused');
  state = apply(state, 'player:B', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 2 }, now + 50_000, 'other-runner');
  assert.equal(state.matches[0].phase, 'running');
  assert.equal(state.matches[0].runnerId, 'other-runner');
  state = apply(state, 'player:B', { type: 'pause', matchId: 'M1' }, now + 50_001, 'other-runner');
  assert.throws(() => apply(state, 'player:A', { type: 'judgeResume', matchId: 'M1', reason: 'x' }), /denied/);
  assert.throws(() => apply(state, ADMIN, { type: 'judgeResume', matchId: 'M1', reason: ' ' }), /reason/);
  state = apply(state, ADMIN, { type: 'judgeResume', matchId: 'M1', reason: 'Fixture override' });
  assert.equal(state.matches[0].phase, 'running');
});

test('exact expiry flags a judge without awarding result; foreign runner cannot materialize it', () => {
  const state = started();
  assert.throws(() => apply(state, ADMIN, { type: 'clockCheck', matchId: 'M1' }, now + 10_000, 'other-runner'), /unsupported/);
  assert.equal(state.matches[0].remainingMs, 10_000);
  assert.throws(() => apply(state, 'player:A', { type: 'pause', matchId: 'M1' }, now + 10_000), /unavailable/);
  let expired = apply(state, ADMIN, { type: 'clockCheck', matchId: 'M1' }, now + 10_000);
  assert.equal(expired.matches[0].phase, 'expired');
  assert.equal(expired.matches[0].remainingMs, 0);
  assert.equal(expired.matches[0].judgeAttention, true);
  assert.equal(expired.matches[0].finalWinner, null);
  assert.throws(() => apply(expired, 'player:A', { type: 'pause', matchId: 'M1' }), /unavailable/);
  expired = apply(expired, 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 });
  assert.equal(expired.matches[0].proposal?.revision, 1);
  assert.throws(() => apply(state, ADMIN, { type: 'clockCheck', matchId: 'M1' }, now - 1), /backward/);
});

test('proposal revision, opponent decision, dispute, and replacement consent', () => {
  let state = started();
  assert.throws(() => apply(published(), 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }), /unavailable/);
  state = apply(state, 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 });
  assert.throws(() => apply(state, 'player:A', { type: 'confirm', matchId: 'M1', revision: 1 }), /Reporter cannot/);
  assert.throws(() => apply(state, 'player:A', { type: 'dispute', matchId: 'M1', revision: 1 }), /Reporter cannot/);
  assert.throws(() => apply(state, 'player:C', { type: 'confirm', matchId: 'M1', revision: 1 }), /denied/);
  state = apply(state, 'player:B', { type: 'dispute', matchId: 'M1', revision: 1 });
  assert.equal(state.matches[0].judgeAttention, true);
  assert.throws(() => apply(state, 'player:B', { type: 'dispute', matchId: 'M1', revision: 1 }), /Stale/);
  state = apply(state, 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 1 });
  assert.equal(state.matches[0].proposal?.revision, 2);
  assert.throws(() => apply(state, 'player:B', { type: 'confirm', matchId: 'M1', revision: 1 }), /Stale/);
  state = apply(state, 'player:B', { type: 'confirm', matchId: 'M1', revision: 2 });
  assert.equal(state.matches[0].phase, 'final');
  assert.equal(state.matches[0].finalWinner, 'A');
  assert.equal(state.matches[0].confirmedBy, 'B');
});

test('opponent may settle a dispute by confirming; final result blocks later player decisions', () => {
  let state = started();
  state = apply(state, 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 });
  state = apply(state, 'player:B', { type: 'dispute', matchId: 'M1', revision: 1 });
  state = apply(state, 'player:B', { type: 'confirm', matchId: 'M1', revision: 1 });
  assert.equal(state.matches[0].phase, 'final');
  assert.equal(state.matches[0].finalWinner, 'A');
  assert.equal(state.matches[0].confirmedBy, 'B');
  state = apply(state, ADMIN, { type: 'correct', matchId: 'M1', winner: 'B', reason: 'Fixture correction' });
  assert.throws(() => apply(state, 'player:B', { type: 'confirm', matchId: 'M1', revision: 1 }), /Stale/);
  assert.throws(() => apply(state, 'player:B', { type: 'dispute', matchId: 'M1', revision: 1 }), /Stale/);
  assert.equal(state.matches[0].finalWinner, 'B');
  assert.equal(state.matches[0].confirmedBy, undefined, 'admin correction is not a player agreement');
});

test('admin correction replaces the result contribution; fixture order stays fixed', () => {
  let state = started();
  state = apply(state, ADMIN, { type: 'resolve', matchId: 'M1', winner: 'B', reason: 'Fixture decision' });
  assert.equal(state.matches[0].confirmedBy, undefined);
  assert.deepEqual(deriveFixture(state).map(row => [row.player, row.points, row.rating]), [
    ['A', 0, 1184], ['B', 3, 1216], ['C', 0, 1200], ['D', 0, 1200]
  ]);
  assert.throws(() => apply(state, ADMIN, { type: 'correct', matchId: 'M1', winner: 'B', reason: 'same' }), /unavailable/);
  assert.throws(() => apply(state, ADMIN, { type: 'correct', matchId: 'M1', winner: 'A', reason: '' }), /reason/);
  state = apply(state, ADMIN, { type: 'correct', matchId: 'M1', winner: 'A', reason: 'Fixture correction' });
  assert.deepEqual(deriveFixture(state).map(row => [row.player, row.points, row.rating]), [
    ['A', 3, 1216], ['B', 0, 1184], ['C', 0, 1200], ['D', 0, 1200]
  ]);
});

test('participant judge request is idempotent and does not pause or award result', () => {
  let state = started();
  const first = transition(state, 'player:A', { type: 'callJudge', matchId: 'M1' }, now + 100, runner);
  assert.equal(first.outcome.applied, true);
  state = first.state;
  assert.equal(state.matches[0].judgeAttention, true);
  assert.equal(state.matches[0].phase, 'running');
  assert.equal(state.matches[0].finalWinner, null);
  const again = transition(state, 'player:B', { type: 'callJudge', matchId: 'M1' }, now + 200, runner);
  assert.equal(again.outcome.applied, false);
  assert.equal(again.state.version, state.version);
  assert.throws(() => transition(state, 'player:C', { type: 'callJudge', matchId: 'M1' }, now + 200, runner), /denied/);
  state = apply(state, 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }, now + 300);
  assert.equal(state.matches[0].judgeAttention, true);
  state = apply(state, ADMIN, { type: 'resolve', matchId: 'M1', winner: 'B', reason: 'Practice ruling' }, now + 400);
  assert.equal(state.matches[0].judgeAttention, false);
  assert.throws(() => apply(state, 'player:A', { type: 'callJudge', matchId: 'M1' }, now + 500), /unavailable/);
});
