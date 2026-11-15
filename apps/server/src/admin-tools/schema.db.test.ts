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
