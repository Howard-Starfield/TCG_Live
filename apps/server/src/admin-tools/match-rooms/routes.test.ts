import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATCH_ROOM_DEFAULT_TEMPLATE, type CleanupPlanDto, type CleanupResultDto, type MatchRoomDto, type MatchRoomsDto,
  type MatchRoomTranscriptDto, type MatchRoomTranscriptSummaryDto, type SaveMatchRoomSettingsRequestDto } from '@tcg-live/core';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { call, login, startHarness, type Harness } from '../../admin/http/test-support.js';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';
import { RuleError } from '../../rehearsal/domain.js';
import { createDemoGuild } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { attachMatchRoomService, currentMatchRoomService, type MatchRoomService } from './service-port.js';
import { matchRoomsRouteModule } from './routes.js';

const BASE = '/api/v1/admin-tools/match-rooms';
const id = (n: number) => `5000000000000${String(n).padStart(5, '0')}`;
const TRANSCRIPT = '11111111-2222-4333-8444-555555555555';

const room = (channelId: string, table: number, patch: Partial<MatchRoomDto> = {}): MatchRoomDto => ({ channelId, table, categoryId: null,
  origin: 'created', name: `🎮 M${table}`, missing: false, customName: null, templateName: `🎮 M${table}`, pendingName: null,
  rename: { state: 'synced', nextAttemptAtMs: null, error: null }, assignedMatch: null, connected: null, recording: null,
  removeBlockedReason: null, ...patch });

function described(version = 1): MatchRoomsDto {
  return { guildId: DEMO_GUILD_ID, storage: 'memory', canManageChannels: true, problem: null, activeEventId: null, eventName: null,
    gameLabel: null, round: 1, freeChannelSlots: 400,
    settings: { version, template: MATCH_ROOM_DEFAULT_TEMPLATE, categoryId: null, categoryName: null, pendingCategoryName: null,
      baselineChannelIds: [], baselineCapturedAtMs: null },
    categories: [], rooms: [room(id(1), 1)], baseline: [] };
}

/** A hand-made service: records every call, and refuses what the test tells it to. */
function fakeService() {
  const calls: Array<[string, ...unknown[]]> = [];
  let version = 1;
  let fail: Error | null = null;
  const plan: CleanupPlanDto = { eventId: null, transcriptsToArchive: 2, planToken: 'token-1',
    items: [{ channelId: id(1), name: '🎮 M1', kind: 'room', action: 'delete', reason: 'Created by the bot' }] };
  let currentToken = 'token-1';
  const guard = () => { if (fail) throw fail; };
  const service: MatchRoomService = {
    async describe() { calls.push(['describe']); guard(); return described(version); },
    async saveSettings(req: SaveMatchRoomSettingsRequestDto) {
      calls.push(['saveSettings', req]); guard();
      if (req.expectedVersion !== version) throw new OpsConflictError('The room settings changed; reload and try again.');
      version += 1;
      return { ...described(version), settings: { ...described(version).settings, template: req.template, categoryId: req.categoryId,
        baselineChannelIds: req.baselineChannelIds } };
    },
    async setCustomName(channelId, customName) { calls.push(['setCustomName', channelId, customName]); guard();
      return room(channelId, 1, { customName, pendingName: customName }); },
    async ensureTables(count) { calls.push(['ensureTables', count]); guard();
      return { created: count > 1 ? [id(2), id(3)] : [], rooms: described(version) }; },
    async adopt(channelId) { calls.push(['adopt', channelId]); guard(); return room(channelId, 4, { origin: 'adopted' }); },
    async forget(channelId) { calls.push(['forget', channelId]); guard(); },
    async cleanupPlan() { calls.push(['cleanupPlan']); guard(); return { ...plan, planToken: currentToken }; },
    async cleanupConfirm(token, actor): Promise<CleanupResultDto> {
      calls.push(['cleanupConfirm', token, actor]); guard();
      if (token !== currentToken) throw new RuleError('The rooms changed; review again.');
      return { deleted: [id(1)], restored: [id(9)], skipped: [{ channelId: id(5), reason: 'Occupied' }], archived: 2 };
    },
    async transcripts(eventId, matchId) { calls.push(['transcripts', eventId, matchId]); guard(); return [summary()]; },
    async transcript(transcriptId) { calls.push(['transcript', transcriptId]); guard();
      if (transcriptId !== TRANSCRIPT) throw new OpsNotFoundError('That transcript does not exist.');
      return { ...summary(), messages: [] }; },
    async setTranscriptHold(transcriptId, hold) { calls.push(['setTranscriptHold', transcriptId, hold]); guard(); }
  };
  return { service, calls, staleToken() { currentToken = 'token-2'; }, failWith(error: Error | null) { fail = error; } };
}

