import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../ops/errors.js';
import { evidenceRelativePath, MemoryEvidenceStore, parseEvidenceUrl, resolveEvidencePath } from './store.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const actor = { kind: 'admin' as const, id: 'local-admin' };
const base = { eventId, matchId: 'M1', source: 'web' as const, submittedBy: 'local-admin' as const, actor };

test('links must be https without credentials and within the length cap', () => {
  assert.equal(parseEvidenceUrl('https://youtu.be/abc?t=10'), 'https://youtu.be/abc?t=10');
  for (const url of ['http://youtu.be/x', 'javascript:alert(1)', 'https://user:pw@host/x', 'https://host/ x', 'file:///C:/x',
    'https://' + 'a'.repeat(2050), '', 42, 'not a url'])
    assert.throws(() => parseEvidenceUrl(url), OpsInputError, String(url).slice(0, 40));
});

test('evidence paths are data/evidence/<eventId>/<evidenceId>.<ext> and cannot escape the root', () => {
  const root = path.resolve('evidence-root');
  const relative = evidenceRelativePath(eventId.toUpperCase(), evidenceId, 'mp4');
  assert.equal(relative, `${eventId}/${evidenceId}.mp4`);
  assert.equal(resolveEvidencePath(relative, root), path.join(root, eventId, `${evidenceId}.mp4`));
  for (const bad of [`../${evidenceId}.mp4`, `${eventId}/../../x.mp4`, `${eventId}/${evidenceId}.exe`, `${eventId}\\${evidenceId}.mp4`,
    `/${eventId}/${evidenceId}.mp4`, `C:/${eventId}/${evidenceId}.mp4`, ''])
    assert.throws(() => resolveEvidencePath(bad, root), OpsInputError, bad);
  assert.throws(() => evidenceRelativePath('..', evidenceId, 'mp4'), OpsInputError);
  assert.throws(() => evidenceRelativePath(eventId, evidenceId, 'exe' as never), OpsInputError);
});

test('link, upload, hold and delete lifecycle with an audit row for every change', async () => {
  const audit = new MemoryOpsAuditStore(() => 1);
  const store = new MemoryEvidenceStore(audit, () => 100, new Set([eventId]));
  const link = await store.createLink({ ...base, url: 'https://streamable.com/abc', note: '  game 2 ' });
  assert.equal(link.status, 'stored');
  assert.equal(link.note, 'game 2');
  assert.equal(link.playable, false);
  assert.equal('storagePath' in link, false, 'DTOs never expose the storage path');
  await assert.rejects(store.createLink({ ...base, eventId: '33333333-3333-4333-8333-333333333333', url: 'https://x.y' }), OpsNotFoundError);
  await assert.rejects(store.createLink({ ...base, matchId: 'X', url: 'https://x.y' }), OpsInputError);

  const pending = await store.createPendingUpload({ ...base, kind: 'upload', extension: 'mkv', originalName: 'C:\\Users\\me\\clip.mkv' });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.originalName, 'clip.mkv');
  assert.match(pending.storagePath!, new RegExp(`^${eventId}/[0-9a-f-]{36}\\.mkv$`));
  const stored = await store.markStored(pending.id, { byteSize: 10, sha256: 'a'.repeat(64) }, actor);
  assert.equal(stored.mime, 'video/x-matroska');
  assert.equal(stored.playable, false, 'MKV is download only');
  await assert.rejects(store.markStored(pending.id, { byteSize: 10, sha256: 'a'.repeat(64) }, actor), OpsConflictError);
  const voice = await store.createPendingUpload({ ...base, kind: 'voice', source: 'bot', submittedBy: 'bot', seat: 'A', extension: 'ogg' });
  assert.equal((await store.markStored(voice.id, { byteSize: 1, sha256: 'b'.repeat(64), durationMs: 5 }, actor)).playable, true);
  const failed = await store.createPendingUpload({ ...base, kind: 'upload', extension: 'mp4' });
  assert.equal((await store.markFailed(failed.id, 'bad\u0000type', actor)).status, 'failed');

  await store.setHold(stored.id, true, actor);
  await store.setHold(stored.id, true, actor);   // no change, no audit
  await assert.rejects(store.softDelete(stored.id, 'duplicate', actor), OpsConflictError);
  await assert.rejects(store.softDelete(link.id, '   ', actor), OpsInputError);
  const deleted = await store.softDelete(link.id, 'wrong match', actor);
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.deleteReason, 'wrong match');
  assert.equal((await store.softDelete(link.id, 'again', actor)).deleteReason, 'wrong match', 'idempotent');
  await assert.rejects(store.setHold(link.id, true, actor), OpsConflictError);
  await assert.rejects(store.setHold('../x', true, actor), OpsNotFoundError);

  const listed = await store.list(eventId, 'M1');
  assert.equal(listed.length, 4);
  assert.ok(listed.every(item => !('storagePath' in item)));
  assert.deepEqual(audit.entries.map(entry => entry.kind), ['evidence.submitted', 'evidence.submitted', 'evidence.submitted',
    'evidence.failed', 'evidence.hold', 'evidence.deleted']);
  assert.equal(audit.entries[3]!.payload.reason, 'bad type');
});

test('recordedUserId and recordingStartedAtMs: voice recordings only, validated', async () => {
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit);
  const event = '11111111-1111-4111-8111-111111111111';
  const common = { eventId: event, matchId: 'M1', extension: 'ogg' as const, source: 'bot' as const, submittedBy: 'bot' as const,
    actor: { kind: 'bot' as const, id: 'voice-recorder' } };
  const voice = await store.createPendingUpload({ ...common, kind: 'voice', recordedUserId: '222222222222222222', recordingStartedAtMs: 5_000 });
  assert.deepEqual([voice.recordedUserId, voice.recordingStartedAtMs], ['222222222222222222', 5_000]);
  const upload = await store.createPendingUpload({ ...common, kind: 'upload' });
  assert.equal('recordedUserId' in upload, false);
  await assert.rejects(store.createPendingUpload({ ...common, kind: 'upload', recordedUserId: '222222222222222222' }), /voice recordings/);
  await assert.rejects(store.createPendingUpload({ ...common, kind: 'voice', recordedUserId: 'x' }), /recorded player/);
  await assert.rejects(store.createPendingUpload({ ...common, kind: 'voice', recordingStartedAtMs: -1 }), /start time/);
});
