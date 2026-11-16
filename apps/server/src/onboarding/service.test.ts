import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SetupSelectionDto } from '@tcg-live/core';
import type { PrivateDiscordConfig } from '../discord/config.js';
import type { SessionRow } from '../discord/session.js';
import { SetupProfileStore } from './profile.js';
import { SetupService, type SetupDiscovery } from './service.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333',
  '444444444444444444', '555555555555555555', '666666666666666666', '777777777777777777'];
const selection: SetupSelectionDto = { guildId: ids[0]!, channelId: ids[1]!,
  matchChannels: { M1: ids[2]!, M2: ids[3]! }, adminId: ids[4]!, publicMatchRooms: true };
const permissions = ['View Channel', 'Send Messages', 'Read Message History', 'Embed Links', 'Attach Files',
  'Connect', 'Manage Permissions', 'Manage Channels', 'Move Members'];

function discovery(guide: SetupDiscovery['guide'] = async () => ids[5]!): SetupDiscovery {
  return { applicationId: ids[6]!, botName: 'BoBoAssist',
    async guilds() { return [{ id: ids[0]!, name: 'TCG Test', ownerId: ids[4]! }]; },
    async channels() { return [
      { id: ids[1]!, name: 'signup', category: 'Tournament', type: 'text', permissions, afk: false },
      { id: ids[2]!, name: 'TCG Match 1', category: 'Tournament', type: 'voice', permissions, afk: false },
      { id: ids[3]!, name: 'TCG Match 2', category: 'Tournament', type: 'voice', permissions, afk: false }
    ]; },
    async createChannel(_guildId, name, type) {
      if (name === 'denied') throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      return { id: '888888888888888888', name, category: null, type, permissions, afk: false };
    },
    async ensureTournamentRoles(_guildId, organizerId) {
      return { organizer: 'created', judge: 'created', assigned: organizerId, problem: null };
    }, guide };
}

function activeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return { event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', application_id: ids[6]!,
    guild_id: selection.guildId, channel_id: selection.channelId,
    identity_map: { kind: 'signup', adminId: selection.adminId, matchChannels: selection.matchChannels!,
      publicMatchRooms: true }, status: 'active', checkin_message_id: null,
    m1_message_id: null, m2_message_id: null, ...overrides };
}

async function fixture<T>(run: (profile: SetupProfileStore) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'tcg-setup-test-'));
  try { return await run(new SetupProfileStore(path.join(directory, 'data', 'discord-setup.json'))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('profile persists only validated non-secret settings and an ambiguous guide send is never auto-replayed', async () => fixture(async profile => {
  let sends = 0;
  const service = new SetupService({ token: 'SECRET', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => activeSession(), onHandover: async () => {} });
  service.attach(discovery(async () => { sends += 1; throw new Error('ambiguous POST'); }));
  const first = await service.check(selection);
  assert.equal(first.notice, 'pending');
  assert.equal((await service.check(selection)).notice, 'pending');
  assert.equal(sends, 1);
  const raw = await readFile(profile.file, 'utf8');
  assert(!raw.includes('SECRET'));
  assert.equal((await profile.read()).guide?.pending, true);
  assert.equal((await profile.read()).completed, false);
  await assert.rejects(() => profile.save({ selection: { ...selection, adminId: 'bad' }, guide: null, completed: true }),
    /Invalid setup selection/);
}));

test('active signup is frozen, cannot auto-bypass before Finish, and resumes without prepare', async () => fixture(async profile => {
  let prepare = 0;
  const handed: Array<{ config: PrivateDiscordConfig; fresh: boolean }> = [];
  const active = activeSession();
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => active, prepare: async () => { prepare++; return active; },
    onHandover: async (config, fresh) => { handed.push({ config, fresh }); } });
  service.attach(discovery());
  assert.equal(await service.readyConfig(), null);
  const status = await service.status();
  assert.equal(status.frozen, true);
  assert.deepEqual(status.selection, selection);
  assert.equal((await service.check({ ...selection, publicMatchRooms: false })).valid, false);
  await assert.rejects(() => service.finish({ ...selection, publicMatchRooms: false }), /active event locks/i);
  assert.equal((await service.finish(selection)).eventId, active.event_id);
  await service.handover();
  assert.equal(prepare, 0);
  assert.equal(handed[0]?.fresh, false);
  assert.equal((await service.readyConfig())?.mode, 'signup');
}));

