import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATCH_ROOM_LIMITS } from '@tcg-live/core';
import { createDemoGuild } from '../demo-guild.js';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { RuleError } from '../../rehearsal/domain.js';
import { matchRoomSetupSink, demoMatchRoomService, type ActiveEventInfo } from './service.js';
import { MemoryMatchRoomStore } from './store.js';
import { demoRoomChatPort, MemoryTranscriptStore } from './transcripts.js';
import { flush, FakeQueueClock, roomWorld, TEST_ADMIN, TEST_APP, TEST_BOT, TEST_GUILD, withoutDemoRooms } from './testing.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';

const EVENT_1 = '11111111-1111-4111-8111-111111111111';
const EVENT_2 = '22222222-2222-4222-8222-222222222222';
const active = (eventId: string, roundRooms: ActiveEventInfo['roundRooms'] = {}): ActiveEventInfo =>
  ({ eventId, eventName: 'Spring Open', gameLabel: 'One Piece', round: 1, roundRooms });
const emptyWorld = () => roomWorld({ demo: withoutDemoRooms(createDemoGuild(TEST_GUILD)) });
const settingsBody = (version: number, template: string, extra: Record<string, unknown> = {}) =>
  ({ expectedVersion: version, template, categoryId: null, createCategory: null, baselineChannelIds: [], ...extra });

test('describe shows the pool: rooms by table, categories, the baseline, free channel slots, storage and the event', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 3);
  w.event = active(EVENT_1, bound);
  await w.system.start();
  const dto = await w.system.service.describe();
  assert.equal(dto.guildId, TEST_GUILD);
  assert.equal(dto.storage, 'memory');
  assert.match(dto.problem ?? '', /npm start/);
  assert.equal(dto.activeEventId, EVENT_1);
  assert.equal(dto.eventName, 'Spring Open');
  assert.equal(dto.gameLabel, 'One Piece');
  assert.equal(dto.round, 1);
  assert.equal(dto.freeChannelSlots, MATCH_ROOM_LIMITS.serverChannels - w.demo.channels.length);
  assert.deepEqual(dto.rooms.map(room => [room.table, room.name, room.assignedMatch, room.origin, room.missing]), [
    [1, '🎮 M1', 'M1', 'created', false], [2, '🎮 M2', 'M2', 'created', false], [3, '🎮 M3', 'M3', 'created', false]]);
  assert.ok(dto.rooms.every(room => room.rename.state === 'synced' && room.pendingName === null && room.templateName === room.name));
  assert.match(dto.rooms[0]!.removeBlockedReason ?? '', /In use by M1/);
  assert.deepEqual(dto.rooms[0]!.connected, []);
  assert.equal(dto.categories.length, 1);
  assert.equal(dto.categories[0]!.name, 'One Piece 1–50');
  assert.equal(dto.categories[0]!.origin, 'created');
  const poolCategory = dto.baseline.find(item => item.id === dto.categories[0]!.categoryId)!;
  assert.deepEqual([poolCategory.inBaseline, poolCategory.botCreated, poolCategory.type], [false, true, 'category']);
  assert.ok(dto.baseline.some(item => item.type === 'category' && item.inBaseline && !item.botCreated), 'the server\'s own categories are in the baseline');
  assert.ok(!dto.baseline.some(item => item.inBaseline && dto.rooms.some(room => room.channelId === item.id)));
  await w.system.stop();
});

