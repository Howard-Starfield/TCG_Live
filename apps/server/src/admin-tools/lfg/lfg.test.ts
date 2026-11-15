import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ComponentType } from 'discord.js';
import { DEFAULT_LFG_SETTINGS, escapeLfgText, LFG_LIMITS, lfgPlayersText, lfgTemplateValues, renderLfgTemplate, type LfgPostDto,
  type LfgSettingsBodyDto } from '@tcg-live/core';
import { call, login, startHarness } from '../../admin/http/test-support.js';
import { DEMO_GUILD_ID } from '../../admin/demo.js';
import { MemoryOpsAuditStore, type OpsActor } from '../../ops/audit.js';
import { LFG_TABLES, TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS, TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS_LFG, adminToolsSetupDecision,
  classifyPublicSchema, directorySetupDecision, evidenceSetupDecision, privateDiscordSetupDecision } from '../../rehearsal/schema-tables.js';
import { createDemoGuild, DEMO_CHANNEL_IDS, DEMO_ROLE_IDS } from '../demo-guild.js';
import type { AdminToolsRouteOptions } from '../routes.js';
import { LFG_MIGRATION } from '../schema.js';
import { MemoryAdminToolsSettingsStore } from '../settings.js';
import { AdminToolsRuntimeState } from '../status.js';
import { handleLfgComponent, handleLfgModal, type LfgInteractionEnv } from './feature.js';
import { MemoryLfgGateway } from './gateway.js';
import { LFG_IDS, lfgCardMessage, lfgFirstMessage, parseLfgCustomId } from './messages.js';
import { lfgRouteModule } from './routes.js';
import { createLfgPost, expireDueLfgPosts, lfgCardsDeleted, lfgMemberAction, refreshLfgCard, resetLfgServiceState,
  type LfgServiceDeps } from './service.js';
import { lfgChannelConfig, lfgChannelProblem, parseLfgSettings } from './settings.js';
import { MemoryLfgPostStore } from './store.js';

const GUILD = '100000000000000001';
const CHANNEL = '200000000000000302';
const ROLE = '200000000000000205';
const VOICE = '200000000000000400';
const user = (n: number) => `30000000000000${String(n).padStart(4, '0')}`;
const MINUTE = 60_000;

function settings(patch: Partial<LfgSettingsBodyDto> = {}): LfgSettingsBodyDto {
  return { ...structuredClone(DEFAULT_LFG_SETTINGS) as LfgSettingsBodyDto, enabled: true,
    channels: [{ channelId: CHANNEL, panel: null, games: [], pingRoleId: null, voiceChannelIds: null }],
    games: [{ name: 'Pokémon TCG', emoji: '⚡', pingRoleId: null }, { name: 'One Piece', emoji: null, pingRoleId: null }],
    formats: ['Standard', 'Casual'], pingRoleId: ROLE, voiceChannelIds: [VOICE], ...patch };
}

interface Rig { deps: LfgServiceDeps; store: MemoryLfgPostStore; gateway: MemoryLfgGateway; audits: Array<{ kind: string; payload: Record<string, unknown>; actor: OpsActor }>;
  clock: { now: number }; body: LfgSettingsBodyDto }
function rig(patch: Partial<LfgSettingsBodyDto> = {}, store = new MemoryLfgPostStore(), gateway = new MemoryLfgGateway(), clock = { now: Date.UTC(2026, 10, 15, 18) }): Rig {
  resetLfgServiceState();
  const audits: Rig['audits'] = [];
  const body = parseLfgSettings(settings(patch));
  return { store, gateway, audits, clock, body, deps: { guildId: GUILD, store, gateway, settings: async () => body, now: () => clock.now,
    audit: async (kind, payload, actor) => { audits.push({ kind, payload, actor }); } } };
}
const post = async (r: Rig, author: string, game = 'Pokémon TCG') => createLfgPost(r.deps, { channelId: CHANNEL, authorId: author, game,
  format: 'Standard', note: null, voiceChannelId: null });

