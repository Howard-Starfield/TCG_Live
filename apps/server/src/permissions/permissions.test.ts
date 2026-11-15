import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits, type Client } from 'discord.js';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type PermissionReportDto } from '@tcg-live/core';
import { call, login, startHarness } from '../admin/http/test-support.js';
import { demoOpsOptions, DEMO_GUILD_ID } from '../admin/demo.js';
import { createDemoGuild, DEMO_CHANNEL_IDS } from '../admin-tools/demo-guild.js';
import { MemoryAdminToolsSettingsStore } from '../admin-tools/settings.js';
import { AdminToolsRuntimeState } from '../admin-tools/status.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { channelPermissions, checkPermissions, hasPermission, MESSAGE_SOURCE_ISSUE_LIMIT, type GuildPermissionView,
  type PermissionConfig } from './checker.js';
import { DEMO_APPLICATION_ID, demoPermissionMonitor } from './demo.js';
import { DemoAdminRuntime } from '../admin/runtime/demo-runtime.js';
import { livePermissionReport } from './live.js';
import { PermissionMonitor } from './monitor.js';
import { setupPermissionReport } from './setup.js';
import { ALL_FEATURE_PERMISSIONS, FEATURE_PERMISSIONS, inviteUrl, permissionBits, permissionLabel, SETUP_CHANNEL_PERMISSIONS,
  SETUP_DISCOVERY_FLAGS } from './table.js';

const F = PermissionFlagsBits;
const GUILD = '100000000000000001';
const APP = '100000000000000777';
const ch = (n: number) => `30000000000000${String(n).padStart(4, '0')}`;
const role = (n: number) => `40000000000000${String(n).padStart(4, '0')}`;
const settings = () => structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
const EVERYTHING = ALL_FEATURE_PERMISSIONS;

function view(patch: Partial<GuildPermissionView> = {}): GuildPermissionView {
  return {
    guildId: GUILD, guildPermissions: EVERYTHING, botTopRole: { id: role(9), name: 'TCG Live', position: 5 },
    channels: [
      { id: ch(1), name: 'signup', type: 'text', permissions: EVERYTHING },
      { id: ch(2), name: 'TCG Match M1', type: 'voice', permissions: EVERYTHING },
      { id: ch(3), name: 'general', type: 'text', permissions: EVERYTHING },
      { id: ch(4), name: 'staff', type: 'text', permissions: EVERYTHING }
    ],
    roles: [{ id: GUILD, name: '@everyone', position: 0, managed: false, mentionable: true },
      { id: role(1), name: 'Player', position: 1, managed: false, mentionable: true },
      { id: role(2), name: 'Admin', position: 7, managed: false, mentionable: true },
      { id: role(3), name: 'Server Booster', position: 2, managed: true, mentionable: false }],
    ...patch
  };
}
const off: PermissionConfig = { tournament: null, moderation: null, adminTools: null, intents: null };
const tools = (patch: Partial<NonNullable<PermissionConfig['adminTools']>> = {}): NonNullable<PermissionConfig['adminTools']> =>
  ({ settings: settings(), stickies: [], panels: [], bulkRoleIds: [], announcements: [], ...patch });

