import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MatchId } from '@tcg-live/core';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { EvidenceSubmitter, type EvidenceCommandInput } from './discord-submit.js';
import { EvidenceFiles } from './files.js';
import { MemoryEvidenceStore } from './store.js';

const eventId = '11111111-1111-4111-8111-111111111111';
const guildId = '100000000000000001';
const adminId = '200000000000000001';
const playerA = '300000000000000001';
const playerB = '300000000000000002';
const stranger = '400000000000000009';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const cdn = 'https://cdn.discordapp.com/attachments/1/2/clip.mp4';

async function setup(body: Buffer = MP4, maxBytes = 1_000) {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-evidence-discord-'));
  const audit = new MemoryOpsAuditStore();
  const store = new MemoryEvidenceStore(audit);
  const fetched: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    return new Response(new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
  const submitter = new EvidenceSubmitter({
    guildId, adminId, evidence: store,
    async matchRoom(matchId: MatchId) {
      return matchId === 'M1' ? { eventId, matchId, voiceChannelId: null, playerIds: [playerA, playerB] } : null;
    }
  }, { files: new EvidenceFiles({ root, freeBytes: async () => 1024 ** 4 }), fetch: fakeFetch, maxBytes });
  const input = (patch: Partial<EvidenceCommandInput> = {}): EvidenceCommandInput => ({ guildId, userId: playerA, matchId: 'm1',
    attachment: { url: cdn, size: body.length, name: 'clip.mp4', contentType: 'video/mp4' }, link: null, note: 'turn 3', ...patch });
  return { root, audit, store, fetched, submitter, input, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('seated players and the organizer can submit files and links; the file goes through the shared pipeline', async () => {
  const s = await setup();
  try {
    const reply = await s.submitter.submit(s.input());
    assert.match(reply, /^Evidence saved for M1: file/);
    assert.deepEqual(s.fetched, [cdn]);
    const [item] = await s.store.list(eventId, 'M1');
    assert.equal(item!.source, 'discord');
    assert.equal(item!.submittedBy, playerA);
    assert.equal(item!.originalName, 'clip.mp4');
    assert.equal(item!.status, 'stored');
    assert.equal(s.audit.entries.at(-1)!.actorKind, 'player');
    assert.match(await s.submitter.submit(s.input({ userId: playerB, attachment: null, link: 'https://youtu.be/abc' })), /link/);
    assert.match(await s.submitter.submit(s.input({ userId: adminId, attachment: null, link: 'https://medal.tv/x' })), /^Evidence saved/);
    assert.equal(s.audit.entries.at(-1)!.actorKind, 'admin');
    assert.equal((await s.store.list(eventId, 'M1')).length, 3);
  } finally { await s.cleanup(); }
});

test('non-participants, other servers, unknown matches and bad links are refused without storing anything', async () => {
  const s = await setup();
  try {
    assert.match(await s.submitter.submit(s.input({ userId: stranger })), /Only the two players/);
    assert.match(await s.submitter.submit(s.input({ guildId: '100000000000000002' })), /tournament server/);
    assert.match(await s.submitter.submit(s.input({ matchId: 'M2' })), /not a match in the current round/);
    assert.match(await s.submitter.submit(s.input({ matchId: '../M1' })), /for example M1/);
    assert.match(await s.submitter.submit(s.input({ attachment: null })), /Attach a file/);
    assert.match(await s.submitter.submit(s.input({ attachment: null, link: 'http://insecure.example/x' })), /https/);
    assert.match(await s.submitter.submit(s.input({ attachment: { url: 'https://evil.example/x.mp4', size: 10, name: 'x', contentType: null } })),
      /not valid/);
    assert.deepEqual(s.fetched, []);
    assert.equal(s.store.records.size, 0);
  } finally { await s.cleanup(); }
});

test('oversize attachments are refused before download, and a lying size is caught while streaming', async () => {
  const s = await setup(Buffer.concat([MP4, Buffer.alloc(2_000)]), 1_000);
  try {
    assert.match(await s.submitter.submit(s.input({ attachment: { url: cdn, size: 5_000, name: 'big.mp4', contentType: 'video/mp4' } })),
      /at most/);
    assert.deepEqual(s.fetched, [], 'never downloaded');
    assert.match(await s.submitter.submit(s.input({ attachment: { url: cdn, size: 10, name: 'lie.mp4', contentType: 'video/mp4' } })),
      /at most/);
    assert.deepEqual(await readdir(path.join(s.root, '.tmp')), []);
    assert.equal(s.store.records.size, 0);
  } finally { await s.cleanup(); }
});
