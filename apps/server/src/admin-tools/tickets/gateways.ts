// TicketGateway implementations: the live Discord guild and the in-memory demo.
import { ChannelType, GatewayIntentBits, OverwriteType, type BaseMessageOptions, type Guild, type Message } from 'discord.js';
import type { DemoGuild } from '../demo-guild.js';
import type { TicketGateway } from './service.js';
import type { TranscriptMessageInput } from './store.js';

function transcriptLine(message: Message): TranscriptMessageInput {
  const embedText = message.embeds.map(embed => [embed.title, embed.description].filter(Boolean).join(': ')).filter(Boolean).join('\n');
  return { messageId: message.id, authorId: message.author.id, authorName: message.member?.displayName ?? message.author.username,
    authorBot: message.author.bot, content: message.content || embedText,
    attachments: [...message.attachments.values()].map(item => ({ name: item.name, url: item.url, size: item.size ?? null })),
    createdAtMs: message.createdTimestamp };
}

export function liveTicketGateway(guild: Guild): TicketGateway {
  const textChannel = async (channelId: string) => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    return channel && channel.type === ChannelType.GuildText ? channel : null;
  };
  return {
    botUserId: () => guild.client.user?.id ?? null,
    everyoneRoleId: () => guild.roles.everyone.id,
    member: async userId => {
      const member = await guild.members.fetch(userId).catch(() => null);
      return member ? { username: member.user.username } : null;
    },
    channelExists: async channelId => !!(await guild.channels.fetch(channelId).catch(() => null)),
    categoryExists: async categoryId => (await guild.channels.fetch(categoryId).catch(() => null))?.type === ChannelType.GuildCategory,
    async createChannel(spec) {
      const channel = await guild.channels.create({ name: spec.name, type: ChannelType.GuildText, parent: spec.categoryId, reason: spec.reason,
        permissionOverwrites: spec.overwrites.map(item => ({ id: item.id, type: item.type === 'role' ? OverwriteType.Role : OverwriteType.Member,
          allow: item.allow, deny: item.deny })) });
      return channel.id;
    },
    async send(channelId, message: BaseMessageOptions) {
      const channel = await textChannel(channelId);
      if (!channel) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
      return (await channel.send(message)).id;
    },
    async fetchTranscript(channelId, max) {
      const channel = await textChannel(channelId);
      // Without the Message Content intent Discord returns empty content, embeds and attachments for other
      // members' messages, over the gateway and REST alike (the bot's own messages and mentions excepted).
      const contentAvailable = guild.client.options.intents.has(GatewayIntentBits.MessageContent);
      if (!channel) return { messages: [], contentAvailable };
      const collected: TranscriptMessageInput[] = [];
      let before: string | undefined;
      while (collected.length < max) {
        const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!page.size) break;
        for (const message of page.values()) collected.push(transcriptLine(message));
        before = page.last()?.id;
        if (page.size < 100) break;
      }
      return { messages: collected.slice(0, max).reverse(), contentAvailable };
    },
    async deleteChannel(channelId, reason) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) return;
      await channel.delete(reason);
    }
  };
}

/** Demo: channels are IDs in memory; transcripts are a short synthetic conversation. */
export function demoTicketGateway(demo: DemoGuild, now: () => number): TicketGateway {
  const created = new Set<string>();
  let next = 900n;
  const bot = demo.members.find(member => member.bot);
  return {
    botUserId: () => bot?.id ?? null,
    everyoneRoleId: () => demo.id,
    member: async userId => { const member = demo.members.find(item => item.id === userId); return member ? { username: member.username } : null; },
    channelExists: async channelId => created.has(channelId) || demo.channels.some(channel => channel.id === channelId),
    categoryExists: async categoryId => demo.channels.some(channel => channel.id === categoryId && channel.type === 'category'),
    async createChannel() { const id = `${BigInt(demo.id) + next}`; next += 1n; created.add(id); return id; },
    async send() { const id = `${BigInt(demo.id) + next}`; next += 1n; return id; },
    async fetchTranscript() { return { messages: [], contentAvailable: true }; },
    async deleteChannel(channelId) { created.delete(channelId); void now; }
  };
}