test('restart follows a tournament signup channel moved after setup', async () => fixture(async profile => {
  const moved = ids[5]!;
  await profile.save({ selection, guide: null, completed: true });
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => activeSession({ channel_id: moved }),
    prepare: async () => { throw new Error('must not prepare'); }, onHandover: async () => {} });
  const original = discovery();
  service.attach({ ...original, async channels(guildId) {
    return [...await original.channels(guildId),
      { id: moved, name: 'one-piece-signup', category: 'Tournament', type: 'text', permissions, afk: false }];
  } });
  assert.equal((await service.readyConfig())?.channelId, moved);
}));

test('legacy shared-chat event resumes without inventing match rooms', async () => fixture(async profile => {
  const active = activeSession({ identity_map: { kind: 'legacy', adminId: selection.adminId,
    players: { A: ids[1]!, B: ids[2]!, C: ids[3]!, D: ids[5]! } } });
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => active, prepare: async () => { throw new Error('must not prepare'); },
    onHandover: async () => {} });
  service.attach(discovery());
  const frozen = (await service.status()).selection!;
  assert.equal(frozen.matchChannels, null);
  assert.equal((await service.check(frozen)).valid, true);
  await service.finish(frozen);
  assert.equal((await service.readyConfig())?.matchChannels, undefined);
}));

test('fresh Finish prepares once and concurrent Finish conflicts before the first await', async () => fixture(async profile => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null,
    prepare: async () => { calls++; await gate; return activeSession(); }, onHandover: async () => {} });
  service.attach(discovery());
  const first = service.finish(selection);
  await assert.rejects(() => service.finish(selection), /already in progress/);
  release();
  assert.equal((await first).openingDashboard, true);
  assert.equal(calls, 1);
  assert.equal((await profile.read()).completed, true);
}));

test('missing token and unavailable schema stay prerequisites without preparing an event', async () => fixture(async profile => {
  let prepared = 0;
  const withoutToken = new SetupService({ token: null, databaseConfigured: true, profile,
    active: async () => null, prepare: async () => { prepared++; return activeSession(); }, onHandover: async () => {} });
  assert.match((await withoutToken.status()).prerequisite!, /TCG_DISCORD_TOKEN/);
  await assert.rejects(() => withoutToken.finish(selection), /TCG_DISCORD_TOKEN/);
  const noDatabase = new SetupService({ token: 'TOKEN', databaseConfigured: false, profile,
    active: async () => null, prepare: async () => { prepared++; return activeSession(); }, onHandover: async () => {} });
  noDatabase.attach(discovery());
  assert.match((await noDatabase.status()).prerequisite!, /DATABASE_URL/);
  const noSchema = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => { throw new Error('secret DB detail'); },
    prepare: async () => { prepared++; return activeSession(); }, onHandover: async () => {} });
  noSchema.attach(discovery());
  const status = await noSchema.status();
  assert.match(status.prerequisite!, /schema is not ready/);
  assert.doesNotMatch(JSON.stringify(status), /secret DB detail/);
  assert.equal(prepared, 0);
}));

test('fresh selection rejects hidden, wrong-type and AFK match rooms server-side', async () => fixture(async profile => {
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => activeSession(), onHandover: async () => {} });
  const base = discovery();
  service.attach({ ...base, async channels() { return [
    { id: ids[1]!, name: 'signup', category: null, type: 'text', permissions, afk: false },
    { id: ids[2]!, name: 'TCG Match 1', category: null, type: 'text', permissions, afk: false },
    { id: ids[3]!, name: 'TCG Match 2', category: null, type: 'voice', permissions, afk: true }
  ]; } });
  const result = await service.check(selection);
  assert.equal(result.valid, false);
  assert.match(result.issues.join(' '), /voice room/);
  assert.match(result.issues.join(' '), /AFK/);
  await assert.rejects(() => service.finish(selection), /voice room/);
}));

