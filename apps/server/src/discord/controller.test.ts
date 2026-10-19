import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, transition, type Command, type EventState, type Outcome } from '../rehearsal/domain.js';
import { buttonId, parseButtonId, renderCard, type CardPayload } from './cards.js';
import { PrivateDiscordController, type CardTransport, type PrivateInteraction } from './controller.js';
import type { PrivateDiscordConfig } from './config.js';
import type { SessionRow } from './session.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888'];
const config = {
  applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]!
} satisfies PrivateDiscordConfig;
const eventId = '11111111-1111-4111-8111-111111111111';

function fixture() {
  let state = createFixture(eventId);
  let session: SessionRow = { event_id: eventId, application_id: config.applicationId,
    guild_id: config.guildId, channel_id: config.channelId,
    identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: null, m1_message_id: null, m2_message_id: null };
  const actions: Array<{ command: Command; principal: string; message?: string }> = [];
  const calls: string[] = [];
  let failEdit = false;
  let editFailure: 'missing' | 'forbidden' | 'retry' | undefined;
  let failSend = false;
  let failReadAfterApply = false;
  let failPin = false;
  let applied = false;
  const transport: CardTransport = {
    async send(_payload: CardPayload) {
      calls.push('send');
      if (failSend) throw new Error('ambiguous send');
      return ids[0]!;
    },
    async edit(id) { calls.push(`edit:${id}`); if (failEdit || editFailure) throw new Error(editFailure ?? 'retry'); },
    async pin(id) { calls.push(`pin:${id}`); if (failPin) throw new Error('pin denied'); },
    classify(error) { return error instanceof Error && ['missing', 'forbidden'].includes(error.message)
      ? error.message as 'missing' | 'forbidden' : 'retry'; }
  };
  const controller = new PrivateDiscordController(config, 'runner', transport,
    async () => { if (applied && failReadAfterApply) throw new Error('read failed'); return { state, session }; },
    async (context, command) => {
      applied = true;
      actions.push({ command, principal: context.principalId, message: context.message?.id });
      state = { ...state, version: state.version + 1 };
      return { eventId, version: state.version, applied: true, result: command.type } satisfies Outcome;
    },
    async (_config, _eventId, slot, id) => {
      session = { ...session, [slot === 'checkin' ? 'checkin_message_id' : slot === 'M1' ? 'm1_message_id' : 'm2_message_id']: id };
    });
  return { controller, config, get state() { return state; }, set state(next: EventState) { state = next; },
    get session() { return session; }, set session(next: SessionRow) { session = next; },
    actions, calls, set failEdit(value: boolean) { failEdit = value; }, set failSend(value: boolean) { failSend = value; },
    set failReadAfterApply(value: boolean) { failReadAfterApply = value; }, set failPin(value: boolean) { failPin = value; },
    set editFailure(value: 'missing' | 'forbidden' | 'retry' | undefined) { editFailure = value; } };
}

function button(f: ReturnType<typeof fixture>, action: 'checkin' | 'won' = 'checkin', revision?: number): {
  interaction: PrivateInteraction; replies: string[]; set ack(value: boolean);
} {
  const replies: string[] = [];
  let ack = true;
  const interaction: PrivateInteraction = {
    id: ids[0]!, applicationId: f.config.applicationId, guildId: f.config.guildId,
    channelId: f.config.channelId, userId: f.config.players.A, kind: 'button',
    customId: buttonId(eventId, action === 'checkin' ? 'checkin' : 'M1', action, revision),
    messageId: action === 'checkin' ? f.session.checkin_message_id ?? undefined : f.session.m1_message_id ?? undefined,
    async acknowledge() { if (!ack) throw new Error('ack failed'); },
    async reply(message) { replies.push(message); }
  };
  return { interaction, replies, set ack(value: boolean) { ack = value; } };
}

test('only explicit admin refresh creates cards; startup edits known cards only', async () => {
  const f = fixture();
  await f.controller.start();
  assert.equal(f.calls.includes('send'), false);
  const replies: string[] = [];
  await f.controller.handle({ id: ids[0]!, applicationId: config.applicationId,
    guildId: config.guildId, channelId: config.channelId, userId: config.adminId,
    kind: 'command', subcommand: 'refresh', acknowledge: async () => {}, reply: async text => { replies.push(text); } });
  assert.equal(f.calls.filter(call => call === 'send').length, 3);
  assert.equal(f.calls.filter(call => call.startsWith('pin:')).length, 1);
  assert.deepEqual(replies, ['Practice cards refreshed.']);
  await f.controller.stop();
});