test('migration 014 creates exactly the LFG tables, and every setup guard accepts 013 with or without 014', async () => {
  const sql = await readFile(LFG_MIGRATION, 'utf8');
  const names = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+) \(/g)].map(match => match[1]!);
  assert.deepEqual(names.sort(), [...LFG_TABLES].sort());
  assert.doesNotMatch(sql, /bigserial|CREATE TABLE (?!IF NOT EXISTS)|CREATE INDEX (?!IF NOT EXISTS)|DROP /);
  const before = [...TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS];
  const after = [...TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS_LFG];
  assert.equal(classifyPublicSchema(after), 'v2_directory_evidence_admin_tools_lfg');
  for (const names of [before, after]) {
    assert.equal(adminToolsSetupDecision(names), 'already_ready');
    assert.equal(evidenceSetupDecision(names), 'already_ready');
    assert.equal(directorySetupDecision(names), 'already_ready');
    assert.equal(privateDiscordSetupDecision(names, '2'), 'already_ready');
  }
  assert.equal(classifyPublicSchema([...before, 'tcg_lfg_posts']), 'unexpected', 'half-applied 014');
});

test('settings validation: defaults, placeholders, Discord limits, lists and channels', () => {
  assert.equal(parseLfgSettings(settings()).channels.length, 1);
  assert.deepEqual(parseLfgSettings(structuredClone(DEFAULT_LFG_SETTINGS)).enabled, false);
  const bad = (patch: Partial<LfgSettingsBodyDto>, pattern: RegExp) => assert.throws(() => parseLfgSettings(settings(patch)), pattern);
  bad({ messages: { ...DEFAULT_LFG_SETTINGS.messages, cardBody: 'Hi {nope}' } }, /unknown placeholders: \{nope\}/);
  bad({ messages: { ...DEFAULT_LFG_SETTINGS.messages, cardBody: 'Hi {role}' } }, /unknown placeholders: \{role\}/);
  bad({ messages: { ...DEFAULT_LFG_SETTINGS.messages, pingText: 'Hey {author}' } }, /must contain \{role\}/);
  bad({ messages: { ...DEFAULT_LFG_SETTINGS.messages, cardTitle: '{note}' } }, /Discord allows 256/);
  bad({ messages: { ...DEFAULT_LFG_SETTINGS.messages, cardBody: '{players} {players} {players} {players} {players}' } }, /Discord allows 4096/);
  bad({ games: [{ name: 'A', emoji: null, pingRoleId: null }, { name: 'a', emoji: null, pingRoleId: null }] }, /once/);
  bad({ games: [{ name: 'Bad {game}', emoji: null, pingRoleId: null }] }, /may not contain/);
  bad({ channels: [{ channelId: CHANNEL, panel: null, games: ['Chess'], pingRoleId: null, voiceChannelIds: null }] }, /not in the games list/);
  bad({ channels: [] }, /at least one LFG channel/);
  bad({ expiryMinutes: 10 }, /Expiry/);
  bad({ maxOpenPerUser: -1 }, /Open posts/);
  bad({ form: { ...DEFAULT_LFG_SETTINGS.form, gameLabel: 'x'.repeat(46) } }, /Form game label/);
  assert.throws(() => parseLfgSettings({ ...settings(), extra: 1 }), /unknown fields/);
  // 0 means unlimited open posts; there is no joiner cap setting at all.
  assert.equal(parseLfgSettings(settings({ maxOpenPerUser: 0 })).maxOpenPerUser, 0);
  assert.equal('maxPlayers' in parseLfgSettings(settings()), false);

  const parsed = parseLfgSettings(settings());
  const blocked = { reserved: new Set<string>(), voice: new Set([VOICE]), stickies: new Set<string>(), ticketPanel: null };
  assert.equal(lfgChannelProblem(parsed, blocked), null);
  assert.match(lfgChannelProblem(parsed, { ...blocked, reserved: new Set([CHANNEL]) })!, /tournament/);
  assert.match(lfgChannelProblem(parsed, { ...blocked, stickies: new Set([CHANNEL]) })!, /sticky/);
  assert.match(lfgChannelProblem(parsed, { ...blocked, ticketPanel: CHANNEL })!, /ticket/);
  assert.match(lfgChannelProblem(parsed, { ...blocked, voice: new Set() })!, /voice channels/);
  // Per-channel overrides fall back to the globals.
  const custom = parseLfgSettings(settings({ channels: [{ channelId: CHANNEL, panel: { ...DEFAULT_LFG_SETTINGS.panel, title: 'OP only' },
    games: ['One Piece'], pingRoleId: '200000000000000777', voiceChannelIds: [] }],
    games: [{ name: 'Pokémon TCG', emoji: null, pingRoleId: '200000000000000888' }, { name: 'One Piece', emoji: null, pingRoleId: null }] }));
  const config = lfgChannelConfig(custom, CHANNEL)!;
  assert.deepEqual([config.panel.title, config.games.map(game => game.name), config.voiceChannelIds], ['OP only', ['One Piece'], []]);
  assert.equal(config.pingRoleFor('One Piece'), '200000000000000777');
  assert.equal(config.pingRoleFor('Pokémon TCG'), '200000000000000888', 'a game role wins');
});

