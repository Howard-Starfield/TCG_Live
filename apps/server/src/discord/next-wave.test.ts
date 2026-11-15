// Next wave (agent G1): command structure and registration, tournament staff, organizer signup-add and
// check-in-for, evidence button and recording badge on cards, /tcg-admin moderation and tempbans.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_TOOLS_LIMITS } from '@tcg-live/core';
import { createFixture, createSignupFixture, transition, type Command, type EventState, type Outcome } from '../rehearsal/domain.js';
import type { DiscordCommandContext } from '../rehearsal/store.js';
import { ADMIN_COMMAND_NAME, adminCommandDefinition } from './admin-command.js';
import { buttonId, EVIDENCE_WINDOW_MS, evidenceWindowOpen, parseButtonId, renderCard } from './cards.js';
import type { PrivateDiscordConfig } from './config.js';
import { PrivateDiscordController, type CardTransport, type PrivateInteraction } from './controller.js';
import { onRecordingBadgeChange, recordingMatchIds, resetRecordingBadges, setMatchRecording, syncRecordingFromPool } from './recording-badge.js';
import { answerEvidenceUnavailable, commandDefinition, comparableCommand, EVIDENCE_UNAVAILABLE, registerPrivateCommand,
  staffCommandDefinition } from './runtime.js';
import type { SessionRow } from './session.js';
import { isTournamentStaff, memberRoleIds } from './staff.js';
import { actorOutranks, parseDuration, SEATED_CONFLICT, seatedConflict } from '../admin-tools/members/discord-feature.js';
import { demoMembersBackend } from '../admin-tools/members/backend.js';
import { moderateMember } from '../admin-tools/members/service.js';
import { MemoryModCaseStore } from '../admin-tools/members/store.js';
import { liftExpiredTempbans } from '../admin-tools/members/tempbans.js';
import { parseModAction } from '../admin-tools/members/parse.js';
import { parseAdminToolsSettings } from '../admin-tools/settings.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { DEFAULT_ADMIN_TOOLS_SETTINGS } from '@tcg-live/core';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888',
  '999999999999999991', '999999999999999992', '999999999999999993', '999999999999999994', '999999999999999995'];
const config = {
  applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]!
} satisfies PrivateDiscordConfig;
const eventId = '11111111-1111-4111-8111-111111111111';
const RUNNER = 'runner';
const STAFF = ids[11]!;
const STAFF_ROLE = ids[12]!;

// ---------------------------------------------------------------- domain

test('signupAdd: organizer only, open signup, capacity, already joined is a no-change', () => {
  let state: EventState = createSignupFixture(eventId);
  assert.throws(() => transition(state, `member:${ids[3]}`, { type: 'signupAdd', memberId: ids[3]! }, 1, RUNNER), /admin action denied/);
  for (const id of ids.slice(3, 7)) state = transition(state, 'admin:fixture', { type: 'signupAdd', memberId: id }, 1, RUNNER).state;
  assert.deepEqual(state.signup!.roster, ids.slice(3, 7));
  assert.equal(transition(state, 'admin:fixture', { type: 'signupAdd', memberId: ids[3]! }, 1, RUNNER).outcome.result, 'already_joined');
  assert.throws(() => transition(state, 'admin:fixture', { type: 'signupAdd', memberId: ids[8]! }, 1, RUNNER), /full/);
  assert.throws(() => transition(state, 'admin:fixture', { type: 'signupAdd', memberId: 'x' }, 1, RUNNER));
});

test('checkinFor: organizer checks a seat in; a second time is a no-change; players cannot use it', () => {
  const state = createFixture(eventId);
  const once = transition(state, 'admin:fixture', { type: 'checkinFor', seat: 'B' }, 1, RUNNER);
  assert.deepEqual(once.state.checkins, ['B']);
  assert.equal(transition(once.state, 'admin:fixture', { type: 'checkinFor', seat: 'B' }, 1, RUNNER).outcome.result, 'already_checked_in');
  assert.throws(() => transition(state, 'player:A', { type: 'checkinFor', seat: 'B' }, 1, RUNNER), /admin action denied/);
  assert.throws(() => transition(state, 'admin:fixture', { type: 'checkinFor', seat: 'P9' as never }, 1, RUNNER), /seat/);
});

