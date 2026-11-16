import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, GatewayIntentBits, SnowflakeUtil, type Guild } from 'discord.js';
import type { MatchRoomTranscriptMessageDto, OpsAuditKind } from '@tcg-live/core';
import type { OpsActor } from '../../ops/audit.js';
import { archiveAndClear, BULK_DELETE_WINDOW_MS, DAY_MS, demoRoomChatPort, fitTranscriptMessages, liveRoomChatPort, MemoryTranscriptStore,
  sweepTranscriptRetention, TRANSCRIPT_MAX_BYTES, TRANSCRIPT_MAX_MESSAGES, type RoomChatPort } from './transcripts.js';

const EVENT = '11111111-1111-4111-8111-111111111111';
const CHANNEL = '500000000000000001';
const message = (id: string, patch: Partial<MatchRoomTranscriptMessageDto> = {}): MatchRoomTranscriptMessageDto =>
  ({ id, authorId: '42', authorName: 'Alice', createdAtMs: 1_000, content: 'secret words', attachments: [], ...patch });

function harness(chat: Partial<RoomChatPort> = {}, messages = [message('1'), message('2', { attachments: [{ name: 'a.png', url: 'https://cdn/a.png', size: 9 }] })]) {
  const calls: string[] = [];
  const audits: Array<{ kind: OpsAuditKind; payload: Record<string, unknown>; actor: OpsActor }> = [];
  const store = new MemoryTranscriptStore(() => 5_000);
  const port: RoomChatPort = {
    fetchMessages: async () => { calls.push('fetch'); return { messages, contentAvailable: true }; },
    bulkDelete: async (_channel, ids) => { calls.push(`delete:${ids.length}`); return { deleted: ids.length, skippedOld: 0 }; },
    ...chat
  };
  const deps = { chat: port, store, audit: async (kind: OpsAuditKind, payload: Record<string, unknown>, actor: OpsActor) => { audits.push({ kind, payload, actor }); } };
  return { calls, audits, store, deps };
}
const binding = { eventId: EVENT, matchId: 'M3' as const, startedAtMs: 100 };

test('archiveAndClear saves the chat with attachment metadata, then clears exactly the archived messages', async () => {
  const { calls, store, deps } = harness();
  const result = await archiveAndClear(deps, { channelId: CHANNEL, name: '🎮 M3' }, binding, 'reassigned');
  assert.equal(result.warning, null);
  assert.deepEqual(calls, ['fetch', 'delete:2']);
  const saved = await store.get(result.transcriptId!);
  assert.equal(saved!.messageCount, 2);
  assert.equal(saved!.reason, 'reassigned');
  assert.equal(saved!.channelName, '🎮 M3');
  assert.deepEqual(saved!.messages[1]!.attachments, [{ name: 'a.png', url: 'https://cdn/a.png', size: 9 }]);
  assert.equal((await store.list(EVENT, 'M3')).length, 1);
  assert.equal((await store.list(EVENT, 'M4')).length, 0);
});

test('without the Message Content intent the text is not stored but author, time and attachments are', async () => {
  const { store, deps } = harness({ fetchMessages: async () => ({ messages: [message('1', { content: 'leaked' })], contentAvailable: false }) });
  const { transcriptId } = await archiveAndClear(deps, { channelId: CHANNEL, name: null }, binding, 'manual');
  const saved = (await store.get(transcriptId!))!;
  assert.equal(saved.contentAvailable, false);
  assert.equal(saved.messages[0]!.content, null);
  assert.equal(saved.messages[0]!.authorName, 'Alice');
  assert.equal(saved.messages[0]!.createdAtMs, 1_000);
});

test('messages over the 14 day window are counted as skippedOld on the transcript and in a warning', async () => {
  const { store, deps } = harness({ bulkDelete: async () => ({ deleted: 1, skippedOld: 1 }) });
  const result = await archiveAndClear(deps, { channelId: CHANNEL, name: null }, binding, 'cleanup');
  assert.match(result.warning!, /older than 14 days/);
  assert.equal((await store.get(result.transcriptId!))!.skippedOld, 1);
});

test('the audit carries ids and counts but never message text or names', async () => {
  const { audits, deps } = harness();
  await archiveAndClear(deps, { channelId: CHANNEL, name: 'Room' }, binding, 'reassigned');
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.kind, 'match_rooms.transcript');
  assert.equal(audits[0]!.payload.messageCount, 2);
  assert.equal(audits[0]!.payload.matchId, 'M3');
  assert.doesNotMatch(JSON.stringify(audits[0]), /secret words|Alice|a\.png/);
});

