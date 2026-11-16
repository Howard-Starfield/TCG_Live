import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Collection, GatewayIntentBits, PermissionFlagsBits, type Guild } from 'discord.js';
import { TOURNAMENT_ROLE_DEFAULTS } from '@tcg-live/core';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { call, login, startHarness } from '../../admin/http/test-support.js';
import { LOCAL_ADMIN, MemoryOpsAuditStore } from '../../ops/audit.js';
import { SetupProfileStore } from '../../onboarding/profile.js';
import { createDemoGuild, DEMO_ORGANIZER_ID, DEMO_ROLE_IDS, type DemoGuild } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { DemoTournamentRolesPort, discordTournamentRolesPort, tournamentRoleHolders } from './port.js';
import { tournamentRolesRouteModule } from './routes.js';
import { describeTournamentRoles, ensureTournamentRoles } from './service.js';
import { MemoryTournamentRoleStore, profileTournamentRoleStore } from './store.js';

const member = (n: number) => `2000000000000${String(n).padStart(5, '0')}`;
const ACTOR = { kind: 'admin', id: 'test' } as const;

/** A demo server without the seeded TCG roles, as an existing install has it. */
function bareGuild(): DemoGuild {
  const demo = createDemoGuild(DEMO_GUILD_ID);
  demo.roles = demo.roles.filter(role => role.id !== DEMO_ROLE_IDS.tcgOrganizer && role.id !== DEMO_ROLE_IDS.tcgJudge);
  for (const person of demo.members) person.roleIds = person.roleIds.filter(id => id !== DEMO_ROLE_IDS.tcgOrganizer && id !== DEMO_ROLE_IDS.tcgJudge);
  return demo;
}

test('ensure creates both roles with no permissions directly under the bot, and assigns Organizer', async () => {
  const demo = bareGuild();
  const port = new DemoTournamentRolesPort(demo);
  const store = new MemoryTournamentRoleStore();
  const result = await ensureTournamentRoles(port, store, DEMO_GUILD_ID, member(3), ACTOR);
  assert.deepEqual(result, { organizer: 'created', judge: 'created', assigned: member(3), problem: null });
  const ids = await store.get(DEMO_GUILD_ID);
  const state = await port.describe();
  const organizer = state.roles.find(role => role.id === ids.organizerRoleId)!;
  const judge = state.roles.find(role => role.id === ids.judgeRoleId)!;
  assert.deepEqual([organizer.name, judge.name], [TOURNAMENT_ROLE_DEFAULTS.organizer.name, TOURNAMENT_ROLE_DEFAULTS.judge.name]);
  assert.deepEqual([organizer.permissions, judge.permissions], [0n, 0n]);
  assert.ok(organizer.position < state.botTop.position && judge.position < state.botTop.position);
  assert.ok(Math.max(organizer.position, judge.position) === state.botTop.position - 1, 'one of them sits directly under the bot');
  assert.ok(demo.members.find(person => person.id === member(3))!.roleIds.includes(organizer.id));
});

test('a rerun adopts by stored ID; a same-named role without a stored ID is not adopted', async () => {
  const demo = bareGuild();
  const port = new DemoTournamentRolesPort(demo);
  const store = new MemoryTournamentRoleStore();
  await ensureTournamentRoles(port, store, DEMO_GUILD_ID, member(3), ACTOR);
  const count = demo.roles.length;
  assert.deepEqual(await ensureTournamentRoles(port, store, DEMO_GUILD_ID, member(3), ACTOR),
    { organizer: 'adopted', judge: 'adopted', assigned: member(3), problem: null });
  assert.equal(demo.roles.length, count, 'nothing new was created');

  // A role called "TCG Judge" that the store does not know (another bot, or a hand-made role) is left alone.
  const fresh = bareGuild();
  fresh.roles.push({ id: member(777), name: 'TCG Judge', color: 0, position: 3, managed: false, aboveBot: false, elevated: false });
  const other = new MemoryTournamentRoleStore();
  const created = await ensureTournamentRoles(new DemoTournamentRolesPort(fresh), other, DEMO_GUILD_ID, member(3), ACTOR);
  assert.equal(created.judge, 'created');
  assert.notEqual((await other.get(DEMO_GUILD_ID)).judgeRoleId, member(777));
});