test('the table: stable unique IDs, Discord labels, the setup lists and the invite integers', () => {
  const ids = FEATURE_PERMISSIONS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(permissionLabel('ManageRoles', 'channel'), 'Manage Permissions');
  assert.equal(permissionLabel('ManageRoles'), 'Manage Roles');
  assert.equal(permissionLabel('ManageGuild'), 'Manage Server');
  assert.equal(permissionLabel('ModerateMembers'), 'Timeout Members');
  // The onboarding lists keep their historical order and names.
  assert.deepEqual(SETUP_CHANNEL_PERMISSIONS.text, ['View Channel', 'Send Messages', 'Read Message History', 'Embed Links', 'Attach Files']);
  assert.deepEqual(SETUP_CHANNEL_PERMISSIONS.public, [...SETUP_CHANNEL_PERMISSIONS.voice, 'Manage Permissions', 'Manage Channels', 'Move Members']);
  assert.equal(SETUP_DISCOVERY_FLAGS['Manage Permissions'], F.ManageRoles);
  assert.equal(permissionBits(['ViewChannel', 'SendMessages']), F.ViewChannel | F.SendMessages);
  assert.equal(ALL_FEATURE_PERMISSIONS & F.Administrator, 0n, 'never asks for Administrator');
  for (const key of ['ManageGuild', 'BanMembers', 'ModerateMembers', 'ManageRoles', 'MentionEveryone', 'PinMessages'] as const)
    assert.notEqual(ALL_FEATURE_PERMISSIONS & F[key], 0n, key);
  const url = new URL(inviteUrl({ applicationId: APP, guildId: GUILD, permissions: F.SendMessages | F.ViewChannel }));
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), APP);
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
  assert.equal(url.searchParams.get('permissions'), String(F.SendMessages | F.ViewChannel));
  assert.equal(url.searchParams.get('guild_id'), GUILD);
  assert.equal(url.searchParams.get('disable_guild_select'), 'true');
  assert.equal(new URL(inviteUrl({ applicationId: APP, permissions: 0n })).searchParams.has('guild_id'), false);
});

test('channel permissions follow Discord: @everyone, then roles, then the member; Administrator wins', () => {
  const base = F.ViewChannel | F.SendMessages;
  assert.equal(channelPermissions({ base, everyone: { allow: 0n, deny: F.SendMessages } }) & F.SendMessages, 0n);
  assert.notEqual(channelPermissions({ base, everyone: { allow: 0n, deny: F.SendMessages },
    roles: [{ allow: F.SendMessages, deny: 0n }] }) & F.SendMessages, 0n, 'a role allow beats the @everyone deny');
  assert.equal(channelPermissions({ base, roles: [{ allow: F.SendMessages, deny: 0n }], member: { allow: 0n, deny: F.SendMessages } })
    & F.SendMessages, 0n, 'the member overwrite comes last');
  assert.notEqual(channelPermissions({ base: F.Administrator, everyone: { allow: 0n, deny: F.ViewChannel } }) & F.ViewChannel, 0n);
  assert.equal(hasPermission(F.Administrator, 'BanMembers'), true);
  assert.equal(hasPermission(F.KickMembers, 'BanMembers'), false);
});

test('only enabled features are checked, and the invite integer covers exactly them', () => {
  const none = checkPermissions(view({ guildPermissions: 0n, channels: [], roles: [] }), off);
  assert.deepEqual(none.issues, []);
  assert.equal(none.enabledBits, 0n);
  // Admin tools mounted: the on-demand tools need their server-wide permissions (warnings only).
  const bare = checkPermissions(view({ guildPermissions: F.ViewChannel }), { ...off, adminTools: tools() });
  assert.ok(bare.issues.length > 0);
  assert.ok(bare.issues.every(issue => issue.severity === 'warning' && issue.scope.kind === 'guild'));
  assert.deepEqual(new Set(bare.issues.map(issue => issue.featureId)),
    new Set(['members.ban', 'members.kick', 'members.timeout', 'members.audit', 'channels.lock', 'channels.slowmode', 'channels.purge']));
  assert.equal(bare.enabledBits & F.ManageGuild, 0n, 'AutoMod is off');
  assert.notEqual(bare.enabledBits & F.BanMembers, 0n);
  // AutoMod on with a timeout rule needs Manage Server and Timeout Members.
  const automod = checkPermissions(view({ guildPermissions: F.ViewChannel }),
    { ...off, moderation: { textEnabled: true, timeoutRules: true, voiceEnabled: false, voiceNoticeChannelId: null } });
  assert.deepEqual(automod.issues.map(issue => [issue.featureId, issue.permission, issue.severity]),
    [['automod.manage', 'Manage Server', 'blocking'], ['automod.timeout', 'Timeout Members', 'blocking']]);
});