test('a chat with no messages archives nothing and never clears', async () => {
  const { calls, store, deps } = harness({}, []);
  assert.deepEqual(await archiveAndClear(deps, { channelId: CHANNEL, name: null }, binding, 'reassigned'), { transcriptId: null, warning: null });
  assert.deepEqual(calls, ['fetch']);
  assert.equal((await store.list(EVENT)).length, 0);
});

test('a failed save leaves the chat untouched and warns', async () => {
  const { calls, store, deps } = harness();
  store.save = async () => { throw new Error('db down'); };
  const result = await archiveAndClear(deps, { channelId: CHANNEL, name: null }, binding, 'cleanup');
  assert.equal(result.transcriptId, null);
  assert.match(result.warning!, /left as it was/);
  assert.deepEqual(calls, ['fetch']);
});

test('a failed clear keeps the transcript and reports it; a read failure warns without a transcript; a gone room is quiet', async () => {
  const cleared = harness({ bulkDelete: async () => { throw Object.assign(new Error('x'), { code: 50013 }); } });
  const first = await archiveAndClear(cleared.deps, { channelId: CHANNEL, name: null }, binding, 'reassigned');
  assert.ok(first.transcriptId);
  assert.match(first.warning!, /Manage Messages/);
  const forbidden = harness({ fetchMessages: async () => { throw Object.assign(new Error('x'), { code: 50001 }); } });
  const second = await archiveAndClear(forbidden.deps, { channelId: CHANNEL, name: null }, binding, 'reassigned');
  assert.equal(second.transcriptId, null);
  assert.match(second.warning!, /Read Message History/);
  const gone = harness({ fetchMessages: async () => { throw Object.assign(new Error('x'), { code: 10003 }); } });
  assert.deepEqual(await archiveAndClear(gone.deps, { channelId: CHANNEL, name: null }, binding, 'cleanup'), { transcriptId: null, warning: null });
});

test('oversized chats keep the newest messages that fit and only those are cleared', async () => {
  const many = Array.from({ length: TRANSCRIPT_MAX_MESSAGES + 5 }, (_, index) => message(String(index + 1), { content: null }));
  const fit = fitTranscriptMessages(many, false);
  assert.equal(fit.kept.length, TRANSCRIPT_MAX_MESSAGES);
  assert.equal(fit.kept[0]!.id, '6');
  assert.equal(fit.dropped, 5);
  const wide = Array.from({ length: 200 }, (_, index) => message(String(index + 1), { content: 'x'.repeat(4_000), attachments:
    Array.from({ length: 10 }, () => ({ name: 'n'.repeat(200), url: `https://x/${'u'.repeat(2_000)}`, size: 1 })) }));
  const big = fitTranscriptMessages(wide, true);
  assert.ok(Buffer.byteLength(JSON.stringify(big.kept)) <= TRANSCRIPT_MAX_BYTES);
  assert.ok(big.dropped > 0 && big.kept.at(-1)!.id === '200');
  const { calls, deps } = harness({}, many);
  const result = await archiveAndClear(deps, { channelId: CHANNEL, name: null }, binding, 'cleanup');
  assert.deepEqual(calls, ['fetch', `delete:${TRANSCRIPT_MAX_MESSAGES}`]);
  assert.match(result.warning!, /5 older message/);
});

test('retention purges expired transcripts, keeps held ones and recent ones, and audits without text', async () => {
  const now = 100 * DAY_MS;
  const store = new MemoryTranscriptStore(() => now);
  const base = { eventId: EVENT, matchId: 'M1' as const, channelId: CHANNEL, channelName: null, startedAtMs: null, reason: 'cleanup' as const,
    contentAvailable: true, messages: [message('1')] };
  const old = await store.save({ ...base, archivedAtMs: now - 40 * DAY_MS });
  const held = await store.save({ ...base, archivedAtMs: now - 40 * DAY_MS });
  const recent = await store.save({ ...base, archivedAtMs: now - 5 * DAY_MS });
  await store.setHold(held.id, true);
  const audits: Array<Record<string, unknown>> = [];
  const audit = async (_kind: OpsAuditKind, payload: Record<string, unknown>) => { audits.push(payload); };
  assert.equal(await sweepTranscriptRetention({ store, settings: async () => ({ retention: { days: null } }), audit, now: () => now }), 0, 'never');
  assert.equal(await sweepTranscriptRetention({ store, settings: async () => ({ retention: { days: 30 } }), audit, now: () => now }), 1);
  assert.equal(await store.get(old.id), null);
  assert.deepEqual(store.raw(old.id)!.dto.messages, []);
  assert.ok(await store.get(held.id));
  assert.ok(await store.get(recent.id));
  assert.deepEqual(audits, [{ transcriptId: old.id, action: 'deleted', reason: 'retention' }]);
  await store.setHold(held.id, false);
  assert.equal(await sweepTranscriptRetention({ store, settings: async () => ({ retention: { days: 30 } }), now: () => now }), 1);
  assert.equal(await store.setHold(held.id, true), false, 'a purged transcript cannot be held');
  assert.equal(await sweepTranscriptRetention({ store: { purgeExpired: async () => { throw new Error('no table'); } },
    settings: async () => ({ retention: { days: 30 } }) }), 0, 'a missing 017 table never throws');
});

