import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_TOOLS_LIMITS as L } from '@tcg-live/core';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { call, login, startHarness } from '../../admin/http/test-support.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';
import { createDemoGuild, DEMO_CHANNEL_IDS } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { auditLockLedger, purgeChannel, setChannelLock, type ChannelGateway, type PermissionBit, type RecentMessage } from './controls.js';
import { channelsRouteModule, parsePurgeRequest } from './routes.js';
import { StickiesTicketsRuntime } from './runtime-status.js';
import { StickyEngine, type StickyClock, type StickyPoster } from './sticky-engine.js';
import { MemoryStickyStore, parseStickyRequest } from './sticky-store.js';
import type { StickyRuntimeStatus } from './types.js';

const CHANNEL = '300000000000000001';
const BOT = '300000000000000099';
const MEMBER = '300000000000000050';

class FakeClock implements StickyClock {
  t = 1_000_000;
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];
  private seq = 0;
  now = () => this.t;
  setTimeout = (callback: () => void, ms: number) => { const id = ++this.seq; this.timers.push({ id, at: this.t + ms, callback }); return id; };
  clearTimeout = (handle: unknown) => { this.timers = this.timers.filter(timer => timer.id !== handle); };
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter(timer => timer !== next);
      this.t = next.at;
      next.callback();
      await flush();
    }
    this.t = end;
    await flush();
  }
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

class FakePoster implements StickyPoster<string> {
  posts: Array<{ channelId: string; payload: string; id: string; at: number }> = [];
  removed: string[] = [];
  latest: string | null = null;
  failWith: unknown = null;
  private seq = 500;
  constructor(private readonly clock: FakeClock) {}
  async post(channelId: string, payload: string) {
    if (this.failWith) throw this.failWith;
    const id = `4000000000000${String(++this.seq).padStart(5, '0')}`;
    this.posts.push({ channelId, payload, id, at: this.clock.now() });
    this.latest = id;
    return id;
  }
  async remove(_channelId: string, messageId: string) { this.removed.push(messageId); }
  async latestMessageId() { return this.latest; }
}

function engineFixture(debounceMs = 10_000, lastMessageId: string | null = null) {
  const clock = new FakeClock();
  const poster = new FakePoster(clock);
  const engine = new StickyEngine(poster, () => BOT, clock);
  const statuses: StickyRuntimeStatus[] = [];
  const persisted: Array<string | null> = [];
  engine.upsert({ key: 's1', channelId: CHANNEL, debounceMs, lastMessageId, render: () => 'sticky body',
    onPosted: async id => { persisted.push(id); }, onStatus: status => { statuses.push(status); } });
  let n = 0;
  const say = (authorId = MEMBER) => engine.onMessage({ channelId: CHANNEL, messageId: `5000000000000${String(++n).padStart(5, '0')}`, authorId });
  return { clock, poster, engine, statuses, persisted, say };
}

test('sticky waits for a quiet moment, re-posts once, and deletes the previous copy', async () => {
  const { clock, poster, say, persisted } = engineFixture(10_000, '400000000000000001');
  say(); await clock.advance(500); say(); await clock.advance(500); say();
  await clock.advance(1_900);
  assert.equal(poster.posts.length, 0, 'still inside the quiet window');
  await clock.advance(200);
  assert.equal(poster.posts.length, 1);
  assert.deepEqual(poster.removed, ['400000000000000001']);
  assert.deepEqual(persisted, [poster.posts[0]!.id]);
});

test('sticky re-posts at most once per debounce in a busy channel, and never starves', async () => {
  const { clock, poster, say } = engineFixture(10_000);
  for (let i = 0; i < 60; i += 1) { say(); await clock.advance(500); }   // 30 s of chatter, never quiet
  const times = poster.posts.map(post => post.at);
  assert.ok(times.length >= 2 && times.length <= 4, `posted ${times.length} times`);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i]! - times[i - 1]! >= 10_000, 'spacing respects the debounce');
  // Each re-post removes the copy before it.
  assert.deepEqual(poster.removed, poster.posts.slice(0, -1).map(post => post.id));
});

test('sticky ignores its own posts and its current copy', async () => {
  const { clock, poster, engine } = engineFixture(5_000, '400000000000000001');
  engine.onMessage({ channelId: CHANNEL, messageId: '500000000000000001', authorId: BOT });
  engine.onMessage({ channelId: CHANNEL, messageId: '400000000000000001', authorId: MEMBER });
  engine.onMessage({ channelId: '300000000000000777', messageId: '500000000000000002', authorId: MEMBER });
  await clock.advance(60_000);
  assert.equal(poster.posts.length, 0);
});