test('a channel overwrite that denies a permission the server grants is an overwrite issue', () => {
  const denied = channelPermissions({ base: EVERYTHING, roles: [{ allow: 0n, deny: F.SendMessages }] });
  const result = checkPermissions(view({ channels: [{ id: ch(3), name: 'general', type: 'text', permissions: denied }] }),
    { ...off, adminTools: tools({ stickies: [{ channelId: ch(3), embed: false }] }) });
  assert.deepEqual(result.issues.map(issue => ({ id: issue.featureId, kind: issue.kind, permission: issue.permission, scope: issue.scope })),
    [{ id: 'stickies.post', kind: 'overwrite', permission: 'Send Messages', scope: { kind: 'channel', id: ch(3), name: 'general' } }]);
  assert.match(result.issues[0]!.fix, /#general/);
  // Missing server-wide too: the invite fixes it.
  const missing = checkPermissions(view({ guildPermissions: EVERYTHING & ~F.SendMessages,
    channels: [{ id: ch(3), name: 'general', type: 'text', permissions: EVERYTHING & ~F.SendMessages }] }),
  { ...off, adminTools: tools({ stickies: [{ channelId: ch(3), embed: false }] }) });
  assert.equal(missing.issues.find(issue => issue.featureId === 'stickies.post')?.kind, 'permission');
  assert.match(missing.issues.find(issue => issue.featureId === 'stickies.post')!.fix, /Grant missing permissions/);
});

test('without View Channel only View Channel is reported, and deleted channels are named', () => {
  const result = checkPermissions(view({ channels: [{ id: ch(1), name: 'signup', type: 'text', permissions: EVERYTHING & ~F.ViewChannel }] }),
    { ...off, tournament: { signupChannelId: ch(1), matchChannelIds: [ch(7)], publicMatchRooms: false, signupMode: false } });
  const signup = result.issues.find(issue => issue.featureId === 'tournament.signup')!;
  assert.equal(signup.permission, 'View Channel');
  assert.equal(signup.severity, 'blocking');
  const room = result.issues.find(issue => issue.featureId === 'tournament.matchRoom')!;
  assert.equal(room.kind, 'missing');
  assert.equal(result.issues.some(issue => issue.featureId === 'tournament.pin'), false, 'pinning only in signup tournaments');
});

test('Administrator passes every permission check but not the role hierarchy', () => {
  const config: PermissionConfig = { ...off, adminTools: tools({ panels: [{ channelId: ch(3), embed: true, roleIds: [role(1), role(2), role(3)] }],
    stickies: [{ channelId: ch(3), embed: true }] }),
  moderation: { textEnabled: true, timeoutRules: true, voiceEnabled: false, voiceNoticeChannelId: null } };
  const result = checkPermissions(view({ guildPermissions: F.Administrator,
    channels: view().channels.map(item => ({ ...item, permissions: F.Administrator })) }), config);
  assert.deepEqual(result.issues.map(issue => [issue.featureId, issue.kind, issue.scope.kind === 'role' ? issue.scope.name : null]),
    [['roles.hierarchy', 'hierarchy', 'Admin'], ['roles.hierarchy', 'hierarchy', 'Server Booster']]);
  assert.match(result.issues[0]!.fix, /drag TCG Live above @Admin/);
  assert.match(result.issues[1]!.why, /managed by an integration/);
  // Without Manage Roles the role tools are blocked too; a role below the bot is fine.
  const noRoles = checkPermissions(view({ guildPermissions: EVERYTHING & ~F.ManageRoles }),
    { ...off, adminTools: tools({ bulkRoleIds: [role(1)] }) });
  assert.deepEqual(noRoles.issues.filter(issue => issue.severity === 'blocking').map(issue => issue.featureId), ['roles.manage']);
});

test('logging, tickets, announcements and intents', () => {
  const s = settings();
  s.tickets = { ...s.tickets, enabled: true, supportChannelId: ch(3), categoryId: ch(99), staffRoleIds: [role(1)] };
  s.logging.messageLog = { enabled: true, channelId: null, retentionDays: 30, ignoredChannelIds: [ch(4)] };
  s.logging.welcome = { ...s.logging.welcome, enabled: true, channelId: ch(3) };
  const hidden = Array.from({ length: MESSAGE_SOURCE_ISSUE_LIMIT + 3 }, (_, index) =>
    ({ id: ch(100 + index), name: `private-${index}`, type: 'text' as const, permissions: 0n }));
  const result = checkPermissions(view({ channels: [...view().channels, ...hidden,
    { id: ch(5), name: 'news', type: 'text', permissions: EVERYTHING & ~F.MentionEveryone }] }), {
    ...off,
    adminTools: tools({ settings: s, announcements: [{ channelId: ch(5), embed: false, mentionEveryone: true, mentionRoleIds: [] }] }),
    intents: { wanted: { guildMembers: true, messageContent: true }, state: { guildMembers: 'missing', messageContent: 'on' } }
  });
  const ids = result.issues.map(issue => issue.featureId);
  assert.ok(ids.includes('tickets.category'), 'deleted category');
  assert.equal(ids.filter(id => id === 'logging.messageSources').length, MESSAGE_SOURCE_ISSUE_LIMIT + 1, 'capped plus a summary');
  assert.ok(!result.issues.some(issue => issue.scope.kind === 'channel' && issue.scope.id === ch(4)), 'ignored channels are skipped');
  assert.equal(result.issues.find(issue => issue.featureId === 'announcements.mention')?.permission, 'Mention @everyone, @here, and All Roles');
  const intent = result.issues.find(issue => issue.kind === 'intent')!;
  assert.equal(intent.permission, 'Server Members Intent');
  assert.equal(intent.severity, 'blocking');
  assert.equal(result.issues[0]!.severity, 'blocking', 'blocking first');
});

test('the monitor debounces bursts into one check and a manual re-check joins the check in flight', async () => {
  let checks = 0;
  const timers: Array<() => void> = [];
  let release: (() => void) | undefined;
  const monitor = new PermissionMonitor({
    debounceMs: 2_000,
    setTimer: callback => { timers.push(callback); return timers.length - 1; },
    clearTimer: handle => { timers[handle as number] = () => {}; },
    check: async () => {
      checks += 1;
      if (checks === 2) await new Promise<void>(resolve => { release = resolve; });
      return { checkedAtMs: checks, ok: true, issues: [], inviteUrl: null, inviteUrlAll: null, permissionsInteger: '0',
        permissionsIntegerAll: '0', botRoleName: null, unavailable: null } satisfies PermissionReportDto;
    },
    onError: () => { throw new Error('unexpected'); }
  });
  let notified = 0;
  monitor.subscribe(() => { notified += 1; });
  for (let index = 0; index < 5; index += 1) monitor.schedule();
  assert.equal(checks, 0, 'nothing before the debounce');
  for (const timer of timers) timer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1, 'one check for the burst');
  assert.equal(monitor.summary()?.checkedAtMs, 1);
  const slow = monitor.recheck();
  await new Promise(resolve => setImmediate(resolve));
  const joined = monitor.recheck();
  release?.();
  const [first, second] = await Promise.all([slow, joined]);
  assert.equal(first.checkedAtMs, 3, 'the joined caller sees a check started after its call');
  assert.equal(second.checkedAtMs, 3);
  assert.equal(notified, 2);
  monitor.close();
  monitor.schedule();
  assert.equal(timers.length, 5, 'closed monitors schedule nothing');
});

