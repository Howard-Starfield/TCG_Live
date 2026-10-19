// Controller subscribe()/status() for the admin console, using fakes modeled on discord/controller.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixture, type Command, type EventState, type Outcome } from '../../rehearsal/domain.js';
import { buttonId } from '../../discord/cards.js';
import type { PrivateDiscordConfig } from '../../discord/config.js';
import { PrivateDiscordController, type CardTransport, type ControllerChange, type PrivateInteraction } from '../../discord/controller.js';
import type { SessionRow } from '../../discord/session.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888'];
const config = {
  applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]!
} satisfies PrivateDiscordConfig;
const eventId = '11111111-1111-4111-8111-111111111111';

function fixture(options: { failEdit?: boolean; gateEdit?: Promise<void> } = {}) {
  let state: EventState = createFixture(eventId);
  let session: SessionRow = { event_id: eventId, application_id: config.applicationId,
    guild_id: config.guildId, channel_id: config.channelId,
    identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: null, m1_message_id: null, m2_message_id: null };
  const calls: string[] = [];
  const actions: Command[] = [];
  let sent = 0;
  const transport: CardTransport = {
    async send(_payload, slot) { calls.push(`send:${slot}`); sent++; return String(500000000000000000n + BigInt(sent)); },
    async edit(id) {
      calls.push(`edit:${id}`);
      if (options.gateEdit) await options.gateEdit;
      if (options.failEdit) throw new Error('retry');
    },
    async pin(id) { calls.push(`pin:${id}`); },
    classify() { return 'retry'; }
  };
  const controller = new PrivateDiscordController(config, 'runner', transport,
    async () => ({ state, session }),
    async (_context, command) => {
      actions.push(command);
      state = { ...state, version: state.version + 1 };
      return { eventId, version: state.version, applied: true, result: command.type } satisfies Outcome;
    },
    async (_config, _eventId, slot, id) => {
      session = { ...session, [slot === 'checkin' ? 'checkin_message_id' : slot === 'M1' ? 'm1_message_id' : 'm2_message_id']: id };
    }, Date.now, 60_000);
  return { controller, calls, actions, get session() { return session; }, set session(next: SessionRow) { session = next; } };
}

function refresh(replies: string[]): PrivateInteraction {
  return { id: ids[0]!, applicationId: config.applicationId, guildId: config.guildId, channelId: config.channelId,
    userId: config.adminId, kind: 'command', subcommand: 'refresh', acknowledge: async () => {},
    reply: async text => { replies.push(text); } };
}

function checkinButton(f: ReturnType<typeof fixture>, replies: string[]): PrivateInteraction {
  return { id: ids[1]!, applicationId: config.applicationId, guildId: config.guildId, channelId: config.channelId,
    userId: config.players.A, kind: 'button', customId: buttonId(eventId, 'checkin', 'checkin'),
    messageId: f.session.checkin_message_id ?? undefined, acknowledge: async () => {},
    reply: async text => { replies.push(text); } };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5));
}

async function scenario(subscribe: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  subscribe(f);
  const replies: string[] = [];
  await f.controller.handle(refresh(replies));
  await f.controller.handle(checkinButton(f, replies));
  await settle();
  const result = { replies, calls: [...f.calls], actions: [...f.actions], session: f.session };
  await f.controller.stop();
  return result;
}