test('sticky survives a restart: no re-post when the stored copy is still the newest message', async () => {
  const fixture = engineFixture(5_000, '400000000000000001');
  fixture.poster.latest = '400000000000000001';
  await fixture.engine.ensureAtBottom('s1');
  assert.equal(fixture.poster.posts.length, 0);
  assert.equal(fixture.statuses.at(-1)?.state, 'posted');
  fixture.poster.latest = '500000000000000009';   // members talked while the bot was off
  await fixture.engine.ensureAtBottom('s1');
  assert.equal(fixture.poster.posts.length, 1);
  assert.deepEqual(fixture.poster.removed, ['400000000000000001']);
});

test('sticky reports missing permissions and a deleted channel', async () => {
  const fixture = engineFixture(5_000);
  fixture.poster.failWith = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  await fixture.engine.ensureAtBottom('s1', true);
  assert.equal(fixture.statuses.at(-1)?.state, 'missing-permissions');
  assert.match(fixture.statuses.at(-1)?.message ?? '', /Manage Messages/);
  fixture.poster.failWith = Object.assign(new Error('Unknown Channel'), { code: 10003 });
  await fixture.engine.ensureAtBottom('s1', true);
  assert.equal(fixture.statuses.at(-1)?.state, 'channel-missing');
});

test('sticky request validation', () => {
  const ok = parseStickyRequest({ channelId: CHANNEL, enabled: true, debounceMs: 15_000, content: '  Read the rules  ', embed: null });
  assert.equal(ok.content, 'Read the rules');
  assert.throws(() => parseStickyRequest({ channelId: CHANNEL, enabled: true, debounceMs: 1_000, content: 'x', embed: null }), /Re-post delay/);
  assert.throws(() => parseStickyRequest({ channelId: CHANNEL, enabled: true, debounceMs: 15_000, content: null, embed: null }), /text or an embed/);
  assert.throws(() => parseStickyRequest({ channelId: 'x', enabled: true, debounceMs: 15_000, content: 'x', embed: null }), /Discord ID/);
  assert.throws(() => parseStickyRequest({ channelId: CHANNEL, enabled: true, debounceMs: 15_000, content: 'x', embed: null, extra: 1 }), /unknown fields/);
});

test('memory sticky store: one per channel, limit, last message kept unless moved', async () => {
  const store = new MemoryStickyStore();
  const saved = await store.save(DEMO_GUILD_ID, null, { channelId: CHANNEL, enabled: true, debounceMs: 5_000, content: 'a', embed: null });
  await assert.rejects(store.save(DEMO_GUILD_ID, null, { channelId: CHANNEL, enabled: true, debounceMs: 5_000, content: 'b', embed: null }), /already has a sticky/);
  await store.setLastMessageId(DEMO_GUILD_ID, saved.id, '400000000000000001');
  assert.equal((await store.save(DEMO_GUILD_ID, saved.id, { channelId: CHANNEL, enabled: true, debounceMs: 5_000, content: 'c', embed: null })).lastMessageId, '400000000000000001');
  assert.equal((await store.save(DEMO_GUILD_ID, saved.id, { channelId: '300000000000000002', enabled: true, debounceMs: 5_000, content: 'c', embed: null })).lastMessageId, null);
});

// ---------------------------------------------------------------- lock / slowmode / purge

class FakeChannels implements ChannelGateway {
  everyoneSend: PermissionBit = 'neutral';
  slowmode = 0;
  calls: PermissionBit[] = [];
  constructor(public messages: RecentMessage[] = []) {}
  async state(channelId: string) { return channelId === CHANNEL ? { everyoneSend: this.everyoneSend, slowmodeSeconds: this.slowmode } : null; }
  async setEveryoneSend(_channelId: string, value: PermissionBit) { this.everyoneSend = value; this.calls.push(value); }
  async setSlowmode(_channelId: string, seconds: number) { this.slowmode = seconds; }
  async recentMessages(_channelId: string, limit: number) { return this.messages.slice(0, limit); }
  async createChannel(): Promise<never> { throw new Error('not used'); }
  async bulkDelete(_channelId: string, ids: readonly string[]) {
    this.messages = this.messages.filter(message => !ids.includes(message.id));
    return ids.length;
  }
}

