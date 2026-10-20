// Wave 3: the console path through PrivateDiscordController (applyAdmin, refreshExplicit) and the slash
// commands that now share its commit and refresh code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, RuleError, transition, type Command, type EventState, type Outcome } from '../rehearsal/domain.js';
import type { DiscordCommandContext, WebCommandContext } from '../rehearsal/store.js';
import type { CardPayload } from './cards.js';
import { ControllerUnavailableError, PrivateDiscordController, type CardTransport, type ControllerChange,
  type PrivateInteraction, type WebAdminRequest } from './controller.js';
import type { PrivateDiscordConfig } from './config.js';
import type { SessionRow } from './session.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888',
  '999999999999999991', '999999999999999992', '999999999999999993'];
const config = {
  applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]!
} satisfies PrivateDiscordConfig;
const eventId = '11111111-1111-4111-8111-111111111111';
const RUNNER = 'runner';

interface Options {
  /** Applied by both store fakes through the real transition(). */
  syncRooms?: (explicit: boolean) => Promise<void>;
  canPost?: () => boolean;
  clock?: () => number;
}

function fixture(options: Options = {}) {
  let state: EventState = createFixture(eventId);
  for (const seat of ['A', 'B', 'C', 'D'] as const) state = transition(state, `player:${seat}`, { type: 'checkin' }, 1, RUNNER).state;
  const session: SessionRow = { event_id: eventId, application_id: config.applicationId, guild_id: config.guildId,
    channel_id: config.channelId, identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: ids[8]!, m1_message_id: ids[9]!, m2_message_id: ids[10]! };
  const web: Array<{ context: WebCommandContext; command: Command }> = [];
  const discord: Array<{ context: DiscordCommandContext; command: Command }> = [];
  const edits: string[] = [];
  const sends: string[] = [];
  let failEdit: Error | null = null;
  let failSend: Error | null = null;
  let failRead = false;
  let webFailure: Error | null = null;
  const clock = options.clock ?? (() => 1_000);
  const applyState = (actor: string, command: Command): Outcome => {
    const result = transition(state, actor, command, clock(), RUNNER);
    if (result.outcome.applied) state = result.state;
    return result.outcome;
  };
  const transport: CardTransport = {
    async send(_payload: CardPayload, slot) { sends.push(slot ?? 'checkin'); if (failSend) throw failSend; return ids[0]!; },
    async edit(id) { edits.push(id); if (failEdit) throw failEdit; },
    async pin() {},
    classify(error) { return (error as Error).message === 'forbidden' ? 'forbidden' : (error as Error).message === 'missing' ? 'missing' : 'retry'; }
  };
  const controller = new PrivateDiscordController(config, RUNNER, transport,
    async () => { if (failRead) throw new Error('read failed'); return { state, session }; },
    async (context, command) => {
      discord.push({ context, command });
      return applyState(context.timer ? 'admin:fixture' : context.principalId === config.adminId ? 'admin:fixture' : 'player:A', command);
    },
    async () => {}, clock, 20, undefined, options.canPost ?? (() => true), undefined, undefined, options.syncRooms,
    async (context, command) => {
      web.push({ context, command });
      if (webFailure) throw webFailure;
      if (!context.precondition(state)) throw new RuleError('precondition');
      return applyState('admin:fixture', command);
    });
  const changes: ControllerChange[] = [];
  controller.subscribe(change => { changes.push(change); });
  return { controller, web, discord, edits, sends, changes,
    get state() { return state; }, set state(next: EventState) { state = next; },
    set failEdit(value: Error | null) { failEdit = value; }, set failSend(value: Error | null) { failSend = value; },
    set failRead(value: boolean) { failRead = value; }, set webFailure(value: Error | null) { webFailure = value; } };
}

function webRequest(command: Command, precondition: (state: EventState) => boolean = () => true): WebAdminRequest {
  return { eventId, principalId: 'local-admin', commandId: 'web:0f8fad5b-d9cb-469f-a165-70867728950e',
    content: '["content"]', precondition, command };
}

