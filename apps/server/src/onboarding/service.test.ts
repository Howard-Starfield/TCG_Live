import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    ]; }, guide };
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