test('frozen private session accepts its existing voice names and recovery reopens setup', async () => fixture(async profile => {
  const active = activeSession({ identity_map: { kind: 'signup', adminId: selection.adminId,
    matchChannels: selection.matchChannels! } });
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => active, prepare: async () => { throw new Error('must not prepare'); },
    onHandover: async () => { throw new Error('startup failed'); } });
  const base = discovery();
  service.attach({ ...base, async channels(guildId) {
    return (await base.channels(guildId)).map(row => row.type === 'voice' ?
      { ...row, name: `Original room ${row.id}` } : row);
  } });
  const frozen = (await service.status()).selection!;
  assert.equal(frozen.publicMatchRooms, false);
  assert.equal((await service.check(frozen)).valid, true);
  await service.finish(frozen);
  await assert.rejects(() => service.handover(), /startup failed/);
  await service.recover('Live startup failed; review permissions.');
  assert.equal((await service.status()).handoverError, 'Live startup failed; review permissions.');
  assert.equal((await profile.read()).completed, false);
  assert.equal(await service.readyConfig(), null);
}));

test('guide replaces only a confirmed missing owned message and persists pending before resend', async () => fixture(async profile => {
  await profile.save({ selection, guide: { channelId: selection.channelId,
    messageId: ids[5]!, pending: false }, completed: false });
  const calls: Array<string | null> = [];
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => activeSession(), onHandover: async () => {} });
  service.attach(discovery(async (_channel, _admin, _content, messageId) => {
    calls.push(messageId);
    if (messageId) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    assert.equal((await profile.read()).guide?.pending, true);
    return ids[6]!;
  }));
  assert.equal((await service.check(selection)).notice, 'posted');
  assert.deepEqual(calls, [ids[5], null]);
  assert.deepEqual((await profile.read()).guide, { channelId: selection.channelId,
    messageId: ids[6], pending: false });
}));

test('createChannel validates input, creates in a bot server and explains a missing Manage Channels', async () => fixture(async profile => {
  const service = new SetupService({ token: 'SECRET', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => { throw new Error('unused'); }, onHandover: async () => {} });
  await assert.rejects(service.createChannel({ guildId: ids[0], name: 'x', type: 'voice' }), /not ready/);
  service.attach(discovery());
  assert.deepEqual(await service.createChannel({ guildId: ids[0], name: '  TCG Match 3 ', type: 'voice' }),
    { id: '888888888888888888', name: 'TCG Match 3', category: null, type: 'voice' });
  await assert.rejects(service.createChannel({ guildId: ids[1], name: 'x', type: 'text' }), /server the bot belongs to/);
  await assert.rejects(service.createChannel({ guildId: ids[0], name: ' ', type: 'text' }), /1-100 readable/);
  await assert.rejects(service.createChannel({ guildId: ids[0], name: 'a'.repeat(101), type: 'text' }), /1-100 readable/);
  await assert.rejects(service.createChannel({ guildId: ids[0], name: 'x', type: 'stage' }), /text or voice/);
  await assert.rejects(service.createChannel({ guildId: ids[0], name: 'x', type: 'text', extra: 1 }), /text or voice/);
  await assert.rejects(service.createChannel({ guildId: ids[0], name: 'denied', type: 'text' }), /Manage Channels/);
}));

