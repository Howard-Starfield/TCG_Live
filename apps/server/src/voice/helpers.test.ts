import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { OpsConflictError, OpsInputError } from '../ops/errors.js';
import { requirement, permissionBits, voiceHelperInviteBits } from '../permissions/table.js';
import { discordHelperApi, offlineHelperApi, type HelperDiscordApi } from './helper-api.js';
import { describeVoicePool, helperInviteUrl } from './pool.js';
import { syntheticToken } from './testing.js';
import { MemoryVoiceBotRegistry, validateBotNickname, VoiceBotTokenStore } from './tokens.js';

const guild = '900000000000000001';
const BOT_USER = '123456789012345678';

test('invite bits come from the voice.rooms requirement: View Channel and Connect only', () => {
  assert.equal(voiceHelperInviteBits(), permissionBits(requirement('voice.rooms').permissions));
  assert.equal(voiceHelperInviteBits(), PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect);
  assert.equal(voiceHelperInviteBits() & PermissionFlagsBits.Speak, 0n, 'helpers never speak');
  const url = helperInviteUrl('111111111111111111', guild);
  assert.match(url, /client_id=111111111111111111/);
  assert.match(url, new RegExp(`permissions=${voiceHelperInviteBits()}&`));
  assert.match(url, /scope=bot&/);
  assert.match(url, /guild_id=900000000000000001&disable_guild_select=true/);
});

test('a v1 file is read as v2 (enabled, no application or nickname) and written as v2 on the next save', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tcg-helpers-'));
  try {
    const file = path.join(directory, 'voice-bots.json');
    const token = syntheticToken();
    await writeFile(file, JSON.stringify({ version: 1, bots: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Old', token, addedAtMs: 5 }] }));
    const store = new VoiceBotTokenStore(file, () => 42, offlineHelperApi());
    assert.deepEqual(await store.list(), [{ id: '11111111-1111-4111-8111-111111111111', label: 'Old', userId: BOT_USER, addedAtMs: 5,
      applicationId: null, enabled: true, nickname: null }]);
    await store.update('11111111-1111-4111-8111-111111111111', { enabled: false, nickname: 'TCG Recorder 2' });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.bots[0].enabled, false);
    assert.equal(saved.bots[0].nickname, 'TCG Recorder 2');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('add stores the application ID; an invalid token is refused; replaceToken accepts only the same bot', async () => {
  let invalid = false;
  const api: HelperDiscordApi = { ...offlineHelperApi(), async probe(token) {
    if (invalid) return { ok: false, code: 'invalid-token' };
    return offlineHelperApi().probe(token);
  } };
  const registry = new MemoryVoiceBotRegistry(() => 1, api);
  const added = await registry.add('Helper', syntheticToken());
  assert.equal(added.applicationId, BOT_USER);
  await assert.rejects(registry.replaceToken(added.id, syntheticToken('223456789012345678')),
    (error: unknown) => error instanceof OpsConflictError && /different bot/.test(error.message));
  const rotated = syntheticToken(BOT_USER, 'r');
  await registry.replaceToken(added.id, rotated);
  assert.equal((await registry.getTokens())[0]!.token, rotated);
  invalid = true;
  await assert.rejects(registry.add('Bad', syntheticToken('323456789012345678')), OpsInputError);
  await assert.rejects(registry.replaceToken(added.id, syntheticToken(BOT_USER, 'q')), OpsInputError);
  assert.throws(() => validateBotNickname('@everyone'), OpsInputError);
  assert.throws(() => validateBotNickname('My Discord bot'), OpsInputError);
  assert.equal(validateBotNickname('  '), null);
  const pool = describeVoicePool(await registry.list(), null, { userId: null }, guild);
  assert.match(pool.bots[1]!.inviteUrl!, /client_id=123456789012345678/);
  assert.doesNotMatch(JSON.stringify(pool), /AbCdEf/);
});

test('verify against a fake Discord: membership, per-room permissions, broad grants and Public Bot, never the token', async () => {
  const token = syntheticToken();
  const roomOk = '700000000000000001';
  const roomDenied = '700000000000000002';
  const roomHidden = '700000000000000003';
  const role = '800000000000000001';
  const seen: string[] = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const route = String(url).replace('https://discord.com/api/v10', '');
    seen.push(`${init?.method} ${route}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bot ${token}`);
    const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
    if (route === '/applications/@me') return reply(200, { id: '111111111111111111', bot_public: true, bot_require_code_grant: false });
    if (route === `/guilds/${guild}/members/${BOT_USER}`) return reply(200, { roles: [role], nick: 'TCG Recorder 2' });
    if (route === `/guilds/${guild}/roles`) return reply(200, [{ id: guild, permissions: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect) },
      { id: role, permissions: String(PermissionFlagsBits.ManageGuild) }]);
    if (route === `/channels/${roomOk}`) return reply(200, { permission_overwrites: [] });
    if (route === `/channels/${roomDenied}`) return reply(200, { permission_overwrites: [{ id: guild, type: 0, allow: '0', deny: String(PermissionFlagsBits.Connect) }] });
    if (route === `/channels/${roomHidden}`) return reply(403, { message: 'Missing Access' });
    return reply(404);
  }) as typeof fetch;
  const registry = new MemoryVoiceBotRegistry(() => 7, discordHelperApi(fetcher));
  const bot = await registry.add('Helper', token);
  const report = await registry.verify(bot.id, guild, [roomOk, roomDenied, roomHidden]);
  assert.equal(report.tokenValid, true);
  assert.equal(report.inServer, true);
  assert.equal(report.nickname, 'TCG Recorder 2');
  assert.deepEqual(report.channels.map(channel => [channel.channelId, channel.state]), [[roomOk, 'ok'], [roomDenied, 'problem'], [roomHidden, 'problem']]);
  assert.ok(report.warnings.some(text => /Public Bot/.test(text)));
  assert.ok(report.warnings.some(text => /Manage Server/.test(text)));
  assert.match(report.problems[0]!, /2 match rooms/);
  assert.equal((await registry.list())[0]!.applicationId, '111111111111111111', 'verify stores the application ID');
  for (const secret of [token, token.split('.')[2]!]) assert.ok(!JSON.stringify(report).includes(secret));

  const notMember = new MemoryVoiceBotRegistry(() => 7, discordHelperApi((async (url: string | URL) =>
    String(url).endsWith('/applications/@me') ? new Response(JSON.stringify({ id: '111111111111111111' }), { status: 200 })
      : new Response(null, { status: 404 })) as typeof fetch));
  const other = await notMember.add('Helper', token);
  const missing = await notMember.verify(other.id, guild, [roomOk]);
  assert.equal(missing.inServer, false);
  assert.equal(missing.errorCode, 'not-in-server');

  const offline = new MemoryVoiceBotRegistry(() => 7, discordHelperApi((async () => { throw Object.assign(new TypeError('fetch failed'), { cause: token }); }) as typeof fetch));
  const added = await offline.add('Helper', token);
  assert.equal(added.applicationId, null, 'a network failure does not block adding');
  const down = await offline.verify(added.id, guild, []);
  assert.equal(down.errorCode, 'network');
  assert.ok(!JSON.stringify(down).includes(token));
});