function summary(): MatchRoomTranscriptSummaryDto {
  return { id: TRANSCRIPT, eventId: 'event-1', matchId: 'M1', channelId: id(1), channelName: '🎮 M1', startedAtMs: 1, archivedAtMs: 2,
    reason: 'reassigned', messageCount: 0, contentAvailable: false, skippedOld: 0, hold: false };
}

function options(service: MatchRoomService | null): AdminToolsRouteOptions {
  const audit = new MemoryOpsAuditStore();
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [matchRoomsRouteModule({ service })] };
}

async function withHarness(service: MatchRoomService | null, run: (request: (suffix: string, method?: string, payload?: unknown) =>
  ReturnType<typeof call>, adminTools: AdminToolsRouteOptions) => Promise<void>, capabilities?: Array<'dashboard.read' | 'members.read' | 'server.manage'>) {
  const adminTools = options(service);
  const harness: Harness = await startHarness({ adminTools }, capabilities ? { capabilities } : {});
  try {
    const token = await login(harness);
    await run((suffix, method = 'GET', payload) => call(harness.port, `${BASE}${suffix}`,
      { method, token, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), adminTools);
  } finally { await harness.stop(); }
}

const kinds = async (adminTools: AdminToolsRouteOptions) => (await adminTools.audit.list()).entries.map(entry => entry.kind);

test('with no service attached every route answers 503 and nothing is audited', async () => {
  await withHarness(null, async (request, adminTools) => {
    for (const [method, suffix, payload] of [['GET', ''], ['PUT', '/settings', { expectedVersion: 1, template: '{match}', categoryId: null,
      createCategory: null, baselineChannelIds: [] }], ['PATCH', `/rooms/${id(1)}`, { customName: null }], ['DELETE', `/rooms/${id(1)}`],
    ['POST', '/ensure', { tables: 2 }], ['POST', '/adopt', { channelId: id(1) }], ['GET', '/cleanup'], ['POST', '/cleanup', { planToken: 'x' }],
    ['GET', '/transcripts?eventId=e'], ['GET', `/transcripts/${TRANSCRIPT}`], ['PATCH', `/transcripts/${TRANSCRIPT}`, { hold: true }]] as const) {
      const reply = await request(suffix, method, payload);
      assert.equal(reply.status, 503, `${method} ${suffix}`);
      assert.match(reply.text, /Rooms are available once the bot is connected/);
    }
    assert.deepEqual(await kinds(adminTools), []);
  });
});

test('without an override the route uses the service the runtime attached, read on every request', async () => {
  const fake = fakeService();
  const adminTools: AdminToolsRouteOptions = { ...options(null), modules: [matchRoomsRouteModule()] };
  const harness = await startHarness({ adminTools });
  try {
    const token = await login(harness);
    assert.equal(currentMatchRoomService(), null);
    assert.equal((await call(harness.port, BASE, { token })).status, 503);
    attachMatchRoomService(fake.service);
    assert.equal((await call(harness.port, BASE, { token })).status, 200);
  } finally { attachMatchRoomService(null); await harness.stop(); }
});

test('reads need members.read and changes need server.manage', async () => {
  const fake = fakeService();
  await withHarness(fake.service, async request => {
    assert.equal((await request('')).status, 200);
    assert.equal((await request('/cleanup')).status, 200);
    assert.equal((await request('/transcripts?eventId=e')).status, 200);
    for (const [method, suffix, payload] of [['PUT', '/settings', { expectedVersion: 1, template: '{match}', categoryId: null,
      createCategory: null, baselineChannelIds: [] }], ['PATCH', `/rooms/${id(1)}`, { customName: null }], ['DELETE', `/rooms/${id(1)}`],
    ['POST', '/ensure', { tables: 2 }], ['POST', '/adopt', { channelId: id(1) }], ['POST', '/cleanup', { planToken: 'x' }],
    ['PATCH', `/transcripts/${TRANSCRIPT}`, { hold: true }]] as const) {
      assert.equal((await request(suffix, method, payload)).status, 403, `${method} ${suffix}`);
    }
    assert.deepEqual(fake.calls.filter(([name]) => !['describe', 'cleanupPlan', 'transcripts'].includes(name)), [], 'no change reached the service');
  }, ['dashboard.read', 'members.read']);
  await withHarness(fake.service, async request => {
    assert.equal((await request('')).status, 403);
    assert.equal((await request('/cleanup')).status, 403);
    assert.equal((await request('/transcripts?eventId=e')).status, 403);
  }, ['dashboard.read']);
});

test('settings: validated, saved with the version, a stale version is 409, and the change is audited', async () => {
  const fake = fakeService();
  await withHarness(fake.service, async (request, adminTools) => {
    const body = { expectedVersion: 1, template: '{table} · {round}', categoryId: id(7), createCategory: null, baselineChannelIds: [id(8), id(8), id(9)] };
    const saved = await request('/settings', 'PUT', body);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json().settings.version, 2);
    assert.deepEqual(fake.calls.at(-1), ['saveSettings', { ...body, baselineChannelIds: [id(8), id(9)] }], 'duplicates are dropped');
    const stale = await request('/settings', 'PUT', body);
    assert.equal(stale.status, 409);
    assert.match(stale.text, /changed/);
    assert.deepEqual(await kinds(adminTools), ['match_rooms.settings'], 'a refused save is not audited');

    const bad = (patch: Record<string, unknown>) => request('/settings', 'PUT', { ...body, expectedVersion: 2, ...patch });
    assert.equal((await bad({ template: 'no token here' })).status, 400);
    assert.equal((await bad({ template: '{stage} {match}' })).status, 400);
    assert.equal((await bad({ template: 5 })).status, 400);
    assert.equal((await bad({ expectedVersion: 'two' })).status, 400);
    assert.equal((await bad({ categoryId: 'abc' })).status, 400);
    assert.equal((await bad({ createCategory: 'New category' })).status, 400, 'a category and a new one together');
    assert.equal((await bad({ categoryId: null, createCategory: ' ' })).status, 400);
    assert.equal((await bad({ categoryId: null, createCategory: 'x'.repeat(101) })).status, 400);
    assert.equal((await bad({ baselineChannelIds: 'all' })).status, 400);
    assert.equal((await bad({ baselineChannelIds: ['1'] })).status, 400);
    assert.equal((await bad({ baselineChannelIds: Array.from({ length: 601 }, (_, n) => id(n + 1)) })).status, 400);
    assert.equal((await bad({ extra: true })).status, 400);
    const created = await bad({ categoryId: null, createCategory: ' TCG Live — Matches ' });
    assert.equal(created.status, 200, created.text);
    assert.equal((fake.calls.at(-1)![1] as SaveMatchRoomSettingsRequestDto).createCategory, 'TCG Live — Matches');
    assert.deepEqual(await kinds(adminTools), ['match_rooms.settings', 'match_rooms.settings']);
  });
});

