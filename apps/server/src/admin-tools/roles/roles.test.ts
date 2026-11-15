import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ButtonRoleButtonDto, MessageBodyDto } from '@tcg-live/core';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { call, login, startHarness } from '../../admin/http/test-support.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';
import { createDemoGuild, DEMO_CHANNEL_IDS, DEMO_ROLE_IDS } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { BulkRoleRunner, MemoryBulkRoleJobStore, parseBulkRequest, type StoredBulkJob } from './bulk.js';
import { handleButtonRoleClick } from './feature.js';
import { DemoRolesGuildPort } from './guild-port.js';
import { MemoryButtonRolePanelStore, panelWarnings, parsePanelInput, type StoredPanel } from './panels.js';
import { demoPortFor } from './port.js';
import { buttonRows, decideButtonRole, panelMessage, parsePanelCustomId } from './render.js';
import { rolesRouteModule } from './routes.js';

const body: MessageBodyDto = { content: null, embed: { title: 'Pick your game', description: 'Click to toggle', color: 0x3b82f6, url: null,
  imageUrl: null, thumbnailUrl: null, footer: null, fields: [] } };
const button = (roleId: string, label = 'Role'): ButtonRoleButtonDto => ({ roleId, label, emoji: null, style: 'primary' });
const member = (n: number) => `2000000000000${String(n).padStart(5, '0')}`;
const PANEL_ID = '6f1c8a2e-0b5d-4e0a-9a0e-2a1b3c4d5e6f';

test('panel validation: button count, duplicate roles, @everyone, emoji, required role', () => {
  const ok = parsePanelInput({ channelId: DEMO_CHANNEL_IDS.general, body, mode: 'toggle',
    buttons: [{ ...button(DEMO_ROLE_IDS.lfg, 'LFG'), emoji: '🎮' }], requiredRoleId: DEMO_ROLE_IDS.player }, DEMO_GUILD_ID);
  assert.equal(ok.requiredRoleId, DEMO_ROLE_IDS.player);
  assert.equal(ok.buttons[0]!.emoji, '🎮');
  const base = { channelId: DEMO_CHANNEL_IDS.general, body, mode: 'toggle' };
  assert.throws(() => parsePanelInput({ ...base, buttons: [] }, DEMO_GUILD_ID), /1-25 buttons/);
  const many = Array.from({ length: 26 }, (_, index) => button(member(500 + index)));
  assert.throws(() => parsePanelInput({ ...base, buttons: many }, DEMO_GUILD_ID), /1-25 buttons/);
  assert.doesNotThrow(() => parsePanelInput({ ...base, buttons: many.slice(0, 25) }, DEMO_GUILD_ID));
  assert.throws(() => parsePanelInput({ ...base, buttons: [button(DEMO_ROLE_IDS.lfg), button(DEMO_ROLE_IDS.lfg)] }, DEMO_GUILD_ID), /only one button/);
  assert.throws(() => parsePanelInput({ ...base, buttons: [button(DEMO_GUILD_ID)] }, DEMO_GUILD_ID), /@everyone/);
  assert.throws(() => parsePanelInput({ ...base, buttons: [{ ...button(DEMO_ROLE_IDS.lfg), emoji: 'abc' }] }, DEMO_GUILD_ID), /emoji/);
  assert.throws(() => parsePanelInput({ ...base, mode: 'radio', buttons: [button(DEMO_ROLE_IDS.lfg)] }, DEMO_GUILD_ID), /mode/);
  assert.throws(() => parsePanelInput({ ...base, buttons: [button(DEMO_ROLE_IDS.lfg)], extra: 1 }, DEMO_GUILD_ID), /unknown fields/);
});

