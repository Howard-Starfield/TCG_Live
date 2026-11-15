// LFG Discord I/O: the live guild (cards, panels) and an in-memory stand-in for the demo and tests.
import { ChannelType, type Guild, type Message, type MessageCreateOptions, type MessageEditOptions } from 'discord.js';
import { discordErrorKind, type StickyPoster } from '../channels/sticky-engine.js';
import { isMissing } from '../roles/guild-port.js';
import { LFG_IDS, type LfgMessage } from './messages.js';
import type { LfgGateway } from './service.js';

async function textChannel(guild: Guild, channelId: string) {
  const channel = await guild.channels.fetch(channelId).catch((error: unknown) => {
    if (discordErrorKind(error) === 'missing-permissions') throw error;
    return null;
  });
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement))
    throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
  return channel;
}

const payload = (message: LfgMessage) => ({ ...(message.content !== undefined ? { content: message.content } : {}), embeds: message.embeds,
  components: message.components, allowedMentions: message.allowedMentions });

export function liveLfgGateway(guild: Guild): LfgGateway {
  return {
    send: async (channelId, message) => (await (await textChannel(guild, channelId)).send(payload(message) as MessageCreateOptions)).id,
    async edit(channelId, messageId, message) {
      try { await (await textChannel(guild, channelId)).messages.edit(messageId, payload(message) as MessageEditOptions); return 'ok'; }
      catch (error) { if (isMissing(error)) return 'missing'; throw error; }
    },
    async remove(channelId, messageId) {
      try { await (await textChannel(guild, channelId)).messages.delete(messageId); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
  };
}

/** Sticky poster for the panel, plus a scan that adopts the bot's existing panels after a restart. */
export function liveLfgPanelPoster(guild: Guild): StickyPoster<LfgMessage> & { scanPanels(channelId: string, botId: string | null): Promise<string[]> } {
  const gateway = liveLfgGateway(guild);
  return {
    post: (channelId, message) => gateway.send(channelId, message),
    remove: (channelId, messageId) => gateway.remove(channelId, messageId),
    latestMessageId: async channelId => (await (await textChannel(guild, channelId)).messages.fetch({ limit: 1 })).first()?.id ?? null,
    async scanPanels(channelId, botId) {
      const page = await (await textChannel(guild, channelId)).messages.fetch({ limit: 50 });
      return [...page.values()].filter((message: Message) => message.author.id === botId &&
        message.components.some(row => 'components' in row && row.components.some(item => 'customId' in item && item.customId === LFG_IDS.new)))
        .map(message => message.id);
    }
  };
}

/** In-memory Discord for the demo and tests: every message is kept, deleted ones are gone. */
export class MemoryLfgGateway implements LfgGateway {
  readonly messages = new Map<string, { channelId: string; message: LfgMessage; edits: number }>();
  private next = 900000000000000000n;
  failSend: unknown = null;
  async send(channelId: string, message: LfgMessage) {
    if (this.failSend) throw this.failSend;
    const id = String(this.next += 1n);
    this.messages.set(id, { channelId, message: structuredClone(message), edits: 0 });
    return id;
  }
  async edit(_channelId: string, messageId: string, message: LfgMessage) {
    const item = this.messages.get(messageId);
    if (!item) return 'missing' as const;
    item.message = structuredClone(message); item.edits += 1;
    return 'ok' as const;
  }
  async remove(_channelId: string, messageId: string) { this.messages.delete(messageId); }
}