async function lockCycle(initial: PermissionBit): Promise<PermissionBit[]> {
  const gateway = new FakeChannels();
  gateway.everyoneSend = initial;
  const audit = new MemoryOpsAuditStore();
  const ledger = auditLockLedger(audit);
  const lock = await setChannelLock(gateway, ledger, DEMO_GUILD_ID, CHANNEL, true, 'raid');
  assert.equal(lock.changed, true);
  assert.deepEqual(lock.payload.prior, { everyoneSend: initial });
  await audit.append({ kind: 'channel.lock', actor: { kind: 'admin', id: 'local-admin' }, guildId: DEMO_GUILD_ID, payload: lock.payload });
  assert.equal((await setChannelLock(gateway, ledger, DEMO_GUILD_ID, CHANNEL, true, 'again')).changed, false, 'locking twice keeps the remembered state');
  const unlock = await setChannelLock(gateway, ledger, DEMO_GUILD_ID, CHANNEL, false, 'over');
  assert.equal(unlock.state.locked, false);
  return gateway.calls;
}

test('unlock restores the exact @everyone Send Messages state from before the lock', async () => {
  assert.deepEqual(await lockCycle('neutral'), ['deny', 'neutral']);
  assert.deepEqual(await lockCycle('allow'), ['deny', 'allow']);
});

test('unlocking a channel locked outside the bot clears the deny; unlocking an open channel does nothing', async () => {
  const gateway = new FakeChannels();
  gateway.everyoneSend = 'deny';
  const ledger = auditLockLedger(new MemoryOpsAuditStore());
  const result = await setChannelLock(gateway, ledger, DEMO_GUILD_ID, CHANNEL, false, 'manual');
  assert.equal(result.payload.remembered, false);
  assert.equal(gateway.everyoneSend, 'neutral');
  assert.equal((await setChannelLock(gateway, ledger, DEMO_GUILD_ID, CHANNEL, false, 'manual')).changed, false);
  await assert.rejects(setChannelLock(gateway, ledger, DEMO_GUILD_ID, '300000000000000123', true, 'x'), /not a text channel/);
});

test('purge: count and by-user modes skip messages older than 14 days', async () => {
  const now = Date.UTC(2026, 10, 14);
  const day = 86_400_000;
  const messages: RecentMessage[] = Array.from({ length: 20 }, (_, index) => ({ id: `6000000000000${String(index).padStart(5, '0')}`,
    authorId: index % 2 ? MEMBER : BOT, createdAtMs: now - index * day }));
  const byCount = await purgeChannel(new FakeChannels(structuredClone(messages)), { channelId: CHANNEL, mode: 'count', count: 18, reason: 'x' }, now);
  assert.deepEqual(byCount, { deleted: 14, skippedTooOld: 4 });   // ages 0-13 days deletable, 14-17 too old
  const byUser = await purgeChannel(new FakeChannels(structuredClone(messages)), { channelId: CHANNEL, mode: 'user', userId: MEMBER, count: 5, reason: 'x' }, now);
  assert.deepEqual(byUser, { deleted: 5, skippedTooOld: 0 });
  const gateway = new FakeChannels(structuredClone(messages));
  await purgeChannel(gateway, { channelId: CHANNEL, mode: 'user', userId: MEMBER, count: 100, reason: 'x' }, now);
  assert.ok(gateway.messages.every(message => message.authorId !== MEMBER || now - message.createdAtMs >= 13 * day), 'only fresh messages of that user went');
});

test('purge request limits', () => {
  assert.throws(() => parsePurgeRequest({ channelId: CHANNEL, mode: 'count', count: L.purgeCountMax + 1, reason: 'x' }), /1 to 100/);
  assert.throws(() => parsePurgeRequest({ channelId: CHANNEL, mode: 'count', count: 0, reason: 'x' }), /1 to 100/);
  assert.throws(() => parsePurgeRequest({ channelId: CHANNEL, mode: 'count', count: 5, reason: ' ' }), /Reason/);
  assert.throws(() => parsePurgeRequest({ channelId: CHANNEL, mode: 'user', count: 5, reason: 'x' }), /missing fields/);
  assert.throws(() => parsePurgeRequest({ channelId: CHANNEL, mode: 'all', count: 5, reason: 'x' }), /purge mode/);
});

// ---------------------------------------------------------------- routes (demo)

function adminTools(): AdminToolsRouteOptions {
  const audit = new MemoryOpsAuditStore();
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [channelsRouteModule({ runtime: new StickiesTicketsRuntime() })] };
}

