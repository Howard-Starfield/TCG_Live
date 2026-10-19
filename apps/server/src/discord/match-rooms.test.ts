import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { createSignupFixture, RuleError, transition, type EventState } from '../rehearsal/domain.js';
import { readPrivateDiscordConfig, sameIdentityMap } from './config.js';
import { MatchRoomReconciler, backupRoomOverwrites, roomPlan, sameOverwrites,
  type Room, type RoomOverwrite, type RoomTransport } from './match-rooms.js';
import { privateDiscordClient } from './sdk.js';
import { PrivateDiscordController, type PrivateInteraction } from './controller.js';
import { assertPublicMatchRoomTargets } from './runtime.js';
import type { SessionRow } from './session.js';

const ids = Array.from({ length: 12 }, (_, index) => `${index + 10}`.repeat(9));
const eventId = '11111111-1111-4111-8111-111111111111';
const env = { TCG_DISCORD_APPLICATION_ID: ids[0], TCG_DISCORD_GUILD_ID: ids[1],
  TCG_DISCORD_CHANNEL_ID: ids[2], TCG_DISCORD_M1_CHANNEL_ID: ids[3], TCG_DISCORD_M2_CHANNEL_ID: ids[4],
  TCG_DISCORD_ADMIN_ID: ids[5], TCG_DISCORD_PUBLIC_MATCH_ROOMS: '1' };
const config = readPrivateDiscordConfig(env, false, 'signup');
const botId = ids[6]!;
const members = [ids[7]!, ids[8]!, ids[9]!, ids[10]!];
const session: SessionRow = { event_id: eventId, application_id: config.applicationId,
  guild_id: config.guildId, channel_id: config.channelId,
  identity_map: { kind: 'signup', adminId: config.adminId,
    matchChannels: config.matchChannels, publicMatchRooms: true }, status: 'active',
  checkin_message_id: null, m1_message_id: null, m2_message_id: null };
const apply = (state: EventState, actor: string, command: Parameters<typeof transition>[2]) =>
  transition(state, actor, command, 1_000, 'runner').state;
function assigned(published = false): EventState {
  let state = createSignupFixture(eventId);
  for (const id of members) state = apply(state, `member:${id}`, { type: 'signupJoin' });
  state = apply(state, 'admin:fixture', { type: 'signupClose', adminId: config.adminId });
  if (published) {
    for (const player of ['A', 'B', 'C', 'D'] as const)
      state = apply(state, `player:${player}`, { type: 'checkin' });
    state = apply(state, 'admin:fixture', { type: 'publish' });
  }
  return state;
}
function fixture(initial = assigned()) {
  let state = initial;
  const policy: Record<Room, RoomOverwrite[]> = { M1: [], M2: [] };
  const voice = new Map<string, string>();
  const writes: Room[] = [];
  const moves: Array<{ member: string; room: Room }> = [];
  const warnings: string[] = [];
  const backups: Room[] = [];
  let allowed = true;
  let failPolicy = false;
  let failMove = false;
  let now = 10_000;
  let readCount = 0;
  let onRead: ((count: number) => void) | undefined;
  let onCurrent: (() => Promise<void> | void) | undefined;
  const transport: RoomTransport = {
    async current(room) { await onCurrent?.(); return policy[room]; },
    async assertPermissions(room, operation) {
      if (!allowed) throw new Error(`missing ${operation} permission in ${room}`);
    },
    async replace(room, desired) {
      writes.push(room);
      if (failPolicy) throw new Error('policy denied');
      policy[room] = desired;
    },
    voiceChannel(id) { return voice.get(id) ?? null; },
    async move(member, room) {
      moves.push({ member, room });
      if (failMove) throw new Error('ambiguous move');
      voice.set(member, config.matchChannels![room]);
    },
    async warnOrganizer(message) { warnings.push(message); }
  };
  const reconciler = new MatchRoomReconciler(config, botId, ids[11]!, transport,
    async () => { onRead?.(++readCount); return { session, state }; }, () => allowed, () => now,
    async (_guild, roomId) => { backups.push(roomId === config.matchChannels!.M1 ? 'M1' : 'M2'); });
  return { reconciler, transport, policy, voice, writes, moves, warnings, backups,
    get state() { return state; }, set state(value: EventState) { state = value; },
    set allowed(value: boolean) { allowed = value; }, set failPolicy(value: boolean) { failPolicy = value; },
    set failMove(value: boolean) { failMove = value; }, set now(value: number) { now = value; },
    set onRead(value: ((count: number) => void) | undefined) { onRead = value; },
    set onCurrent(value: (() => Promise<void> | void) | undefined) { onCurrent = value; } };
}