test('scope, canonical binding, identity and acknowledgment precede mutation', async () => {
  const f = fixture();
  f.session = { ...f.session, checkin_message_id: ids[0]! };
  const b = button(f);
  b.ack = false;
  await f.controller.handle(b.interaction);
  assert.equal(f.actions.length, 0);
  b.ack = true;
  await f.controller.handle({ ...b.interaction, guildId: ids[7]! });
  await f.controller.handle({ ...b.interaction, messageId: ids[1]! });
  await f.controller.handle({ ...b.interaction, userId: ids[7]! });
  assert.equal(f.actions.length, 0);
  await f.controller.handle(b.interaction);
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0]?.principal, config.players.A);
  assert.equal(f.actions[0]?.message, ids[0]);
  await f.controller.stop();
});

test('rendered proposal revision zero is retained and failed edit follows committed action', async () => {
  const f = fixture();
  f.session = { ...f.session, m1_message_id: ids[1]! };
  f.state = { ...f.state, published: true };
  const b = button(f, 'won', 0);
  f.failEdit = true;
  await f.controller.handle(b.interaction);
  assert.equal(f.actions.length, 1);
  assert.deepEqual(f.actions[0]?.command, { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 });
  assert.match(b.replies[0] ?? '', /^Saved: propose\. Card update pending\.$/);
  assert.equal(parseButtonId(b.interaction.customId!).revision, 0);
  await f.controller.stop();
});

test('ambiguous initial send is attempted once and never auto-replayed', async () => {
  const f = fixture();
  f.failSend = true;
  await f.controller.handle({ id: ids[0]!, applicationId: config.applicationId,
    guildId: config.guildId, channelId: config.channelId, userId: config.adminId,
    kind: 'command', subcommand: 'refresh', acknowledge: async () => {}, reply: async () => {} });
  assert.deepEqual(f.calls, ['send']);
  await f.controller.stop();
});

test('post-commit read failure still reports saved outcome', async () => {
  const f = fixture();
  f.session = { ...f.session, checkin_message_id: ids[0]! };
  f.failReadAfterApply = true;
  const b = button(f);
  await f.controller.handle(b.interaction);
  assert.equal(f.actions.length, 1);
  assert.deepEqual(b.replies, ['Saved: checkin. Card update pending.']);
  await f.controller.stop();
});

test('explicit refresh retries pinning an already bound check-in card', async () => {
  const f = fixture();
  const replies: string[] = [];
  const refresh: PrivateInteraction = { id: ids[0]!, applicationId: config.applicationId,
    guildId: config.guildId, channelId: config.channelId, userId: config.adminId,
    kind: 'command', subcommand: 'refresh', acknowledge: async () => {}, reply: async text => { replies.push(text); } };
  f.failPin = true;
  await f.controller.handle(refresh);
  assert.equal(f.session.checkin_message_id, ids[0]);
  f.failPin = false;
  await f.controller.handle(refresh);
  assert.equal(f.calls.filter(call => call === `pin:${ids[0]}`).length, 2);
  assert.equal(f.calls.filter(call => call === 'send').length, 3);
  assert.equal(replies.at(-1), 'Practice cards refreshed.');
  await f.controller.stop();
});

test('authorized stale control requests edit of known card without mutation', async () => {
  const f = fixture();
  f.session = { ...f.session, checkin_message_id: ids[0]! };
  const b = button(f);
  await f.controller.handle({ ...b.interaction, customId: buttonId(eventId, 'M1', 'won', 0) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.actions.length, 0);
  assert.ok(f.calls.includes(`edit:${ids[0]}`));
  assert.equal(f.calls.includes('send'), false);
  await f.controller.stop();
});

test('stop during deferred acknowledgment drains it without starting mutation', async () => {
  const f = fixture();
  f.session = { ...f.session, checkin_message_id: ids[0]! };
  let finishAck: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { finishAck = resolve; });
  const b = button(f);
  const handling = f.controller.handle({ ...b.interaction, acknowledge: () => waiting });
  let stopped = false;
  const stopping = f.controller.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stopped, false);
  finishAck!();
  await Promise.all([handling, stopping]);
  assert.equal(f.actions.length, 0);
});

test('background missing, forbidden and rate-limit-like edit failures never create replacements', async () => {
  for (const failure of ['missing', 'forbidden', 'retry'] as const) {
    const f = fixture();
    f.session = { ...f.session, checkin_message_id: ids[0]! };
    f.editFailure = failure;
    await f.controller.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.calls.includes('send'), false, `${failure} must not send`);
    await f.controller.stop();
  }
});

