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
import { requireEvidenceRepliesSchema, requireEvidenceSchema, setupEvidenceSchema } from './schema.js';

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

test('migration 015: text notes and the reply table keep their constraints, and setup is idempotent', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  assert.match(await setupEvidenceSchema(), /^(created|already_ready)$/);
  assert.equal(await setupEvidenceSchema(), 'already_ready');
  assert.equal(await setupEvidenceSchema(), 'already_ready');
  // One of each named constraint after any number of setups (015 replaces 012's unnamed checks exactly once).
  const names = await withClient(async client => (await client.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'public.tcg_evidence'::regclass AND contype = 'c' ORDER BY conname`)).rows.map(row => row.conname));
  for (const name of ['tcg_evidence_kind_check', 'tcg_evidence_note_length', 'tcg_evidence_note_is_text'])
    assert.equal(names.filter(candidate => candidate === name).length, 1, name);
  assert.equal(names.includes('tcg_evidence_note_check'), false, 'the 500-character column check is replaced');
  // Older databases and the new shape both pass every earlier setup guard.
  assert.equal(await setupRehearsalSchema(), 'already_ready');
  assert.equal(await setupTournamentDirectory(), 'already_ready');
  await withClient(requireEvidenceRepliesSchema);

  const event = await createRehearsalEvent();
  const store = pgEvidenceStore();
  const note = await store.createNote({ eventId: event.id, matchId: 'M1', text: 'x'.repeat(4000), source: 'web', submittedBy: 'local-admin', actor });
  assert.equal(note.kind, 'note');
  assert.equal(note.note.length, 4000);
  assert.equal(note.externalUrl, null);
  assert.equal(note.playable, false);
  await assert.rejects(store.createNote({ eventId: event.id, matchId: 'M1', text: 'x'.repeat(4001), source: 'web', submittedBy: 'local-admin', actor }));
  await assert.rejects(store.createNote({ eventId: event.id, matchId: 'M1', text: '   ', source: 'web', submittedBy: 'local-admin', actor }));
  // A note holds and soft-deletes like any other item.
  await store.setHold(note.id, true, actor);
  await assert.rejects(store.softDelete(note.id, 'x', actor), OpsConflictError);
  await store.setHold(note.id, false, actor);
  const removed = await store.softDelete(note.id, 'test cleanup', actor);
  assert.equal(removed.status, 'deleted');
  assert.equal(removed.note, '', 'deleting a note removes its text');
  assert.equal((await store.list(event.id, 'M1')).find(entry => entry.id === note.id)?.note, '', 'and reads back empty');
  assert.equal(await withClient(async client => (await client.query<{ note: string }>('SELECT note FROM public.tcg_evidence WHERE id = $1', [note.id])).rows[0]!.note), '');

  // The constraints themselves, bypassing the store's own validation.
  const insert = (columns: string, values: unknown[]) => withClient(client => client.query(
    `INSERT INTO public.tcg_evidence (id, event_id, match_id, source, submitted_by, status, created_at_ms, ${columns})
     VALUES (gen_random_uuid(), $1, 'M1', 'web', 'local-admin', 'stored', 1, ${values.map((_, index) => `$${index + 2}`).join(', ')})`,
    [event.id, ...values]));
  await assert.doesNotReject(insert('kind, note', ['note', 'typed text']));
  await assert.rejects(insert('kind, note', ['note', '   ']), 'a note needs text');
  await assert.rejects(insert('kind, note', ['note', 'x'.repeat(4001)]), 'a note is at most 4000');
  await assert.rejects(insert('kind, note, external_url', ['note', 'text', 'https://example.com/x']), 'a note has no link');
  await assert.rejects(insert('kind, note, storage_path', ['note', 'text', `${event.id}/${event.id}.mp4`]), 'a note has no file');
  await assert.rejects(insert('kind, note, byte_size', ['note', 'text', 5]), 'a note has no file facts');
  await assert.doesNotReject(insert('kind, note, external_url', ['link', 'x'.repeat(500), 'https://example.com/x']));
  await assert.rejects(insert('kind, note, external_url', ['link', 'x'.repeat(501), 'https://example.com/x']), 'captions stay at 500');
  await assert.rejects(insert('kind, note', ['bogus', 'text']), 'unknown kinds are still refused');

  // The reply thread: store round trip and its constraints.
  const staff = await store.createReply({ eventId: event.id, matchId: 'M1', body: 'staff only', audience: 'staff', author: 'local-admin', actor });
  assert.equal(staff.status, 'recorded');
  await assert.rejects(store.claimReplyRetry(staff.id, actor), OpsConflictError);
  const players = await store.createReply({ eventId: event.id, matchId: 'M1', body: 'to players', audience: 'players', author: 'local-admin', actor });
  assert.equal(players.status, 'pending');
  const failed = await store.finishReplyDelivery(players.id, { error: 'The bot is not allowed to post in this match room.' }, actor, players.attempt);
  assert.equal(failed.status, 'failed');
  assert.equal((await store.finishReplyDelivery(players.id, { messageId: '123456789012345678' }, actor, players.attempt)).status, 'failed',
    'only a pending reply finishes; a late finish changes nothing and is not an error');
  const retry = await store.claimReplyRetry(players.id, actor);
  assert.equal(retry.status, 'pending');
  assert.notEqual(retry.attempt, players.attempt);
  await assert.rejects(store.claimReplyRetry(players.id, actor), OpsConflictError, 'a second retry cannot start while one is in flight');
  // The first attempt reports late (failure): it must not overwrite the newer attempt.
  assert.equal((await store.finishReplyDelivery(players.id, { error: 'late failure' }, actor, players.attempt)).status, 'pending');
  const delivered = await store.finishReplyDelivery(players.id, { messageId: '123456789012345678' }, actor, retry.attempt);
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.discordMessageId, '123456789012345678');
  assert.equal(delivered.deliveryError, null);
  await assert.rejects(store.claimReplyRetry(players.id, actor), OpsConflictError, 'a delivered reply is never posted twice');
  assert.deepEqual((await store.listReplies(event.id, 'M1')).map(reply => reply.id), [staff.id, players.id]);
  assert.deepEqual(await store.listReplies(event.id, 'M2'), []);
  assert.equal((await store.getReply(players.id))?.status, 'delivered');
  const raw = (columns: string, values: unknown[]) => withClient(client => client.query(
    `INSERT INTO public.tcg_evidence_replies (id, event_id, match_id, author, body, created_at_ms, ${columns})
     VALUES (gen_random_uuid(), $1, 'M1', 'local-admin', 'text', 1, ${values.map((_, index) => `$${index + 2}`).join(', ')})`, [event.id, ...values]));
  await assert.rejects(raw('audience, status', ['staff', 'pending']), 'a staff reply is never pending');
  await assert.rejects(raw('audience, status', ['players', 'recorded']), 'a players reply is delivered, not recorded');
  await assert.rejects(raw('audience, status', ['players', 'delivered']), 'delivered needs a message ID');
  await assert.rejects(raw('audience, status, discord_message_id', ['players', 'failed', '123456789012345678']), 'only a delivered reply has a message ID');
  await assert.rejects(raw('audience, status, delivery_error', ['players', 'delivered', 'oops']), 'an error belongs to a failed reply');
  await assert.rejects(raw('audience, status', ['everyone', 'pending']), 'unknown audience');
  await assert.doesNotReject(raw('audience, status', ['staff', 'recorded']));
  await assert.doesNotReject(raw('audience, status, discord_message_id', ['players', 'delivered', '123456789012345678']));
  // The audit has one evidence.reply row per step of the first two replies.
  const entries = (await pgOpsAuditStore().list({ eventId: event.id, limit: 500 })).entries.filter(entry => entry.kind === 'evidence.reply');
  assert.deepEqual(entries.map(entry => entry.payload.stage), ['created', 'created', 'failed', 'retry', 'delivered']);
  // Deleted notes may be blank; live notes may not.
  const deletedBlank = (note: string, status: string) => withClient(client => client.query(
    `INSERT INTO public.tcg_evidence (id, event_id, match_id, source, submitted_by, kind, note, status, deleted_at_ms, created_at_ms)
     VALUES (gen_random_uuid(), $1, 'M1', 'web', 'local-admin', 'note', $2, $3, CASE WHEN $3::text = 'deleted' THEN 5 END, 1)`, [event.id, note, status]));
  await assert.doesNotReject(deletedBlank('', 'deleted'));
  await assert.rejects(deletedBlank('', 'stored'), 'a live note needs text');
});
