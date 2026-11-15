import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto, type LoggingSettingsDto, type OpsAuditKind,
  type PrivilegedIntentName, type PrivilegedIntentState } from '@tcg-live/core';
import { fakeFeatureContext, TEST_GUILD_ID } from '../../discord/feature-testing.js';
import { featurePrivilegedIntents } from '../../discord/intents.js';
import { parseAdminToolsSettings } from '../settings.js';
import { loggingFeature } from './feature.js';
import { DAY_MS, LoggingProcessor, type LogPost, type LoggingDeps } from './processor.js';
import { MemoryLoggingStore } from './store.js';
import { isNewAccount, renderLoggingTemplate, snowflakeTimeMs, templateMentions } from './template.js';

const NOW = Date.UTC(2026, 10, 14, 12);
const USER = '200000000000000001';
const OTHER = '200000000000000002';
const GENERAL = '300000000000000001';
const IGNORED = '300000000000000002';
const LOG = '300000000000000003';
const WELCOME = '300000000000000004';
const ROLE_A = '400000000000000001';
const ROLE_HIGH = '400000000000000002';

function logging(patch: (settings: LoggingSettingsDto) => void = () => {}): LoggingSettingsDto {
  const value = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS.logging) as LoggingSettingsDto;
  value.joinLeave = { enabled: true, channelId: LOG, newAccountDays: 7, memberUpdates: true };
  value.welcome = { enabled: true, channelId: WELCOME, message: 'Hi {user} ({username}) to {server} #{memberCount}', leaveMessage: 'Bye {username}' };
  value.autoRole = { enabled: true, roleIds: [ROLE_A] };
  value.messageLog = { enabled: true, channelId: LOG, retentionDays: 30, ignoredChannelIds: [IGNORED] };
  patch(value);
  return value;
}

interface Harness {
  processor: LoggingProcessor; store: MemoryLoggingStore; posts: Array<{ channelId: string; message: LogPost }>;
  audits: Array<{ kind: OpsAuditKind; payload: Record<string, unknown> }>; added: Array<{ userId: string; roleIds: readonly string[] }>;
  deps: LoggingDeps;
}
function harness(settings: LoggingSettingsDto = logging(), options: {
  intents?: Partial<Record<PrivilegedIntentName, PrivilegedIntentState>>; addRolesFails?: boolean; postFails?: boolean; now?: number;
} = {}): Harness {
  const store = new MemoryLoggingStore();
  const posts: Harness['posts'] = [];
  const audits: Harness['audits'] = [];
  const added: Harness['added'] = [];
  const deps: LoggingDeps = {
    guildId: TEST_GUILD_ID, store, settings: async () => settings,
    intents: () => ({ guildMembers: 'on', messageContent: 'on', ...options.intents }),
    post: async (channelId, message) => { if (options.postFails) throw new Error('Missing Access'); posts.push({ channelId, message }); },
    serverName: async () => 'TCG {user} Club', memberCount: async () => 42,
    manageableRoles: async ids => ({ ok: ids.filter(id => id !== ROLE_HIGH), skipped: ids.filter(id => id === ROLE_HIGH) }),
    addRoles: async (userId, roleIds) => { if (options.addRolesFails) throw new Error('Missing Permissions'); added.push({ userId, roleIds }); },
    audit: async (kind, payload) => { audits.push({ kind, payload }); },
    log: () => {}, now: () => options.now ?? NOW
  };
  return { processor: new LoggingProcessor(deps), store, posts, audits, added, deps };
}
const join = (patch: Partial<{ userId: string; username: string; bot: boolean; accountCreatedAtMs: number }> = {}) =>
  ({ userId: USER, username: 'ash', bot: false, accountCreatedAtMs: NOW - 400 * DAY_MS, ...patch });
const create = (patch: Partial<Parameters<LoggingProcessor['messageCreated']>[0]> = {}) => ({ guildId: TEST_GUILD_ID, messageId: '500000000000000001',
  channelId: GENERAL, authorId: USER, bot: false, webhook: false, content: 'hello', attachmentCount: 0, createdAtMs: NOW - DAY_MS, ...patch });

