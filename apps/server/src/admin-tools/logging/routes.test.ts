import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, login, startHarness } from '../../admin/http/test-support.js';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';
import { createDemoGuild } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { loggingRouteModule, parseLogQuery } from './routes.js';

function options(audit = new MemoryOpsAuditStore()): AdminToolsRouteOptions {
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID), modules: [loggingRouteModule()] };
}

test('log query parsing validates every filter', () => {
  const q = (text: string) => parseLogQuery(new URLSearchParams(text));
  assert.deepEqual(q(''), { stream: 'member', order: 'oldest', kind: null, channelId: null, fromMs: null, toMs: null, userId: null,
    after: 0, before: 0, limit: 50 });
  assert.equal(q('stream=message&kind=delete&channelId=200000000000000302&order=newest&before=9').kind, 'delete');
  for (const bad of ['stream=x', 'kind=delete', 'stream=message&kind=join', 'channelId=200000000000000302', 'userId=abc',
    'limit=0', 'limit=501', 'fromMs=5&toMs=4', 'order=up', 'extra=1', 'after=-1']) {
    assert.throws(() => q(bad), /./, bad);
  }
});

test('demo logs list, filter and page; message history delete is audited and needs server.manage', async () => {
  const audit = new MemoryOpsAuditStore();
  const harness = await startHarness({ adminTools: options(audit) });
  try {
    const token = await login(harness);
    const members = (await call(harness.port, '/api/v1/admin-tools/logs?stream=member&limit=500', { token })).json();
    assert.ok(members.entries.length >= 9);
    assert.ok(members.entries.some((entry: any) => entry.kind === 'join' && entry.detail.newAccount === true));
    const page1 = (await call(harness.port, '/api/v1/admin-tools/logs?stream=member&order=newest&limit=3', { token })).json();
    const page2 = (await call(harness.port, `/api/v1/admin-tools/logs?stream=member&order=newest&limit=3&before=${page1.nextAfter}`, { token })).json();
    assert.ok(page1.entries[0].id > page2.entries[0].id);
    const deletes = (await call(harness.port, '/api/v1/admin-tools/logs?stream=message&kind=delete', { token })).json();
    assert.equal(deletes.entries.length, 2);
    assert.equal((await call(harness.port, '/api/v1/admin-tools/logs?stream=nope', { token })).status, 400);
    const stats = (await call(harness.port, '/api/v1/admin-tools/logs/message-store', { token })).json();
    assert.deepEqual([stats.storedMessages, stats.loggedEntries], [1, 3]);
    const wiped = await call(harness.port, '/api/v1/admin-tools/logs/messages', { method: 'DELETE', token });
    assert.equal(wiped.status, 200);
    assert.deepEqual(wiped.json(), { storedMessages: 1, loggedEntries: 3 });
    assert.equal((await call(harness.port, '/api/v1/admin-tools/logs?stream=message', { token })).json().entries.length, 0);
    assert.deepEqual(audit.entries.at(-1)?.kind, 'logging.retention');
    assert.equal(audit.entries.at(-1)?.payload.reason, 'manual');
  } finally { await harness.stop(); }

  const reader = await startHarness({ adminTools: options() }, { capabilities: ['dashboard.read', 'members.read'] });
  try {
    const token = await login(reader);
    assert.equal((await call(reader.port, '/api/v1/admin-tools/logs', { token })).status, 200);
    assert.equal((await call(reader.port, '/api/v1/admin-tools/logs/messages', { method: 'DELETE', token })).status, 403);
  } finally { await reader.stop(); }
});
