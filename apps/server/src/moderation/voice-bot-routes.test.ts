import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_VOICE_ROOM_POLICY } from '@tcg-live/core';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { MemoryOpsAuditStore, LOCAL_ADMIN } from '../ops/audit.js';
import { MemoryVoiceBotRegistry } from '../voice/tokens.js';
import { syntheticToken } from '../voice/testing.js';
import { MemoryModerationFlagStore } from './flags.js';
import type { ModerationRouteOptions } from './routes.js';
import { MemoryModerationSettingsStore } from './settings.js';

const guild = '123456789012345678';
const json = (body: unknown) => JSON.stringify(body);

function setup() {
  const audit = new MemoryOpsAuditStore();
  const settings = new MemoryModerationSettingsStore(audit);
  const retried: string[] = [];
  let running = true;
  let changed = 0;
  const options: ModerationRouteOptions = { settings, flags: new MemoryModerationFlagStore(audit), audit,
    voiceBots: new MemoryVoiceBotRegistry(), guildId: () => guild, onVoiceBotsChanged: () => { changed++; },
    voiceControl: { get running() { return running; }, async retryBot(id) { retried.push(id); return true; } } };
  return { options, audit, settings, retried, set running(value: boolean) { running = value; }, get changed() { return changed; } };
}

test('helper routes: patch, rotate token, verify, retry; every change audited; the token is never answered or audited', async () => {
  const env = setup();
  const harness = await startHarness({ moderation: env.options });
  try {
    const session = await login(harness);
    const token = syntheticToken('223456789012345678');
    const added = await call(harness.port, '/api/v1/moderation/voice-bots', { method: 'POST', token: session, body: json({ label: 'Helper 1', token }) });
    assert.equal(added.status, 201, added.text);
    const helper = added.json().bots[1];
    assert.equal(helper.enabled, true);
    assert.match(helper.inviteUrl, /client_id=223456789012345678&scope=bot&permissions=1049600&guild_id=123456789012345678/);
    const base = `/api/v1/moderation/voice-bots/${helper.id}`;

    const patched = await call(harness.port, base, { method: 'PATCH', token: session, body: json({ enabled: false, nickname: 'TCG Recorder 2' }) });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json().bots[1].enabled, false);
    assert.equal(patched.json().bots[1].nickname, 'TCG Recorder 2');
    assert.equal(env.changed, 2, 'the runtime reloads after add and after enable/nickname changes');
    assert.equal((await call(harness.port, base, { method: 'PATCH', token: session, body: json({ nope: 1 }) })).status, 400);
    assert.equal((await call(harness.port, base, { method: 'PATCH', token: session, body: json({ nickname: '@here' }) })).status, 400);

    const other = await call(harness.port, `${base}/token`, { method: 'PUT', token: session, body: json({ token: syntheticToken('323456789012345678') }) });
    assert.equal(other.status, 409);
    const rotated = syntheticToken('223456789012345678', 'r');
    assert.equal((await call(harness.port, `${base}/token`, { method: 'PUT', token: session, body: json({ token: rotated }) })).status, 200);

    const verify = await call(harness.port, `${base}/verify`, { method: 'POST', token: session, body: json({ channelIds: ['700000000000000001'] }) });
    assert.equal(verify.status, 200, verify.text);
    assert.equal(verify.json().inServer, true);
    assert.equal(verify.json().channels[0].state, 'ok');
    assert.equal((await call(harness.port, `${base}/verify`, { method: 'POST', token: session, body: json({ channelIds: ['x'] }) })).status, 400);

    assert.equal((await call(harness.port, `${base}/retry`, { method: 'POST', token: session })).status, 200);
    assert.equal((await call(harness.port, '/api/v1/moderation/voice-bots/main/retry', { method: 'POST', token: session })).status, 200);
    assert.deepEqual(env.retried, [helper.id, 'main']);
    env.running = false;
    assert.equal((await call(harness.port, `${base}/retry`, { method: 'POST', token: session })).status, 409);

    const updates = env.audit.entries.filter(entry => entry.kind === 'moderation.voice_bot.updated');
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0]!.payload.changed, ['enabled', 'nickname']);
    assert.deepEqual(updates[1]!.payload.changed, ['credential']);
    const everything = JSON.stringify(env.audit.entries) + added.text + patched.text + verify.text;
    for (const secret of [token, rotated, token.split('.')[2]!, rotated.split('.')[2]!]) assert.ok(!everything.includes(secret));
  } finally { await harness.stop(); }
});