test('templates fill placeholders in one pass and only ping the joining user', () => {
  const text = renderLoggingTemplate('Welcome {user} aka {username} to {server}, #{memberCount} {unknown}', {
    userId: USER, username: '{user} @everyone', server: 'Club {username}', memberCount: null });
  assert.equal(text, `Welcome <@${USER}> aka {user} @everyone to Club {username}, #? {unknown}`);
  assert.deepEqual(templateMentions('welcome', USER), { parse: [], users: [USER] });
  assert.deepEqual(templateMentions('leave', USER), { parse: [], users: [] });
  assert.equal(renderLoggingTemplate('x'.repeat(3000), { userId: USER, username: 'a', server: 's', memberCount: 1 }).length, 2000);
});

test('new-account flag and snowflake time', () => {
  assert.equal(isNewAccount(NOW - 2 * DAY_MS, 7, NOW), true);
  assert.equal(isNewAccount(NOW - 8 * DAY_MS, 7, NOW), false);
  assert.equal(isNewAccount(NOW - 1000, 0, NOW), false);
  assert.equal(snowflakeTimeMs('175928847299117063'), 1462015105796);
});

test('a join is logged with the new-account flag, welcomed with a safe mention and auto-roled', async () => {
  const h = harness();
  await h.processor.memberJoined(join({ username: '@everyone', accountCreatedAtMs: NOW - DAY_MS }));
  const [entry] = h.store.entries;
  assert.equal(entry?.kind, 'join');
  assert.deepEqual(entry?.stream === 'member' && entry.detail, { newAccount: true, accountCreatedAtMs: NOW - DAY_MS });
  const logPost = h.posts.find(post => post.channelId === LOG)!;
  assert.match(logPost.message.embeds![0]!.title!, /new account/);
  assert.deepEqual(logPost.message.allowedMentions, { parse: [] });
  const welcome = h.posts.find(post => post.channelId === WELCOME)!;
  assert.equal(welcome.message.content, `Hi <@${USER}> (@everyone) to TCG {user} Club #42`);
  assert.deepEqual(welcome.message.allowedMentions, { parse: [], users: [USER] });
  assert.deepEqual(h.added, [{ userId: USER, roleIds: [ROLE_A] }]);
  assert.equal(h.audits.length, 0);
});

test('auto-role skips bots, audits unmanageable roles and failures', async () => {
  const bot = harness();
  await bot.processor.memberJoined(join({ bot: true }));
  assert.equal(bot.added.length, 0);
  assert.equal(bot.posts.some(post => post.channelId === WELCOME), false, 'bots are not welcomed');
  assert.equal(bot.store.entries.length, 1, 'bots are still in the join log');

  const high = harness(logging(value => { value.autoRole.roleIds = [ROLE_A, ROLE_HIGH]; }));
  await high.processor.memberJoined(join());
  assert.deepEqual(high.added, [{ userId: USER, roleIds: [ROLE_A] }]);
  assert.deepEqual(high.audits.map(audit => [audit.kind, audit.payload.roleIds]), [['auto_role.failed', [ROLE_HIGH]]]);

  const failing = harness(logging(), { addRolesFails: true });
  await failing.processor.memberJoined(join());
  assert.equal(failing.audits[0]?.kind, 'auto_role.failed');
  assert.match(String(failing.audits[0]?.payload.error), /Missing Permissions/);
});

test('auto-role "Skip bots" off gives bots the roles but never a welcome; the setting parses and stays optional', async () => {
  const off = harness(logging(value => { value.autoRole.skipBots = false; }));
  await off.processor.memberJoined(join({ bot: true }));
  assert.deepEqual(off.added, [{ userId: USER, roleIds: [ROLE_A] }]);
  assert.equal(off.posts.some(post => post.channelId === WELCOME), false);
  const on = harness(logging(value => { value.autoRole.skipBots = true; }));
  await on.processor.memberJoined(join({ bot: true }));
  assert.equal(on.added.length, 0);

  const body = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
  assert.equal(parseAdminToolsSettings(body).logging.autoRole.skipBots, undefined);
  body.logging.autoRole = { enabled: false, roleIds: [], skipBots: false };
  assert.equal(parseAdminToolsSettings(body).logging.autoRole.skipBots, false);
  body.logging.autoRole = { enabled: false, roleIds: [], skipBots: 'no' as unknown as boolean };
  assert.throws(() => parseAdminToolsSettings(body), /Skip bots/);
});

