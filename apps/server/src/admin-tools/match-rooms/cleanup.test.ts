import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MatchRoomTranscriptMessageDto, OpsAuditKind } from '@tcg-live/core';
import { RuleError } from '../../rehearsal/domain.js';
import { buildCleanupPlan, cleanupPlanToken, executeCleanup, type CleanupDeps, type CleanupPlanInput, type CleanupRoomInput } from './cleanup.js';
import { MemoryTranscriptStore, type RoomChatPort } from './transcripts.js';

const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const room = (id: string, patch: Partial<CleanupRoomInput> = {}): CleanupRoomInput => ({ channelId: id, name: `room ${id}`, origin: 'created', categoryId: 'C1',
  originalName: null, boundEventId: null, binding: { eventId: OTHER, matchId: 'M1', startedAtMs: 0 }, ...patch });

function plan(rooms: CleanupRoomInput[], patch: Partial<CleanupPlanInput> = {}) {
  return buildCleanupPlan({ rooms, categories: [{ categoryId: 'C1', name: 'Matches', origin: 'created' }], baselineIds: [], activeEventId: null,
    occupancy: Object.fromEntries(rooms.map(item => [item.channelId, 0])), overwriteBackups: {}, ...patch });
}
const actions = (built: ReturnType<typeof plan>) => Object.fromEntries(built.items.map(item => [`${item.kind}:${item.channelId}`, item.action]));

test('the plan deletes only created, non-baseline rooms and categories, restores adopted rooms and keeps baseline channels', () => {
  const built = plan([room('1'), room('2', { origin: 'adopted', originalName: 'Lounge' }), room('3'), room('4', { categoryId: 'C2' })],
    { baselineIds: ['3'], categories: [{ categoryId: 'C1', name: 'Matches', origin: 'created' }, { categoryId: 'C2', name: 'Mine', origin: 'configured' },
      { categoryId: 'C3', name: 'Base', origin: 'created' }], overwriteBackups: { 2: {} } });
  assert.deepEqual(actions(built), { 'room:1': 'delete', 'room:2': 'restore', 'room:3': 'keep', 'room:4': 'delete', 'category:C1': 'skip',
    'category:C2': 'keep', 'category:C3': 'delete' });
  assert.equal(built.items.find(item => item.channelId === '2')!.restoreName, 'Lounge');
  assert.match(built.items.find(item => item.channelId === '2')!.reason, /backup/);
  assert.equal(built.transcriptsToArchive, 2);
  assert.match(built.items.find(item => item.channelId === 'C1')!.reason, /Still holds 2 rooms that stay/);
});

test('a created category whose baseline membership or origin protects it is kept, and an emptied one is deleted', () => {
  assert.equal(actions(plan([room('1')]))['category:C1'], 'delete');
  assert.equal(actions(plan([room('1')], { baselineIds: ['C1'] }))['category:C1'], 'keep');
  assert.equal(actions(plan([room('1')], { categories: [{ categoryId: 'C1', name: null, origin: 'configured' }] }))['category:C1'], 'keep');
});

