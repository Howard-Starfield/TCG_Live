// The shared transaction body (runPrincipalCommand) against a recording fake client: check order,
// prior-result semantics and the stored principal columns, without PostgreSQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import type { PrivateDiscordConfig } from '../discord/config.js';
import type { SessionRow } from '../discord/session.js';
import { createFixture, RuleError, transition, type Command, type EventState, type Outcome } from './domain.js';
import { STAFF_DENIED } from '../discord/staff.js';
import { CommandConflictError, PreconditionFailedError, resetSnapshotColumnCache, RetiredSessionError, runPrincipalCommand, UnknownEventError,
  type PrincipalCommandContext } from './store.js';
import { StaffConflictError } from './domain.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888'];
const config: PrivateDiscordConfig = { applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]! };
const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = 'web:0f8fad5b-d9cb-469f-a165-70867728950e';
const RUNNER = 'runner';

interface Prior { event_id: string; command_hash: string; outcome: Outcome }

function checkedIn(): EventState {
  let state = createFixture(EVENT);
  for (const seat of ['A', 'B', 'C', 'D'] as const) state = transition(state, `player:${seat}`, { type: 'checkin' }, 1, RUNNER).state;
  return state;
}

function fakeClient(options: { state?: EventState | null; session?: Partial<SessionRow> | null; prior?: Prior | null;
  /** Migration 016 has run (the actor_snapshot column exists). */ column?: boolean } = {}) {
  resetSnapshotColumnCache();
  const log: string[] = [];
  const writes: unknown[][] = [];
  const state = options.state === undefined ? checkedIn() : options.state;
  const session: SessionRow | null = options.session === null ? null : {
    event_id: EVENT, application_id: config.applicationId, guild_id: config.guildId, channel_id: config.channelId,
    identity_map: { players: config.players!, adminId: config.adminId }, status: 'active',
    checkin_message_id: ids[0]!, m1_message_id: null, m2_message_id: null, ...options.session };
  const client = {
    async query(text: string, values: unknown[] = []) {
      if (/FOR UPDATE/.test(text)) { log.push('lock'); return { rows: state ? [{ state, version: state.version }] : [] }; }
      if (/FROM public\.tcg_rehearsal_audit WHERE command_id = \$1$/.test(text)) {
        log.push('prior:global'); return { rows: options.prior ? [options.prior] : [] };
      }
      if (/FROM public\.tcg_rehearsal_audit WHERE event_id = \$1 AND command_id = \$2/.test(text)) {
        log.push('prior:event'); return { rows: options.prior && options.prior.event_id === values[0] ? [options.prior] : [] };
      }
      if (/FROM public\.tcg_rehearsal_sessions/.test(text)) { log.push('session'); return { rows: session ? [session] : [] }; }
      if (/information_schema\.columns/.test(text)) { log.push('column'); return { rows: options.column ? [{ '?column?': 1 }] : [] }; }
      if (/^UPDATE/.test(text)) { log.push('update'); writes.push(values); return { rows: [] }; }
      if (/^INSERT/.test(text)) { log.push('insert'); writes.push(values); return { rows: [] }; }
      throw new Error(`unexpected query: ${text}`);
    }
  };
  return { client: client as unknown as Pick<pg.Client, 'query'>, log, writes };
}

function web(precondition: (state: EventState) => boolean = () => true, log?: string[]): PrincipalCommandContext {
  return { kind: 'web', config, eventId: EVENT, principalId: 'local-admin', commandId: COMMAND_ID, content: '["content"]',
    precondition: state => { log?.push('precondition'); return precondition(state); } };
}

const webHash = createHash('sha256').update(JSON.stringify(['web', 'local-admin', '["content"]'])).digest('hex');
const publish: Command = { type: 'publish' };

