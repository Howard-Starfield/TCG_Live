// Behaviours the first review found missing: finished events, adopted rooms, legacy permissions, other applications, locking and full categories.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { createDemoGuild } from '../demo-guild.js';
import { roomPlan } from '../../discord/match-rooms.js';
import { OpsNotFoundError } from '../../ops/errors.js';
import { RuleError } from '../../rehearsal/domain.js';
import type { ActiveEventInfo } from './service.js';
import { flush, roomWorld, TEST_GUILD, withoutDemoRooms } from './testing.js';

const EVENT_1 = '11111111-1111-4111-8111-111111111111';
const EVENT_2 = '22222222-2222-4222-8222-222222222222';
const BOT = '200000000000000099';
const active = (eventId: string, roundRooms: ActiveEventInfo['roundRooms'], finished = false): ActiveEventInfo =>
  ({ eventId, eventName: 'Spring Open', gameLabel: 'One Piece', round: 1, roundRooms, finished });
const emptyWorld = () => roomWorld({ demo: withoutDemoRooms(createDemoGuild(TEST_GUILD)) });
const body = (version: number, template: string) => ({ expectedVersion: version, template, categoryId: null, createCategory: null, baselineChannelIds: [] });
const voice = (id: string, name: string, position: number) => ({ id, name, type: 'voice' as const, parentId: null, position, reserved: false });
const parentOf = (w: { demo: { channels: Array<{ id: string; parentId: string | null }> } }, id: string) => w.demo.channels.find(channel => channel.id === id)?.parentId ?? null;

test('a finished tournament that is still the active session does not block clean-up or removing its rooms', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 2);
  await w.system.start();
  w.event = active(EVENT_1, bound, true);
  const dto = await w.system.service.describe();
  assert.ok(dto.rooms.every(room => room.assignedMatch === null && room.removeBlockedReason === null));
  const plan = await w.system.service.cleanupPlan();
  assert.deepEqual(plan.items.filter(item => item.kind === 'room').map(item => item.action), ['delete', 'delete']);
  const result = await w.system.service.cleanupConfirm(plan.planToken);
  assert.equal(result.deleted.length, 3, 'two rooms and their category');
  await w.system.stop();
});

test('a template change leaves unused adopted rooms alone, but renames bot-made rooms and rooms in a running match', async () => {
  const w = emptyWorld();
  w.demo.channels.push(voice('810000000000000001', 'Lounge', 50), voice('810000000000000002', 'Stage room', 51));
  await w.system.service.adopt('810000000000000001');
  await w.system.service.adopt('810000000000000002');
  const created = (await w.system.service.ensureTables(3)).created;
  w.event = active(EVENT_1, { M2: '810000000000000002' });
  const dto = await w.system.service.saveSettings(body(1, '{table} · {round}'));
  const pending = Object.fromEntries(dto.rooms.map(room => [room.channelId, room.pendingName]));
  assert.equal(pending['810000000000000001'], null, 'an idle adopted room keeps its own name until it is next bound');
  assert.equal(pending['810000000000000002'], 'Table 2 · Round 1', 'a room in the running match follows the template');
  assert.equal(pending[created[0]!], 'Table 3 · Round 1');
});

test('chat of an adopted room is archived but kept when the start of its match is unknown; bot-made rooms are cleared', async () => {
  const w = emptyWorld();
  w.demo.channels.push(voice('810000000000000001', 'Lounge', 50));
  await w.system.service.adopt('810000000000000001');
  const first = await w.publish(EVENT_1, 1);
  w.chatMessages.set(first.M1!, 4);
  w.bindings.unknownStart = true;
  await w.publish(EVENT_2, 1);
  assert.deepEqual(w.chatLog.filter(entry => entry.endsWith(first.M1!)), [`archive:${first.M1}`], 'archived, never cleared');
  assert.equal(w.chatMessages.get(first.M1!), 4);
  assert.equal((await w.transcripts.list(EVENT_1)).length, 1);
  const other = emptyWorld();
  const created = await other.publish(EVENT_1, 1);
  other.chatMessages.set(created.M1!, 2);
  other.bindings.unknownStart = true;
  await other.publish(EVENT_2, 1);
  assert.ok(other.chatLog.includes(`clear:${created.M1}`));
});

test('rooms of another bot application in the server are never listed, changed or deleted', async () => {
  const w = emptyWorld();
  w.demo.channels.push(voice('810000000000000001', 'Other bot room', 50));
  await w.store.insertRoom({ guildId: TEST_GUILD, channelId: '810000000000000001', applicationId: '999999999999999999', tableNo: 9, categoryId: null,
    origin: 'created', customName: null, appliedName: 'Other bot room', desiredName: null, originalName: null, renameLog: [], nextRenameAtMs: null,
    renameError: null, missingSinceMs: null, createdAtMs: 1 });
  await w.publish(EVENT_1, 2);
  const dto = await w.system.service.describe();
  assert.deepEqual(dto.rooms.map(room => room.table), [1, 2]);
  const plan = await w.system.service.cleanupPlan();
  assert.ok(!plan.items.some(item => item.channelId === '810000000000000001'));
  await w.system.service.cleanupConfirm(plan.planToken);
  assert.ok(w.demo.channels.some(item => item.id === '810000000000000001'), 'the other application room is still there');
  assert.equal((await w.store.rooms(TEST_GUILD)).length, 1);
  await assert.rejects(w.system.service.setCustomName('810000000000000001', 'Mine now'), OpsNotFoundError);
});