test('occupied, unknown-occupancy and active-event rooms are skipped with reasons; adopted rooms are never deleted even outside the baseline', () => {
  const built = plan([room('1'), room('2'), room('3', { boundEventId: EVENT }), room('4', { origin: 'adopted' }), room('5', { origin: 'adopted', missing: true })],
    { activeEventId: EVENT, occupancy: { 1: 2, 2: null, 3: 0, 4: 1, 5: 0 } });
  assert.deepEqual(actions(built), { 'room:1': 'skip', 'room:2': 'skip', 'room:3': 'skip', 'room:4': 'skip', 'room:5': 'skip', 'category:C1': 'skip' });
  assert.match(built.items[0]!.reason, /2 people are connected/);
  assert.match(built.items[1]!.reason, /Couldn't check/);
  assert.match(built.items[2]!.reason, /active event/);
  assert.equal(built.items.some(item => item.action === 'delete'), false);
  assert.equal(actions(plan([room('1', { boundEventId: OTHER })], { activeEventId: EVENT }))['room:1'], 'delete', 'bound to a finished event is fine');
});

test('the token follows the actions, not the labels, and a tampered plan is refused', () => {
  const first = plan([room('1')]);
  assert.equal(plan([room('1', { name: 'renamed' })]).planToken, first.planToken);
  assert.notEqual(plan([room('1')], { occupancy: { 1: 1 } }).planToken, first.planToken);
  assert.notEqual(plan([room('1'), room('2')]).planToken, first.planToken);
  assert.equal(cleanupPlanToken(first.eventId, first.items), first.planToken);
});

function harness(patch: Partial<CleanupDeps> = {}, messages: MatchRoomTranscriptMessageDto[] = [{ id: '1', authorId: '4', authorName: 'A', createdAtMs: 1, content: 'hi', attachments: [] }]) {
  const log: string[] = [];
  const audits: Array<{ kind: OpsAuditKind; payload: Record<string, unknown>; actor: { kind: string; id: string } }> = [];
  const children = new Map<string, number | null>([['C1', 0]]);
  const chat: RoomChatPort = {
    fetchMessages: async channelId => { log.push(`fetch:${channelId}`); return { messages, contentAvailable: true }; },
    bulkDelete: async (channelId, ids) => { log.push(`clear:${channelId}`); return { deleted: ids.length, skippedOld: 0 }; }
  };
  const deps: CleanupDeps = {
    chat, store: new MemoryTranscriptStore(() => 1),
    audit: async (kind, payload, actor) => { audits.push({ kind, payload, actor }); },
    channels: { deleteChannel: async id => { log.push(`delete:${id}`); }, childCount: async id => children.get(id) ?? 0 },
    bindingOf: async () => ({ eventId: OTHER, matchId: 'M1', startedAtMs: 0 }),
    renames: { request: (id, name) => { log.push(`rename:${id}:${name}`); } },
    restoreOverwrites: async id => { log.push(`overwrites:${id}`); },
    dropRoom: async id => { log.push(`dropRoom:${id}`); },
    dropCategory: async id => { log.push(`dropCategory:${id}`); },
    ...patch
  };
  return { deps, log, audits, children };
}

test('confirming archives each room before deleting it, restores adopted rooms, deletes the category last and audits', async () => {
  const built = plan([room('1'), room('2', { origin: 'adopted', originalName: 'Lounge', categoryId: 'C9' })], { overwriteBackups: { 2: {} } });
  const { deps, log, audits } = harness();
  const result = await executeCleanup(deps, built, built.planToken);
  assert.deepEqual(log, ['fetch:1', 'clear:1', 'delete:1', 'dropRoom:1', 'overwrites:2', 'rename:2:Lounge', 'delete:C1', 'dropCategory:C1']);
  assert.deepEqual(result, { deleted: ['1', 'C1'], restored: ['2'], skipped: [], archived: 1 });
  assert.deepEqual(audits.map(entry => entry.kind), ['match_rooms.transcript', 'match_rooms.restored', 'match_rooms.cleanup']);
  assert.equal(audits.at(-1)!.actor.id, 'bot', 'without an actor the bot is named, never an invented admin');
  assert.deepEqual(audits.at(-1)!.payload, { eventId: null, deleted: ['1', 'C1'], restored: ['2'], skipped: [], archived: 1 });
  assert.equal((await deps.store.list(OTHER, 'M1')).length, 1);
});

test('a stale or wrong token, or an edited plan, deletes nothing', async () => {
  const built = plan([room('1')]);
  const { deps, log } = harness();
  await assert.rejects(executeCleanup(deps, built, 'stale'), (error: unknown) => error instanceof RuleError && /changed; review again/.test((error as Error).message));
  const newer = plan([room('1'), room('2')]);
  await assert.rejects(executeCleanup(deps, newer, built.planToken), RuleError);
  const edited = { ...built, items: built.items.map(item => ({ ...item, action: 'delete' as const, channelId: '999' })) };
  await assert.rejects(executeCleanup(deps, edited, built.planToken), RuleError);
  assert.deepEqual(log, []);
});

test('a room whose chat cannot be archived is kept, and its category with it', async () => {
  const built = plan([room('1'), room('2')]);
  const { deps, log, children } = harness({ chat: { fetchMessages: async channelId => {
    if (channelId === '1') throw Object.assign(new Error('x'), { code: 50001 });
    return { messages: [{ id: '9', authorId: '4', authorName: null, createdAtMs: 1, content: null, attachments: [] }], contentAvailable: false };
  }, bulkDelete: async (_id, ids) => ({ deleted: ids.length, skippedOld: 0 }) } });
  children.set('C1', 1);
  const result = await executeCleanup(deps, built, built.planToken);
  assert.deepEqual(result.deleted, ['2']);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped.find(entry => entry.channelId === '1')!.reason, /could not be archived/);
  assert.match(result.skipped.find(entry => entry.channelId === 'C1')!.reason, /Not empty/);
  assert.equal(log.includes('delete:1'), false);
  assert.equal(log.includes('delete:C1'), false);
});

test('a category with outside channels still in it is not deleted, and a room with no match history is deleted without a transcript', async () => {
  const built = plan([room('1', { binding: null })]);
  const { deps, log, children } = harness({ bindingOf: async () => null });
  children.set('C1', 3);
  const result = await executeCleanup(deps, built, built.planToken);
  assert.equal(built.transcriptsToArchive, 0);
  assert.deepEqual(result.deleted, ['1']);
  assert.deepEqual(result.skipped, [{ channelId: 'C1', reason: 'Not empty (3 channels left), so it was kept.' }]);
  assert.deepEqual(log, ['delete:1', 'dropRoom:1']);
});

test('skipped plan items are reported and delete failures skip one room without stopping the run', async () => {
  const built = plan([room('1'), room('2'), room('3')], { occupancy: { 1: 0, 2: 0, 3: 4 } });
  const { deps } = harness({ channels: { deleteChannel: async id => { if (id === '1') throw Object.assign(new Error('x'), { code: 50013 }); },
    childCount: async () => 0 } });
  const result = await executeCleanup(deps, built, built.planToken);
  assert.deepEqual(result.deleted, ['2']);
  assert.deepEqual(result.skipped.map(entry => entry.channelId).sort(), ['1', '3', 'C1']);
  assert.match(result.skipped.find(entry => entry.channelId === '1')!.reason, /Manage Channels/);
});

test('restore failures are reported and the room is not counted as restored', async () => {
  const built = plan([room('2', { origin: 'adopted', originalName: 'Lounge' })]);
  const { deps } = harness({ restoreOverwrites: async () => { throw new Error('no backup'); } });
  const result = await executeCleanup(deps, built, built.planToken);
  assert.deepEqual(result.restored, []);
  assert.match(result.skipped.find(entry => entry.channelId === '2')!.reason, /Permissions could not be restored/);
});

test('the clean-up summary is audited with the actor who confirmed it', async () => {
  const built = plan([room('1')]);
  const { deps, audits } = harness();
  await executeCleanup(deps, built, built.planToken, { kind: 'admin', id: 'local-admin' });
  assert.deepEqual(audits.at(-1)!.actor, { kind: 'admin', id: 'local-admin' });
});
