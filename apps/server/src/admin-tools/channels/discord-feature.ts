// Discord feature "stickies-tickets" (agent B): keeps general stickies and the ticket panel at the bottom of
// their channels (messageCreate, no MessageContent needed), handles the 'tk:' ticket buttons, marks tickets
// whose channel was deleted by hand, and purges old transcripts. Never acts in reserved tournament channels.
import { ChannelType, MessageFlags, PermissionFlagsBits, type BaseMessageOptions, type Channel, type Guild, type Message,
  type MessageComponentInteraction } from 'discord.js';
import type { DiscordFeature, DiscordFeatureContext } from '../../discord/features.js';
import { closeTicket, openTicket, ticketChannelDeleted, type TicketGateway, type TicketServiceDeps } from '../tickets/service.js';
import { liveTicketGateway } from '../tickets/gateways.js';
import { messageFromBody, parseTicketCustomId, TICKET_IDS, ticketCloseConfirmMessage, ticketPanelMessage } from '../tickets/messages.js';
import { pgTicketStore, type TicketStore } from '../tickets/store.js';
import { stickiesTicketsRuntime, type StickiesTicketsRuntime, type TicketPanelResult } from './runtime-status.js';
import { discordErrorKind, realClock, StickyEngine, stickyFailureStatus, type StickyClock, type StickyPoster } from './sticky-engine.js';
import { pgStickyStore, type StickyStore } from './sticky-store.js';

export const PANEL_KEY = 'ticket-panel';
/** The panel is re-posted at most this often. */
export const PANEL_DEBOUNCE_MS = 15_000;
const RETENTION_EVERY_MS = 6 * 3_600_000;

export interface StickiesTicketsFeatureOptions {
  stickies?: StickyStore;
  tickets?: TicketStore;
  runtime?: StickiesTicketsRuntime;
  clock?: StickyClock;
  /** Discord I/O; defaults to the live guild. */
  io?(ctx: DiscordFeatureContext): Promise<{ poster: StickyPoster<BaseMessageOptions>; tickets: TicketGateway; scanPanels(channelId: string): Promise<string[]> }>;
}

/** Live poster: send, delete (already deleted is fine), newest message. */
export function livePoster(guild: Guild): StickyPoster<BaseMessageOptions> & { scanPanels(channelId: string, botId: string | null): Promise<string[]> } {
  const text = async (channelId: string) => {
    const channel = await guild.channels.fetch(channelId).catch((error: unknown) => {
      if (discordErrorKind(error) === 'missing-permissions') throw error;
      return null;
    });
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement))
      throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
    return channel;
  };
  return {
    post: async (channelId, payload) => (await (await text(channelId)).send(payload)).id,
    async remove(channelId, messageId) {
      try { await (await text(channelId)).messages.delete(messageId); }
      catch (error) { if (!['unknown-message', 'channel-missing'].includes(discordErrorKind(error))) throw error; }
    },
    latestMessageId: async channelId => (await (await text(channelId)).messages.fetch({ limit: 1 })).first()?.id ?? null,
    /** The bot's own ticket panels among the last 50 messages, newest first. */
    async scanPanels(channelId, botId) {
      const page = await (await text(channelId)).messages.fetch({ limit: 50 });
      return [...page.values()].filter((message: Message) => message.author.id === botId &&
        message.components.some(row => 'components' in row && row.components.some(item => 'customId' in item && item.customId === TICKET_IDS.open)))
        .map(message => message.id);
    }
  };
}

function canManageTicket(interaction: MessageComponentInteraction, openerId: string | null, staffRoleIds: readonly string[]): { staff: boolean; allowed: boolean } {
  const member = interaction.member;
  const roles: readonly string[] = !member ? [] : Array.isArray(member.roles) ? member.roles : [...member.roles.cache.keys()];
  const staff = roles.some(role => staffRoleIds.includes(role)) || !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
  return { staff, allowed: staff || interaction.user.id === openerId };
}