test('welcome failures are audited; leave messages ping nobody', async () => {
  const failing = harness(logging(), { postFails: true });
  await failing.processor.memberJoined(join());
  assert.ok(failing.audits.some(audit => audit.kind === 'welcome.failed'));
  const h = harness();
  await h.processor.memberLeft({ userId: USER, username: 'ash', bot: false });
  assert.equal(h.store.entries[0]?.kind, 'leave');
  const leave = h.posts.find(post => post.channelId === WELCOME)!;
  assert.equal(leave.message.content, 'Bye ash');
  assert.deepEqual(leave.message.allowedMentions, { parse: [], users: [] });
});

test('role and nickname changes are diffed and logged; unknown before-state is skipped', async () => {
  const h = harness();
  const written = await h.processor.memberUpdated({ userId: USER, before: { roleIds: [ROLE_A], nick: null },
    after: { roleIds: [ROLE_HIGH], nick: 'Ash' } });
  assert.deepEqual(written.map(entry => entry.kind), ['role', 'nick']);
  assert.deepEqual(written[0]?.stream === 'member' && written[0].detail, { addedRoleIds: [ROLE_HIGH], removedRoleIds: [ROLE_A] });
  assert.deepEqual(written[1]?.stream === 'member' && written[1].detail, { before: null, after: 'Ash' });
  assert.equal(h.posts[0]?.message.embeds?.length, 2);
  assert.deepEqual(await h.processor.memberUpdated({ userId: USER, before: null, after: { roleIds: [], nick: null } }), []);
  const off = harness(logging(value => { value.joinLeave.memberUpdates = false; }));
  assert.deepEqual(await off.processor.memberUpdated({ userId: USER, before: { roleIds: [], nick: null }, after: { roleIds: [ROLE_A], nick: null } }), []);
});

test('missing or off intents make every sub-feature a no-op', async () => {
  for (const state of ['missing', 'off'] as const) {
    const h = harness(logging(), { intents: { guildMembers: state, messageContent: state } });
    await h.processor.memberJoined(join());
    await h.processor.memberLeft({ userId: USER, username: 'ash', bot: false });
    await h.processor.memberUpdated({ userId: USER, before: { roleIds: [], nick: null }, after: { roleIds: [ROLE_A], nick: 'x' } });
    assert.equal(await h.processor.messageCreated(create()), false);
    await h.processor.messagesDeleted({ guildId: TEST_GUILD_ID, channelId: GENERAL, messageIds: ['500000000000000001'], bulk: false });
    assert.equal(h.store.entries.length + h.store.messages.size + h.posts.length + h.added.length + h.audits.length, 0, state);
  }
});

test('message store skips bots, webhooks, DMs, other guilds, ignored channels, the log channel and a disabled log', async () => {
  const h = harness();
  assert.equal(await h.processor.messageCreated(create()), true);
  for (const patch of [{ bot: true }, { webhook: true }, { guildId: null }, { guildId: '999999999999999991' }, { channelId: IGNORED },
    { channelId: LOG }, { content: '', attachmentCount: 0 }]) {
    assert.equal(await h.processor.messageCreated(create({ messageId: '500000000000000009', ...patch })), false, JSON.stringify(patch));
  }
  assert.equal(h.store.messages.size, 1);
  const disabled = harness(logging(value => { value.messageLog.enabled = false; }));
  assert.equal(await disabled.processor.messageCreated(create()), false);
  assert.equal(disabled.store.messages.size, 0);
});

