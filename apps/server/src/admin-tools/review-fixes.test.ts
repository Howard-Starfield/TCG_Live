// Regression tests for the adversarial review of the admin tools (staff roles, double sends, purge and lock
// safety, sticky loops, quiet storage failures, ticket overwrites).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import type { MessageBodyDto } from '@tcg-live/core';
import { DEMO_GUILD_ID } from '../admin/demo.js';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { MemoryAnnouncementStore, type StoredAnnouncement } from './announcements/announcements.js';
import { announcementsRouteModule } from './announcements/routes.js';
import { purgeChannel, type ChannelGateway, type PermissionBit, type RecentMessage } from './channels/controls.js';
import { channelsRouteModule } from './channels/routes.js';
import { StickyEngine, type StickyClock } from './channels/sticky-engine.js';
import { createDemoGuild, DEMO_CHANNEL_IDS, DEMO_ROLE_IDS } from './demo-guild.js';
import { BulkRoleRunner, MemoryBulkRoleJobStore, type BulkRoleJobStore, type StoredBulkJob } from './roles/bulk.js';
import { DemoRolesGuildPort, isElevatedPermissions, roleProblem, type RolesGuildPort } from './roles/guild-port.js';
import { panelWarnings } from './roles/panels.js';
import type { AdminToolsRouteOptions } from './routes.js';
import { MemoryAdminToolsSettingsStore } from './settings.js';
import { AdminToolsRuntimeState } from './status.js';
import { ticketOverwrites } from './tickets/messages.js';

const member = (n: number) => `2000000000000${String(n).padStart(5, '0')}`;

test('staff roles (Administrator, Ban Members...) are never assignable by panels, bulk jobs or auto-role', () => {
  assert.equal(isElevatedPermissions(PermissionFlagsBits.Administrator), true);
  assert.equal(isElevatedPermissions(PermissionFlagsBits.BanMembers | PermissionFlagsBits.SendMessages), true);
  assert.equal(isElevatedPermissions(PermissionFlagsBits.ManageGuild), true);
  assert.equal(isElevatedPermissions(PermissionFlagsBits.SendMessages | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect), false);
  const role = { id: '300000000000000001', managed: false, position: 2, elevated: true };
  assert.equal(roleProblem(role, DEMO_GUILD_ID, 10), 'elevated');
  assert.equal(roleProblem({ ...role, elevated: false }, DEMO_GUILD_ID, 10), null);
  const warnings = panelWarnings({ buttons: [{ roleId: role.id, label: 'Mods', emoji: null, style: 'primary' }], requiredRoleId: null },
    [{ ...role, name: 'Mods' }], 10, DEMO_GUILD_ID);
  assert.deepEqual(warnings.map(item => item.problem), ['elevated']);
  assert.match(warnings[0]!.message, /staff permissions/);
});

function queuedJob(userIds: string[]): StoredBulkJob {
  return { id: '7a1c8a2e-0b5d-4e0a-9a0e-2a1b3c4d5e70', guildId: DEMO_GUILD_ID, action: 'add', roleId: DEMO_ROLE_IDS.season3,
    target: { kind: 'ids', userIds }, reason: 'Season 3', status: 'queued', total: userIds.length, done: 0, failed: 0, error: null,
    createdAtMs: 1, startedAtMs: null, finishedAtMs: null, userIds, failures: [], createdBy: 'local-admin' };
}

test('a bulk job queued for a role that became a staff role fails at run time without touching anyone', async () => {
  const demo = new DemoRolesGuildPort(createDemoGuild(DEMO_GUILD_ID));
  const port: RolesGuildPort = Object.assign(Object.create(demo) as RolesGuildPort, {
    roles: async () => {
      const result = await demo.roles();
      return { ...result, roles: result.roles.map(item => item.id === DEMO_ROLE_IDS.season3 ? { ...item, elevated: true } : item) };
    }
  });
  const store = new MemoryBulkRoleJobStore();
  await store.create(queuedJob([member(1), member(2)]));
  const audits: Array<Record<string, unknown>> = [];
  await new BulkRoleRunner({ store, guildId: DEMO_GUILD_ID, port: async () => port, sleep: async () => {},
    audit: async (_kind, payload) => { audits.push(payload); } }).kick();
  const job = (await store.get(DEMO_GUILD_ID, queuedJob([]).id))!;
  assert.equal(job.status, 'failed');
  assert.match(job.error ?? '', /elevated/);
  assert.equal(demo.roleCalls.length, 0);
  assert.equal(audits[0]?.refused, 'elevated');
});