test('hierarchy warnings: managed, above the bot, deleted roles and an unknown required role', async () => {
  const port = new DemoRolesGuildPort(createDemoGuild(DEMO_GUILD_ID));
  const { roles, botTopPosition } = await port.roles();
  const warnings = panelWarnings({ buttons: [button(DEMO_ROLE_IDS.lfg, 'LFG'), button(DEMO_ROLE_IDS.bot, 'Bot'),
    button(DEMO_ROLE_IDS.admin, 'Admin'), button(member(999), 'Gone')], requiredRoleId: member(998) }, roles, botTopPosition, DEMO_GUILD_ID);
  assert.deepEqual(warnings.map(item => [item.roleId, item.problem]), [[DEMO_ROLE_IDS.bot, 'managed'], [DEMO_ROLE_IDS.admin, 'above-bot'],
    [member(999), 'unknown'], [member(998), 'unknown']]);
  assert.match(warnings[1]!.message, /^Admin: .*above the bot/);
});

test('toggle and unique click logic, with the required role', () => {
  const buttons = [button('300000000000000001'), button('300000000000000002'), button('300000000000000003')];
  const toggle = { mode: 'toggle' as const, buttons, requiredRoleId: null };
  assert.deepEqual(decideButtonRole(toggle, ['300000000000000002'], '300000000000000001'),
    { kind: 'change', add: ['300000000000000001'], remove: [], message: 'Added <@&300000000000000001>.' });
  assert.deepEqual(decideButtonRole(toggle, ['300000000000000001'], '300000000000000001'),
    { kind: 'change', add: [], remove: ['300000000000000001'], message: 'Removed <@&300000000000000001>.' });
  const unique = { ...toggle, mode: 'unique' as const };
  const switched = decideButtonRole(unique, ['300000000000000002', '300000000000000003', '999999999999999999'], '300000000000000001');
  assert.equal(switched.kind, 'change');
  if (switched.kind === 'change') {
    assert.deepEqual(switched.add, ['300000000000000001']);
    assert.deepEqual(switched.remove, ['300000000000000002', '300000000000000003']);
  }
  assert.deepEqual(decideButtonRole(unique, ['300000000000000001'], '300000000000000001').kind, 'change');
  const gated = { ...toggle, requiredRoleId: '300000000000000009' };
  assert.equal(decideButtonRole(gated, [], '300000000000000001').kind, 'denied');
  assert.equal(decideButtonRole(toggle, [], '300000000000000008').kind, 'denied');
});

test('25 buttons render as five rows of five with parseable custom IDs and no mentions', () => {
  const buttons = Array.from({ length: 25 }, (_, index) => ({ ...button(member(600 + index), `R${index}`), emoji: index === 0 ? '123456789012345678' : null }));
  const rows = buttonRows(PANEL_ID, buttons);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.components.length === 5));
  const first = rows[0]!.components[0]! as { custom_id: string; emoji?: { id?: string } };
  assert.deepEqual(parsePanelCustomId(first.custom_id), { panelId: PANEL_ID, roleId: member(600) });
  assert.ok(first.custom_id.length <= 100);
  assert.deepEqual(first.emoji, { id: '123456789012345678' });
  assert.deepEqual(panelMessage({ id: PANEL_ID, body, buttons }).allowedMentions, { parse: [], roles: [], users: [] });
  assert.equal(parsePanelCustomId('br:not-a-panel:1'), null);
});

function fakeClick(customId: string, userId: string) {
  const replies: string[] = [];
  return { replies, interaction: {
    customId, user: { id: userId },
    deferReply: async () => undefined, reply: async (options: { content: string }) => { replies.push(options.content); },
    editReply: async (options: { content: string }) => { replies.push(options.content); }
  } as never };
}