test('a failing check becomes an unavailable report', async () => {
  const monitor = new PermissionMonitor({ check: async () => { throw new Error('offline'); },
    onError: () => ({ checkedAtMs: null, ok: false, issues: [], inviteUrl: null, inviteUrlAll: null, permissionsInteger: '0',
      permissionsIntegerAll: '0', botRoleName: null, unavailable: 'Discord is offline.' }) });
  assert.equal((await monitor.recheck()).unavailable, 'Discord is offline.');
  assert.equal(monitor.summary(), null);
});

test('the live report reads discord.js permissions and never includes the token', async () => {
  const token = 'MTAw.SECRET-TOKEN.value';
  const me = { id: '500000000000000001', permissions: { bitfield: EVERYTHING & ~F.BanMembers },
    roles: { highest: { id: role(9), name: 'TCG Live', position: 5 } } };
  const channel = (id: string, name: string, bits: bigint) => ({ id, name, type: 0, isThread: () => false,
    permissionsFor: () => ({ bitfield: bits }) });
  const guild = { id: GUILD, members: { fetchMe: async () => me },
    channels: { cache: new Map([[ch(1), channel(ch(1), 'signup', EVERYTHING & ~F.EmbedLinks)]]) },
    roles: { cache: new Map([[GUILD, { id: GUILD, name: '@everyone', position: 0, managed: false, mentionable: true }]]) } };
  const client = { token, isReady: () => true, guilds: { fetch: async () => guild } } as unknown as Client;
  const report = await livePermissionReport({ client: () => client, guildId: GUILD, applicationId: APP,
    tournament: () => ({ signupChannelId: ch(1), matchChannelIds: [], publicMatchRooms: false, signupMode: true }),
    moderation: async () => null, voiceRuntime: false, adminToolsSettings: async () => settings(), intents: () => null,
    stores: { stickies: { list: async () => { throw new Error('schema missing'); } }, panels: { list: async () => [] },
      bulk: { open: async () => [] }, announcements: { list: async () => [] } }, now: () => 42 });
  assert.equal(report.checkedAtMs, 42);
  assert.deepEqual(report.issues.map(issue => [issue.featureId, issue.permission]),
    [['tournament.signup', 'Embed Links'], ['members.ban', 'Ban Members']]);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|token/i);
  assert.equal(new URL(report.inviteUrl!).searchParams.get('client_id'), APP);
});