test('saving settings: stale versions conflict, bad templates and categories are refused, a good save bumps the version', async () => {
  const w = emptyWorld();
  const service = w.system.service;
  await assert.rejects(service.saveSettings(settingsBody(1, '🎮 {stage}')), (error: unknown) => error instanceof OpsInputError && /coming with brackets/.test(error.message));
  await assert.rejects(service.saveSettings(settingsBody(1, 'Room')), OpsInputError);
  await assert.rejects(service.saveSettings(settingsBody(1, '{match}', { categoryId: '810000000000000001' })), /not a category/);
  await assert.rejects(service.saveSettings(settingsBody(1, '{match}', { categoryId: w.demo.channels.find(item => item.type === 'category')!.id, createCategory: 'New' })), /not both/);
  await assert.rejects(service.saveSettings(settingsBody(1, '{match}', { createCategory: '  ' })), OpsInputError);
  await assert.rejects(service.saveSettings(settingsBody(1, '{match}', { baselineChannelIds: ['nope'] })), OpsInputError);
  const category = w.demo.channels.find(item => item.type === 'category' && item.name === 'Play')!;
  const saved = await service.saveSettings(settingsBody(1, '⚔️ {round} · {match}', { categoryId: category.id, baselineChannelIds: [category.id] }));
  assert.equal(saved.settings.version, 2);
  assert.equal(saved.settings.template, '⚔️ {round} · {match}');
  assert.equal(saved.settings.categoryId, category.id);
  assert.equal(saved.settings.categoryName, 'Play');
  assert.deepEqual(saved.settings.baselineChannelIds, [category.id]);
  assert.deepEqual(saved.categories.map(item => [item.categoryId, item.origin, item.from, item.to]), [[category.id, 'configured', 1, 50]]);
  await assert.rejects(service.saveSettings(settingsBody(1, '{match}')), OpsConflictError);
  const pending = await service.saveSettings(settingsBody(2, '{match}', { createCategory: 'TCG Live — Matches' }));
  assert.equal(pending.settings.pendingCategoryName, 'TCG Live — Matches');
  assert.equal(pending.settings.categoryId, null);
  assert.deepEqual(pending.categories, [], 'the previously chosen category is no longer the chosen one');
});

test('a template change renames right away through the queue: queued first, applied when the queue runs', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 3);
  w.event = active(EVENT_1, bound);
  await w.system.service.setCustomName(bound.M3!, 'Feature table');
  await w.system.start();
  w.clock.advance(0);
  await flush();
  w.renames.length = 0;
  const dto = await w.system.service.saveSettings(settingsBody(1, '{table} · {round}'));
  const byTable = Object.fromEntries(dto.rooms.map(room => [room.table, room]));
  assert.deepEqual([byTable[1]!.pendingName, byTable[1]!.rename.state], ['Table 1 · Round 1', 'queued']);
  assert.equal(byTable[1]!.name, '🎮 M1', 'the room still has its old name until the rename is sent');
  assert.equal(byTable[3]!.pendingName, null, 'a custom name is left alone');
  assert.equal(byTable[1]!.templateName, 'Table 1 · Round 1');
  w.clock.advance(0);
  await flush();
  const after = await w.system.service.describe();
  assert.deepEqual(after.rooms.map(room => room.name), ['Table 1 · Round 1', 'Table 2 · Round 1', 'Feature table']);
  assert.ok(after.rooms.every(room => room.rename.state === 'synced'));
  await w.system.stop();
});

test('custom names: validated, queued without waiting for Discord, and Use template switches back', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 2);
  const service = w.system.service;
  await w.system.start();
  await assert.rejects(service.setCustomName(bound.M1!, ' '), OpsInputError);
  await assert.rejects(service.setCustomName(bound.M1!, 'x'.repeat(101)), OpsInputError);
  await assert.rejects(service.setCustomName('810000000000000077', 'Name'), OpsNotFoundError);
  await assert.rejects(service.setCustomName('nope', 'Name'), OpsInputError);
  const renamed = await service.setCustomName(bound.M1!, '  Finals  ');
  assert.equal(renamed.customName, 'Finals');
  assert.equal(renamed.pendingName, 'Finals');
  assert.equal(renamed.rename.state, 'queued');
  assert.equal(renamed.name, '🎮 M1', 'the request returned before Discord did anything');
  w.clock.advance(0);
  await flush();
  assert.equal(w.demo.channels.find(item => item.id === bound.M1)!.name, 'Finals');
  const back = await service.setCustomName(bound.M1!, null);
  assert.equal(back.customName, null);
  assert.equal(back.pendingName, '🎮 M1');
  assert.equal(back.templateName, '🎮 M1');
  await w.system.stop();
});

test('a rename made in Discord becomes the room\'s custom name, and the next event keeps it', async () => {
  const w = emptyWorld();
  const first = await w.publish(EVENT_1, 2);
  await w.system.start();
  w.demo.channels.find(item => item.id === first.M2)!.name = 'Streamed match';
  await w.system.observedRename(first.M2!, 'Streamed match');
  const dto = await w.system.service.describe();
  assert.equal(dto.rooms[1]!.customName, 'Streamed match');
  assert.equal(dto.rooms[1]!.rename.state, 'synced');
  const second = await w.publish(EVENT_2, 2);
  assert.equal(second.M2, first.M2);
  assert.equal(w.demo.channels.find(item => item.id === first.M2)!.name, 'Streamed match');
  assert.equal(w.renames.length, 0);
  await w.system.stop();
});