test('a throwing subscriber leaves Discord replies, card refreshes and commits unchanged', async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', onUncaught);
  try {
    const baseline = await scenario(() => {});
    const seen: ControllerChange[] = [];
    const withThrowing = await scenario(f => {
      f.controller.subscribe(() => { throw new Error('subscriber failure'); });
      f.controller.subscribe(change => { seen.push(change); });
    });
    assert.deepEqual(withThrowing, baseline);
    assert.deepEqual(baseline.replies, ['Practice cards refreshed.', 'Saved: checkin.']);
    assert.ok(seen.some(change => change.type === 'event' && change.eventId === eventId), 'later subscribers still notified');
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('notifications are delivered from microtasks, never synchronously inside controller code', async () => {
  const f = fixture();
  f.session = { ...f.session, checkin_message_id: ids[5]! };
  let synchronous = true;
  const delivered: Array<{ change: ControllerChange; synchronous: boolean }> = [];
  f.controller.subscribe(change => { delivered.push({ change, synchronous }); });
  const replies: string[] = [];
  const handling = f.controller.handle(checkinButton(f, replies));
  synchronous = false;
  await handling;
  await settle();
  assert.ok(delivered.length > 0);
  assert.ok(delivered.every(item => !item.synchronous));
  assert.ok(delivered.some(item => item.change.type === 'event'));
  await f.controller.stop();
});

test('panelRevision moves on card binds and sticky reposts, not on commands; unsubscribe stops delivery', async () => {
  const f = fixture();
  const changes: ControllerChange[] = [];
  const unsubscribe = f.controller.subscribe(change => { changes.push(change); });
  assert.deepEqual(f.controller.status(), { updatePending: false, panelRevision: 0 });
  await f.controller.handle(refresh([]));
  await settle();
  assert.equal(f.controller.status().panelRevision, 3, 'three cards created and bound');
  assert.equal(changes.filter(change => change.type === 'panels').length, 3);
  await f.controller.handle(checkinButton(f, []));
  await settle();
  assert.equal(f.controller.status().panelRevision, 3, 'a committed command bumps the event version instead');
  unsubscribe();
  const before = changes.length;
  await f.controller.handle(refresh([]));
  await settle();
  assert.equal(changes.length, before);
  await f.controller.stop();
});

test('sticky repost suspend, replace and complete each move panelRevision', async () => {
  const routed: PrivateDiscordConfig = { ...config, matchChannels: { M1: '999999999999999999', M2: '101010101010101010' } };
  const state = createFixture(eventId);
  let session: SessionRow = { event_id: eventId, application_id: routed.applicationId, guild_id: routed.guildId,
    channel_id: routed.channelId, identity_map: { players: routed.players, adminId: routed.adminId, matchChannels: routed.matchChannels },
    status: 'active', checkin_message_id: ids[0]!, m1_message_id: ids[1]!, m2_message_id: ids[2]! };
  const controller = new PrivateDiscordController(routed, 'runner', {
    async send() { return '888888888888888888'; }, async edit() {}, async pin() {}, async remove() {},
    classify() { return 'retry'; }
  }, async () => ({ session, state }), async () => { throw new Error('no mutation'); }, async () => {},
  Date.now, 60_000, {
    async suspend(_c, _e, slot) { session = { ...session, identity_map: { ...session.identity_map, stickySuspended: [slot] } }; return true; },
    async replace(_c, _e, _slot, _old, next) { session = { ...session, m1_message_id: next }; return true; },
    async complete() { session = { ...session, identity_map: { ...session.identity_map, stickySuspended: [] } }; }
  }, () => true, 5);
  const panels: ControllerChange[] = [];
  controller.subscribe(change => { if (change.type === 'panels') panels.push(change); });
  controller.onMessage({ guildId: routed.guildId, channelId: routed.matchChannels!.M1, id: ids[7]!, authorBot: false });
  const deadline = Date.now() + 1_000;
  while (controller.status().panelRevision < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(controller.status().panelRevision, 3);
  assert.equal(session.m1_message_id, '888888888888888888');
  await settle();
  assert.deepEqual(panels, [{ type: 'panels', eventId }, { type: 'panels', eventId }, { type: 'panels', eventId }]);
  await controller.stop();
});

test('updatePending reflects an in-flight or failed card refresh and notifies status changes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ gateEdit: gate });
  f.session = { ...f.session, checkin_message_id: ids[5]! };
  const statuses: boolean[] = [];
  f.controller.subscribe(change => { if (change.type === 'status') statuses.push(f.controller.status().updatePending); });
  assert.equal(f.controller.status().updatePending, false, 'nothing requested yet');
  const starting = f.controller.start();
  await starting;
  await settle();
  assert.equal(f.controller.status().updatePending, true, 'edit in flight');
  release();
  await settle();
  assert.equal(f.controller.status().updatePending, false);
  assert.deepEqual(statuses, [true, false]);
  await f.controller.stop();

  const failing = fixture({ failEdit: true });
  failing.session = { ...failing.session, checkin_message_id: ids[5]! };
  await failing.controller.start();
  await settle();
  assert.equal(failing.controller.status().updatePending, true, 'failed edit stays pending until a retry succeeds');
  await failing.controller.stop();
});

test('timer applications notify an event change', async () => {
  const startedAtMs = Date.now();
  let state = createFixture(eventId, 20);
  state = { ...state, version: 1, published: true,
    matches: [{ ...state.matches[0], phase: 'running', runnerId: 'runner', startedAtMs, remainingMs: 20 }, state.matches[1]] };
  const session: SessionRow = { event_id: eventId, application_id: config.applicationId, guild_id: config.guildId,
    channel_id: config.channelId, identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: null, m1_message_id: null, m2_message_id: null };
  const controller = new PrivateDiscordController(config, 'runner', {
    async send() { throw new Error('no send'); }, async edit() {}, async pin() {}, classify() { return 'retry'; }
  }, async () => ({ state, session }), async context => {
    assert.equal(context.principalId, 'system:timer');
    state = { ...state, version: 2, matches: [{ ...state.matches[0], phase: 'expired', runnerId: null, startedAtMs: null,
      remainingMs: 0, judgeAttention: true }, state.matches[1]] };
    return { eventId, version: 2, applied: true, result: 'clockCheck' };
  }, async () => {}, Date.now, 10);
  const changes: ControllerChange[] = [];
  controller.subscribe(change => { changes.push(change); });
  try {
    await controller.start();
    const deadline = Date.now() + 2_000;
    while (!changes.some(change => change.type === 'event') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(changes.find(change => change.type === 'event'), { type: 'event', eventId });
  } finally { await controller.stop(); }
});
