import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ADMIN_TOOLS_SETTINGS } from '@tcg-live/core';
import { setupEvidenceSchema } from '../evidence/schema.js';
import { LOCAL_ADMIN } from '../ops/audit.js';
import { setupPrivateDiscordSchema, setupRehearsalSchema, transaction, withClient } from '../rehearsal/store.js';
import { setupTournamentDirectory } from '../tournaments/directory.js';
import { allocateAdminCounter, requireAdminToolsSchema, setupAdminToolsSchema } from './schema.js';
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