test('a final result records finalAtMs; the evidence window closes 24 h later', () => {
  let state = createFixture(eventId);
  for (const seat of ['A', 'B', 'C', 'D'] as const) state = transition(state, `player:${seat}`, { type: 'checkin' }, 1, RUNNER).state;
  state = transition(state, 'admin:fixture', { type: 'publish' }, 2, RUNNER).state;
  state = transition(state, 'player:A', { type: 'ready', matchId: 'M1' }, 3, RUNNER).state;
  state = transition(state, 'player:B', { type: 'ready', matchId: 'M1' }, 3, RUNNER).state;
  const resolved = transition(state, 'admin:fixture', { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'r' }, 1_000, RUNNER).state;
  const match = resolved.matches[0]!;
  assert.equal(match.finalAtMs, 1_000);
  assert.equal(evidenceWindowOpen(match, 1_000 + EVIDENCE_WINDOW_MS), true);
  assert.equal(evidenceWindowOpen(match, 1_001 + EVIDENCE_WINDOW_MS), false);
  assert.equal(evidenceWindowOpen(state.matches[1]!, 5), false, 'a match in setup has no evidence button');
});

// ---------------------------------------------------------------- cards

test('match card: Submit evidence while a judge is needed and after the result; recording badge; signup policy line', () => {
  let state = createFixture(eventId);
  for (const seat of ['A', 'B', 'C', 'D'] as const) state = transition(state, `player:${seat}`, { type: 'checkin' }, 1, RUNNER).state;
  state = transition(state, 'admin:fixture', { type: 'publish' }, 2, RUNNER).state;
  const labels = (s: EventState, options = {}) => renderCard(s, 'M1', RUNNER, undefined, undefined, undefined, options)
    .components.flatMap(row => row.components.map(button => button.label));
  assert.ok(!labels(state).includes('Submit evidence'));
  const called = transition(state, 'player:A', { type: 'callJudge', matchId: 'M1' }, 3, RUNNER).state;
  assert.ok(labels(called).includes('Submit evidence'));
  const evidenceButton = renderCard(called, 'M1').components.flatMap(row => row.components).find(button => button.label === 'Submit evidence')!;
  assert.deepEqual(parseButtonId(evidenceButton.custom_id), { eventId, slot: 'M1', action: 'evidence' });
  assert.equal(evidenceButton.custom_id, buttonId(eventId, 'M1', 'evidence'));
  const recorded = renderCard(called, 'M1', RUNNER, undefined, undefined, undefined, { recording: new Set(['M1']) });
  assert.match(recorded.embeds[0]!.description, /🔴 Audio recording active/);
  assert.doesNotMatch(renderCard(called, 'M2', RUNNER, undefined, undefined, undefined, { recording: new Set(['M1']) }).embeds[0]!.description,
    /recording active/);
  const signup = createSignupFixture(eventId);
  assert.match(renderCard(signup, 'checkin', RUNNER, undefined, undefined, undefined, { recordingNotice: 'Rooms are recorded.' })
    .embeds[0]!.description, /Recording:\*\* Rooms are recorded\..*recording-optout/);
  assert.doesNotMatch(renderCard(signup, 'checkin').embeds[0]!.description, /Recording/);
});

