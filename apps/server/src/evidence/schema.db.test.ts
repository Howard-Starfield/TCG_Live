import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODERATION_SETTINGS } from '@tcg-live/core';
import { createRehearsalEvent, setupPrivateDiscordSchema, setupRehearsalSchema, withClient } from '../rehearsal/store.js';
import { setupTournamentDirectory } from '../tournaments/directory.js';
import { pgOpsAuditStore } from '../ops/audit.js';
import { OpsConflictError } from '../ops/errors.js';
import { pgModerationFlagStore } from '../moderation/flags.js';
import { ModerationVersionConflictError, pgModerationSettingsStore } from '../moderation/settings.js';
import { pgEvidenceStore } from './store.js';
import { requireEvidenceSchema, setupEvidenceSchema } from './schema.js';

const optIn = process.env.npm_lifecycle_event === 'test:db';
const skip = optIn ? false : 'Real database suite is opt-in: npm run test:db';
const actor = { kind: 'admin' as const, id: 'local-admin' };

test('migration 012 is idempotent and every older setup still accepts the new schema', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  assert.match(await setupPrivateDiscordSchema(), /^(upgraded|already_ready)$/);
  assert.match(await setupTournamentDirectory(), /^(created|already_ready)$/);
  assert.match(await setupEvidenceSchema(), /^(created|already_ready)$/);
  assert.equal(await setupEvidenceSchema(), 'already_ready');
  assert.equal(await setupRehearsalSchema(), 'already_ready');
  assert.equal(await setupPrivateDiscordSchema(), 'already_ready');
  assert.equal(await setupTournamentDirectory(), 'already_ready');
  await withClient(requireEvidenceSchema);
});

test('evidence, settings, flags and audit stores round-trip against PostgreSQL', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  await setupEvidenceSchema();
  const event = await createRehearsalEvent();
  const store = pgEvidenceStore();
  const audit = pgOpsAuditStore();
  const before = (await audit.list({ eventId: event.id, limit: 500 })).entries.length;
  const link = await store.createLink({ eventId: event.id, matchId: 'M1', url: 'https://youtu.be/x', source: 'web',
    submittedBy: 'local-admin', actor });
  await store.setHold(link.id, true, actor);
  await assert.rejects(store.softDelete(link.id, 'x', actor), OpsConflictError);
  await store.setHold(link.id, false, actor);
  assert.equal((await store.softDelete(link.id, 'test cleanup', actor)).status, 'deleted');
  const pending = await store.createPendingUpload({ eventId: event.id, matchId: 'M2', kind: 'upload', extension: 'webm',
    source: 'web', submittedBy: 'local-admin', actor });
  assert.equal((await store.markStored(pending.id, { byteSize: 1, sha256: 'd'.repeat(64) }, actor)).playable, true);
  assert.equal((await store.list(event.id, 'M1')).length, 1);
  assert.equal((await audit.list({ eventId: event.id, limit: 500 })).entries.length - before, 5);

  const guild = `9${String(Date.now()).padStart(17, '0')}`;
  const settings = pgModerationSettingsStore();
  assert.equal((await settings.get(guild)).version, 0);
  const saved = await settings.put(guild, 0, structuredClone(DEFAULT_MODERATION_SETTINGS), actor);
  assert.equal(saved.version, 1);
  await assert.rejects(settings.put(guild, 0, structuredClone(DEFAULT_MODERATION_SETTINGS), actor), ModerationVersionConflictError);
  await settings.setAutoModRuleIds(guild, { preset: '123456789012345678' });
  assert.deepEqual(await settings.getAutoModRuleIds(guild), { preset: '123456789012345678' });

  const flags = pgModerationFlagStore();
  const flag = await flags.append({ kind: 'volume', guildId: guild, detail: { peakDbfs: -1, rmsDbfs: -4, sustainedMs: 500, thresholdDbfs: -8 } });
  assert.deepEqual((await flags.list(guild, { after: flag.id - 1 })).flags.map(item => item.id), [flag.id]);
});
