import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryOpsAuditStore, LOCAL_ADMIN } from '../ops/audit.js';
import { retentionDue, runRetention, RETENTION_REASON } from './retention.js';
import { MemoryEvidenceStore, RETENTION_EVENT_ENDED_SQL, type EvidenceRecord, type EvidenceRetentionSource, type RetentionCandidate } from './store.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const DAY = 24 * 60 * 60_000;

async function seed() {
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit);
  const add = async (matchId: string) => {
    const pending = await store.createPendingUpload({ eventId, matchId, kind: 'upload', extension: 'mp4', source: 'web',
      submittedBy: 'local-admin', actor: LOCAL_ADMIN });
    return store.markStored(pending.id, { byteSize: 1, sha256: 'a'.repeat(64) }, LOCAL_ADMIN);
  };
  return { audit, store, add };
}

/** Memory source: per-match open flags and one event end time, filtered like the SQL query. */
function source(store: MemoryEvidenceStore, endedAtMs: number | null, openMatches: Set<string>): EvidenceRetentionSource {
  return {
    async candidates(before, limit) {
      return [...store.records.values()].filter(record => record.status !== 'deleted' && !record.hold &&
        endedAtMs !== null && endedAtMs <= before).slice(0, limit)
        .map(record => ({ record: structuredClone(record), eventEndedAtMs: endedAtMs, matchOpen: openMatches.has(record.matchId) }));
    },
    async deletedWithFiles(since) {
      return [...store.records.values()].filter(record => record.status === 'deleted' && record.storagePath && (record.deletedAtMs ?? 0) >= since);
    }
  };
}

test('retentionDue honors never, holds, open matches, running events and the day count', () => {
  const record = { hold: false, status: 'stored' } as EvidenceRecord;
  const candidate = (patch: Partial<RetentionCandidate> = {}, recordPatch: Partial<EvidenceRecord> = {}): RetentionCandidate =>
    ({ record: { ...record, ...recordPatch }, eventEndedAtMs: 0, matchOpen: false, ...patch });
  assert.equal(retentionDue(candidate(), 7, 7 * DAY), true);
  assert.equal(retentionDue(candidate(), 7, 7 * DAY - 1), false);
  assert.equal(retentionDue(candidate(), null, 1_000 * DAY), false, 'never');
  assert.equal(retentionDue(candidate({}, { hold: true }), 7, 100 * DAY), false);
  assert.equal(retentionDue(candidate({ matchOpen: true }), 7, 100 * DAY), false);
  assert.equal(retentionDue(candidate({ eventEndedAtMs: null }), 7, 100 * DAY), false);
  assert.equal(retentionDue(candidate({}, { status: 'deleted' }), 7, 100 * DAY), false);
});

test('a retention run deletes expired items, skips holds and open disputes, removes files, and audits the reason', async () => {
  const { audit, store, add } = await seed();
  const expired = await add('M1');
  const held = await add('M1');
  const disputed = await add('M2');
  await store.setHold(held.id, true, LOCAL_ADMIN);
  const now = 40 * DAY;
  const removed: string[] = [];
  const result = await runRetention({ source: source(store, 5 * DAY, new Set(['M2'])), store,
    removeFile: async record => { removed.push(record.id); }, settings: async () => ({ retention: { days: 30 } }), now: () => now });
  assert.equal(result.deleted, 1);
  assert.deepEqual(removed, [expired.id]);
  assert.equal((await store.get(expired.id))!.status, 'deleted');
  assert.equal((await store.get(expired.id))!.deleteReason, RETENTION_REASON);
  assert.equal((await store.get(held.id))!.status, 'stored');
  assert.equal((await store.get(disputed.id))!.status, 'stored');
  const deletion = audit.entries.find(entry => entry.kind === 'evidence.deleted')!;
  assert.deepEqual([deletion.actorKind, deletion.actorId, deletion.payload.reason], ['system', 'retention', 'retention']);

  // Not yet due under a 30-day setting when the event ended 20 days ago; 'never' deletes nothing.
  const fresh = await seed();
  const item = await fresh.add('M1');
  const notDue = await runRetention({ source: source(fresh.store, now - 20 * DAY, new Set()), store: fresh.store,
    removeFile: async () => {}, settings: async () => ({ retention: { days: 30 } }), now: () => now });
  assert.equal(notDue.deleted, 0);
  const never = await runRetention({ source: source(fresh.store, 0, new Set()), store: fresh.store,
    removeFile: async () => { throw new Error('must not run'); }, settings: async () => ({ retention: { days: null } }), now: () => now });
  assert.equal(never.deleted, 0);
  assert.equal((await fresh.store.get(item.id))!.status, 'stored');
});

test('failed file removals are retried for recently deleted rows', async () => {
  const { store, add } = await seed();
  const item = await add('M1');
  await store.softDelete(item.id, 'manual', LOCAL_ADMIN);
  const removed: string[] = [];
  const result = await runRetention({ source: source(store, null, new Set()), store,
    removeFile: async record => { removed.push(record.id); }, settings: async () => ({ retention: { days: 30 } }) });
  assert.deepEqual(removed, [item.id]);
  assert.equal(result.filesChecked, 1);
});

test('an event ends only when its session is retired or the tournament deleted, never from match phases', () => {
  const sql = RETENTION_EVENT_ENDED_SQL;
  assert.match(sql, /s\.deleted_at_ms IS NOT NULL THEN s\.deleted_at_ms/);
  assert.match(sql, /s\.status = 'retired' THEN s\.retired_at_ms/);
  assert.doesNotMatch(sql, /matches|phase|final|audit|published/i, 'all-final plus inactivity is not an end (paused Swiss rounds)');
});
