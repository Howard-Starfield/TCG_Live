import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EmbedDto, MessageBodyDto } from '@tcg-live/core';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { call, login, startHarness } from '../../admin/http/test-support.js';
import { MemoryOpsAuditStore } from '../../ops/audit.js';
import { fakeFeatureContext } from '../../discord/feature-testing.js';
import { createDemoGuild, DEMO_CHANNEL_IDS, DEMO_ROLE_IDS } from '../demo-guild.js';
import { DemoRolesGuildPort } from '../roles/guild-port.js';
import { demoPortFor } from '../roles/port.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { AnnouncementScheduler, announcementMessage, announcementView, MemoryAnnouncementStore, parseAnnouncementInput,
  type StoredAnnouncement } from './announcements.js';
import { announcementsFeature } from './feature.js';
import { announcementsRouteModule } from './routes.js';
import { ANNOUNCEMENT_GRACE_MS } from './types.js';

const NOW = Date.UTC(2026, 10, 14, 12);
const embed = (patch: Partial<EmbedDto> = {}): EmbedDto => ({ title: 'Season 3', description: '**Signups open**', color: 0xf59e0b, url: null,
  imageUrl: null, thumbnailUrl: null, footer: null, fields: [], ...patch });
const body = (patch: Partial<EmbedDto> = {}): MessageBodyDto => ({ content: 'Read this @everyone', embed: embed(patch) });
const input = (patch: Record<string, unknown> = {}) => ({ channelId: DEMO_CHANNEL_IDS.announcements, body: body(), mentionRoleIds: [],
  scheduledAtMs: null, ...patch });

test('Discord embed limits and https-only images are enforced', () => {
  const parse = (value: unknown) => parseAnnouncementInput(value, DEMO_GUILD_ID, NOW);
  assert.doesNotThrow(() => parse(input({ body: body({ title: 't'.repeat(256), description: 'd'.repeat(4096) }) })));
  assert.throws(() => parse(input({ body: body({ title: 't'.repeat(257) }) })), /title/);
  assert.throws(() => parse(input({ body: body({ description: 'd'.repeat(4097) }) })), /description/);
  const field = { name: 'n', value: 'v', inline: false };
  assert.doesNotThrow(() => parse(input({ body: body({ fields: Array(25).fill(field) }) })));
  assert.throws(() => parse(input({ body: body({ fields: Array(26).fill(field) }) })), /25 fields/);
  const big = { name: 'n'.repeat(200), value: 'v'.repeat(1000), inline: true };
  assert.throws(() => parse(input({ body: body({ description: null, fields: Array(5).fill(big) }) })), /6000/);
  assert.throws(() => parse(input({ body: body({ imageUrl: 'http://example.com/a.png' }) })), /https/);
  assert.equal(parse(input({ body: body({ thumbnailUrl: 'https://example.com/t.png' }) })).body.embed!.thumbnailUrl, 'https://example.com/t.png');
  assert.throws(() => parse(input({ scheduledAtMs: NOW - 1 })), /future/);
  assert.throws(() => parse(input({ mentionRoleIds: [DEMO_GUILD_ID] })), /@everyone switch/);
  assert.throws(() => parse(input({ mentionRoleIds: Array.from({ length: 11 }, (_, n) => `30000000000000000${String(n).padStart(2, '0')}`) })), /at most 10/);
});

test('mention safety: nothing pings by default, roles and @everyone only when chosen', () => {
  const none = announcementMessage({ body: body(), mentionRoleIds: [], mentionEveryone: false });
  assert.deepEqual(none.allowedMentions, { parse: [], roles: [], users: [] });
  assert.equal(none.content, 'Read this @everyone'); // Typed text, but allowedMentions keeps it silent.
  assert.equal(parseAnnouncementInput(input(), DEMO_GUILD_ID, NOW).mentionEveryone, false);
  const roles = announcementMessage({ body: body(), mentionRoleIds: [DEMO_ROLE_IDS.player], mentionEveryone: false });
  assert.deepEqual(roles.allowedMentions, { parse: [], roles: [DEMO_ROLE_IDS.player], users: [] });
  assert.equal(roles.content, `<@&${DEMO_ROLE_IDS.player}> Read this @everyone`);
  const everyone = announcementMessage({ body: { content: null, embed: embed() }, mentionRoleIds: [], mentionEveryone: true });
  assert.deepEqual(everyone.allowedMentions.parse, ['everyone']);
  assert.equal(everyone.content, '@everyone');
  assert.equal(everyone.embeds[0]!.description, '**Signups open**');
});

function scheduled(id: string, atMs: number): StoredAnnouncement {
  return { id, guildId: DEMO_GUILD_ID, channelId: DEMO_CHANNEL_IDS.announcements, body: body(), mentionRoleIds: [], mentionEveryone: false,
    scheduledAtMs: atMs, status: 'scheduled', messageId: null, sentAtMs: null, error: null, createdAtMs: 1, updatedAtMs: 1 };
}

