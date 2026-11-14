// Discord feature for keyword flags: syncs AutoMod rules after each settings save (and once at start), and
// turns AutoMod action executions on bot-owned rules into one dashboard flag per message.
import { GatewayIntentBits, type AutoModerationActionExecution } from 'discord.js';
import type { KeywordAction, ModerationSettingsDto } from '@tcg-live/core';
import type { DiscordFeature, DiscordFeatureContext } from '../discord/features.js';
import { AUTOMOD_NAME_PREFIX, customRuleName, discordAutoModDeps, PRESET_RULE_NAME, syncAutoMod, type AutoModSyncDeps } from './automod.js';
import { pgModerationSettingsStore, type AutoModRuleIds } from './settings.js';

/** The fields of an AutoModerationActionExecution the feature reads. */
export type AutoModExecutionLike = Pick<AutoModerationActionExecution, 'ruleId' | 'userId' | 'channelId' | 'messageId' |
  'content' | 'matchedKeyword' | 'matchedContent'> & { guild: { id: string } };

export interface AutoModFeatureOptions {
  ids?: AutoModSyncDeps['ids'];
  /** Overrides the discord.js-backed sync deps (tests). */
  deps?(context: DiscordFeatureContext, ids: AutoModSyncDeps['ids']): AutoModSyncDeps;
  /** Executions of one rule on one message within this window become a single flag. */
  dedupeMs?: number;
  now?(): number;
}

const EXCERPT = 200;
const ID_REFRESH_MS = 30_000;
/** An unknown rule ID re-reads the stored IDs at most this often (foreign rules fire too). */
const ID_MISS_REFRESH_MS = 5_000;

/** Rule ID → configured rule name and action, from stored IDs and current settings. */
function describeRule(ids: AutoModRuleIds, ruleId: string, settings: ModerationSettingsDto): { name: string; action: KeywordAction } | null {
  const key = Object.entries(ids).find(([, id]) => id === ruleId)?.[0];
  if (!key) return null;
  if (key === 'preset') return { name: PRESET_RULE_NAME, action: settings.text.preset.action };
  const list = settings.text.customLists.find(item => `custom:${item.id}` === key);
  return list ? { name: customRuleName(list.name), action: list.action } : { name: `${AUTOMOD_NAME_PREFIX}removed word list`, action: 'flag' };
}

export function autoModFeature(options: AutoModFeatureOptions = {}): DiscordFeature {
  const dedupeMs = options.dedupeMs ?? 10_000;
  const now = options.now ?? Date.now;
  let context: DiscordFeatureContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let listener: ((execution: AutoModerationActionExecution) => void) | undefined;
  const seen = new Map<string, number>();
  let ids: AutoModRuleIds = {};
  let idsLoadedAt = 0;

  return {
    name: 'automod',
    // Non-privileged. Execution events arrive only when the bot has Manage Server. The feature seam has no
    // conditional intents, so this is always requested; with text moderation off no events arrive.
    intents: [GatewayIntentBits.AutoModerationExecution],
    start(ctx) {
      context = ctx;
      const store = options.ids ?? pgModerationSettingsStore();
      const deps = options.deps?.(ctx, store) ?? discordAutoModDeps(ctx.client, store);
      const loadIds = async (mode: 'cached' | 'miss' | 'fresh') => {
        const age = now() - idsLoadedAt;
        if ((mode === 'cached' && age < ID_REFRESH_MS) || (mode === 'miss' && age < ID_MISS_REFRESH_MS)) return ids;
        idsLoadedAt = now();
        ids = await store.getAutoModRuleIds(ctx.guildId);
        return ids;
      };
      const sync = async (settings: ModerationSettingsDto) => {
        if (!ctx.isActive()) return;
        try {
          const result = await syncAutoMod(deps, ctx.guildId, settings);
          await loadIds('fresh').catch(() => {});
          await ctx.appendAudit({ kind: 'automod.synced', actor: { kind: 'bot', id: 'bot' }, guildId: ctx.guildId,
            payload: { status: result.status, ruleIds: result.ruleIds, presetManagedElsewhere: result.presetManagedElsewhere, trigger: 'settings' } });
          if (result.status === 'pending' && result.message) ctx.log(`AutoMod sync pending: ${result.message}`);
        } catch (error) {
          ctx.log(`AutoMod sync failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      };
      unsubscribe = ctx.on('moderationSettingsChanged', event => { void sync(event.settings); });
      // Reconcile changes made while the bot was offline. Never-saved settings have nothing to sync.
      void ctx.moderationSettings().then(settings => settings.version > 0 ? sync(settings) : undefined).catch(() => {});

      const handle = async (execution: AutoModExecutionLike) => {
        if (!ctx.isActive() || execution.guild.id !== ctx.guildId) return;
        // Discord sends one execution per action (block, alert, timeout): keep the first of each message.
        const at = now();
        for (const [key, time] of seen) if (at - time > dedupeMs) seen.delete(key);
        const dedupeKey = [execution.ruleId, execution.userId, execution.channelId ?? '', execution.messageId ?? '',
          execution.content, execution.matchedKeyword ?? '', execution.matchedContent ?? ''].join('\u0000');
        if (seen.has(dedupeKey)) return;
        seen.set(dedupeKey, at);
        let rule = describeRule(await loadIds('cached'), execution.ruleId, await ctx.moderationSettings());
        if (!rule) rule = describeRule(await loadIds('miss'), execution.ruleId, await ctx.moderationSettings());
        if (!rule) { seen.delete(dedupeKey); return; } // Not a bot-owned rule.
        const room = execution.channelId
          ? (await ctx.activeMatchRooms().catch(() => [])).find(item => item.voiceChannelId === execution.channelId) ?? null : null;
        // content and matchedContent are empty without the privileged Message Content intent (not requested).
        const raw = execution.content || execution.matchedContent || '';
        const excerpt = raw ? [...raw].slice(0, EXCERPT).join('') : null;
        // appendFlag writes the automod.executed ops-audit row in the same transaction.
        await ctx.appendFlag({ kind: 'keyword', guildId: ctx.guildId, channelId: execution.channelId,
          eventId: room?.eventId ?? null, matchId: room?.matchId ?? null, userId: execution.userId,
          detail: { ruleId: execution.ruleId, ruleName: rule.name, action: rule.action,
            matchedKeyword: execution.matchedKeyword ? [...execution.matchedKeyword].slice(0, 60).join('') : null, matchedContent: excerpt } });
      };
      listener = execution => {
        void handle(execution).catch(error => ctx.log(`AutoMod flag not recorded: ${error instanceof Error ? error.message : 'unknown error'}`));
      };
      ctx.client.on('autoModerationActionExecution', listener);
    },
    stop() {
      unsubscribe?.();
      if (listener) context?.client.off('autoModerationActionExecution', listener);
      unsubscribe = undefined;
      listener = undefined;
      seen.clear();
    }
  };
}