test('public config is explicit, paired, and frozen; voice intent is conditional', () => {
  assert.equal(config.publicMatchRooms, true);
  assert.throws(() => readPrivateDiscordConfig({ ...env, TCG_DISCORD_M2_CHANNEL_ID: '' }, false, 'signup'), /require both/);
  assert.throws(() => readPrivateDiscordConfig({ ...env, TCG_DISCORD_PUBLIC_MATCH_ROOMS: 'yes' }, false, 'signup'), /PUBLIC_MATCH_ROOMS/);
  assert.equal(readPrivateDiscordConfig({ ...env, TCG_DISCORD_PUBLIC_MATCH_ROOMS: '' }, false, 'signup').publicMatchRooms, undefined);
  assert.equal(sameIdentityMap(session.identity_map, config), true);
  assert.equal(sameIdentityMap(session.identity_map,
    readPrivateDiscordConfig({ ...env, TCG_DISCORD_PUBLIC_MATCH_ROOMS: '0' }, false, 'signup')), false);
  const publicClient = privateDiscordClient(true);
  const privateClient = privateDiscordClient();
  assert.equal(publicClient.options.intents.has(GatewayIntentBits.GuildVoiceStates), true);
  assert.equal(privateClient.options.intents.has(GatewayIntentBits.GuildVoiceStates), false);
  void publicClient.destroy(); void privateClient.destroy();
});

test('public target validation rejects duplicate, wrong-guild, AFK and general voice rooms', () => {
  const rooms = { M1: { id: config.matchChannels!.M1, name: 'TCG Match Alpha',
    guildId: config.guildId, type: ChannelType.GuildVoice },
  M2: { id: config.matchChannels!.M2, name: 'TCG Match Beta',
    guildId: config.guildId, type: ChannelType.GuildVoice } };
  assert.doesNotThrow(() => assertPublicMatchRoomTargets(config, rooms, null));
  assert.throws(() => assertPublicMatchRoomTargets(config, { ...rooms, M2: { ...rooms.M2, id: rooms.M1.id } }, null), /two distinct/);
  assert.throws(() => assertPublicMatchRoomTargets(config, { ...rooms, M2: { ...rooms.M2, guildId: ids[0]! } }, null), /configured guild/);
  assert.throws(() => assertPublicMatchRoomTargets(config, rooms, rooms.M1.id), /outside AFK/);
  assert.throws(() => assertPublicMatchRoomTargets(config, { ...rooms, M1: { ...rooms.M1, name: 'General' } }, null), /TCG Match/);
});

test('policy gives everyone public entry, only pair/admin/bot posting, and bot management', () => {
  const plan = roomPlan(config.guildId, botId, config.adminId, [members[0]!, members[1]!]);
  const row = (id: string) => plan.find(item => item.id === id)!;
  const everyone = row(config.guildId);
  assert.equal((BigInt(everyone.allow) & PermissionFlagsBits.ViewChannel) !== 0n, true);
  assert.equal((BigInt(everyone.allow) & PermissionFlagsBits.Connect) !== 0n, true);
  for (const flag of [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.UseApplicationCommands]) assert.equal((BigInt(everyone.deny) & flag) !== 0n, true);
  for (const flag of [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect,
    PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles])
    assert.equal((BigInt(row(botId).allow) & flag) !== 0n, true);
  assert.equal((BigInt(row(config.adminId).allow) & PermissionFlagsBits.SendMessages) !== 0n, true);
  assert.equal((BigInt(row(members[0]!).allow) & PermissionFlagsBits.SendMessages) !== 0n, true);
  assert.equal(plan.some(item => item.id === members[2]), false);
});