test('bulk runner logs a storage outage once, not on every resume tick', async () => {
  const failing = { open: async () => { throw new Error('relation "tcg_bulk_role_jobs" does not exist'); } } as unknown as BulkRoleJobStore;
  const logs: string[] = [];
  const runner = new BulkRoleRunner({ store: failing, guildId: DEMO_GUILD_ID, port: async () => { throw new Error('unused'); },
    log: message => { logs.push(message); } });
  for (let index = 0; index < 5; index += 1) await runner.kick();
  assert.equal(logs.length, 1);
});

const body: MessageBodyDto = { content: 'Round 2 starts now', embed: null };
function scheduledAnnouncement(id: string): StoredAnnouncement {
  return { id, guildId: DEMO_GUILD_ID, channelId: DEMO_CHANNEL_IDS.announcements, body, mentionRoleIds: [], mentionEveryone: false,
    scheduledAtMs: Date.now() + 3_600_000, status: 'scheduled', messageId: null, sentAtMs: null, error: null, createdAtMs: 1, updatedAtMs: 1 };
}

/** The scheduler claims the announcement right after a route has read it (the race window). */
class RacingStore extends MemoryAnnouncementStore {
  override async get(guildId: string, id: string) {
    const item = await super.get(guildId, id);
    if (item?.status === 'scheduled') await this.claim(guildId, id, Date.now());
    return item;
  }
}

test('an announcement claimed by the scheduler is never sent a second time by Send now or re-scheduled by an edit', async () => {
  const audit = new MemoryOpsAuditStore();
  const store = new RacingStore();
  const options: AdminToolsRouteOptions = { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory',
    guildId: () => DEMO_GUILD_ID, status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [announcementsRouteModule({ store, demoTimer: false })] };
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const request = (path: string, method: string, payload?: unknown) => call(harness.port, `/api/v1/admin-tools/${path}`,
      { method, token, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const first = '00000000-0000-4000-8000-0000000000a1';
    await store.create(scheduledAnnouncement(first));
    const send = await request(`announcements/${first}/send`, 'POST');
    assert.equal(send.status, 409, send.text);
    const second = '00000000-0000-4000-8000-0000000000a2';
    await store.create(scheduledAnnouncement(second));
    const edit = await request(`announcements/${second}`, 'PUT', { channelId: DEMO_CHANNEL_IDS.announcements, body, mentionRoleIds: [],
      scheduledAtMs: Date.now() + 7_200_000 });
    assert.equal(edit.status, 409, edit.text);
    assert.equal((await store.get(DEMO_GUILD_ID, second))!.status, 'sent', 'the claim stands; nothing re-schedules it');
  } finally { await harness.stop(); }
});

class FakeChannels implements ChannelGateway {
  constructor(public messages: RecentMessage[]) {}
  async state() { return { everyoneSend: 'neutral' as PermissionBit, slowmodeSeconds: 0 }; }
  async setEveryoneSend() {}
  async setSlowmode() {}
  async recentMessages(_channelId: string, limit: number) { return this.messages.slice(0, limit); }
  async bulkDelete(_channelId: string, ids: readonly string[]) {
    this.messages = this.messages.filter(message => !ids.includes(message.id));
    return ids.length;
  }
}

test('purge never deletes the bot\'s own messages (tournament cards, panels, stickies)', async () => {
  const now = Date.UTC(2026, 10, 14);
  const BOT = '300000000000000099';
  const messages: RecentMessage[] = Array.from({ length: 10 }, (_, index) => ({ id: `6000000000000${String(index).padStart(5, '0')}`,
    authorId: index % 2 ? member(1) : BOT, createdAtMs: now - index * 60_000 }));
  const gateway = new FakeChannels(structuredClone(messages));
  const result = await purgeChannel(gateway, { channelId: DEMO_CHANNEL_IDS.general, mode: 'count', count: 10, reason: 'x' }, now, [BOT]);
  assert.deepEqual(result, { deleted: 5, skippedTooOld: 0 });
  assert.ok(gateway.messages.every(message => message.authorId === BOT));
  const byBot = await purgeChannel(gateway, { channelId: DEMO_CHANNEL_IDS.general, mode: 'user', userId: BOT, count: 10, reason: 'x' }, now, [BOT]);
  assert.equal(byBot.deleted, 0);
});

test('the tournament channels cannot be locked (the bot would lose Send Messages); others can', async () => {
  const audit = new MemoryOpsAuditStore();
  const options: AdminToolsRouteOptions = { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory',
    guildId: () => DEMO_GUILD_ID, status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [channelsRouteModule()] };
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const lock = (channelId: string) => call(harness.port, '/api/v1/admin-tools/channels/lock',
      { method: 'POST', token, body: JSON.stringify({ channelId, locked: true, reason: 'raid' }) });
    const refused = await lock(DEMO_CHANNEL_IDS.signup);
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.text, /cannot be locked/);
    assert.equal((await lock(DEMO_CHANNEL_IDS.general)).status, 200);
  } finally { await harness.stop(); }
});