/** M1 (A vs B) and M2 (C vs D) both running under RUNNER. */
function running(): EventState {
  let state = checkedIn();
  state = transition(state, 'admin:fixture', { type: 'publish' }, 2, RUNNER).state;
  for (const seat of ['A', 'B', 'C', 'D'] as const)
    state = transition(state, `player:${seat}`, { type: 'ready', matchId: seat === 'A' || seat === 'B' ? 'M1' : 'M2' }, 3, RUNNER).state;
  return state;
}
/** The operator's ID is also seated as player A: the organizer plays. */
const playing = { ...config, adminId: config.players!.A };
const playingSession = { identity_map: { players: config.players!, adminId: playing.adminId } };
const resolveM1: Command = { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'r' };
const resolveM2: Command = { type: 'resolve', matchId: 'M2', winner: 'C', reason: 'r' };
const slash = (principalId: string, role: 'organizer' | 'judge', extra: Partial<Extract<PrincipalCommandContext, { kind: 'discord' }>> = {}):
  PrincipalCommandContext => ({ kind: 'discord', config, eventId: EVENT, principalId, interactionId: ids[1]!,
    actor: { role, via: 'role' }, ...extra });
/** The same, in the session where the operator's ID is seated. */
const playingSlash = (principalId: string, role: 'organizer' | 'judge') => slash(principalId, role, { config: playing });

test('web: lock, prior result, session, precondition, then the domain apply; stored as principal_kind web', async () => {
  const fake = fakeClient();
  const outcome = await runPrincipalCommand(fake.client, web(() => true, fake.log), publish, RUNNER, () => 5_000);
  assert.deepEqual(outcome, { eventId: EVENT, version: 5, result: 'publish', applied: true });
  assert.deepEqual(fake.log, ['lock', 'prior:global', 'session', 'precondition', 'update', 'insert']);
  const insert = fake.writes[1]!;
  assert.deepEqual([insert[2], insert[3], insert[4], insert[9], insert[10], insert[11]],
    [COMMAND_ID, 'admin:fixture', webHash, 'web', 'local-admin', null]);
  assert.equal(insert[7], 5_000);
});

test('web: a stored result with the same content is returned before the session and precondition checks', async () => {
  const stored: Outcome = { eventId: EVENT, version: 5, result: 'publish', applied: true };
  for (const session of [{}, { status: 'retired' as const }]) {
    const fake = fakeClient({ prior: { event_id: EVENT, command_hash: webHash, outcome: stored }, session });
    assert.deepEqual(await runPrincipalCommand(fake.client, web(() => false, fake.log), publish, RUNNER, () => 6_000), stored);
    assert.deepEqual(fake.log, ['lock', 'prior:global'], 'no session read, no precondition, no write');
  }
  const changed = fakeClient({ prior: { event_id: EVENT, command_hash: 'other', outcome: stored } });
  await assert.rejects(runPrincipalCommand(changed.client, web(), publish, RUNNER, () => 6_000), CommandConflictError);
  const elsewhere = fakeClient({ prior: { event_id: OTHER, command_hash: webHash, outcome: stored } });
  await assert.rejects(runPrincipalCommand(elsewhere.client, web(), publish, RUNNER, () => 6_000), CommandConflictError,
    'the same browser UUID under another event');
  assert.deepEqual(changed.writes, []);
});