test('older blocked edit converges to newer committed state on the same card', async () => {
  let state = createFixture(eventId);
  const session: SessionRow = { event_id: eventId, application_id: config.applicationId,
    guild_id: config.guildId, channel_id: config.channelId,
    identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: ids[0]!, m1_message_id: null, m2_message_id: null };
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const descriptions: string[] = [];
  const transport: CardTransport = {
    async send() { throw new Error('unexpected send'); },
    async edit(_id, payload) {
      descriptions.push(payload.embeds[0]!.description);
      if (descriptions.length === 1) await gate;
    },
    async pin() {}, classify() { return 'retry'; }
  };
  const controller = new PrivateDiscordController(config, 'runner', transport,
    async () => ({ state, session }),
    async (context, command) => {
      const player = Object.entries(config.players).find(([, id]) => id === context.principalId)?.[0];
      state = transition(state, `player:${player}`, command, 1_000, 'runner').state;
      return { eventId, version: state.version, result: command.type, applied: true };
    }, async () => {});
  const first = button(fixture()).interaction;
  first.messageId = ids[0]!;
  const firstAction = controller.handle(first);
  while (!descriptions.length) await new Promise(resolve => setTimeout(resolve, 1));
  const second = { ...first, id: ids[1]!, userId: config.players.B };
  const secondAction = controller.handle(second);
  while (state.checkins.length !== 2) await new Promise(resolve => setTimeout(resolve, 1));
  unblock();
  await Promise.all([firstAction, secondAction]);
  assert.match(descriptions.at(-1) ?? '', /2\/4 checked in/);
  assert.equal(descriptions.filter(value => /2\/4 checked in/.test(value)).length, 1);
  await controller.stop();
});

test('timer retries transient apply failure and post-commit read failure, then shows expiry', async () => {
  for (const failure of ['apply', 'read'] as const) {
    const startedAtMs = Date.now();
    let state = createFixture(eventId, 30);
    state = { ...state, version: 1, published: true,
      matches: [{ ...state.matches[0], phase: 'running', runnerId: 'runner', startedAtMs, remainingMs: 30 }, state.matches[1]] };
    const session: SessionRow = { event_id: eventId, application_id: config.applicationId,
      guild_id: config.guildId, channel_id: config.channelId,
      identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
      checkin_message_id: null, m1_message_id: ids[0]!, m2_message_id: null };
    let applyCalls = 0;
    let failNextRead = false;
    const edits: string[] = [];
    const controller = new PrivateDiscordController(config, 'runner', {
      async send() { throw new Error('unexpected send'); },
      async edit(_id, payload) { edits.push(payload.embeds[0]!.description); },
      async pin() {}, classify() { return 'retry'; }
    }, async () => {
      if (failNextRead) { failNextRead = false; throw new Error('transient read'); }
      return { state, session };
    }, async () => {
      applyCalls++;
      if (failure === 'apply' && applyCalls === 1) throw new Error('transient apply');
      if (state.matches[0].phase === 'running') {
        state = { ...state, version: 2,
          matches: [{ ...state.matches[0], phase: 'expired', runnerId: null, startedAtMs: null,
            remainingMs: 0, judgeAttention: true }, state.matches[1]] };
        if (failure === 'read') failNextRead = true;
      }
      return { eventId, version: state.version, result: 'clockCheck', applied: true };
    }, async () => {}, Date.now, 10);
    try {
      await controller.start();
      const limit = Date.now() + 2_000;
      while (!edits.some(value => /State: expired/.test(value)) && Date.now() < limit)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(edits.some(value => /State: expired/.test(value)), `${failure} must converge to expired card`);
      assert.equal(state.matches[0].finalWinner, null);
      assert.ok(applyCalls >= 2);
    } finally { await controller.stop(); }
  }
});