test('setup readiness reports the same issues and an invite for the tournament permissions', () => {
  const report = setupPermissionReport({ applicationId: APP, guildId: GUILD, publicMatchRooms: true, checkedAtMs: 1, capabilities: [
    { slot: 'signup', channelId: ch(1), channelName: 'signup', missing: ['Embed Links'] },
    { slot: 'M1', channelId: ch(2), channelName: 'TCG Match M1', missing: ['Connect', 'Move Members'] },
    { slot: 'M2', channelId: ch(3), channelName: 'Channel not visible to bot', missing: ['View Channel'] }] });
  assert.deepEqual(report.issues.map(issue => [issue.featureId, issue.permission, issue.kind]), [
    ['tournament.signup', 'Embed Links', 'permission'], ['tournament.matchRoom', 'Connect', 'permission'],
    ['tournament.publicRoom', 'Move Members', 'permission'], ['tournament.matchRoom', 'View Channel', 'missing']]);
  const bits = BigInt(report.permissionsInteger);
  assert.notEqual(bits & F.MoveMembers, 0n);
  assert.equal(bits & F.BanMembers, 0n, 'setup asks only for tournament permissions');
  assert.equal(new URL(report.inviteUrl!).searchParams.get('guild_id'), GUILD);
});

test('GET /admin-tools/permissions: demo issues, capability, re-check, no token', async () => {
  const unauthorized = await startHarness(demoOpsOptions(), { capabilities: ['dashboard.read'] });
  try {
    const token = await login(unauthorized);
    assert.equal((await call(unauthorized.port, '/api/v1/admin-tools/permissions', { token })).status, 403);
    assert.equal((await call(unauthorized.port, '/api/v1/admin-tools/permissions/recheck', { method: 'POST', token })).status, 403);
  } finally { await unauthorized.stop(); }
  const harness = await startHarness(demoOpsOptions(), { capabilities: ['dashboard.read', 'members.read'] });
  try {
    assert.equal((await call(harness.port, '/api/v1/admin-tools/permissions')).status, 401);
    const token = await login(harness);
    const reply = await call(harness.port, '/api/v1/admin-tools/permissions', { token });
    assert.equal(reply.status, 200, reply.text);
    const report = reply.json() as PermissionReportDto;
    assert.equal(report.ok, false);
    assert.ok(report.issues.some(issue => issue.featureId === 'roles.manage' && issue.permission === 'Manage Roles' && issue.severity === 'blocking'));
    assert.ok(report.issues.some(issue => issue.featureId === 'stickies.post' && issue.kind === 'overwrite' &&
      issue.scope.kind === 'channel' && issue.scope.id === DEMO_CHANNEL_IDS.general));
    assert.equal(new URL(report.inviteUrl!).searchParams.get('client_id'), DEMO_APPLICATION_ID);
    assert.equal(new URL(report.inviteUrl!).searchParams.get('guild_id'), DEMO_GUILD_ID);
    assert.notEqual(BigInt(report.permissionsInteger) & F.ManageRoles, 0n);
    assert.equal(report.permissionsIntegerAll, ALL_FEATURE_PERMISSIONS.toString());
    assert.doesNotMatch(reply.text, /token/i);
    const again = await call(harness.port, '/api/v1/admin-tools/permissions/recheck', { method: 'POST', token });
    assert.equal(again.status, 200, again.text);
  } finally { await harness.stop(); }
  // Without a permission source the route answers 503.
  const audit = new MemoryOpsAuditStore();
  const bare = await startHarness({ adminTools: { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory',
    guildId: () => DEMO_GUILD_ID, status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID), modules: [] } });
  try {
    const token = await login(bare);
    assert.equal((await call(bare.port, '/api/v1/admin-tools/permissions', { token })).status, 503);
  } finally { await bare.stop(); }
});

