import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryOpsAuditStore, LOCAL_ADMIN } from '../ops/audit.js';
import { OpsInputError } from '../ops/errors.js';
import { EvidenceFileError, EvidenceFiles, type EvidenceDiskOptions } from './files.js';
import { containedRealPath, parseRange } from './range.js';
import { sniffEvidenceType } from './sniff.js';
import { MemoryEvidenceStore, resolveEvidencePath } from './store.js';
import { PlaybackTickets } from './tickets.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const GIB = 1024 ** 3;
const bytes = (...parts: (string | number[])[]) => Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part)));
const MP4 = bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0], 'isomiso2avc1mp41');

test('range parsing: single ranges, suffixes, clamping, multi-range and malformed fall back to 200, 416 when unsatisfiable', () => {
  const size = 100;
  const cases: [string | undefined, ReturnType<typeof parseRange>][] = [
    [undefined, { kind: 'full' }],
    ['bytes=0-9', { kind: 'partial', start: 0, end: 9 }],
    ['bytes=10-', { kind: 'partial', start: 10, end: 99 }],
    ['bytes=-5', { kind: 'partial', start: 95, end: 99 }],
    ['bytes=-500', { kind: 'partial', start: 0, end: 99 }],
    ['bytes=90-500', { kind: 'partial', start: 90, end: 99 }],
    ['bytes=99-99', { kind: 'partial', start: 99, end: 99 }],
    ['bytes=100-', { kind: 'unsatisfiable' }],
    ['bytes=100-200', { kind: 'unsatisfiable' }],
    ['bytes=-0', { kind: 'unsatisfiable' }],
    ['bytes=0-1,5-6', { kind: 'full' }],
    ['bytes=5-1', { kind: 'full' }],
    ['bytes=-', { kind: 'full' }],
    ['items=0-1', { kind: 'full' }],
    ['bytes=a-b', { kind: 'full' }],
    [`bytes=${'9'.repeat(17)}-`, { kind: 'full' }]
  ];
  for (const [header, expected] of cases) assert.deepEqual(parseRange(header, size), expected, String(header));
  assert.deepEqual(parseRange('bytes=0-0', 0), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange('bytes=-1', 0), { kind: 'unsatisfiable' });
});

test('magic-byte sniffing recognises the allowed containers and refuses everything else', () => {
  assert.equal(sniffEvidenceType(MP4), 'mp4');
  assert.equal(sniffEvidenceType(bytes([0, 0, 0, 0x14], 'ftypqt  ')), 'mov');
  assert.equal(sniffEvidenceType(bytes([0, 0, 0, 0x20], 'ftypM4A ')), 'm4a');
  assert.equal(sniffEvidenceType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], 'webm')), 'webm');
  assert.equal(sniffEvidenceType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88], 'matroska')), 'mkv');
  assert.equal(sniffEvidenceType(bytes('OggS', [0, 2])), 'ogg');
  assert.equal(sniffEvidenceType(bytes('ID3', [4, 0, 0])), 'mp3');
  assert.equal(sniffEvidenceType(bytes([0xff, 0xfb, 0x90, 0x64])), 'mp3');
  assert.equal(sniffEvidenceType(bytes([0xff, 0xf1, 0x50, 0x80])), null, 'ADTS AAC is not MP3');
  for (const other of [bytes(''), bytes('%PDF-1.7'), bytes([0x89], 'PNG'), bytes('<html>'), bytes('MZ', [0x90, 0]), bytes([0, 0, 0, 0x18], 'ftyp')])
    assert.equal(sniffEvidenceType(other), null);
});