test('a unique-mode click swaps roles and confirms; unmanageable roles are refused politely', async () => {
  const demo = createDemoGuild(DEMO_GUILD_ID);
  const port = new DemoRolesGuildPort(demo);
  const panels = new MemoryButtonRolePanelStore();
  const panel: StoredPanel = { id: PANEL_ID, guildId: DEMO_GUILD_ID, channelId: DEMO_CHANNEL_IDS.general, messageId: null, messageMissing: false,
    body, mode: 'unique', buttons: [button(DEMO_ROLE_IDS.lfg), button(DEMO_ROLE_IDS.season3), button(DEMO_ROLE_IDS.admin)],
    requiredRoleId: DEMO_ROLE_IDS.player, updatedAtMs: 1 };
  await panels.create(panel);
  const ash = demo.members[0]!; // holds Player and LFG
  assert.ok(ash.roleIds.includes(DEMO_ROLE_IDS.lfg));
  const click = fakeClick(`br:${PANEL_ID}:${DEMO_ROLE_IDS.season3}`, ash.id);
  await handleButtonRoleClick(click.interaction, panels, port);
  assert.ok(ash.roleIds.includes(DEMO_ROLE_IDS.season3));
  assert.ok(!ash.roleIds.includes(DEMO_ROLE_IDS.lfg));
  assert.match(click.replies[0]!, /Added .* and removed/);
  const admin = fakeClick(`br:${PANEL_ID}:${DEMO_ROLE_IDS.admin}`, ash.id);
  await handleButtonRoleClick(admin.interaction, panels, port);
  assert.match(admin.replies[0]!, /cannot change this role/);
  assert.ok(!ash.roleIds.includes(DEMO_ROLE_IDS.admin));
  const outsider = demo.members[1]!;
  outsider.roleIds = [];
  const denied = fakeClick(`br:${PANEL_ID}:${DEMO_ROLE_IDS.lfg}`, outsider.id);
  await handleButtonRoleClick(denied.interaction, panels, port);
  assert.match(denied.replies[0]!, /You need the/);
});

function queuedJob(userIds: string[], id = '7a1c8a2e-0b5d-4e0a-9a0e-2a1b3c4d5e6f'): StoredBulkJob {
  return { id, guildId: DEMO_GUILD_ID, action: 'add', roleId: DEMO_ROLE_IDS.season3, target: { kind: 'ids', userIds }, reason: 'Season 3',
    status: 'queued', total: userIds.length, done: 0, failed: 0, error: null, createdAtMs: 1, startedAtMs: null, finishedAtMs: null,
    userIds, failures: [], createdBy: 'local-admin' };
}

test('bulk runner paces batches, records per-member failures and audits the finish', async () => {
  const demo = createDemoGuild(DEMO_GUILD_ID);
  const port = new DemoRolesGuildPort(demo);
  port.failingUsers.add(member(3));
  const store = new MemoryBulkRoleJobStore();
  const ids = [member(1), member(2), member(3), member(4), member(5), '200000000000099999'];
  await store.create(queuedJob(ids));
  const sleeps: number[] = [];
  const audits: string[] = [];
  const runner = new BulkRoleRunner({ store, guildId: DEMO_GUILD_ID, port: async () => port, concurrency: 2, pauseMs: 250,
    sleep: async ms => { sleeps.push(ms); }, audit: async kind => { audits.push(kind); } });
  await runner.kick();
  const job = (await store.get(DEMO_GUILD_ID, queuedJob([]).id))!;
  assert.equal(job.status, 'done');
  assert.deepEqual([job.done, job.failed], [4, 2]);
  assert.deepEqual(job.failures.map(item => item.userId), [member(3), '200000000000099999']);
  assert.match(job.failures[1]!.error, /Not in the server/);
  assert.deepEqual(sleeps, [250, 250]); // 3 batches of 2: a pause between batches only.
  assert.equal(port.roleCalls.length, 6);
  assert.deepEqual(audits, ['bulk_roles.finished']);
  assert.ok(demo.members[0]!.roleIds.includes(DEMO_ROLE_IDS.season3));
});

