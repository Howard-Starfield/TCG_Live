// Staff roles through PrivateDiscordController: judge-close and evidence-reply end to end, the conflict rule on
// evidence replies, and the "no other staff" warning after a committed signup close.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvidenceReplyDto } from '@tcg-live/core';
import { OpsInputError } from '../ops/errors.js';
import { ADMIN, createFixture, createSignupFixture, transition, type Command, type EventState, type Outcome } from '../rehearsal/domain.js';
import type { DiscordCommandContext } from '../rehearsal/store.js';
import { PrivateDiscordController, type CardTransport, type EvidenceReplyRequest, type PrivateInteraction } from './controller.js';
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
const ORG_ROLE = '500000000000000001';
const JUDGE_ROLE = '500000000000000002';
const ORG = '210000000000000001';
const JUDGE = '210000000000000002';
const roles = { guildId: config.guildId, organizerRoleId: ORG_ROLE, judgeRoleId: JUDGE_ROLE };

/** M1 (A vs B) running with a judge called; M2 (C vs D) running. */
function liveState(): EventState {
  let state = createFixture(eventId);
  for (const seat of ['A', 'B', 'C', 'D'] as const) state = transition(state, `player:${seat}`, { type: 'checkin' }, 1, RUNNER).state;
  state = transition(state, ADMIN, { type: 'publish' }, 2, RUNNER).state;
  for (const [seat, matchId] of [['A', 'M1'], ['B', 'M1'], ['C', 'M2'], ['D', 'M2']] as const)
    state = transition(state, `player:${seat}`, { type: 'ready', matchId }, 3, RUNNER).state;
  return transition(state, 'player:A', { type: 'callJudge', matchId: 'M1' }, 4, RUNNER).state;
}

function fixture(initial: EventState, signup = false) {
  let state = initial;
  const session: SessionRow = { event_id: eventId, application_id: config.applicationId, guild_id: config.guildId,
    channel_id: config.channelId, identity_map: signup ? { kind: 'signup', adminId: config.adminId } : { players: config.players, adminId: config.adminId },
    status: 'active', checkin_message_id: ids[8]!, m1_message_id: ids[9]!, m2_message_id: ids[10]! };
  const applied: Array<{ context: DiscordCommandContext; command: Command }> = [];
  const replies: EvidenceReplyRequest[] = [];
  const transport: CardTransport = { async send() { return ids[0]!; }, async edit() {}, async pin() {}, classify() { return 'retry'; } };
  const controller = new PrivateDiscordController(config, RUNNER, transport, async () => ({ state, session }),
    async (context, command): Promise<Outcome> => {
      applied.push({ context, command });
      const result = transition(state, context.actor ? `${context.actor.role}:${context.principalId}` : 'player:A', command, 5, RUNNER);
      if (result.outcome.applied) state = result.state;
      return result.outcome;
    }, async () => {}, () => 5, 20, undefined, undefined, undefined, undefined, undefined,
    // The console path, never the real store.
    async (_context, command): Promise<Outcome> => {
      const result = transition(state, ADMIN, command, 5, RUNNER);
      if (result.outcome.applied) state = result.state;
      return result.outcome;
    });
  controller.setStaffSources(async () => ({ roles, legacyStaffRoleIds: [] }));
  let delivery: EvidenceReplyDto['status'] = 'delivered';
  let failure: Error | null = null;
  controller.setEvidenceReplies(async request => {
    replies.push(request);
    if (failure) throw failure;
    return { id: '22222222-2222-4222-8222-222222222222', eventId: request.eventId, matchId: request.matchId, author: request.author,
      body: request.body, audience: request.audience, status: request.audience === 'staff' ? 'recorded' : delivery,
      deliveryError: delivery === 'failed' ? 'The match room no longer exists.' : null, discordMessageId: null, createdAtMs: 5 };
  });
  const slash = (subcommand: string, extra: Partial<PrivateInteraction> = {}) => {
    const texts: string[] = [];
    const interaction: PrivateInteraction = { id: ids[0]!, applicationId: config.applicationId, guildId: config.guildId,
      channelId: config.channelId, userId: JUDGE, roleIds: [JUDGE_ROLE], kind: 'command', subcommand,
      acknowledge: async () => {}, reply: async message => { texts.push(message); }, ...extra };
    return { interaction, texts };
  };
  return { controller, applied, replies, slash, get state() { return state; },
    set delivery(value: EvidenceReplyDto['status']) { delivery = value; }, set failure(value: Error | null) { failure = value; } };
}