test('recording badge merges the voice pool state and the direct setter, and notifies once per change', () => {
  resetRecordingBadges();
  let changes = 0;
  onRecordingBadgeChange(() => { changes++; });
  syncRecordingFromPool({ bots: {}, rooms: [{ matchId: 'M2', channelId: ids[0]!, botId: 'main', status: 'recording' },
    { matchId: 'M3', channelId: ids[1]!, botId: null, status: 'unmonitored' }] });
  setMatchRecording('M1', true);
  syncRecordingFromPool({ bots: {}, rooms: [{ matchId: 'M2', channelId: ids[0]!, botId: 'main', status: 'recording' }] });
  assert.deepEqual([...recordingMatchIds()].sort(), ['M1', 'M2']);
  assert.equal(changes, 2, 'an unchanged pool publish does not re-render');
  syncRecordingFromPool(null);
  setMatchRecording('M1', false);
  assert.equal(recordingMatchIds().size, 0);
  resetRecordingBadges();
});

// ---------------------------------------------------------------- commands and registration

test('/tcg-test is for players; /tcg-staff is Manage Server by default with autocomplete; /tcg-admin carries moderation', () => {
  const player = commandDefinition();
  assert.deepEqual(player.options?.map(option => option.name), ['evidence', 'recording-optout']);
  assert.equal(player.default_member_permissions, undefined, 'players see /tcg-test');
  const staff = staffCommandDefinition();
  assert.equal(staff.name, 'tcg-staff');
  assert.equal(staff.default_member_permissions, String(1 << 5));
  assert.deepEqual(staff.options?.map(option => option.name), ['publish', 'signup-close', 'signup-reopen', 'signup-remove', 'signup-add',
    'checkin-for', 'refresh', 'resolve', 'correct', 'judge-resume']);
  const resolve = staff.options!.find(option => option.name === 'resolve') as unknown as { options: Array<{ name: string; autocomplete?: boolean; choices?: unknown }> };
  assert.deepEqual(resolve.options.map(option => [option.name, !!option.autocomplete, !!option.choices]),
    [['match', true, false], ['winner', true, false], ['reason', false, false]], 'any match and seat, not a fixed M1/M2 list');
  const admin = adminCommandDefinition();
  assert.equal(admin.name, ADMIN_COMMAND_NAME);
  for (const name of ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'case', 'note'])
    assert.ok(admin.options?.some(option => option.name === name), name);
  assert.ok((admin.options?.length ?? 0) <= 25);
});

test('registration upserts all three commands on every start and skips unchanged definitions', async () => {
  const stored = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let nextId = 1;
  const rest = {
    async get() { return [...stored.entries()].map(([name, body]) => ({ ...body, name })); },
    async post(_route: string, { body }: { body: Record<string, unknown> }) {
      calls.push(`post:${body.name}`);
      // What Discord returns: server fields, nulls and localizations.
      stored.set(String(body.name), { ...JSON.parse(JSON.stringify(body)), id: String(nextId++), application_id: config.applicationId,
        version: '1', type: 1, nsfw: false, name_localizations: null, description_localizations: null,
        default_member_permissions: (body.default_member_permissions as string | undefined) ?? null });
      return {};
    },
    async patch(_route: string, { body }: { body: Record<string, unknown> }) { calls.push(`patch:${body.name}`); return {}; }
  };
  const first = await registerPrivateCommand(config, rest as never);
  assert.deepEqual(first.created, ['tcg-test', 'tcg-staff', 'tcg-admin']);
  const second = await registerPrivateCommand(config, rest as never);
  assert.deepEqual(second, { created: [], updated: [], unchanged: ['tcg-test', 'tcg-staff', 'tcg-admin'] });
  // An older install: /tcg-test still has the admin subcommands, so it is PATCHed.
  stored.set('tcg-test', { ...stored.get('tcg-test')!, options: [{ type: 1, name: 'publish', description: 'Publish' }] });
  const third = await registerPrivateCommand(config, rest as never);
  assert.deepEqual(third.updated, ['tcg-test']);
  assert.deepEqual(calls, ['post:tcg-test', 'post:tcg-staff', 'post:tcg-admin', 'patch:tcg-test']);
  assert.deepEqual(comparableCommand({ a: null, b: false, c: [], options: [], d_localizations: {} }), { c: [] });
});

// ---------------------------------------------------------------- staff