test('edits log before/after and update the stored copy; unchanged content is ignored', async () => {
  const h = harness();
  await h.processor.messageCreated(create({ attachmentCount: 2 }));
  const base = { guildId: TEST_GUILD_ID, messageId: '500000000000000001', channelId: GENERAL, attachmentCount: undefined,
    authorId: USER, bot: false, cachedBefore: null, editedAtMs: NOW };
  assert.equal(await h.processor.messageUpdated({ ...base, content: undefined }), null, 'embed unfurl');
  assert.equal(await h.processor.messageUpdated({ ...base, content: 'hello' }), null, 'same text');
  const entry = await h.processor.messageUpdated({ ...base, content: 'hello there' });
  assert.ok(entry?.stream === 'message');
  assert.deepEqual([entry.kind, entry.before, entry.after, entry.attachmentCount, entry.userId], ['edit', 'hello', 'hello there', 2, USER]);
  assert.equal((await h.store.getMessage(TEST_GUILD_ID, '500000000000000001'))?.content, 'hello there');
  assert.equal(h.posts[0]?.channelId, LOG);
  assert.deepEqual(h.posts[0]?.message.allowedMentions, { parse: [] });
  // No stored copy: falls back to the gateway cache.
  const cached = await h.processor.messageUpdated({ ...base, messageId: '500000000000000002', cachedBefore: 'old', content: 'new' });
  assert.ok(cached?.stream === 'message' && cached.before === 'old');
});

test('deletes and bulk deletes log stored messages only and move the text out of the store', async () => {
  const h = harness();
  await h.processor.messageCreated(create());
  const single = await h.processor.messagesDeleted({ guildId: TEST_GUILD_ID, channelId: GENERAL, messageIds: ['500000000000000001'], bulk: false });
  assert.ok(single[0]?.stream === 'message');
  assert.deepEqual([single[0].kind, single[0].before, single[0].after], ['delete', 'hello', null]);
  assert.equal(h.store.messages.size, 0);
  assert.equal(h.posts.at(-1)?.message.embeds?.[0]?.title, 'Message deleted');
  // Never stored (bot card, older than the log): nothing logged, nothing posted.
  const posts = h.posts.length;
  assert.deepEqual(await h.processor.messagesDeleted({ guildId: TEST_GUILD_ID, channelId: GENERAL, messageIds: ['500000000000000077'], bulk: false }), []);
  assert.equal(h.posts.length, posts);
  for (let index = 0; index < 12; index++)
    await h.processor.messageCreated(create({ messageId: `5000000000000002${String(index).padStart(2, '0')}`, content: `m${index}`, createdAtMs: NOW - index }));
  const ids = [...h.store.messages.values()].map(message => message.messageId);
  const bulk = await h.processor.messagesDeleted({ guildId: TEST_GUILD_ID, channelId: GENERAL, messageIds: [...ids, '500000000000000088'], bulk: true });
  assert.equal(bulk.length, 12);
  const summary = h.posts.at(-1)!.message.embeds![0]!;
  assert.equal(summary.title, '12 messages bulk deleted');
  assert.match(summary.description!, /and 2 more/);
});

test('retention purge drops old message copies and log entries, runs even when disabled, and is audited', async () => {
  const h = harness(logging(value => { value.messageLog.enabled = false; value.messageLog.retentionDays = 7; }));
  await h.store.storeMessage(TEST_GUILD_ID, { messageId: '500000000000000001', channelId: GENERAL, authorId: USER, content: 'old',
    attachmentCount: 0, createdAtMs: NOW - 8 * DAY_MS, editedAtMs: null });
  await h.store.storeMessage(TEST_GUILD_ID, { messageId: '500000000000000002', channelId: GENERAL, authorId: USER, content: 'new',
    attachmentCount: 0, createdAtMs: NOW - DAY_MS, editedAtMs: null });
  await h.store.recordMessageEvent(TEST_GUILD_ID, { kind: 'delete', channelId: GENERAL, messageId: '500000000000000003', authorId: USER,
    before: 'x', after: null, attachmentCount: 0, occurredAtMs: NOW - 9 * DAY_MS });
  await h.store.recordMemberEvent(TEST_GUILD_ID, { kind: 'join', userId: USER, detail: {}, occurredAtMs: NOW - 90 * DAY_MS });
  assert.deepEqual(await h.processor.purge(), { storedMessages: 1, loggedEntries: 1 });
  assert.equal(h.store.messages.size, 1);
  assert.equal(h.store.entries.length, 1, 'member events are not message history');
  assert.deepEqual(h.audits.map(audit => [audit.kind, audit.payload.reason]), [['logging.retention', 'retention']]);
  await h.processor.purge();
  assert.equal(h.audits.length, 1, 'nothing purged, nothing audited');
});

