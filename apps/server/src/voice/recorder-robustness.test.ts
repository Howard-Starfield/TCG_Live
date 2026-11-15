import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryEvidenceStore, resolveEvidencePath } from '../evidence/store.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { OPUS_SILENCE_FRAME, PAGE_EOS, readOggPages } from './ogg-writer.js';
import { VoiceRecorder, type RecorderDeps, type RecorderIo } from './recorder.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const players = ['222222222222222222', '333333333333333333'];
const late = '444444444444444445';
const opus = Buffer.from([0xfc, 1, 2, 3, 4, 5]);
const target = (playerIds = players) => ({ eventId, matchId: 'M1', channelId: '555555555555555555', playerIds });

async function setup(extra: Partial<RecorderDeps> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-voice-r-'));
  const audit = new MemoryOpsAuditStore();
  const evidence = new MemoryEvidenceStore(audit);
  let now = 10_000;
  const logs: string[] = [];
  const make = (more: Partial<RecorderDeps> = {}) => new VoiceRecorder({ evidence, audit: input => audit.append(input), guildId: '444444444444444444',
    root: path.join(root, 'evidence'), journalFile: path.join(root, 'voice-recordings.json'), now: () => now, log: message => logs.push(message),
    ...extra, ...more });
  const file = async (id: string) => resolveEvidencePath((await evidence.get(id))!.storagePath!, path.join(root, 'evidence'));
  return { root, audit, evidence, make, file, logs, tick(ms: number) { now += ms; return now; }, get now() { return now; },
    kinds: () => audit.entries.map(entry => entry.kind), cleanup: () => rm(root, { recursive: true, force: true }).catch(() => {}) };
}

test('a write error on one track keeps its intact audio as partial (audited); the other track keeps recording', async () => {
  let failFd: number | null = null;
  const io: Partial<RecorderIo> = { writeSync: (fd, data, offset, length) => {
    if (fd === failFd) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return writeSync(fd, data, offset, length);
  } };
  const env = await setup({ io });
  try {
    const recorder = env.make();
    const session = await recorder.start(target());
    for (let index = 0; index < 120; index += 1) { const at = env.tick(20); session.write(players[0]!, opus, at); session.write(players[1]!, opus, at); }
    // Break player 0's file descriptor from now on: its next page write fails.
    const ids = session.evidenceIds;
    const fds = (session as unknown as { tracks: Array<{ userId: string; fd: number }> }).tracks;
    failFd = fds.find(track => track.userId === players[0])!.fd;
    for (let index = 0; index < 120; index += 1) { const at = env.tick(20); session.write(players[0]!, opus, at); session.write(players[1]!, opus, at); }
    assert.deepEqual(session.partialEvidenceIds, [ids.get(players[0]!)!]);
    const partialAudit = env.audit.entries.find(entry => entry.kind === 'voice.recording.partial')!;
    assert.equal(partialAudit.payload.evidenceId, ids.get(players[0]!));
    assert.ok((partialAudit.payload.savedDurationMs as number) >= 1_000, 'the intact pages before the error are kept');
    await session.stop('match resolved');
    const broken = (await env.evidence.get(ids.get(players[0]!)!))!;
    const healthy = (await env.evidence.get(ids.get(players[1]!)!))!;
    assert.equal(broken.status, 'stored');
    assert.equal(healthy.status, 'stored');
    assert.ok(broken.durationMs! >= 1_000 && broken.durationMs! < healthy.durationMs!);
    const data = readFileSync(await env.file(broken.id));
    assert.equal(readOggPages(data).validLength, data.length);
    assert.ok(readOggPages(data).pages.at(-1)!.flags & PAGE_EOS);
    assert.ok(healthy.durationMs! >= 4_500);
    const stop = env.audit.entries.find(entry => entry.kind === 'voice.recording.stop')!;
    assert.deepEqual(stop.payload.partialEvidenceIds, [broken.id]);
    assert.deepEqual(recorder.journalIds(), []);
  } finally { await env.cleanup(); }
});

test('an fsync error at stop stores the track as partial instead of failing it', async () => {
  const env = await setup({ io: { fsyncSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } } });
  try {
    const session = await env.make().start(target([players[0]!]));
    for (let index = 0; index < 120; index += 1) session.write(players[0]!, opus, env.tick(20));
    await session.stop();
    const record = (await env.evidence.get(session.evidenceIds.get(players[0]!)!))!;
    assert.equal(record.status, 'stored');
    assert.ok(record.durationMs! >= 1_000);
    assert.ok(env.kinds().includes('voice.recording.partial'));
  } finally { await env.cleanup(); }
});

