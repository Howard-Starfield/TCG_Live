import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MODERATION_SETTINGS } from '@tcg-live/core';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { MemoryOpsAuditStore, type OpsAuditStore } from '../ops/audit.js';
import { MemoryVoiceBotRegistry } from '../voice/tokens.js';
import { syntheticToken } from '../voice/testing.js';
import { MemoryModerationFlagStore } from './flags.js';
import type { ModerationRouteOptions } from './routes.js';
import { MemoryModerationSettingsStore } from './settings.js';

const guild = '123456789012345678';

function moderation(overrides: Partial<ModerationRouteOptions> = {}, audit: OpsAuditStore = new MemoryOpsAuditStore()) {
  const options: ModerationRouteOptions = {
    settings: new MemoryModerationSettingsStore(audit), flags: new MemoryModerationFlagStore(audit), audit,
    voiceBots: new MemoryVoiceBotRegistry(), guildId: () => guild, ...overrides
  };
  return options;
}
const json = (body: unknown) => JSON.stringify(body);

test('moderation routes need a session and the moderation.manage capability', async () => {
  const harness = await startHarness({ moderation: moderation() }, { capabilities: ['dashboard.read'] });
  try {
    assert.equal((await call(harness.port, '/api/v1/moderation/settings')).status, 401);
    const token = await login(harness);
    const session = (await call(harness.port, '/api/v1/session', { token })).json();
    assert.equal(session.moderation, true);
    for (const [method, path] of [['GET', '/api/v1/moderation/settings'], ['PUT', '/api/v1/moderation/settings'],
      ['GET', '/api/v1/moderation/flags'], ['GET', '/api/v1/moderation/voice-bots'], ['POST', '/api/v1/moderation/voice-bots'],
      ['POST', '/api/v1/moderation/automod/sync'], ['GET', '/api/v1/ops/audit']] as const) {
      const reply = await call(harness.port, path, { method, token, ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(reply.status, 403, `${method} ${path}`);
    }
  } finally { await harness.stop(); }
});

test('settings round-trip with optimistic versions; a stale save answers 409 with the current settings', async () => {
  const options = moderation();
  let notified = 0;
  options.onSettingsSaved = () => { notified++; throw Error('listener failure must not fail the save'); };
  const harness = await startHarness({ moderation: options });
  try {
    const token = await login(harness);
    const initial = (await call(harness.port, '/api/v1/moderation/settings', { token })).json();
    assert.equal(initial.version, 0);
    assert.equal(initial.guildId, guild);
    const settings = structuredClone(DEFAULT_MODERATION_SETTINGS);
    settings.retention.days = 7;
    const saved = await call(harness.port, '/api/v1/moderation/settings', { method: 'PUT', token, body: json({ expectedVersion: 0, settings }) });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json().version, 1);
    assert.equal(saved.json().retention.days, 7);
    assert.equal(notified, 1);
    const stale = await call(harness.port, '/api/v1/moderation/settings', { method: 'PUT', token, body: json({ expectedVersion: 0, settings }) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json().error.code, 'conflict');
    assert.equal(stale.json().current.version, 1);
    const invalid = await call(harness.port, '/api/v1/moderation/settings', { method: 'PUT', token,
      body: json({ expectedVersion: 1, settings: { ...settings, recording: { mode: 'video' } } }) });
    assert.equal(invalid.status, 400);
    assert.equal((await call(harness.port, '/api/v1/moderation/settings', { method: 'PUT', token, body: json({ settings }) })).status, 400);
    const audit = (await call(harness.port, '/api/v1/ops/audit', { token })).json();
    assert.deepEqual(audit.entries.map((entry: { kind: string }) => entry.kind), ['moderation.settings']);
  } finally { await harness.stop(); }
});

test('helper voice bots: the token is accepted, never echoed or audited, and removable', async () => {
  const audit = new MemoryOpsAuditStore();
  const options = moderation({}, audit);
  let changes = 0;
  options.onVoiceBotsChanged = () => { changes++; };
  const harness = await startHarness({ moderation: options });
  try {
    const token = await login(harness);
    const secret = syntheticToken();
    const secretPart = secret.split('.')[2]!;
    const added = await call(harness.port, '/api/v1/moderation/voice-bots', { method: 'POST', token, body: json({ label: 'Helper A', token: secret }) });
    assert.equal(added.status, 201, added.text);
    assert.doesNotMatch(added.text, new RegExp(secretPart));
    const pool = added.json();
    assert.deepEqual(pool.bots.map((bot: { kind: string }) => bot.kind), ['main', 'helper']);
    assert.equal(pool.runtime, 'disabled');
    const duplicate = await call(harness.port, '/api/v1/moderation/voice-bots', { method: 'POST', token, body: json({ label: 'Again', token: secret }) });
    assert.equal(duplicate.status, 409);
    assert.doesNotMatch(duplicate.text, new RegExp(secretPart));
    const malformed = await call(harness.port, '/api/v1/moderation/voice-bots', { method: 'POST', token, body: json({ label: 'Bad', token: 'oops-secret-value' }) });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(malformed.text, /oops-secret-value/);
    const listed = await call(harness.port, '/api/v1/moderation/voice-bots', { token });
    assert.doesNotMatch(listed.text, new RegExp(secretPart));
    const helperId = pool.bots[1].id;
    assert.equal((await call(harness.port, `/api/v1/moderation/voice-bots/${helperId}`, { method: 'DELETE', token })).status, 200);
    assert.equal((await call(harness.port, `/api/v1/moderation/voice-bots/${helperId}`, { method: 'DELETE', token })).status, 404);
    assert.equal(changes, 2);
    const auditText = (await call(harness.port, '/api/v1/ops/audit', { token })).text;
    assert.doesNotMatch(auditText, new RegExp(secretPart));
    assert.deepEqual(audit.entries.map(entry => entry.kind), ['moderation.voice_bot.added', 'moderation.voice_bot.removed']);
  } finally { await harness.stop(); }
});

test('an add that cannot be audited is undone; unset guild, flags paging and the AutoMod seam', async () => {
  const failing: OpsAuditStore = { append: async () => { throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }); },
    list: async () => ({ entries: [], nextAfter: 0 }) };
  const registry = new MemoryVoiceBotRegistry();
  const flagsAudit = new MemoryOpsAuditStore();
  const flags = new MemoryModerationFlagStore(flagsAudit);
  let guildId: string | null = null;
  const harness = await startHarness({ moderation: moderation({ voiceBots: registry, flags, guildId: () => guildId }, failing) });
  try {
    const token = await login(harness);
    const added = await call(harness.port, '/api/v1/moderation/voice-bots', { method: 'POST', token, body: json({ label: 'H', token: syntheticToken() }) });
    assert.equal(added.status, 503);
    assert.deepEqual(await registry.list(), []);
    assert.equal((await call(harness.port, '/api/v1/moderation/settings', { token })).status, 503);
    guildId = guild;
    await flags.append({ kind: 'volume', guildId: guild, detail: { peakDbfs: -1, rmsDbfs: -3, sustainedMs: 400, thresholdDbfs: -8 } });
    await flags.append({ kind: 'volume', guildId: guild, detail: { peakDbfs: -1, rmsDbfs: -3, sustainedMs: 400, thresholdDbfs: -8 } });
    const page = (await call(harness.port, '/api/v1/moderation/flags?limit=1', { token })).json();
    assert.deepEqual([page.flags.length, page.nextAfter], [1, 1]);
    assert.equal((await call(harness.port, `/api/v1/moderation/flags?after=${page.nextAfter}`, { token })).json().flags[0].id, 2);
    assert.equal((await call(harness.port, '/api/v1/moderation/flags?limit=0', { token })).status, 400);
    assert.equal((await call(harness.port, '/api/v1/moderation/flags?cursor=1', { token })).status, 400);
    const sync = await call(harness.port, '/api/v1/moderation/automod/sync', { method: 'POST', token });
    assert.equal(sync.status, 501);
  } finally { await harness.stop(); }
});