test('clean-up and room creation never interleave', async () => {
  const w = emptyWorld();
  await w.publish(EVENT_1, 2);
  const log: string[] = [];
  const create = w.discord.createVoice.bind(w.discord);
  const remove = w.discord.deleteChannel.bind(w.discord);
  w.discord.createVoice = async input => { log.push('create:start'); await flush(3); const room = await create(input); log.push('create:end'); return room; };
  w.discord.deleteChannel = async (id, reason) => { log.push('delete'); await remove(id, reason); };
  const plan = await w.system.service.cleanupPlan();
  const [created] = await Promise.allSettled([w.system.service.ensureTables(4), w.system.service.cleanupConfirm(plan.planToken)]);
  assert.equal(created.status, 'fulfilled');
  const deletes = log.map((entry, index) => entry === 'delete' ? index : -1).filter(index => index >= 0);
  const starts = log.indexOf('create:start');
  const ends = log.lastIndexOf('create:end');
  assert.ok(!deletes.length || deletes.every(index => index < starts) || deletes.every(index => index > ends), `no interleaving: ${log.join(',')}`);
});

test('a room keeps a per-channel Manage Roles overwrite it already has, and never gets one it did not have', async () => {
  const w = emptyWorld();
  w.demo.channels.push(voice('810000000000000001', 'TCG Match 1', 50), voice('810000000000000002', 'TCG Match 2', 51));
  const legacy = (manageRoles: boolean) => [{ id: BOT, type: 1 as const, deny: '0',
    allow: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageChannels | (manageRoles ? PermissionFlagsBits.ManageRoles : 0n)) }];
  await w.discord.setOverwrites('810000000000000001', legacy(true), 't');
  await w.discord.setOverwrites('810000000000000002', legacy(false), 't');
  const system = w.build({ legacyChannels: () => ({ M1: '810000000000000001', M2: '810000000000000002' }) });
  const bound = await w.publish(EVENT_1, 3, {}, system);
  const manageRoles = async (id: string) => BigInt((await w.discord.overwrites(id)).find(row => row.id === BOT)!.allow) & PermissionFlagsBits.ManageRoles;
  assert.notEqual(await manageRoles(bound.M1!), 0n, 'the legacy room keeps the overwrite it was set up with');
  assert.equal(await manageRoles(bound.M2!), 0n);
  assert.equal(await manageRoles(bound.M3!), 0n, 'new rooms never get it');
  const plain = roomPlan('100000000000000001', BOT, '910000000000000001', []).find(row => row.id === BOT)!;
  assert.equal(BigInt(plain.allow) & PermissionFlagsBits.ManageRoles, 0n);
  const kept = roomPlan('100000000000000001', BOT, '910000000000000001', [], true).find(row => row.id === BOT)!;
  assert.notEqual(BigInt(kept.allow) & PermissionFlagsBits.ManageRoles, 0n);
});

test('a configured category close to the 50-channel limit spills the remaining tables into a category of the bot', async () => {
  const w = emptyWorld();
  const parent = w.demo.channels.find(channel => channel.type === 'category' && channel.name === 'Play')!;
  await w.store.patchSettings(TEST_GUILD, { categoryId: parent.id }, 1);
  const already = w.demo.channels.filter(channel => channel.parentId === parent.id).length;
  for (let n = 0; n < 48 - already; n++) w.demo.channels.push({ id: `${720000000000000000n + BigInt(n)}`, name: `chat-${n}`, type: 'text', parentId: parent.id, position: 100 + n, reserved: false });
  const bound = await w.publish(EVENT_1, 4);
  assert.equal(parentOf(w, bound.M1!), parent.id);
  assert.equal(parentOf(w, bound.M2!), parent.id);
  assert.equal(w.demo.channels.filter(channel => channel.parentId === parent.id).length, 50);
  assert.notEqual(parentOf(w, bound.M3!), parent.id);
  assert.equal(w.demo.channels.find(channel => channel.id === parentOf(w, bound.M3!))!.name, 'One Piece 1–50');
  assert.equal(parentOf(w, bound.M3!), parentOf(w, bound.M4!));
});

test('Discord refusing a full category is reported in plain words', async () => {
  const w = emptyWorld();
  w.discord.createVoice = async () => { throw Object.assign(new Error('Maximum number of server channels in category reached'), { code: 30013 }); };
  await assert.rejects(w.publish(EVENT_1, 1), (error: unknown) => error instanceof RuleError && /category is full/.test(error.message));
});

test('live path: provision, then describe and clean-up preview with a running event show rooms assigned and skipped; once finished they are deleted and counted for the archive', async () => {
  const w = emptyWorld();
  const bound = await w.publish(EVENT_1, 2);
  w.event = active(EVENT_1, bound);
  const running = await w.system.service.describe();
  assert.deepEqual(running.rooms.map(room => room.assignedMatch), ['M1', 'M2']);
  assert.ok(running.rooms.every(room => room.removeBlockedReason !== null));
  const held = await w.system.service.cleanupPlan();
  assert.ok(held.items.filter(item => item.kind === 'room').every(item => item.action === 'skip'));
  assert.equal(held.transcriptsToArchive, 0);
  w.event = active(EVENT_1, bound, true);
  const done = await w.system.service.cleanupPlan();
  assert.deepEqual(done.items.filter(item => item.kind === 'room').map(item => item.action), ['delete', 'delete']);
  assert.equal(done.transcriptsToArchive, 2, 'each room has a binding to archive');
});