test('judge-close: a judge closes a judge request with a note; the autocomplete lists only matches needing a judge', async () => {
  const f = fixture(liveState());
  const choices = await f.controller.autocomplete('judge-close', 'match', '', null);
  assert.deepEqual(choices.map(choice => choice.value), ['M1'], 'M2 has no judge request');
  const close = f.slash('judge-close', { matchId: 'm1' as 'M1', reason: 'Settled at the table' });
  await f.controller.handle(close.interaction);
  assert.deepEqual(f.applied[0]!.command, { type: 'judgeClose', matchId: 'M1', reason: 'Settled at the table' });
  assert.equal(f.applied[0]!.context.actor?.role, 'judge');
  assert.equal(f.applied[0]!.context.principalId, JUDGE);
  assert.match(close.texts[0]!, /^Saved: judgeClose/);
  assert.equal(f.state.matches[0]!.judgeAttention, false);
  const noNote = f.slash('judge-close', { matchId: 'M1' });
  await f.controller.handle(noNote.interaction);
  assert.equal(noNote.texts[0], 'Invalid admin command options.');
  await f.controller.stop();
});

test('evidence-reply: a judge replies through the evidence replies service, to the players or staff-only', async () => {
  const f = fixture(liveState());
  const reply = f.slash('evidence-reply', { matchId: 'm1' as 'M1', text: '  Please send the clip.  ' });
  await f.controller.handle(reply.interaction);
  assert.deepEqual(f.replies[0], { eventId, matchId: 'M1', body: '  Please send the clip.  ', audience: 'players', author: JUDGE,
    actor: { kind: 'admin', id: JUDGE } });
  assert.equal(reply.texts[0], 'Reply sent to the players of M1.');
  assert.equal(f.applied.length, 0, 'a reply is not a domain command');
  const staffOnly = f.slash('evidence-reply', { matchId: 'M2', text: 'Note for us', staffOnly: true });
  await f.controller.handle(staffOnly.interaction);
  assert.equal(f.replies[1]!.audience, 'staff');
  assert.match(staffOnly.texts[0]!, /^Staff-only note saved on M2/);
  f.delivery = 'failed';
  const failed = f.slash('evidence-reply', { matchId: 'M2', text: 'Hello' });
  await f.controller.handle(failed.interaction);
  assert.match(failed.texts[0]!, /could not deliver it: The match room no longer exists\. Retry it from the dashboard/);
  f.failure = new OpsInputError('A reply must be 1-1500 readable characters.');
  const empty = f.slash('evidence-reply', { matchId: 'M2', text: '' });
  await f.controller.handle(empty.interaction);
  assert.equal(empty.texts[0], 'A reply must be 1-1500 readable characters.');
  const unknown = f.slash('evidence-reply', { matchId: 'M9', text: 'x' });
  await f.controller.handle(unknown.interaction);
  assert.match(unknown.texts[0]!, /Unknown match/);
  // Strangers never reach the service.
  const stranger = f.slash('evidence-reply', { matchId: 'M1', text: 'x', userId: ids[9]!, roleIds: [] });
  await f.controller.handle(stranger.interaction);
  assert.match(stranger.texts[0]!, /Only the organizer or tournament staff/);
  assert.equal(f.replies.length, 4);
  await f.controller.stop();
});

test('evidence-reply: staff seated in the match cannot reply on it (conflict rule), but can on another match', async () => {
  const f = fixture(liveState());
  const own = f.slash('evidence-reply', { matchId: 'M1', text: 'x', userId: config.players.A, roleIds: [ORG_ROLE] });
  await f.controller.handle(own.interaction);
  assert.equal(own.texts[0], 'You are playing in M1, so another organizer or judge must rule on it.');
  assert.equal(f.replies.length, 0);
  const other = f.slash('evidence-reply', { matchId: 'M2', text: 'x', userId: config.players.A, roleIds: [ORG_ROLE] });
  await f.controller.handle(other.interaction);
  assert.equal(other.texts[0], 'Reply sent to the players of M2.');
  await f.controller.stop();
});