test("the main bot's own token is refused as a helper, without echoing it", async () => {
  const registry = new MemoryVoiceBotRegistry();
  const mainUser = '223456789012345678';
  const harness = await startHarness({ moderation: moderation({ voiceBots: registry, mainBotUserId: () => mainUser }) });
  try {
    const token = await login(harness);
    const secret = syntheticToken(mainUser, 'q');
    const refused = await call(harness.port, '/api/v1/moderation/voice-bots', { method: 'POST', token, body: json({ label: 'Main', token: secret }) });
    assert.equal(refused.status, 409);
    assert.doesNotMatch(refused.text, new RegExp(secret.split('.')[2]!));
    assert.deepEqual(await registry.list(), []);
  } finally { await harness.stop(); }
});

test('flags filter by eventId and matchId; malformed filters are 400', async () => {
  const flagsAudit = new MemoryOpsAuditStore();
  const flags = new MemoryModerationFlagStore(flagsAudit);
  const eventA = '11111111-1111-4111-8111-111111111111';
  const eventB = '22222222-2222-4222-8222-222222222222';
  const detail = { peakDbfs: -1, rmsDbfs: -3, sustainedMs: 400, thresholdDbfs: -8 };
  await flags.append({ kind: 'volume', guildId: guild, eventId: eventA, matchId: 'M1', detail });
  await flags.append({ kind: 'volume', guildId: guild, eventId: eventA, matchId: 'M2', detail });
  await flags.append({ kind: 'volume', guildId: guild, eventId: eventB, matchId: 'M1', detail });
  const harness = await startHarness({ moderation: moderation({ flags }) });
  try {
    const token = await login(harness);
    const ids = async (query: string) => (await call(harness.port, `/api/v1/moderation/flags${query}`, { token })).json().flags
      .map((flag: { id: number }) => flag.id);
    assert.deepEqual(await ids(''), [1, 2, 3]);
    assert.deepEqual(await ids(`?eventId=${eventA}`), [1, 2]);
    assert.deepEqual(await ids('?matchId=M1'), [1, 3]);
    assert.deepEqual(await ids(`?eventId=${eventA.toUpperCase()}&matchId=M2`), [2]);
    for (const bad of ['?eventId=nope', '?matchId=M0', '?matchId=x', `?eventId=${eventA}&eventId=${eventB}`])
      assert.equal((await call(harness.port, `/api/v1/moderation/flags${bad}`, { token })).status, 400, bad);
  } finally { await harness.stop(); }
});

