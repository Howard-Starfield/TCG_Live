import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MATCH_ROOM_LIMITS } from '@tcg-live/core';
import { demoMatchRoomDiscord, demoRoomRenamer } from './port.js';
import { budgetOpensAt, classifyRenameError, FORBIDDEN_RETRY_MS, RATE_LIMITED_NOTE, RoomRenameQueue, renameStateOf } from './renames.js';
import { MemoryMatchRoomStore, type MatchRoomRow } from './store.js';
import { createDemoGuild } from '../demo-guild.js';
import { FakeQueueClock, flush, TEST_APP, TEST_GUILD } from './testing.js';

const WINDOW = MATCH_ROOM_LIMITS.renameWindowMs;
const CHANNEL = '800000000000000001';
const rateLimit = (retryAfter: number) => Object.assign(new Error('You are being rate limited.'), { name: 'RateLimitError', retryAfter });

const room = (extra: Partial<MatchRoomRow> = {}): MatchRoomRow => ({ guildId: TEST_GUILD, channelId: CHANNEL, applicationId: TEST_APP, tableNo: 1,
  categoryId: null, origin: 'created', customName: null, appliedName: '🎮 M1', desiredName: null, originalName: null, renameLog: [],
  nextRenameAtMs: null, renameError: null, missingSinceMs: null, createdAtMs: 1, ...extra });

async function queueWorld(initial: Partial<MatchRoomRow> = {}) {
  const clock = new FakeQueueClock();
  const store = new MemoryMatchRoomStore();
  await store.insertRoom(room(initial));
  const sent: Array<{ name: string; at: number }> = [];
  const behavior = { fail: null as (() => unknown) | null, during: null as ((name: string) => Promise<void>) | null };
  const make = () => new RoomRenameQueue({ guildId: TEST_GUILD, store, clock, renamer: { async rename(_channelId, name) {
    sent.push({ name, at: clock.now() });
    await behavior.during?.(name);
    const failure = behavior.fail?.();
    if (failure) throw failure;
  } } });
  const queue = make();
  await queue.start();
  const row = async () => (await store.rooms(TEST_GUILD))[0]!;
  return { clock, store, sent, behavior, queue, make, row };
}

test('three requests before a send go out as one rename with the latest name', async () => {
  const w = await queueWorld();
  await w.queue.request(CHANNEL, 'first');
  await w.queue.request(CHANNEL, 'second');
  await w.queue.request(CHANNEL, 'third');
  assert.equal((await w.row()).desiredName, 'third');
  assert.equal(w.sent.length, 0, 'a request never awaits Discord');
  assert.equal(w.clock.pending, 1, 'one timer for the earliest due room');
  w.clock.advance(0);
  await flush();
  assert.deepEqual(w.sent.map(item => item.name), ['third']);
  const after = await w.row();
  assert.equal(after.appliedName, 'third');
  assert.equal(after.desiredName, null);
  assert.deepEqual(after.renameLog, [w.clock.now()]);
  await w.queue.stop();
});

test('asking for the name a room already has sends nothing and clears a waiting rename', async () => {
  const w = await queueWorld();
  await w.queue.request(CHANNEL, 'later');
  await w.queue.request(CHANNEL, '🎮 M1');
  assert.equal((await w.row()).desiredName, null);
  assert.equal(w.clock.pending, 0);
  await w.queue.stop();
});

test('the third rename inside ten minutes waits for the oldest one plus ten minutes and a second', async () => {
  const w = await queueWorld();
  const start = w.clock.now();
  await w.queue.request(CHANNEL, 'one');
  w.clock.advance(0);
  await flush();
  w.clock.advance(1_000);
  await w.queue.request(CHANNEL, 'two');
  w.clock.advance(0);
  await flush();
  assert.deepEqual(w.sent.map(item => item.name), ['one', 'two']);
  w.clock.advance(1_000);
  await w.queue.request(CHANNEL, 'three');
  const waiting = await w.row();
  assert.equal(waiting.nextRenameAtMs, start + WINDOW + 1_000);
  assert.equal(renameStateOf(waiting), 'queued');
  // The budget opens at start + 10 minutes + 1 second; the clock is at start + 2 seconds.
  w.clock.advance(WINDOW - 2_000 + 1_000 - 1);
  await flush();
  assert.equal(w.sent.length, 2, 'still inside the window');
  w.clock.advance(1);
  await flush();
  assert.deepEqual(w.sent.map(item => item.name), ['one', 'two', 'three']);
  assert.equal(w.sent[2]!.at, start + WINDOW + 1_000);
  await w.queue.stop();
});