test('a room can be renamed, returned to the template and forgotten; each change is audited', async () => {
  const fake = fakeService();
  await withHarness(fake.service, async (request, adminTools) => {
    const renamed = await request(`/rooms/${id(1)}`, 'PATCH', { customName: '  Feature table  ' });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.json().customName, 'Feature table');
    assert.deepEqual(fake.calls.at(-1), ['setCustomName', id(1), 'Feature table']);
    assert.equal((await request(`/rooms/${id(1)}`, 'PATCH', { customName: null })).status, 200);
    assert.deepEqual(fake.calls.at(-1), ['setCustomName', id(1), null], 'null means use the template');
    for (const payload of [{}, { customName: '' }, { customName: '   ' }, { customName: 5 }, { customName: 'x'.repeat(101) },
      { customName: 'two\nlines' }, { customName: 'ok', extra: 1 }])
      assert.equal((await request(`/rooms/${id(1)}`, 'PATCH', payload)).status, 400, JSON.stringify(payload));
    assert.equal((await request('/rooms/not-an-id', 'PATCH', { customName: null })).status, 400);
    assert.equal((await request(`/rooms/${id(1)}`, 'DELETE')).status, 200);
    assert.deepEqual(fake.calls.at(-1), ['forget', id(1)]);
    assert.equal((await request('/rooms/abc', 'DELETE')).status, 400);
    assert.deepEqual(await kinds(adminTools), ['match_rooms.renamed', 'match_rooms.renamed', 'match_rooms.forgotten']);
    const audit = (await adminTools.audit.list()).entries;
    assert.deepEqual(audit[0]!.payload, { channelId: id(1), customName: 'Feature table' });
  });
});

