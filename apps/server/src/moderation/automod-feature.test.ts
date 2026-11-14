import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { GatewayIntentBits, type Client } from 'discord.js';
import type { ModerationSettingsDto } from '@tcg-live/core';
import { DiscordFeatureEvents, type DiscordFeatureContext, type MatchRoomInfo } from '../discord/features.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { autoModFeature, type AutoModExecutionLike } from './automod-feature.js';
import { BOT, FakeRuleManager, GUILD, settingsWith, textSettings } from './automod-testing.js';
import { MemoryModerationFlagStore } from './flags.js';
import { MemoryModerationSettingsStore } from './settings.js';

const ROOM = '723456789012345678';
const USER = '823456789012345678';
const EVENT = '11111111-1111-4111-8111-111111111111';
const settle = async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve)); };

function harness(settings: ModerationSettingsDto) {
  const client = new EventEmitter();
  const audit = new MemoryOpsAuditStore();
  const flags = new MemoryModerationFlagStore(audit);
  const ids = new MemoryModerationSettingsStore(audit);
  const manager = new FakeRuleManager();
  const events = new DiscordFeatureEvents();
  const logs: string[] = [];
  let current = settings;
  const rooms: MatchRoomInfo[] = [{ eventId: EVENT, matchId: 'M3', voiceChannelId: ROOM, playerIds: [USER] }];
  const context = {
    client: client as unknown as Client, guildId: GUILD, adminId: BOT, isActive: () => true,
    moderationSettings: async () => current,
    appendFlag: input => flags.append(input), appendAudit: input => audit.append(input),
    on: (type, listener) => events.on(type, listener),
    activeMatchRooms: async () => rooms, matchRoom: async () => null,
    log: message => { logs.push(message); }
  } as Partial<DiscordFeatureContext> as DiscordFeatureContext;
  const feature = autoModFeature({ ids, deps: () => ({ rules: async () => manager, botUserId: () => BOT, ids }), dedupeMs: 5_000 });
  return { client, audit, flags, ids, manager, events, logs, context, feature, setSettings: (next: ModerationSettingsDto) => { current = next; } };
}
const execution = (ruleId: string, overrides: Partial<AutoModExecutionLike> = {}): AutoModExecutionLike => ({
  guild: { id: GUILD }, ruleId, userId: USER, channelId: ROOM, messageId: null, content: '', matchedKeyword: 'noob',
  matchedContent: null, ...overrides });

test('requests only the AutoModerationExecution intent', () => {
  assert.deepEqual(autoModFeature().intents, [GatewayIntentBits.AutoModerationExecution]);
});

test('syncs at start and after each settings save, auditing automod.synced', async () => {
  const text = textSettings({ customLists: [{ id: 'trash', name: 'Trash talk', enabled: true, words: ['noob'], regexPatterns: [],
    allowList: [], action: 'block', timeoutSeconds: 600 }] });
  const h = harness(settingsWith(text));
  await h.feature.start(h.context);
  await settle();
  assert.equal(h.manager.rules.size, 2);
  h.events.emit({ type: 'moderationSettingsChanged', settings: settingsWith({ ...text, enabled: false }, 2) });
  await settle();
  assert.ok([...h.manager.rules.values()].every(rule => !rule.enabled));
  const synced = (await h.audit.list()).entries.filter(entry => entry.kind === 'automod.synced');
  assert.deepEqual(synced.map(entry => entry.payload.status), ['synced', 'disabled']);
  await h.feature.stop();
  h.events.emit({ type: 'moderationSettingsChanged', settings: settingsWith(text, 3) });
  await settle();
  assert.ok([...h.manager.rules.values()].every(rule => !rule.enabled), 'stopped features no longer sync');
});

test('one flag per blocked message across its action executions, with the match room resolved', async () => {
  const text = textSettings({ alertChannelId: '423456789012345678', customLists: [{ id: 'trash', name: 'Trash talk', enabled: true,
    words: ['noob'], regexPatterns: [], allowList: [], action: 'timeout', timeoutSeconds: 600 }] });
  const h = harness(settingsWith(text));
  await h.feature.start(h.context);
  await settle();
  const ruleId = (await h.ids.getAutoModRuleIds(GUILD))['custom:trash']!;
  const long = 'x'.repeat(500);
  // Block, timeout and alert each dispatch one execution for the same message.
  for (let index = 0; index < 3; index += 1) h.client.emit('autoModerationActionExecution', execution(ruleId, { content: long }));
  await settle();
  assert.equal(h.flags.flags.length, 1);
  const flag = h.flags.flags[0]!;
  assert.equal(flag.kind, 'keyword');
  assert.equal(flag.matchId, 'M3');
  assert.equal(flag.eventId, EVENT);
  assert.equal(flag.userId, USER);
  assert.equal(flag.channelId, ROOM);
  assert.deepEqual(flag.kind === 'keyword' && { ...flag.detail, matchedContent: flag.detail.matchedContent?.length },
    { ruleId, ruleName: 'TCG Live – Trash talk', action: 'timeout', matchedKeyword: 'noob', matchedContent: 200 });
  assert.equal((await h.audit.list()).entries.filter(entry => entry.kind === 'automod.executed').length, 1);

  // Without Message Content, content is empty: the flag still records with no excerpt; elsewhere, no match.
  h.client.emit('autoModerationActionExecution', execution(ruleId, { channelId: '923456789012345678', matchedKeyword: 'scrub' }));
  await settle();
  assert.equal(h.flags.flags.length, 2);
  assert.equal(h.flags.flags[1]!.matchId, null);
  assert.equal(h.flags.flags[1]!.kind === 'keyword' && h.flags.flags[1]!.detail.matchedContent, null);
  await h.feature.stop();
});

test('ignores executions of rules the bot does not own and of other guilds', async () => {
  const h = harness(settingsWith(textSettings()));
  await h.feature.start(h.context);
  await settle();
  const presetId = (await h.ids.getAutoModRuleIds(GUILD)).preset!;
  h.client.emit('autoModerationActionExecution', execution('999999999999999999'));
  h.client.emit('autoModerationActionExecution', execution(presetId, { guild: { id: '999999999999999998' } }));
  await settle();
  assert.equal(h.flags.flags.length, 0);
  h.client.emit('autoModerationActionExecution', execution(presetId));
  await settle();
  assert.equal(h.flags.flags.length, 1);
  assert.equal(h.flags.flags[0]!.kind === 'keyword' && h.flags.flags[0]!.detail.ruleName, 'TCG Live – preset filter');
  await h.feature.stop();
  assert.equal(h.client.listenerCount('autoModerationActionExecution'), 0);
});
