import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingMsAt } from '@tcg-live/core';
import { ADMIN } from '../../rehearsal/domain.js';
import { deriveJudge, deriveStage, eventAdminActions, mapAuditRow, mapClock, mapSnapshot, mapSummary,
  matchAdminActions, sanitizeCommand, type AdminAuditRow, type SnapshotInput } from './mappers.js';
import { EVENT_ID, IDS, Replay, RUNNER, sessionFor, T0 } from './testing.js';

function snapshotOf(replay: Replay, overrides: Partial<SnapshotInput> = {}) {
  return mapSnapshot({ state: replay.state, session: sessionFor(replay.state), audit: replay.entries(),
    runnerId: RUNNER, panelRevision: 0, members: () => undefined, ...overrides });
}

function row(overrides: Partial<AdminAuditRow>): AdminAuditRow {
  return { sequence: 1, command_id: 'discord:900000000000000001', actor_id: 'player:A', action: { type: 'checkin' },
    outcome: { eventId: EVENT_ID, version: 1, result: 'checkin', applied: true }, occurred_at_ms: T0,
    mode: null, principal_kind: 'discord', principal_id: IDS.a, ...overrides };
}

test('audit rows: commandId kept, bigint columns cast, timer rows mapped to the system actor', () => {
  const timer = mapAuditRow(row({ sequence: '7', command_id: `timer:M1:0:${T0}`, actor_id: ADMIN,
    action: { type: 'clockCheck', matchId: 'M1' }, occurred_at_ms: String(T0), mode: 'CAM',
    principal_kind: 'system', principal_id: 'system:timer',
    outcome: { eventId: EVENT_ID, version: 7, result: 'clockCheck', applied: true } }));
  assert.deepEqual(timer, { sequence: 7, commandId: `timer:M1:0:${T0}`, occurredAtMs: T0,
    actor: { kind: 'system', source: 'timer' }, via: 'system', principalId: 'system:timer',
    command: { type: 'clockCheck', matchId: 'M1' }, result: 'clockCheck', mode: 'CAM' });
  const admin = mapAuditRow(row({ actor_id: ADMIN, action: { type: 'signupClose', adminId: IDS.admin },
    principal_id: IDS.admin, outcome: { result: 'signupClose:{}' } }));
  assert.deepEqual(admin.actor, { kind: 'admin' });
  assert.deepEqual(admin.command, { type: 'signupClose' }, 'adminId is not part of CommandDto');
  const cli = mapAuditRow(row({ principal_kind: null, principal_id: null, command_id: 'checkin-A' }));
  assert.equal(cli.via, 'cli');
  assert.equal(cli.principalId, null);
  assert.equal(cli.commandId, 'checkin-A');
  assert.deepEqual(cli.actor, { kind: 'player', seat: 'A' });
  assert.equal(mapAuditRow(row({ principal_kind: 'web' })).via, 'web');
  assert.deepEqual(mapAuditRow(row({ actor_id: `member:${IDS.e}`, action: { type: 'signupJoin' } })).actor,
    { kind: 'member', memberId: IDS.e });
  assert.throws(() => mapAuditRow(row({ occurred_at_ms: 'not-a-number' })));
});

test('command sanitizing keeps typed contract keys only', () => {
  assert.deepEqual(sanitizeCommand({ type: 'resolve', matchId: 'M2', winner: 'C', reason: 'r', extra: 'x', adminId: '1' }),
    { type: 'resolve', matchId: 'M2', winner: 'C', reason: 'r' });
  assert.deepEqual(sanitizeCommand({ type: 'resumeConsent', matchId: 'M3', pauseGeneration: 2, revision: '1' }),
    { type: 'resumeConsent', pauseGeneration: 2 });
  assert.deepEqual(sanitizeCommand({ type: 'signupRemove', memberId: IDS.e }), { type: 'signupRemove', memberId: IDS.e });
  assert.deepEqual(sanitizeCommand({ type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }),
    { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 });
  assert.deepEqual(sanitizeCommand(null), { type: 'unknown' });
});

