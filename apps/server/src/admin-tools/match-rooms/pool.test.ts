import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import type { MatchId } from '@tcg-live/core';
import { createDemoGuild, DEMO_CHANNEL_IDS } from '../demo-guild.js';
import { RuleError } from '../../rehearsal/domain.js';
import { captureBaseline, migrateLegacyRooms } from './migrate.js';
import { flush, roomWorld, TEST_APP, TEST_GUILD, withoutDemoRooms } from './testing.js';

const EVENT_1 = '11111111-1111-4111-8111-111111111111';
const EVENT_2 = '22222222-2222-4222-8222-222222222222';
const ids = (rooms: Partial<Record<MatchId, string>>) => Object.entries(rooms).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([, id]) => id);
const category = (w: { demo: { channels: Array<{ id: string; name: string }> } }, id: string | null) => w.demo.channels.find(channel => channel.id === id)?.name;
const parentOf = (w: { demo: { channels: Array<{ id: string; parentId: string | null }> } }, id: string) => w.demo.channels.find(channel => channel.id === id)?.parentId ?? null;

function emptyWorld(options: Parameters<typeof roomWorld>[0] = {}) {
  return roomWorld({ demo: withoutDemoRooms(createDemoGuild(TEST_GUILD)), ...options });
}

test('match Mk lands on table k, created with its name and permissions in one call, in the game category, with no rename', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 4);
  const rows = await w.store.rooms(TEST_GUILD);
  assert.deepEqual(rows.map(row => row.tableNo), [1, 2, 3, 4]);
  assert.deepEqual(rows.map(row => row.channelId), ids(bound));
  assert.equal(new Set(ids(bound)).size, 4);
  for (const [matchId, channelId] of Object.entries(bound)) {
    const channel = w.demo.channels.find(item => item.id === channelId)!;
    assert.equal(channel.name, `🎮 ${matchId}`);
    assert.equal(category(w, channel.parentId), 'One Piece 1–50');
    assert.equal(rows.find(row => row.channelId === channelId)!.origin, 'created');
  }
  assert.equal(w.renames.length, 0, 'a created room is born with its name');
  // Players get posting rights in their own room only; the bot overwrite has no Manage Roles.
  const overwrites = await w.discord.overwrites(bound.M2!);
  const bot = overwrites.find(item => item.id === '200000000000000099')!;
  assert.equal(BigInt(bot.allow) & PermissionFlagsBits.ManageRoles, 0n);
  assert.ok(overwrites.some(item => item.id === '300000000000000003'), 'M2 is for the second pair');
  assert.deepEqual(w.bindings.sessions.get(EVENT_1), bound);
  const categoryRows = await w.store.categories(TEST_GUILD);
  assert.deepEqual(categoryRows.map(row => [row.rangeFrom, row.rangeTo, row.origin]), [[1, 50, 'created']]);
});

test('a second event reuses the rooms without creating or renaming, and archives the room chat before rebinding', async () => {
  const w = emptyWorld();
  const first = await w.publish(EVENT_1, 4);
  const channelCount = w.demo.channels.length;
  for (const id of ids(first)) w.chatMessages.set(id!, 3);
  w.bindings.order.length = 0;
  const second = await w.publish(EVENT_2, 4);
  assert.deepEqual(second, first, 'the same table serves the same match number');
  assert.equal(w.demo.channels.length, channelCount, 'nothing was created');
  assert.equal(w.renames.length, 0, 'the default template renders the same name');
  const transcripts = await w.transcripts.list(EVENT_1);
  assert.equal(transcripts.length, 4, 'one transcript per reused room, for the match it hosted');
  assert.ok(transcripts.every(item => item.reason === 'reassigned' && item.messageCount === 3));
  for (const id of ids(second)) {
    const archive = w.bindings.order.indexOf(`archive:${id}`);
    const bind = w.bindings.order.indexOf(`bind:${id}`);
    assert.ok(archive >= 0 && bind > archive, 'the chat is archived before the room is bound to its new match');
  }
  assert.deepEqual([...w.chatMessages.values()], [0, 0, 0, 0], 'and cleared');
  // Providing the same event again (a refresh or a restart) archives and renames nothing.
  w.chatLog.length = 0;
  const again = await w.publish(EVENT_2, 4);
  assert.deepEqual(again, first);
  assert.deepEqual(w.chatLog, []);
});

