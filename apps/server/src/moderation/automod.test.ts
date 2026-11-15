import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoModerationActionType, AutoModerationRuleKeywordPresetType } from 'discord.js';
import type { CustomKeywordListDto } from '@tcg-live/core';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { OpsInputError } from '../ops/errors.js';
import { AUTOMOD_PERMISSION_HINT, AutoModValidationError, planAutoMod, PRESET_RULE_NAME, syncAutoMod, validateAutoModText,
  type AutoModSyncDeps } from './automod.js';
import { ALERT, AutoModerationRuleTriggerType, BOT, FakeRuleManager, GUILD, settingsWith, textSettings } from './automod-testing.js';
import { MemoryModerationSettingsStore } from './settings.js';

const list = (overrides: Partial<CustomKeywordListDto> = {}): CustomKeywordListDto => ({
  id: 'trash', name: 'Trash talk', enabled: true, words: ['noob'], regexPatterns: [], allowList: [], action: 'block',
  timeoutSeconds: 600, ...overrides });
const errorsOf = (overrides: Parameters<typeof textSettings>[0]) => planAutoMod(textSettings(overrides)).errors;

test('maps the preset filter and custom lists to Discord AutoMod payloads with per-rule actions', () => {
  const text = textSettings({ alertChannelId: ALERT, exemptChannelIds: ['523456789012345678'], exemptRoleIds: ['623456789012345678'],
    preset: { enabled: true, presets: { profanity: true, sexual: false, slurs: true }, action: 'flag', allowList: ['scunthorpe'] },
    customLists: [list({ action: 'timeout', regexPatterns: ['n+o+b'], allowList: ['noobie'] }), list({ id: 'b', name: 'Blocked', action: 'block' })] });
  const { rules, errors } = planAutoMod(text);
  assert.deepEqual(errors, []);
  const [preset, timeout, block] = rules;
  assert.equal(preset!.payload!.name, PRESET_RULE_NAME);
  assert.equal(preset!.payload!.triggerType, AutoModerationRuleTriggerType.KeywordPreset);
  assert.deepEqual(preset!.payload!.triggerMetadata, { presets: [AutoModerationRuleKeywordPresetType.Profanity,
    AutoModerationRuleKeywordPresetType.Slurs], allowList: ['scunthorpe'] });
  // 'flag' alerts only: the message still posts.
  assert.deepEqual(preset!.payload!.actions, [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: ALERT } }]);
  assert.deepEqual(preset!.payload!.exemptChannels, ['523456789012345678']);
  assert.deepEqual(preset!.payload!.exemptRoles, ['623456789012345678']);
  assert.equal(timeout!.key, 'custom:trash');
  assert.equal(timeout!.payload!.name, 'TCG Live – Trash talk');
  assert.equal(timeout!.payload!.triggerType, AutoModerationRuleTriggerType.Keyword);
  assert.deepEqual(timeout!.payload!.triggerMetadata, { keywordFilter: ['noob'], regexPatterns: ['n+o+b'], allowList: ['noobie'] });
  assert.deepEqual(timeout!.payload!.actions.map(action => action.type), [AutoModerationActionType.BlockMessage,
    AutoModerationActionType.Timeout, AutoModerationActionType.SendAlertMessage]);
  assert.equal(timeout!.payload!.actions[0]!.metadata!.customMessage, text.blockMessage);
  assert.equal(timeout!.payload!.actions[1]!.metadata!.durationSeconds, 600);
  assert.deepEqual(block!.payload!.actions.map(action => action.type), [AutoModerationActionType.BlockMessage, AutoModerationActionType.SendAlertMessage]);
});

test('disabled text moderation, preset or list plans no active rule and reports no errors', () => {
  const off = planAutoMod(textSettings({ enabled: false, customLists: [list({ action: 'flag' })] }));
  assert.deepEqual(off.errors, []);
  assert.ok(off.rules.every(rule => rule.payload === null));
  const partly = planAutoMod(textSettings({ customLists: [list({ enabled: false, words: [] })],
    preset: { ...textSettings().preset, enabled: false } }));
  assert.deepEqual(partly.errors, []);
  assert.ok(partly.rules.every(rule => rule.payload === null));
});