test('stage follows signup, publication and both finals', () => {
  const signup = Replay.signup();
  assert.equal(deriveStage(signup.state), 'signup');
  for (const id of [IDS.a, IDS.b, IDS.c, IDS.d]) signup.run(`member:${id}`, { type: 'signupJoin' });
  signup.run(ADMIN, { type: 'signupClose', adminId: IDS.admin });
  assert.equal(deriveStage(signup.state), 'checkin');
  const legacy = Replay.legacy();
  assert.equal(deriveStage(legacy.state), 'checkin');
  legacy.published();
  assert.equal(deriveStage(legacy.state), 'live');
  legacy.run('player:A', { type: 'ready', matchId: 'M1' }).run('player:B', { type: 'ready', matchId: 'M1' })
    .after(1_000, ADMIN, { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'r' });
  assert.equal(deriveStage(legacy.state), 'live');
  legacy.run('player:C', { type: 'ready', matchId: 'M2' }).run('player:D', { type: 'ready', matchId: 'M2' })
    .after(1_000, ADMIN, { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'r' });
  assert.equal(deriveStage(legacy.state), 'complete');
});

test('every phase maps its clock, admin actions and final source from the domain rules', () => {
  const r = Replay.legacy().published();
  let m1 = snapshotOf(r).matches[0]!;
  assert.equal(m1.phase, 'setup');
  assert.deepEqual(m1.adminActions, [], 'setup offers no resolve');
  assert.deepEqual(m1.clock, { durationMs: 60_000, remainingMs: 60_000, runningSinceMs: null, state: 'frozen' });

  r.run('player:A', { type: 'ready', matchId: 'M1' }).after(500, 'player:B', { type: 'ready', matchId: 'M1' });
  const startedAt = r.now;
  m1 = snapshotOf(r).matches[0]!;
  assert.equal(m1.phase, 'running');
  assert.deepEqual(m1.ready, ['A', 'B']);
  assert.deepEqual(m1.clock, { durationMs: 60_000, remainingMs: 60_000, runningSinceMs: startedAt, state: 'running' });
  assert.equal(remainingMsAt(m1.clock, startedAt + 10_000), 50_000);
  assert.deepEqual(m1.adminActions, ['resolve']);

  r.after(10_000, 'player:A', { type: 'pause', matchId: 'M1' });
  m1 = snapshotOf(r).matches[0]!;
  assert.equal(m1.phase, 'paused');
  assert.equal(m1.pauseGeneration, 1);
  assert.deepEqual(m1.clock, { durationMs: 60_000, remainingMs: 50_000, runningSinceMs: null, state: 'frozen' });
  assert.deepEqual(m1.adminActions, ['resolve', 'judgeResume']);
  r.run('player:B', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 });
  assert.deepEqual(snapshotOf(r).matches[0]!.resumeConsents, ['B']);
  r.after(1_000, 'player:A', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 });
  assert.equal(snapshotOf(r).matches[0]!.clock.state, 'running');

  // The timer applies a clockCheck at the deadline as the admin actor, principal 'system'.
  const deadline = r.now + 50_000;
  r.run(ADMIN, { type: 'clockCheck', matchId: 'M1' }, { at: deadline, principalKind: 'system' });
  m1 = snapshotOf(r).matches[0]!;
  assert.equal(m1.phase, 'expired');
  assert.deepEqual(m1.clock, { durationMs: 60_000, remainingMs: 0, runningSinceMs: null, state: 'frozen' });
  assert.deepEqual(m1.adminActions, ['resolve']);
  assert.deepEqual(m1.judge, { reasons: ['expired'], sinceMs: deadline, raisedBy: [] });

  r.after(1_000, ADMIN, { type: 'resolve', matchId: 'M1', winner: 'B', reason: 'Clock expired' });
  m1 = snapshotOf(r).matches[0]!;
  assert.equal(m1.phase, 'final');
  assert.equal(m1.judge, null);
  assert.equal(m1.finalWinner, 'B');
  assert.equal(m1.finalSource, 'admin');
  assert.equal(m1.confirmedBy, null);
  assert.deepEqual(m1.adminActions, ['correct']);

  r.run('player:C', { type: 'ready', matchId: 'M2' }).run('player:D', { type: 'ready', matchId: 'M2' })
    .after(5_000, 'player:C', { type: 'propose', matchId: 'M2', winner: 'C', expectedRevision: 0 });
  let m2 = snapshotOf(r).matches[1]!;
  assert.deepEqual(m2.proposal, { revision: 1, winner: 'C', reporter: 'C', decision: 'open' });
  assert.equal(m2.judge, null);
  r.after(1_000, 'player:D', { type: 'confirm', matchId: 'M2', revision: 1 });
  m2 = snapshotOf(r).matches[1]!;
  assert.equal(m2.finalSource, 'agreed');
  assert.equal(m2.confirmedBy, 'D');
  r.after(1_000, ADMIN, { type: 'correct', matchId: 'M2', winner: 'D', reason: 'Score sheet' });
  m2 = snapshotOf(r).matches[1]!;
  assert.equal(m2.finalSource, 'admin', 'a correction replaces the agreement');
  assert.equal(m2.confirmedBy, null);
  const snapshot = snapshotOf(r);
  assert.equal(snapshot.stage, 'complete');
  assert.deepEqual(snapshot.standings, [
    { seat: 'A', points: 0, rating: 1184 }, { seat: 'B', points: 3, rating: 1216 },
    { seat: 'C', points: 0, rating: 1184 }, { seat: 'D', points: 3, rating: 1216 }]);
});