test('web: refusals are typed; the precondition runs under the lock and a mismatch writes nothing', async () => {
  const stale = fakeClient();
  await assert.rejects(runPrincipalCommand(stale.client, web(() => false, stale.log), publish, RUNNER, () => 1), PreconditionFailedError);
  assert.deepEqual(stale.log, ['lock', 'prior:global', 'session', 'precondition']);
  await assert.rejects(runPrincipalCommand(fakeClient({ state: null }).client, web(), publish, RUNNER, () => 1), UnknownEventError);
  await assert.rejects(runPrincipalCommand(fakeClient({ session: null }).client, web(), publish, RUNNER, () => 1), UnknownEventError,
    'a CLI event without a session is unknown to the console');
  await assert.rejects(runPrincipalCommand(fakeClient({ session: { status: 'retired' } }).client, web(), publish, RUNNER, () => 1),
    RetiredSessionError);
  await assert.rejects(runPrincipalCommand(fakeClient({ session: { guild_id: ids[5]! } }).client, web(), publish, RUNNER, () => 1),
    /configuration differs/);
  const rule = fakeClient({ state: createFixture(EVENT) });
  await assert.rejects(runPrincipalCommand(rule.client, web(), publish, RUNNER, () => 1),
    (error: unknown) => error instanceof RuleError && error.message === 'Fixture round requires four check-ins and one publication.');
  assert.deepEqual(rule.writes, []);
  await assert.rejects(runPrincipalCommand(fakeClient().client, web(), { type: 'signupClose', adminId: ids[3]! }, RUNNER, () => 1),
    /Signup action requires a signup session|Signup admin identity differs/);
});

test('web: identity is validated before any query; only admin commands are accepted', async () => {
  for (const [context, command, pattern] of [
    [{ ...web(), commandId: 'web:not-a-uuid' }, publish, /console command ID/],
    [{ ...web(), commandId: 'discord:123' }, publish, /console command ID/],
    [web(), { type: 'checkin' }, /Console principal action denied/],
    [web(), { type: 'clockCheck', matchId: 'M1' }, /Console principal action denied/]
  ] as Array<[PrincipalCommandContext, Command, RegExp]>) {
    const fake = fakeClient();
    await assert.rejects(runPrincipalCommand(fake.client, context, command, RUNNER, () => 1), pattern);
    assert.deepEqual(fake.log, []);
  }
});

test('discord: the historical order (session and actor checks before the prior lookup) and stored columns are unchanged', async () => {
  const context: PrincipalCommandContext = { kind: 'discord', config, eventId: EVENT, principalId: config.adminId, interactionId: ids[1]!,
    actor: { role: 'organizer', via: 'owner' } };
  const fake = fakeClient();
  assert.equal((await runPrincipalCommand(fake.client, context, publish, RUNNER, () => 7_000)).applied, true);
  assert.deepEqual(fake.log, ['lock', 'session', 'prior:event', 'update', 'column', 'insert']);
  const insert = fake.writes[1]!;
  assert.deepEqual([insert[2], insert[3], insert[9], insert[10], insert[11]],
    [`discord:${ids[1]}`, `organizer:${config.adminId}`, 'discord', config.adminId, ids[1]]);
  assert.equal(insert.length, 12, 'no snapshot before migration 016');
  // A replayed interaction after retirement is still refused, as before.
  const hash = createHash('sha256').update(JSON.stringify([config.adminId, publish])).digest('hex');
  const retired = fakeClient({ session: { status: 'retired' },
    prior: { event_id: EVENT, command_hash: hash, outcome: { eventId: EVENT, version: 5, result: 'publish', applied: true } } });
  await assert.rejects(runPrincipalCommand(retired.client, context, publish, RUNNER, () => 7_000),
    (error: unknown) => error instanceof RetiredSessionError && error.message === 'Private Discord session is retired.');
  const missing = fakeClient({ state: null });
  await assert.rejects(runPrincipalCommand(missing.client, context, publish, RUNNER, () => 1),
    (error: unknown) => error instanceof UnknownEventError && error.message === 'Unknown private Discord event.');
  const timer: PrincipalCommandContext = { kind: 'discord', config, eventId: EVENT, principalId: 'system:timer',
    timer: { matchId: 'M1', pauseGeneration: 0, deadlineMs: 1 } };
  const early = fakeClient();
  assert.deepEqual(await runPrincipalCommand(early.client, timer, { type: 'clockCheck', matchId: 'M1' }, RUNNER, () => 1),
    { eventId: EVENT, version: 4, result: 'obsolete_or_early_timer', applied: false });
});

