// Discord AutoMod sync for text moderation (keyword flags). planAutoMod() is a pure mapping from
// TextModerationSettingsDto to bot-owned rule payloads; syncAutoMod() diffs that plan against the guild's
// rules and only ever creates, edits, disables or deletes rules the bot owns (IDs in automod_rule_ids).
//
// Discord limits enforced here (https://discord.com/developers/docs/resources/auto-moderation):
// - per server: 6 Keyword rules, 1 KeywordPreset rule (all owners combined, disabled rules count too);
// - Keyword rule: 1000 keywords of <= 60 chars, 10 regex of <= 260 chars, 100 allow-list entries;
// - KeywordPreset rule: 1000 allow-list entries;
// - 50 exempt channels and 20 exempt roles per rule; block message <= 150 chars;
// - Timeout (duration <= 2419200 s) is "Only available if using AutoModerationRuleTriggerType.Keyword"
//   (discord-api-types APIAutoModerationActionMetadata.duration_seconds), so the preset rule never gets one;
// - every rule needs at least one action, so 'flag' (alert only) needs an alert channel.
import { AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType, type Client } from 'discord.js';
import { MODERATION_LIMITS as L, type AutoModSyncResultDto, type KeywordAction, type KeywordPreset,
  type ModerationSettingsDto, type TextModerationSettingsDto } from '@tcg-live/core';
import { OpsInputError } from '../ops/errors.js';
import type { AutoModRuleIds, ModerationSettingsStore } from './settings.js';

export const AUTOMOD_NAME_PREFIX = 'TCG Live – ';
export const PRESET_RULE_NAME = `${AUTOMOD_NAME_PREFIX}preset filter`;
export const DISCORD_KEYWORD_RULE_LIMIT = 6;
export const customRuleName = (listName: string) => `${AUTOMOD_NAME_PREFIX}${listName}`;

const PRESET_TYPES: Record<KeywordPreset, AutoModerationRuleKeywordPresetType> = {
  profanity: AutoModerationRuleKeywordPresetType.Profanity,
  sexual: AutoModerationRuleKeywordPresetType.SexualContent,
  slurs: AutoModerationRuleKeywordPresetType.Slurs
};

/** Structurally an AutoModerationRuleCreateOptions; channel and role IDs are plain snowflakes. */
export interface AutoModRulePayload {
  name: string;
  eventType: AutoModerationRuleEventType.MessageSend;
  triggerType: AutoModerationRuleTriggerType.Keyword | AutoModerationRuleTriggerType.KeywordPreset;
  triggerMetadata: { keywordFilter?: string[]; regexPatterns?: string[]; presets?: AutoModerationRuleKeywordPresetType[]; allowList: string[] };
  actions: Array<{ type: AutoModerationActionType; metadata?: { channel?: string; durationSeconds?: number; customMessage?: string } }>;
  enabled: true;
  exemptRoles: string[];
  exemptChannels: string[];
}

export type AutoModRuleKey = 'preset' | `custom:${string}`;
export interface DesiredAutoModRule {
  key: AutoModRuleKey;
  name: string;
  action: KeywordAction;
  /** null: the rule should exist only as disabled (an owned rule is disabled, nothing is created). */
  payload: AutoModRulePayload | null;
}
export interface AutoModPlan { rules: DesiredAutoModRule[]; errors: string[] }

/** Invalid settings for Discord AutoMod; the message is safe to show (answers 400). */
export class AutoModValidationError extends OpsInputError {
  constructor(readonly problems: string[]) { super(problems.join(' ')); }
}

function actionsFor(action: KeywordAction, timeoutSeconds: number, text: TextModerationSettingsDto,
  label: string, preset: boolean, errors: string[]): AutoModRulePayload['actions'] {
  const alert = text.alertChannelId
    ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: text.alertChannelId } }] : [];
  const block = { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: text.blockMessage } };
  if (action === 'flag') {
    if (!alert.length) errors.push(`${label} uses "Flag only", which needs an alert channel: choose one, or switch the action to Block.`);
    return alert;
  }
  if (action === 'block') return [block, ...alert];
  if (preset) {
    errors.push(`${label}: Discord does not allow a timeout on the preset filter; choose Flag or Block.`);
    return [block, ...alert];
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < L.timeoutSecondsMin || timeoutSeconds > L.timeoutSecondsMax)
    errors.push(`${label} timeout must be ${L.timeoutSecondsMin}-${L.timeoutSecondsMax} seconds.`);
  return [block, { type: AutoModerationActionType.Timeout, metadata: { durationSeconds: timeoutSeconds } }, ...alert];
}

function checkEntries(entries: readonly string[], max: number, maxLength: number, label: string, errors: string[]): void {
  if (entries.length > max) errors.push(`${label} has ${entries.length} entries; Discord allows ${max}.`);
  const long = entries.find(entry => [...entry].length > maxLength);
  if (long !== undefined) errors.push(`${label} entries must be at most ${maxLength} characters ("${[...long].slice(0, 20).join('')}…" is longer).`);
}

