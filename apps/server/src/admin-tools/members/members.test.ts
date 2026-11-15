import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Capability, EventSnapshotDto } from '@tcg-live/core';
import { liveDispute } from '@tcg-live/core/fixtures';
import { call, login, startHarness, type Harness } from '../../admin/http/test-support.js';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { HttpError } from '../../admin/http/respond.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';
import { createDemoGuild, DEMO_ROLE_IDS, type DemoGuild } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { demoMembersBackend, type MembersBackend, type TargetInfo } from './backend.js';
import { assertCanModerate, membersRouteModule, type MembersModuleOptions } from './routes.js';

const json = (body: unknown) => JSON.stringify(body);
const memberId = (n: number) => `2000000000000${String(n).padStart(5, '0')}`;
const ASH = memberId(1), MISTY = memberId(2), BROCK = memberId(3), BOT = memberId(99);
const DAY = 86_400_000;

interface Setup { harness: Harness; token: string; demo: DemoGuild; audit: MemoryOpsAuditStore; sent: Array<{ to: string; text: string }> }

async function setup(module: MembersModuleOptions = {}, capabilities?: Capability[], extra: Partial<AdminToolsRouteOptions> = {}): Promise<Setup> {
  const audit = new MemoryOpsAuditStore();
  const demo = createDemoGuild(DEMO_GUILD_ID);
  const sent: Array<{ to: string; text: string }> = [];
  const options: AdminToolsRouteOptions = { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory',
    guildId: () => DEMO_GUILD_ID, status: new AdminToolsRuntimeState([], 'demo'), demo,
    modules: [membersRouteModule({ demo: { sent, ...module.demo }, ...module })], ...extra };
  const harness = await startHarness({ adminTools: options }, capabilities ? { capabilities } : {});
  return { harness, token: await login(harness), demo, audit, sent };
}
const act = (s: Setup, body: unknown) => call(s.harness.port, '/api/v1/admin-tools/actions', { method: 'POST', token: s.token, body: json(body) });
const get = (s: Setup, path: string) => call(s.harness.port, `/api/v1/admin-tools/${path}`, { token: s.token });

test('reading needs members.read and acting needs members.moderate', async () => {
  const none = await setup({}, ['dashboard.read']);
  try {
    assert.equal((await get(none, 'members?q=ash')).status, 403);
    assert.equal((await get(none, 'bans')).status, 403);
  } finally { await none.harness.stop(); }
  const reader = await setup({}, ['dashboard.read', 'members.read']);
  try {
    assert.equal((await get(reader, 'members?q=ash')).status, 200);
    assert.equal((await get(reader, 'cases')).status, 200);
    assert.equal((await get(reader, 'mod-audit')).status, 200);
    assert.equal((await act(reader, { action: 'warn', userId: ASH, reason: 'x' })).status, 403);
    const note = await call(reader.harness.port, '/api/v1/admin-tools/notes', { method: 'POST', token: reader.token, body: json({ targetId: ASH, body: 'x' }) });
    assert.equal(note.status, 403);
  } finally { await reader.harness.stop(); }
});

test('action validation: reason required, timeout limits, Discord IDs, no tempbans, no unknown fields', async () => {
  const s = await setup();
  try {
    const bad = async (body: unknown, pattern: RegExp) => {
      const reply = await act(s, body);
      assert.equal(reply.status, 400, `${json(body)} -> ${reply.text}`);
      assert.match(reply.json().error.message, pattern);
    };
    await bad({ action: 'warn', userId: ASH }, /missing/);
    await bad({ action: 'warn', userId: ASH, reason: '   ' }, /Reason/);
    await bad({ action: 'warn', userId: ASH, reason: 'x'.repeat(501) }, /Reason/);
    await bad({ action: 'warn', userId: '123', reason: 'spam' }, /Discord ID/);
    await bad({ action: 'nuke', userId: ASH, reason: 'spam' }, /action/);
    await bad({ action: 'timeout', userId: ASH, reason: 'spam', durationMs: 59_000 }, /28 days/);
    await bad({ action: 'timeout', userId: ASH, reason: 'spam', durationMs: 28 * DAY + 1 }, /28 days/);
    await bad({ action: 'timeout', userId: ASH, reason: 'spam' }, /missing/);
    await bad({ action: 'ban', userId: ASH, reason: 'spam', deleteMessageSeconds: 604_801, durationMs: null }, /Delete messages/);
    await bad({ action: 'ban', userId: ASH, reason: 'spam', deleteMessageSeconds: 0, durationMs: DAY }, /Temporary bans/);
    await bad({ action: 'kick', userId: ASH, reason: 'spam', durationMs: 1 }, /unknown fields/);
    await bad({ action: 'warn', userId: ASH, reason: 'spam', evidenceIds: ['nope'] }, /valid IDs/);
    await bad({ action: 'warn', userId: ASH, reason: 'spam', matchId: 'M1' }, /tournament/);
    assert.equal((await act(s, { action: 'timeout', userId: ASH, reason: 'spam', durationMs: 28 * DAY })).status, 200);
  } finally { await s.harness.stop(); }
});