test('discord slash: a verified staff role acts as organizer:<id> or judge:<id>; without one it is refused', async () => {
  const state = running();
  const judge = fakeClient({ state, column: true });
  const outcome = await runPrincipalCommand(judge.client, slash(ids[7]!, 'judge', { actor: { role: 'judge', via: 'legacy-staff-role',
    username: 'judy\u0007', displayName: `  ${'x'.repeat(150)}  `, roleName: 'TCG Judge' } }), resolveM2, RUNNER, () => 5_000);
  assert.equal(outcome.applied, true);
  const insert = judge.writes[1]!;
  assert.equal(insert[3], `judge:${ids[7]}`);
  assert.deepEqual(JSON.parse(insert[12] as string), { v: 1, userId: ids[7], username: 'judy', displayName: 'x'.repeat(100),
    role: 'judge', via: 'legacy-staff-role', roleName: 'TCG Judge' });
  const organizerResolve = fakeClient({ state: running(), column: true });
  await runPrincipalCommand(organizerResolve.client, slash(ids[7]!, 'organizer'), resolveM1, RUNNER, () => 5_000);
  assert.equal(organizerResolve.writes[1]![3], `organizer:${ids[7]}`);
  const none = fakeClient({ state });
  await assert.rejects(runPrincipalCommand(none.client, { kind: 'discord', config, eventId: EVENT, principalId: ids[7]!,
    interactionId: ids[1]! }, resolveM2, RUNNER, () => 5_000), (error: unknown) => error instanceof RuleError && error.message === STAFF_DENIED);
  assert.deepEqual(none.writes, []);
});

test('discord slash: the snapshot is written once migration 016 has run, skipped before it, and never changes the command hash', async () => {
  const withColumn = fakeClient({ state: running(), column: true });
  await runPrincipalCommand(withColumn.client, slash(ids[7]!, 'judge', { snapshot: { username: 'u', displayName: 'd' } }), resolveM2, RUNNER, () => 5_000);
  const before = fakeClient({ state: running(), column: false });
  await runPrincipalCommand(before.client, slash(ids[7]!, 'judge', { snapshot: { username: 'u', displayName: 'd' } }), resolveM2, RUNNER, () => 5_000);
  assert.equal(withColumn.writes[1]!.length, 13);
  assert.equal(before.writes[1]!.length, 12, 'the column is detected, not assumed');
  assert.match(String(withColumn.writes[1]![5]), /resolve/);
  assert.equal(withColumn.writes[1]![4], before.writes[1]![4], 'same command hash with or without a snapshot');
  assert.equal(JSON.parse(withColumn.writes[1]![12] as string).displayName, 'd');
  const staff = fakeClient({ state: checkedIn(), column: true });
  await runPrincipalCommand(staff.client, slash(ids[7]!, 'organizer'), { type: 'publish' }, RUNNER, () => 5_000);
  assert.equal(staff.writes[1]!.length, 13, 'a staff command carries a snapshot');
  const timer: PrincipalCommandContext = { kind: 'discord', config, eventId: EVENT, principalId: 'system:timer',
    timer: { matchId: 'M1', pauseGeneration: 0, deadlineMs: 60_003 } };
  const timed = fakeClient({ state: running(), column: true });
  await runPrincipalCommand(timed.client, timer, { type: 'clockCheck', matchId: 'M1' }, RUNNER, () => 90_000);
  assert.equal(timed.writes[1]!.length, 12, 'system rows carry no snapshot');
  assert.equal(timed.writes[1]![3], 'admin:fixture');
});