test('adopting an existing voice room: lowest free table, original name and permissions kept, refused for text, duplicates and AFK', async () => {
  const w = emptyWorld();
  w.demo.channels.push({ id: '810000000000000001', name: 'Lounge', type: 'voice', parentId: null, position: 50, reserved: false },
    { id: '810000000000000002', name: 'Afk', type: 'voice', parentId: null, position: 51, reserved: false });
  const afk = w.build({ discord: { ...w.discord, afkChannelId: () => '810000000000000002' } });
  const service = w.system.service;
  const room = await service.adopt('810000000000000001');
  assert.deepEqual([room.table, room.origin, room.name, room.customName], [1, 'adopted', 'Lounge', null]);
  assert.deepEqual(w.backups.map(item => item.channelId), ['810000000000000001']);
  assert.equal((await w.store.rooms(TEST_GUILD))[0]!.originalName, 'Lounge');
  assert.equal(w.renames.length, 0, 'it is renamed at the next event, not now');
  await assert.rejects(service.adopt('810000000000000001'), RuleError);
  await assert.rejects(service.adopt(w.demo.channels.find(item => item.type === 'text')!.id), /voice/);
  await assert.rejects(service.adopt('810000000000000055'), OpsNotFoundError);
  await assert.rejects(afk.service.adopt('810000000000000002'), /AFK/);
  const bound = await w.publish(EVENT_1, 2);
  assert.equal(bound.M1, '810000000000000001', 'table 1 is the adopted room');
  assert.equal((await w.store.rooms(TEST_GUILD))[1]!.origin, 'created');
});

test('forgetting a room releases it unless it is in use', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 2);
  w.event = active(EVENT_1, bound);
  const service = w.system.service;
  await assert.rejects(service.forget(bound.M1!), /In use by M1/);
  w.event = null;
  w.occupants.set(bound.M2!, [{ id: '1', displayName: 'Player', avatarUrl: null }]);
  await assert.rejects(service.forget(bound.M2!), /connected/);
  w.occupants.clear();
  await service.forget(bound.M2!);
  assert.deepEqual((await w.store.rooms(TEST_GUILD)).map(row => row.tableNo), [1]);
  assert.ok(w.demo.channels.some(item => item.id === bound.M2), 'the channel itself is left alone');
  await assert.rejects(service.forget(bound.M2!), OpsNotFoundError);
});

test('creating missing tables fills the gaps without binding them, and asking again creates nothing', async () => {
  const w = emptyWorld();
  const service = w.system.service;
  await assert.rejects(service.ensureTables(0), OpsInputError);
  await assert.rejects(service.ensureTables(501), OpsInputError);
  const first = await service.ensureTables(3);
  assert.equal(first.created.length, 3);
  assert.deepEqual(first.rooms.rooms.map(room => room.name), ['🎮 M1', '🎮 M2', '🎮 M3']);
  assert.equal(w.bindings.sessions.size, 0);
  assert.deepEqual((await service.ensureTables(3)).created, []);
  const more = await service.ensureTables(4);
  assert.equal(more.created.length, 1);
  // The audit records what the bot made on its own.
  assert.equal(w.audit.entries.filter(entry => entry.kind === 'match_rooms.created').length, 4);
  w.demo.channels = w.demo.channels.filter(item => item.id !== first.created[1]);
  assert.equal((await service.ensureTables(4)).created.length, 1, 'a room that disappeared is created again');
});

