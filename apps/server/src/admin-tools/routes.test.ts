import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type EventSnapshotDto } from '@tcg-live/core';
import { liveDispute } from '@tcg-live/core/fixtures';
import { sendJson } from '../admin/http/respond.js';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { demoOpsOptions, DEMO_GUILD_ID } from '../admin/demo.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { ADMIN_TOOLS_TABLES } from '../rehearsal/schema-tables.js';
import { createDemoGuild, DEMO_CHANNEL_IDS, DEMO_ROLE_IDS } from './demo-guild.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from './module.js';
import { adminToolsRouteModules } from './route-registry.js';
import { adminToolsRoutes, membersFromSnapshot, type AdminToolsRouteOptions } from './routes.js';
import { ADMIN_TOOLS_MIGRATION } from './schema.js';
import { MemoryAdminToolsSettingsStore } from './settings.js';
import { AdminToolsRuntimeState } from './status.js';

const json = (body: unknown) => JSON.stringify(body);
const defaults = () => structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;

function adminTools(overrides: Partial<AdminToolsRouteOptions> = {}): AdminToolsRouteOptions {
  const audit = new MemoryOpsAuditStore();
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID), modules: [], ...overrides };
}

test('migration 013 creates exactly the guarded admin tools tables and bigserial sequences', async () => {
  const sql = await readFile(ADMIN_TOOLS_MIGRATION, 'utf8');
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+) \(([\s\S]*?)\n\);/g)];
  const names = tables.map(match => match[1]!);
  const sequences = tables.filter(match => /^\s+id bigserial/m.test(match[2]!)).map(match => `${match[1]}_id_seq`);
  assert.deepEqual([...names, ...sequences].sort(), [...ADMIN_TOOLS_TABLES].sort());
  assert.doesNotMatch(sql, /CREATE TABLE (?!IF NOT EXISTS)|CREATE INDEX (?!IF NOT EXISTS)|CREATE UNIQUE INDEX (?!IF NOT EXISTS)|DROP /);
});

test('admin tools routes need a session and the matching capability', async () => {
  const harness = await startHarness({ adminTools: adminTools() }, { capabilities: ['dashboard.read'] });
  try {
    assert.equal((await call(harness.port, '/api/v1/admin-tools/settings')).status, 401);
    const token = await login(harness);
    assert.equal((await call(harness.port, '/api/v1/session', { token })).json().adminTools, true);
    for (const [method, path] of [['GET', '/api/v1/admin-tools/settings'], ['PUT', '/api/v1/admin-tools/settings'],
      ['GET', '/api/v1/admin-tools/status'], ['GET', '/api/v1/admin-tools/guild']] as const) {
      const reply = await call(harness.port, path, { method, token, ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(reply.status, 403, `${method} ${path}`);
    }
  } finally { await harness.stop(); }
  // members.read may read but not save settings.
  const reader = await startHarness({ adminTools: adminTools() }, { capabilities: ['dashboard.read', 'members.read'] });
  try {
    const token = await login(reader);
    assert.equal((await call(reader.port, '/api/v1/admin-tools/settings', { token })).status, 200);
    const put = await call(reader.port, '/api/v1/admin-tools/settings', { method: 'PUT', token, body: json({ expectedVersion: 0, settings: defaults() }) });
    assert.equal(put.status, 403);
  } finally { await reader.stop(); }
});

test('settings round-trip with optimistic versions, strict validation, reserved channels and an audit row', async () => {
  const options = adminTools();
  const saved: number[] = [];
  options.onSettingsSaved = settings => { saved.push(settings.version); throw Error('listener failure must not fail the save'); };
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const initial = (await call(harness.port, '/api/v1/admin-tools/settings', { token })).json();
    assert.equal(initial.version, 0);
    assert.equal(initial.guildId, DEMO_GUILD_ID);
    const settings = defaults();
    settings.logging.joinLeave = { enabled: true, channelId: DEMO_CHANNEL_IDS.modLog, newAccountDays: 3, memberUpdates: true };
    const put = (body: unknown) => call(harness.port, '/api/v1/admin-tools/settings', { method: 'PUT', token, body: json(body) });
    const first = await put({ expectedVersion: 0, settings });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json().version, 1);
    assert.deepEqual(saved, [1]);
    const stale = await put({ expectedVersion: 0, settings });
    assert.equal(stale.status, 409);
    assert.equal(stale.json().error.code, 'conflict');
    assert.equal(stale.json().current.version, 1);
    assert.equal(stale.json().current.logging.joinLeave.newAccountDays, 3);

    const unknownField = await put({ expectedVersion: 1, settings: { ...settings, extra: true } });
    assert.equal(unknownField.status, 400);
    const noChannel = defaults();
    noChannel.logging.welcome.enabled = true;
    assert.match((await put({ expectedVersion: 1, settings: noChannel })).json().error.message, /welcome/i);
    const reserved = defaults();
    reserved.tickets = { ...reserved.tickets, enabled: true, supportChannelId: DEMO_CHANNEL_IDS.signup, categoryId: DEMO_CHANNEL_IDS.tickets,
      staffRoleIds: [DEMO_ROLE_IDS.judge] };
    const clash = await put({ expectedVersion: 1, settings: reserved });
    assert.equal(clash.status, 400);
    assert.match(clash.json().error.message, /signup channel/);
    reserved.tickets.supportChannelId = DEMO_CHANNEL_IDS.support;
    assert.equal((await put({ expectedVersion: 1, settings: reserved })).status, 200);

    const audit = await options.audit.list({ limit: 50 });
    assert.deepEqual(audit.entries.map(entry => [entry.kind, entry.payload.sections]),
      [['admin_tools.settings', ['logging']], ['admin_tools.settings', ['tickets', 'logging']]]);
  } finally { await harness.stop(); }
});