test('setup, paused and expired startup/reconnect edit exactly three saved cards without sending', async () => {
  for (const phase of ['setup', 'paused', 'expired'] as const) {
    let state = createFixture(eventId);
    if (phase !== 'setup') state = { ...state, published: true, version: 1,
      matches: [{ ...state.matches[0], phase, remainingMs: phase === 'expired' ? 0 : 5_000,
        pauseGeneration: 1, judgeAttention: phase === 'expired' }, state.matches[1]] };
    const session: SessionRow = { event_id: eventId, application_id: config.applicationId,
      guild_id: config.guildId, channel_id: config.channelId,
      identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
      checkin_message_id: ids[0]!, m1_message_id: ids[1]!, m2_message_id: ids[2]! };
    const edits: string[] = [];
    let sends = 0;
    const controller = new PrivateDiscordController(config, 'new-runner', {
      async send() { sends++; return ids[3]!; },
      async edit(id) { edits.push(id); },
      async pin() {}, classify() { return 'retry'; }
    }, async () => ({ state, session }), async () => { throw new Error('unexpected mutation'); }, async () => {});
    try {
      await controller.start();
      const firstLimit = Date.now() + 1_000;
      while (edits.length < 3 && Date.now() < firstLimit) await new Promise(resolve => setTimeout(resolve, 1));
      assert.deepEqual(edits, [ids[0], ids[1], ids[2]], `${phase} startup edits saved IDs`);
      controller.reconnect();
      const secondLimit = Date.now() + 1_000;
      while (edits.length < 6 && Date.now() < secondLimit) await new Promise(resolve => setTimeout(resolve, 1));
      assert.deepEqual(edits, [ids[0], ids[1], ids[2], ids[0], ids[1], ids[2]], `${phase} reconnect edits saved IDs`);
      assert.equal(sends, 0, `${phase} never creates replacements`);
    } finally { await controller.stop(); }
  }
});

test('explicit refresh replaces only a confirmed deleted card; forbidden card is retained', async () => {
  const state = createFixture(eventId);
  let session: SessionRow = { event_id: eventId, application_id: config.applicationId,
    guild_id: config.guildId, channel_id: config.channelId,
    identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: ids[0]!, m1_message_id: ids[1]!, m2_message_id: ids[2]! };
  const sends: string[] = [];
  const edits: string[] = [];
  let error: 'missing' | 'forbidden' = 'missing';
  const controller = new PrivateDiscordController(config, 'runner', {
    async send() { sends.push(error); return ids[3]!; },
    async edit(id) { edits.push(id); if (id === ids[1]) throw new Error(error); },
    async pin() {},
    classify(value) { return value instanceof Error && value.message === 'missing' ? 'missing' : 'forbidden'; }
  }, async () => ({ state, session }), async () => { throw new Error('unexpected mutation'); },
  async (_config, _eventId, slot, id) => {
    if (slot === 'M1') session = { ...session, m1_message_id: id };
  });
  const replies: string[] = [];
  const refresh: PrivateInteraction = { id: ids[4]!, applicationId: config.applicationId,
    guildId: config.guildId, channelId: config.channelId, userId: config.adminId,
    kind: 'command', subcommand: 'refresh', acknowledge: async () => {}, reply: async text => { replies.push(text); } };
  await controller.handle(refresh);
  assert.deepEqual(sends, ['missing']);
  assert.equal(session.m1_message_id, ids[3]);
  assert.equal(replies.at(-1), 'Practice cards refreshed.');
  error = 'forbidden';
  session = { ...session, m1_message_id: ids[1]! };
  await controller.handle(refresh);
  assert.deepEqual(sends, ['missing'], 'forbidden edit cannot create a replacement');
  assert.equal(session.m1_message_id, ids[1]);
  assert.ok(edits.includes(ids[1]!));
  await controller.stop();
});