test('settings saves schedule a re-check', async () => {
  const options = demoOpsOptions();
  let scheduled = 0;
  const source = options.adminTools!.permissions!;
  const original = source.schedule!.bind(source);
  source.schedule = () => { scheduled += 1; original(); };
  const harness = await startHarness(options);
  try {
    const token = await login(harness);
    const put = await call(harness.port, '/api/v1/admin-tools/settings', { method: 'PUT', token,
      body: JSON.stringify({ expectedVersion: 0, settings: settings() }) });
    assert.equal(put.status, 200, put.text);
    assert.equal(scheduled, 1);
  } finally { await harness.stop(); }
});

test('the runtime status carries the permission summary and changes after each check', async () => {
  const runtime = new DemoAdminRuntime();
  const audit = new MemoryOpsAuditStore();
  const monitor = demoPermissionMonitor(createDemoGuild(DEMO_GUILD_ID), new MemoryAdminToolsSettingsStore(audit), () => 7);
  assert.equal('permissions' in runtime.status(), false, 'absent until attached');
  runtime.attachPermissions(monitor);
  assert.equal(runtime.status().permissions, null);
  const changes: string[] = [];
  const unsubscribe = runtime.subscribe(change => { changes.push(change.type); });
  await monitor.recheck();
  await new Promise(resolve => setImmediate(resolve));
  const summary = runtime.status().permissions!;
  assert.equal(summary.checkedAtMs, 7);
  assert.ok(summary.blocking >= 2, 'Manage Roles and the #general sticky');
  assert.ok(changes.includes('status'));
  unsubscribe();
  await runtime.close();
  monitor.close();
});