test('Finish ensures the TCG roles for the chosen organizer before preparing, and reports them', async () => fixture(async profile => {
  const order: string[] = [];
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => { order.push('prepare'); return activeSession(); }, onHandover: async () => {} });
  const base = discovery();
  service.attach({ ...base, async ensureTournamentRoles(guildId, organizerId, store) {
    order.push(`roles:${guildId}:${organizerId}`);
    await store.set({ guildId, organizerRoleId: ids[5]!, judgeRoleId: ids[6]! });
    return { organizer: 'created', judge: 'created', assigned: organizerId, problem: null };
  } });
  const finished = await service.finish(selection);
  assert.deepEqual(order, [`roles:${selection.guildId}:${selection.adminId}`, 'prepare']);
  assert.deepEqual(finished.roles, { organizer: 'created', judge: 'created', assigned: selection.adminId, problem: null });
  // The IDs went into the setup profile, and the Finish save kept them.
  assert.deepEqual((await profile.read()).roles, { guildId: selection.guildId, organizerRoleId: ids[5], judgeRoleId: ids[6] });
  assert.equal((await profile.read()).completed, true);
}));

test('Finish succeeds when the roles cannot be set up and says so', async () => fixture(async profile => {
  let prepared = 0;
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => { prepared++; return activeSession(); }, onHandover: async () => {} });
  service.attach({ ...discovery(), async ensureTournamentRoles() { throw new Error('Missing Permissions'); } });
  const finished = await service.finish(selection);
  assert.equal(finished.eventId, activeSession().event_id);
  assert.equal(prepared, 1);
  assert.deepEqual([finished.roles?.organizer, finished.roles?.judge, finished.roles?.assigned], ['failed', 'failed', null]);
  assert.match(finished.roles?.problem ?? '', /Create them later/);
  assert.doesNotMatch(JSON.stringify(finished), /Missing Permissions/);
  assert.equal((await profile.read()).completed, true);
}));

test('a save that omits roles fails instead of erasing them when the profile cannot be read', async () => fixture(async profile => {
  const saved = { guildId: ids[0]!, organizerRoleId: ids[5]!, judgeRoleId: ids[6]! };
  await profile.save({ selection, guide: null, completed: false, roles: saved });
  const before = await readFile(profile.file, 'utf8');
  await writeFile(profile.file, '{ not json');
  await assert.rejects(() => profile.save({ selection, guide: null, completed: true }), /invalid/i);
  assert.equal(await readFile(profile.file, 'utf8'), '{ not json');
  // The IDs are still recoverable once the file is repaired.
  await writeFile(profile.file, before);
  assert.deepEqual((await profile.read()).roles, saved);
}));

// ---- bot-managed match rooms (no M1/M2 pickers)

const categoryId = '999999999999999999';
const poolSelection: SetupSelectionDto = { guildId: ids[0]!, channelId: ids[1]!, matchChannels: null,
  adminId: ids[4]!, publicMatchRooms: true, matchRooms: { categoryId, createCategory: false } };
const roomPermissions = [...permissions, 'Manage Messages'];

function poolDiscovery(options: { category?: string[]; server?: string[] | null } = {}): SetupDiscovery {
  const base = discovery();
  return { ...base,
    async channels() { return [
      { id: ids[1]!, name: 'signup', category: null, type: 'text', permissions, afk: false },
      { id: categoryId, name: 'Matches', category: null, type: 'category', permissions: options.category ?? roomPermissions, afk: false }
    ]; },
    ...(options.server === null ? {} : { async serverPermissions() { return options.server ?? roomPermissions; } }) };
}

const pooledSession = () => activeSession({ identity_map: { kind: 'signup', adminId: selection.adminId, publicMatchRooms: true } });

test('a new setup needs no M1/M2: the category picker makes a valid selection with a rooms readiness row', async () => fixture(async profile => {
  const prepared: PrivateDiscordConfig[] = [];
  const applied: unknown[] = [];
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    roomSettings: { async applySetup(guildId, applicationId, input) { applied.push([guildId, applicationId, input]); } },
    active: async () => null, prepare: async config => { prepared.push(config); return pooledSession(); }, onHandover: async () => {} });
  service.attach(poolDiscovery());
  const checked = await service.check(poolSelection);
  assert.equal(checked.valid, true, checked.issues.join(' '));
  assert.deepEqual(checked.capabilities.map(row => [row.slot, row.channelId, row.missing]),
    [['signup', ids[1], []], ['rooms', categoryId, []]]);
  const finished = await service.finish(poolSelection);
  assert.deepEqual(finished.rooms, { problem: null });
  assert.deepEqual(applied, [[ids[0], ids[6], { categoryId, createCategory: false }]]);
  assert.equal(prepared[0]?.matchChannels, undefined, 'no M1/M2 reach the saved event');
  assert.equal(prepared[0]?.publicMatchRooms, true);
  assert.deepEqual((await profile.read()).selection?.matchRooms, { categoryId, createCategory: false });
}));