test('tournament staff: the organizer, or a member holding a configured staff role', () => {
  assert.deepEqual(memberRoleIds({ roles: [STAFF_ROLE] }), [STAFF_ROLE]);
  assert.deepEqual(memberRoleIds({ roles: { cache: new Map([[STAFF_ROLE, {}]]) } }), [STAFF_ROLE]);
  assert.deepEqual(memberRoleIds(null), []);
  // A cached GuildMember lists @everyone too; it never counts as a staff role.
  const GUILD_ID = '100000000000000001';
  const cached = { guild: { id: GUILD_ID }, roles: { cache: new Map([[GUILD_ID, {}], [STAFF_ROLE, {}]]) } };
  assert.deepEqual(memberRoleIds(cached), [STAFF_ROLE]);
  assert.equal(isTournamentStaff({ userId: '200000000000000009', adminId: '200000000000000001',
    roleIds: memberRoleIds({ guild: { id: GUILD_ID }, roles: { cache: new Map([[GUILD_ID, {}]]) } }), staffRoleIds: [GUILD_ID] }), false);
  assert.equal(isTournamentStaff({ userId: config.adminId, adminId: config.adminId, roleIds: [], staffRoleIds: [] }), true);
  assert.equal(isTournamentStaff({ userId: STAFF, adminId: config.adminId, roleIds: [STAFF_ROLE], staffRoleIds: [STAFF_ROLE] }), true);
  assert.equal(isTournamentStaff({ userId: STAFF, adminId: config.adminId, roleIds: [STAFF_ROLE], staffRoleIds: undefined }), false);
});

test('admin-tools settings: cases.staffRoleIds is optional, validated, and absent stays absent', () => {
  const body = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as unknown as { cases: Record<string, unknown> };
  assert.equal('staffRoleIds' in parseAdminToolsSettings(body).cases, false);
  body.cases.staffRoleIds = [STAFF_ROLE, STAFF_ROLE];
  assert.deepEqual(parseAdminToolsSettings(body).cases.staffRoleIds, [STAFF_ROLE]);
  body.cases.staffRoleIds = ['nope'];
  assert.throws(() => parseAdminToolsSettings(body), /Discord IDs/);
});

function controllerFixture() {
  let state: EventState = createFixture(eventId);
  const session: SessionRow = { event_id: eventId, application_id: config.applicationId, guild_id: config.guildId,
    channel_id: config.channelId, identity_map: { players: config.players, adminId: config.adminId }, status: 'active',
    checkin_message_id: ids[8]!, m1_message_id: ids[9]!, m2_message_id: ids[10]! };
  const applied: Array<{ context: DiscordCommandContext; command: Command }> = [];
  const transport: CardTransport = { async send() { return ids[0]!; }, async edit() {}, async pin() {}, classify() { return 'retry'; } };
  const controller = new PrivateDiscordController(config, RUNNER, transport, async () => ({ state, session }),
    async (context, command): Promise<Outcome> => {
      applied.push({ context, command });
      const actor = context.principalId === config.adminId || (context.staff && !context.message) ? 'admin:fixture' : 'player:A';
      const result = transition(state, actor, command, 1_000, RUNNER);
      if (result.outcome.applied) state = result.state;
      return result.outcome;
    }, async () => {}, () => 1_000, 20);
  controller.setStaffRoles(async () => [STAFF_ROLE]);
  const slash = (subcommand: string, extra: Partial<PrivateInteraction> = {}) => {
    const replies: string[] = [];
    const interaction: PrivateInteraction = { id: ids[0]!, applicationId: config.applicationId, guildId: config.guildId,
      channelId: config.channelId, userId: STAFF, roleIds: [STAFF_ROLE], kind: 'command', subcommand,
      acknowledge: async () => {}, reply: async message => { replies.push(message); }, ...extra };
    return { interaction, replies };
  };
  return { controller, applied, slash, get state() { return state; } };
}