test('status and guild metadata are demoable, and the demo mounts admin tools', async () => {
  const harness = await startHarness(demoOpsOptions());
  try {
    const token = await login(harness);
    const status = (await call(harness.port, '/api/v1/admin-tools/status', { token })).json();
    assert.equal(status.runtime, 'demo');
    assert.deepEqual(status.privilegedIntents, { guildMembers: 'off', messageContent: 'off' });
    const guild = (await call(harness.port, '/api/v1/admin-tools/guild', { token })).json();
    assert.equal(guild.guildId, DEMO_GUILD_ID);
    assert.ok(guild.roles.length > 3);
    assert.equal(guild.channels.find((channel: { id: string }) => channel.id === DEMO_CHANNEL_IDS.signup).reserved, true);
    // Saving a message log turns on MessageContent in the demo status.
    const settings = defaults();
    settings.logging.messageLog.enabled = true;
    const put = await call(harness.port, '/api/v1/admin-tools/settings', { method: 'PUT', token, body: json({ expectedVersion: 0, settings }) });
    assert.equal(put.status, 200, put.text);
    const after = (await call(harness.port, '/api/v1/admin-tools/status', { token })).json();
    assert.deepEqual(after.privilegedIntents, { guildMembers: 'off', messageContent: 'on' });
    assert.equal(after.wantedIntents.messageContent, true);
  } finally { await harness.stop(); }
});

test('route modules mount under /api/v1/admin-tools/ with shared deps, notify and audit', async () => {
  let captured: AdminToolsRouteDeps | undefined;
  const changed: Array<[string, string | null]> = [];
  const module: AdminToolsRouteModule = { name: 'probe', routes: deps => {
    captured = deps;
    return [{ pattern: /^\/api\/v1\/admin-tools\/probe$/, methods: {
      POST: { access: 'members.moderate', run: async ({ response }) => {
        await deps.recordAudit('channel.lock', { channelId: DEMO_CHANNEL_IDS.general });
        deps.notify('probe', 'x');
        sendJson(response, 200, { reserved: [...await deps.reservedChannelIds()].sort(), demo: deps.demo?.members.length });
      } }
    } }];
  } };
  const options = adminTools({ modules: [module], onChanged: (area, id) => { changed.push([area, id]); },
    reservedChannelIds: async () => ['123456789012345678'] });
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const reply = await call(harness.port, '/api/v1/admin-tools/probe', { method: 'POST', token, body: '{}' });
    assert.equal(reply.status, 200, reply.text);
    assert.ok(reply.json().reserved.includes('123456789012345678'));
    assert.ok(reply.json().reserved.includes(DEMO_CHANNEL_IDS.signup));
    assert.deepEqual(changed, [['probe', 'x']]);
    assert.equal(captured?.storage, 'memory');
    assert.equal((await options.audit.list()).entries[0]?.kind, 'channel.lock');
    // The handler wires snapshots: tournament members come from the runtime's events.
    assert.equal(await captured!.tournamentMembers('missing-event'), null);
  } finally { await harness.stop(); }

  assert.throws(() => adminToolsRoutes(adminTools({ modules: [{ name: 'bad', routes: () => [{ pattern: /^\/api\/v1\/other$/, methods: {} }] }] })),
    /must mount under/);
  assert.throws(() => adminToolsRoutes(adminTools({ modules: [module, module] })), /Duplicate/);
  // The shared registry itself always mounts cleanly.
  assert.doesNotThrow(() => adminToolsRoutes(adminTools({ modules: adminToolsRouteModules })));
});

test('tournament members come from the event snapshot: roster, check-ins and seated players', () => {
  const snapshot = liveDispute as EventSnapshotDto;
  const members = membersFromSnapshot(snapshot);
  assert.equal(members.eventId, snapshot.eventId);
  const seated = Object.values(snapshot.seats).filter(Boolean);
  for (const id of members.players) assert.ok(seated.includes(id));
  assert.equal(members.checkedIn.length, new Set(snapshot.checkins.map(seat => snapshot.seats[seat]).filter(Boolean)).size);
});
