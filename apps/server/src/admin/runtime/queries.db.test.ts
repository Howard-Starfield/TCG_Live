import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscordCommand, setupPrivateDiscordSchema, withClient } from '../../rehearsal/store.js';
import type { PrivateDiscordConfig } from '../../discord/config.js';
import { bindCard, prepareSession } from '../../discord/session.js';
import { DiscordAdminRuntime } from './discord-runtime.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888'];
const config: PrivateDiscordConfig = { applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]! };
const optIn = process.env.npm_lifecycle_event === 'test:db';

test('real database: admin reads list, snapshot (active and retired) and page the audit read-only',
  { skip: optIn ? false : 'Real database suite is opt-in: npm run test:db' }, async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
    assert.ok(['upgraded', 'already_ready'].includes(await setupPrivateDiscordSchema()));
    const active = await withClient(client => client.query<{ application_id: string; guild_id: string; channel_id: string }>(
      "SELECT application_id,guild_id,channel_id FROM public.tcg_rehearsal_sessions WHERE status='active'"));
    if (active.rows[0] && (active.rows[0].application_id !== config.applicationId ||
        active.rows[0].channel_id !== config.channelId)) throw new Error('Refusing to replace an active non-test Discord session.');

    const first = await prepareSession(config, true);
    await bindCard(config, first.event_id, 'checkin', ids[0]!);
    const message = { slot: 'checkin' as const, id: ids[0]!, channelId: config.channelId };
    let interaction = 1;
    const run = (principalId: string, command: Parameters<typeof applyDiscordCommand>[1], at: number) =>
      applyDiscordCommand({ config, eventId: first.event_id, principalId, interactionId: `12${String(interaction++).padStart(16, '0')}`,
        ...(principalId === config.adminId ? {} : { message }) }, command, 'db-admin-runner', () => at);
    for (const [index, player] of (['A', 'B', 'C', 'D'] as const).entries())
      assert.equal((await run(config.players[player], { type: 'checkin' }, 1_000 + index)).applied, true);
    assert.equal((await run(config.adminId, { type: 'publish' }, 2_000)).applied, true);
    const second = await prepareSession(config, true);

    const runtime = new DiscordAdminRuntime({ runnerId: 'db-admin-runner', commandsEnabled: false, publicMatchRooms: false });
    try {
      const events = await runtime.listEvents();
      assert.deepEqual(events.slice(0, 2).map(event => [event.eventId, event.status, event.kind, event.version]),
        [[second.event_id, 'active', 'legacy', 0], [first.event_id, 'retired', 'legacy', 5]]);
      assert.equal(typeof events[1]!.createdAtMs, 'number');
      assert.equal(typeof events[1]!.retiredAtMs, 'number');
      assert.equal(await runtime.activeEventId(), second.event_id);
      const retired = await runtime.snapshot(first.event_id);
      assert.equal(retired.status, 'retired');
      assert.equal(retired.stage, 'live');
      assert.deepEqual(retired.checkins, ['A', 'B', 'C', 'D']);
      assert.deepEqual(retired.adminActions, []);
      assert.equal(retired.discord.cards.checkin.messageId, ids[0]);
      assert.deepEqual(Object.keys(retired.members).sort(), [ids[3], ids[4], ids[5], ids[6], ids[7]].sort());
      const current = await runtime.snapshot();
      assert.equal(current.eventId, second.event_id);
      assert.equal(current.status, 'active');
      const page = await runtime.audit(first.event_id, 2, 2);
      assert.deepEqual(page.map(entry => [entry.sequence, entry.via, entry.principalId, entry.actor]),
        [[3, 'discord', ids[5], { kind: 'player', seat: 'C' }], [4, 'discord', ids[6], { kind: 'player', seat: 'D' }]]);
      assert.equal(typeof page[0]!.occurredAtMs, 'number');
      assert.match(page[0]!.commandId, /^discord:12/);
      const publish = await runtime.audit(first.event_id, 4, 500);
      assert.deepEqual(publish.map(entry => [entry.actor, entry.command]), [[{ kind: 'admin' }, { type: 'publish' }]]);
      assert.equal(runtime.status().database, 'ready');
    } finally {
      await runtime.close();
    }
  });