test('scheduler: due sends, < 1 h late sends on start, older is marked missed, future waits', async () => {
  const store = new MemoryAnnouncementStore();
  const port = new DemoRolesGuildPort(createDemoGuild(DEMO_GUILD_ID));
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004'];
  await store.create(scheduled(ids[0]!, NOW - 1_000));
  await store.create(scheduled(ids[1]!, NOW - ANNOUNCEMENT_GRACE_MS + 60_000));
  await store.create(scheduled(ids[2]!, NOW - ANNOUNCEMENT_GRACE_MS - 60_000));
  await store.create(scheduled(ids[3]!, NOW + 60_000));
  const audits: string[] = [];
  const scheduler = new AnnouncementScheduler({ store, guildId: DEMO_GUILD_ID, port: async () => port, now: () => NOW,
    audit: async kind => { audits.push(kind); } });
  assert.equal(await scheduler.tick(), 3);
  const [sent, late, missed, future] = await Promise.all(ids.map(id => store.get(DEMO_GUILD_ID, id)));
  assert.equal(sent!.status, 'sent');
  assert.ok(port.messages.has(sent!.messageId!));
  assert.equal(late!.status, 'sent');
  assert.equal(missed!.status, 'failed');
  assert.equal(announcementView(missed!).missed, true);
  assert.equal(future!.status, 'scheduled');
  assert.equal(port.messages.size, 2);
  assert.deepEqual(audits.sort(), ['announcement.failed', 'announcement.sent', 'announcement.sent']);
  assert.equal(await scheduler.tick(), 0); // Nothing is sent twice.
});

test('the feature runs the catch-up on start and sends failures as failed, not missed', async () => {
  const store = new MemoryAnnouncementStore();
  const port = new DemoRolesGuildPort(createDemoGuild(DEMO_GUILD_ID));
  const id = '00000000-0000-4000-8000-000000000009';
  await store.create({ ...scheduled(id, NOW - 10_000), channelId: '200000000000077777' }); // Unknown channel.
  const feature = announcementsFeature({ store, port: async () => port, now: () => NOW, tickMs: 60_000 });
  const ctx = fakeFeatureContext({ guildId: DEMO_GUILD_ID });
  await feature.start(ctx);
  await feature.stop();
  const item = (await store.get(DEMO_GUILD_ID, id))!;
  assert.equal(item.status, 'failed');
  assert.equal(announcementView(item).missed, false);
  assert.match(item.error!, /channel no longer exists/);
  assert.deepEqual((await ctx.auditStore.list()).entries.map(entry => entry.kind), ['announcement.failed']);
});

test('announcement routes: send now, schedule, edit a sent message in place, history, delete', async () => {
  const audit = new MemoryOpsAuditStore();
  const options: AdminToolsRouteOptions = { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory',
    guildId: () => DEMO_GUILD_ID, status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID),
    modules: [announcementsRouteModule({ demoTimer: false })] };
  const harness = await startHarness({ adminTools: options });
  try {
    const token = await login(harness);
    const request = (path: string, method = 'GET', payload?: unknown) => call(harness.port, `/api/v1/admin-tools/${path}`,
      { method, token, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const port = demoPortFor(options.demo!);
    const sent = await request('announcements', 'POST', input({ mentionRoleIds: [DEMO_ROLE_IDS.player] }));
    assert.equal(sent.status, 201, sent.text);
    assert.equal(sent.json().status, 'sent');
    const message = port.messages.get(sent.json().messageId)!.message;
    assert.deepEqual(message.allowedMentions, { parse: [], roles: [DEMO_ROLE_IDS.player], users: [] });
    const later = await request('announcements', 'POST', input({ scheduledAtMs: Date.now() + 3_600_000 }));
    assert.equal(later.json().status, 'scheduled');
    const draft = await request('announcements', 'POST', input({ draft: true }));
    assert.equal(draft.json().status, 'draft');
    const edited = await request(`announcements/${sent.json().id}`, 'PUT', input({ body: body({ title: 'Season 3 (updated)' }), mentionRoleIds: [DEMO_ROLE_IDS.player] }));
    assert.equal(edited.status, 200, edited.text);
    assert.equal(port.messages.get(sent.json().messageId)!.message.embeds[0]!.title, 'Season 3 (updated)');
    assert.equal((await request(`announcements/${sent.json().id}`, 'PUT', input({ channelId: DEMO_CHANNEL_IDS.general }))).status, 400);
    const fromDraft = await request(`announcements/${draft.json().id}/send`, 'POST');
    assert.equal(fromDraft.json().status, 'sent');
    const history = (await request('announcements')).json().announcements;
    assert.equal(history.length, 3);
    assert.equal((await request(`announcements/${sent.json().id}`, 'DELETE')).json().messageDeleted, true);
    assert.equal(port.messages.has(sent.json().messageId), false);
    const kinds = (await audit.list()).entries.map(entry => entry.kind);
    assert.deepEqual(kinds, ['announcement.saved', 'announcement.sent', 'announcement.saved', 'announcement.saved', 'announcement.saved',
      'announcement.sent', 'announcement.deleted']);
  } finally { await harness.stop(); }
});