test('first overwrite backup is exclusive and never replaced by a later plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tcg-room-backup-'));
  const original = roomPlan(config.guildId, botId, config.adminId, []);
  const path = join(directory, `${config.guildId}-${config.matchChannels!.M1}.json`);
  try {
    await backupRoomOverwrites(config.guildId, config.matchChannels!.M1, original, directory);
    await backupRoomOverwrites(config.guildId, config.matchChannels!.M1, [], directory);
    const saved = JSON.parse(await readFile(path, 'utf8')) as { overwrites: RoomOverwrite[] };
    assert.deepEqual(saved.overwrites, original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('roster close/reopen updates complete policies and unchanged policy is not rewritten', async () => {
  const f = fixture(createSignupFixture(eventId));
  await f.reconciler.trigger();
  assert.deepEqual(f.writes, ['M1', 'M2']);
  assert.deepEqual(f.backups, ['M1', 'M2']);
  assert.equal(f.policy.M1.length, 3);
  await f.reconciler.trigger();
  assert.equal(f.writes.length, 2);
  f.state = assigned();
  await f.reconciler.trigger();
  assert.equal(f.policy.M1.length, 5);
  f.state = apply(f.state, 'admin:fixture', { type: 'signupReopen' });
  await f.reconciler.trigger();
  assert.equal(f.policy.M1.length, 3);
  f.policy.M1 = [];
  await f.reconciler.trigger();
  assert.equal(f.writes.at(-1), 'M1', 'manual drift is repaired from current SDK state');
  await f.reconciler.stop();
});

test('failed policy plan is suppressed until Refresh or plan/current change', async () => {
  const f = fixture();
  f.failPolicy = true;
  await assert.rejects(f.reconciler.trigger(), /policy update failed/);
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.reconciler.trigger(), /policy is pending/);
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.reconciler.trigger(true), /policy update failed/);
  assert.equal(f.writes.length, 2);
  f.failPolicy = false;
  f.policy.M1 = roomPlan(config.guildId, botId, config.adminId, []);
  await f.reconciler.trigger();
  assert.ok(f.writes.length >= 3);
  await f.reconciler.stop();
});

test('publication moves only connected wrong-room unfinished members; cap counts failed moves', async () => {
  const f = fixture(assigned(true));
  f.voice.set(members[0]!, ids[2]!);
  f.voice.set(members[1]!, config.matchChannels!.M1);
  f.voice.set(members[2]!, ids[11]!); // AFK
  f.voice.set(config.adminId, ids[2]!);
  f.voice.set(ids[0]!, ids[2]!); // spectator
  f.failMove = true;
  for (let index = 0; index < 4; index++) await f.reconciler.trigger(false, members[0]);
  assert.equal(f.moves.length, 3);
  assert.equal(f.warnings.length, 1);
  f.now += 60_001;
  f.failMove = false;
  await f.reconciler.trigger();
  assert.deepEqual(f.moves.at(-1), { member: members[0], room: 'M1' });
  const count = f.moves.length;
  await f.reconciler.trigger();
  assert.equal(f.moves.length, count, 'bot-generated correct-channel event is a no-op');
  f.state = { ...f.state, matches: [{ ...f.state.matches[0], phase: 'final' }, f.state.matches[1]] };
  f.voice.set(members[0]!, ids[2]!);
  await f.reconciler.trigger();
  assert.equal(f.moves.length, count, 'finished pair is not redirected');
  await f.reconciler.stop();
});