// ---- live port, against a fake guild ----

class Page extends Map<string, unknown> { last() { return [...this.values()].at(-1) as { id: string } | undefined; } }
interface FakeMessage { id: string; createdTimestamp: number; system?: boolean }
function liveGuild(options: { intents: number; messages: FakeMessage[]; deleted: string[][] }): Guild {
  const toMessage = (item: FakeMessage) => ({ id: item.id, createdTimestamp: item.createdTimestamp, system: item.system ?? false,
    author: { id: '42', username: 'alice' }, member: null, content: 'hello', attachments: new Map([['a', { name: 'a.png', url: 'https://cdn/a.png', size: 3 }]]) });
  const channel = {
    type: ChannelType.GuildVoice,
    messages: { fetch: async (query: { limit: number; before?: string }) => {
      const older = options.messages.filter(item => !query.before || BigInt(item.id) < BigInt(query.before)).sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
      return new Page(older.slice(0, query.limit).map(item => [item.id, toMessage(item)]));
    } },
    bulkDelete: async (ids: string[]) => { options.deleted.push(ids); return new Map(ids.map(id => [id, {}])); }
  };
  return { client: { options: { intents: { has: (bit: number) => (options.intents & bit) !== 0 } } },
    channels: { fetch: async (id: string) => (id === CHANNEL ? channel : null) } } as unknown as Guild;
}
const snowflakeAt = (ms: number, sequence: number) => String(SnowflakeUtil.generate({ timestamp: ms, increment: BigInt(sequence) }));

test('the live port pages back to the binding start, skips system messages, and reads contentAvailable from the intent', async () => {
  const now = Date.UTC(2026, 5, 1);
  const messages: FakeMessage[] = Array.from({ length: 130 }, (_, index) => ({ id: snowflakeAt(now - (130 - index) * 1_000, index), createdTimestamp: now - (130 - index) * 1_000 }));
  messages.push({ id: snowflakeAt(now - 500, 999), createdTimestamp: now - 500, system: true });
  const withIntent = liveRoomChatPort(liveGuild({ intents: GatewayIntentBits.MessageContent, messages, deleted: [] }), () => now);
  const all = await withIntent.fetchMessages(CHANNEL, null);
  assert.equal(all.contentAvailable, true);
  assert.equal(all.messages.length, 130, 'the system message is skipped');
  assert.ok(all.messages[0]!.createdAtMs < all.messages.at(-1)!.createdAtMs, 'oldest first');
  assert.deepEqual(all.messages[0]!.attachments, [{ name: 'a.png', url: 'https://cdn/a.png', size: 3 }]);
  const since = await withIntent.fetchMessages(CHANNEL, now - 10_500);
  assert.equal(since.messages.length, 10);
  const without = liveRoomChatPort(liveGuild({ intents: 0, messages, deleted: [] }), () => now);
  assert.equal((await without.fetchMessages(CHANNEL, null)).contentAvailable, false);
  await assert.rejects(withIntent.fetchMessages('999', null), (error: { code?: number }) => error.code === 10003);
});

test('the live port bulk deletes only messages under 14 days old and counts the rest as skippedOld', async () => {
  const now = Date.UTC(2026, 5, 1);
  const deleted: string[][] = [];
  const port = liveRoomChatPort(liveGuild({ intents: 0, messages: [], deleted }), () => now);
  const fresh = Array.from({ length: 150 }, (_, index) => snowflakeAt(now - DAY_MS, index));
  const stale = [snowflakeAt(now - BULK_DELETE_WINDOW_MS - 120_000, 1), snowflakeAt(now - 20 * DAY_MS, 2)];
  const result = await port.bulkDelete(CHANNEL, [...stale, ...fresh]);
  assert.deepEqual(result, { deleted: 150, skippedOld: 2 });
  assert.deepEqual(deleted.map(batch => batch.length), [100, 50]);
  assert.ok(!deleted.flat().some(id => stale.includes(id)));
});

test('the demo port serves a synthetic chat until it is cleared', async () => {
  const port = demoRoomChatPort(() => 1_000_000);
  const first = await port.fetchMessages('900', null);
  assert.equal(first.messages.length, 3);
  assert.deepEqual(await port.bulkDelete('900', first.messages.map(item => item.id)), { deleted: 3, skippedOld: 0 });
  assert.deepEqual((await port.fetchMessages('900', null)).messages, []);
});