test('clean-up: the preview lists what changes, a changed plan is refused, and confirming deletes, restores and archives', async () => {
  const w = emptyWorld();
  w.demo.channels.push({ id: '810000000000000001', name: 'Lounge', type: 'voice', parentId: null, position: 50, reserved: false });
  const service = w.system.service;
  await service.adopt('810000000000000001');
  const first = await w.publish(EVENT_1, 3);
  w.chatMessages.set(first.M2!, 2);
  await w.system.start();
  w.clock.advance(0);
  await flush();
  assert.equal(w.demo.channels.find(item => item.id === '810000000000000001')!.name, '🎮 M1', 'adopted and renamed to the template');
  // An event is still running: its rooms are skipped.
  w.event = active(EVENT_1, first);
  const during = await service.cleanupPlan();
  assert.ok(during.items.filter(item => item.kind === 'room').every(item => item.action === 'skip' || item.action === 'restore'));
  w.event = active(EVENT_2);
  const plan = await service.cleanupPlan();
  const action = (id: string) => plan.items.find(item => item.channelId === id)?.action;
  assert.equal(action('810000000000000001'), 'restore');
  const created = Object.values(first).filter(id => id !== '810000000000000001') as string[];
  for (const id of created) assert.equal(action(id), 'delete');
  const poolCategory = (await w.store.categories(TEST_GUILD)).find(item => item.origin === 'created')!;
  assert.equal(action(poolCategory.categoryId), 'delete');
  assert.ok(plan.items.some(item => item.action === 'restore' && item.restoreName === 'Lounge'));
  assert.equal(plan.transcriptsToArchive, 2);
  await assert.rejects(service.cleanupConfirm('0'.repeat(64)), (error: unknown) => error instanceof RuleError && /rooms changed/.test(error.message));
  await assert.rejects(service.cleanupConfirm(''), OpsInputError);
  // The rooms changed after the preview: the same token is stale.
  w.occupants.set(created[0]!, [{ id: '1', displayName: 'Player', avatarUrl: null }]);
  await assert.rejects(service.cleanupConfirm(plan.planToken), /rooms changed/);
  w.occupants.clear();
  w.chatLog.length = 0;
  const result = await service.cleanupConfirm(plan.planToken);
  assert.equal(result.deleted.length, created.length + 1);
  assert.deepEqual(result.restored, ['810000000000000001']);
  assert.equal(result.archived, 1, 'only the room with a chat has something to archive');
  assert.equal(w.chatLog.filter(entry => entry.startsWith('archive:')).length >= created.length, true);
  assert.ok(created.every(id => !w.demo.channels.some(item => item.id === id)));
  assert.ok(!w.demo.channels.some(item => item.id === poolCategory.categoryId));
  assert.ok(w.demo.channels.some(item => item.id === '810000000000000001'), 'adopted rooms are never deleted');
  assert.deepEqual((await w.store.rooms(TEST_GUILD)).map(row => row.channelId), ['810000000000000001']);
  assert.equal((await w.store.categories(TEST_GUILD)).length, 0);
  assert.equal((await w.store.settings(TEST_GUILD)).categoryId, null);
  // The restored room's original name goes through the rename queue.
  assert.equal((await w.store.rooms(TEST_GUILD))[0]!.desiredName, 'Lounge');
  w.clock.advance(0);
  await flush();
  assert.equal(w.demo.channels.find(item => item.id === '810000000000000001')!.name, 'Lounge');
  assert.equal((await w.audit.list({ limit: 100 })).entries.some(entry => entry.kind === 'match_rooms.cleanup'), true);
  await w.system.stop();
});

test('clean-up never deletes a baseline room, or a channel the bot did not create', async () => {
  const w = emptyWorld();
  const first = await w.publish(EVENT_1, 2);
  await w.system.start();
  const kept = (await w.store.rooms(TEST_GUILD))[0]!;
  await w.system.service.saveSettings(settingsBody(1, '🎮 {match}', { baselineChannelIds: [kept.channelId] }));
  const plan = await w.system.service.cleanupPlan();
  assert.equal(plan.items.find(item => item.channelId === kept.channelId)!.action, 'keep');
  assert.equal(plan.items.find(item => item.channelId === first.M2)!.action, 'delete');
  const result = await w.system.service.cleanupConfirm(plan.planToken);
  assert.ok(!result.deleted.includes(kept.channelId));
  assert.ok(w.demo.channels.some(item => item.id === kept.channelId));
  await w.system.stop();
});