test('action validation: flag needs an alert channel, the preset cannot time out, timeouts stay in range', () => {
  assert.match(errorsOf({ customLists: [list({ action: 'flag' })] }).join(' '), /needs an alert channel/);
  assert.match(errorsOf({ preset: { ...textSettings().preset, action: 'flag' } }).join(' '), /Preset filter.*alert channel/);
  assert.deepEqual(errorsOf({ alertChannelId: ALERT, customLists: [list({ action: 'flag' })] }), []);
  // The contract forbids it, but a hand-built body must still not reach Discord.
  const presetTimeout = { ...textSettings().preset, action: 'timeout' as 'block' };
  assert.match(errorsOf({ preset: presetTimeout }).join(' '), /does not allow a timeout on the preset/);
  assert.match(errorsOf({ customLists: [list({ action: 'timeout', timeoutSeconds: 10 })] }).join(' '), /timeout must be 60-2419200/);
  assert.match(errorsOf({ customLists: [list({ action: 'timeout', timeoutSeconds: 2_419_201 })] }).join(' '), /timeout/);
  assert.match(errorsOf({ preset: { ...textSettings().preset, presets: { profanity: false, sexual: false, slurs: false } } }).join(' '),
    /no list is selected/);
  assert.match(errorsOf({ customLists: [list({ words: [], regexPatterns: [] })] }).join(' '), /no words or patterns/);
  assert.throws(() => validateAutoModText(textSettings({ customLists: [list({ action: 'flag' })] })),
    (error: unknown) => error instanceof AutoModValidationError && error instanceof OpsInputError);
});

test('enforces every Discord AutoMod limit with a clear error', () => {
  const many = (count: number, length = 3) => Array.from({ length: count }, (_, index) => `${index}`.padStart(length, 'w'));
  const cases: Array<[Parameters<typeof textSettings>[0], RegExp]> = [
    [{ customLists: [list({ words: many(1001) })] }, /words has 1001 entries; Discord allows 1000/],
    [{ customLists: [list({ words: ['x'.repeat(61)] })] }, /words entries must be at most 60/],
    [{ customLists: [list({ regexPatterns: many(11) })] }, /patterns has 11 entries; Discord allows 10/],
    [{ customLists: [list({ regexPatterns: ['x'.repeat(261)] })] }, /patterns entries must be at most 260/],
    [{ customLists: [list({ allowList: many(101) })] }, /allow list has 101 entries; Discord allows 100/],
    [{ preset: { ...textSettings().preset, allowList: many(1001) } }, /Preset filter allow list has 1001 entries; Discord allows 1000/],
    [{ customLists: Array.from({ length: 7 }, (_, index) => list({ id: `l${index}` })) }, /At most 6 custom word lists/],
    [{ exemptChannelIds: many(51, 18) }, /At most 50 exempt channels/],
    [{ exemptRoleIds: many(21, 18) }, /At most 20 exempt roles/],
    [{ blockMessage: 'x'.repeat(151) }, /Block message must be at most 150/]
  ];
  for (const [overrides, pattern] of cases) assert.match(errorsOf(overrides).join(' '), pattern);
  assert.deepEqual(errorsOf({ customLists: [list({ words: many(1000), regexPatterns: many(10), allowList: many(100) })] }), []);
});

function harness() {
  const manager = new FakeRuleManager();
  const ids = new MemoryModerationSettingsStore(new MemoryOpsAuditStore());
  let ready = true;
  const deps: AutoModSyncDeps = { rules: async () => ready ? manager : null, botUserId: () => BOT, ids };
  return { manager, ids, deps, setReady: (value: boolean) => { ready = value; } };
}

test('sync creates owned rules, is idempotent, updates in place, disables (not deletes) and deletes removed lists', async () => {
  const { manager, ids, deps } = harness();
  const text = textSettings({ alertChannelId: ALERT, customLists: [list(), list({ id: 'second', name: 'Second' })] });
  const first = await syncAutoMod(deps, GUILD, settingsWith(text));
  assert.equal(first.status, 'synced');
  assert.equal(first.presetManagedElsewhere, false);
  assert.equal(first.ruleIds.length, 3);
  const stored = await ids.getAutoModRuleIds(GUILD);
  assert.deepEqual(Object.keys(stored).sort(), ['custom:second', 'custom:trash', 'preset']);
  assert.deepEqual(manager.calls.map(call => call.op), ['create', 'create', 'create']);

  manager.calls.length = 0;
  assert.deepEqual((await syncAutoMod(deps, GUILD, settingsWith(text))).ruleIds.sort(), first.ruleIds.sort());
  assert.equal(manager.calls.length, 0, 'a repeat sync makes no Discord changes');

  const edited = { ...text, customLists: [list({ words: ['noob', 'scrub'] })] };
  await syncAutoMod(deps, GUILD, settingsWith(edited));
  assert.deepEqual(manager.calls.map(call => [call.op, call.id]), [['delete', stored['custom:second']], ['edit', stored['custom:trash']]]);
  assert.deepEqual(manager.rules.get(stored['custom:trash']!)!.triggerMetadata.keywordFilter, ['noob', 'scrub']);
  assert.equal((await ids.getAutoModRuleIds(GUILD))['custom:second'], undefined);

  manager.calls.length = 0;
  const off = await syncAutoMod(deps, GUILD, settingsWith({ ...edited, enabled: false }));
  assert.equal(off.status, 'disabled');
  assert.deepEqual(manager.calls.map(call => [call.op, call.options]), [['edit', { enabled: false, reason: 'TCG Live moderation settings' }],
    ['edit', { enabled: false, reason: 'TCG Live moderation settings' }]]);
  assert.equal(manager.rules.size, 2, 'disabled rules are kept');
  assert.ok([...manager.rules.values()].every(rule => !rule.enabled));
  manager.calls.length = 0;
  await syncAutoMod(deps, GUILD, settingsWith({ ...edited, enabled: false }));
  assert.equal(manager.calls.length, 0);
  await syncAutoMod(deps, GUILD, settingsWith(edited));
  assert.ok([...manager.rules.values()].every(rule => rule.enabled), 're-enabling edits the same rules');
  assert.equal(manager.rules.size, 2);
});