test('judge: dispute, then a new proposal, keeps attention and reasons until a decision clears them', () => {
  const r = Replay.legacy().published()
    .run('player:A', { type: 'ready', matchId: 'M1' }).run('player:B', { type: 'ready', matchId: 'M1' })
    .after(4_000, 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 })
    .after(1_000, 'player:B', { type: 'dispute', matchId: 'M1', revision: 1 });
  const disputedAt = r.now;
  let m1 = snapshotOf(r).matches[0]!;
  assert.deepEqual(m1.proposal, { revision: 1, winner: 'A', reporter: 'A', decision: 'disputed' });
  assert.deepEqual(m1.judge, { reasons: ['dispute'], sinceMs: disputedAt, raisedBy: ['B'] });

  // cli.ts:47-48: the reporter re-proposes after the dispute; attention is not cleared by a proposal.
  r.after(1_000, 'player:A', { type: 'propose', matchId: 'M1', winner: 'B', expectedRevision: 1 });
  m1 = snapshotOf(r).matches[0]!;
  assert.deepEqual(m1.proposal, { revision: 2, winner: 'B', reporter: 'A', decision: 'open' });
  assert.deepEqual(m1.judge, { reasons: ['dispute'], sinceMs: disputedAt, raisedBy: ['B'] });
  assert.equal(r.state.matches[0].judgeAttention, true);

  r.after(1_000, 'player:A', { type: 'callJudge', matchId: 'M1' });   // no-op: already called, not audited
  r.after(1_000, 'player:B', { type: 'confirm', matchId: 'M1', revision: 2 });
  m1 = snapshotOf(r).matches[0]!;
  assert.equal(m1.judge, null, 'confirm clears attention');
  assert.equal(m1.finalSource, 'agreed');

  // After a correction clears attention, nothing earlier leaks into later judge details.
  r.after(1_000, ADMIN, { type: 'correct', matchId: 'M1', winner: 'A', reason: 'r' });
  assert.equal(snapshotOf(r).matches[0]!.judge, null);
});

test('judge: called, then judge-resume (attention stays), then expiry adds a reason; M2 is unaffected', () => {
  const r = Replay.legacy(30_000).published()
    .run('player:C', { type: 'ready', matchId: 'M2' }).run('player:D', { type: 'ready', matchId: 'M2' })
    .after(2_000, 'player:C', { type: 'pause', matchId: 'M2' })
    .after(1_000, 'player:D', { type: 'callJudge', matchId: 'M2' });
  const calledAt = r.now;
  let m2 = snapshotOf(r).matches[1]!;
  assert.deepEqual(m2.judge, { reasons: ['called'], sinceMs: calledAt, raisedBy: ['D'] });
  assert.deepEqual(m2.adminActions, ['resolve', 'judgeResume']);
  r.after(1_000, ADMIN, { type: 'judgeResume', matchId: 'M2', reason: 'Checked' });
  m2 = snapshotOf(r).matches[1]!;
  assert.equal(m2.phase, 'running');
  assert.deepEqual(m2.judge, { reasons: ['called'], sinceMs: calledAt, raisedBy: ['D'] });
  // An expiry materialized by an ordinary command (not the timer) is still reported from the phase.
  r.after(40_000, 'player:C', { type: 'propose', matchId: 'M2', winner: 'C', expectedRevision: 0 });
  m2 = snapshotOf(r).matches[1]!;
  assert.equal(m2.phase, 'expired');
  assert.deepEqual(m2.judge, { reasons: ['called', 'expired'], sinceMs: calledAt, raisedBy: ['D'] });
  assert.equal(snapshotOf(r).matches[0]!.judge, null);
});