test('a staff-role member runs /tcg-staff checkin-for as the organizer; the real user is recorded; others are refused', async () => {
  const f = controllerFixture();
  const byMention = f.slash('checkin-for', { player: `<@${config.players.C}>` });
  await f.controller.handle(byMention.interaction);
  assert.deepEqual(f.applied[0]!.command, { type: 'checkinFor', seat: 'C' });
  assert.equal(f.applied[0]!.context.principalId, STAFF, 'principal_id keeps the real Discord user');
  assert.equal(f.applied[0]!.context.staff, true);
  assert.match(byMention.replies[0]!, /Saved: checkinFor/);
  const bySeat = f.slash('checkin-for', { player: 'd', userId: config.adminId, roleIds: [] });
  await f.controller.handle(bySeat.interaction);
  assert.deepEqual(f.applied[1]!.command, { type: 'checkinFor', seat: 'D' });
  assert.equal(f.applied[1]!.context.staff, undefined, 'the organizer acts as themselves');
  const outsider = f.slash('publish', { userId: ids[9]!, roleIds: [] });
  await f.controller.handle(outsider.interaction);
  assert.equal(f.applied.length, 2);
  assert.match(outsider.replies[0]!, /Only the organizer or tournament staff/);
  const seatedStaff = f.slash('publish', { userId: config.players.A, roleIds: [STAFF_ROLE] });
  await f.controller.handle(seatedStaff.interaction);
  assert.match(seatedStaff.replies[0]!, /Staff who play/);
  await f.controller.stop();
});

test('/tcg-staff resolve accepts any match and a mentioned winner; autocomplete lists live matches and their seats', async () => {
  const f = controllerFixture();
  for (const seat of ['A', 'B', 'C', 'D'] as const) await f.controller.handle(f.slash('checkin-for', { player: seat }).interaction);
  await f.controller.handle(f.slash('publish').interaction);
  assert.equal(f.state.published, true);
  const matchChoices = await f.controller.autocomplete('judge-resume', 'match', '', null);
  assert.deepEqual(matchChoices, [], 'nothing is paused');
  const winners = await f.controller.autocomplete('resolve', 'winner', '', 'm2', id => id === config.players.C ? 'Cy' : undefined);
  assert.deepEqual(winners.map(choice => choice.value), ['C', 'D']);
  assert.match(winners[0]!.name, /C · Cy/);
  const wrong = f.slash('resolve', { matchId: 'M2', winner: 'A', reason: 'r' });
  await f.controller.handle(wrong.interaction);
  assert.match(wrong.replies[0]!, /Winner is not in the selected match \(C vs D\)/);
  const unknown = f.slash('resolve', { matchId: 'M7', winner: 'A', reason: 'r' });
  await f.controller.handle(unknown.interaction);
  assert.match(unknown.replies[0]!, /Unknown match.*M1, M2/);
  await f.controller.stop();
});

test('/tcg-staff signup-add refuses the organizer and passes the member through', async () => {
  const f = controllerFixture();
  const self = f.slash('signup-add', { memberId: config.adminId });
  await f.controller.handle(self.interaction);
  assert.match(self.replies[0]!, /admin cannot play/);
  await f.controller.handle(f.slash('signup-add', { memberId: ids[9]! }).interaction);
  assert.deepEqual(f.applied.at(-1)!.command, { type: 'signupAdd', memberId: ids[9] });
  await f.controller.stop();
});

test('evidence form: seated players and staff while the window is open; anyone else is refused', async () => {
  const f = controllerFixture();
  assert.match((await f.controller.evidenceRefusal(config.players.A, [], eventId, 'M1'))!, /^Evidence for this match closed|^This match/);
  for (const seat of ['A', 'B', 'C', 'D'] as const) await f.controller.handle(f.slash('checkin-for', { player: seat }).interaction);
  await f.controller.handle(f.slash('publish').interaction);
  assert.match((await f.controller.evidenceRefusal(ids[9]!, [], eventId, 'M1'))!, /Only the two players/);
  assert.match((await f.controller.evidenceRefusal(config.players.A, [], eventId, 'M1'))!, /closed/, 'not before a judge call');
  await f.controller.stop();
});