test('a 429 reschedules by retryAfter and shows as retrying', async () => {
  const w = await queueWorld({ desiredName: 'wanted' });
  let calls = 0;
  w.behavior.fail = () => (++calls === 1 ? rateLimit(4_000) : null);
  await w.queue.start();
  w.clock.advance(0);
  await flush();
  const limited = await w.row();
  assert.equal(limited.appliedName, '🎮 M1');
  assert.equal(limited.desiredName, 'wanted');
  assert.equal(limited.nextRenameAtMs, w.clock.now() + 4_000 + 1_000);
  assert.equal(renameStateOf(limited), 'retrying');
  assert.equal(limited.renameError, RATE_LIMITED_NOTE);
  w.clock.advance(5_000);
  await flush();
  assert.equal(calls, 2);
  const done = await w.row();
  assert.equal(done.appliedName, 'wanted');
  assert.equal(done.renameError, null);
  assert.equal(renameStateOf(done), 'synced');
  await w.queue.stop();
});

test('a restart resumes from the stored log: nothing is sent until the saved budget opens', async () => {
  const clock0 = new FakeQueueClock();
  const stored = clock0.now();
  const w = await queueWorld({ desiredName: 'wanted', renameLog: [stored - 1_000, stored - 500], nextRenameAtMs: null });
  assert.equal(w.clock.nextAt(), stored + WINDOW, 'armed for the oldest entry + 10 minutes + 1 second');
  w.clock.advance(WINDOW - 2_000);
  await flush();
  assert.equal(w.sent.length, 0);
  w.clock.advance(2_000);
  await flush();
  assert.deepEqual(w.sent.map(item => item.name), ['wanted']);
  // A second queue over the same store (another restart) finds nothing left to send.
  const again = w.make();
  await again.start();
  assert.equal(w.clock.pending, 0);
  await again.stop(); await w.queue.stop();
});

test('a request that arrives while a rename is in flight stays wanted; an unchanged one is cleared', async () => {
  const w = await queueWorld();
  await w.queue.request(CHANNEL, 'first');
  w.behavior.during = async name => { if (name === 'first') await w.queue.request(CHANNEL, 'second'); };
  w.clock.advance(0);
  await flush();
  const mid = await w.row();
  assert.equal(mid.appliedName, 'first');
  assert.equal(mid.desiredName, 'second', 'the newer request was not cleared by the older send');
  assert.equal(renameStateOf(mid), 'queued');
  assert.equal(mid.nextRenameAtMs, w.clock.now(), 'one rename in the window: the second may go at once');
  w.behavior.during = null;
  w.clock.advance(0);
  await flush();
  const done = await w.row();
  assert.equal(done.appliedName, 'second');
  assert.equal(done.desiredName, null);
  await w.queue.stop();
});

test('a room that is gone is marked missing; a forbidden rename fails with an error and retries after ten minutes', async () => {
  const missing = await queueWorld({ desiredName: 'wanted' });
  missing.behavior.fail = () => Object.assign(new Error('Unknown Channel'), { code: 10003 });
  await missing.queue.start();
  missing.clock.advance(0);
  await flush();
  const gone = await missing.row();
  assert.equal(gone.missingSinceMs, missing.clock.now());
  assert.equal(gone.desiredName, null);
  await missing.queue.request(CHANNEL, 'again');
  assert.equal((await missing.row()).desiredName, null, 'nothing is queued for a missing room');
  await missing.queue.stop();

  const denied = await queueWorld({ desiredName: 'wanted' });
  let allowed = false;
  denied.behavior.fail = () => (allowed ? null : Object.assign(new Error('Missing Permissions'), { code: 50013 }));
  await denied.queue.start();
  denied.clock.advance(0);
  await flush();
  const failed = await denied.row();
  assert.equal(renameStateOf(failed), 'failed');
  assert.match(failed.renameError!, /not allowed to rename/);
  assert.equal(failed.nextRenameAtMs, denied.clock.now() + FORBIDDEN_RETRY_MS);
  assert.equal(failed.desiredName, 'wanted');
  allowed = true;
  denied.clock.advance(FORBIDDEN_RETRY_MS);
  await flush();
  const fixed = await denied.row();
  assert.equal(fixed.appliedName, 'wanted');
  assert.equal(fixed.renameError, null);
  await denied.queue.stop();
});

