import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ADMIN_TOOLS_SETTINGS } from '@tcg-live/core';
import { setupEvidenceSchema } from '../evidence/schema.js';
import { LOCAL_ADMIN } from '../ops/audit.js';
import { setupPrivateDiscordSchema, setupRehearsalSchema, transaction, withClient } from '../rehearsal/store.js';
import { setupTournamentDirectory } from '../tournaments/directory.js';
import { OpsConflictError } from '../ops/errors.js';
import { RuleError } from '../rehearsal/domain.js';
import { MATCH_ROOM_TABLES } from '../rehearsal/schema-tables.js';
import { allocateAdminCounter, requireAdminToolsSchema, requireMatchRoomsSchema, setupAdminToolsSchema } from './schema.js';
import { pgMatchRoomStore, type MatchRoomRow } from './match-rooms/store.js';
import { AdminToolsVersionConflictError, pgAdminToolsSettingsStore } from './settings.js';

const optIn = process.env.npm_lifecycle_event === 'test:db';
const skip = optIn ? false : 'Real database suite is opt-in: npm run test:db';

test('migration 013 is idempotent and every older setup still accepts the new schema', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  assert.match(await setupPrivateDiscordSchema(), /^(upgraded|already_ready)$/);
  assert.match(await setupTournamentDirectory(), /^(created|already_ready)$/);
  assert.match(await setupEvidenceSchema(), /^(created|already_ready)$/);
  assert.match(await setupAdminToolsSchema(), /^(created|already_ready)$/);
  assert.equal(await setupAdminToolsSchema(), 'already_ready');
  assert.equal(await setupEvidenceSchema(), 'already_ready');
  assert.equal(await setupRehearsalSchema(), 'already_ready');
  assert.equal(await setupPrivateDiscordSchema(), 'already_ready');
  assert.equal(await setupTournamentDirectory(), 'already_ready');
  await withClient(requireAdminToolsSchema);
});

test('settings round-trip with versions, and counters are gap-free per guild', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  await setupAdminToolsSchema();
  const guild = `8${String(Date.now()).padStart(17, '0')}`;
  const store = pgAdminToolsSettingsStore();
  assert.equal((await store.get(guild)).version, 0);
  assert.equal((await store.put(guild, 0, structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS), LOCAL_ADMIN)).version, 1);
  await assert.rejects(store.put(guild, 0, structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS), LOCAL_ADMIN), AdminToolsVersionConflictError);
  const numbers = await Promise.all([1, 2, 3, 4].map(() => withClient(client => transaction(client, () => allocateAdminCounter(client, guild, 'case')))));
  assert.deepEqual(numbers.sort(), [1, 2, 3, 4]);
  // A rolled-back allocation does not consume a number.
  await assert.rejects(withClient(client => transaction(client, async () => {
    await allocateAdminCounter(client, guild, 'case');
    throw new Error('rollback');
  })));
  assert.equal(await withClient(client => transaction(client, () => allocateAdminCounter(client, guild, 'case'))), 5);
});