test('deleting a helper removes its room pins; room settings validate and save through the versioned settings', async () => {
  const env = setup();
  const harness = await startHarness({ moderation: env.options });
  try {
    const session = await login(harness);
    const added = (await call(harness.port, '/api/v1/moderation/voice-bots', { method: 'POST', token: session,
      body: json({ label: 'Helper', token: syntheticToken('223456789012345678') }) })).json().bots[1];
    const current = await env.settings.get(guild);
    const { guildId: _g, version, updatedAtMs: _u, ...body } = current;
    const rooms = { '700000000000000001': { ...DEFAULT_VOICE_ROOM_POLICY, pinnedBotId: added.id, priority: 'high' } };
    const saved = await call(harness.port, '/api/v1/moderation/settings', { method: 'PUT', token: session,
      body: json({ expectedVersion: version, settings: { ...body, voice: { ...body.voice, rooms } } }) });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json().voice.rooms['700000000000000001'].priority, 'high');
    const bad = await call(harness.port, '/api/v1/moderation/settings', { method: 'PUT', token: session,
      body: json({ expectedVersion: saved.json().version, settings: { ...body, voice: { ...body.voice, rooms: { notasnowflake: DEFAULT_VOICE_ROOM_POLICY } } } }) });
    assert.equal(bad.status, 400);
    const stale = await call(harness.port, '/api/v1/moderation/settings', { method: 'PUT', token: session,
      body: json({ expectedVersion: version, settings: { ...body, voice: { ...body.voice, rooms } } }) });
    assert.equal(stale.status, 409);
    assert.equal((await call(harness.port, `/api/v1/moderation/voice-bots/${added.id}`, { method: 'DELETE', token: session })).status, 200);
    assert.equal((await env.settings.get(guild)).voice.rooms!['700000000000000001']!.pinnedBotId, null);
  } finally { await harness.stop(); }
});

test('recording opt-outs: list, add, remove; audited; also callable for the Discord command', async () => {
  const env = setup();
  const harness = await startHarness({ moderation: env.options });
  try {
    const session = await login(harness);
    const player = '600000000000000009';
    const add = await call(harness.port, '/api/v1/moderation/recording-opt-outs', { method: 'POST', token: session, body: json({ userId: player, optedOut: true }) });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(add.json().userIds, [player]);
    assert.deepEqual((await call(harness.port, '/api/v1/moderation/recording-opt-outs', { token: session })).json().userIds, [player]);
    assert.deepEqual((await env.settings.get(guild)).recording.optOutUserIds, [player]);
    const remove = await call(harness.port, '/api/v1/moderation/recording-opt-outs', { method: 'POST', token: session, body: json({ userId: player, optedOut: false }) });
    assert.deepEqual(remove.json().userIds, []);
    assert.equal((await call(harness.port, '/api/v1/moderation/recording-opt-outs', { method: 'POST', token: session, body: json({ userId: 'x', optedOut: true }) })).status, 400);
    const audits = env.audit.entries.filter(entry => entry.kind === 'voice.recording.opt_out');
    assert.deepEqual(audits.map(entry => [entry.payload.userId, entry.payload.optedOut, entry.actorId]), [[player, true, LOCAL_ADMIN.id], [player, false, LOCAL_ADMIN.id]]);
    const settingsAudit = env.audit.entries.filter(entry => entry.kind === 'moderation.settings').at(-1)!;
    assert.deepEqual(settingsAudit.payload.optOut, { added: [], removed: [player] });
  } finally { await harness.stop(); }
});