test('unpublished and stopped passes do not move players', async () => {
  const f = fixture(assigned());
  f.voice.set(members[0]!, ids[2]!);
  await f.reconciler.trigger();
  assert.equal(f.moves.length, 0);
  await f.reconciler.stop();
  f.state = assigned(true);
  await f.reconciler.trigger();
  assert.equal(f.moves.length, 0);
});

test('a changed aggregate before a move abandons the old destination', async () => {
  const f = fixture(assigned(true));
  f.voice.set(members[0]!, ids[2]!);
  f.policy.M1 = roomPlan(config.guildId, botId, config.adminId, members.slice(0, 2));
  f.policy.M2 = roomPlan(config.guildId, botId, config.adminId, members.slice(2));
  f.onRead = count => {
    if (count === 2) f.state = { ...f.state, version: f.state.version + 1,
      matches: [{ ...f.state.matches[0], phase: 'final' }, f.state.matches[1]] };
  };
  await f.reconciler.trigger();
  assert.equal(f.moves.length, 0);
  await f.reconciler.stop();
});

test('backup failure and lost lease stop writes; shutdown discards queued work', async () => {
  const f = fixture();
  const broken = new MatchRoomReconciler(config, botId, ids[11]!, f.transport,
    async () => ({ session, state: f.state }), () => true, Date.now,
    async () => { throw new RuleError('backup failed'); });
  await assert.rejects(broken.trigger(), /backup failed/);
  assert.equal(f.writes.length, 0);
  await broken.stop();
  f.onCurrent = () => { f.allowed = false; };
  await assert.rejects(f.reconciler.trigger(), /stopped/);
  assert.equal(f.writes.length, 0);
  await f.reconciler.stop();
  const queued = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  queued.onCurrent = () => gate;
  const first = queued.reconciler.trigger();
  const second = queued.reconciler.trigger();
  const stopped = queued.reconciler.stop();
  release();
  await Promise.allSettled([first, second, stopped]);
  assert.equal(queued.writes.length, 0);
});

test('overwrite comparison ignores order while matching exact bitfields', () => {
  const a = roomPlan(config.guildId, botId, config.adminId, members.slice(0, 2));
  assert.equal(sameOverwrites(a, [...a].reverse()), true);
  assert.equal(sameOverwrites(a, a.slice(1)), false);
});

test('committed Close and explicit Refresh report room warnings without undoing the action', async () => {
  const state = assigned();
  const bound = { ...session, checkin_message_id: ids[0]!, m1_message_id: ids[1]!, m2_message_id: ids[2]! };
  const order: string[] = [];
  const controller = new PrivateDiscordController(config, 'runner', {
    async send() { throw new Error('unexpected send'); }, async edit() { order.push('card'); },
    async pin() {}, classify() { return 'retry'; }
  }, async () => ({ session: bound, state }), async (_context, command) => {
    order.push('commit');
    return { eventId, version: state.version + 1, result: command.type, applied: true };
  }, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  async explicit => { order.push(explicit ? 'room-refresh' : 'room-commit');
    throw new RuleError('Public match room M1 requires bot Manage Roles permission.'); });
  const replies: string[] = [];
  const command = (subcommand: string): PrivateInteraction => ({
    id: ids[4]!, applicationId: config.applicationId, guildId: config.guildId,
    channelId: config.channelId, userId: config.adminId, kind: 'command', subcommand,
    async acknowledge() {}, async reply(message) { replies.push(message); }
  });
  await controller.handle(command('signup-close'));
  assert.deepEqual(order.slice(0, 2), ['commit', 'room-commit']);
  assert.match(replies[0]!, /^Saved: signupClose\. Room setup pending: .*Manage Roles/);
  assert.doesNotMatch(replies[0]!, /Card update pending/);
  await controller.handle(command('refresh'));
  assert.ok(order.includes('room-refresh'));
  assert.match(replies[1]!, /^Practice cards refreshed\. Room setup pending: .*Manage Roles/);
  await controller.stop();
});
