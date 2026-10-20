// The shared transaction body (runPrincipalCommand) against a recording fake client: check order,
// prior-result semantics and the stored principal columns, without PostgreSQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type pg from 'pg';
import type { PrivateDiscordConfig } from '../discord/config.js';
import type { SessionRow } from '../discord/session.js';
import { createFixture, RuleError, transition, type Command, type EventState, type Outcome } from './domain.js';
import { CommandConflictError, PreconditionFailedError, RetiredSessionError, runPrincipalCommand, UnknownEventError,
  type PrincipalCommandContext } from './store.js';

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

function fakeClient(options: { state?: EventState | null; session?: Partial<SessionRow> | null; prior?: Prior | null } = {}) {
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
  const context: PrincipalCommandContext = { kind: 'discord', config, eventId: EVENT, principalId: config.adminId, interactionId: ids[1]! };
  const fake = fakeClient();
  assert.equal((await runPrincipalCommand(fake.client, context, publish, RUNNER, () => 7_000)).applied, true);
  assert.deepEqual(fake.log, ['lock', 'session', 'prior:event', 'update', 'insert']);
  const insert = fake.writes[1]!;
  assert.deepEqual([insert[2], insert[9], insert[10], insert[11]], [`discord:${ids[1]}`, 'discord', config.adminId, ids[1]]);
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