test('discord card controls act as the member, even for a staff member who plays', async () => {
  const state = checkedIn();
  const fresh = createFixture(EVENT);
  const button = (principalId: string): PrincipalCommandContext => ({ kind: 'discord', config: playing, eventId: EVENT, principalId,
    interactionId: ids[1]!, message: { slot: 'checkin', id: ids[0]!, channelId: config.channelId } });
  const seated = fakeClient({ state: fresh, session: playingSession });
  const outcome = await runPrincipalCommand(seated.client, button(playing.adminId), { type: 'checkin' }, RUNNER, () => 5_000);
  assert.equal(outcome.applied, true);
  assert.equal(seated.writes[1]![3], 'player:A', 'the seated organizer acts as the player, not the admin');
  const stranger = fakeClient({ state, session: playingSession });
  await assert.rejects(runPrincipalCommand(stranger.client, button(ids[7]!), { type: 'checkin' }, RUNNER, () => 5_000),
    /Discord actor is not in the private fixture/);
});

test('conflict rule: staff seated in a match cannot rule on it from Discord or the dashboard, but can on another match', async () => {
  const state = running();
  for (const command of [resolveM1, { type: 'correct', matchId: 'M1', winner: 'B', reason: 'r' },
    { type: 'judgeResume', matchId: 'M1', reason: 'r' }, { type: 'judgeClose', matchId: 'M1', reason: 'r' }] as Command[]) {
    const discord = fakeClient({ state, session: playingSession });
    await assert.rejects(runPrincipalCommand(discord.client, playingSlash(playing.adminId, 'organizer'), command, RUNNER, () => 5_000),
      (error: unknown) => error instanceof StaffConflictError && error.matchId === 'M1' &&
        error.message === 'You are playing in M1, so another organizer or judge must rule on it.', command.type);
    assert.deepEqual(discord.writes, []);
    const dashboard = fakeClient({ state, session: playingSession });
    await assert.rejects(runPrincipalCommand(dashboard.client, { ...web(), config: playing }, command, RUNNER, () => 5_000),
      (error: unknown) => error instanceof StaffConflictError && /Add a TCG Judge in Admin tools > Settings > Tournament roles\.$/.test(error.message), command.type);
  }
  // Another match is fine for the seated staff member and the dashboard.
  const other = fakeClient({ state, session: playingSession });
  assert.equal((await runPrincipalCommand(other.client, playingSlash(playing.adminId, 'organizer'), resolveM2, RUNNER, () => 5_000)).applied, true);
  assert.equal(other.writes[1]![3], `organizer:${playing.adminId}`);
  const webOther = fakeClient({ state, session: playingSession });
  assert.equal((await runPrincipalCommand(webOther.client, { ...web(), config: playing }, resolveM2, RUNNER, () => 5_000)).applied, true);
  // A staff member who does not play (and a dashboard with an operator who does not) is never in conflict.
  const bystander = fakeClient({ state, session: playingSession });
  assert.equal((await runPrincipalCommand(bystander.client, playingSlash(ids[7]!, 'judge'), resolveM1, RUNNER, () => 5_000)).applied, true);
  const webFree = fakeClient({ state });
  assert.equal((await runPrincipalCommand(webFree.client, web(), resolveM1, RUNNER, () => 5_000)).applied, true);
});

test('conflict rule: it runs before the prior-result replay, so a replay after a conflict is still refused', async () => {
  const state = running();
  const context = playingSlash(playing.adminId, 'organizer');
  const hash = createHash('sha256').update(JSON.stringify([playing.adminId, resolveM1])).digest('hex');
  const stored: Outcome = { eventId: EVENT, version: 5, result: 'resolve', applied: true };
  const replayed = fakeClient({ state, session: playingSession, prior: { event_id: EVENT, command_hash: hash, outcome: stored } });
  await assert.rejects(runPrincipalCommand(replayed.client, context, resolveM1, RUNNER, () => 5_000), StaffConflictError);
  assert.equal(replayed.log.includes('prior:event'), false, 'refused before the replay lookup');
  const again = fakeClient({ state, session: playingSession });
  await assert.rejects(runPrincipalCommand(again.client, context, resolveM1, RUNNER, () => 5_000), StaffConflictError);
  await assert.rejects(runPrincipalCommand(fakeClient({ state, session: playingSession }).client, context, resolveM1, RUNNER, () => 5_000), StaffConflictError);
});