test('a player seated mid-recording gets a new track aligned to the session start with silence', async () => {
  const env = await setup();
  try {
    const session = await env.make().start(target([players[0]!]));
    env.tick(3_000);
    const added = await session.addPlayer(late);
    assert.ok(added);
    assert.equal(await session.addPlayer(late), null, 'added once');
    assert.deepEqual(session.players().sort(), [players[0]!, late].sort());
    const row = (await env.evidence.get(added!))!;
    assert.equal(row.recordingStartedAtMs, 10_000, 'aligned to the session start');
    assert.equal(row.recordedUserId, late);
    for (let index = 0; index < 50; index += 1) session.write(late, opus, env.tick(20));
    await session.stop();
    const stored = (await env.evidence.get(added!))!;
    assert.equal(stored.status, 'stored');
    assert.ok(Math.abs(stored.durationMs! - 4_000) <= 120, `duration ${stored.durationMs}`);
    const packets = readOggPages(readFileSync(await env.file(added!))).pages.slice(2).flatMap(page => page.packets);
    assert.ok(packets.filter(item => item.equals(OPUS_SILENCE_FRAME)).length >= 140, 'silence before the late arrival');
    const starts = env.audit.entries.filter(entry => entry.kind === 'voice.recording.start');
    assert.equal(starts.length, 2);
    assert.equal(starts[1]!.payload.joinedAtOffsetMs, 3_000);
  } finally { await env.cleanup(); }
});

test('a clock jump is capped: no hours of silence, a gap is audited instead', async () => {
  const env = await setup({ maxFillMs: 2_000 });
  try {
    const session = await env.make().start(target([players[0]!]));
    session.write(players[0]!, opus, env.tick(20));
    session.write(players[0]!, opus, env.tick(3 * 60 * 60_000));
    await new Promise(resolve => setImmediate(resolve));
    const gap = env.audit.entries.find(entry => entry.kind === 'voice.recording.gap')!;
    assert.equal(gap.payload.reason, 'clock');
    assert.ok((gap.payload.durationMs as number) > 60 * 60_000);
    await session.stop();
    const record = (await env.evidence.get(session.evidenceIds.get(players[0]!)!))!;
    assert.ok(record.durationMs! < 10_000, `duration ${record.durationMs}`);
    assert.ok(statSync(await env.file(record.id)).size < 50_000);
  } finally { await env.cleanup(); }
});

test('journal: EPERM on rename is retried; a corrupt journal is kept as .corrupt and recovery falls back to pending database rows', async () => {
  let refusals = 2;
  const env = await setup({ io: { rename: async (from, to) => {
    if (refusals > 0) { refusals -= 1; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }
    await rename(from, to);
  } } });
  try {
    const recorder = env.make({ pendingVoiceRows: async () => [...env.evidence.records.values()]
      .filter(record => record.status === 'pending' && record.kind === 'voice' && record.source === 'bot')
      .map(record => ({ id: record.id, eventId: record.eventId, matchId: record.matchId, storagePath: record.storagePath, createdAtMs: 0 })) });
    const session = await recorder.start(target());
    await recorder.journalSettled();
    assert.equal(refusals, 0);
    assert.equal(recorder.journalIds().length, 2, 'journaled after the retries');
    for (let index = 0; index < 120; index += 1) session.write(players[0]!, opus, env.tick(20));
    // An active recording is never touched by a periodic recovery.
    assert.deepEqual(await recorder.recover(), { stored: 0, failed: 0 });
    assert.equal(recorder.journalIds().length, 2);
    // The process "dies"; its journal is corrupted.
    writeFileSync(path.join(env.root, 'voice-recordings.json'), '{"version":1,"entr');
    const fresh = env.make({ pendingVoiceRows: async () => [...env.evidence.records.values()]
      .filter(record => record.status === 'pending')
      .map(record => ({ id: record.id, eventId: record.eventId, matchId: record.matchId, storagePath: record.storagePath, createdAtMs: 0 })) });
    const result = await fresh.recover();
    assert.deepEqual(result, { stored: 2, failed: 0 }, 'both files kept their intact pages');
    assert.ok(existsSync(path.join(env.root, 'voice-recordings.json.corrupt')));
    for (const id of session.evidenceIds.values()) assert.notEqual((await env.evidence.get(id))!.status, 'pending');
  } finally { await env.cleanup(); }
});

test('stopAll stops every recording in parallel within the budget', async () => {
  const env = await setup();
  try {
    const recorder = env.make();
    await recorder.start(target([players[0]!]));
    await recorder.start({ ...target([players[1]!]), matchId: 'M2' });
    assert.equal(recorder.activeCount, 2);
    await recorder.stopAll('shutdown', 2_000);
    assert.equal(recorder.activeCount, 0);
    assert.equal(env.audit.entries.filter(entry => entry.kind === 'voice.recording.stop').length, 2);
  } finally { await env.cleanup(); }
});