test('memory store lists with filters and both paging orders', async () => {
  const store = new MemoryLoggingStore();
  for (let index = 0; index < 5; index++)
    await store.recordMemberEvent(TEST_GUILD_ID, { kind: index % 2 ? 'leave' : 'join', userId: index < 3 ? USER : OTHER, detail: {}, occurredAtMs: NOW + index });
  await store.recordMessageEvent(TEST_GUILD_ID, { kind: 'edit', channelId: GENERAL, messageId: '500000000000000001', authorId: USER,
    before: 'a', after: 'b', attachmentCount: 0, occurredAtMs: NOW });
  const base = { stream: 'member' as const, order: 'oldest' as const, after: 0, before: 0, limit: 2, userId: null, kind: null,
    channelId: null, fromMs: null, toMs: null };
  const first = await store.list(TEST_GUILD_ID, base);
  assert.deepEqual(first.entries.map(entry => entry.id), [1, 2]);
  assert.equal(first.nextAfter, 2);
  assert.deepEqual((await store.list(TEST_GUILD_ID, { ...base, after: 2 })).entries.map(entry => entry.id), [3, 4]);
  const newest = await store.list(TEST_GUILD_ID, { ...base, order: 'newest' });
  assert.deepEqual(newest.entries.map(entry => entry.id), [5, 4]);
  const older = await store.list(TEST_GUILD_ID, { ...base, order: 'newest', before: newest.nextAfter });
  assert.deepEqual(older.entries.map(entry => entry.id), [3, 2]);
  const last = await store.list(TEST_GUILD_ID, { ...base, order: 'newest', before: 2 });
  assert.equal(last.nextAfter, 0);
  assert.deepEqual((await store.list(TEST_GUILD_ID, { ...base, limit: 10, kind: 'leave', userId: USER })).entries.map(entry => entry.id), [2]);
  assert.deepEqual((await store.list(TEST_GUILD_ID, { ...base, limit: 10, fromMs: NOW + 3 })).entries.map(entry => entry.id), [4, 5]);
  assert.equal((await store.list(TEST_GUILD_ID, { ...base, stream: 'message', channelId: GENERAL })).entries.length, 1);
  assert.deepEqual(await store.deleteMessageHistory(TEST_GUILD_ID), { storedMessages: 0, loggedEntries: 1 });
});

test('the feature declares opt-in intents and stays idle without them', async () => {
  const settings = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
  const feature = loggingFeature({ store: new MemoryLoggingStore() });
  assert.deepEqual(featurePrivilegedIntents(feature, settings), []);
  settings.logging = logging();
  assert.deepEqual(featurePrivilegedIntents(feature, settings), ['guildMembers', 'messageContent']);

  let processed = 0;
  const store = new MemoryLoggingStore();
  const ctx = fakeFeatureContext({}, settings);
  const fake = loggingFeature({ store, purgeFirstRunMs: 60_000, deps: (context, logStore, read) => ({
    ...harness().deps, guildId: context.guildId, store: logStore, settings: read, intents: () => context.privilegedIntents(),
    post: async () => { processed++; } }) });
  await fake.start(ctx);
  try {
    // The fake context reports every intent 'off' (no login recorded): nothing is stored or posted.
    await fake.handleRaw({ t: 'GUILD_MEMBER_ADD', d: { guild_id: TEST_GUILD_ID, user: { id: USER, username: 'ash' } } });
    await fake.handleRaw({ t: 'MESSAGE_CREATE', d: { guild_id: TEST_GUILD_ID, id: '500000000000000001', channel_id: GENERAL,
      author: { id: USER }, content: 'hi', attachments: [] } });
    assert.equal(store.entries.length + store.messages.size + processed, 0);
    assert.ok(ctx.logs.some(line => /Server Members Intent and Message Content Intent/.test(line)));
  } finally { await fake.stop(); }
});

