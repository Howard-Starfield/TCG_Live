// Core fixtures checked against real mapper output: the audit timeline is replayed through transition().
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventSnapshotDto, MatchDto } from '@tcg-live/core';
import { auditTimeline, checkin, final, FIXTURE_ADMIN_ID, FIXTURE_EVENT_ID, FIXTURE_NOW_MS, liveDispute,
  liveInterrupted, signupOpen } from '@tcg-live/core/fixtures';
import { ADMIN, createSignupFixture, transition, type Command, type EventState } from '../../rehearsal/domain.js';
import { mapAuditRow, mapSnapshot, type AdminAuditRow, type AdminSessionRow } from './mappers.js';

const RUNNER = 'fixture-runner';
const CREATED_AT_MS = FIXTURE_NOW_MS - 45 * 60_000;

function replayTimeline() {
  let state = createSignupFixture(FIXTURE_EVENT_ID, 50 * 60_000);
  const rows: AdminAuditRow[] = [];
  const states = new Map<number, EventState>();
  const apply = (actor: string, command: Command, atMs: number, extra: Partial<AdminAuditRow>) => {
    const result = transition(state, actor, command, atMs, RUNNER);
    assert.equal(result.outcome.applied, true, `${command.type} applies`);
    state = result.state;
    rows.push({ sequence: state.version, command_id: `discord:${state.version}`, actor_id: actor, action: command,
      outcome: result.outcome, occurred_at_ms: atMs, mode: 'matchId' in command ? 'CAM' : null,
      principal_kind: 'discord', principal_id: FIXTURE_ADMIN_ID, ...extra });
    states.set(state.version, state);
    return result.outcome;
  };
  for (const entry of auditTimeline) {
    const actor = entry.actor.kind === 'member' ? `member:${entry.actor.memberId}`
      : entry.actor.kind === 'player' ? `player:${entry.actor.seat}` : ADMIN;
    const command = (entry.command.type === 'signupClose'
      ? { ...entry.command, adminId: FIXTURE_ADMIN_ID } : entry.command) as unknown as Command;
    const outcome = apply(actor, command, entry.occurredAtMs, { command_id: entry.commandId,
      principal_kind: entry.via === 'cli' ? null : entry.via, principal_id: entry.principalId });
    assert.equal(outcome.result, entry.result, `result of #${entry.sequence}`);
    assert.equal(outcome.version, entry.sequence, `sequence of #${entry.sequence}`);
  }
  return { rows, states, apply, get state() { return state; } };
}

function session(withMatchCards: boolean): AdminSessionRow {
  return {
    event_id: FIXTURE_EVENT_ID, application_id: '900000000000000099',
    guild_id: '900000000000000100', channel_id: '900000000000000101',
    identity_map: { kind: 'signup', adminId: FIXTURE_ADMIN_ID,
      matchChannels: { M1: '900000000000000102', M2: '900000000000000103' } },
    status: 'active', checkin_message_id: '900000000000000201',
    m1_message_id: withMatchCards ? '900000000000000202' : null,
    m2_message_id: withMatchCards ? '900000000000000203' : null,
    created_at_ms: CREATED_AT_MS, retired_at_ms: null
  };
}

function snapshotAt(state: EventState, rows: AdminAuditRow[], options: { cards?: boolean; panelRevision?: number; runnerId?: string } = {}): EventSnapshotDto {
  return mapSnapshot({ state, session: session(options.cards ?? false),
    audit: rows.filter(row => Number(row.sequence) <= state.version).map(mapAuditRow),
    runnerId: options.runnerId ?? RUNNER, panelRevision: options.panelRevision ?? 0,
    members: id => final.members[id] });
}

test('auditTimeline replays through the real domain and maps back to itself', () => {
  const { rows } = replayTimeline();
  assert.deepEqual(rows.map(mapAuditRow), auditTimeline);
});

test('signupOpen and checkin fixtures equal mapper output at their versions', () => {
  const { rows, states } = replayTimeline();
  assert.deepEqual(snapshotAt(states.get(signupOpen.version)!, rows), signupOpen);
  assert.deepEqual(snapshotAt(states.get(checkin.version)!, rows), checkin);
});

test('liveDispute equals mapper output at the end of the timeline', () => {
  const { rows, states } = replayTimeline();
  assert.deepEqual(snapshotAt(states.get(liveDispute.version)!, rows, { cards: true, panelRevision: 2 }), liveDispute);
});

test('liveInterrupted matches except adminActions, which the rules refuse while a clock is interrupted', () => {
  const { rows, states } = replayTimeline();
  const mapped = snapshotAt(states.get(liveInterrupted.version)!, rows, { cards: true, panelRevision: 2, runnerId: 'another-runner' });
  assert.equal(mapped.matches[0]!.clock.state, 'interrupted');
  // Fixture inaccuracy (reported): domain.ts:207 refuses M1 commands and store.ts:273 refuses every command of
  // an event with an interrupted running clock, so no admin action is available on either match.
  const corrected: EventSnapshotDto = { ...liveInterrupted,
    matches: liveInterrupted.matches.map((match): MatchDto => ({ ...match, adminActions: [] })) };
  assert.deepEqual(mapped, corrected);
  assert.deepEqual(liveInterrupted.matches.map(match => match.adminActions), [['resolve'], ['resolve', 'judgeResume']],
    'documents the fixture values this test corrects');
});

test('final is reachable from liveDispute; only its version is arbitrary', () => {
  const replay = replayTimeline();
  replay.apply('player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }, CREATED_AT_MS + 2_800_000, {});
  replay.apply('player:B', { type: 'confirm', matchId: 'M1', revision: 1 }, CREATED_AT_MS + 2_815_000, {});
  replay.apply(ADMIN, { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Judge ruling' }, CREATED_AT_MS + 2_900_000, {});
  const mapped = snapshotAt(replay.state, replay.rows, { cards: true, panelRevision: 2 });
  assert.equal(mapped.version, 20, 'the shortest continuation of the 17-entry timeline');
  assert.deepEqual({ ...mapped, version: final.version }, final);
});