export function stickiesTicketsFeature(options: StickiesTicketsFeatureOptions = {}): DiscordFeature {
  const stops: Array<() => void> = [];
  let engine: StickyEngine<BaseMessageOptions> | null = null;
  const runtime = options.runtime ?? stickiesTicketsRuntime;
  return {
    name: 'stickies-tickets',
    async start(ctx) {
      const clock = options.clock ?? realClock;
      const stickies = options.stickies ?? pgStickyStore();
      const tickets = options.tickets ?? pgTicketStore();
      const io = options.io ? await options.io(ctx) : await (async () => {
        const guild = await ctx.guild();
        const poster = livePoster(guild);
        return { poster, tickets: liveTicketGateway(guild), scanPanels: (channelId: string) => poster.scanPanels(channelId, ctx.client.user?.id ?? null) };
      })();
      const botId = () => ctx.client.user?.id ?? null;
      const sticky = new StickyEngine(io.poster, botId, clock);
      engine = sticky;
      const signatures = new Map<string, string>();
      const service = (): TicketServiceDeps => ({ guildId: ctx.guildId, store: tickets, gateway: io.tickets, now: clock.now,
        audit: (kind, payload, actor) => ctx.audit(kind, payload, actor) });

      // ---- general stickies
      let reloading: Promise<void> = Promise.resolve();
      const reloadStickies = () => (reloading = reloading.then(async () => {
        if (!ctx.isActive()) return;
        let list;
        try { list = await stickies.list(ctx.guildId); } catch { ctx.log('Stickies: storage unavailable; will retry on the next change.'); return; }
        const reserved = new Set(await ctx.reservedChannelIds().catch((): string[] => []));
        const settings = await ctx.adminToolsSettings();
        const panelChannel = settings.tickets.enabled ? settings.tickets.supportChannelId : null;
        const keep = new Set<string>();
        for (const item of list) {
          const blocked = reserved.has(item.channelId) ? 'reserved' as const : item.channelId === panelChannel ? 'reserved' as const : null;
          if (!item.enabled || blocked) {
            if (sticky.has(item.id)) await sticky.remove(item.id, true);
            else if (item.lastMessageId) await io.poster.remove(item.channelId, item.lastMessageId).catch(() => {});
            if (item.lastMessageId) await stickies.setLastMessageId(ctx.guildId, item.id, null).catch(() => {});
            runtime.setStickyStatus(item.id, { state: blocked ?? 'disabled', atMs: clock.now(),
              message: blocked ? 'This channel belongs to the tournament or the ticket panel; the sticky is paused.' : null });
            signatures.delete(item.id);
            continue;
          }
          keep.add(item.id);
          const previous = sticky.has(item.id) ? sticky.lastMessageId(item.id) : item.lastMessageId;
          const movedFrom = sticky.has(item.id) && sticky.keyForChannel(item.channelId) !== item.id ? previous : null;
          if (movedFrom) await sticky.remove(item.id, true);
          const owner = sticky.keyForChannel(item.channelId);
          if (owner && owner !== item.id) await sticky.remove(owner, true);
          sticky.upsert({ key: item.id, channelId: item.channelId, debounceMs: item.debounceMs, lastMessageId: movedFrom ? null : previous,
            render: () => messageFromBody(item),
            onPosted: messageId => stickies.setLastMessageId(ctx.guildId, item.id, messageId),
            onStatus: status => runtime.setStickyStatus(item.id, status) });
          const signature = JSON.stringify([item.content, item.embed, item.channelId]);
          const changed = signatures.has(item.id) && signatures.get(item.id) !== signature;
          signatures.set(item.id, signature);
          await sticky.ensureAtBottom(item.id, changed);
        }
        // Deleted stickies: remove their posted copy.
        for (const key of [...signatures.keys()]) if (!keep.has(key)) { signatures.delete(key); await sticky.remove(key, true); runtime.setStickyStatus(key, null); }
      }).catch(() => { ctx.log('Stickies: reload failed; will retry on the next change.'); }));

      // ---- ticket panel (same engine, key PANEL_KEY)
      let panelSignature: string | null = null;
      const refreshPanel = async (force: boolean): Promise<TicketPanelResult> => {
        const settings = (await ctx.adminToolsSettings()).tickets;
        const channelId = settings.enabled ? settings.supportChannelId : null;
        if (!channelId) {
          await sticky.remove(PANEL_KEY, true);
          runtime.panel = null;
          return { ok: false, messageId: null, message: 'Tickets are off or no support channel is chosen.' };
        }
        if ((await ctx.reservedChannelIds().catch((): string[] => [])).includes(channelId)) {
          await sticky.remove(PANEL_KEY, true);
          runtime.panel = { state: 'reserved', message: 'The support channel belongs to the tournament. Choose another one.', atMs: clock.now() };
          return { ok: false, messageId: null, message: runtime.panel.message! };
        }
        let lastMessageId = sticky.has(PANEL_KEY) && sticky.keyForChannel(channelId) === PANEL_KEY ? sticky.lastMessageId(PANEL_KEY) : null;
        if (!sticky.has(PANEL_KEY) || sticky.keyForChannel(channelId) !== PANEL_KEY) {
          await sticky.remove(PANEL_KEY, true);
          const owner = sticky.keyForChannel(channelId);
          if (owner) await sticky.remove(owner, false);
          // Restart: adopt the newest existing panel and delete duplicates.
          try {
            const [newest, ...older] = await io.scanPanels(channelId);
            lastMessageId = newest ?? null;
            for (const id of older) await io.poster.remove(channelId, id).catch(() => {});
          } catch (error) { runtime.panel = stickyFailureStatus(error, clock.now()); }
        }
        sticky.upsert({ key: PANEL_KEY, channelId, debounceMs: PANEL_DEBOUNCE_MS, lastMessageId, render: () => ticketPanelMessage(settings.panel),
          onPosted: async () => {}, onStatus: status => { runtime.panel = status; } });
        const signature = JSON.stringify([settings.panel, channelId]);
        const changed = panelSignature !== null && panelSignature !== signature;
        panelSignature = signature;
        await sticky.ensureAtBottom(PANEL_KEY, force || changed);
        const posted = runtime.panel?.state === 'posted';
        return { ok: posted, messageId: sticky.lastMessageId(PANEL_KEY), message: posted ? 'The ticket panel is at the bottom of the support channel.'
          : runtime.panel?.message ?? 'The panel could not be posted.' };
      };
      stops.push(runtime.registerPanelRefresher(() => refreshPanel(true)));

      // ---- Discord events
      const onMessage = (message: Message) => {
        if (message.guildId !== ctx.guildId || !ctx.isActive()) return;
        sticky.onMessage({ channelId: message.channelId, messageId: message.id, authorId: message.author.id,
          bot: message.author.bot === true || !!message.webhookId });
      };
      const onChannelDelete = (channel: Channel) => {
        if (!('guildId' in channel) || channel.guildId !== ctx.guildId || !ctx.isActive()) return;
        void ticketChannelDeleted(service(), channel.id).catch(() => {});
        const key = sticky.keyForChannel(channel.id);
        if (key) { void sticky.remove(key, false); if (key !== PANEL_KEY) runtime.setStickyStatus(key, { state: 'channel-missing', atMs: clock.now(),
          message: 'The channel was deleted. Pick another channel or delete this sticky.' }); }
      };
      ctx.client.on('messageCreate', onMessage);
      ctx.client.on('channelDelete', onChannelDelete);
      stops.push(() => { ctx.client.off('messageCreate', onMessage); ctx.client.off('channelDelete', onChannelDelete); });
      stops.push(ctx.on('adminToolsChanged', event => { if (event.area === 'stickies') void reloadStickies(); }));
      stops.push(ctx.on('adminToolsSettingsChanged', () => { void reloadStickies(); void refreshPanel(false).catch(() => {}); }));

      // ---- ticket buttons
      stops.push(ctx.interactions.onComponent('tk:', async interaction => {
        const parsed = parseTicketCustomId(interaction.customId);
        const ephemeral = MessageFlags.Ephemeral;
        if (!parsed) { await interaction.reply({ content: 'This button is no longer valid.', flags: ephemeral }); return; }
        const settings = (await ctx.adminToolsSettings()).tickets;
        if (parsed.action === 'open') {
          await interaction.deferReply({ flags: ephemeral });
          const outcome = await openTicket(service(), settings, { id: interaction.user.id, username: interaction.user.username });
          const content = outcome.kind === 'created' ? `Your ticket is open: <#${outcome.channelId}>`
            : outcome.kind === 'existing' ? `You already have an open ticket: <#${outcome.channelId}>`
            : outcome.kind === 'pending' ? 'Your ticket is being created. It will appear in a moment.' : outcome.message;
          if (outcome.kind === 'unavailable') ctx.log('Tickets: a member could not open a ticket (category or permissions).');
          await interaction.editReply({ content });
          return;
        }
        if (parsed.action === 'cancel') { await interaction.update({ content: 'The ticket stays open.', components: [] }); return; }
        const ticket = await tickets.get(ctx.guildId, parsed.ticketId);
        const access = canManageTicket(interaction, ticket?.openerId ?? null, settings.staffRoleIds);
        if (!ticket || ticket.status !== 'open') { await interaction.reply({ content: 'This ticket is already closed.', flags: ephemeral }); return; }
        if (parsed.action === 'claim') {
          if (!access.staff) { await interaction.reply({ content: 'Only staff can claim tickets.', flags: ephemeral }); return; }
          await interaction.reply({ content: `<@${interaction.user.id}> is handling this ticket.`, allowedMentions: { parse: [] } });
          return;
        }
        if (!access.allowed) { await interaction.reply({ content: 'Only the member who opened this ticket or the staff can close it.', flags: ephemeral }); return; }
        if (parsed.action === 'close') { await interaction.reply({ ...ticketCloseConfirmMessage(ticket.id), flags: ephemeral }); return; }
        await interaction.update({ content: 'Closing the ticket and saving the transcript…', components: [] });
        try {
          const result = await closeTicket(service(), ticket.id, { kind: 'player', id: interaction.user.id });
          if (result.warning) await interaction.followUp({ content: result.warning, flags: ephemeral }).catch(() => {});
        } catch (error) {
          await interaction.followUp({ content: error instanceof Error && error.message.length < 200 ? error.message : 'The ticket could not be closed.',
            flags: ephemeral }).catch(() => {});
        }
      }));

      // ---- transcript retention
      const purge = async () => {
        const days = (await ctx.adminToolsSettings()).tickets.transcriptRetentionDays;
        if (days === null || !ctx.isActive()) return;
        const removed = await tickets.purgeClosedBefore(ctx.guildId, clock.now() - days * 86_400_000).catch(() => 0);
        if (removed) await ctx.audit('ticket.deleted', { purged: removed, retentionDays: days }).catch(() => {});
      };
      const timer = setInterval(() => { void purge(); }, RETENTION_EVERY_MS);
      timer.unref?.();
      stops.push(() => clearInterval(timer));

      await reloadStickies();
      await refreshPanel(false).catch(() => { ctx.log('Tickets: the panel could not be checked; it is retried on the next settings change.'); });
      void purge();
    },
    stop() {
      engine?.stop();
      engine = null;
      for (const stop of stops.splice(0)) stop();
    }
  };
}