test('slot-aware routing sends match cards to their channels and rejects copied controls', async () => {
  const routed: PrivateDiscordConfig = { ...config,
    matchChannels: { M1: '999999999999999999', M2: '101010101010101010' } };
  const state = { ...createFixture(eventId), published: true };
  let session: SessionRow = { event_id: eventId, application_id: routed.applicationId,
    guild_id: routed.guildId, channel_id: routed.channelId,
    identity_map: { players: routed.players, adminId: routed.adminId, matchChannels: routed.matchChannels }, status: 'active',
    checkin_message_id: null, m1_message_id: null, m2_message_id: null };
  const sends: string[] = [];
  const pins: string[] = [];
  const actions: Command[] = [];
  const controller = new PrivateDiscordController(routed, 'runner', {
    async send(_payload, slot) { sends.push(slot ?? 'unset'); return ids[sends.length]!; },
    async edit() {}, async pin(_id, slot) { pins.push(slot ?? 'unset'); }, classify() { return 'retry'; }
  }, async () => ({ state, session }), async (_context, command) => {
    actions.push(command);
    return { eventId, version: state.version, applied: true, result: command.type };
  }, async (_config, _eventId, slot, id) => {
    session = { ...session, [slot === 'checkin' ? 'checkin_message_id' : slot === 'M1' ? 'm1_message_id' : 'm2_message_id']: id };
  });
  const admin: PrivateInteraction = { id: ids[6]!, applicationId: routed.applicationId,
    guildId: routed.guildId, channelId: routed.channelId, userId: routed.adminId,
    kind: 'command', subcommand: 'refresh', acknowledge: async () => {}, reply: async () => {} };
  await controller.handle(admin);
  assert.deepEqual(sends, ['checkin', 'M1', 'M2']);
  assert.deepEqual(pins, ['checkin']);
  const replies: string[] = [];
  const won: PrivateInteraction = { id: ids[7]!, applicationId: routed.applicationId,
    guildId: routed.guildId, channelId: routed.channelId, userId: routed.players.A,
    kind: 'button', customId: buttonId(eventId, 'M1', 'won', 0), messageId: session.m1_message_id!,
    acknowledge: async () => {}, reply: async text => { replies.push(text); } };
  await controller.handle(won);
  assert.equal(actions.length, 0, 'a copied match control in the control channel is inert');
  await controller.handle({ ...won, channelId: routed.matchChannels!.M2 });
  assert.equal(actions.length, 0, 'a copied M1 control in M2 is inert');
  await controller.handle({ ...won, channelId: routed.matchChannels!.M1 });
  assert.equal(actions.length, 1);
  await controller.handle({ ...admin, channelId: routed.matchChannels!.M1 });
  assert.deepEqual(sends, ['checkin', 'M1', 'M2'], 'admin commands remain in the control channel');
  await controller.stop();
});

test('match card controls show pause/resume availability without reviving expired clock', () => {
  const base = createFixture(eventId);
  const controls = (phase: 'running' | 'paused' | 'expired') => {
    const state = { ...base, published: true,
      matches: [{ ...base.matches[0], phase }, base.matches[1]] } as EventState;
    const card = renderCard(state, 'M1');
    return { description: card.embeds[0]!.description,
      buttons: card.components.flatMap(row => row.components) };
  };
  const running = controls('running').buttons;
  assert.equal(running.find(button => button.label === '🟠 Pause')?.disabled, undefined);
  assert.equal(running.find(button => button.label === 'Resume')?.disabled, true);
  const paused = controls('paused').buttons;
  assert.equal(paused.find(button => button.label === '🟠 Pause')?.disabled, true);
  assert.equal(paused.find(button => button.label === 'Resume')?.disabled, undefined);
  const expired = controls('expired');
  assert.equal(expired.buttons.find(button => button.label === '🟠 Pause')?.disabled, true);
  assert.equal(expired.buttons.find(button => button.label === 'Resume')?.disabled, true);
  assert.match(expired.description, /judge must resolve/);
});

test('paused match highlights the waiting player; final card shows winner without stale clock or proposal', () => {
  const base = createFixture(eventId);
  const paused: EventState = { ...base, published: true,
    matches: [{ ...base.matches[0], phase: 'paused', resumeConsents: ['A'], pauseGeneration: 2 },
      base.matches[1]] };
  const waiting = renderCard(paused, 'M1', undefined, config.players);
  assert.equal(waiting.embeds[0]?.color, 0xef4444);
  assert.match(waiting.embeds[0]!.description, new RegExp(`Resume agreed: <@${config.players.A}>`));
  assert.match(waiting.embeds[0]!.description, new RegExp(`<@${config.players.B}>`));
  assert.match(waiting.embeds[0]!.description, new RegExp(`Waiting to resume: <@${config.players.B}>`));
  assert.deepEqual(waiting.allowedMentions, { parse: [] });
  const bothWaiting = renderCard({ ...paused,
    matches: [{ ...paused.matches[0], resumeConsents: [] }, paused.matches[1]] }, 'M1', undefined, config.players);
  assert.match(bothWaiting.embeds[0]!.description, new RegExp(`<@${config.players.A}>.*<@${config.players.B}>`));
  const finished = renderCard({ ...paused,
    matches: [{ ...paused.matches[0], phase: 'final', finalWinner: 'A', confirmedBy: 'B',
      proposal: { revision: 2, winner: 'B', reporter: 'B', decision: 'open' } }, paused.matches[1]] },
  'M1', undefined, config.players);
  assert.equal(finished.embeds[0]?.color, 0x22c55e);
  assert.match(finished.embeds[0]!.description, /Finished — A wins/);
  assert.match(finished.embeds[0]!.description, new RegExp(`Agreed by <@${config.players.B}>`));
  assert.doesNotMatch(finished.embeds[0]!.description, /Remaining|Proposal/);
  assert.equal(finished.components.length, 0);
  assert.equal(renderCard(base, 'M1').embeds[0]?.color, 0xf59e0b);
  const legacy = renderCard({ ...paused, matches: [{ ...paused.matches[0], phase: 'final', finalWinner: 'A' },
    paused.matches[1]] }, 'M1', undefined, config.players);
  assert.doesNotMatch(legacy.embeds[0]!.description, /Agreed by/);
});

