import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MODERATION_LIMITS } from '@tcg-live/core';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../ops/errors.js';
import { describeVoicePool } from './pool.js';
import { offlineHelperApi } from './helper-api.js';
import { syntheticToken } from './testing.js';
import { MemoryVoiceBotRegistry, tokenUserId, validateBotToken, VoiceBotTokenStore } from './tokens.js';

test('token shape check decodes the public bot user ID and never echoes the token', () => {
  const token = syntheticToken();
  assert.equal(validateBotToken(` Bot ${token} `), token);
  assert.equal(tokenUserId(token), '123456789012345678');
  for (const bad of ['', 'abc', `${token}.extra`, `${Buffer.from('not-a-number').toString('base64url')}.AbCdEf.${'y'.repeat(38)}`, 42]) {
    assert.throws(() => validateBotToken(bad), (error: unknown) =>
      error instanceof OpsInputError && (typeof bad !== 'string' || bad === '' || !error.message.includes(bad)));
  }
});

test('file store writes 0600 via temp+rename, lists summaries only and keeps tokens out of errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tcg-voice-'));
  try {
    const file = path.join(directory, 'data', 'voice-bots.json');
    const store = new VoiceBotTokenStore(file, () => 42, offlineHelperApi());
    assert.deepEqual(await store.list(), []);
    const token = syntheticToken();
    const added = await store.add('Helper 1', token);
    assert.deepEqual(Object.keys(added).sort(), ['addedAtMs', 'applicationId', 'enabled', 'id', 'label', 'nickname', 'userId']);
    assert.equal(added.userId, '123456789012345678');
    assert.doesNotMatch(JSON.stringify(await store.list()), new RegExp(token.split('.')[2]!));
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(path.dirname(file))).filter(name => name.endsWith('.tmp')), []);
    assert.equal((await store.getTokens())[0]!.token, token, 'the voice runtime can read the secret');

    await assert.rejects(store.add('Again', token), (error: unknown) => error instanceof OpsConflictError && !error.message.includes(token));
    await assert.rejects(store.add('Same bot, rotated token', syntheticToken('123456789012345678', 'z')), OpsConflictError);
    await assert.rejects(store.add('', syntheticToken('223456789012345678')), OpsInputError);
    await assert.rejects(store.remove('11111111-1111-4111-8111-111111111111'), OpsNotFoundError);
    assert.equal((await store.remove(added.id)).id, added.id);
    assert.deepEqual(await store.list(), []);

    await writeFile(file, `{"version":1,"bots":[{"id":"bad","token":"${token}"}]}`);
    await assert.rejects(store.list(), (error: unknown) => error instanceof OpsConflictError && !error.message.includes(token));
    assert.match(await readFile(file, 'utf8'), /bad/, 'an invalid file is left for the operator, not overwritten by reads');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('memory registry enforces the helper limit; the pool lists main plus helpers without tokens', async () => {
  const registry = new MemoryVoiceBotRegistry(() => 1);
  for (let i = 0; i < MODERATION_LIMITS.voiceHelperBots; i++) await registry.add(`Helper ${i}`, syntheticToken(`1234567890123456${10 + i}`));
  await assert.rejects(registry.add('One too many', syntheticToken('923456789012345678')), OpsConflictError);
  const pool = describeVoicePool(await registry.list(), null, { userId: '999999999999999999' });
  assert.equal(pool.runtime, 'disabled');
  assert.equal(pool.bots.length, MODERATION_LIMITS.voiceHelperBots + 1);
  assert.deepEqual(pool.bots[0], { id: 'main', label: 'Main bot', kind: 'main', userId: '999999999999999999', addedAtMs: null,
    connected: false, assignedChannelId: null, assignedMatchId: null });
  assert.doesNotMatch(JSON.stringify(pool), /AbCdEf/);
  const live = describeVoicePool([], { bots: { main: { connected: true, assignedChannelId: '823456789012345678', assignedMatchId: 'M1' } },
    rooms: [{ matchId: 'M1', channelId: '823456789012345678', botId: 'main' }, { matchId: 'M2', channelId: '723456789012345678', botId: null }] });
  assert.equal(live.runtime, 'running');
  assert.equal(live.bots[0]!.connected, true);
  assert.equal(live.rooms[1]!.botId, null, 'a room without a free bot is reported as unmonitored');
});