test('sticky routes: CRUD, reserved channels refused, audited, feature notified', async () => {
  const options = adminTools();
  const notified: string[] = [];
  options.onChanged = (area, id) => { notified.push(`${area}:${id}`); };
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const listed = (await call(harness.port, '/api/v1/admin-tools/stickies', { token })).json();
    assert.equal(listed.stickies.length, 1, 'demo seeds one sticky');
    const body = (channelId: string) => JSON.stringify({ channelId, enabled: true, debounceMs: 20_000, content: 'Be kind', embed: null });
    const reserved = await call(harness.port, '/api/v1/admin-tools/stickies', { method: 'POST', token, body: body(DEMO_CHANNEL_IDS.signup) });
    assert.equal(reserved.status, 400);
    assert.match(reserved.json().error.message, /tournament/);
    const voice = await call(harness.port, '/api/v1/admin-tools/stickies', { method: 'POST', token, body: body(DEMO_CHANNEL_IDS.matchM1) });
    assert.equal(voice.status, 400);
    const created = await call(harness.port, '/api/v1/admin-tools/stickies', { method: 'POST', token, body: body(DEMO_CHANNEL_IDS.general) });
    assert.equal(created.status, 201, created.text);
    const id = created.json().id as string;
    assert.equal(created.json().status.state, 'posted');
    const dup = await call(harness.port, '/api/v1/admin-tools/stickies', { method: 'POST', token, body: body(DEMO_CHANNEL_IDS.general) });
    assert.equal(dup.status, 409);
    const disabled = await call(harness.port, `/api/v1/admin-tools/stickies/${id}`, { method: 'PUT', token,
      body: JSON.stringify({ channelId: DEMO_CHANNEL_IDS.general, enabled: false, debounceMs: 20_000, content: 'Be kind', embed: null }) });
    assert.equal(disabled.json().status.state, 'disabled');
    assert.equal((await call(harness.port, `/api/v1/admin-tools/stickies/${id}`, { method: 'DELETE', token })).status, 200);
    assert.equal((await call(harness.port, `/api/v1/admin-tools/stickies/${id}`, { method: 'DELETE', token })).status, 404);
    const kinds = (options.audit as MemoryOpsAuditStore).entries.map(entry => entry.kind);
    assert.deepEqual(kinds.filter(kind => kind.startsWith('sticky.')), ['sticky.saved', 'sticky.saved', 'sticky.deleted']);
    assert.deepEqual(notified, [`stickies:${id}`, `stickies:${id}`, `stickies:${id}`]);
  } finally { await harness.stop(); }
});

test('channel control routes: lock/unlock, slowmode and purge in the demo, audited, capability-gated', async () => {
  const options = adminTools();
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const post = (path: string, body: unknown) => call(harness.port, `/api/v1/admin-tools/channels/${path}`, { method: 'POST', token, body: JSON.stringify(body) });
    const channelId = DEMO_CHANNEL_IDS.general;
    assert.equal((await post('lock', { channelId, locked: true, reason: 'Round 3' })).json().locked, true);
    assert.equal((await call(harness.port, `/api/v1/admin-tools/channels/state/${channelId}`, { token })).json().locked, true);
    assert.equal((await post('lock', { channelId, locked: false, reason: 'Done' })).json().locked, false);
    assert.equal((await post('slowmode', { channelId, seconds: 30, reason: 'Busy' })).json().slowmodeSeconds, 30);
    assert.equal((await post('slowmode', { channelId, seconds: L.slowmodeSecondsMax + 1, reason: 'Busy' })).status, 400);
    const purge = await post('purge', { channelId, mode: 'count', count: 40, reason: 'Spam' });
    assert.equal(purge.status, 200, purge.text);
    assert.ok(purge.json().skippedTooOld > 0, 'demo history reaches past 14 days');
    assert.equal(purge.json().deleted + purge.json().skippedTooOld, 40);
    assert.equal((await post('lock', { channelId: DEMO_CHANNEL_IDS.matchM1, locked: true, reason: 'x' })).status, 400);
    const kinds = (options.audit as MemoryOpsAuditStore).entries.map(entry => entry.kind);
    assert.deepEqual(kinds, ['channel.lock', 'channel.unlock', 'channel.slowmode', 'channel.purge']);
  } finally { await harness.stop(); }
  const reader = await startHarness({ adminTools: adminTools() }, { capabilities: ['dashboard.read', 'members.read'] });
  try {
    const token = await login(reader);
    const reply = await call(reader.port, '/api/v1/admin-tools/channels/lock', { method: 'POST', token,
      body: JSON.stringify({ channelId: DEMO_CHANNEL_IDS.general, locked: true, reason: 'x' }) });
    assert.equal(reply.status, 403);
  } finally { await reader.stop(); }
});