test('a failing archive does not stop the match from getting its room', async () => {
  const w = emptyWorld();
  await w.publish(EVENT_1, 2);
  const system = w.build({ chat: { async fetchMessages() { throw new Error('boom'); }, async bulkDelete() { return { deleted: 0, skippedOld: 0 }; } } });
  const bound = await w.publish(EVENT_2, 2, {}, system);
  assert.equal(Object.keys(bound).length, 2);
});

test('a template with a different name renames a reused room only when it is newly bound, through the queue', async () => {
  const w = emptyWorld();
  await w.publish(EVENT_1, 2);
  await w.store.saveSettings(TEST_GUILD, 1, { template: '{table} · {round}', categoryId: null, pendingCategoryName: null, baselineChannelIds: [] }, 1);
  await w.system.start();
  const second = await w.publish(EVENT_2, 2);
  const rows = await w.store.rooms(TEST_GUILD);
  assert.deepEqual(rows.map(row => row.desiredName), ['Table 1 · Round 1', 'Table 2 · Round 1']);
  assert.equal(w.renames.length, 0, 'queued, not sent from inside provisioning');
  w.clock.advance(0);
  await flush();
  assert.deepEqual(w.renames.map(item => item.name).sort(), ['Table 1 · Round 1', 'Table 2 · Round 1']);
  assert.equal(w.demo.channels.find(item => item.id === second.M1)!.name, 'Table 1 · Round 1');
  await w.system.stop();
});

test('a restart in the middle of a round renames nothing, even when the template no longer matches the names', async () => {
  const w = emptyWorld();
  await w.publish(EVENT_1, 2);
  await w.store.saveSettings(TEST_GUILD, 1, { template: '⚔️ {round} · {match}', categoryId: null, pendingCategoryName: null, baselineChannelIds: [] }, 1);
  const restarted = w.build();
  await restarted.start();
  w.chatLog.length = 0;
  const again = await w.publish(EVENT_1, 2, {}, restarted);
  assert.equal(Object.keys(again).length, 2);
  assert.equal((await w.store.rooms(TEST_GUILD)).filter(row => row.desiredName !== null).length, 0);
  w.clock.advance(0);
  await flush();
  assert.equal(w.renames.length, 0);
  assert.deepEqual(w.chatLog, [], 'and no chat is archived: the rooms are still bound to this event');
  await restarted.stop();
});

test('a room that is gone is created again inside the category with its name, and no rename call', async () => {
  const w = emptyWorld();
  const first = await w.publish(EVENT_1, 3);
  const parent = parentOf(w, first.M2!);
  w.demo.channels = w.demo.channels.filter(channel => channel.id !== first.M2);
  const second = await w.publish(EVENT_2, 3);
  assert.notEqual(second.M2, first.M2);
  assert.equal(second.M1, first.M1);
  const channel = w.demo.channels.find(item => item.id === second.M2)!;
  assert.equal(channel.name, '🎮 M2');
  assert.equal(channel.parentId, parent);
  assert.equal(w.renames.length, 0);
  const rows = await w.store.rooms(TEST_GUILD);
  assert.equal(rows.length, 3, 'the missing room\'s record was replaced, not duplicated');
  assert.equal(rows.find(row => row.tableNo === 2)!.channelId, second.M2);
});

test('table 51 goes into the next category, named for the game and its range', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 51);
  assert.equal(category(w, parentOf(w, bound.M1!)), 'One Piece 1–50');
  assert.equal(category(w, parentOf(w, bound.M50!)), 'One Piece 1–50');
  assert.equal(category(w, parentOf(w, bound.M51!)), 'One Piece 51–100');
  assert.deepEqual((await w.store.categories(TEST_GUILD)).map(row => [row.rangeFrom, row.rangeTo]), [[1, 50], [51, 100]]);
  // Another event with a different game reuses those categories rather than making new ones.
  const channels = w.demo.channels.length;
  await w.publish(EVENT_2, 51, { gameLabel: 'Pokémon' });
  assert.equal(w.demo.channels.length, channels);
});

test('tables 1 to 50 use the chosen category; the bot only creates the others', async () => {
  const w = emptyWorld();
  const parent = w.demo.channels.find(channel => channel.type === 'category' && channel.name === 'Play')!;
  await w.store.patchSettings(TEST_GUILD, { categoryId: parent.id }, 1);
  const bound = await w.publish(EVENT_1, 51, { gameLabel: null });
  assert.equal(parentOf(w, bound.M1!), parent.id);
  assert.equal(category(w, parentOf(w, bound.M51!)), 'TCG 51–100', 'the label falls back to TCG without a game');
  const rows = await w.store.categories(TEST_GUILD);
  assert.deepEqual(rows.map(row => [row.categoryId === parent.id ? 'chosen' : 'bot', row.origin]).sort(), [['bot', 'created'], ['bot', 'created'], ['chosen', 'configured']]);
});

