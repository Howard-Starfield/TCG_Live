// Discord feature "lfg": keeps the "Looking for a game" panel at the bottom of each LFG channel (the shared
// sticky engine), opens the form on 'lfg:new', posts cards from the form, answers Join / Leave / Close,
// expires cards on time (with restart catch-up) and marks cards deleted by hand. Never acts in reserved channels.
import { MessageFlags, PermissionFlagsBits, type Guild, type Message, type MessageComponentInteraction,
  type ModalSubmitInteraction } from 'discord.js';
import type { LfgPanelState, LfgPanelStatusDto, LfgSettingsBodyDto } from '@tcg-live/core';
import type { DiscordFeature, DiscordFeatureContext } from '../../discord/features.js';
import { FEATURE_INTERACTION_PREFIXES } from '../../discord/interactions.js';
import { memberRoleIds } from '../../discord/staff.js';
import { pgStickyStore, type StickyStore } from '../channels/sticky-store.js';
import { realClock, StickyEngine, stickyFailureStatus, type StickyClock, type StickyPoster } from '../channels/sticky-engine.js';
import { liveLfgGateway, liveLfgPanelPoster } from './gateway.js';
import { LFG_IDS, lfgModal, lfgPanelMessage, lfgReply, parseLfgCustomId, parseLfgForm, type LfgFormValues, type LfgMessage,
  type VoiceNames } from './messages.js';
import { lfgRuntime, type LfgRuntime } from './runtime.js';
import { createLfgPost, endLfgPost, expireDueLfgPosts, lfgCardsDeleted, lfgMemberAction, type LfgGateway,
  type LfgServiceDeps } from './service.js';
import { lfgBody, lfgChannelConfig, pgLfgSettingsStore, type LfgSettingsStore } from './settings.js';
import { pgLfgPostStore, type LfgPostStore } from './store.js';

/** The panel is re-posted at most this often. */
export const LFG_PANEL_DEBOUNCE_MS = 15_000;
export const LFG_EXPIRY_TICK_MS = 15_000;
const panelKey = (channelId: string) => `lfg-panel:${channelId}`;

export interface LfgFeatureOptions {
  settings?: LfgSettingsStore;
  posts?: LfgPostStore;
  stickies?: StickyStore;
  runtime?: LfgRuntime;
  clock?: StickyClock;
  expiryTickMs?: number;
  io?(ctx: DiscordFeatureContext): Promise<{ gateway: LfgGateway; poster: StickyPoster<LfgMessage>; scanPanels(channelId: string): Promise<string[]>;
    voiceNames(ids: readonly string[]): Promise<VoiceNames> }>;
}

/** The fields of the submitted form; a missing field reads as empty. */
export function readLfgForm(interaction: Pick<ModalSubmitInteraction, 'fields'>): LfgFormValues {
  const read = (id: string): string => {
    try {
      const field = interaction.fields.getField(id) as { value?: unknown; values?: unknown };
      if (Array.isArray(field.values)) return typeof field.values[0] === 'string' ? field.values[0] : '';
      return typeof field.value === 'string' ? field.value : '';
    } catch { return ''; }
  };
  return { game: read(LFG_IDS.field.game), format: read(LFG_IDS.field.format), note: read(LFG_IDS.field.note), voice: read(LFG_IDS.field.voice) };
}

export interface LfgInteractionEnv {
  deps: LfgServiceDeps;
  voiceNames(ids: readonly string[]): Promise<VoiceNames>;
  /** A card was posted in this channel (the panel moves below it, debounced). */
  onPosted(channelId: string, messageId: string): void;
  /** Tournament staff roles (admin-tools settings, Cases); they may close any card. */
  staffRoleIds?(): Promise<readonly string[]>;
}

type Component = Pick<MessageComponentInteraction, 'customId' | 'channelId' | 'user' | 'member' | 'memberPermissions' | 'reply' | 'deferReply' | 'editReply' | 'showModal'>;
type Modal = Pick<ModalSubmitInteraction, 'customId' | 'channelId' | 'user' | 'fields' | 'reply' | 'deferReply' | 'editReply'>;
const ephemeral = MessageFlags.Ephemeral;
const quiet = { parse: [] as never[] };

