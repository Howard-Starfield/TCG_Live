import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATCH_ROOM_DEFAULT_TEMPLATE } from '@tcg-live/core';
import { OpsConflictError } from '../../ops/errors.js';
import { RuleError } from '../../rehearsal/domain.js';
import { MemoryMatchRoomStore, type MatchRoomRow } from './store.js';
import { TEST_APP, TEST_GUILD } from './testing.js';

const row = (n: number, extra: Partial<MatchRoomRow> = {}): MatchRoomRow => ({ guildId: TEST_GUILD, channelId: `80000000000000000${n}`, applicationId: TEST_APP,
  tableNo: n, categoryId: null, origin: 'created', customName: null, appliedName: null, desiredName: null, originalName: null, renameLog: [],
  nextRenameAtMs: null, renameError: null, missingSinceMs: null, createdAtMs: 1, ...extra });

test('settings default to version 1 and the default template, bump on save, and refuse a stale version', async () => {
  const store = new MemoryMatchRoomStore();
  const fresh = await store.settings(TEST_GUILD);
  assert.deepEqual([fresh.version, fresh.template, fresh.categoryId, fresh.baselineCapturedAtMs], [1, MATCH_ROOM_DEFAULT_TEMPLATE, null, null]);
  const saved = await store.saveSettings(TEST_GUILD, 1, { template: '{match}', categoryId: null, pendingCategoryName: null, baselineChannelIds: ['1'] }, 5);
  assert.deepEqual([saved.version, saved.template, saved.updatedAtMs], [2, '{match}', 5]);
  await assert.rejects(store.saveSettings(TEST_GUILD, 1, { template: 'x{n}', categoryId: null, pendingCategoryName: null, baselineChannelIds: [] }, 6), OpsConflictError);
  const patched = await store.patchSettings(TEST_GUILD, { baselineCapturedAtMs: 9 }, 9);
  assert.deepEqual([patched.version, patched.baselineCapturedAtMs, patched.template], [2, 9, '{match}']);
  assert.equal((await store.settings('another-guild')).version, 1, 'settings are per guild');
});

test('rooms: one per channel and per table, ordered by table, updated atomically from the current row', async () => {
  const store = new MemoryMatchRoomStore();
  await store.insertRoom(row(2));
  await store.insertRoom(row(1));
  await assert.rejects(store.insertRoom(row(3, { channelId: row(1).channelId })), RuleError);
  await assert.rejects(store.insertRoom(row(1, { channelId: '800000000000000099' })), RuleError);
  assert.deepEqual((await store.rooms(TEST_GUILD)).map(item => item.tableNo), [1, 2]);
  assert.equal(await store.updateRoom(TEST_GUILD, '800000000000000077', { customName: 'x' }), null);
  const updated = await store.updateRoom(TEST_GUILD, row(1).channelId, current => ({ renameLog: [...current.renameLog, 5], desiredName: 'wanted' }));
  assert.deepEqual([updated!.renameLog, updated!.desiredName], [[5], 'wanted']);
  const unchanged = await store.updateRoom(TEST_GUILD, row(1).channelId, () => null);
  assert.equal(unchanged!.desiredName, 'wanted');
  // Callers cannot change stored rows through what they were handed.
  (await store.rooms(TEST_GUILD))[0]!.renameLog.push(99);
  assert.deepEqual((await store.rooms(TEST_GUILD))[0]!.renameLog, [5]);
  assert.equal(await store.removeRoom(TEST_GUILD, row(1).channelId), true);
  assert.equal(await store.removeRoom(TEST_GUILD, row(1).channelId), false);
});

test('categories are kept by range and removed by ID', async () => {
  const store = new MemoryMatchRoomStore();
  await store.saveCategory({ guildId: TEST_GUILD, categoryId: '800000000000000002', rangeFrom: 51, rangeTo: 100, origin: 'created', createdAtMs: 1 });
  await store.saveCategory({ guildId: TEST_GUILD, categoryId: '800000000000000001', rangeFrom: 1, rangeTo: 50, origin: 'configured', createdAtMs: 1 });
  assert.deepEqual((await store.categories(TEST_GUILD)).map(item => item.rangeFrom), [1, 51]);
  await store.removeCategory(TEST_GUILD, '800000000000000001');
  assert.deepEqual((await store.categories(TEST_GUILD)).map(item => item.categoryId), ['800000000000000002']);
});