function slash(subcommand: string, extra: Partial<PrivateInteraction> = {}) {
  const replies: string[] = [];
  const interaction: PrivateInteraction = { id: ids[0]!, applicationId: config.applicationId, guildId: config.guildId,
    channelId: config.channelId, userId: config.adminId, kind: 'command', subcommand,
    acknowledge: async () => {}, reply: async message => { replies.push(message); }, ...extra };
  return { interaction, replies };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('applyAdmin: the web store context, change notice, room sync, card refresh and Discord reply text', async () => {
  const rooms: boolean[] = [];
  const f = fixture({ syncRooms: async explicit => { rooms.push(explicit); } });
  const result = await f.controller.applyAdmin(webRequest({ type: 'publish' }));
  assert.equal(f.web.length, 1);
  assert.deepEqual({ ...f.web[0]!.context, precondition: typeof f.web[0]!.context.precondition }, {
    config, eventId, principalId: 'local-admin', commandId: 'web:0f8fad5b-d9cb-469f-a165-70867728950e',
    content: '["content"]', precondition: 'function' });
  assert.deepEqual(f.web[0]!.command, { type: 'publish' });
  assert.equal(f.discord.length, 0, 'never the Discord store path');
  assert.deepEqual(result, { outcome: { eventId, version: 5, result: 'publish', applied: true }, cards: 'updated',
    roomWarning: null, reply: 'Saved: publish.', degraded: false });
  assert.deepEqual(rooms, [false], 'publication syncs the match rooms');
  assert.deepEqual(f.edits.sort(), [ids[8], ids[9], ids[10]].sort(), 'the three cards are re-rendered');
  await tick();
  assert.ok(f.changes.some(change => change.type === 'event' && change.eventId === eventId));
  await f.controller.stop();
});

test('applyAdmin: a pending card refresh and a room warning propagate as "saved; display pending"', async () => {
  const f = fixture({ syncRooms: async () => { throw new RuleError('Public match room M1 requires bot Move Members permission.'); } });
  f.failEdit = new Error('retry');
  const result = await f.controller.applyAdmin(webRequest({ type: 'publish' }));
  assert.equal(result.outcome.applied, true);
  assert.equal(result.cards, 'pending');
  assert.equal(result.roomWarning, 'Public match room M1 requires bot Move Members permission.');
  assert.equal(result.reply, 'Saved: publish. Card update pending. Room setup pending: Public match room M1 requires bot Move Members permission.');
  // A non-rule room failure gets the generic room message.
  const g = fixture({ syncRooms: async () => { throw new Error('socket hang up'); } });
  assert.equal((await g.controller.applyAdmin(webRequest({ type: 'publish' }))).roomWarning, 'Public match room setup failed.');
  await f.controller.stop();
  await g.controller.stop();
});

test('applyAdmin: a failure after the commit still reports the saved outcome with cards pending', async () => {
  const f = fixture();
  const apply = f.controller.applyAdmin(webRequest({ type: 'publish' }));
  f.failRead = true;          // The read that follows the commit (for timers) fails.
  const result = await apply;
  assert.deepEqual({ applied: result.outcome.applied, cards: result.cards, reply: result.reply, degraded: result.degraded },
    { applied: true, cards: 'pending', reply: 'Saved: publish. Card update pending.', degraded: true });
  f.failRead = false;
  await f.controller.stop();
});

test('applyAdmin: refusals before the commit reject, with no notice and no card work', async () => {
  const f = fixture();
  f.webFailure = new RuleError('Private Discord session is retired.');
  await assert.rejects(f.controller.applyAdmin(webRequest({ type: 'publish' })), /session is retired/);
  f.webFailure = null;
  await assert.rejects(f.controller.applyAdmin(webRequest({ type: 'publish' }, () => false)), /precondition/);
  await assert.rejects(f.controller.applyAdmin(webRequest({ type: 'signupReopen' })), RuleError, 'domain rule from transition()');
  assert.equal(f.edits.length, 0);
  await tick();
  assert.equal(f.changes.filter(change => change.type === 'event').length, 0);
  await f.controller.stop();
});

test('applyAdmin and refreshExplicit honor the accepting and lease gates', async () => {
  let lease = true;
  const f = fixture({ canPost: () => lease });
  lease = false;
  await assert.rejects(f.controller.applyAdmin(webRequest({ type: 'publish' })), ControllerUnavailableError);
  await assert.rejects(f.controller.refreshExplicit(), ControllerUnavailableError);
  lease = true;
  await f.controller.stop();
  await assert.rejects(f.controller.applyAdmin(webRequest({ type: 'publish' })), ControllerUnavailableError);
  await assert.rejects(f.controller.refreshExplicit(), ControllerUnavailableError);
  assert.equal(f.web.length, 0);
});

test('applyAdmin: a judge-resume schedules the expiry timer from the latest state', async () => {
  let now = 10_000;
  const f = fixture({ clock: () => now });
  f.state = transition(f.state, 'admin:fixture', { type: 'publish' }, now, RUNNER).state;
  f.state = transition(f.state, 'player:A', { type: 'ready', matchId: 'M1' }, now, RUNNER).state;
  f.state = transition(f.state, 'player:B', { type: 'ready', matchId: 'M1' }, now, RUNNER).state;
  f.state = transition(f.state, 'player:A', { type: 'pause', matchId: 'M1' }, now + 59_990, RUNNER).state;
  now += 100_000;
  // 10 ms of the 60 s clock remain when the judge resumes the match.
  const result = await f.controller.applyAdmin(webRequest({ type: 'judgeResume', matchId: 'M1', reason: 'Checked.' }));
  assert.equal(result.reply, 'Saved: judgeResume.');
  assert.equal(f.state.matches[0]!.phase, 'running');
  now += 10;
  const deadline = Date.now() + 2_000;
  while (!f.discord.some(entry => entry.context.timer) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const timer = f.discord.find(entry => entry.context.timer);
  assert.ok(timer, 'the expiry timer fired');
  assert.deepEqual(timer.command, { type: 'clockCheck', matchId: 'M1' });
  assert.equal(timer.context.principalId, 'system:timer');
  assert.equal(f.state.matches[0]!.phase, 'expired');
  await f.controller.stop();
});

test('refreshExplicit: a card permission refusal is reported as cardError; /tcg-test refresh still replies pending', async () => {
  const f = fixture({ syncRooms: async () => { throw new RuleError('Room policy is pending.'); } });
  f.failEdit = new Error('missing');
  f.failSend = new Error('forbidden');
  const result = await f.controller.refreshExplicit();
  assert.deepEqual(result, { cards: 'pending',
    cardError: 'Private Discord card permission denied; fix channel permissions before refresh.',
    roomWarning: 'Room policy is pending.', reply: 'Practice card refresh pending. Room setup pending: Room policy is pending.' });
  const command = slash('refresh');
  await f.controller.handle(command.interaction);
  assert.deepEqual(command.replies, ['Practice card refresh pending. Room setup pending: Room policy is pending.']);
  f.failEdit = null;
  f.failSend = null;
  const ok = fixture();
  assert.deepEqual(await ok.controller.refreshExplicit(),
    { cards: 'refreshed', cardError: null, roomWarning: null, reply: 'Practice cards refreshed.' });
  await f.controller.stop();
  await ok.controller.stop();
});

test('slash admin commands keep their replies through the shared commit path', async () => {
  const f = fixture({ syncRooms: async () => { throw new RuleError('Room M2 is pending.'); } });
  const publish = slash('publish');
  await f.controller.handle(publish.interaction);
  assert.deepEqual(publish.replies, ['Saved: publish. Room setup pending: Room M2 is pending.']);
  assert.equal(f.discord.at(-1)!.context.interactionId, ids[0]);
  assert.equal(f.web.length, 0);

  const again = slash('publish', { id: ids[1]! });
  await f.controller.handle(again.interaction);
  assert.deepEqual(again.replies, ['Fixture round requires four check-ins and one publication.']);

  const wrongWinner = slash('resolve', { id: ids[2]!, matchId: 'M1', winner: 'C', reason: 'x' });
  await f.controller.handle(wrongWinner.interaction);
  assert.deepEqual(wrongWinner.replies, ['Winner is not in the selected match.']);

  const notAdmin = slash('publish', { id: ids[3]!, userId: config.players.A });
  await f.controller.handle(notAdmin.interaction);
  assert.deepEqual(notAdmin.replies, ['Private test admin action denied.']);

  f.failEdit = new Error('retry');
  const resolve = slash('resolve', { id: ids[4]!, matchId: 'M1', winner: 'A', reason: 'Ruling' });
  f.state = transition(f.state, 'player:A', { type: 'ready', matchId: 'M1' }, 1_000, RUNNER).state;
  f.state = transition(f.state, 'player:B', { type: 'ready', matchId: 'M1' }, 1_000, RUNNER).state;
  await f.controller.handle(resolve.interaction);
  assert.deepEqual(resolve.replies, ['Saved: resolve. Card update pending.']);
  await f.controller.stop();
});