test('after a committed signup close, a missing second staff member produces a warning (Discord reply and admin result)', async () => {
  const roster = [ids[3]!, ids[4]!, ids[5]!, ids[6]!];
  const signupState = () => {
    let state = createSignupFixture(eventId);
    for (const id of roster) state = transition(state, `member:${id}`, { type: 'signupJoin' }, 1, RUNNER).state;
    return state;
  };
  const coverage = (otherStaff: number, complete: boolean) => {
    const seen: string[][] = [];
    return { seen, run: async (seated: readonly string[]) => { seen.push([...seated]); return { otherStaff, complete }; } };
  };
  const cases: Array<[number, boolean, RegExp | null]> = [[0, true, /No other TCG Organizer or TCG Judge/], [0, false, /Could not confirm another/], [2, true, null], [1, false, null]];
  for (const [otherStaff, complete, expected] of cases) {
    const f = fixture(signupState(), true);
    const c = coverage(otherStaff, complete);
    f.controller.setStaffCoverage(c.run);
    const close = f.slash('signup-close', { userId: ORG, roleIds: [ORG_ROLE] });
    await f.controller.handle(close.interaction);
    assert.deepEqual(c.seen, [roster], 'coverage is asked about the closed roster');
    if (expected) assert.match(close.texts[0]!, new RegExp(`^Saved: signupClose\\. Warning: .*${expected.source}`));
    else assert.equal(close.texts[0], 'Saved: signupClose.');
    await f.controller.stop();
  }
  // A throwing lookup never fails the committed close.
  const g = fixture(signupState(), true);
  g.controller.setStaffCoverage(async () => { throw new Error('discord down'); });
  const closed = await g.controller.applyAdmin({ eventId, principalId: 'local-admin', commandId: 'web:0f8fad5b-d9cb-469f-a165-70867728950e',
    content: '[]', precondition: () => true, command: { type: 'signupClose', adminId: config.adminId } });
  assert.equal(closed.outcome.applied, true);
  assert.match(closed.staffWarning!, /Could not confirm another/);
  assert.equal(closed.reply, 'Saved: signupClose.', 'the warning is separate from the reply text');
  // No coverage source: no warning, nothing to ask.
  const h = fixture(signupState(), true);
  const plain = await h.controller.applyAdmin({ eventId, principalId: 'local-admin', commandId: 'web:0f8fad5b-d9cb-469f-a165-70867728950e',
    content: '[]', precondition: () => true, command: { type: 'signupClose', adminId: config.adminId } });
  assert.equal('staffWarning' in plain, false);
  await g.controller.stop();
  await h.controller.stop();
});

test('the audit roleName is the real name of the matched role, null for the owner; unmapped subcommands are refused', async () => {
  const f = fixture(liveState());
  const names = { [JUDGE_ROLE]: 'Table Judges', [ORG_ROLE]: 'Head TO' };
  await f.controller.handle(f.slash('judge-close', { matchId: 'M1', reason: 'ok', roleNames: names }).interaction);
  assert.equal(f.applied[0]!.context.actor?.roleName, 'Table Judges', 'a role renamed through the card');
  // Without a known name there is no invented one.
  const g = fixture(liveState());
  await g.controller.handle(g.slash('judge-close', { matchId: 'M1', reason: 'ok' }).interaction);
  assert.equal(g.applied[0]!.context.actor?.roleName, null);
  const owner = fixture(liveState());
  await owner.controller.handle(owner.slash('judge-close', { matchId: 'M1', reason: 'ok', userId: ids[9]!, roleIds: [], ownerId: ids[9]!, roleNames: names }).interaction);
  assert.equal(owner.applied[0]!.context.actor?.roleName, null, 'the owner has no role');
  assert.equal(owner.applied[0]!.context.actor?.via, 'owner');
  const legacy = fixture(liveState());
  legacy.controller.setStaffSources(async () => ({ roles, legacyStaffRoleIds: ['500000000000000009'] }));
  await legacy.controller.handle(legacy.slash('judge-close', { matchId: 'M1', reason: 'ok', roleIds: ['500000000000000009'],
    roleNames: { '500000000000000009': 'Old Staff' } }).interaction);
  assert.equal(legacy.applied[0]!.context.actor?.roleName, 'Old Staff');
  const bogus = f.slash('mystery', { userId: ORG, roleIds: [ORG_ROLE] });
  await f.controller.handle(bogus.interaction);
  assert.equal(bogus.texts[0], 'Unknown staff command.');
  assert.equal(f.applied.length, 1);
  await Promise.all([f, g, owner, legacy].map(item => item.controller.stop()));
});