test('result controls show I won then opponent Agree/Dispute; a dispute permits a corrected proposal', () => {
  const base = createFixture(eventId);
  const running: EventState = { ...base, published: true,
    matches: [{ ...base.matches[0], phase: 'running', ready: ['A', 'B'] }, base.matches[1]] };
  const buttons = (state: EventState) => renderCard(state, 'M1', undefined, config.players)
    .components.flatMap(row => row.components);
  const initial = buttons(running);
  assert.ok(initial.some(button => button.label === 'I won' && !button.disabled));
  assert.ok(!initial.some(button => button.label === 'I lost'));
  assert.equal(initial.find(button => button.label === '🟠 Pause')?.style, 2);
  assert.equal(initial.find(button => button.label === 'Resume')?.style, 3);
  assert.match(renderCard(running, 'M1', undefined, config.players).embeds[0]!.description,
    new RegExp(`Ready: <@${config.players.A}>, <@${config.players.B}>`));
  const proposed: EventState = { ...running,
    matches: [{ ...running.matches[0], proposal: {
      revision: 1, reporter: 'A', winner: 'A', decision: 'open' } }, running.matches[1]] };
  const pending = buttons(proposed);
  assert.equal(pending.find(button => button.label === 'I won')?.disabled, true);
  assert.equal(pending.find(button => button.label === 'Agree')?.style, 3);
  assert.equal(pending.find(button => button.label === 'Dispute')?.style, 4);
  assert.equal(pending.find(button => button.label === 'Dispute')?.disabled, undefined);
  assert.match(renderCard(proposed, 'M1', undefined, config.players).embeds[0]!.description,
    new RegExp(`Waiting for <@${config.players.B}> to Agree or Dispute`));
  const disputed: EventState = { ...proposed,
    matches: [{ ...proposed.matches[0], proposal: { ...proposed.matches[0].proposal!, decision: 'disputed' } },
      proposed.matches[1]] };
  assert.equal(buttons(disputed).find(button => button.label === 'I won')?.disabled, undefined);
  assert.equal(buttons(disputed).find(button => button.label === 'Dispute')?.disabled, true);
  assert.equal(buttons(disputed).find(button => button.label === 'Agree')?.disabled, undefined);
  assert.equal(parseButtonId(buttonId(eventId, 'M1', 'lost', 0)).action, 'lost',
    'legacy I lost controls remain parseable');
});