test('channel create route: creates text and voice channels in the demo, validates, audited, needs server.manage', async () => {
  const options = adminTools();
  const harness = await startHarness({ adminTools: options });
  const play = options.demo!.channels.find(channel => channel.type === 'category' && channel.name === 'Play')!.id;
  try {
    const token = await login(harness);
    const create = (body: unknown) => call(harness.port, '/api/v1/admin-tools/channels/create', { method: 'POST', token, body: JSON.stringify(body) });
    const text = await create({ name: 'Side Events', type: 'text', parentId: play, reason: 'New format' });
    assert.equal(text.status, 201, text.text);
    assert.equal(text.json().name, 'side-events');
    assert.equal(text.json().parentId, play);
    const voice = await create({ name: 'TCG Match 3', type: 'voice', parentId: null, reason: 'Third table' });
    assert.equal(voice.json().name, 'TCG Match 3');
    assert.equal(voice.json().type, 'voice');
    const meta = (await call(harness.port, '/api/v1/admin-tools/guild', { token })).json();
    assert.ok(meta.channels.some((channel: { id: string }) => channel.id === voice.json().id), 'new channel shows in pickers');
    assert.equal((await create({ name: ' ', type: 'text', parentId: null, reason: 'x' })).status, 400);
    assert.equal((await create({ name: 'x', type: 'forum', parentId: null, reason: 'x' })).status, 400);
    assert.equal((await create({ name: 'x', type: 'text', parentId: DEMO_CHANNEL_IDS.general, reason: 'x' })).status, 400);
    const kinds = (options.audit as MemoryOpsAuditStore).entries.map(entry => entry.kind);
    assert.deepEqual(kinds, ['channel.create', 'channel.create']);
  } finally { await harness.stop(); }
  const moderator = await startHarness({ adminTools: adminTools() }, { capabilities: ['dashboard.read', 'members.read', 'members.moderate'] });
  try {
    const token = await login(moderator);
    const reply = await call(moderator.port, '/api/v1/admin-tools/channels/create', { method: 'POST', token,
      body: JSON.stringify({ name: 'x', type: 'text', parentId: null, reason: 'x' }) });
    assert.equal(reply.status, 403);
  } finally { await moderator.stop(); }
});

// ---------------------------------------------------------------- Discord feature

test('feature: posts enabled stickies, skips reserved channels, follows messages, and registers the ticket buttons', async () => {
  const { EventEmitter } = await import('node:events');
  const { fakeFeatureContext, TEST_GUILD_ID } = await import('../../discord/feature-testing.js');
  const { stickiesTicketsFeature } = await import('./discord-feature.js');
  const { MemoryTicketStore } = await import('../tickets/store.js');
  const clock = new FakeClock();
  const poster = new FakePoster(clock);
  const store = new MemoryStickyStore(clock.now);
  const runtime = new StickiesTicketsRuntime();
  const reservedChannel = '300000000000000555';
  const open = await store.save(TEST_GUILD_ID, null, { channelId: CHANNEL, enabled: true, debounceMs: 5_000, content: 'rules', embed: null });
  const reserved = await store.save(TEST_GUILD_ID, null, { channelId: reservedChannel, enabled: true, debounceMs: 5_000, content: 'nope', embed: null });
  const client = Object.assign(new EventEmitter(), { user: { id: BOT } });
  const ctx = fakeFeatureContext({ client: client as never, reservedChannelIds: async () => [reservedChannel] });
  const feature = stickiesTicketsFeature({ stickies: store, tickets: new MemoryTicketStore(), runtime, clock,
    io: async () => ({ poster: poster as unknown as StickyPoster<never>, tickets: {} as never, scanPanels: async () => [] }) });
  await feature.start(ctx);
  try {
    assert.deepEqual(poster.posts.map(post => post.channelId), [CHANNEL]);
    assert.equal(runtime.stickyStatus(open.id)?.state, 'posted');
    assert.equal(runtime.stickyStatus(reserved.id)?.state, 'reserved');
    assert.equal((await store.get(TEST_GUILD_ID, open.id))?.lastMessageId, poster.posts[0]!.id);
    client.emit('messageCreate', { guildId: TEST_GUILD_ID, channelId: CHANNEL, id: '500000000000000001', author: { id: MEMBER } });
    client.emit('messageCreate', { guildId: TEST_GUILD_ID, channelId: reservedChannel, id: '500000000000000002', author: { id: MEMBER } });
    await clock.advance(10_000);
    assert.deepEqual(poster.posts.map(post => post.channelId), [CHANNEL, CHANNEL]);
    assert.throws(() => ctx.interactions.onComponent('tk:', async () => {}), /already has a component handler/);
    assert.ok(runtime.panelRefresher());
  } finally { await feature.stop(); }
  assert.equal(client.listenerCount('messageCreate'), 0);
  assert.equal(runtime.panelRefresher(), null);
});