test('a rename made in Discord becomes the custom name and uses the budget; the bot\'s own rename echo does not', async () => {
  const w = await queueWorld();
  await w.queue.observed(CHANNEL, 'Finals Table');
  const custom = await w.row();
  assert.equal(custom.customName, 'Finals Table');
  assert.equal(custom.appliedName, 'Finals Table');
  assert.deepEqual(custom.renameLog, [w.clock.now()]);
  await w.queue.observed(CHANNEL, 'Finals Table');
  assert.equal((await w.row()).renameLog.length, 1, 'the same name again is not a second rename');

  // The echo of the bot's own rename arrives while the send is still in flight.
  await w.queue.request(CHANNEL, 'From the bot');
  w.behavior.during = async name => { await w.queue.observed(CHANNEL, name); };
  w.clock.advance(0);
  await flush();
  const after = await w.row();
  assert.equal(after.customName, 'Finals Table', 'the echo was ignored');
  assert.equal(after.appliedName, 'From the bot');
  await w.queue.stop();
});

test('budget and error classification', () => {
  const now = 1_000_000_000;
  assert.equal(budgetOpensAt([], now), now);
  assert.equal(budgetOpensAt([now - 1_000], now), now, 'one rename in the window leaves room for another');
  assert.equal(budgetOpensAt([now - 5_000, now - 1_000], now), now - 5_000 + WINDOW + 1_000);
  assert.equal(budgetOpensAt([now - WINDOW - 10, now - 1_000], now), now, 'old entries age out');
  assert.equal(budgetOpensAt([now - 9_000, now - 5_000, now - 1_000], now), now - 5_000 + WINDOW + 1_000, 'renames made in Discord count too');
  assert.deepEqual(classifyRenameError(rateLimit(1234)), { kind: 'rateLimit', retryAfterMs: 1234 });
  assert.deepEqual(classifyRenameError({ code: 10003 }), { kind: 'missing' });
  assert.deepEqual(classifyRenameError({ code: 50013 }), { kind: 'forbidden' });
  assert.deepEqual(classifyRenameError({ code: 50001 }), { kind: 'forbidden' });
  assert.deepEqual(classifyRenameError(new Error('socket hang up')), { kind: 'other' });
});

test('the demo rename transport applies after a delay and enforces two renames per ten minutes per channel', async () => {
  const clock = new FakeQueueClock();
  const demo = createDemoGuild(TEST_GUILD);
  const discord = demoMatchRoomDiscord(demo);
  const channelId = demo.channels.find(channel => channel.type === 'voice')!.id;
  const renamer = demoRoomRenamer((id, name) => discord.rename(id, name), { clock });
  const first = renamer.rename(channelId, 'one', 'test');
  await flush();
  assert.notEqual(demo.channels.find(channel => channel.id === channelId)!.name, 'one', 'queued: not applied yet');
  clock.advance(1_500);
  await first;
  assert.equal(demo.channels.find(channel => channel.id === channelId)!.name, 'one');
  const second = renamer.rename(channelId, 'two', 'test');
  clock.advance(1_500);
  await second;
  await assert.rejects(renamer.rename(channelId, 'three', 'test'), error => classifyRenameError(error).kind === 'rateLimit');
  clock.advance(WINDOW);
  const third = renamer.rename(channelId, 'three', 'test');
  clock.advance(1_500);
  await third;
  assert.equal(demo.channels.find(channel => channel.id === channelId)!.name, 'three');
});