/** Pure mapping. Rules that should not be active get payload null; errors cover active rules only. */
export function planAutoMod(text: TextModerationSettingsDto): AutoModPlan {
  const errors: string[] = [];
  const rules: DesiredAutoModRule[] = [];
  if (text.exemptChannelIds.length > L.exemptChannels) errors.push(`At most ${L.exemptChannels} exempt channels are allowed.`);
  if (text.exemptRoleIds.length > L.exemptRoles) errors.push(`At most ${L.exemptRoles} exempt roles are allowed.`);
  if ([...text.blockMessage].length > L.blockMessageLength) errors.push(`Block message must be at most ${L.blockMessageLength} characters.`);
  if (text.customLists.length > L.customLists) errors.push(`At most ${L.customLists} custom word lists are allowed.`);
  const exempt = { exemptRoles: [...text.exemptRoleIds], exemptChannels: [...text.exemptChannelIds] };

  const preset = text.preset;
  const presets = (Object.keys(PRESET_TYPES) as KeywordPreset[]).filter(key => preset.presets[key]).map(key => PRESET_TYPES[key]);
  const presetActive = text.enabled && preset.enabled;
  let presetPayload: AutoModRulePayload | null = null;
  if (presetActive) {
    const label = 'Preset filter';
    if (!presets.length) errors.push('Preset filter is on but no list is selected: select at least one, or turn the preset filter off.');
    checkEntries(preset.allowList, L.allowListPreset, L.wordLength, `${label} allow list`, errors);
    presetPayload = { name: PRESET_RULE_NAME, eventType: AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.KeywordPreset, triggerMetadata: { presets, allowList: [...preset.allowList] },
      actions: actionsFor(preset.action, 0, text, label, true, errors), enabled: true, ...exempt };
  }
  rules.push({ key: 'preset', name: PRESET_RULE_NAME, action: preset.action, payload: presetPayload });

  for (const list of text.customLists) {
    const name = customRuleName(list.name);
    const label = `Word list "${list.name}"`;
    let payload: AutoModRulePayload | null = null;
    if (text.enabled && list.enabled) {
      if (!list.words.length && !list.regexPatterns.length) errors.push(`${label} is on but has no words or patterns.`);
      checkEntries(list.words, L.wordsPerList, L.wordLength, `${label} words`, errors);
      checkEntries(list.regexPatterns, L.regexPerList, L.regexLength, `${label} patterns`, errors);
      checkEntries(list.allowList, L.allowListPerCustomList, L.wordLength, `${label} allow list`, errors);
      payload = { name, eventType: AutoModerationRuleEventType.MessageSend, triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: { keywordFilter: [...list.words], regexPatterns: [...list.regexPatterns], allowList: [...list.allowList] },
        actions: actionsFor(list.action, list.timeoutSeconds, text, label, false, errors), enabled: true, ...exempt };
    }
    rules.push({ key: `custom:${list.id}`, name, action: list.action, payload });
  }
  return { rules, errors };
}

/** Throws AutoModValidationError when the active rules cannot be expressed in Discord AutoMod. */
export function validateAutoModText(text: TextModerationSettingsDto): void {
  const { errors } = planAutoMod(text);
  if (errors.length) throw new AutoModValidationError(errors);
}

// ---- Sync ----

/** The subset of discord.js AutoModerationRule that sync reads. */
export interface AutoModRuleLike {
  id: string;
  name: string;
  creatorId: string;
  triggerType: AutoModerationRuleTriggerType;
  enabled: boolean;
  triggerMetadata: { keywordFilter: readonly string[]; regexPatterns: readonly string[];
    presets: readonly AutoModerationRuleKeywordPresetType[]; allowList: readonly string[] };
  actions: ReadonlyArray<{ type: AutoModerationActionType;
    metadata: { channelId: string | null; durationSeconds: number | null; customMessage: string | null } }>;
  exemptRoles: { keys(): Iterable<string> };
  exemptChannels: { keys(): Iterable<string> };
}
/** The subset of discord.js GuildAutoModerationRuleManager that sync calls. */
export interface AutoModRuleManagerLike {
  fetch(): Promise<{ values(): Iterable<AutoModRuleLike> }>;
  create(options: AutoModRulePayload & { reason?: string }): Promise<{ id: string }>;
  edit(id: string, options: Partial<Omit<AutoModRulePayload, 'triggerType' | 'enabled'>> & { enabled?: boolean; reason?: string }): Promise<{ id: string }>;
  delete(id: string, reason?: string): Promise<void>;
}
export interface AutoModSyncDeps {
  /** Resolves the guild's rule manager; rejects or returns null when Discord is not ready. */
  rules(guildId: string): Promise<AutoModRuleManagerLike | null>;
  /** The bot's user ID, used to adopt bot-created rules whose ID was never stored. */
  botUserId(): string | null;
  ids: Pick<ModerationSettingsStore, 'getAutoModRuleIds' | 'setAutoModRuleIds'>;
}

