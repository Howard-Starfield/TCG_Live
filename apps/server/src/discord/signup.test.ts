import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignupFixture, transition, type Command, type EventState } from '../rehearsal/domain.js';
import { verifyState } from '../rehearsal/store.js';
import { buttonId, parseButtonId, renderCard } from './cards.js';
import { readPrivateDiscordConfig } from './config.js';
import { PrivateDiscordController, type PrivateInteraction } from './controller.js';
import { resolvePlayers, type SessionRow } from './session.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333',
  '444444444444444444', '555555555555555555', '666666666666666666',
  '777777777777777777', '888888888888888888'];
const eventId = '11111111-1111-4111-8111-111111111111';
const env = {
  TCG_DISCORD_APPLICATION_ID: ids[0]!, TCG_DISCORD_GUILD_ID: ids[1]!,
  TCG_DISCORD_CHANNEL_ID: ids[2]!, TCG_DISCORD_ADMIN_ID: ids[7]!
};
const config = readPrivateDiscordConfig(env, false, 'signup');
const session: SessionRow = { event_id: eventId, application_id: config.applicationId,
  guild_id: config.guildId, channel_id: config.channelId,
  identity_map: { kind: 'signup', adminId: config.adminId }, status: 'active',
  checkin_message_id: null, m1_message_id: null, m2_message_id: null };
const run = (state: EventState, actor: string, command: Parameters<typeof transition>[2]) =>
  transition(state, actor, command, 1_000, 'runner');

test('signup config excludes preset IDs and accepts player-free setup', () => {
  assert.equal(config.players, undefined);
  assert.throws(() => readPrivateDiscordConfig({ ...env, TCG_DISCORD_PLAYER_A_ID: ids[3] }, false, 'signup'),
    /refuses preset player IDs/);
  assert.throws(() => readPrivateDiscordConfig(env, false), /PLAYER_A_ID/);
});

test('join order assigns four distinct members; check-in and publish remain separate', () => {
  let state = createSignupFixture(eventId);
  assert.equal(resolvePlayers(session, state), null);
  assert.throws(() => run(state, 'player:A', { type: 'checkin' }), /Signup is still open/);
  assert.throws(() => run(state, 'admin:fixture', { type: 'signupJoin' }), /member action denied/);
  const roster = [ids[4]!, ids[3]!, ids[5]!, ids[6]!];
  for (const id of roster) state = run(state, `member:${id}`, { type: 'signupJoin' }).state;
  assert.equal(state.signup?.roster.length, 4);
  const duplicate = run(state, `member:${roster[0]}`, { type: 'signupJoin' });
  assert.equal(duplicate.outcome.applied, false);
  assert.equal(duplicate.state.version, state.version);
  assert.throws(() => run(state, `member:${ids[2]}`, { type: 'signupJoin' }), /full/);
  assert.throws(() => run(state, 'admin:fixture', { type: 'signupClose', adminId: roster[0]! }), /nonadmin/);
  state = run(state, 'admin:fixture', { type: 'signupClose', adminId: ids[7]! }).state;
  assert.deepEqual(resolvePlayers(session, state), { A: roster[0], B: roster[1], C: roster[2], D: roster[3] });
  assert.equal(state.checkins.length, 0);
  assert.throws(() => run(state, `member:${ids[2]}`, { type: 'signupJoin' }), /closed/);
  assert.throws(() => run(state, 'admin:fixture', { type: 'publish' }), /four check-ins/);
  for (const player of ['A', 'B', 'C', 'D'] as const)
    state = run(state, `player:${player}`, { type: 'checkin' }).state;
  state = run(state, 'admin:fixture', { type: 'publish' }).state;
  assert.throws(() => run(state, 'admin:fixture', { type: 'signupReopen' }), /unavailable/);
});

test('withdraw and admin remove are open-only; reopen clears attendance and assignment', () => {
  let state = createSignupFixture(eventId);
  const roster = [ids[3]!, ids[4]!, ids[5]!, ids[6]!];
  assert.equal(run(state, `member:${roster[0]}`, { type: 'signupWithdraw' }).outcome.applied, false);
  assert.throws(() => run(state, 'admin:fixture', { type: 'signupRemove', memberId: 'bad' }), /Invalid signup member ID/);
  for (const id of roster) state = run(state, `member:${id}`, { type: 'signupJoin' }).state;
  state = run(state, 'admin:fixture', { type: 'signupRemove', memberId: roster[1]! }).state;
  assert.deepEqual(state.signup?.roster, [roster[0], roster[2], roster[3]]);
  state = run(state, `member:${roster[1]}`, { type: 'signupJoin' }).state;
  state = run(state, 'admin:fixture', { type: 'signupClose', adminId: ids[7]! }).state;
  state = run(state, 'player:A', { type: 'checkin' }).state;
  assert.throws(() => run(state, 'admin:fixture', { type: 'signupRemove', memberId: roster[0]! }), /closed/);
  state = run(state, 'admin:fixture', { type: 'signupReopen' }).state;
  assert.equal(state.signup?.status, 'open');
  assert.equal(state.signup?.assignment, undefined);
  assert.deepEqual(state.checkins, []);
  assert.deepEqual(state.signup?.roster, [roster[0], roster[2], roster[3], roster[1]]);
  assert.equal(resolvePlayers(session, state), null);
});

