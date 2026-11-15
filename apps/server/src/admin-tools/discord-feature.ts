// The admin-tools foundation feature: requests the opt-in privileged intents the saved settings need,
// reports a refused intent once (log + audit), notices settings that need a restart, and answers
// `/tcg-admin status`. Feature agents add their own features next to this one in feature-registry.ts.
import { GatewayIntentBits, MessageFlags } from 'discord.js';
import { PRIVILEGED_INTENT_NAMES, PRIVILEGED_INTENT_PORTAL_LABELS, privilegedIntentsForSettings, type AdminToolsSettingsBodyDto,
  type AdminToolsStatusDto } from '@tcg-live/core';
import type { DiscordFeature } from '../discord/features.js';

/** GuildMembers / MessageContent exactly as the Decisions say (opt-in per feature). */
export function adminToolsPrivilegedIntents(settings: AdminToolsSettingsBodyDto): GatewayIntentBits[] {
  const wanted = privilegedIntentsForSettings(settings);
  return [...(wanted.guildMembers ? [GatewayIntentBits.GuildMembers] : []), ...(wanted.messageContent ? [GatewayIntentBits.MessageContent] : [])];
}

export function formatAdminToolsStatus(status: AdminToolsStatusDto): string {
  const lines = PRIVILEGED_INTENT_NAMES.map(name => `${PRIVILEGED_INTENT_PORTAL_LABELS[name]}: ${status.privilegedIntents[name]}` +
    (status.wantedIntents[name] ? ' (needed by your settings)' : ''));
  if (status.restartReason) lines.push(`Restart required: ${status.restartReason}`);
  const degraded = status.features.filter(feature => feature.state !== 'running');
  if (degraded.length) lines.push(`Features: ${degraded.map(feature => `${feature.name} ${feature.state}`).join(', ')}`);
  return lines.join('\n').slice(0, 1900);
}

export function adminToolsCoreFeature(): DiscordFeature {
  const stops: Array<() => void> = [];
  return {
    name: 'admin-tools',
    intentsFor: adminToolsPrivilegedIntents,
    async start(ctx) {
      const missing = PRIVILEGED_INTENT_NAMES.filter(name => ctx.privilegedIntents()[name] === 'missing');
      if (missing.length) {
        ctx.log(`Admin tools: Discord refused ${missing.map(name => PRIVILEGED_INTENT_PORTAL_LABELS[name]).join(' and ')}; ` +
          'the features that need it stay idle. Turn it on in the Developer Portal and restart.');
        await ctx.audit('admin_tools.intents_missing', { intents: missing }).catch(() => {});
      }
      let reported: string | null = null;
      stops.push(ctx.on('adminToolsSettingsChanged', () => {
        void ctx.adminToolsStatus().then(status => {
          if (!status.restartRequired || status.restartReason === reported) return;
          reported = status.restartReason;
          ctx.log(`Admin tools: restart required. ${status.restartReason ?? ''}`);
        }).catch(() => {});
      }));
      stops.push(ctx.interactions.onSubcommand('status', async interaction => {
        const status = await ctx.adminToolsStatus();
        await interaction.reply({ content: formatAdminToolsStatus(status), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }));
    },
    stop() { for (const stop of stops.splice(0)) stop(); }
  };
}
