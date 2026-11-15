import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryEvidenceStore, resolveEvidencePath } from '../evidence/store.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { OPUS_SILENCE_FRAME, PAGE_EOS, readOggPages } from './ogg-writer.js';
import { RecordingStorageError, shouldRecord, VoiceRecorder, type RecorderStorage } from './recorder.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const players = ['222222222222222222', '333333333333333333'];
const opus = Buffer.from([0xfc, 1, 2, 3, 4, 5]);

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-voice-'));
  const audit = new MemoryOpsAuditStore();
  const evidence = new MemoryEvidenceStore(audit);
  let now = 10_000;
  const make = () => new VoiceRecorder({ evidence, audit: input => audit.append(input), guildId: '444444444444444444',
    root: path.join(root, 'evidence'), journalFile: path.join(root, 'voice-recordings.json'), now: () => now });
  return { root, audit, evidence, make, tick(ms: number) { now += ms; return now; }, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}) };
}

test('recording modes: off never, judge-call only with a call, always always', () => {
  assert.deepEqual([shouldRecord('off', true), shouldRecord('judge-call', false), shouldRecord('judge-call', true), shouldRecord('always', false)],
    [false, false, true, true]);
});

test('lifecycle: one pending voice row per player, Ogg files at the store path, stored with size, sha256 and duration on stop', async () => {
  const env = await setup();
  try {
    const recorder = env.make();
    const session = await recorder.start({ eventId, matchId: 'M1', channelId: '555555555555555555', playerIds: players });
    const ids = session.evidenceIds;
    assert.equal(ids.size, 2);
    for (const id of ids.values()) {
      const record = await env.evidence.get(id);
      assert.deepEqual([record!.kind, record!.source, record!.submittedBy, record!.status], ['voice', 'bot', 'bot', 'pending']);
      assert.equal(record!.recordingStartedAtMs, 10_000);
    }
    for (const [userId, id] of ids) assert.equal((await env.evidence.get(id))!.recordedUserId, userId);
    assert.deepEqual(recorder.journalIds().sort(), [...ids.values()].sort());
    for (let index = 0; index < 10; index += 1) session.write(players[0]!, opus, env.tick(20));
    session.write('999999999999999999', opus, env.tick(0)); // not a recorded player: ignored
    assert.equal(session.offsetMs(10_100), 100);
    env.tick(300);
    await session.stop('match resolved');
    for (const [userId, id] of ids) {
      const record = (await env.evidence.get(id))!;
      assert.equal(record.status, 'stored');
      const file = resolveEvidencePath(record.storagePath!, path.join(env.root, 'evidence'));
      const data = readFileSync(file);
      assert.equal(record.byteSize, data.length);
      assert.equal(record.sha256, createHash('sha256').update(data).digest('hex'));
      assert.equal(record.mime, 'audio/ogg');
      const { pages, validLength } = readOggPages(data);
      assert.equal(validLength, data.length);
      assert.ok(pages.at(-1)!.flags & PAGE_EOS);
      // Both tracks run from start to stop (500 ms of wall-clock), so they stay aligned side by side.
      assert.ok(Math.abs(record.durationMs! - 500) <= 120, `${userId} duration ${record.durationMs}`);
      const packets = pages.slice(2).flatMap(page => page.packets);
      if (userId === players[0]) assert.equal(packets.filter(item => item.equals(opus)).length, 10);
      else assert.ok(packets.every(item => item.equals(OPUS_SILENCE_FRAME)));
    }
    assert.deepEqual(recorder.journalIds(), []);
    const kinds = env.audit.entries.map(entry => entry.kind);
    assert.ok(kinds.includes('voice.recording.start') && kinds.includes('voice.recording.stop'));
    const stop = env.audit.entries.find(entry => entry.kind === 'voice.recording.stop')!;
    assert.equal(stop.payload.reason, 'match resolved');
  } finally { await env.cleanup(); }
});