// ---------------------------------------------------------------- moderation and tempbans

test('/tcg-admin moderation follows Discord role order: staff cannot act on equal or higher members; the owner can', () => {
  const member = (top: number | null, extra: { isOwner?: boolean; inGuild?: boolean } = {}) =>
    ({ isOwner: extra.isOwner ?? false, inGuild: extra.inGuild ?? top !== null, targetTop: top });
  assert.equal(actorOutranks(member(5), member(3)), null);
  assert.match(actorOutranks(member(5), member(5)) ?? '', /below yours/);
  assert.match(actorOutranks(member(2), member(7)) ?? '', /below yours/);
  assert.match(actorOutranks(member(9), member(1, { isOwner: true })) ?? '', /owner/);
  assert.equal(actorOutranks(member(0, { isOwner: true }), member(7)), null);
  // A user who left the server (ban by ID) has no roles to compare.
  assert.equal(actorOutranks(member(1), member(null)), null);
});

test('/tcg-admin moderation: a staff member seated in the current round cannot act on another seated player', () => {
  const rooms = [{ playerIds: ['200000000000000001', '200000000000000002'] }, { playerIds: ['200000000000000003', '200000000000000004'] }];
  assert.equal(seatedConflict(rooms, '200000000000000001', '200000000000000002'), true, 'same match');
  assert.equal(seatedConflict(rooms, '200000000000000001', '200000000000000004'), true, 'same round');
  assert.equal(seatedConflict(rooms, '200000000000000009', '200000000000000002'), false, 'actor not playing');
  assert.equal(seatedConflict(rooms, '200000000000000001', '200000000000000009'), false, 'target not playing');
  assert.equal(seatedConflict([], '200000000000000001', '200000000000000002'), false, 'no active event');
  assert.match(SEATED_CONFLICT, /another staff member/);
});

test('/tcg-test evidence always gets an ephemeral answer when the evidence feature is not running', async () => {
  const replies: Array<{ content: string; flags: unknown }> = [];
  const command = (name: string, sub: string) => ({ isChatInputCommand: () => true, commandName: name,
    options: { getSubcommand: () => sub }, reply: async (body: { content: string; flags: unknown }) => { replies.push(body); } }) as never;
  assert.equal(answerEvidenceUnavailable(command('tcg-test', 'evidence'), true), false, 'the feature answers it');
  assert.equal(answerEvidenceUnavailable(command('tcg-test', 'recording-optout'), false), false);
  assert.equal(answerEvidenceUnavailable(command('tcg-staff', 'evidence'), false), false);
  assert.equal(replies.length, 0);
  assert.equal(answerEvidenceUnavailable(command('tcg-test', 'evidence'), false), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.content, EVIDENCE_UNAVAILABLE);
  assert.equal(replies[0]!.flags, 64);
});

test('durations parse as minutes, hours, days and weeks', () => {
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('1d12h'), 36 * 3_600_000);
  assert.equal(parseDuration('2w'), 14 * 86_400_000);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration(''), null);
});