test('a category requested in setup is created when the first room needs it, then used', async () => {
  const w = emptyWorld();
  await w.store.patchSettings(TEST_GUILD, { pendingCategoryName: 'TCG Live — Matches' }, 1);
  const bound = await w.publish(EVENT_1, 2);
  const settings = await w.store.settings(TEST_GUILD);
  assert.equal(category(w, parentOf(w, bound.M1!)), 'TCG Live — Matches');
  assert.equal(settings.pendingCategoryName, null);
  assert.equal(settings.categoryId, parentOf(w, bound.M1!));
});

test('the server channel limit is refused clearly before anything is created, and nothing is bound', async () => {
  const w = emptyWorld();
  const filler = Array.from({ length: 498 - w.demo.channels.length }, (_, index) => ({ id: `${700000000000000000n + BigInt(index)}`, name: `filler-${index}`,
    type: 'text' as const, parentId: null, position: 100 + index, reserved: false }));
  w.demo.channels.push(...filler);
  assert.equal(w.demo.channels.length, 498);
  await assert.rejects(w.publish(EVENT_1, 4), (error: unknown) => error instanceof RuleError &&
    /500 channels per server and only 2 are free; this round needs 5 new channels/.test(error.message));
  assert.equal(w.demo.channels.length, 498, 'no partial creation');
  assert.equal(w.bindings.sessions.size, 0);
  assert.equal((await w.store.rooms(TEST_GUILD)).length, 0);
  w.demo.channels.push(...Array.from({ length: 2 }, (_, index) => ({ id: `${710000000000000000n + BigInt(index)}`, name: `more-${index}`, type: 'text' as const, parentId: null,
    position: 900 + index, reserved: false })));
  await assert.rejects(w.publish(EVENT_1, 1), /none are free/);
});

test('the pool binds every match or throws', async () => {
  const w = emptyWorld();
  w.discord.canManageChannels = () => false;
  await assert.rejects(w.publish(EVENT_1, 2), /Manage Channels/);
  assert.equal(w.bindings.sessions.size, 0);
});

test('the frozen legacy rooms are still used for M1 and M2, adopted into the pool, and renamed to the template at the next event', async () => {
  const w = emptyWorld({ legacy: { M1: '810000000000000001', M2: '810000000000000002' } });
  w.demo.channels.push({ id: '810000000000000001', name: 'TCG Match 1', type: 'voice', parentId: null, position: 50, reserved: false },
    { id: '810000000000000002', name: 'TCG Match 2', type: 'voice', parentId: null, position: 51, reserved: false });
  await w.system.queue.start();
  const bound = await w.publish(EVENT_1, 3);
  assert.equal(bound.M1, '810000000000000001');
  assert.equal(bound.M2, '810000000000000002');
  assert.notEqual(bound.M3, undefined);
  const rows = await w.store.rooms(TEST_GUILD);
  assert.deepEqual(rows.map(row => [row.tableNo, row.origin]), [[1, 'adopted'], [2, 'adopted'], [3, 'created']]);
  assert.deepEqual(rows.slice(0, 2).map(row => row.originalName), ['TCG Match 1', 'TCG Match 2'], 'their own names are kept for clean-up');
  assert.ok(rows.slice(0, 2).every(row => row.customName === null));
  assert.deepEqual(w.backups.map(item => item.channelId).sort(), ['810000000000000001', '810000000000000002'], 'the overwrites are backed up before they change');
  w.clock.advance(0);
  await flush();
  assert.deepEqual(w.renames.map(item => item.name).sort(), ['🎮 M1', '🎮 M2']);
  assert.equal(w.demo.channels.find(item => item.id === '810000000000000001')!.name, '🎮 M1');
  assert.equal((await w.store.rooms(TEST_GUILD))[0]!.originalName, 'TCG Match 1');
  await w.system.queue.stop();
});

