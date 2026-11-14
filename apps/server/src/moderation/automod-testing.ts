// Test fakes for AutoMod sync: an in-memory guild rule manager with discord.js-shaped rules.
import { AutoModerationRuleTriggerType, type AutoModerationActionType } from 'discord.js';
import { DEFAULT_MODERATION_SETTINGS, type ModerationSettingsDto, type TextModerationSettingsDto } from '@tcg-live/core';
import type { AutoModRuleLike, AutoModRuleManagerLike, AutoModRulePayload } from './automod.js';

export const GUILD = '123456789012345678';
export const BOT = '223456789012345678';
export const OTHER = '323456789012345678';
export const ALERT = '423456789012345678';

export function textSettings(overrides: Partial<TextModerationSettingsDto> = {}): TextModerationSettingsDto {
  return { ...structuredClone(DEFAULT_MODERATION_SETTINGS.text), enabled: true, ...overrides };
}
export function settingsWith(text: TextModerationSettingsDto, version = 1): ModerationSettingsDto {
  return { guildId: GUILD, version, updatedAtMs: 1, ...structuredClone(DEFAULT_MODERATION_SETTINGS), text };
}

type Call = { op: 'create' | 'edit' | 'delete'; id: string; options?: unknown };

export class FakeRuleManager implements AutoModRuleManagerLike {
  readonly rules = new Map<string, AutoModRuleLike>();
  readonly calls: Call[] = [];
  failWith: unknown = null;
  private next = 900000000000000000n;

  add(rule: Partial<AutoModRuleLike> & { triggerType: AutoModerationRuleTriggerType }): AutoModRuleLike {
    const id = String(this.next++);
    const full: AutoModRuleLike = { id, name: 'Other rule', creatorId: OTHER, enabled: true,
      triggerMetadata: { keywordFilter: [], regexPatterns: [], presets: [], allowList: [] }, actions: [],
      exemptRoles: new Map(), exemptChannels: new Map(), ...rule };
    this.rules.set(id, full);
    return full;
  }
  private apply(rule: AutoModRuleLike, options: Partial<AutoModRulePayload> & { enabled?: boolean }): AutoModRuleLike {
    const meta = options.triggerMetadata;
    return { ...rule,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(meta ? { triggerMetadata: { keywordFilter: meta.keywordFilter ?? [], regexPatterns: meta.regexPatterns ?? [],
        presets: meta.presets ?? [], allowList: meta.allowList } } : {}),
      ...(options.actions ? { actions: options.actions.map(action => ({ type: action.type as AutoModerationActionType, metadata: {
        channelId: action.metadata?.channel ?? null, durationSeconds: action.metadata?.durationSeconds ?? null,
        customMessage: action.metadata?.customMessage ?? null } })) } : {}),
      ...(options.exemptRoles ? { exemptRoles: new Map(options.exemptRoles.map(id => [id, null])) } : {}),
      ...(options.exemptChannels ? { exemptChannels: new Map(options.exemptChannels.map(id => [id, null])) } : {}) };
  }
  async fetch() { if (this.failWith) throw this.failWith; return new Map(this.rules); }
  async create(options: AutoModRulePayload) {
    if (this.failWith) throw this.failWith;
    const rule = this.apply(this.add({ triggerType: options.triggerType, creatorId: BOT }), options);
    this.rules.set(rule.id, rule);
    this.calls.push({ op: 'create', id: rule.id, options });
    return { id: rule.id };
  }
  async edit(id: string, options: Partial<AutoModRulePayload> & { enabled?: boolean }) {
    if (this.failWith) throw this.failWith;
    const rule = this.rules.get(id);
    if (!rule) throw Object.assign(new Error('Unknown rule'), { code: 10066 });
    this.rules.set(id, this.apply(rule, options));
    this.calls.push({ op: 'edit', id, options });
    return { id };
  }
  async delete(id: string) {
    if (this.failWith) throw this.failWith;
    this.rules.delete(id);
    this.calls.push({ op: 'delete', id });
  }
  ownedByBot() { return [...this.rules.values()].filter(rule => rule.creatorId === BOT); }
}

export { AutoModerationRuleTriggerType };