test('transcripts pass through to the store, with hold and clear errors', async () => {
  const w = emptyWorld();
  const first = await w.publish(EVENT_1, 1);
  w.chatMessages.set(first.M1!, 2);
  await w.publish(EVENT_2, 1);
  const service = w.system.service;
  const list = await service.transcripts(EVENT_1);
  assert.equal(list.length, 1);
  assert.deepEqual(await service.transcripts(EVENT_1, 'M2'), []);
  const full = await service.transcript(list[0]!.id);
  assert.equal(full.messages.length, 2);
  await service.setTranscriptHold(list[0]!.id, true);
  assert.equal((await service.transcript(list[0]!.id)).hold, true);
  await assert.rejects(service.transcript('00000000-0000-4000-8000-000000000000'), OpsNotFoundError);
  await assert.rejects(service.setTranscriptHold('00000000-0000-4000-8000-000000000000', true), OpsNotFoundError);
  await assert.rejects(service.setTranscriptHold(list[0]!.id, 'yes' as never), OpsInputError);
  await assert.rejects(service.transcripts(''), OpsInputError);
});

test('setup hands the chosen category to the settings, or asks for one to be created', async () => {
  const store = new MemoryMatchRoomStore();
  const sink = matchRoomSetupSink(store, () => 7);
  await sink.applySetup(TEST_GUILD, TEST_APP, { categoryId: '810000000000000001', createCategory: false });
  assert.equal((await store.settings(TEST_GUILD)).categoryId, '810000000000000001');
  const other = new MemoryMatchRoomStore();
  await matchRoomSetupSink(other, () => 7).applySetup(TEST_GUILD, TEST_APP, { categoryId: null, createCategory: true });
  const created = await other.settings(TEST_GUILD);
  assert.equal(created.pendingCategoryName, 'TCG Live — Matches');
  assert.equal(created.categoryId, null);
  assert.equal(created.version, 1, 'setup is a system write, not a user edit');
  // A later setup with a category the organizer already chose does not replace it with a new one.
  await store.patchSettings(TEST_GUILD, { categoryId: '810000000000000001' }, 8);
  await matchRoomSetupSink(store, () => 9).applySetup(TEST_GUILD, TEST_APP, { categoryId: null, createCategory: true });
  assert.equal((await store.settings(TEST_GUILD)).pendingCategoryName, null);
});

test('demo: rooms start from the demo server\'s two rooms, and a template change shows queued before it applies', async () => {
  const clock = new FakeQueueClock();
  const demo = createDemoGuild(TEST_GUILD);
  let event: ActiveEventInfo | null = null;
  const system = await demoMatchRoomService({ demo, applicationId: TEST_APP, adminId: TEST_ADMIN, botId: TEST_BOT, audit: new MemoryOpsAuditStore(),
    chat: demoRoomChatPort(() => clock.now()), transcripts: new MemoryTranscriptStore(() => clock.now()), clock,
    seed: [{ channelId: demo.channels.find(item => item.name === '🎮 M1')!.id, table: 1 }, { channelId: demo.channels.find(item => item.name === '🎮 M2')!.id, table: 2 }],
    activeEvent: async () => event });
  await system.start();
  const before = await system.service.describe();
  assert.deepEqual(before.rooms.map(room => [room.table, room.name]), [[1, '🎮 M1'], [2, '🎮 M2']]);
  assert.equal(before.storage, 'demo');
  assert.equal(before.problem, null, 'the demo keeps its rooms in memory on purpose');
  const bound = await system.pool.provision({ eventId: EVENT_1, eventName: null, gameLabel: 'One Piece', round: 1,
    matches: ['M1', 'M2', 'M3'].map(id => ({ id: id as 'M1', pair: [] })), savedRooms: {} });
  assert.equal(bound.M1, before.rooms[0]!.channelId, 'M1 is the demo server\'s own room');
  assert.equal((await system.service.describe()).rooms.length, 3);
  event = active(EVENT_1, bound);
  const queued = await system.service.saveSettings(settingsBody(1, '{table} · {round}'));
  assert.ok(queued.rooms.every(room => room.rename.state === 'queued' && room.pendingName !== null), 'queued is visible');
  clock.advance(0);
  await flush();
  const applying = await system.service.describe();
  assert.ok(applying.rooms.every(room => room.rename.state === 'queued' && room.name !== room.pendingName), 'the demo rename takes a moment');
  for (let step = 0; step < 3; step++) { clock.advance(1_500); await flush(); }
  const done = await system.service.describe();
  assert.deepEqual(done.rooms.map(room => room.name), ['Table 1 · Round 1', 'Table 2 · Round 1', 'Table 3 · Round 1']);
  assert.ok(done.rooms.every(room => room.rename.state === 'synced'));
  await system.stop();
});
