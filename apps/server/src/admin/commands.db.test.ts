import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AdminCommandRequestDto } from '@tcg-live/core';
import type { PrivateDiscordConfig } from '../discord/config.js';
import { bindCard, prepareSession } from '../discord/session.js';
import { RuleError } from '../rehearsal/domain.js';
import { applyDiscordCommand, applyWebCommand, CommandConflictError, PreconditionFailedError, RetiredSessionError,
  setupPrivateDiscordSchema, UnknownEventError, withClient } from '../rehearsal/store.js';
import { commandContent, LOCAL_ADMIN, parseCommandRequest, preconditionHolds, toDomainCommand, webCommandId } from './commands.js';
import { DiscordAdminRuntime } from './runtime/discord-runtime.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888'];
const config: PrivateDiscordConfig = { applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]! };
const optIn = process.env.npm_lifecycle_event === 'test:db';
const RUNNER = 'db-web-runner';

/** The DiscordAdminRuntime path without a controller: parse, map, then the shared store body. */
function web(body: unknown, at: number) {
  const request: AdminCommandRequestDto = parseCommandRequest(body);
  return applyWebCommand({ config, eventId: request.eventId, principalId: LOCAL_ADMIN.id, commandId: webCommandId(request.commandId),
    content: commandContent(request), precondition: state => preconditionHolds(state, request.precondition) },
  toDomainCommand(request.command, config.adminId), RUNNER, () => at);
}

test('real database: console commands share the Discord transaction body, replay stored results and check preconditions under the lock',
  { skip: optIn ? false : 'Real database suite is opt-in: npm run test:db' }, async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
    assert.ok(['upgraded', 'already_ready'].includes(await setupPrivateDiscordSchema()));
    const active = await withClient(client => client.query<{ application_id: string; channel_id: string }>(
      "SELECT application_id,channel_id FROM public.tcg_rehearsal_sessions WHERE status='active'"));
    if (active.rows[0] && (active.rows[0].application_id !== config.applicationId || active.rows[0].channel_id !== config.channelId))
      throw new Error('Refusing to replace an active non-test Discord session.');

    const session = await prepareSession(config, true);
    const eventId = session.event_id;
    await bindCard(config, eventId, 'checkin', ids[0]!);
    for (const [index, player] of (['A', 'B', 'C', 'D'] as const).entries())
      assert.equal((await applyDiscordCommand({ config, eventId, principalId: config.players![player],
        interactionId: `13${String(index + 1).padStart(16, '0')}`, message: { slot: 'checkin', id: ids[0]!, channelId: config.channelId } },
      { type: 'checkin' }, RUNNER, () => 1_000 + index)).applied, true);

    const commandId = randomUUID();
    const publish = { commandId, eventId, command: { type: 'publish' }, precondition: { eventVersion: 4 } };
    const first = await web(publish, 2_000);
    assert.deepEqual(first, { eventId, version: 5, result: 'publish', applied: true });
    // A retry is answered from the stored row although eventVersion 4 no longer holds.
    assert.deepEqual(await web(publish, 2_500), first);
    // Two concurrent retries serialize on the FOR UPDATE lock and both see the stored result.
    assert.deepEqual(await Promise.all([web(publish, 2_600), web(publish, 2_700)]), [first, first]);
    await assert.rejects(web({ ...publish, precondition: { eventVersion: 5 } }, 3_000), CommandConflictError);
    await assert.rejects(web({ ...publish, commandId: randomUUID() }, 3_000), PreconditionFailedError);
    await assert.rejects(web({ ...publish, commandId: randomUUID(), precondition: { eventVersion: 5 } }, 3_000),
      (error: unknown) => error instanceof RuleError && /four check-ins and one publication/.test(error.message));
    await assert.rejects(web({ ...publish, commandId: randomUUID(), eventId: randomUUID() }, 3_000), UnknownEventError);

    const reason = await web({ commandId: randomUUID(), eventId, command: { type: 'resolve', matchId: 'M1', winner: 'B', reason: '  Ruling  ' },
      precondition: { match: { matchId: 'M1', phase: 'setup', proposalRevision: null, finalWinner: null, pauseGeneration: 0 } } }, 3_500)
      .catch((error: unknown) => error);
    assert.ok(reason instanceof RuleError && reason.message === 'Admin resolution is unavailable.', 'resolve during setup is a rule error');

    const rows = await withClient(client => client.query<{ command_id: string; principal_kind: string; principal_id: string;
      interaction_id: string | null; actor_id: string }>(
      'SELECT command_id, principal_kind, principal_id, interaction_id, actor_id FROM public.tcg_rehearsal_audit WHERE event_id = $1 ORDER BY sequence',
      [eventId]));
    assert.equal(rows.rows.length, 5, 'four check-ins and one publication; no duplicate, no refused rows');
    assert.deepEqual(rows.rows[4], { command_id: `web:${commandId}`, principal_kind: 'web', principal_id: 'local-admin',
      interaction_id: null, actor_id: 'admin:fixture' });

    const runtime = new DiscordAdminRuntime({ runnerId: RUNNER, commandsEnabled: true, publicMatchRooms: false });
    try {
      const entry = (await runtime.audit(eventId, 4, 10))[0]!;
      assert.deepEqual([entry.via, entry.principalId, entry.actor, entry.commandId], ['web', 'local-admin', { kind: 'admin' }, `web:${commandId}`]);
    } finally {
      await runtime.close();
    }

    // Two concurrent FIRST attempts with one command ID: one applies, the other waits on the FOR UPDATE
    // lock, finds the stored row and replays it. Both answer with the same outcome; one audit row.
    await bindCard(config, eventId, 'M2', ids[1]!);
    for (const [index, player] of (['C', 'D'] as const).entries())
      assert.equal((await applyDiscordCommand({ config, eventId, principalId: config.players![player],
        interactionId: `14${String(index + 1).padStart(16, '0')}`, message: { slot: 'M2', id: ids[1]!, channelId: config.channelId } },
      { type: 'ready', matchId: 'M2' }, RUNNER, () => 5_000)).applied, true);
    const raceId = randomUUID();
    const race = { commandId: raceId, eventId, command: { type: 'resolve', matchId: 'M2', winner: 'C', reason: 'Race.' },
      precondition: { match: { matchId: 'M2', phase: 'running', proposalRevision: null, finalWinner: null, pauseGeneration: 0 } } };
    const [left, right] = await Promise.all([web(race, 5_100), web(race, 5_200)]);
    assert.deepEqual(left, { eventId, version: 8, result: 'resolve', applied: true });
    assert.deepEqual(right, left);
    const raced = await withClient(client => client.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.tcg_rehearsal_audit WHERE command_id = $1', [`web:${raceId}`]));
    assert.equal(raced.rows[0]?.count, 1, 'one audit row for the raced command ID');

    await prepareSession(config, true);
    // The stored success is still returned after retirement; a new command on the retired event is refused.
    assert.deepEqual(await web(publish, 4_000), first);
    await assert.rejects(web({ commandId: randomUUID(), eventId, command: { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'x' },
      precondition: { match: { matchId: 'M1', phase: 'setup', proposalRevision: null, finalWinner: null, pauseGeneration: 0 } } }, 4_000),
    RetiredSessionError);
  });