test('raw packets drive the processor when the intents are on', async () => {
  const settings = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
  settings.logging = logging(value => { value.welcome.enabled = false; value.autoRole.enabled = false; });
  const store = new MemoryLoggingStore();
  const ctx = fakeFeatureContext({ privilegedIntents: () => ({ guildMembers: 'on', messageContent: 'on' }) }, settings);
  const feature = loggingFeature({ store, deps: (context, logStore, read) => ({ ...harness().deps, store: logStore, settings: read,
    intents: () => context.privilegedIntents() }) });
  await feature.start(ctx);
  try {
    await feature.handleRaw({ t: 'GUILD_MEMBER_ADD', d: { guild_id: TEST_GUILD_ID, user: { id: USER, username: 'ash' } } });
    await feature.handleRaw({ t: 'GUILD_MEMBER_ADD', d: { guild_id: '999999999999999991', user: { id: USER, username: 'ash' } } });
    await feature.handleRaw({ t: 'MESSAGE_CREATE', d: { guild_id: TEST_GUILD_ID, id: '500000000000000001', channel_id: GENERAL,
      author: { id: USER }, content: 'hi', attachments: [{ url: 'https://cdn/x.png', filename: 'x.png' }], timestamp: new Date(NOW).toISOString() } });
    await feature.handleRaw({ t: 'MESSAGE_CREATE', d: { id: '500000000000000002', channel_id: GENERAL, author: { id: USER }, content: 'dm' } });
    await feature.handleRaw({ t: 'MESSAGE_DELETE_BULK', d: { guild_id: TEST_GUILD_ID, channel_id: GENERAL, ids: ['500000000000000001'] } });
    assert.deepEqual(store.entries.map(entry => entry.kind), ['join', 'delete']);
    assert.ok(store.entries[1]?.stream === 'message' && store.entries[1].attachmentCount === 1);
    // Live settings: disabling the log stops storing at once.
    settings.logging.messageLog.enabled = false;
    ctx.events.emit({ type: 'adminToolsSettingsChanged', settings: { guildId: TEST_GUILD_ID, version: 2, updatedAtMs: NOW, ...settings } });
    await new Promise(resolve => setTimeout(resolve, 0));
    await feature.handleRaw({ t: 'MESSAGE_CREATE', d: { guild_id: TEST_GUILD_ID, id: '500000000000000003', channel_id: GENERAL,
      author: { id: USER }, content: 'after disable' } });
    assert.equal(store.messages.size, 0);
  } finally { await feature.stop(); }
});

test('logging settings validation (foundation parser) accepts valid sections and rejects bad ones', () => {
  const valid = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto;
  valid.logging = logging();
  assert.deepEqual(parseAdminToolsSettings(valid).logging, valid.logging);
  const bad = (patch: (value: LoggingSettingsDto) => void, message: RegExp) => {
    const body = structuredClone(valid);
    patch(body.logging);
    assert.throws(() => parseAdminToolsSettings(body), message);
  };
  bad(value => { value.messageLog.retentionDays = 0; }, /retention/i);
  bad(value => { value.joinLeave.newAccountDays = 400; }, /New account days/);
  bad(value => { value.welcome.channelId = null; }, /channel for welcome/);
  bad(value => { value.autoRole.roleIds = []; }, /auto-role/);
  bad(value => { value.messageLog.ignoredChannelIds = ['nope']; }, /Ignored channels/);
  bad(value => { value.welcome.message = 'x'.repeat(1001); }, /Welcome message/);
});