export const AUTOMOD_PERMISSION_HINT = 'The bot needs the Manage Server permission to manage AutoMod rules (and Moderate Members for ' +
  'timeout rules). Grant it in Server Settings > Roles, then press Sync again.';
const REASON = 'TCG Live moderation settings';

const sorted = (values: Iterable<string | number | null | undefined>) =>
  JSON.stringify([...values].filter(value => value !== null && value !== undefined).map(String).sort());
const actionKey = (actions: ReadonlyArray<{ type: number; channel: string | null; duration: number | null; message: string | null }>) =>
  JSON.stringify(actions.map(a => [a.type, a.channel, a.duration, a.message]).sort());

/** True when the existing rule already matches the payload (no edit needed). */
export function ruleMatches(rule: AutoModRuleLike, payload: AutoModRulePayload): boolean {
  const meta = payload.triggerMetadata;
  return rule.enabled && rule.name === payload.name &&
    sorted(rule.triggerMetadata.keywordFilter) === sorted(meta.keywordFilter ?? []) &&
    sorted(rule.triggerMetadata.regexPatterns) === sorted(meta.regexPatterns ?? []) &&
    sorted(rule.triggerMetadata.presets) === sorted(meta.presets ?? []) &&
    sorted(rule.triggerMetadata.allowList) === sorted(meta.allowList) &&
    sorted(rule.exemptRoles.keys()) === sorted(payload.exemptRoles) &&
    sorted(rule.exemptChannels.keys()) === sorted(payload.exemptChannels) &&
    actionKey(rule.actions.map(a => ({ type: a.type, channel: a.metadata.channelId ?? null, duration: a.metadata.durationSeconds ?? null,
      message: a.type === AutoModerationActionType.BlockMessage ? a.metadata.customMessage ?? null : null }))) ===
    actionKey(payload.actions.map(a => ({ type: a.type, channel: a.metadata?.channel ?? null, duration: a.metadata?.durationSeconds ?? null,
      message: a.type === AutoModerationActionType.BlockMessage ? a.metadata?.customMessage ?? null : null })));
}

function discordCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}
/** Missing Permissions (50013) or Missing Access (50001). */
export const isDiscordPermissionError = (error: unknown) => [50013, 50001].includes(discordCode(error) ?? 0);

