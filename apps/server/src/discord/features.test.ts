import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayIntentBits } from 'discord.js';
import { createFixture, type Command, type EventState, type Outcome } from '../rehearsal/domain.js';
import { PrivateDiscordController, type CardTransport, type WebAdminRequest } from './controller.js';
import type { PrivateDiscordConfig } from './config.js';
import { discordFeatures } from './feature-registry.js';
import { DiscordFeatureEvents, featureIntents, startDiscordFeatures, type DiscordFeature, type DiscordFeatureContext,
  type MatchLifecycleEvent } from './features.js';
import type { SessionRow } from './session.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888'];
const config = {
  applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]!
} satisfies PrivateDiscordConfig;
const eventId = '11111111-1111-4111-8111-111111111111';
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(applied = true) {
  let state: EventState = createFixture(eventId);
  const session: SessionRow = { event_id: eventId, application_id: config.applicationId, guild_id: config.guildId,
    channel_id: config.channelId, identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: null, m1_message_id: null, m2_message_id: null };
  const transport: CardTransport = { async send() { return ids[0]!; }, async edit() {}, async pin() {}, classify() { return 'retry'; } };
  const controller = new PrivateDiscordController(structuredClone(config), 'runner', transport, async () => ({ state, session }),
    undefined, async () => {}, () => 1_000, undefined, undefined, undefined, undefined, undefined, undefined,
    async (_context, command: Command): Promise<Outcome> => {
      if (applied && (command.type === 'resolve' || command.type === 'confirm')) {
        state = structuredClone(state);
        const match = state.matches.find(item => item.id === command.matchId)!;
        match.phase = 'final';
        match.finalWinner = command.type === 'resolve' ? command.winner : match.players[0];
      }
      if (applied) state = { ...state, version: state.version + 1 };
      return { eventId, version: state.version, applied, result: applied ? command.type : 'not_allowed' };
    });
  const request = (command: Command): WebAdminRequest => ({ eventId, principalId: 'local-admin', commandId: 'web:x', content: '{}',
    precondition: () => true, command });
  return { controller, request };
}

test('the controller emits judge, dispute, resume and resolve events after commits without changing results', async () => {
  const quiet = harness();
  const observed = harness();
  const events: MatchLifecycleEvent[] = [];
  observed.controller.onMatchEvent(event => events.push(event));
  observed.controller.onMatchEvent(() => { throw Error('a broken feature must not affect commands'); });
  try {
    const commands: Command[] = [
      { type: 'callJudge', matchId: 'M1' },
      { type: 'dispute', matchId: 'M1', revision: 2 },
      { type: 'judgeResume', matchId: 'M1', reason: 'ok' },
      { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'judge' },
      { type: 'ready', matchId: 'M2' }
    ];
    for (const command of commands) {
      const expected = await quiet.controller.applyAdmin(quiet.request(command));
      const actual = await observed.controller.applyAdmin(observed.request(command));
      assert.deepEqual(actual, expected, `same result for ${command.type}`);
    }
    await settle();
    assert.deepEqual(events, [
      { type: 'judgeCalled', eventId, matchId: 'M1', reason: 'called', requestedBy: 'local-admin', occurredAtMs: 1_000 },
      { type: 'disputeOpened', eventId, matchId: 'M1', revision: 2, requestedBy: 'local-admin', occurredAtMs: 1_000 },
      { type: 'judgeResumed', eventId, matchId: 'M1', occurredAtMs: 1_000 },
      { type: 'matchResolved', eventId, matchId: 'M1', winner: 'A', source: 'admin', occurredAtMs: 1_000 }
    ]);
  } finally { await Promise.all([quiet.controller.stop(), observed.controller.stop()]); }
});

test('refused commands emit nothing', async () => {
  const { controller, request } = harness(false);
  const events: MatchLifecycleEvent[] = [];
  controller.onMatchEvent(event => events.push(event));
  try {
    await controller.applyAdmin(request({ type: 'callJudge', matchId: 'M1' }));
    await settle();
    assert.deepEqual(events, []);
  } finally { await controller.stop(); }
});

test('registered features are fresh per call; failing features are isolated and stop in reverse order', async () => {
  const names = discordFeatures().map(item => item.name);
  assert.ok(names.includes('automod'));
  assert.equal(new Set(names).size, names.length);
  assert.notEqual(discordFeatures()[0], discordFeatures()[0]);
  const order: string[] = [];
  const logged: string[] = [];
  const feature = (name: string, fail = false): DiscordFeature => ({ name, intents: [GatewayIntentBits.GuildVoiceStates],
    start() { order.push(`start:${name}`); if (fail) throw Error('token=secret'); }, stop() { order.push(`stop:${name}`); } });
  assert.deepEqual(featureIntents([feature('a'), feature('b')]), [GatewayIntentBits.GuildVoiceStates]);
  const context = { isActive: () => true, log: (message: string) => logged.push(message) } as unknown as DiscordFeatureContext;
  const handle = await startDiscordFeatures([feature('a'), feature('broken', true), feature('c')], context);
  assert.deepEqual(handle.started, ['a', 'c']);
  await handle.stop();
  await handle.stop();
  assert.deepEqual(order, ['start:a', 'start:broken', 'stop:broken', 'start:c', 'stop:c', 'stop:a']);
  assert.deepEqual(logged, ['Discord feature broken could not start; continuing without it.']);
});

test('the feature event bus is typed, isolated and unsubscribable', async () => {
  const bus = new DiscordFeatureEvents();
  const seen: string[] = [];
  const off = bus.on('matchRoomAssigned', event => seen.push(event.channelId));
  bus.on('matchRoomAssigned', () => { throw Error('ignored'); });
  bus.on('voiceBotsChanged', () => seen.push('bots'));
  bus.emit({ type: 'matchRoomAssigned', eventId, matchId: 'M3', channelId: ids[0]!, occurredAtMs: 1 });
  bus.emit({ type: 'voiceBotsChanged' });
  await settle();
  off();
  bus.emit({ type: 'matchRoomAssigned', eventId, matchId: 'M3', channelId: ids[1]!, occurredAtMs: 1 });
  await settle();
  assert.deepEqual(seen, [ids[0], 'bots']);
});