test('tempban: parse accepts a duration, the case stores expiresAtMs with the real actor, and the scheduler lifts it once', async () => {
  const day = 86_400_000;
  assert.throws(() => parseModAction({ action: 'ban', userId: ids[3], reason: 'x', deleteMessageSeconds: 0, durationMs: 1 }), /temporary ban/);
  // durationMs may be left out of a ban: a permanent ban, like null.
  const permanent = parseModAction({ action: 'ban', userId: ids[3], reason: 'x', deleteMessageSeconds: 0 });
  assert.equal(permanent.action === 'ban' && permanent.durationMs, null);
  assert.throws(() => parseModAction({ action: 'timeout', userId: ids[3], reason: 'x' }), /missing fields/);
  const request = parseModAction({ action: 'ban', userId: ids[3], reason: 'Cheating', deleteMessageSeconds: 0, durationMs: day });
  let now = 10_000;
  const audit = new MemoryOpsAuditStore();
  const cases = new MemoryModCaseStore(audit, () => now);
  const banned = new Set<string>();
  const sent: string[] = [];
  const backend = {
    ...demoMembersBackend({ members: [], bans: [], roles: [] } as never),
    async target(userId: string) { return { inGuild: true, isOwner: false, isBotSelf: false, targetTop: 0, botTop: 5,
      bot: { ban: true, kick: true, moderate: true, viewAuditLog: true }, timedOutUntilMs: null, banned: banned.has(userId) }; },
    async apply(userId: string, action: { kind: string }) { if (action.kind === 'ban') banned.add(userId); else if (action.kind === 'unban') banned.delete(userId); },
    async dm() { return true; },
    async postLog(_channel: string, text: string) { sent.push(text); }
  };
  const settings = async () => ({ cases: { dmMembers: true, logChannelId: ids[2]! } });
  const result = await moderateMember({ guildId: config.guildId, now: () => now, backend, cases, settings }, request,
    { kind: 'admin', id: STAFF }, 'discord');
  assert.equal(result.case.expiresAtMs, now + day);
  assert.equal(result.case.moderatorId, STAFF, 'the real Discord user, not local-admin');
  assert.equal(result.case.source, 'discord');
  assert.match(sent[0]!, /ban · until <t:\d+:f> · <@\d+> · by <@999999999999999994>/);
  const deps = { guildId: config.guildId, now: () => now, backend, cases, audit: (payload: Record<string, unknown>) =>
    audit.append({ kind: 'member.tempban_expired', actor: { kind: 'bot', id: 'bot' }, guildId: config.guildId, payload }) };
  assert.deepEqual(await liftExpiredTempbans(deps), [], 'not due yet');
  now += day + 1;   // also the catch-up after a restart: the due query only looks at the stored time
  assert.deepEqual(await liftExpiredTempbans(deps), [{ caseNumber: 1, outcome: 'unbanned' }]);
  assert.equal(banned.has(ids[3]!), false);
  assert.deepEqual(cases.cases.map(item => [item.number, item.kind, item.moderatorId]), [[1, 'ban', STAFF], [2, 'unban', 'bot']]);
  assert.equal(cases.cases[0]!.expiryHandledAtMs, now);
  assert.deepEqual(await liftExpiredTempbans(deps), [], 'lifted once');
  const kinds = (await audit.list({ limit: 50 })).entries.map(entry => entry.kind);
  assert.deepEqual(kinds, ['member.ban', 'member.unban', 'member.tempban_expired']);
  assert.ok(ADMIN_TOOLS_LIMITS.tempbanMsMax >= day);
});

test('tempban: a newer permanent ban supersedes the expiry; a manual unban is just marked handled', async () => {
  let now = 1_000;
  const audit = new MemoryOpsAuditStore();
  const cases = new MemoryModCaseStore(audit, () => now);
  const unbans: string[] = [];
  const backend = { ...demoMembersBackend({ members: [], bans: [], roles: [] } as never),
    async target() { return { banned: true } as never; }, async apply(userId: string) { unbans.push(userId); } };
  const actor = { kind: 'admin' as const, id: 'local-admin' };
  const make = (targetId: string, expiresAtMs: number | null) => cases.create(config.guildId, { kind: 'ban', targetId, reason: 'r', evidenceIds: [],
    eventId: null, matchId: null, source: 'dashboard', expiresAtMs }, actor, async () => {});
  await make(ids[3]!, 2_000);
  await make(ids[3]!, null);
  now = 5_000;
  const results = await liftExpiredTempbans({ guildId: config.guildId, now: () => now, backend, cases, audit: async () => {} });
  assert.deepEqual(results, [{ caseNumber: 1, outcome: 'superseded' }]);
  assert.deepEqual(unbans, []);
});