test('templates: single-pass placeholders, escaped member text, no pings from notes, "+N more"', () => {
  const values = lfgTemplateValues({ authorId: user(1), game: 'Pokémon TCG', format: null, note: '@everyone **free** <@&123> {author} [x](https://e.vil)',
    voiceChannelId: VOICE, expiresAtMs: 1_800_000_000_000, players: [] }, 20);
  const out = renderLfgTemplate('{author} {note} {voice} {format} {count} {expires}', values);
  assert.ok(out.startsWith(`<@${user(1)}> `));
  assert.ok(out.includes('{author}'), 'a placeholder typed in a note stays literal');
  assert.ok(!out.includes('@everyone'), '@everyone is broken by a zero-width space');
  assert.ok(!/<@&123>/.test(out));
  assert.ok(out.includes('\\*\\*free\\*\\*'));
  assert.ok(out.includes(`<#${VOICE}> any 1 <t:1800000000:R>`));
  assert.equal(escapeLfgText('a_b'), 'a\\_b');
  const many = Array.from({ length: 30 }, (_, index) => user(index));
  assert.match(lfgPlayersText(many, 5), /^(<@\d+>, ){4}<@\d+> \+25 more$/);
  assert.ok(lfgPlayersText(Array.from({ length: 5000 }, (_, index) => user(index)), 50).length <= LFG_LIMITS.playersTextMax);
});

test('the form: game select from the list, voice rooms, and server-side validation of the answers', async () => {
  const r = rig();
  const shown: any[] = [];
  const env: LfgInteractionEnv = { deps: r.deps, voiceNames: async ids => new Map(ids.map(id => [id, 'Lounge'])), onPosted: () => {} };
  await handleLfgComponent({ customId: LFG_IDS.new, channelId: CHANNEL, user: { id: user(1) }, showModal: async (modal: unknown) => { shown.push(modal); },
    reply: async () => {} } as any, env);
  const modal = shown[0];
  assert.equal(modal.custom_id, 'lfg:form');
  const select = modal.components[0].component;
  assert.equal(select.type, ComponentType.StringSelect);
  assert.deepEqual(select.options.map((option: any) => option.value), ['Pokémon TCG', 'One Piece']);
  assert.equal(modal.components[3].component.options[0].label, '🔊 Lounge');
  assert.equal(modal.components.length, 4);
  assert.ok(modal.components.every((item: any) => item.type === ComponentType.Label && item.label.length <= 45));

  const replies: string[] = [];
  const submit = (values: Record<string, string>, author = user(1)) => handleLfgModal({ customId: 'lfg:form', channelId: CHANNEL, user: { id: author },
    fields: { getField: (id: string) => { if (!(id in values)) throw new Error('missing'); return id === 'lfg-note' ? { value: values[id] } : { values: [values[id]] }; } },
    deferReply: async () => {}, editReply: async (reply: { content: string }) => { replies.push(reply.content); }, reply: async () => {} } as any, env);
  await submit({ 'lfg-game': 'Chess' });
  assert.match(replies.at(-1)!, /Pick one of these games/);
  await submit({ 'lfg-game': 'Pokémon TCG', 'lfg-voice': '200000000000000999' });
  assert.match(replies.at(-1)!, /voice rooms/);
  await submit({ 'lfg-game': 'pokémon tcg', 'lfg-format': 'Casual', 'lfg-note': 'GG @here', 'lfg-voice': VOICE });
  assert.match(replies.at(-1)!, /Your Pokémon TCG post is up\. It closes <t:\d+:R>\./);
  const [card] = [...r.gateway.messages.values()];
  assert.equal(card!.message.content, `<@&${ROLE}> <@${user(1)}> is looking for a Pokémon TCG game.`);
  assert.deepEqual(card!.message.allowedMentions, { parse: [], roles: [ROLE], users: [] }, 'only the LFG role can be notified');
  assert.match(card!.message.embeds[0]!.description!, /GG @\u200bhere/);
  assert.match(card!.message.embeds[0]!.description!, new RegExp(`<#${VOICE}>`));
  assert.deepEqual((card!.message.components[0] as any).components.map((button: any) => button.custom_id.split(':')[1]), ['join', 'leave', 'close']);
  assert.equal(r.audits.at(-1)?.kind, 'lfg.posted');
  // Free-text game when no list exists.
  const free = rig({ games: [], formats: [] });
  const freeEnv = { ...env, deps: free.deps };
  const modals: any[] = [];
  await handleLfgComponent({ customId: LFG_IDS.new, channelId: CHANNEL, user: { id: user(1) }, showModal: async (m: unknown) => { modals.push(m); } } as any, freeEnv);
  assert.equal(modals[0].components[0].component.type, ComponentType.TextInput);
  assert.equal(modals[0].components[1].component.type, ComponentType.TextInput);
  assert.deepEqual(parseLfgCustomId('lfg:join:00000000-0000-4000-8000-0000000000AA'), { action: 'join', postId: '00000000-0000-4000-8000-0000000000aa' });
  assert.equal(parseLfgCustomId('lfg:join:nope'), null);
});