test('an expiry tripped by an ordinary command dates the wait from that command, not from kickoff', () => {
  const r = Replay.legacy(30_000).published()
    .run('player:C', { type: 'ready', matchId: 'M2' }).run('player:D', { type: 'ready', matchId: 'M2' })
    .after(40_000, 'player:C', { type: 'propose', matchId: 'M2', winner: 'C', expectedRevision: 0 });
  const m2 = snapshotOf(r).matches[1]!;
  assert.equal(m2.phase, 'expired');
  assert.deepEqual(m2.judge, { reasons: ['expired'], sinceMs: r.now, raisedBy: [] });
});

test('judge falls back to the match audit or event creation when no raising entry is visible', () => {
  const r = Replay.legacy().published();
  const match = { ...r.state.matches[0], judgeAttention: true, phase: 'paused' as const };
  assert.deepEqual(deriveJudge(match, [], 42), { reasons: [], sinceMs: 42, raisedBy: [] });
  assert.equal(deriveJudge({ ...match, judgeAttention: false }, [], 42), null);
});

test('clock: a persisted running clock of another runner is interrupted; retired events are frozen', () => {
  const r = Replay.legacy().published()
    .run('player:A', { type: 'ready', matchId: 'M1' }).run('player:B', { type: 'ready', matchId: 'M1' }, { runnerId: 'old-runner' });
  const match = r.state.matches[0];
  assert.deepEqual(mapClock(match, 60_000, RUNNER, false),
    { durationMs: 60_000, remainingMs: 60_000, runningSinceMs: r.now, state: 'interrupted' });
  assert.equal(remainingMsAt(mapClock(match, 60_000, RUNNER, false), r.now + 10_000), 60_000, 'never counts down');
  assert.deepEqual(mapClock(match, 60_000, 'old-runner', true),
    { durationMs: 60_000, remainingMs: 60_000, runningSinceMs: null, state: 'frozen' });
  const snapshot = snapshotOf(r);
  assert.equal(snapshot.matches[0]!.clock.state, 'interrupted');
  assert.deepEqual(snapshot.matches[0]!.adminActions, [], 'the domain refuses commands on an interrupted clock');
  assert.deepEqual(snapshot.matches[1]!.adminActions, [], 'store.ts:273 refuses every command while interrupted');
  const retired = mapSnapshot({ state: r.state, session: sessionFor(r.state, { status: 'retired', retired_at_ms: String(T0 + 5) }),
    audit: r.entries(), runnerId: 'old-runner', panelRevision: 9, members: () => undefined });
  assert.equal(retired.status, 'retired');
  assert.equal(retired.retiredAtMs, T0 + 5);
  assert.equal(retired.panelRevision, 0);
  assert.equal(retired.matches[0]!.clock.state, 'frozen');
  assert.deepEqual(retired.matches[0]!.adminActions, []);
});

test('event admin actions follow publish and signup guards', () => {
  const s = Replay.signup();
  assert.deepEqual(eventAdminActions(s.state, IDS.admin, false), [], 'empty open roster');
  s.run(`member:${IDS.a}`, { type: 'signupJoin' });
  assert.deepEqual(eventAdminActions(s.state, IDS.admin, false), ['signupRemove']);
  for (const id of [IDS.b, IDS.c, IDS.d]) s.run(`member:${id}`, { type: 'signupJoin' });
  assert.deepEqual(eventAdminActions(s.state, IDS.admin, false), ['signupClose', 'signupRemove']);
  const withAdmin = { ...s.state, signup: { status: 'open' as const, roster: [IDS.a, IDS.b, IDS.c, IDS.admin] } };
  assert.deepEqual(eventAdminActions(withAdmin, IDS.admin, false), ['signupRemove'], 'admin in roster blocks close');
  s.run(ADMIN, { type: 'signupClose', adminId: IDS.admin });
  assert.deepEqual(eventAdminActions(s.state, IDS.admin, false), ['signupReopen']);
  for (const seat of ['A', 'B', 'C', 'D'] as const) s.run(`player:${seat}`, { type: 'checkin' });
  assert.deepEqual(eventAdminActions(s.state, IDS.admin, false), ['publish', 'signupReopen']);
  assert.deepEqual(eventAdminActions(s.state, IDS.admin, true), [], 'retired or interrupted');
  s.run(ADMIN, { type: 'publish' });
  assert.deepEqual(eventAdminActions(s.state, IDS.admin, false), [], 'no reopen after publication');
  const legacy = Replay.legacy();
  assert.deepEqual(eventAdminActions(legacy.state, IDS.admin, false), []);
  legacy.published();
  assert.deepEqual(eventAdminActions(legacy.state, IDS.admin, false), [], 'published legacy event');
  const ready = Replay.legacy();
  for (const seat of ['A', 'B', 'C', 'D'] as const) ready.run(`player:${seat}`, { type: 'checkin' });
  assert.deepEqual(eventAdminActions(ready.state, IDS.admin, false), ['publish'], 'legacy events publish without signup');
  assert.deepEqual(matchAdminActions(ready.state.matches[0], false), []);
});