test('ensure creates missing tables, adopt takes an existing voice channel; bodies are validated', async () => {
  const fake = fakeService();
  await withHarness(fake.service, async (request, adminTools) => {
    const ensured = await request('/ensure', 'POST', { tables: 3 });
    assert.equal(ensured.status, 200, ensured.text);
    assert.deepEqual(ensured.json().created, [id(2), id(3)]);
    assert.equal((await request('/ensure', 'POST', { tables: 1 })).status, 200);
    for (const payload of [{}, { tables: 0 }, { tables: 501 }, { tables: 2.5 }, { tables: '3' }, { tables: 3, extra: 1 }])
      assert.equal((await request('/ensure', 'POST', payload)).status, 400, JSON.stringify(payload));
    const adopted = await request('/adopt', 'POST', { channelId: id(4) });
    assert.equal(adopted.status, 200, adopted.text);
    assert.equal(adopted.json().origin, 'adopted');
    for (const payload of [{}, { channelId: 'x' }, { channelId: id(4), extra: 1 }])
      assert.equal((await request('/adopt', 'POST', payload)).status, 400, JSON.stringify(payload));
    assert.deepEqual(await kinds(adminTools), ['match_rooms.created', 'match_rooms.adopted'], 'ensuring nothing new is not a change');
  });
});

test('service refusals map to HTTP: a rule is 409, bad input 400, unknown 404, and a refused change is not audited', async () => {
  const fake = fakeService();
  await withHarness(fake.service, async (request, adminTools) => {
    fake.failWith(new RuleError('Only 12 server channels are free.'));
    const rule = await request('/ensure', 'POST', { tables: 40 });
    assert.equal(rule.status, 409);
    assert.match(rule.text, /Only 12 server channels are free/);
    fake.failWith(new OpsInputError('That channel is not a voice room.'));
    assert.equal((await request('/adopt', 'POST', { channelId: id(4) })).status, 400);
    fake.failWith(new OpsNotFoundError('That room does not exist.'));
    assert.equal((await request(`/rooms/${id(4)}`, 'DELETE')).status, 404);
    fake.failWith(new RuleError('That room is in use.'));
    assert.equal((await request(`/rooms/${id(4)}`, 'DELETE')).status, 409);
    assert.equal((await request('')).status, 409, 'reads map the same way');
    assert.deepEqual(await kinds(adminTools), []);
    fake.failWith(null);
    assert.equal((await request('')).status, 200);
  });
});