test('hierarchy and target refusals are clear', () => {
  const base: TargetInfo = { inGuild: true, isOwner: false, isBotSelf: false, targetTop: 3, botTop: 5,
    bot: { ban: true, kick: true, moderate: true, viewAuditLog: true }, timedOutUntilMs: null, banned: false };
  const refused = (action: Parameters<typeof assertCanModerate>[0], patch: Partial<TargetInfo>, status: number, pattern: RegExp) =>
    assert.throws(() => assertCanModerate(action, { ...base, ...patch }), (error: unknown) =>
      error instanceof HttpError && error.status === status && pattern.test(error.message));
  refused('kick', { targetTop: 5 }, 422, /highest role must be above/);
  refused('ban', { targetTop: 6 }, 422, /highest role must be above/);
  refused('warn', { isBotSelf: true }, 422, /itself/);
  refused('timeout', { isOwner: true }, 422, /server owner/);
  refused('kick', { bot: { ...base.bot, kick: false } }, 422, /Kick Members permission/);
  refused('kick', { inGuild: false, targetTop: null }, 404, /not in the server/);
  refused('unban', {}, 404, /not banned/);
  refused('ban', { banned: true }, 409, /already banned/);
  refused('untimeout', {}, 409, /not timed out/);
  assert.doesNotThrow(() => assertCanModerate('ban', { ...base, inGuild: false, targetTop: null }));
  assert.doesNotThrow(() => assertCanModerate('warn', { ...base, targetTop: 9 }));
});

