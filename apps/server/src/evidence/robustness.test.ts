// Robustness of the evidence file pipeline: Windows rename locks, disk-full mapping, duplicate uploads,
// codec sniffing, the cached quota account, and the sweep of uploads interrupted by a crash.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EVIDENCE_DOWNLOAD_ONLY_MIME } from '@tcg-live/core';
import { LOCAL_ADMIN, MemoryOpsAuditStore } from '../ops/audit.js';
import { EvidenceFileError, EvidenceFiles, evidenceFsError, type EvidenceDiskOptions } from './files.js';
import { STALE_PENDING_MS, sweepStalePending } from './retention.js';
import { uploadHttpError } from './seams.js';
import { mp4Codecs, stsdCodecs } from './sniff.js';
import { MemoryEvidenceStore, resolveEvidencePath } from './store.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const GIB = 1024 ** 3;
const box = (type: string, ...payload: Buffer[]) => {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};
const u32 = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; };
const stsd = (...codecs: string[]) => box('stsd', u32(0), u32(codecs.length), ...codecs.map(codec => box(codec, Buffer.alloc(8))));
const ftyp = (brand: string) => box('ftyp', Buffer.from(brand, 'latin1'), u32(0x200), Buffer.from('isomiso2', 'latin1'));
/** ftyp, then a large mdat, then moov at the end of the file (as cameras and phones often write it). */
const moovAtEnd = (brand: string, ...codecs: string[]) =>
  Buffer.concat([ftyp(brand), box('mdat', Buffer.alloc(5_000, 1)), box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd(...codecs))))))]);

async function* chunks(...parts: Buffer[]): AsyncGenerator<Buffer> { for (const part of parts) yield part; }

async function fixture(options: EvidenceDiskOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-evidence-robust-'));
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit);
  const files = new EvidenceFiles({ root, freeBytes: async () => 100 * GIB, ...options });
  const evidence = { eventId, matchId: 'M1', source: 'web' as const, submittedBy: 'local-admin' as const, actor: LOCAL_ADMIN };
  const ingest = (body: Buffer, matchId = 'M1') => files.ingest({ source: chunks(body), maxBytes: 1_000_000, store,
    evidence: { ...evidence, matchId } });
  return { root, audit, store, files, ingest, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const errno = (code: string) => Object.assign(new Error(code), { code });

test('codec sniffing walks top-level boxes to a moov at the end and reads stsd sample entries', async () => {
  assert.deepEqual(stsdCodecs(box('moov', stsd('avc1', 'mp4a'))), ['avc1', 'mp4a']);
  const file = moovAtEnd('isom', 'hvc1');
  const readAt = async (position: number, length: number) => file.subarray(position, position + length);
  assert.deepEqual(await mp4Codecs(readAt, file.length), ['hvc1']);
  assert.equal(await mp4Codecs(readAt, 20), null, 'no moov in a truncated file');
  // 64-bit box size on mdat.
  const large = Buffer.concat([ftyp('isom'), Buffer.from([0, 0, 0, 1]), Buffer.from('mdat'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 20]),
    Buffer.alloc(4), box('moov', stsd('apcn'))]);
  assert.deepEqual(await mp4Codecs(async (p, l) => large.subarray(p, p + l), large.length), ['apcn']);
});

test('HEVC and ProRes MP4/MOV are stored download-only; H.264 stays playable', async () => {
  const f = await fixture();
  try {
    const hevc = await f.ingest(moovAtEnd('isom', 'hvc1', 'mp4a'));
    assert.equal(hevc.status, 'stored');
    assert.equal(hevc.playable, false);
    assert.equal(hevc.mime, EVIDENCE_DOWNLOAD_ONLY_MIME);
    const prores = await f.ingest(moovAtEnd('qt  ', 'apch'));
    assert.equal(prores.playable, false);
    assert.equal((await f.store.get(prores.id))!.storagePath!.endsWith('.mov'), true);
    const h264 = await f.ingest(moovAtEnd('isom', 'avc1', 'mp4a'));
    assert.equal(h264.playable, true);
    assert.equal(h264.mime, 'video/mp4');
  } finally { await f.cleanup(); }
});

test('the same file uploaded twice to one match is stored once and returned as a duplicate', async () => {
  const f = await fixture();
  try {
    const body = moovAtEnd('isom', 'avc1');
    const first = await f.ingest(body);
    assert.equal(first.duplicate, undefined);
    const again = await f.ingest(body);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal(f.store.records.size, 1);
    assert.deepEqual(await readdir(path.join(f.root, '.tmp')), [], 'the second copy left no temp file');
    assert.equal(f.audit.entries.filter(entry => entry.kind === 'evidence.submitted').length, 1);
    // Another match stores its own copy; a deleted copy does not count.
    assert.notEqual((await f.ingest(body, 'M2')).id, first.id);
    await f.store.softDelete(first.id, 'wrong clip', LOCAL_ADMIN);
    assert.equal((await f.ingest(body)).duplicate, undefined);
  } finally { await f.cleanup(); }
});