test('a new setup without M1/M2 is saved with public rooms on, and with no category the server is checked instead', async () => fixture(async profile => {
  const prepared: PrivateDiscordConfig[] = [];
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async config => { prepared.push(config); return pooledSession(); }, onHandover: async () => {} });
  service.attach(poolDiscovery({ server: ['View Channel', 'Connect'] }));
  const bare: SetupSelectionDto = { guildId: ids[0]!, channelId: ids[1]!, matchChannels: null, adminId: ids[4]!, publicMatchRooms: false };
  const checked = await service.check(bare);
  const rooms = checked.capabilities.find(row => row.slot === 'rooms')!;
  assert.deepEqual([rooms.channelId, rooms.channelName], [ids[0], 'Server']);
  assert.deepEqual(rooms.missing, ['Manage Channels', 'Manage Permissions', 'Read Message History', 'Manage Messages']);
  assert.equal(checked.valid, false, 'a server without Manage Channels cannot hold bot-made rooms');
  assert.ok(checked.permissions!.issues.some(issue => issue.featureId === 'tournament.roomCategory' && issue.scope.kind === 'guild'));
  service.attach(poolDiscovery({ server: roomPermissions.filter(name => name !== 'Manage Messages') }));
  const warned = await service.check(bare);
  assert.equal(warned.valid, true, 'room chat is only a warning');
  assert.deepEqual(warned.permissions!.issues.map(issue => [issue.featureId, issue.severity]), [['tournament.roomChat', 'warning']]);
  await service.finish(bare);
  assert.equal(prepared[0]?.publicMatchRooms, true);
  assert.equal((await profile.read()).selection?.publicMatchRooms, true);
}));

test('a category the bot cannot see, or a category chosen and created at once, is refused', async () => fixture(async profile => {
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => pooledSession(), onHandover: async () => {} });
  service.attach(poolDiscovery());
  const gone = await service.check({ ...poolSelection, matchRooms: { categoryId: '888888888888888887', createCategory: false } });
  assert.equal(gone.valid, false);
  assert.match(gone.issues.join(' '), /category the bot can see/);
  const notCategory = await service.check({ ...poolSelection, matchRooms: { categoryId: ids[1]!, createCategory: false } });
  assert.equal(notCategory.valid, false);
  await assert.rejects(() => service.check({ ...poolSelection, matchRooms: { categoryId, createCategory: true } }), /Choose a server/);
  await assert.rejects(() => service.check({ ...poolSelection, matchRooms: { categoryId: null } as never }), /Choose a server/);
  const created = await service.check({ ...poolSelection, matchRooms: { categoryId: null, createCategory: true } });
  assert.equal(created.valid, true, 'a category to create needs no existing one');
}));

test('Finish reports a room settings failure without failing setup', async () => fixture(async profile => {
  let prepared = 0;
  const failing = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    roomSettings: { async applySetup() { throw new Error('relation does not exist'); } },
    active: async () => null, prepare: async () => { prepared++; return pooledSession(); }, onHandover: async () => {} });
  failing.attach(poolDiscovery());
  const finished = await failing.finish(poolSelection);
  assert.equal(prepared, 1);
  assert.match(finished.rooms?.problem ?? '', /Rooms tab/);
  assert.doesNotMatch(JSON.stringify(finished), /relation does not exist/);
  assert.equal((await profile.read()).completed, true);
  // No sink attached: a requested category is reported, no request is not a problem.
  const unattached = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => pooledSession(), onHandover: async () => {} });
  unattached.attach(poolDiscovery());
  assert.match((await unattached.finish(poolSelection)).rooms?.problem ?? '', /Rooms tab/);
  const { matchRooms: _matchRooms, ...plain } = poolSelection;
  const again = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => null, prepare: async () => pooledSession(), onHandover: async () => {} });
  again.attach(poolDiscovery());
  assert.deepEqual((await again.finish(plain)).rooms, { problem: null });
}));