test('PATCH /moderation/flags/:id acknowledges, dismisses and reopens a flag, audited; bad input is 400/404', async () => {
  const audit = new MemoryOpsAuditStore();
  const flags = new MemoryModerationFlagStore(audit);
  await flags.append({ kind: 'keyword', guildId: guild, detail: { ruleId: null, ruleName: 'Slurs', action: 'block', matchedKeyword: 'x', matchedContent: null } });
  const harness = await startHarness({ moderation: moderation({ flags, audit }, audit) });
  try {
    const token = await login(harness);
    const patch = (id: string, body: unknown) => call(harness.port, `/api/v1/moderation/flags/${id}`, { method: 'PATCH', token, body: json(body) });
    const acked = await patch('1', { state: 'acknowledged' });
    assert.equal(acked.status, 200, acked.text);
    assert.equal(acked.json().review.state, 'acknowledged');
    assert.equal(acked.json().review.by, 'local-admin');
    assert.equal((await patch('1', { state: 'dismissed' })).json().review.state, 'dismissed');
    assert.equal((await patch('1', { state: null })).json().review, null);
    const listed = (await call(harness.port, '/api/v1/moderation/flags', { token })).json().flags[0];
    assert.equal(listed.review, null);
    const kinds = (await audit.list({ after: 0, limit: 100, eventId: null })).entries.map(entry => entry.kind);
    assert.equal(kinds.filter(kind => kind === 'moderation.flag.reviewed').length, 3);
    assert.equal((await patch('1', { state: 'maybe' })).status, 400);
    assert.equal((await patch('1', { state: 'dismissed', extra: 1 })).status, 400);
    assert.equal((await patch('9', { state: 'dismissed' })).status, 404);
  } finally { await harness.stop(); }
});