// One sync per guild at a time (the route and the settings listener can race).
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(guildId: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(guildId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  const tail = next.catch(() => {});
  queues.set(guildId, tail);
  void tail.then(() => { if (queues.get(guildId) === tail) queues.delete(guildId); });
  return next;
}

/**
 * Brings the guild's bot-owned AutoMod rules in line with the settings. Idempotent: a second run with the
 * same settings makes no Discord calls besides the fetch. Validation problems throw AutoModValidationError;
 * Discord being unavailable or a missing permission answers status 'pending' with a repair message.
 */
export function syncAutoMod(deps: AutoModSyncDeps, guildId: string, settings: ModerationSettingsDto): Promise<AutoModSyncResultDto> {
  return serialized(guildId, () => runSync(deps, guildId, settings));
}

async function runSync(deps: AutoModSyncDeps, guildId: string, settings: ModerationSettingsDto): Promise<AutoModSyncResultDto> {
  const plan = planAutoMod(settings.text);
  if (plan.errors.length) throw new AutoModValidationError(plan.errors);
  const stored = await deps.ids.getAutoModRuleIds(guildId);
  const pending = (message: string): AutoModSyncResultDto =>
    ({ status: 'pending', presetManagedElsewhere: false, ruleIds: Object.values(stored), message });

  let manager: AutoModRuleManagerLike | null;
  let existing: AutoModRuleLike[];
  try {
    manager = await deps.rules(guildId);
    if (!manager) return pending('Discord is not connected yet; AutoMod rules sync when the bot is online.');
    existing = [...(await manager.fetch()).values()];
  } catch (error) {
    if (isDiscordPermissionError(error)) return pending(AUTOMOD_PERMISSION_HINT);
    return pending('Discord AutoMod rules could not be read; try Sync again.');
  }

  const byId = new Map(existing.map(rule => [rule.id, rule]));
  const botId = deps.botUserId();
  const owned = new Map<string, AutoModRuleLike>();
  for (const [key, id] of Object.entries(stored)) { const rule = byId.get(id); if (rule) owned.set(key, rule); }
  // Adopt a bot-created rule whose ID was never stored (for example after an ambiguous create).
  const ownedIds = () => new Set([...owned.values()].map(rule => rule.id));
  for (const desired of plan.rules) {
    if (owned.has(desired.key) || !botId) continue;
    const taken = ownedIds();
    const orphan = existing.find(rule => !taken.has(rule.id) && rule.creatorId === botId && rule.name === desired.name &&
      rule.triggerType === (desired.key === 'preset' ? AutoModerationRuleTriggerType.KeywordPreset : AutoModerationRuleTriggerType.Keyword));
    if (orphan) owned.set(desired.key, orphan);
  }
  const mine = ownedIds();
  const foreignPreset = existing.some(rule => rule.triggerType === AutoModerationRuleTriggerType.KeywordPreset && !mine.has(rule.id));
  const desiredKeys = new Set(plan.rules.map(rule => rule.key));
  const removed = [...owned.keys()].filter(key => !desiredKeys.has(key as AutoModRuleKey));
  const creates = plan.rules.filter(rule => rule.payload && !owned.has(rule.key) && !(rule.key === 'preset' && foreignPreset));

  // Discord's per-server keyword rule cap counts every owner and disabled rules too.
  const keywordAfter = existing.filter(rule => rule.triggerType === AutoModerationRuleTriggerType.Keyword).length -
    removed.filter(key => owned.get(key)!.triggerType === AutoModerationRuleTriggerType.Keyword).length +
    creates.filter(rule => rule.key !== 'preset').length;
  if (keywordAfter > DISCORD_KEYWORD_RULE_LIMIT) {
    const foreign = existing.filter(rule => rule.triggerType === AutoModerationRuleTriggerType.Keyword && !mine.has(rule.id)).length;
    throw new AutoModValidationError([`Discord allows ${DISCORD_KEYWORD_RULE_LIMIT} keyword rules per server and ${foreign} ` +
      `already belong to other rules or bots; turn off or remove ${keywordAfter - DISCORD_KEYWORD_RULE_LIMIT} word list(s).`]);
  }

  const next: AutoModRuleIds = {};
  for (const [key, rule] of owned) next[key] = rule.id;
  const save = async () => {
    if (JSON.stringify(Object.entries(next).sort()) !== JSON.stringify(Object.entries(stored).sort()))
      await deps.ids.setAutoModRuleIds(guildId, next);
  };
  try {
    for (const key of removed) {
      await manager.delete(owned.get(key)!.id, REASON);
      delete next[key];
    }
    for (const desired of plan.rules) {
      const rule = owned.get(desired.key);
      if (desired.key === 'preset' && foreignPreset && !rule) continue;
      if (rule) {
        if (desired.payload) {
          if (!ruleMatches(rule, desired.payload)) {
            const { triggerType: _type, ...edit } = desired.payload;
            await manager.edit(rule.id, { ...edit, reason: REASON });
          }
        } else if (rule.enabled) await manager.edit(rule.id, { enabled: false, reason: REASON });
      } else if (desired.payload) {
        const created = await manager.create({ ...desired.payload, reason: REASON });
        next[desired.key] = created.id;
      }
    }
  } catch (error) {
    await save().catch(() => {});
    if (error instanceof AutoModValidationError) throw error;
    if (isDiscordPermissionError(error)) return { ...pending(AUTOMOD_PERMISSION_HINT), ruleIds: Object.values(next), presetManagedElsewhere: foreignPreset };
    if (discordCode(error) === 50035) {
      const detail = error instanceof Error ? error.message.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) : '';
      throw new AutoModValidationError([`Discord rejected an AutoMod rule${detail ? `: ${detail}` : '.'}`]);
    }
    return { ...pending('Discord AutoMod sync did not finish; try Sync again.'), ruleIds: Object.values(next), presetManagedElsewhere: foreignPreset };
  }
  await save();
  return {
    status: settings.text.enabled ? 'synced' : 'disabled', presetManagedElsewhere: foreignPreset, ruleIds: Object.values(next),
    ...(foreignPreset ? { message: 'This server already has a preset filter rule managed elsewhere; only custom word lists are synced.' } : {})
  };
}

/** Production deps: the guild's rule manager from a logged-in discord.js client. */
export function discordAutoModDeps(client: Client, ids: AutoModSyncDeps['ids']): AutoModSyncDeps {
  return {
    async rules(guildId) {
      if (!client.isReady()) return null;
      const guild = await client.guilds.fetch(guildId);
      return guild.autoModerationRules as unknown as AutoModRuleManagerLike;
    },
    botUserId: () => client.user?.id ?? null,
    ids
  };
}

/** The ModerationRouteOptions.automodSync seam for the private Discord runtime. */
export function discordAutoModSync(client: Client, ids: AutoModSyncDeps['ids']) {
  const deps = discordAutoModDeps(client, ids);
  return (guildId: string, settings: ModerationSettingsDto) => syncAutoMod(deps, guildId, settings);
}