test('crash recovery: an interrupted file is finalized from its intact prefix; one without headers is marked failed', async () => {
  const env = await setup();
  try {
    const crashed = env.make();
    const session = await crashed.start({ eventId, matchId: 'M2', channelId: '555555555555555555', playerIds: players });
    for (let index = 0; index < 120; index += 1) session.write(players[0]!, opus, env.tick(20)); // > 1 s: pages flushed
    const [first, second] = [...session.evidenceIds.values()];
    const root = path.join(env.root, 'evidence');
    const firstFile = resolveEvidencePath((await env.evidence.get(first!))!.storagePath!, root);
    const secondFile = resolveEvidencePath((await env.evidence.get(second!))!.storagePath!, root);
    appendFileSync(firstFile, Buffer.from('OggS\0garbage-partial-page'));
    writeFileSync(secondFile, Buffer.from('OggS')); // headers lost
    // The process "dies" here: no stop(). A new recorder recovers on start.
    const result = await env.make().recover();
    assert.deepEqual(result, { stored: 1, failed: 1 });
    const stored = (await env.evidence.get(first!))!;
    assert.equal(stored.status, 'stored');
    const data = readFileSync(firstFile);
    const parsed = readOggPages(data);
    assert.equal(parsed.validLength, data.length, 'the partial tail was cut');
    assert.ok(parsed.pages.at(-1)!.flags & PAGE_EOS);
    assert.ok(stored.durationMs! >= 1_000);
    assert.equal(stored.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal((await env.evidence.get(second!))!.status, 'failed');
    assert.equal(existsSync(secondFile), false);
    assert.deepEqual(env.make().journalIds(), []);
  } finally { await env.cleanup(); }
});

test('storage: no start below the quota or free-disk floor; a full disk mid-recording stops it cleanly, audited and announced', async () => {
  const env = await setup();
  try {
    let problem: string | null = 'Not enough free disk space.';
    let written = 0;
    const storage: RecorderStorage = { async storageProblem() { return problem; }, noteWritten(bytes) { written += bytes; } };
    const notices: string[] = [];
    const recorder = new VoiceRecorder({ evidence: env.evidence, audit: input => env.audit.append(input), guildId: '444444444444444444',
      root: path.join(env.root, 'evidence'), journalFile: path.join(env.root, 'voice-recordings.json'), storage,
      notify: async text => { notices.push(text); } });
    const target = { eventId, matchId: 'M3', channelId: '555555555555555555', playerIds: players };
    await assert.rejects(recorder.start(target), RecordingStorageError);
    await assert.rejects(recorder.start(target), RecordingStorageError);
    assert.equal(env.evidence.records.size, 0, 'no row is reserved when refused');
    const storageAudits = () => env.audit.entries.filter(entry => entry.kind === 'voice.recording.stopped_storage');
    assert.equal(storageAudits().length, 1, 'a refusal streak is audited once');
    assert.equal(storageAudits()[0]!.payload.phase, 'not_started');
    assert.equal(notices.length, 1);

    problem = null;
    const session = await recorder.start(target);
    assert.ok(written > 0, 'header pages count against the shared quota account');
    for (let index = 0; index < 60; index += 1) session.write(players[0]!, opus, 10_000 + index * 20);
    assert.equal(await recorder.checkStorage(session), false, 'room left: keeps recording');
    problem = 'The evidence storage quota is full.';
    assert.equal(await recorder.checkStorage(session), true);
    assert.equal(session.active, false);
    for (const id of session.evidenceIds.values()) assert.equal((await env.evidence.get(id))!.status, 'stored', 'what was written is finalized');
    const stopped = storageAudits().at(-1)!;
    assert.equal(stopped.payload.phase, 'stopped');
    assert.deepEqual([...(stopped.payload.evidenceIds as string[])].sort(), [...session.evidenceIds.values()].sort());
    assert.equal(env.audit.entries.find(entry => entry.kind === 'voice.recording.stop')!.payload.reason, 'storage');
    assert.equal(notices.length, 2);
    assert.match(notices[1]!, /M3 stopped/);
    assert.equal(recorder.activeCount, 0, 'no recording (and so no periodic check) is left');
  } finally { await env.cleanup(); }
});