test('bulk runner resumes after a stop without repeating members, and stops on cancel', async () => {
  const port = new DemoRolesGuildPort(createDemoGuild(DEMO_GUILD_ID));
  const store = new MemoryBulkRoleJobStore();
  const ids = Array.from({ length: 6 }, (_, index) => member(index + 1));
  await store.create(queuedJob(ids));
  let batches = 0;
  let first!: BulkRoleRunner;
  first = new BulkRoleRunner({ store, guildId: DEMO_GUILD_ID, port: async () => port, concurrency: 2,
    sleep: async () => { if (++batches === 1) first.stop(); } });
  await first.kick();
  const paused = (await store.get(DEMO_GUILD_ID, queuedJob([]).id))!;
  assert.equal(paused.status, 'running'); // As after a crash or shutdown mid-job.
  assert.equal(paused.done, 2);
  const second = new BulkRoleRunner({ store, guildId: DEMO_GUILD_ID, port: async () => port, concurrency: 2, sleep: async () => {} });
  await second.kick();
  assert.equal((await store.get(DEMO_GUILD_ID, paused.id))!.status, 'done');
  assert.deepEqual(port.roleCalls.map(item => item.userId), ids); // Each member exactly once.

  const cancelStore = new MemoryBulkRoleJobStore();
  await cancelStore.create(queuedJob(ids));
  const cancelling = new BulkRoleRunner({ store: cancelStore, guildId: DEMO_GUILD_ID, port: async () => port, concurrency: 2,
    sleep: async () => { await cancelStore.cancel(DEMO_GUILD_ID, paused.id, 5); } });
  await cancelling.kick();
  const cancelled = (await cancelStore.get(DEMO_GUILD_ID, paused.id))!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.done, 2); // Cancelled between batches: nothing more is changed.
  await assert.rejects(cancelStore.cancel(DEMO_GUILD_ID, paused.id, 6), /already finished/);
});

test('bulk request parsing: targets, reason and preview', () => {
  assert.throws(() => parseBulkRequest({ action: 'add', roleId: DEMO_ROLE_IDS.lfg, target: { kind: 'ids', userIds: [] }, reason: 'x' }, true), /at least one/);
  assert.throws(() => parseBulkRequest({ action: 'add', roleId: DEMO_ROLE_IDS.lfg, target: { kind: 'roster', eventId: 'nope' }, reason: 'x' }, true), /tournament/);
  assert.throws(() => parseBulkRequest({ action: 'add', roleId: DEMO_ROLE_IDS.lfg, target: { kind: 'ids', userIds: [member(1)] } }, true), /missing/);
  assert.equal(parseBulkRequest({ action: 'remove', roleId: DEMO_ROLE_IDS.lfg, target: { kind: 'ids', userIds: [member(1)] } }, false).action, 'remove');
});

function options(): AdminToolsRouteOptions {
  const audit = new MemoryOpsAuditStore();
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [rolesRouteModule({ runner: { pauseMs: 0, sleep: async () => {} } })] };
}
const json = (value: unknown) => JSON.stringify(value);