/** Buttons: the panel's "new" button, and Join / Leave / Close on a card. Exported for tests. */
export async function handleLfgComponent(interaction: Component, env: LfgInteractionEnv): Promise<void> {
  const parsed = parseLfgCustomId(interaction.customId);
  if (!parsed || parsed.action === 'form') { await interaction.reply({ content: 'This button is no longer valid.', flags: ephemeral }); return; }
  if (parsed.action === 'new') {
    const settings = await env.deps.settings();
    const config = settings.enabled && interaction.channelId ? lfgChannelConfig(settings, interaction.channelId) : null;
    if (!config) { await interaction.reply({ content: 'LFG is not available in this channel right now.', flags: ephemeral }); return; }
    // Modals cannot be deferred: build it from cached settings and channel names only.
    await interaction.showModal(lfgModal(settings, config, await env.voiceNames(config.voiceChannelIds)) as never);
    return;
  }
  await interaction.deferReply({ flags: ephemeral });
  const answer = (content: string) => interaction.editReply({ content, allowedMentions: quiet });
  if (parsed.action === 'close') {
    const post = await env.deps.store.get(env.deps.guildId, parsed.postId);
    if (!post) { await answer('This post no longer exists.'); return; }
    // The author, members with Manage Messages, or a configured tournament staff role.
    const staffRoles = new Set(await env.staffRoleIds?.().catch((): readonly string[] => []) ?? []);
    const staff = !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ||
      memberRoleIds(interaction.member).some(id => staffRoles.has(id));
    if (post.authorId !== interaction.user.id && !staff) { await answer('Only the member who posted this or the staff can close it.'); return; }
    const by = post.authorId === interaction.user.id ? 'author' : 'staff';
    const closed = await endLfgPost(env.deps, post.id, 'closed', by, { kind: by === 'author' ? 'player' : 'admin', id: interaction.user.id });
    await answer(closed ? 'The post is closed.' : 'This post is already closed.');
    return;
  }
  const outcome = await lfgMemberAction(env.deps, parsed.action, parsed.postId, interaction.user.id);
  await answer(outcome.message);
}

/** The submitted form: validate against the channel's lists, then post the card. Exported for tests. */
export async function handleLfgModal(interaction: Modal, env: LfgInteractionEnv): Promise<void> {
  if (interaction.customId !== LFG_IDS.form || !interaction.channelId) {
    await interaction.reply({ content: 'This form is no longer valid.', flags: ephemeral });
    return;
  }
  await interaction.deferReply({ flags: ephemeral });
  const answer = (content: string) => interaction.editReply({ content, allowedMentions: quiet });
  const settings = await env.deps.settings();
  const config = settings.enabled ? lfgChannelConfig(settings, interaction.channelId) : null;
  if (!config) { await answer('LFG is not available in this channel right now.'); return; }
  const form = parseLfgForm(readLfgForm(interaction), settings, config);
  if (!form.ok) { await answer(form.message); return; }
  const outcome = await createLfgPost(env.deps, { channelId: interaction.channelId, authorId: interaction.user.id, game: form.game,
    format: form.format, note: form.note, voiceChannelId: form.voiceChannelId });
  if (outcome.kind === 'refused') { await answer(outcome.message); return; }
  if (outcome.post.messageId) env.onPosted(outcome.post.channelId, outcome.post.messageId);
  await answer(lfgReply(settings.messages.postedText, outcome.post, settings));
}

interface RawPacket { t?: string; d?: { guild_id?: string; channel_id?: string; id?: string; ids?: string[] } }