test('migration 016: the actor snapshot column is added once, nullable, with its object and size check', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  await setupAdminToolsSchema();
  await setupAdminToolsSchema();
  const column = await withClient(client => client.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tcg_rehearsal_audit' AND column_name = 'actor_snapshot'`));
  assert.deepEqual(column.rows, [{ data_type: 'jsonb', is_nullable: 'YES' }]);
  // Running it twice adds no second check constraint.
  const checks = await withClient(client => client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = 'public.tcg_rehearsal_audit'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%actor_snapshot%'`));
  assert.equal(checks.rows.length, 1);
  assert.match(checks.rows[0]!.definition, /jsonb_typeof\(actor_snapshot\) = 'object'/);
  assert.match(checks.rows[0]!.definition, /pg_column_size\(actor_snapshot\) < 1024/);
  assert.equal(await setupAdminToolsSchema(), 'already_ready');
});

test('migration 017: match room tables are added once, stay optional for every guard, and the pg store round-trips', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  await setupAdminToolsSchema();
  assert.equal(await setupAdminToolsSchema(), 'already_ready');
  assert.equal(await setupEvidenceSchema(), 'already_ready');
  assert.equal(await setupRehearsalSchema(), 'already_ready');
  assert.equal(await setupPrivateDiscordSchema(), 'already_ready');
  assert.equal(await setupTournamentDirectory(), 'already_ready');
  await withClient(requireMatchRoomsSchema);
  const tables = await withClient(client => client.query<{ relname: string }>(
    "SELECT relname FROM pg_class WHERE relname LIKE 'tcg_match_room%' AND relkind = 'r' ORDER BY relname"));
  assert.deepEqual(tables.rows.map(row => row.relname).sort(), [...MATCH_ROOM_TABLES].sort());

  const guild = `7${String(Date.now()).padStart(17, '0')}`;
  const channel = (n: number) => `6${String(n).padStart(17, '0')}`;
  const store = pgMatchRoomStore();
  await store.available();
  assert.equal((await store.settings(guild)).version, 1);
  const saved = await store.saveSettings(guild, 1, { template: '{match}', categoryId: null, pendingCategoryName: 'Matches', baselineChannelIds: [channel(9)] }, 10);
  assert.deepEqual([saved.version, saved.template, saved.pendingCategoryName, saved.baselineChannelIds], [2, '{match}', 'Matches', [channel(9)]]);
  await assert.rejects(store.saveSettings(guild, 1, { template: '{n}', categoryId: null, pendingCategoryName: null, baselineChannelIds: [] }, 11), OpsConflictError);
  const patched = await store.patchSettings(guild, { baselineCapturedAtMs: 12 }, 12);
  assert.deepEqual([patched.version, patched.baselineCapturedAtMs], [2, 12]);

  const room: MatchRoomRow = { guildId: guild, channelId: channel(1), applicationId: channel(8), tableNo: 1, categoryId: null, origin: 'created',
    customName: null, appliedName: '🎮 M1', desiredName: null, originalName: null, renameLog: [], nextRenameAtMs: null, renameError: null,
    missingSinceMs: null, createdAtMs: 5 };
  await store.insertRoom(room);
  await assert.rejects(store.insertRoom({ ...room, channelId: channel(2) }), RuleError, 'one room per table');
  await assert.rejects(store.insertRoom({ ...room, tableNo: 2 }), RuleError, 'one row per channel');
  const updated = await store.updateRoom(guild, room.channelId, current => ({ desiredName: 'Finals', renameLog: [...current.renameLog, 100, 200], nextRenameAtMs: 700_000 }));
  assert.deepEqual([updated!.desiredName, updated!.renameLog, updated!.nextRenameAtMs], ['Finals', [100, 200], 700_000]);
  assert.deepEqual((await store.rooms(guild))[0]!.renameLog, [100, 200]);
  // The log keeps at most four entries, and origins are checked by the table.
  await assert.rejects(store.updateRoom(guild, room.channelId, { renameLog: [1, 2, 3, 4, 5] }));
  await assert.rejects(withClient(client => client.query("UPDATE public.tcg_match_rooms SET origin = 'other' WHERE guild_id = $1", [guild])));
  await store.saveCategory({ guildId: guild, categoryId: channel(3), rangeFrom: 1, rangeTo: 50, origin: 'created', createdAtMs: 6 });
  assert.deepEqual((await store.categories(guild)).map(row => [row.rangeFrom, row.rangeTo, row.origin]), [[1, 50, 'created']]);
  await store.removeCategory(guild, channel(3));
  assert.equal(await store.removeRoom(guild, room.channelId), true);

  // The transcripts table: reasons are checked, and a message document over the size limit is refused.
  await assert.rejects(withClient(client => client.query(
    `INSERT INTO public.tcg_match_room_transcripts (id, guild_id, event_id, match_id, channel_id, archived_at_ms, reason, message_count, content_available, messages)
     VALUES (gen_random_uuid(), $1, 'e', 'M1', $2, 1, 'bogus', 0, true, '[]'::jsonb)`, [guild, channel(1)])));
  await withClient(client => client.query(
    `INSERT INTO public.tcg_match_room_transcripts (id, guild_id, event_id, match_id, channel_id, archived_at_ms, reason, message_count, content_available, messages)
     VALUES (gen_random_uuid(), $1, 'e', 'M1', $2, 1, 'cleanup', 0, true, '[]'::jsonb)`, [guild, channel(1)]));
  await withClient(client => client.query('DELETE FROM public.tcg_match_room_transcripts WHERE guild_id = $1', [guild]));
  await withClient(client => client.query('DELETE FROM public.tcg_match_room_settings WHERE guild_id = $1', [guild]));
});