test('stored paths are contained: traversal is refused and realpath containment rejects outside files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-evidence-'));
  try {
    for (const bad of ['../x.mp4', `${eventId}/../../x.mp4`, `${eventId}/${eventId}.exe`, `C:/${eventId}/${eventId}.mp4`, ''])
      assert.throws(() => resolveEvidencePath(bad, root), OpsInputError, bad);
    const inside = resolveEvidencePath(`${eventId}/${eventId}.mp4`, root);
    await mkdir(path.dirname(inside), { recursive: true });
    await writeFile(inside, MP4);
    assert.equal(await containedRealPath(root, inside), await import('node:fs/promises').then(fs => fs.realpath(inside)));
    const outside = path.join(root, '..', `outside-${process.pid}.mp4`);
    await writeFile(outside, MP4);
    try {
      assert.equal(await containedRealPath(root, outside), null);
      assert.equal(await containedRealPath(root, path.join(root, `${eventId}`, '..', '..', path.basename(outside))), null);
      assert.equal(await containedRealPath(root, root), null, 'the root itself is not a file inside it');
      assert.equal(await containedRealPath(root, path.join(root, 'missing.mp4')), null);
    } finally { await rm(outside, { force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function* chunks(...parts: Buffer[]): AsyncGenerator<Buffer> { for (const part of parts) yield part; }

async function fixture(options: EvidenceDiskOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-evidence-'));
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit);
  const files = new EvidenceFiles({ root, freeBytes: async () => 100 * GIB, ...options });
  const evidence = { eventId, matchId: 'M1', source: 'web' as const, submittedBy: 'local-admin' as const, actor: LOCAL_ADMIN };
  const temps = async () => (await readdir(files.tempDir).catch(() => [])).length;
  return { root, audit, store, files, evidence, temps, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('ingest streams to a temp file, hashes, sniffs, and moves into <event>/<id>.<ext>', async () => {
  const f = await fixture();
  try {
    const body = Buffer.concat([MP4, Buffer.alloc(10_000, 7)]);
    const item = await f.files.ingest({ source: chunks(body.subarray(0, 5), body.subarray(5)), maxBytes: 1_000_000,
      store: f.store, evidence: { ...f.evidence, note: 'turn 4', originalName: 'C:\\clips\\game.mp4' } });
    assert.equal(item.status, 'stored');
    assert.equal(item.byteSize, body.length);
    assert.equal(item.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(item.mime, 'video/mp4');
    assert.equal(item.originalName, 'game.mp4');
    assert.equal(item.playable, true);
    const record = (await f.store.get(item.id))!;
    assert.equal(record.storagePath, `${eventId}/${item.id}.mp4`);
    assert.deepEqual(await readFile(path.join(f.root, eventId, `${item.id}.mp4`)), body);
    assert.equal(await f.temps(), 0);
    const mkv = await f.files.ingest({ source: chunks(bytes([0x1a, 0x45, 0xdf, 0xa3], 'matroska')), maxBytes: 100, store: f.store, evidence: f.evidence });
    assert.equal(mkv.playable, false, 'MKV is stored as download-only');
    await f.files.removeFile((await f.store.get(item.id))!);
    await assert.rejects(readFile(path.join(f.root, eventId, `${item.id}.mp4`)), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('size cap aborts mid-stream and cleans the temp file; declared oversize is refused before reading', async () => {
  const f = await fixture();
  try {
    let pulled = 0;
    async function* big() { for (let i = 0; i < 10; i++) { pulled++; yield i === 0 ? MP4 : Buffer.alloc(100, 1); } }
    await assert.rejects(f.files.ingest({ source: big(), maxBytes: 250, store: f.store, evidence: f.evidence }),
      (error: unknown) => error instanceof EvidenceFileError && error.status === 413);
    assert.ok(pulled < 10, 'stopped reading at the cap');
    assert.equal(await f.temps(), 0);
    assert.equal(f.store.records.size, 0, 'no row for a refused stream');
    let read = false;
    async function* never() { read = true; yield MP4; }
    await assert.rejects(f.files.ingest({ source: never(), maxBytes: 250, declaredBytes: 251, store: f.store, evidence: f.evidence }),
      (error: unknown) => error instanceof EvidenceFileError && error.status === 413);
    assert.equal(read, false);
    // An aborted source (client disconnect) also leaves nothing behind.
    async function* aborted() { yield MP4; throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' }); }
    await assert.rejects(f.files.ingest({ source: aborted(), maxBytes: 1_000, store: f.store, evidence: f.evidence }), { code: 'ECONNRESET' });
    assert.equal(await f.temps(), 0);
    // Unknown type: refused after streaming, temp removed, no row.
    await assert.rejects(f.files.ingest({ source: chunks(bytes('%PDF-1.7 hello')), maxBytes: 1_000, store: f.store, evidence: f.evidence }),
      (error: unknown) => error instanceof EvidenceFileError && error.status === 415);
    assert.equal(await f.temps(), 0);
    assert.equal(f.store.records.size, 0);
  } finally { await f.cleanup(); }
});

test('quota and free-disk floor refuse new writes', async () => {
  const lowDisk = await fixture({ freeBytes: async () => 2 * GIB + 50, minFreeBytes: 2 * GIB });
  try {
    await assert.rejects(lowDisk.files.ingest({ source: chunks(MP4), maxBytes: 1_000, declaredBytes: 100, store: lowDisk.store, evidence: lowDisk.evidence }),
      (error: unknown) => error instanceof EvidenceFileError && error.status === 507 && /free disk space/.test(error.message));
    assert.equal((await lowDisk.files.ingest({ source: chunks(MP4), maxBytes: 1_000, declaredBytes: 32, store: lowDisk.store,
      evidence: lowDisk.evidence })).status, 'stored', 'fits above the floor');
  } finally { await lowDisk.cleanup(); }
  const quota = await fixture({ quotaBytes: 100 });
  try {
    await quota.files.ingest({ source: chunks(MP4, Buffer.alloc(40)), maxBytes: 1_000, store: quota.store, evidence: quota.evidence });
    // 72 bytes used: a declared 40 is refused up front, an undeclared 40 is refused while streaming.
    await assert.rejects(quota.files.ingest({ source: chunks(MP4), maxBytes: 1_000, declaredBytes: 40, store: quota.store, evidence: quota.evidence }),
      (error: unknown) => error instanceof EvidenceFileError && error.status === 507 && /quota/.test(error.message));
    await assert.rejects(quota.files.ingest({ source: chunks(MP4, Buffer.alloc(20)), maxBytes: 1_000, store: quota.store, evidence: quota.evidence }),
      (error: unknown) => error instanceof EvidenceFileError && error.status === 507);
    assert.equal(await quota.temps(), 0);
    assert.equal(quota.store.records.size, 1);
  } finally { await quota.cleanup(); }
});

test('playback tickets: 43-char base64url, expire after the TTL, die with the session, and are revocable', () => {
  let now = 1_000;
  let live = true;
  const tickets = new PlaybackTickets({ now: () => now, ttlMs: 15 * 60_000 });
  const record = { id: eventId, storagePath: `${eventId}/${eventId}.mp4`, mime: 'video/mp4' };
  const issued = tickets.issue(record, () => live);
  const ticket = issued.url.slice('/api/v1/media/'.length);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.expiresAtMs, 1_000 + 15 * 60_000);
  assert.notEqual(tickets.issue(record, () => live).url, issued.url, 'random per issue');
  assert.deepEqual(tickets.resolve(ticket), record);
  assert.equal(tickets.resolve('x'.repeat(43)), null);
  now += 15 * 60_000;
  assert.equal(tickets.resolve(ticket), null, 'expired at the TTL');
  now = 1_000;
  const second = tickets.issue(record, () => live).url.slice(14);
  live = false;
  assert.equal(tickets.resolve(second), null, 'session ended');
  live = true;
  assert.equal(tickets.resolve(second), null, 'an invalidated ticket stays dead');
  const third = tickets.issue(record, () => live).url.slice(14);
  tickets.revoke(eventId);
  assert.equal(tickets.resolve(third), null);
  const capped = new PlaybackTickets({ maxTickets: 2 });
  const a = capped.issue(record, () => true).url.slice(14);
  capped.issue(record, () => true);
  capped.issue(record, () => true);
  assert.equal(capped.size, 2);
  assert.equal(capped.resolve(a), null, 'oldest evicted at the cap');
});

test('quota: an upload that finishes during another upload counts against it', async () => {
  const f = await fixture({ quotaBytes: 150 });
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let consumed!: () => void;
    const firstChunkDone = new Promise<void>(resolve => { consumed = resolve; });
    async function* slow() { yield MP4; consumed(); await gate; yield Buffer.alloc(60); }
    // A starts first (32 bytes in flight), B lands 92 bytes, then A's remaining 60 would exceed 150.
    const first = f.files.ingest({ source: slow(), maxBytes: 1_000, store: f.store, evidence: f.evidence });
    await firstChunkDone;
    await f.files.ingest({ source: chunks(MP4, Buffer.alloc(60)), maxBytes: 1_000, store: f.store, evidence: f.evidence });
    release();
    await assert.rejects(first, (error: unknown) => error instanceof EvidenceFileError && error.status === 507);
    assert.equal(await f.temps(), 0);
  } finally { await f.cleanup(); }
});

test('quota account: recording bytes written beside an upload count against it; storageProblem sees uploads in flight', async () => {
  const f = await fixture({ quotaBytes: 150 });
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let consumed!: () => void;
    const firstChunkDone = new Promise<void>(resolve => { consumed = resolve; });
    // The generator resumes only after ingest() has counted and written the first chunk.
    async function* slow() { yield MP4; consumed(); await gate; yield Buffer.alloc(60); }
    const upload = f.files.ingest({ source: slow(), maxBytes: 1_000, store: f.store, evidence: f.evidence });
    await firstChunkDone;
    assert.equal(await f.files.storageProblem(100), null, '32 in flight + 100 fits');
    assert.match((await f.files.storageProblem(130)) ?? '', /quota/);
    f.files.noteWritten(90); // a voice recording grows to 90 bytes in the root
    release();
    await assert.rejects(upload, (error: unknown) => error instanceof EvidenceFileError && error.status === 507);
  } finally { await f.cleanup(); }
  const low = await fixture({ freeBytes: async () => 10, minFreeBytes: 100 });
  try { assert.match((await low.files.storageProblem()) ?? '', /free disk space/); } finally { await low.cleanup(); }
});