test('a role deleted in Discord is reported, then recreated by ensure', async () => {
  const demo = bareGuild();
  const port = new DemoTournamentRolesPort(demo);
  const store = new MemoryTournamentRoleStore();
  await ensureTournamentRoles(port, store, DEMO_GUILD_ID, member(3), ACTOR);
  const { judgeRoleId } = await store.get(DEMO_GUILD_ID);
  demo.roles = demo.roles.filter(role => role.id !== judgeRoleId);
  const described = await describeTournamentRoles(port, store, DEMO_GUILD_ID, []);
  const judge = described.roles.find(role => role.kind === 'judge')!;
  assert.equal(judge.problem, 'missing');
  assert.match(judge.problemText!, /deleted/);
  assert.equal(described.roles.find(role => role.kind === 'organizer')!.problem, null);
  const again = await ensureTournamentRoles(port, store, DEMO_GUILD_ID, member(3), ACTOR);
  assert.deepEqual([again.organizer, again.judge], ['adopted', 'created']);
  assert.notEqual((await store.get(DEMO_GUILD_ID)).judgeRoleId, judgeRoleId);
});

test('role failures never throw: they are reported', async () => {
  const demo = bareGuild();
  const port = new DemoTournamentRolesPort(demo);
  port.failChanges = true;
  const result = await ensureTournamentRoles(port, new MemoryTournamentRoleStore(), DEMO_GUILD_ID, member(3), ACTOR);
  assert.deepEqual([result.organizer, result.judge, result.assigned], ['failed', 'failed', null]);
  assert.match(result.problem!, /Could not create TCG Organizer.*missing permissions/i);

  const noManage = new DemoTournamentRolesPort(bareGuild());
  noManage.describe = async () => ({ ...(await DemoTournamentRolesPort.prototype.describe.call(noManage)), canManageRoles: false });
  const refused = await ensureTournamentRoles(noManage, new MemoryTournamentRoleStore(), DEMO_GUILD_ID, member(3), ACTOR);
  assert.deepEqual([refused.organizer, refused.judge], ['failed', 'failed']);
  assert.match(refused.problem!, /Manage Roles/);
  const described = await describeTournamentRoles(noManage, new MemoryTournamentRoleStore(), DEMO_GUILD_ID, []);
  assert.deepEqual(described.roles.map(role => role.problem), ['no-manage-roles', 'no-manage-roles']);
});

test('assigning refuses managed, above-bot and elevated roles', async () => {
  for (const [problem, change] of [
    ['managed', (role: DemoGuild['roles'][number]) => { role.managed = true; }],
    ['above-bot', (role: DemoGuild['roles'][number]) => { role.position = 99; role.aboveBot = true; }],
    ['elevated', (role: DemoGuild['roles'][number]) => { role.elevated = true; }]
  ] as const) {
    const demo = createDemoGuild(DEMO_GUILD_ID);
    change(demo.roles.find(role => role.id === DEMO_ROLE_IDS.tcgOrganizer)!);
    const store = new MemoryTournamentRoleStore({ guildId: DEMO_GUILD_ID, organizerRoleId: DEMO_ROLE_IDS.tcgOrganizer, judgeRoleId: DEMO_ROLE_IDS.tcgJudge });
    const result = await ensureTournamentRoles(new DemoTournamentRolesPort(demo), store, DEMO_GUILD_ID, member(3), ACTOR);
    assert.equal(result.assigned, null, problem);
    assert.ok(result.problem, problem);
    assert.equal(demo.members.find(person => person.id === member(3))!.roleIds.includes(DEMO_ROLE_IDS.tcgOrganizer), false, problem);
    const described = await describeTournamentRoles(new DemoTournamentRolesPort(demo), store, DEMO_GUILD_ID, []);
    assert.equal(described.roles[0]!.problem, problem);
  }
});