test('migration: configured rooms, the active event\'s rooms and bot-made rooms join the pool; running it twice changes nothing', async () => {
  const w = emptyWorld();
  w.demo.channels.push({ id: '810000000000000001', name: 'TCG Match 1', type: 'voice', parentId: null, position: 50, reserved: false },
    { id: '810000000000000002', name: 'TCG Match 2', type: 'voice', parentId: null, position: 51, reserved: false },
    { id: '810000000000000003', name: `TCG Match M3 · ${TEST_APP}`, type: 'voice', parentId: null, position: 52, reserved: false },
    { id: '810000000000000004', name: 'TCG Match M4 · 999999999999999999', type: 'voice', parentId: null, position: 53, reserved: false });
  const deps = { guildId: TEST_GUILD, applicationId: TEST_APP, store: w.store, discord: w.discord,
    legacyChannels: { M1: '810000000000000001', M2: '810000000000000002' } as Partial<Record<MatchId, string>>,
    activeRoundRooms: { M1: '810000000000000001', M3: '810000000000000003' } as Partial<Record<MatchId, string>>,
    backup: async (_guild: string, channelId: string, overwrites: readonly unknown[]) => { w.backups.push({ channelId, overwrites: overwrites as never }); } };
  assert.deepEqual(await migrateLegacyRooms(deps), { adopted: 2, created: 1 });
  const rows = await w.store.rooms(TEST_GUILD);
  assert.deepEqual(rows.map(row => [row.tableNo, row.channelId, row.origin, row.originalName]), [
    [1, '810000000000000001', 'adopted', 'TCG Match 1'], [2, '810000000000000002', 'adopted', 'TCG Match 2'],
    [3, '810000000000000003', 'created', null]]);
  assert.ok(rows.every(row => row.customName === null && row.desiredName === null), 'no rename at migration: they rename at the next event');
  assert.equal(w.backups.length, 2);
  assert.equal(w.renames.length, 0);
  const snapshot = JSON.stringify(await w.store.rooms(TEST_GUILD));
  assert.deepEqual(await migrateLegacyRooms(deps), { adopted: 0, created: 0 });
  assert.equal(JSON.stringify(await w.store.rooms(TEST_GUILD)), snapshot);
  assert.equal(w.backups.length, 2);
});

test('migration with nothing to migrate leaves an empty pool', async () => {
  const w = emptyWorld();
  assert.deepEqual(await migrateLegacyRooms({ guildId: TEST_GUILD, applicationId: TEST_APP, store: w.store, discord: w.discord,
    backup: async () => {} }), { adopted: 0, created: 0 });
  assert.equal((await w.store.rooms(TEST_GUILD)).length, 0);
});

test('baseline capture saves every voice channel, stage channel and category outside the pool, once', async () => {
  const w = roomWorld();
  w.demo.channels.push({ id: '810000000000000009', name: 'Stage', type: 'stage', parentId: null, position: 60, reserved: false });
  await w.store.insertRoom({ guildId: TEST_GUILD, channelId: DEMO_CHANNEL_IDS.matchM1, applicationId: TEST_APP, tableNo: 1, categoryId: null, origin: 'adopted',
    customName: null, appliedName: '🎮 M1', desiredName: null, originalName: null, renameLog: [], nextRenameAtMs: null, renameError: null, missingSinceMs: null, createdAtMs: 1 });
  assert.equal(await captureBaseline({ guildId: TEST_GUILD, store: w.store, discord: w.discord, now: () => 5_000 }), true);
  const settings = await w.store.settings(TEST_GUILD);
  const categories = w.demo.channels.filter(channel => channel.type === 'category').map(channel => channel.id);
  assert.deepEqual([...settings.baselineChannelIds].sort(), [...categories, DEMO_CHANNEL_IDS.matchM2, '810000000000000009'].sort());
  assert.equal(settings.baselineCapturedAtMs, 5_000);
  assert.equal(settings.version, 1, 'a system capture does not bump the settings version');
  // Rooms the bot creates later are not in it, and a second capture changes nothing.
  await w.publish(EVENT_1, 3);
  assert.equal(await captureBaseline({ guildId: TEST_GUILD, store: w.store, discord: w.discord, now: () => 9_000 }), false);
  assert.deepEqual((await w.store.settings(TEST_GUILD)).baselineChannelIds, settings.baselineChannelIds);
});

test('start migrates, captures the baseline and never throws when Discord is unavailable', async () => {
  const w = roomWorld();
  const broken = w.build({ discord: { ...w.discord, list: async () => { throw new Error('offline'); } } });
  await broken.start();
  assert.ok(w.warnings.some(message => /pending/.test(message)));
  await broken.stop();
  await w.system.start();
  assert.ok((await w.store.settings(TEST_GUILD)).baselineCapturedAtMs !== null);
  await w.system.stop();
});