export function lfgFeature(options: LfgFeatureOptions = {}): DiscordFeature {
  const stops: Array<() => void> = [];
  let engine: StickyEngine<LfgMessage> | null = null;
  const runtime = options.runtime ?? lfgRuntime;
  return {
    name: 'lfg',
    async start(ctx) {
      const clock = options.clock ?? realClock;
      const settingsStore = options.settings ?? pgLfgSettingsStore();
      const posts = options.posts ?? pgLfgPostStore();
      const stickies = options.stickies ?? pgStickyStore();
      const io = options.io ? await options.io(ctx) : await (async () => {
        const guild: Guild = await ctx.guild();
        const poster = liveLfgPanelPoster(guild);
        return { gateway: liveLfgGateway(guild), poster, scanPanels: (channelId: string) => poster.scanPanels(channelId, ctx.client.user?.id ?? null),
          voiceNames: async (ids: readonly string[]) => new Map(ids.map(id => [id, guild.channels.cache.get(id)?.name ?? id] as const)) };
      })();

      // Settings are cached so the "new" button can answer within Discord's 3 seconds.
      let cached: LfgSettingsBodyDto | null = null;
      const loadSettings = async () => {
        try { cached = lfgBody(await settingsStore.get(ctx.guildId)); } catch { ctx.log('LFG: settings storage unavailable; will retry on the next change.'); }
        return cached;
      };
      const settings = async (): Promise<LfgSettingsBodyDto> => cached ?? await loadSettings() ?? (() => { throw new Error('LFG settings unavailable'); })();
      const deps: LfgServiceDeps = { guildId: ctx.guildId, store: posts, gateway: io.gateway, settings, now: clock.now,
        audit: (kind, payload, actor) => ctx.audit(kind, payload, actor), log: message => ctx.log(message) };

      const sticky = new StickyEngine(io.poster, () => ctx.client.user?.id ?? null, clock);
      engine = sticky;
      const signatures = new Map<string, string>();
      const status = (channelId: string, state: LfgPanelState, message: string | null) =>
        runtime.setPanel({ channelId, state, message, atMs: clock.now() });

      let reloading: Promise<LfgPanelStatusDto[]> = Promise.resolve([]);
      const reloadPanels = (force = false) => (reloading = reloading.catch(() => []).then(async () => {
        if (!ctx.isActive()) return runtime.panelStatuses();
        const current = await loadSettings();
        if (!current) return runtime.panelStatuses();
        const reserved = new Set(await ctx.reservedChannelIds().catch((): string[] => []));
        const tickets = await ctx.adminToolsSettings().catch(() => null);
        const ticketChannel = tickets?.tickets.enabled ? tickets.tickets.supportChannelId : null;
        const stickyChannels = new Set((await stickies.list(ctx.guildId).catch(() => [])).filter(item => item.enabled).map(item => item.channelId));
        const wanted = new Set<string>();
        for (const channel of current.enabled ? current.channels : []) {
          const key = panelKey(channel.channelId);
          const blocked: [LfgPanelState, string] | null = reserved.has(channel.channelId)
            ? ['reserved', 'This channel belongs to the tournament; the LFG panel is paused.']
            : stickyChannels.has(channel.channelId) || channel.channelId === ticketChannel
              ? ['conflict', 'This channel already has a sticky message or the ticket panel; the LFG panel is paused.'] : null;
          if (blocked) {
            if (sticky.has(key)) await sticky.remove(key, true);
            signatures.delete(key);
            status(channel.channelId, blocked[0], blocked[1]);
            continue;
          }
          wanted.add(key);
          const config = lfgChannelConfig(current, channel.channelId)!;
          let lastMessageId = sticky.has(key) ? sticky.lastMessageId(key) : null;
          if (!sticky.has(key)) {
            // Restart: adopt the newest existing panel and delete duplicates.
            try {
              const [newest, ...older] = await io.scanPanels(channel.channelId);
              lastMessageId = newest ?? null;
              for (const id of older) await io.poster.remove(channel.channelId, id).catch(() => {});
            } catch (error) { runtime.setPanel({ channelId: channel.channelId, ...stickyFailureStatus(error, clock.now()) }); }
          }
          sticky.upsert({ key, channelId: channel.channelId, debounceMs: LFG_PANEL_DEBOUNCE_MS, lastMessageId,
            render: () => lfgPanelMessage(config.panel), onPosted: async () => {},
            onStatus: next => runtime.setPanel({ channelId: channel.channelId, state: next.state, message: next.message, atMs: next.atMs }) });
          const signature = JSON.stringify(config.panel);
          const changed = signatures.has(key) && signatures.get(key) !== signature;
          signatures.set(key, signature);
          await sticky.ensureAtBottom(key, force || changed);
        }
        for (const key of [...signatures.keys()]) {
          if (wanted.has(key)) continue;
          signatures.delete(key);
          await sticky.remove(key, true);
          runtime.setPanel(null, key.slice('lfg-panel:'.length));
        }
        return runtime.panelStatuses();
      }));
      stops.push(runtime.registerRefresher(() => reloadPanels(true)));

      const env: LfgInteractionEnv = { deps, voiceNames: ids => io.voiceNames(ids),
        staffRoleIds: async () => (await ctx.adminToolsSettings()).cases.staffRoleIds ?? [],
        onPosted: (channelId, messageId) => sticky.onMessage({ channelId, messageId, authorId: 'lfg-card', bot: false }) };
      stops.push(ctx.interactions.onComponent(FEATURE_INTERACTION_PREFIXES.lfg, interaction => handleLfgComponent(interaction, env)));
      stops.push(ctx.interactions.onModal(FEATURE_INTERACTION_PREFIXES.lfg, interaction => handleLfgModal(interaction, env)));

      const onMessage = (message: Message) => {
        if (message.guildId !== ctx.guildId || !ctx.isActive()) return;
        sticky.onMessage({ channelId: message.channelId, messageId: message.id, authorId: message.author.id, bot: message.author.bot === true || !!message.webhookId });
      };
      // Raw packets: deletions of cards that are not in the message cache (the client has no partials).
      const onRaw = (packet: RawPacket) => {
        const d = packet.d;
        if (!d || d.guild_id !== ctx.guildId || !ctx.isActive()) return;
        if (packet.t === 'MESSAGE_DELETE' && d.id) void lfgCardsDeleted(deps, { messageIds: [d.id] }).catch(() => {});
        else if (packet.t === 'MESSAGE_DELETE_BULK' && d.ids) void lfgCardsDeleted(deps, { messageIds: d.ids }).catch(() => {});
        else if (packet.t === 'CHANNEL_DELETE' && d.id) {
          void lfgCardsDeleted(deps, { channelId: d.id }).catch(() => {});
          const key = panelKey(d.id);
          if (sticky.has(key)) { void sticky.remove(key, false); status(d.id, 'channel-missing', 'The channel was deleted. Remove it from the LFG channels.'); }
        }
      };
      ctx.client.on('messageCreate', onMessage);
      ctx.client.on('raw', onRaw);
      stops.push(() => { ctx.client.off('messageCreate', onMessage); ctx.client.off('raw', onRaw); });
      stops.push(ctx.on('adminToolsChanged', event => { if (event.area === 'lfg' || event.area === 'stickies') void reloadPanels(); }));
      stops.push(ctx.on('adminToolsSettingsChanged', () => { void reloadPanels(); }));

      // Expiry: on start (restart catch-up) and on a short tick.
      let expiring = false;
      const expire = async () => {
        if (expiring || !ctx.isActive()) return;
        expiring = true;
        try { await expireDueLfgPosts(deps); } catch { /* Storage down: retried on the next tick. */ } finally { expiring = false; }
      };
      const timer = setInterval(() => { void expire(); }, options.expiryTickMs ?? LFG_EXPIRY_TICK_MS);
      timer.unref?.();
      stops.push(() => clearInterval(timer));

      await reloadPanels().catch(() => { ctx.log('LFG: the panels could not be checked; they are retried on the next settings change.'); });
      await expire();
    },
    stop() {
      engine?.stop();
      engine = null;
      for (const stop of stops.splice(0)) stop();
    }
  };
}