test('human burst bumps only its match; lost CAS reply preserves the committed new canonical card', async () => {
  const routed: PrivateDiscordConfig = { ...config,
    matchChannels: { M1: '999999999999999999', M2: '101010101010101010' } };
  const state = createFixture(eventId);
  let session: SessionRow = { event_id: eventId, application_id: routed.applicationId,
    guild_id: routed.guildId, channel_id: routed.channelId,
    identity_map: { players: routed.players, adminId: routed.adminId, matchChannels: routed.matchChannels },
    status: 'active', checkin_message_id: ids[0]!, m1_message_id: ids[1]!, m2_message_id: ids[2]! };
  const calls: string[] = [];
  const transport: CardTransport = {
    async send(_card, slot) { calls.push(`send:${slot}`); return '888888888888888888'; },
    async edit() {}, async pin() {},
    async remove(id, slot) { calls.push(`remove:${slot}:${id}`); assert.equal(session.m1_message_id, '888888888888888888'); },
    classify() { return 'retry'; }
  };
  const controller = new PrivateDiscordController(routed, 'runner', transport,
    async () => ({ session, state }), async () => { throw new Error('no mutation'); }, async () => {},
    Date.now, 5, {
      async suspend(_config, _event, slot, expected) {
        calls.push(`suspend:${slot}`);
        if (session.m1_message_id !== expected || session.identity_map.stickySuspended?.includes(slot)) return false;
        session = { ...session, identity_map: { ...session.identity_map, stickySuspended: [slot] } };
        return true;
      },
      async replace(_config, _event, slot, expected, next) {
        calls.push(`bind:${slot}`);
        if (session.m1_message_id !== expected || !session.identity_map.stickySuspended?.includes(slot)) return false;
        session = { ...session, m1_message_id: next };
        throw new Error('reply lost after commit');
      },
      async complete(_config, _event, slot) {
        calls.push(`complete:${slot}`);
        session = { ...session, identity_map: { ...session.identity_map, stickySuspended: [] } };
      }
    }, () => true, 5);
  controller.onMessage({ guildId: routed.guildId, channelId: routed.matchChannels!.M1,
    id: ids[6]!, authorBot: true });
  controller.onMessage({ guildId: routed.guildId, channelId: routed.matchChannels!.M1,
    id: ids[6]!, authorBot: false, webhookId: ids[5]! });
  controller.onMessage({ guildId: ids[6]!, channelId: routed.matchChannels!.M1,
    id: ids[6]!, authorBot: false });
  controller.onMessage({ guildId: routed.guildId, channelId: routed.matchChannels!.M1,
    id: ids[6]!, authorBot: false });
  controller.onMessage({ guildId: routed.guildId, channelId: routed.matchChannels!.M1,
    id: ids[7]!, authorBot: false });
  const deadline = Date.now() + 500;
  while (!calls.includes('complete:M1') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(calls, ['suspend:M1', 'send:M1', 'bind:M1', `remove:M1:${ids[1]}`, 'complete:M1']);
  assert.equal(session.checkin_message_id, ids[0]);
  assert.equal(session.m2_message_id, ids[2]);
  await controller.stop();
});

test('ambiguous sticky send suspends durably and stop cancels unstarted debounce', async () => {
  const state = createFixture(eventId);
  let session: SessionRow = { event_id: eventId, application_id: config.applicationId,
    guild_id: config.guildId, channel_id: config.channelId,
    identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: ids[0]!, m1_message_id: null, m2_message_id: null };
  let sends = 0;
  const transport: CardTransport = {
    async send() { sends++; throw new Error('ambiguous'); }, async edit() {}, async pin() {},
    async remove() { throw new Error('no known new card'); }, classify() { return 'retry'; }
  };
  const controller = new PrivateDiscordController(config, 'runner', transport,
    async () => ({ session, state }), async () => { throw new Error('no mutation'); }, async () => {},
    Date.now, 5, {
      async suspend(_config, _event, slot, expected) {
        if (session.checkin_message_id !== expected || session.identity_map.stickySuspended?.includes(slot)) return false;
        session = { ...session, identity_map: { ...session.identity_map, stickySuspended: [slot] } };
        return true;
      }, async replace() { throw new Error('must not bind'); }, async complete() { throw new Error('must not complete'); }
    }, () => true, 5);
  controller.onMessage({ guildId: config.guildId, channelId: config.channelId,
    id: ids[7]!, authorBot: false });
  const deadline = Date.now() + 500;
  while (sends === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(sends, 1);
  assert.deepEqual(session.identity_map.stickySuspended, ['checkin']);
  controller.onMessage({ guildId: config.guildId, channelId: config.channelId,
    id: '999999999999999999', authorBot: false });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sends, 1, 'suspended slot is never resent automatically');
  await controller.stop();
  controller.onMessage({ guildId: config.guildId, channelId: config.channelId,
    id: '101010101010101010', authorBot: false });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(sends, 1);
});

test('blocked sticky send converges to a concurrently committed result on the new canonical card', async () => {
  const routed: PrivateDiscordConfig = { ...config,
    matchChannels: { M1: '999999999999999999', M2: '101010101010101010' } };
  let state: EventState = { ...createFixture(eventId), published: true };
  let session: SessionRow = { event_id: eventId, application_id: routed.applicationId,
    guild_id: routed.guildId, channel_id: routed.channelId,
    identity_map: { players: routed.players, adminId: routed.adminId, matchChannels: routed.matchChannels },
    status: 'active', checkin_message_id: null, m1_message_id: ids[1]!, m2_message_id: null };
  let signalSend!: () => void;
  let releaseSend!: () => void;
  const sending = new Promise<void>(resolve => { signalSend = resolve; });
  const blocked = new Promise<void>(resolve => { releaseSend = resolve; });
  const edits: Array<{ id: string; description: string }> = [];
  let applied!: () => void;
  const committed = new Promise<void>(resolve => { applied = resolve; });
  const controller = new PrivateDiscordController(routed, 'runner', {
    async send() { signalSend(); await blocked; return '888888888888888888'; },
    async edit(id, card) { edits.push({ id, description: card.embeds[0]!.description }); },
    async pin() {}, async remove() {}, classify() { return 'retry'; }
  }, async () => ({ session, state }), async (_context, command) => {
    assert.equal(command.type, 'propose');
    state = { ...state, version: state.version + 1,
      matches: [{ ...state.matches[0], proposal: { revision: 1, reporter: 'A', winner: 'A', decision: 'open' } },
        state.matches[1]] };
    applied();
    return { eventId, version: state.version, applied: true, result: 'proposal' };
  }, async () => {}, Date.now, 5, {
    async suspend(_config, _event, slot, old) {
      if (session.m1_message_id !== old) return false;
      session = { ...session, identity_map: { ...session.identity_map, stickySuspended: [slot] } };
      return true;
    },
    async replace(_config, _event, _slot, old, next) {
      if (session.m1_message_id !== old) return false;
      session = { ...session, m1_message_id: next };
      return true;
    },
    async complete() { session = { ...session, identity_map: { ...session.identity_map, stickySuspended: [] } }; }
  }, () => true, 5);
  controller.onMessage({ guildId: routed.guildId, channelId: routed.matchChannels!.M1,
    id: ids[7]!, authorBot: false });
  await sending;
  const action = controller.handle({ id: ids[6]!, applicationId: routed.applicationId,
    guildId: routed.guildId, channelId: routed.matchChannels!.M1, userId: routed.players.A,
    kind: 'button', customId: buttonId(eventId, 'M1', 'won', 0), messageId: ids[1]!,
    acknowledge: async () => {}, reply: async () => {} });
  await committed;
  releaseSend();
  await action;
  const deadline = Date.now() + 500;
  while (!edits.some(edit => edit.id === '888888888888888888' && edit.description.includes('Proposal #1')) &&
    Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(edits.some(edit => edit.id === '888888888888888888' && edit.description.includes('Proposal #1')));
  await controller.stop();
});

test('first resume consent claims one targeted reminder and leaves ordinary card mentions disabled', async () => {
  const base = createFixture(eventId);
  let state: EventState = { ...base, published: true,
    matches: [{ ...base.matches[0], phase: 'paused', pauseGeneration: 1 }, base.matches[1]] };
  const session: SessionRow = { event_id: eventId, application_id: config.applicationId,
    guild_id: config.guildId, channel_id: config.channelId,
    identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: null, m1_message_id: ids[1]!, m2_message_id: null };
  const reminders: Array<{ slot: string; ids: string[] }> = [];
  let claims = 0;
  let failReminder = false;
  const replies: string[] = [];
  const controller = new PrivateDiscordController(config, 'runner', {
    async send() { throw new Error('no card creation'); },
    async edit(_id, card) { assert.deepEqual(card.allowedMentions, { parse: [] }); },
    async pin() {},
    async resumeReminder(slot, waitingIds) {
      reminders.push({ slot, ids: waitingIds });
      if (failReminder) throw new Error('synthetic network failure');
      return ids[7]!;
    },
    classify() { return 'retry'; }
  }, async () => ({ session, state }), async () => {
    state = { ...state, version: 1,
      matches: [{ ...state.matches[0], resumeConsents: ['A'] }, state.matches[1]] };
    return { eventId, version: 1, applied: true, result: 'resume_consent' };
  }, async () => {}, Date.now, 5, undefined, () => true, 5,
  async (_config, _event, matchId, generation) => {
    claims++;
    assert.equal(matchId, 'M1'); assert.ok(generation === 1 || generation === 2);
    return [config.players.B];
  });
  await controller.handle({ id: ids[6]!, applicationId: config.applicationId,
    guildId: config.guildId, channelId: config.channelId, userId: config.players.A,
    kind: 'button', customId: buttonId(eventId, 'M1', 'resume', 1), messageId: ids[1]!,
    acknowledge: async () => {}, reply: async text => { replies.push(text); } });
  assert.equal(claims, 1);
  assert.deepEqual(reminders, [{ slot: 'M1', ids: [config.players.B] }]);
  state = { ...state, matches: [{ ...state.matches[0], pauseGeneration: 2, resumeConsents: [] }, state.matches[1]] };
  failReminder = true;
  await controller.handle({ id: ids[7]!, applicationId: config.applicationId,
    guildId: config.guildId, channelId: config.channelId, userId: config.players.A,
    kind: 'button', customId: buttonId(eventId, 'M1', 'resume', 2), messageId: ids[1]!,
    acknowledge: async () => {}, reply: async text => { replies.push(text); } });
  assert.equal(claims, 2);
  assert.equal(replies.at(-1), 'Saved: resume_consent. Card update pending.');
  await controller.stop();
});
