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
const staffMember = '400000000000000008';
const STAFF_ROLE = '500000000000000001';
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
    async adminToolsSettings() { return { cases: { staffRoleIds: [STAFF_ROLE] } } as never; },
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

test('/tcg-test evidence uses the match card rule: seated players, the organizer and tournament staff roles', async () => {
  const s = await setup();
  try {
    const saved = await s.submitter.submit(s.input({ userId: staffMember, roleIds: [STAFF_ROLE], attachment: null, link: 'https://youtu.be/x' }));
    assert.match(saved, /^Evidence saved for M1/);
    assert.equal(s.audit.entries.at(-1)!.actorKind, 'admin');
    assert.equal(s.audit.entries.at(-1)!.actorId, staffMember);
    // Another role, or no roles: refused.
    assert.match(await s.submitter.submit(s.input({ userId: staffMember, roleIds: ['500000000000000002'], attachment: null,
      link: 'https://youtu.be/y' })), /tournament staff/);
    assert.equal((await s.store.list(eventId, 'M1')).length, 1);
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

/** A submitter whose fetch answers from `respond`, with backoff waits recorded instead of slept. */
async function scripted(respond: (url: string, call: number) => Response | Promise<Response>) {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-evidence-discord-'));
  const store = new MemoryEvidenceStore(new MemoryOpsAuditStore());
  const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
  const waits: number[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    return respond(String(url), calls.length);
  }) as typeof fetch;
  const submitter = new EvidenceSubmitter({
    guildId, adminId, evidence: store,
    async matchRoom(matchId: MatchId) {
      return matchId === 'M1' ? { eventId, matchId, voiceChannelId: null, playerIds: [playerA, playerB] } : null;
    }
  }, { files: new EvidenceFiles({ root, freeBytes: async () => 1024 ** 4 }), fetch: fakeFetch, maxBytes: 1_000,
    sleep: async ms => { waits.push(ms); } });
  const input: EvidenceCommandInput = { guildId, userId: playerA, matchId: 'M1',
    attachment: { url: cdn, size: MP4.length, name: 'clip.mp4', contentType: 'video/mp4' }, link: null, note: null };
  return { store, calls, waits, submitter, input, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

test('attachment redirects are followed by hand, only to allow-listed Discord CDN hosts', async () => {
  const media = 'https://media.discordapp.net/attachments/1/2/clip.mp4?ex=1';
  const ok = await scripted(url => url === cdn ? redirect(media) : new Response(new Uint8Array(MP4)));
  try {
    assert.match(await ok.submitter.submit(ok.input), /^Evidence saved/);
    assert.deepEqual(ok.calls.map(call => [call.url, call.redirect]), [[cdn, 'manual'], [media, 'manual']]);
  } finally { await ok.cleanup(); }
  for (const target of ['https://evil.example/x.mp4', 'http://cdn.discordapp.com/x.mp4', 'https://user:pw@cdn.discordapp.com/x']) {
    const bad = await scripted(url => url === cdn ? redirect(target) : new Response(new Uint8Array(MP4)));
    try {
      assert.match(await bad.submitter.submit(bad.input), /redirected the attachment somewhere unexpected/, target);
      assert.equal(bad.calls.length, 1, 'the off-list host is never contacted');
      assert.equal(bad.store.records.size, 0);
    } finally { await bad.cleanup(); }
  }
  const loop = await scripted(() => redirect(cdn));
  try {
    assert.match(await loop.submitter.submit(loop.input), /unexpected/);
    assert.equal(loop.calls.length, 4, 'three redirects at most');
  } finally { await loop.cleanup(); }
});

test('5xx answers and network failures are retried twice with backoff; 4xx is not retried', async () => {
  const flaky = await scripted((_url, call) => {
    if (call === 1) throw new TypeError('fetch failed');
    if (call === 2) return new Response('busy', { status: 503 });
    return new Response(new Uint8Array(MP4));
  });
  try {
    assert.match(await flaky.submitter.submit(flaky.input), /^Evidence saved/);
    assert.equal(flaky.calls.length, 3);
    assert.deepEqual(flaky.waits, [1_000, 2_000]);
  } finally { await flaky.cleanup(); }
  const down = await scripted(() => new Response('down', { status: 502 }));
  try {
    assert.match(await down.submitter.submit(down.input), /did not provide the attachment/);
    assert.equal(down.calls.length, 3, 'one try and two retries');
    assert.equal(down.store.records.size, 0);
  } finally { await down.cleanup(); }
  const gone = await scripted(() => new Response('gone', { status: 404 }));
  try {
    assert.match(await gone.submitter.submit(gone.input), /did not provide the attachment/);
    assert.equal(gone.calls.length, 1);
    assert.deepEqual(gone.waits, []);
  } finally { await gone.cleanup(); }
});

test('the same clip submitted twice for one match is stored once', async () => {
  const s = await scripted(() => new Response(new Uint8Array(MP4)));
  try {
    assert.match(await s.submitter.submit(s.input), /^Evidence saved for M1: file \(/);
    assert.match(await s.submitter.submit({ ...s.input, userId: playerB }), /already submitted for this match/);
    assert.equal(s.store.records.size, 1);
  } finally { await s.cleanup(); }
});