test('routes refuse the bot itself and members above the bot, without using a case number', async () => {
  const s = await setup();
  try {
    s.demo.members.find(member => member.id === MISTY)!.roleIds.push(DEMO_ROLE_IDS.admin);
    const above = await act(s, { action: 'kick', userId: MISTY, reason: 'test' });
    assert.equal(above.status, 422);
    assert.match(above.json().error.message, /bot's highest role/);
    assert.equal((await act(s, { action: 'ban', userId: BOT, reason: 'test', deleteMessageSeconds: 0, durationMs: null })).status, 422);
    const warn = await act(s, { action: 'warn', userId: ASH, reason: 'first' });
    assert.equal(warn.status, 200, warn.text);
    assert.equal(warn.json().case.number, 1);
  } finally { await s.harness.stop(); }
});

test('cases are numbered gap-free; a Discord failure rolls the number back; DM failures never fail the action', async () => {
  let failNext = false;
  const closedDms = new Set([BROCK]);
  const s = await setup({
    demo: { closedDms },
    backend: deps => {
      const inner = demoMembersBackend(deps.demo!, { closedDms });
      const wrapped: MembersBackend = Object.create(inner);
      wrapped.apply = async (...args) => {
        if (failNext) { failNext = false; throw new HttpError(503, 'unavailable', 'Discord did not answer.'); }
        return inner.apply(...args);
      };
      return wrapped;
    }
  });
  try {
    const first = (await act(s, { action: 'warn', userId: ASH, reason: 'Late to table' })).json();
    assert.deepEqual([first.case.number, first.case.kind, first.dm], [1, 'warn', 'sent']);
    failNext = true;
    assert.equal((await act(s, { action: 'kick', userId: ASH, reason: 'No show' })).status, 503);
    const timeout = await act(s, { action: 'timeout', userId: BROCK, reason: 'Toxic', durationMs: DAY });
    assert.equal(timeout.status, 200, timeout.text);
    assert.equal(timeout.json().case.number, 2);
    assert.equal(timeout.json().dm, 'failed');
    assert.ok(timeout.json().case.expiresAtMs > Date.now());
    assert.ok(s.demo.members.find(member => member.id === BROCK)!.timedOutUntilMs! > Date.now());
    const lift = (await act(s, { action: 'untimeout', userId: BROCK, reason: 'Appeal accepted' })).json();
    assert.deepEqual([lift.case.number, lift.dm], [3, 'skipped']);
    const kinds: string[] = (await s.audit.list()).entries.map(entry => entry.kind);
    assert.deepEqual(kinds, ['member.warn', 'member.timeout', 'member.untimeout']);
  } finally { await s.harness.stop(); }
});

test('ban list pages by cursor, links the case, filters, and unban needs a reason', async () => {
  const s = await setup();
  try {
    const ban = await act(s, { action: 'ban', userId: ASH, reason: 'Cheating', deleteMessageSeconds: 3600, durationMs: null });
    assert.equal(ban.status, 200, ban.text);
    assert.ok(s.sent.some(item => item.to === ASH && /banned/.test(item.text)), 'DM sent before the ban');
    const first = (await get(s, 'bans?limit=2')).json();
    assert.equal(first.bans.length, 2);
    assert.ok(first.nextAfter);
    const second = (await get(s, `bans?limit=2&after=${first.nextAfter}`)).json();
    assert.equal(second.bans.length, 2);
    const third = (await get(s, `bans?limit=2&after=${second.nextAfter}`)).json();
    assert.deepEqual([third.bans.length, third.nextAfter], [0, null]);
    const all = [...first.bans, ...second.bans];
    assert.equal(new Set(all.map((item: { userId: string }) => item.userId)).size, 4);
    assert.equal(all.find((item: { userId: string }) => item.userId === ASH).caseNumber, 1);
    assert.equal((await get(s, 'bans?q=spam')).json().bans.length, 1);
    assert.equal((await get(s, 'bans?after=nope')).status, 400);

    assert.equal((await act(s, { action: 'unban', userId: ASH })).status, 400);
    const unban = await act(s, { action: 'unban', userId: ASH, reason: 'Appeal' });
    assert.equal(unban.status, 200, unban.text);
    assert.equal(unban.json().case.number, 2);
    assert.equal((await get(s, 'bans')).json().bans.length, 3);
    assert.equal((await act(s, { action: 'unban', userId: ASH, reason: 'Again' })).status, 404);
  } finally { await s.harness.stop(); }
});

test('search, profile, cases filters, edit and delete, notes and the merged audit trail', async () => {
  const s = await setup({ backend: deps => {
    const inner = demoMembersBackend(deps.demo!);
    const wrapped: MembersBackend = Object.create(inner);
    wrapped.externalAudit = async () => ({ entries: [{ id: '300000000000000001', kind: 'ban', targetId: memberId(102),
      moderatorId: '300000000000000009', reason: 'Right-click ban', occurredAtMs: Date.now() - DAY }], state: 'ok' });
    return wrapped;
  } });
  try {
    const search = (await get(s, 'members?q=mi')).json();
    assert.deepEqual(search.members.map((member: { username: string }) => member.username).sort(), ['mihawk', 'misty']);
    assert.equal((await get(s, `members?q=${ASH}`)).json().members[0].username, 'ash');
    assert.equal((await get(s, 'members?q=')).status, 400);
    assert.equal((await get(s, 'members?q=a&limit=26')).status, 400);
    const truncated = (await get(s, 'members?q=a&limit=1')).json();
    assert.deepEqual([truncated.members.length, truncated.truncated], [1, true]);

    await act(s, { action: 'warn', userId: ASH, reason: 'one' });
    await act(s, { action: 'warn', userId: MISTY, reason: 'two' });
    await act(s, { action: 'timeout', userId: ASH, reason: 'three', durationMs: 3_600_000 });
    const cases = (await get(s, `cases?targetId=${ASH}`)).json();
    assert.deepEqual(cases.cases.map((item: { number: number }) => item.number), [3, 1]);
    assert.equal((await get(s, 'cases?kind=warn&limit=1')).json().nextBefore, 2);
    assert.equal((await get(s, 'cases?kind=nope')).status, 400);
    assert.equal((await get(s, 'cases/2')).json().targetId, MISTY);
    assert.equal((await get(s, 'cases/99')).status, 404);

    const put = (path: string, body: unknown, method = 'PUT') => call(s.harness.port, `/api/v1/admin-tools/${path}`, { method, token: s.token, body: json(body) });
    const evidence = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const edited = await put('cases/1', { reason: 'one, edited', evidenceIds: [evidence] });
    assert.equal(edited.status, 200, edited.text);
    assert.deepEqual([edited.json().reason, edited.json().evidenceIds], ['one, edited', [evidence]]);
    assert.equal((await put('cases/1', {})).status, 400);
    assert.equal((await put('cases/2', {}, 'DELETE')).status, 400);
    assert.equal((await put('cases/2', { reason: 'Mistake' }, 'DELETE')).status, 200);
    assert.equal((await get(s, 'cases/2')).status, 404);
    // Numbers are never reused after a delete.
    assert.equal((await act(s, { action: 'warn', userId: MISTY, reason: 'four' })).json().case.number, 4);

    const note = await put('notes', { targetId: ASH, body: 'Talks over opponents.' }, 'POST');
    assert.equal(note.status, 201, note.text);
    assert.equal((await put(`notes/${note.json().id}`, { body: 'Updated note' })).json().body, 'Updated note');
    await put('notes', { targetId: ASH, body: 'Second' }, 'POST');
    assert.equal((await put(`notes/${note.json().id}`, {}, 'DELETE')).status, 200);
    assert.equal((await put(`notes/${note.json().id}`, { body: 'x' })).status, 404);
    assert.equal((await put('notes', { targetId: ASH, body: ' ' }, 'POST')).status, 400);

    const profile = (await get(s, `members/${ASH}`)).json();
    assert.deepEqual([profile.username, profile.caseCount, profile.noteCount, profile.cases.length, profile.notes[0].body],
      ['ash', 2, 1, 2, 'Second']);
    assert.ok(profile.flags.timedOutUntilMs > Date.now());
    assert.deepEqual(profile.tournaments, []);
    const banned = (await get(s, `members/${memberId(101)}`)).json();
    assert.deepEqual([banned.flags.banned, banned.flags.left, banned.username], [true, true, 'spam-bot-3000']);
    assert.equal((await get(s, 'members/400000000000000000')).status, 404);
    assert.equal((await get(s, 'members/abc')).status, 400);

    const trail = (await get(s, 'mod-audit')).json();
    assert.equal(trail.discordAudit, 'ok');
    assert.deepEqual(trail.entries.map((entry: { source: string; caseNumber: number | null }) => [entry.source, entry.caseNumber]),
      [['dashboard', 4], ['dashboard', 3], ['dashboard', 1], ['external', null]]);
    const kinds: string[] = (await s.audit.list()).entries.map(entry => entry.kind);
    for (const kind of ['member.case.updated', 'member.note.added', 'member.note.updated', 'member.note.deleted']) assert.ok(kinds.includes(kind), kind);
  } finally { await s.harness.stop(); }
});

test('the audit trail degrades to our cases when the bot cannot view the audit log', async () => {
  const s = await setup({ backend: deps => {
    const wrapped: MembersBackend = Object.create(demoMembersBackend(deps.demo!));
    wrapped.externalAudit = async () => ({ entries: [], state: 'missing-permission' });
    return wrapped;
  } });
  try {
    await act(s, { action: 'warn', userId: ASH, reason: 'one' });
    const trail = (await get(s, 'mod-audit')).json();
    assert.equal(trail.discordAudit, 'missing-permission');
    assert.equal(trail.entries.length, 1);
  } finally { await s.harness.stop(); }
});

test('tournament history comes from the runtime event snapshots', async () => {
  const s = await setup();
  try {
    const snapshot = liveDispute as EventSnapshotDto;
    const player = Object.values(snapshot.seats).find(Boolean)!;
    s.demo.members.push({ ...structuredClone(s.demo.members[0]!), id: player, username: 'seated-player' });
    const profile = (await get(s, `members/${player}`)).json();
    assert.deepEqual(profile.tournaments.map((ref: { eventId: string; role: string }) => [ref.eventId, ref.role]), [[snapshot.eventId, 'player']]);
    assert.deepEqual((await get(s, `members/${ASH}`)).json().tournaments, []);
  } finally { await s.harness.stop(); }
});