test('panel routes: create with warnings, publish, edit in place, deleted message shows missing, repost, delete', async () => {
  const adminTools = options();
  const harness = await startHarness({ adminTools });
  try {
    const token = await login(harness);
    const request = (path: string, method = 'GET', payload?: unknown) =>
      call(harness.port, `/api/v1/admin-tools/${path}`, { method, token, ...(payload === undefined ? {} : { body: json(payload) }) });
    const input = { channelId: DEMO_CHANNEL_IDS.general, body, mode: 'toggle',
      buttons: [button(DEMO_ROLE_IDS.lfg, 'LFG'), button(DEMO_ROLE_IDS.admin, 'Admin')], requiredRoleId: null };
    const created = await request('button-roles', 'POST', input);
    assert.equal(created.status, 201, created.text);
    const panel = created.json();
    assert.equal(panel.messageState, 'unpublished');
    assert.deepEqual(panel.warnings.map((item: { problem: string }) => item.problem), ['above-bot']);
    const published = (await request(`button-roles/${panel.id}/publish`, 'POST')).json();
    assert.equal(published.messageState, 'posted');
    const port = demoPortFor(adminTools.demo!);
    assert.equal(port.messages.get(published.messageId)!.message.components[0]!.components.length, 2);
    const edited = await request(`button-roles/${panel.id}`, 'PUT', { ...input, buttons: [button(DEMO_ROLE_IDS.lfg, 'Looking for game')] });
    assert.equal(edited.json().messageId, published.messageId);
    assert.equal((port.messages.get(published.messageId)!.message.components[0]!.components[0] as { label: string }).label, 'Looking for game');
    port.messages.delete(published.messageId);
    const listed = (await request('button-roles')).json();
    assert.equal(listed.panels[0].messageState, 'missing');
    const reposted = (await request(`button-roles/${panel.id}/publish`, 'POST')).json();
    assert.equal(reposted.messageState, 'posted');
    assert.notEqual(reposted.messageId, published.messageId);
    assert.equal((await request(`button-roles/${panel.id}`, 'DELETE')).status, 200);
    assert.equal(port.messages.has(reposted.messageId), false);
    assert.equal((await request('button-roles', 'POST', { ...input, buttons: [] })).status, 400);
    const kinds = (await adminTools.audit.list()).entries.map(entry => entry.kind);
    assert.deepEqual(kinds, ['button_roles.saved', 'button_roles.published', 'button_roles.saved', 'button_roles.published', 'button_roles.deleted']);
  } finally { await harness.stop(); }
});

test('bulk role routes: dry-run preview, refused roles, queued job runs in the demo, cancel of a finished job conflicts', async () => {
  const adminTools = options();
  const harness = await startHarness({ adminTools });
  try {
    const token = await login(harness);
    const request = (path: string, method = 'GET', payload?: unknown) =>
      call(harness.port, `/api/v1/admin-tools/${path}`, { method, token, ...(payload === undefined ? {} : { body: json(payload) }) });
    const target = { kind: 'ids', userIds: [member(1), member(2), member(3)] };
    const preview = (await request('bulk-roles/preview', 'POST', { action: 'add', roleId: DEMO_ROLE_IDS.season3, target })).json();
    assert.deepEqual([preview.total, preview.warning], [3, null]);
    assert.equal(adminTools.demo!.members[0]!.roleIds.includes(DEMO_ROLE_IDS.season3), false, 'preview changes nothing');
    const admin = await request('bulk-roles/preview', 'POST', { action: 'add', roleId: DEMO_ROLE_IDS.admin, target });
    assert.equal(admin.json().warning.problem, 'above-bot');
    assert.equal((await request('bulk-roles', 'POST', { action: 'add', roleId: DEMO_ROLE_IDS.admin, target, reason: 'x' })).status, 400);
    assert.equal((await request('bulk-roles', 'POST', { action: 'add', roleId: DEMO_ROLE_IDS.season3,
      target: { kind: 'roster', eventId: '00000000-0000-4000-8000-000000000000' }, reason: 'x' })).status, 400);
    const queued = await request('bulk-roles', 'POST', { action: 'add', roleId: DEMO_ROLE_IDS.season3, target, reason: 'Season 3 kickoff' });
    assert.equal(queued.status, 201, queued.text);
    let detail = (await request(`bulk-roles/${queued.json().id}`)).json();
    for (let attempt = 0; detail.status !== 'done' && attempt < 50; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      detail = (await request(`bulk-roles/${queued.json().id}`)).json();
    }
    assert.deepEqual([detail.status, detail.done, detail.failed, detail.failures], ['done', 3, 0, []]);
    assert.ok(adminTools.demo!.members[2]!.roleIds.includes(DEMO_ROLE_IDS.season3));
    assert.equal((await request(`bulk-roles/${detail.id}/cancel`, 'POST')).status, 409);
    assert.equal((await request('bulk-roles')).json().jobs.length, 1);
    const kinds = (await adminTools.audit.list()).entries.map(entry => entry.kind);
    assert.deepEqual(kinds, ['bulk_roles.queued', 'bulk_roles.finished']);
  } finally { await harness.stop(); }
});