test('snapshot: members directory, seats, kind, cards and summaries', () => {
  const s = Replay.signup();
  s.run(`member:${IDS.e}`, { type: 'signupJoin' }, { principalId: IDS.e });
  s.run(ADMIN, { type: 'signupRemove', memberId: IDS.e });
  for (const id of [IDS.a, IDS.b, IDS.c, IDS.d]) s.run(`member:${id}`, { type: 'signupJoin' }, { principalId: id });
  let snapshot = snapshotOf(s, { members: id => id === IDS.a ? { id, displayName: 'Ava', avatarUrl: 'https://cdn.discordapp.com/a.png' } : undefined });
  assert.equal(snapshot.kind, 'signup');
  assert.deepEqual(snapshot.seats, { A: null, B: null, C: null, D: null });
  assert.deepEqual(snapshot.signup, { status: 'open', capacity: 4, roster: [IDS.a, IDS.b, IDS.c, IDS.d] });
  assert.deepEqual(Object.keys(snapshot.members).sort(), [IDS.admin, IDS.a, IDS.b, IDS.c, IDS.d, IDS.e].sort(),
    'the removed member stays named because the audit names them');
  assert.deepEqual(snapshot.members[IDS.a], { id: IDS.a, displayName: 'Ava', avatarUrl: 'https://cdn.discordapp.com/a.png' });
  assert.deepEqual(snapshot.members[IDS.e], { id: IDS.e, displayName: null, avatarUrl: null });
  s.run(ADMIN, { type: 'signupClose', adminId: IDS.admin });
  snapshot = snapshotOf(s);
  assert.deepEqual(snapshot.seats, { A: IDS.a, B: IDS.b, C: IDS.c, D: IDS.d });

  const legacy = Replay.legacy();
  const session = sessionFor(legacy.state, { identity_map: { players: { A: IDS.a, B: IDS.b, C: IDS.c, D: IDS.d }, adminId: IDS.admin,
    matchChannels: { M1: '800000000000000201', M2: '800000000000000202' }, publicMatchRooms: true, stickySuspended: ['M1'] },
    checkin_message_id: '800000000000000301', m1_message_id: '800000000000000302', created_at_ms: String(T0) });
  const legacySnapshot = mapSnapshot({ state: legacy.state, session, audit: [], runnerId: RUNNER, panelRevision: 3, members: () => undefined });
  assert.equal(legacySnapshot.kind, 'legacy', 'schemaVersion 1 without identity kind');
  assert.equal(legacySnapshot.createdAtMs, T0);
  assert.equal(legacySnapshot.panelRevision, 3);
  assert.equal(legacySnapshot.signup, null);
  assert.deepEqual(legacySnapshot.seats, { A: IDS.a, B: IDS.b, C: IDS.c, D: IDS.d });
  assert.deepEqual(legacySnapshot.discord, { guildId: IDS.guild, channelId: IDS.channel,
    matchChannels: { M1: '800000000000000201', M2: '800000000000000202' }, publicMatchRooms: true,
    cards: { checkin: { messageId: '800000000000000301', repostSuspended: false },
      M1: { messageId: '800000000000000302', repostSuspended: true }, M2: { messageId: null, repostSuspended: false } } });
  assert.deepEqual(Object.keys(legacySnapshot.members).sort(), [IDS.admin, IDS.a, IDS.b, IDS.c, IDS.d].sort());

  assert.deepEqual(mapSummary({ event_id: EVENT_ID, status: 'retired', kind: null, schema_version: '2',
    created_at_ms: String(T0), retired_at_ms: T0 + 1, version: 4 }),
  { eventId: EVENT_ID, status: 'retired', kind: 'signup', createdAtMs: T0, retiredAtMs: T0 + 1, version: 4 });
  assert.equal(mapSummary({ event_id: EVENT_ID, status: 'active', kind: 'legacy', schema_version: 1,
    created_at_ms: T0, retired_at_ms: null, version: 0 }).kind, 'legacy');
});
