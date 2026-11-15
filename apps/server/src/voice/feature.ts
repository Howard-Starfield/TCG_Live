// Discord feature wiring for the voice pool (Phase 3). Off unless TCG_DISCORD_VOICE=1 (strict 0/1).
import { GatewayIntentBits } from 'discord.js';
import type { DiscordFeature, DiscordFeatureContext } from '../discord/features.js';
import { sharedEvidenceFiles } from '../evidence/files.js';
import { HelperBotTransport, MainBotTransport, opusscriptDecoderFactory } from './connection.js';
import { voicePoolIdentities } from './identities.js';
import { SHUTDOWN_RECORDING_BUDGET_MS, VoiceMonitor, type VoiceRoomInfo } from './monitor.js';
import { MAIN_VOICE_BOT_ID } from './pool.js';
import { pgPendingVoiceRows } from './pending.js';
import { VoiceRecorder } from './recorder.js';
import { voiceRuntimeControl } from './control.js';

/** TCG_DISCORD_VOICE: unset or '0' is off, '1' is on; anything else is refused. */
export function voiceRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TCG_DISCORD_VOICE;
  if (raw === undefined || raw.trim() === '' || raw.trim() === '0') return false;
  if (raw.trim() === '1') return true;
  throw new Error('TCG_DISCORD_VOICE must be 0 or 1.');
}

async function send(context: DiscordFeatureContext, channelId: string, content: string): Promise<void> {
  const channel = await context.client.channels.fetch(channelId);
  if (!channel || !channel.isSendable()) throw new Error('not sendable');
  await channel.send({ content, allowedMentions: { parse: [] } });
}

export function voiceFeature(env: NodeJS.ProcessEnv = process.env): DiscordFeature {
  let monitor: VoiceMonitor | null = null;
  const unsubscribe: Array<() => void> = [];
  return {
    name: 'voice',
    // Recordings get SHUTDOWN_RECORDING_BUDGET_MS, then the bots leave; still inside the runtime's 5 s watchdog.
    stopBudgetMs: SHUTDOWN_RECORDING_BUDGET_MS + 700,
    // Only an enabled runtime asks Discord for voice states.
    intents: (() => { try { return voiceRuntimeEnabled(env) ? [GatewayIntentBits.GuildVoiceStates] : []; } catch { return []; } })(),
    async start(context) {
      let enabled: boolean;
      try { enabled = voiceRuntimeEnabled(env); }
      catch { context.log('TCG_DISCORD_VOICE must be 0 or 1; voice monitoring stays off.'); enabled = false; }
      if (!enabled) { context.publishVoicePool(null); return; }
      const organizer = async (channelId: string | null, text: string) => {
        if (channelId) return send(context, channelId, text);
        const admin = await context.client.users.fetch(context.adminId);
        await admin.send({ content: text, allowedMentions: { parse: [] } });
      };
      const recorder = new VoiceRecorder({ evidence: context.evidence, audit: input => context.appendAudit(input),
        guildId: context.guildId, log: message => context.log(message), storage: sharedEvidenceFiles(), pendingVoiceRows: pgPendingVoiceRows(),
        notify: async text => organizer((await context.moderationSettings().catch(() => null))?.voice.notifyChannelId ?? null, `⚠️ ${text}`) });
      monitor = new VoiceMonitor({
        guildId: context.guildId,
        isActive: () => context.isActive(),
        settings: () => context.moderationSettings(),
        rooms: () => context.activeMatchRooms() as Promise<VoiceRoomInfo[]>,
        helpers: () => context.voiceBots.getTokens(),
        main: new MainBotTransport(MAIN_VOICE_BOT_ID, context.client, context.guildId),
        createHelper: credential => new HelperBotTransport(credential.id, credential.token, context.guildId, credential.userId, credential.nickname),
        decoder: opusscriptDecoderFactory(),
        recorder,
        appendFlag: input => context.appendFlag(input),
        publish: state => context.publishVoicePool(state),
        postNotice: (channelId, text) => send(context, channelId, text),
        audit: input => context.appendAudit(input),
        notifyOrganizer: organizer,
        identities: voicePoolIdentities,
        log: message => context.log(message)
      });
      const active = monitor;
      unsubscribe.push(
        context.on('judgeCalled', event => { void active.judgeCalled(event.eventId, event.matchId); }),
        context.on('disputeOpened', event => { void active.judgeCalled(event.eventId, event.matchId); }),
        context.on('judgeResumed', () => { void active.schedule(); }),
        context.on('matchResolved', event => { void active.matchResolved(event.eventId, event.matchId); }),
        context.on('matchRoomAssigned', event => { void active.roomAssigned(event.eventId, event.matchId); }),
        context.on('moderationSettingsChanged', event => { void active.settingsChanged(event.settings); }),
        context.on('voiceBotsChanged', () => { void active.helpersChanged(); }));
      voiceRuntimeControl.attach(active);
      await monitor.start();
    },
    async stop() {
      for (const off of unsubscribe.splice(0)) off();
      const active = monitor;
      monitor = null;
      if (active) voiceRuntimeControl.detach(active);
      await active?.stop();
    }
  };
}