test('join/leave are idempotent under rapid clicks, there is no joiner cap, and card edits coalesce', async () => {
  const r = rig({ playerListLimit: 5 });
  const created = await post(r, user(1));
  assert.equal(created.kind, 'created');
  const id = created.kind === 'created' ? created.post.id : '';
  const results = await Promise.all(Array.from({ length: 10 }, () => lfgMemberAction(r.deps, 'join', id, user(2))));
  assert.equal(results.filter(result => result.changed).length, 1);
  assert.equal(results.filter(result => result.message === 'You already joined this game.').length, 9);
  assert.match(results.find(result => result.changed)!.message, /You joined <@\d+>'s Pokémon TCG game\./);
  assert.equal((await lfgMemberAction(r.deps, 'join', id, user(1))).message, 'You are hosting this game.');
  // 300 members join at once: all stored.
  await Promise.all(Array.from({ length: 300 }, (_, index) => lfgMemberAction(r.deps, 'join', id, user(100 + index))));
  await refreshLfgCard(r.deps, id);
  const stored = (await r.store.get(GUILD, id))!;
  assert.equal(stored.players.length, 301);
  const card = r.gateway.messages.get(stored.messageId!)!;
  assert.ok(card.edits < 50, `edits coalesce (${card.edits})`);
  assert.match(card.message.embeds[0]!.description!, /\*\*Players \(302\):\*\* (<@\d+>, ){4}<@\d+> \+297 more/);
  const leaves = await Promise.all(Array.from({ length: 5 }, () => lfgMemberAction(r.deps, 'leave', id, user(2))));
  assert.equal(leaves.filter(result => result.changed).length, 1);
  assert.equal((await lfgMemberAction(r.deps, 'leave', id, user(2))).message, 'You have not joined this game.');
  assert.deepEqual(new Set(r.audits.map(item => item.kind)), new Set(['lfg.posted', 'lfg.joined', 'lfg.left']));
});

test('max open posts and the posting cooldown answer with friendly errors', async () => {
  const r = rig({ maxOpenPerUser: 1, cooldownMinutes: 10 });
  assert.equal((await post(r, user(1))).kind, 'created');
  const second = await post(r, user(1));
  assert.ok(second.kind === 'refused' && /already have an open LFG post/.test(second.message));
  const first = (await r.store.list(GUILD, { status: 'open', limit: 5 }))[0]!;
  await r.store.close(GUILD, first.id, 'closed', 'author', r.clock.now);
  const third = await post(r, user(1));
  assert.ok(third.kind === 'refused' && /post again in 10 minute/.test(third.message));
  r.clock.now += 10 * MINUTE;
  assert.equal((await post(r, user(1))).kind, 'created');

  const unlimited = rig({ maxOpenPerUser: 0, cooldownMinutes: 0 });
  for (let index = 0; index < 4; index += 1) assert.equal((await post(unlimited, user(1))).kind, 'created');
  // Concurrent double submit: one post only.
  const racy = rig({ maxOpenPerUser: 1, cooldownMinutes: 0 });
  const both = await Promise.all([post(racy, user(5)), post(racy, user(5))]);
  assert.equal(both.filter(item => item.kind === 'created').length, 1);
  // A card that cannot be sent frees the slot again.
  const failing = rig();
  failing.gateway.failSend = Object.assign(new Error('Missing Access'), { code: 50001 });
  const refused = await post(failing, user(1));
  assert.ok(refused.kind === 'refused' && /cannot post in this channel/.test(refused.message));
  assert.equal((await failing.store.list(GUILD, { limit: 5 })).length, 0);
});

test('the role ping respects its cooldown and never pings other roles', async () => {
  const r = rig({ pingCooldownMinutes: 30, cooldownMinutes: 0, maxOpenPerUser: 0 });
  const a = await post(r, user(1));
  const b = await post(r, user(2));
  assert.ok(a.kind === 'created' && b.kind === 'created');
  assert.equal(a.post.pingedRoleId, ROLE);
  assert.equal(b.post.pingedRoleId, null, 'within the cooldown: no ping');
  const second = r.gateway.messages.get(b.post.messageId!)!;
  assert.equal(second.message.content, undefined);
  assert.deepEqual(second.message.allowedMentions, { parse: [], roles: [], users: [] });
  r.clock.now += 30 * MINUTE;
  const c = await post(r, user(3));
  assert.ok(c.kind === 'created' && c.post.pingedRoleId === ROLE);
  // A game's own role has its own cooldown.
  const game = rig({ games: [{ name: 'Pokémon TCG', emoji: null, pingRoleId: '200000000000000888' }, { name: 'One Piece', emoji: null, pingRoleId: null }],
    cooldownMinutes: 0, maxOpenPerUser: 0 });
  const g1 = await post(game, user(1), 'Pokémon TCG');
  const g2 = await post(game, user(2), 'One Piece');
  assert.ok(g1.kind === 'created' && g1.post.pingedRoleId === '200000000000000888');
  assert.ok(g2.kind === 'created' && g2.post.pingedRoleId === ROLE);
  assert.deepEqual(lfgFirstMessage(g1.post, game.body).allowedMentions.roles, ['200000000000000888']);
});

test('expiry closes cards on time, also after a restart, and card edits never ping', async () => {
  const store = new MemoryLfgPostStore();
  const gateway = new MemoryLfgGateway();
  const clock = { now: Date.UTC(2026, 10, 15, 18) };
  const r = rig({ expiryMinutes: 30, maxOpenPerUser: 0, cooldownMinutes: 0 }, store, gateway, clock);
  const one = await post(r, user(1));
  const two = await post(r, user(2));
  assert.ok(one.kind === 'created' && two.kind === 'created');
  clock.now += 29 * MINUTE;
  assert.equal(await expireDueLfgPosts(r.deps), 0);
  // "Restart": new service state, same storage and Discord; the bot was off when the posts expired.
  clock.now += 3 * 60 * MINUTE;
  const restarted = rig({ expiryMinutes: 30, maxOpenPerUser: 0, cooldownMinutes: 0 }, store, gateway, clock);
  assert.equal(await expireDueLfgPosts(restarted.deps), 2);
  assert.equal(await expireDueLfgPosts(restarted.deps), 0, 'expires once');
  const expired = (await store.get(GUILD, one.post.id))!;
  assert.equal(expired.status, 'expired');
  const card = gateway.messages.get(expired.messageId!)!.message;
  assert.ok((card.components[0] as any).components.every((button: any) => button.disabled === true));
  assert.match(card.embeds[0]!.description!, /This post expired\. Players \(1\)/);
  assert.equal(card.content, undefined);
  assert.deepEqual(card.allowedMentions.roles, []);
  assert.equal((await lfgMemberAction(restarted.deps, 'join', one.post.id, user(9))).message, 'This post is closed.');
  assert.deepEqual(restarted.audits.map(item => item.kind), ['lfg.expired', 'lfg.expired']);
});

test('close by author or staff only, and cards deleted by hand mark their post deleted', async () => {
  const r = rig({ maxOpenPerUser: 0, cooldownMinutes: 0 });
  const env: LfgInteractionEnv = { deps: r.deps, voiceNames: async () => new Map(), onPosted: () => {} };
  const created = await post(r, user(1));
  assert.ok(created.kind === 'created');
  const replies: string[] = [];
  const click = (id: string, staff: boolean) => handleLfgComponent({ customId: LFG_IDS.close(created.post.id), channelId: CHANNEL, user: { id },
    memberPermissions: { has: () => staff }, deferReply: async () => {}, editReply: async (reply: { content: string }) => { replies.push(reply.content); } } as any, env);
  await click(user(7), false);
  assert.match(replies.at(-1)!, /Only the member who posted this or the staff/);
  await click(user(7), true);
  assert.equal(replies.at(-1), 'The post is closed.');
  await click(user(1), false);
  assert.equal(replies.at(-1), 'This post is already closed.');
  assert.equal((await r.store.get(GUILD, created.post.id))!.closedBy, 'staff');

  // A configured tournament staff role may close a card too (no Manage Messages needed); other roles may not.
  const STAFF_ROLE = '500000000000000001';
  const staffEnv: LfgInteractionEnv = { ...env, staffRoleIds: async () => [STAFF_ROLE] };
  const fourth = await post(r, user(5));
  assert.ok(fourth.kind === 'created');
  const clickAs = (roles: string[]) => handleLfgComponent({ customId: LFG_IDS.close(fourth.post.id), channelId: CHANNEL, user: { id: user(8) },
    member: { roles }, memberPermissions: { has: () => false }, deferReply: async () => {},
    editReply: async (reply: { content: string }) => { replies.push(reply.content); } } as any, staffEnv);
  await clickAs(['500000000000000002']);
  assert.match(replies.at(-1)!, /Only the member who posted this or the staff/);
  await clickAs([STAFF_ROLE]);
  assert.equal(replies.at(-1), 'The post is closed.');
  assert.equal((await r.store.get(GUILD, fourth.post.id))!.closedBy, 'staff');

  const other = await post(r, user(2));
  assert.ok(other.kind === 'created');
  assert.equal(await lfgCardsDeleted(r.deps, { messageIds: [other.post.messageId!] }), 1);
  assert.equal((await r.store.get(GUILD, other.post.id))!.status, 'deleted');
  // A card that vanished is noticed on its next edit.
  const third = await post(r, user(3));
  assert.ok(third.kind === 'created');
  r.gateway.messages.delete(third.post.messageId!);
  await lfgMemberAction(r.deps, 'join', third.post.id, user(4));
  await refreshLfgCard(r.deps, third.post.id);
  assert.equal((await r.store.get(GUILD, third.post.id))!.status, 'deleted');
});

function options(audit = new MemoryOpsAuditStore()): AdminToolsRouteOptions {
  return { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
    status: new AdminToolsRuntimeState([], 'demo'), demo: createDemoGuild(DEMO_GUILD_ID), modules: [lfgRouteModule()] };
}

test('LFG routes: demo data, versioned settings with checks, filters, close/delete, stats, capabilities', async () => {
  const audit = new MemoryOpsAuditStore();
  const harness = await startHarness({ adminTools: options(audit) });
  try {
    const token = await login(harness);
    const saved = (await call(harness.port, '/api/v1/admin-tools/lfg/settings', { token })).json();
    assert.equal(saved.enabled, true);
    assert.equal(saved.channels[0].channelId, DEMO_CHANNEL_IDS.general);
    const list = (await call(harness.port, '/api/v1/admin-tools/lfg/posts', { token })).json();
    assert.equal(list.posts.length, 4);
    assert.ok(list.posts.some((item: LfgPostDto) => item.players.length === 22), 'demo shows a big game');
    assert.equal((await call(harness.port, '/api/v1/admin-tools/lfg/posts?status=active', { token })).json().posts.length, 2);
    assert.equal((await call(harness.port, '/api/v1/admin-tools/lfg/posts?game=Yu-Gi-Oh!', { token })).json().posts[0].status, 'expired');
    assert.equal((await call(harness.port, '/api/v1/admin-tools/lfg/posts?status=nope', { token })).status, 400);
    const stats = (await call(harness.port, '/api/v1/admin-tools/lfg/stats?days=7', { token })).json();
    assert.deepEqual([stats.posts, stats.open, stats.joins], [4, 2, 26]);

    const body = (patch: Record<string, unknown>) => ({ expectedVersion: saved.version, settings: { ...saved, guildId: undefined, version: undefined,
      updatedAtMs: undefined, ...patch } });
    const strip = (value: any) => JSON.parse(JSON.stringify(value));
    const reserved = await call(harness.port, '/api/v1/admin-tools/lfg/settings', { method: 'PUT', token,
      body: JSON.stringify(strip(body({ channels: [{ ...saved.channels[0], channelId: DEMO_CHANNEL_IDS.signup }] }))) });
    assert.equal(reserved.status, 400);
    assert.match(reserved.json().error.message, /tournament/);
    const ok = await call(harness.port, '/api/v1/admin-tools/lfg/settings', { method: 'PUT', token, body: JSON.stringify(strip(body({ expiryMinutes: 60 }))) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json().version, saved.version + 1);
    const stale = await call(harness.port, '/api/v1/admin-tools/lfg/settings', { method: 'PUT', token, body: JSON.stringify(strip(body({ expiryMinutes: 90 }))) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json().current.expiryMinutes, 60);
    assert.equal(audit.entries.at(-1)?.kind, 'lfg.settings');
    assert.deepEqual(audit.entries.at(-1)?.payload.changed, ['expiryMinutes']);

    const open = list.posts.find((item: LfgPostDto) => item.status === 'open');
    const closed = await call(harness.port, `/api/v1/admin-tools/lfg/posts/${open.id}/close`, { method: 'POST', token });
    assert.equal(closed.json().status, 'closed');
    assert.equal((await call(harness.port, `/api/v1/admin-tools/lfg/posts/${open.id}/close`, { method: 'POST', token })).status, 409);
    assert.equal((await call(harness.port, `/api/v1/admin-tools/lfg/posts/${open.id}`, { method: 'DELETE', token })).json().status, 'deleted');
    assert.deepEqual(audit.entries.slice(-2).map(entry => entry.kind), ['lfg.closed', 'lfg.deleted']);
    assert.equal((await call(harness.port, '/api/v1/admin-tools/lfg/posts/00000000-0000-4000-8000-000000000000/close', { method: 'POST', token })).status, 404);
    const panels = (await call(harness.port, '/api/v1/admin-tools/lfg/panels', { token })).json();
    assert.equal(panels.panels[0].state, 'posted');
    assert.equal((await call(harness.port, '/api/v1/admin-tools/lfg/panels/refresh', { method: 'POST', token })).status, 200);
    assert.equal(audit.entries.at(-1)?.kind, 'lfg.panel');
  } finally { await harness.stop(); }

  const reader = await startHarness({ adminTools: options() }, { capabilities: ['dashboard.read', 'members.read'] });
  try {
    const token = await login(reader);
    assert.equal((await call(reader.port, '/api/v1/admin-tools/lfg/posts', { token })).status, 200);
    assert.equal((await call(reader.port, '/api/v1/admin-tools/lfg/settings', { method: 'PUT', token, body: '{}' })).status, 403);
    assert.equal((await call(reader.port, '/api/v1/admin-tools/lfg/posts/00000000-0000-4000-8000-000000000000/close', { method: 'POST', token })).status, 403);
  } finally { await reader.stop(); }
  void lfgCardMessage; void DEMO_ROLE_IDS;
});