test('a legacy selection with M1/M2 stays valid, needs no TCG Match names, and applies no rooms settings', async () => fixture(async profile => {
  const applied: unknown[] = [];
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    roomSettings: { async applySetup(...args) { applied.push(args); } },
    active: async () => null, prepare: async () => activeSession(), onHandover: async () => {} });
  const base = discovery();
  service.attach({ ...base, async channels(guildId) {
    return (await base.channels(guildId)).map(row => row.type === 'voice' ? { ...row, name: `Lounge ${row.id}` } : row);
  } });
  const checked = await service.check(selection);
  assert.equal(checked.valid, true, checked.issues.join(' '));
  assert.deepEqual(checked.capabilities.map(row => row.slot), ['signup', 'M1', 'M2']);
  const finished = await service.finish(selection);
  assert.deepEqual(finished.rooms, { problem: null });
  assert.deepEqual(applied, [], 'nothing to apply without a rooms choice');
  assert.deepEqual((await profile.read()).selection, selection, 'the saved legacy selection gains no keys');
}));

test('matchRooms never makes a frozen event look changed, and frozen events keep their identity', async () => fixture(async profile => {
  const active = pooledSession();
  const service = new SetupService({ token: 'TOKEN', databaseConfigured: true, profile,
    active: async () => active, prepare: async () => { throw new Error('must not prepare'); }, onHandover: async () => {} });
  service.attach(poolDiscovery());
  const frozen = (await service.status()).selection!;
  assert.equal(frozen.matchChannels, null);
  assert.equal(frozen.publicMatchRooms, true);
  assert.equal(frozen.matchRooms, undefined);
  assert.equal((await service.check(poolSelection)).valid, true, 'a different category is not an identity change');
  await service.finish(poolSelection);
  assert.equal((await service.status()).selection?.matchRooms?.categoryId, categoryId, 'the saved choice shows on the frozen event');
  // Identity still locks: a different organizer is refused.
  assert.equal((await service.check({ ...poolSelection, adminId: ids[5]! })).valid, false);
  // A saved legacy event with M1/M2 is unchanged by this feature.
  const legacy = new SetupService({ token: 'TOKEN', databaseConfigured: true,
    profile: new SetupProfileStore(path.join(path.dirname(profile.file), 'legacy.json')),
    active: async () => activeSession(), prepare: async () => { throw new Error('must not prepare'); }, onHandover: async () => {} });
  legacy.attach(discovery());
  assert.equal((await legacy.check(selection)).valid, true);
  assert.equal((await legacy.status()).selection?.matchRooms, undefined);
}));

test('profile validation: matchRooms is the one optional key, with a category or a create flag but not both', async () => fixture(async profile => {
  await profile.save({ selection: poolSelection, guide: null, completed: false });
  assert.deepEqual((await profile.read()).selection, poolSelection);
  await profile.save({ selection: { ...poolSelection, matchRooms: { categoryId: null, createCategory: true } }, guide: null, completed: false });
  for (const bad of [{ categoryId, createCategory: true }, { categoryId: 'x', createCategory: false }, { categoryId: null },
    { categoryId: null, createCategory: false, extra: 1 }, null, 'category'])
    await assert.rejects(() => profile.save({ selection: { ...poolSelection, matchRooms: bad as never }, guide: null, completed: false }),
      /Invalid setup selection/);
  await assert.rejects(() => profile.save({ selection: { ...poolSelection, extra: 1 } as never, guide: null, completed: false }), /Invalid setup selection/);
}));