test('clean-up needs the plan token: the preview carries it, the confirm sends it back, a stale one is refused', async () => {
  const fake = fakeService();
  await withHarness(fake.service, async (request, adminTools) => {
    const plan = (await request('/cleanup')).json() as CleanupPlanDto;
    assert.equal(plan.planToken, 'token-1');
    assert.deepEqual(fake.calls.filter(([name]) => name === 'cleanupConfirm'), [], 'a preview deletes nothing');
    for (const payload of [{}, { planToken: '' }, { planToken: 5 }, { planToken: 'x'.repeat(257) }, { planToken: 'a', extra: 1 }])
      assert.equal((await request('/cleanup', 'POST', payload)).status, 400, JSON.stringify(payload));
    assert.equal((await request('/cleanup', 'POST')).status, 400, 'an empty body');
    fake.staleToken();
    const stale = await request('/cleanup', 'POST', { planToken: plan.planToken });
    assert.equal(stale.status, 409);
    assert.match(stale.text, /review again/);
    assert.deepEqual(await kinds(adminTools), [], 'nothing was cleaned up, nothing is audited');
    const fresh = (await request('/cleanup')).json() as CleanupPlanDto;
    assert.equal(fresh.planToken, 'token-2');
    const done = await request('/cleanup', 'POST', { planToken: fresh.planToken });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(done.json(), { deleted: [id(1)], restored: [id(9)], skipped: [{ channelId: id(5), reason: 'Occupied' }], archived: 2 });
    assert.deepEqual(fake.calls.filter(([name]) => name === 'cleanupConfirm').at(-1), ['cleanupConfirm', 'token-2', { kind: 'admin', id: 'local-admin' }], 'the requester goes with the confirm');
    // The service (executeCleanup) writes the summary row; the route adds none of its own.
    assert.deepEqual(await kinds(adminTools), []);
  });
});

test('transcripts: list by event and match, read one, hold or release it', async () => {
  const fake = fakeService();
  await withHarness(fake.service, async (request, adminTools) => {
    assert.equal((await request('/transcripts?eventId=event-1')).json()[0].id, TRANSCRIPT);
    assert.deepEqual(fake.calls.at(-1), ['transcripts', 'event-1', undefined]);
    await request('/transcripts?eventId=event-1&matchId=M12');
    assert.deepEqual(fake.calls.at(-1), ['transcripts', 'event-1', 'M12']);
    for (const suffix of ['/transcripts', '/transcripts?eventId=', '/transcripts?eventId=e&matchId=Mx', '/transcripts?eventId=e&matchId=M0',
      '/transcripts?eventId=e&other=1', '/transcripts?eventId=a&eventId=b'])
      assert.equal((await request(suffix)).status, 400, suffix);
    assert.equal((await request(`/transcripts/${TRANSCRIPT}`)).status, 200);
    assert.equal((await request('/transcripts/not-a-uuid')).status, 400);
    assert.equal((await request('/transcripts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).status, 404);
    assert.equal((await request(`/transcripts/${TRANSCRIPT}`, 'PATCH', { hold: true })).status, 200);
    assert.deepEqual(fake.calls.at(-1), ['setTranscriptHold', TRANSCRIPT, true]);
    assert.equal((await request(`/transcripts/${TRANSCRIPT}`, 'PATCH', { hold: 'yes' })).status, 400);
    assert.equal((await request(`/transcripts/${TRANSCRIPT}`, 'PATCH', {})).status, 400);
    assert.equal((await request('/transcripts/not-a-uuid', 'PATCH', { hold: true })).status, 400);
    assert.deepEqual(await kinds(adminTools), ['match_rooms.transcript']);
  });
});

test('every audit kind the routes write is a declared one', async () => {
  const { ADMIN_TOOLS_AUDIT_KINDS } = await import('@tcg-live/core');
  for (const kind of ['match_rooms.settings', 'match_rooms.renamed', 'match_rooms.created', 'match_rooms.adopted', 'match_rooms.forgotten',
    'match_rooms.cleanup', 'match_rooms.transcript']) assert.ok((ADMIN_TOOLS_AUDIT_KINDS as readonly string[]).includes(kind), kind);
});