test('schema v2 and frozen identity reject rollback and admin-in-roster corruption', () => {
  const state = createSignupFixture(eventId);
  assert.doesNotThrow(() => verifyState(state, eventId, 0));
  assert.throws(() => verifyState({ ...state, schemaVersion: 1 }, eventId, 0), /incompatible/);
  assert.throws(() => resolvePlayers({ ...session, identity_map: { kind: 'signup', adminId: ids[7]!,
    players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! } } as never }, state), /conflicts/);
  const poisoned = { ...state, signup: { status: 'open' as const, roster: [ids[7]!] } };
  assert.throws(() => resolvePlayers(session, poisoned), /conflicts/);
});

test('signup cards use distinct actions and do not mention players on unassigned matches', () => {
  let state = createSignupFixture(eventId);
  const signupCard = renderCard(state, 'checkin');
  assert.match(signupCard.embeds[0]!.description, /Signup: open/);
  assert.deepEqual(signupCard.components[0]!.components.map(button => parseButtonId(button.custom_id).action),
    ['signupJoin', 'signupWithdraw']);
  assert.equal(signupCard.allowedMentions.parse.length, 0);
  assert.match(renderCard(state, 'M1').embeds[0]!.description, /Awaiting signup/);
  assert.doesNotMatch(renderCard(state, 'M1').embeds[0]!.description, /<@/);
  assert.equal(parseButtonId(buttonId(eventId, 'checkin', 'signupJoin')).slot, 'checkin');
  assert.throws(() => parseButtonId(buttonId(eventId, 'M1', 'signupJoin')), /Invalid/);
  for (const id of [ids[3]!, ids[4]!, ids[5]!, ids[6]!]) state = run(state, `member:${id}`, { type: 'signupJoin' }).state;
  state = run(state, 'admin:fixture', { type: 'signupClose', adminId: ids[7]! }).state;
  const assigned = renderCard(state, 'checkin', undefined, resolvePlayers(session, state)!);
  assert.deepEqual(assigned.components[0]!.components.map(button => parseButtonId(button.custom_id).action), ['checkin']);
  assert.equal(assigned.allowedMentions.parse.length, 0);
});

test('controller rejects a stale Join after close and reads assigned players from saved state', async () => {
  let state = createSignupFixture(eventId);
  const bound = { ...session, checkin_message_id: ids[0]! };
  const applied: Command[] = [];
  const controller = new PrivateDiscordController(config, 'runner', {
    async send() { throw new Error('unexpected send'); }, async edit() {}, async pin() {},
    classify() { return 'retry'; }
  }, async () => ({ session: bound, state }), async (_context, command) => {
    applied.push(command);
    const actor = command.type === 'signupJoin' ? `member:${ids[3]}` : 'player:A';
    const next = run(state, actor, command);
    state = next.state;
    return next.outcome;
  });
  const replies: string[] = [];
  const click = (action: 'signupJoin' | 'checkin', userId = ids[3]!): PrivateInteraction => ({
    id: ids[1]!, applicationId: config.applicationId, guildId: config.guildId,
    channelId: config.channelId, userId, kind: 'button',
    customId: buttonId(eventId, 'checkin', action), messageId: ids[0]!,
    async acknowledge() {}, async reply(message) { replies.push(message); }
  });
  await controller.handle(click('signupJoin'));
  assert.equal(applied.length, 1);
  for (const id of [ids[4]!, ids[5]!, ids[6]!]) state = run(state, `member:${id}`, { type: 'signupJoin' }).state;
  state = run(state, 'admin:fixture', { type: 'signupClose', adminId: ids[7]! }).state;
  await controller.handle(click('signupJoin'));
  assert.equal(applied.length, 1, 'stale Join never reaches the transaction adapter');
  assert.equal(replies.at(-1), 'Signup is closed.');
  await controller.handle(click('checkin'));
  assert.equal(applied.at(-1)?.type, 'checkin');
  await controller.stop();
});