test('describe lists members and legacy staff roles; above-bot text names the roles to move', async () => {
  const demo = createDemoGuild(DEMO_GUILD_ID);
  const store = new MemoryTournamentRoleStore({ guildId: DEMO_GUILD_ID, organizerRoleId: DEMO_ROLE_IDS.tcgOrganizer, judgeRoleId: DEMO_ROLE_IDS.tcgJudge });
  const described = await describeTournamentRoles(new DemoTournamentRolesPort(demo), store, DEMO_GUILD_ID, [DEMO_ROLE_IDS.judge]);
  assert.deepEqual(described.roles.map(role => [role.kind, role.members.map(item => item.id), role.membersComplete]),
    [['organizer', [DEMO_ORGANIZER_ID], true], ['judge', [member(2)], true]]);
  assert.deepEqual([described.ownerId, described.legacyStaffRoleIds], [DEMO_ORGANIZER_ID, [DEMO_ROLE_IDS.judge]]);
  assert.equal(described.botTopRole!.name, 'TCG Live');
  demo.roles.find(role => role.id === DEMO_ROLE_IDS.tcgJudge)!.position = 99;
  const above = (await describeTournamentRoles(new DemoTournamentRolesPort(demo), store, DEMO_GUILD_ID, [])).roles[1]!;
  assert.equal(above.problem, 'above-bot');
  assert.equal(above.problemText, 'Move the TCG Live role above TCG Judge in Server Settings > Roles.');
});