test('a preset rule owned elsewhere is never touched; foreign keyword rules count toward the cap', async () => {
  const { manager, deps } = harness();
  const foreign = manager.add({ triggerType: AutoModerationRuleTriggerType.KeywordPreset, name: 'Server preset' });
  const before = structuredClone({ ...foreign, exemptRoles: [], exemptChannels: [] });
  const result = await syncAutoMod(deps, GUILD, settingsWith(textSettings({ customLists: [list()] })));
  assert.equal(result.status, 'synced');
  assert.equal(result.presetManagedElsewhere, true);
  assert.match(result.message ?? '', /managed elsewhere/);
  assert.equal(result.ruleIds.length, 1);
  assert.ok(manager.calls.every(call => call.id !== foreign.id));
  assert.deepEqual({ ...manager.rules.get(foreign.id)!, exemptRoles: [], exemptChannels: [] }, before);

  for (let index = 0; index < 5; index += 1) manager.add({ triggerType: AutoModerationRuleTriggerType.Keyword });
  // 5 foreign + 1 owned = 6: one more list cannot fit.
  await assert.rejects(syncAutoMod(deps, GUILD, settingsWith(textSettings({ customLists: [list(), list({ id: 'two', name: 'Two' })] }))),
    (error: unknown) => error instanceof AutoModValidationError && /6 keyword rules per server and 5 already/.test(error.message));
});

test('adopts a bot-created rule whose ID was never stored instead of creating a duplicate', async () => {
  const { manager, ids, deps } = harness();
  const orphan = manager.add({ triggerType: AutoModerationRuleTriggerType.Keyword, creatorId: BOT, name: 'TCG Live – Trash talk' });
  await syncAutoMod(deps, GUILD, settingsWith(textSettings({ preset: { ...textSettings().preset, enabled: false }, customLists: [list()] })));
  assert.equal((await ids.getAutoModRuleIds(GUILD))['custom:trash'], orphan.id);
  assert.deepEqual(manager.calls.map(call => call.op), ['edit']);
  assert.equal(manager.rules.size, 1);
});

test('missing permissions and an offline bot answer pending with a repair hint; validation errors throw', async () => {
  const { manager, deps, setReady } = harness();
  manager.failWith = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  const denied = await syncAutoMod(deps, GUILD, settingsWith(textSettings()));
  assert.equal(denied.status, 'pending');
  assert.equal(denied.message, AUTOMOD_PERMISSION_HINT);
  manager.failWith = null;
  setReady(false);
  assert.match((await syncAutoMod(deps, GUILD, settingsWith(textSettings()))).message ?? '', /not connected/);
  setReady(true);
  await assert.rejects(syncAutoMod(deps, GUILD, settingsWith(textSettings({ customLists: [list({ action: 'flag' })] }))), AutoModValidationError);
  assert.equal(manager.calls.length, 0);
  manager.failWith = Object.assign(new Error('Invalid Form Body'), { code: 50035 });
  // fetch fails first with a non-permission code: pending, not a crash.
  assert.equal((await syncAutoMod(deps, GUILD, settingsWith(textSettings()))).status, 'pending');
});

test('concurrent syncs for one guild are serialized and create each rule once', async () => {
  const { manager, deps } = harness();
  const settings = settingsWith(textSettings({ customLists: [list()] }));
  await Promise.all([syncAutoMod(deps, GUILD, settings), syncAutoMod(deps, GUILD, settings)]);
  assert.equal(manager.calls.filter(call => call.op === 'create').length, 2);
  assert.equal(manager.rules.size, 2);
});