test('a temp-to-final rename blocked by antivirus (EPERM/EBUSY) is retried with backoff', async () => {
  let failures = 2;
  const waits: number[] = [];
  const f = await fixture({ sleep: async ms => { waits.push(ms); },
    rename: async (from, to) => { if (failures-- > 0) throw errno(failures % 2 ? 'EPERM' : 'EBUSY'); await rename(from, to); } });
  try {
    const item = await f.ingest(moovAtEnd('isom', 'avc1'));
    assert.equal(item.status, 'stored');
    assert.deepEqual(waits, [100, 200]);
  } finally { await f.cleanup(); }
});

test('a rename still locked after the retry window fails cleanly with a readable 500; the row is marked failed', async () => {
  let clock = 0;
  const f = await fixture({ now: () => clock, renameRetryMs: 1_000, sleep: async ms => { clock += ms; },
    rename: async () => { throw errno('EPERM'); } });
  try {
    await assert.rejects(f.ingest(moovAtEnd('isom', 'avc1')),
      (error: unknown) => error instanceof EvidenceFileError && error.status === 500 && /locked or not writable/.test(error.message));
    const [record] = f.store.records.values();
    assert.equal(record!.status, 'failed');
    assert.deepEqual(await readdir(path.join(f.root, '.tmp')), []);
    const http = uploadHttpError(new EvidenceFileError(500, 'x')) as { status: number; code: string; headers: Record<string, string> };
    assert.deepEqual([http.status, http.code, http.headers.Connection], [500, 'internal', 'close']);
  } finally { await f.cleanup(); }
});

test('disk-full errors map to 507 and other errors pass through', async () => {
  for (const code of ['ENOSPC', 'EDQUOT']) {
    const mapped = evidenceFsError(errno(code));
    assert.ok(mapped instanceof EvidenceFileError && mapped.status === 507, code);
  }
  const other = new Error('boom');
  assert.equal(evidenceFsError(other), other);
  const f = await fixture({ rename: async () => { throw errno('ENOSPC'); } });
  try {
    await assert.rejects(f.ingest(moovAtEnd('isom', 'avc1')), (error: unknown) => error instanceof EvidenceFileError && error.status === 507);
  } finally { await f.cleanup(); }
});

test('the quota account is walked once, then kept current from writes and removals', async () => {
  let walks = 0;
  const f = await fixture({ usedBytes: async () => { walks++; return 1_000; } });
  try {
    assert.deepEqual(await f.files.usage(), { usedBytes: 1_000, inflightBytes: 0, quotaBytes: f.files.quotaBytes });
    const body = moovAtEnd('isom', 'avc1');
    const item = await f.ingest(body);
    f.files.noteWritten(50);
    assert.equal((await f.files.usage()).usedBytes, 1_000 + body.length + 50);
    await f.files.removeFile((await f.store.get(item.id))!);
    assert.equal((await f.files.usage()).usedBytes, 1_050);
    assert.equal(walks, 1, 'no directory walk per call');
    await f.files.storedBytes(true);
    assert.equal(walks, 2);
  } finally { await f.cleanup(); }
});

test('the startup sweep fails stale pending uploads, removes their files, and leaves voice rows alone', async () => {
  let clock = 1_000_000;
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit, () => clock);
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-evidence-sweep-'));
  try {
    const base = { eventId, matchId: 'M1', source: 'web' as const, submittedBy: 'local-admin' as const, actor: LOCAL_ADMIN };
    const crashed = await store.createPendingUpload({ ...base, kind: 'upload', extension: 'mp4' });
    const voice = await store.createPendingUpload({ ...base, source: 'bot', submittedBy: 'bot', kind: 'voice', extension: 'ogg' });
    clock += STALE_PENDING_MS + 1;
    const fresh = await store.createPendingUpload({ ...base, kind: 'upload', extension: 'mp4' });
    // The crash came after the rename: the file is on disk.
    const orphan = resolveEvidencePath(crashed.storagePath!, root);
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, 'x');
    const files = new EvidenceFiles({ root });
    const removed: string[] = [];
    const failed = await sweepStalePending({ now: () => clock, store,
      source: { async stalePendingUploads(before) {
        return [...store.records.values()].filter(record => record.status === 'pending' && record.createdAtMs < before);
      } },
      removeFile: async record => { removed.push(record.id); await files.removeFile(record); } });
    assert.equal(failed, 1);
    assert.equal((await store.get(crashed.id))!.status, 'failed');
    assert.equal((await store.get(voice.id))!.status, 'pending', 'voice rows are recovered by the recorder');
    assert.equal((await store.get(fresh.id))!.status, 'pending', 'recent uploads may still be finishing');
    assert.deepEqual(removed, [crashed.id]);
    assert.deepEqual(await readdir(path.dirname(orphan)), []);
    const entry = audit.entries.find(item => item.kind === 'evidence.failed')!;
    assert.deepEqual([entry.actorKind, entry.actorId], ['system', 'retention']);
    assert.equal(await sweepStalePending({ source: {}, store, removeFile: async () => {} }), 0, 'sources without the query skip it');
  } finally { await rm(root, { recursive: true, force: true }); }
});