test('the profile round-trips roles per guild, keeps them across other saves, and rejects bad IDs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tcg-roles-test-'));
  try {
    const profile = new SetupProfileStore(path.join(directory, 'data', 'discord-setup.json'));
    const store = profileTournamentRoleStore(profile);
    assert.deepEqual(await store.get(DEMO_GUILD_ID), { guildId: DEMO_GUILD_ID, organizerRoleId: null, judgeRoleId: null });
    const saved = { guildId: DEMO_GUILD_ID, organizerRoleId: '300000000000000001', judgeRoleId: '300000000000000002' };
    await store.set(saved);
    assert.deepEqual(await store.get(DEMO_GUILD_ID), saved);
    assert.deepEqual(await store.get('100000000000000002'), { guildId: '100000000000000002', organizerRoleId: null, judgeRoleId: null });
    // A save without a roles key keeps them; null clears them.
    await profile.save({ selection: null, guide: null, completed: true });
    assert.deepEqual((await profile.read()).roles, saved);
    await profile.updateSwitches(current => ({ ...current, voiceMonitoring: true }));
    assert.deepEqual((await profile.read()).roles, saved);
    await profile.save({ selection: null, guide: null, completed: true, roles: null });
    assert.equal((await profile.read()).roles, undefined);
    assert.equal(JSON.parse(await readFile(profile.file, 'utf8')).roles, undefined);
    await assert.rejects(() => store.set({ ...saved, judgeRoleId: 'nope' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// ---- routes

function options(demo = createDemoGuild(DEMO_GUILD_ID)): AdminToolsRouteOptions {
  const audit = new MemoryOpsAuditStore();
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo, modules: [tournamentRolesRouteModule()] };
}
const BASE = '/api/v1/admin-tools/tournament-roles';

test('routes: the demo seeds both roles, edits are validated and audited, members can be added and removed', async () => {
  const adminTools = options();
  const harness = await startHarness({ adminTools });
  try {
    const token = await login(harness);
    const request = (suffix: string, method = 'GET', payload?: unknown) =>
      call(harness.port, `${BASE}${suffix}`, { method, token, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const read = (await request('')).json();
    assert.deepEqual(read.roles.map((role: { kind: string; name: string }) => [role.kind, role.name]),
      [['organizer', 'TCG Organizer'], ['judge', 'TCG Judge']]);
    assert.deepEqual(read.roles[0].members.map((item: { id: string }) => item.id), [DEMO_ORGANIZER_ID]);

    assert.equal((await request('/judge', 'PATCH', { name: '  ' })).status, 400);
    assert.equal((await request('/judge', 'PATCH', { color: 0x1000000 })).status, 400);
    assert.equal((await request('/judge', 'PATCH', { color: 1.5 })).status, 400);
    assert.equal((await request('/judge', 'PATCH', {})).status, 400);
    assert.equal((await request('/judge', 'PATCH', { name: 'Referee', colour: 1 })).status, 400);
    assert.equal((await request('/judge', 'PATCH', { name: 'Referee', color: 0x1ABC9C })).status, 200);
    const edited = (await request('')).json().roles[1];
    assert.deepEqual([edited.name, edited.color], ['Referee', 0x1ABC9C]);

    assert.equal((await request(`/judge/members/${member(5)}`, 'PUT')).status, 200);
    assert.ok(adminTools.demo!.members.find(person => person.id === member(5))!.roleIds.includes(DEMO_ROLE_IDS.tcgJudge));
    assert.equal((await request(`/judge/members/${member(5)}`, 'DELETE')).status, 200);
    assert.equal(adminTools.demo!.members.find(person => person.id === member(5))!.roleIds.includes(DEMO_ROLE_IDS.tcgJudge), false);
    assert.equal((await request('/judge/members/123', 'PUT')).status, 400);
    assert.equal((await request(`/judge/members/${member(950)}`, 'PUT')).status, 409, 'not in the server');
    assert.equal((await request('/referee', 'PATCH', { name: 'x' })).status, 404);

    assert.deepEqual((await adminTools.audit.list()).entries.map(entry => [entry.kind, entry.actorId]),
      [['tournament_roles.updated', LOCAL_ADMIN.id], ['tournament_roles.member_added', LOCAL_ADMIN.id],
        ['tournament_roles.member_removed', LOCAL_ADMIN.id]]);
  } finally { await harness.stop(); }
});

test('routes: ensure creates roles on a bare server, defaults the organizer to the owner, and is audited', async () => {
  const demo = bareGuild();
  const adminTools = options(demo);
  const harness = await startHarness({ adminTools });
  try {
    const token = await login(harness);
    const request = (suffix: string, method = 'GET', payload?: unknown) =>
      call(harness.port, `${BASE}${suffix}`, { method, token, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const before = (await request('')).json();
    assert.deepEqual(before.roles.map((role: { problem: string }) => role.problem), ['not-created', 'not-created']);
    assert.equal((await request('/judge/members/' + member(5), 'PUT')).status, 409, 'cannot assign a role that does not exist');
    assert.equal((await request('/ensure', 'POST', { organizerId: 'x' })).status, 400);
    const ensured = await request('/ensure', 'POST');
    assert.equal(ensured.status, 200, ensured.text);
    assert.deepEqual(ensured.json(), { organizer: 'created', judge: 'created', assigned: DEMO_ORGANIZER_ID, problem: null });
    const after = (await request('')).json();
    assert.deepEqual(after.roles.map((role: { problem: unknown; members: unknown[] }) => [role.problem, role.members.length]), [[null, 1], [null, 0]]);
    assert.deepEqual((await adminTools.audit.list()).entries.map(entry => entry.kind),
      ['tournament_roles.created', 'tournament_roles.member_added']);
    assert.deepEqual((await request('/ensure', 'POST', { organizerId: member(4) })).json(),
      { organizer: 'adopted', judge: 'adopted', assigned: member(4), problem: null });
  } finally { await harness.stop(); }
});

test('routes: reads need members.read, changes need server.manage', async () => {
  const harness = await startHarness({ adminTools: options() }, { capabilities: ['dashboard.read', 'members.read'] });
  try {
    const token = await login(harness);
    assert.equal((await call(harness.port, BASE)).status, 401);
    assert.equal((await call(harness.port, BASE, { token })).status, 200);
    for (const [method, suffix] of [['POST', '/ensure'], ['PATCH', '/judge'], ['PUT', `/judge/members/${member(1)}`],
      ['DELETE', `/judge/members/${member(1)}`]] as const) {
      const reply = await call(harness.port, `${BASE}${suffix}`, { method, token, ...(method === 'PATCH' ? { body: '{"name":"x"}' } : {}) });
      assert.equal(reply.status, 403, `${method} ${suffix}`);
    }
  } finally { await harness.stop(); }
  const none = await startHarness({ adminTools: options() }, { capabilities: ['dashboard.read'] });
  try { assert.equal((await call(none.port, BASE, { token: await login(none) })).status, 403); } finally { await none.stop(); }
});

test('routes: a role that is elevated cannot be given out, but can still be renamed and emptied', async () => {
  const demo = createDemoGuild(DEMO_GUILD_ID);
  demo.roles.find(role => role.id === DEMO_ROLE_IDS.tcgJudge)!.elevated = true;
  const harness = await startHarness({ adminTools: options(demo) });
  try {
    const token = await login(harness);
    const request = (suffix: string, method = 'GET', payload?: unknown) =>
      call(harness.port, `${BASE}${suffix}`, { method, token, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const put = await request(`/judge/members/${member(5)}`, 'PUT');
    assert.equal(put.status, 409);
    assert.match(put.json().message ?? put.text, /staff permissions/);
    assert.equal((await request('/judge', 'PATCH', { name: 'Referee' })).status, 200);
    assert.equal((await request(`/judge/members/${member(2)}`, 'DELETE')).status, 200);
  } finally { await harness.stop(); }
});

// ---- the live Discord port, against a hand-made guild

function liveGuild(options: { intents: boolean; cached?: number }) {
  const created: Array<Record<string, unknown>> = [];
  const moves: Array<[string, number]> = [];
  const fetched: string[] = [];
  const everyone = '900000000000000000';
  const roleMap = new Collection<string, { id: string; name: string; colors: { primaryColor: number }; position: number; managed: boolean; permissions: { bitfield: bigint } }>();
  roleMap.set('810000000000000001', { id: '810000000000000001', name: 'TCG Live', colors: { primaryColor: 0 }, position: 7, managed: true, permissions: { bitfield: 8n } });
  const person = (id: string, roleIds: string[]) => ({ id, displayName: `name-${id.slice(-2)}`, displayAvatarURL: () => `https://cdn.example/${id}.png`,
    roles: { cache: new Collection(roleIds.map(role => [role, {}])) } });
  const members = new Collection<string, ReturnType<typeof person>>();
  for (let index = 0; index < (options.cached ?? 0); index += 1) members.set(`7${String(index).padStart(17, '0')}`, person(`7${String(index).padStart(17, '0')}`, ['820000000000000001']));
  const guild = { id: everyone, ownerId: '700000000000000099', memberCount: 50,
    client: { options: { intents: { has: (bit: number) => options.intents && bit === GatewayIntentBits.GuildMembers } } },
    roles: { async fetch() { return roleMap; },
      async create(data: Record<string, unknown>) {
        created.push(data);
        const role = { id: `82000000000000000${created.length}`, name: String(data.name), colors: data.colors as { primaryColor: number },
          position: 1, managed: false, permissions: { bitfield: data.permissions as bigint } };
        roleMap.set(role.id, role);
        return role;
      },
      async setPosition(role: { id: string; position: number }, position: number) { moves.push([role.id, position]); role.position = position; return role; } },
    members: { cache: members,
      async fetchMe() { return { roles: { highest: { id: '810000000000000001', name: 'TCG Live', position: 7 } }, permissions: { has: (bit: bigint) => bit === PermissionFlagsBits.ManageRoles } }; },
      async fetch(id?: string) {
        if (id === undefined) throw new Error('fetch-all');
        fetched.push(id);
        return id === guild.ownerId ? person(id, ['820000000000000001']) : person(id, []);
      } } };
  return { guild: guild as unknown as Guild, created, moves, fetched };
}

test('the live port creates a role with permissions 0n and the colour as colors.primaryColor, then moves it under the bot', async () => {
  const live = liveGuild({ intents: true });
  const port = discordTournamentRolesPort(live.guild);
  const role = await port.create('organizer');
  assert.deepEqual(live.created, [{ name: 'TCG Organizer', colors: { primaryColor: 0xE67E22 }, permissions: 0n, hoist: false,
    mentionable: false, reason: 'TCG Live tournament role' }]);
  assert.deepEqual(live.moves, [[role.id, 6]]);
  assert.deepEqual([role.permissions, role.position, role.color], [0n, 6, 0xE67E22]);
  const described = await port.describe();
  assert.deepEqual([described.botTop.position, described.canManageRoles, described.ownerId], [7, true, '700000000000000099']);
});

test('without the Server Members intent the holder list is the cache, the owner and per-ID fetches, and is marked incomplete', async () => {
  const off = liveGuild({ intents: false, cached: 2 });
  const result = await tournamentRoleHolders(off.guild, ['820000000000000001'], false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.ids.sort(), ['700000000000000000', '700000000000000001', '700000000000000099']);
  assert.deepEqual(off.fetched, ['700000000000000099']);

  const port = discordTournamentRolesPort(off.guild);
  const holders = await port.holders(['820000000000000001'], ['700000000000000555']);
  assert.equal(holders.complete, false);
  assert.ok(off.fetched.includes('700000000000000555'), 'candidate IDs are fetched one by one');

  // With the intent a failed full fetch still falls back and says so.
  const on = liveGuild({ intents: true, cached: 1 });
  const partial = await tournamentRoleHolders(on.guild, ['820000000000000001'], true);
  assert.equal(partial.complete, false);
  assert.ok(partial.ids.includes('700000000000000099'));
  assert.deepEqual(await tournamentRoleHolders(on.guild, [], true), { ids: [], complete: true });
});

test('concurrent ensures for one guild create exactly one pair of roles', async () => {
  const demo = bareGuild();
  const port = new DemoTournamentRolesPort(demo);
  const store = new MemoryTournamentRoleStore();
  const slow = port.create.bind(port);
  port.create = async kind => { await new Promise(resolve => setTimeout(resolve, 5)); return slow(kind); };
  const before = demo.roles.length;
  const results = await Promise.all([1, 2, 3].map(() => ensureTournamentRoles(port, store, DEMO_GUILD_ID, member(3), ACTOR)));
  assert.equal(demo.roles.length, before + 2);
  assert.deepEqual(results.map(result => [result.organizer, result.judge]), [['created', 'created'], ['adopted', 'adopted'], ['adopted', 'adopted']]);
  assert.ok(results.every(result => result.assigned === member(3)));
});

test('routes: an unreadable setup profile answers 503 with a profile message, not a Discord error', async () => {
  const broken = { async get(): Promise<never> { throw new Error('EACCES'); }, async set(): Promise<never> { throw new Error('EACCES'); } };
  const audit = new MemoryOpsAuditStore();
  const adminTools: AdminToolsRouteOptions = { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory',
    guildId: () => DEMO_GUILD_ID, status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [tournamentRolesRouteModule({ store: broken })] };
  const harness = await startHarness({ adminTools });
  try {
    const token = await login(harness);
    for (const [method, suffix, body] of [['GET', '', undefined], ['PATCH', '/judge', '{"name":"x"}'],
      ['PUT', `/judge/members/${member(5)}`, undefined], ['DELETE', `/judge/members/${member(5)}`, undefined]] as const) {
      const reply = await call(harness.port, `${BASE}${suffix}`, { method, token, ...(body ? { body } : {}) });
      assert.equal(reply.status, 503, `${method} ${suffix}`);
      assert.match(reply.text, /discord-setup\.json/);
    }
    // ensure reports it instead of creating roles it could not save.
    const ensured = await call(harness.port, `${BASE}/ensure`, { method: 'POST', token });
    assert.equal(ensured.status, 200);
    assert.deepEqual([ensured.json().organizer, ensured.json().judge], ['failed', 'failed']);
  } finally { await harness.stop(); }
});