test('a sticky ignores other bots and webhooks, so two sticky bots cannot ping-pong', () => {
  const clock: StickyClock = { now: () => 1_000, setTimeout: () => 1, clearTimeout: () => {} };
  const statuses: string[] = [];
  const engine = new StickyEngine({ post: async () => '500000000000000001', remove: async () => {}, latestMessageId: async () => null },
    () => '300000000000000099', clock);
  engine.upsert({ key: 'k', channelId: DEMO_CHANNEL_IDS.general, debounceMs: 5_000, lastMessageId: null, render: () => ({}),
    onPosted: async () => {}, onStatus: status => { statuses.push(status.state); } });
  engine.onMessage({ channelId: DEMO_CHANNEL_IDS.general, messageId: '500000000000000002', authorId: '300000000000000077', bot: true });
  assert.deepEqual(statuses, []);
  engine.onMessage({ channelId: DEMO_CHANNEL_IDS.general, messageId: '500000000000000003', authorId: member(1) });
  assert.deepEqual(statuses, ['waiting']);
  engine.stop();
});

test('ticket channel overwrites: @everyone denied; member, staff and bot allowed; the bot asks only for what it needs', () => {
  const overwrites = ticketOverwrites({ everyoneRoleId: DEMO_GUILD_ID, openerId: member(1), staffRoleIds: [DEMO_ROLE_IDS.player],
    botUserId: '300000000000000099' });
  assert.equal(overwrites.length, 4);
  const bot = overwrites.find(item => item.id === '300000000000000099')!;
  assert.equal(bot.allow & PermissionFlagsBits.ManageMessages, 0n);
  assert.equal(bot.allow & PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ViewChannel);
});

test('GET /admin-tools/guild marks staff-level roles elevated; the demo has a Moderator below the bot that panels refuse', async () => {
  const audit = new MemoryOpsAuditStore();
  const options: AdminToolsRouteOptions = { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory',
    guildId: () => DEMO_GUILD_ID, status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID), modules: [] };
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const response = await call(harness.port, '/api/v1/admin-tools/guild', { method: 'GET', token });
    assert.equal(response.status, 200, response.text);
    const roles = response.json().roles as Array<{ id: string; elevated: boolean; aboveBot: boolean }>;
    const byId = new Map(roles.map(role => [role.id, role]));
    assert.deepEqual([byId.get(DEMO_ROLE_IDS.moderator)?.elevated, byId.get(DEMO_ROLE_IDS.moderator)?.aboveBot], [true, false]);
    assert.equal(byId.get(DEMO_ROLE_IDS.player)?.elevated, false);
    assert.ok(roles.every(role => typeof role.elevated === 'boolean'));
  } finally { await harness.stop(); }
  const port = new DemoRolesGuildPort(createDemoGuild(DEMO_GUILD_ID));
  const { roles, botTopPosition } = await port.roles();
  const warnings = panelWarnings({ buttons: [{ roleId: DEMO_ROLE_IDS.moderator, label: 'Mods', emoji: null, style: 'primary' }],
    requiredRoleId: null }, roles, botTopPosition, DEMO_GUILD_ID);
  assert.deepEqual(warnings.map(item => item.problem), ['elevated']);
});
