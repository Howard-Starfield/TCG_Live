import { ChannelType, PermissionFlagsBits, type Client, type Guild, type GuildBasedChannel,
  type GuildMember, type TextChannel } from 'discord.js';
import { filenameFromThumbnail, retainedVisual, visualFile, visualThumbnail } from '../discord/visuals.js';
import type { DiscoveredChannel, SetupDiscovery } from './service.js';
import { SETUP_DISCOVERY_FLAGS } from '../permissions/table.js';

/** Channel permissions the wizard reports, from the shared permission table. */
const FLAGS: Readonly<Record<string, bigint>> = SETUP_DISCOVERY_FLAGS;

/** Only Discord's own guild/channel IDs are accepted; no browser-provided URL is fetched. */
export function discordSetupDiscovery(client: Client): SetupDiscovery {
  const botId = client.user!.id;
  const applicationId = client.application!.id;
  async function guild(id: string): Promise<Guild> {
    if (!client.guilds.cache.has(id)) throw new Error('Server is not available to this bot.');
    return client.guilds.fetch(id);
  }
  async function member(target: Guild): Promise<GuildMember> {
    await target.roles.fetch();
    return target.members.fetchMe({ force: true });
  }
  function permissions(channel: GuildBasedChannel, bot: GuildMember): string[] {
    const effective = channel.permissionsFor(bot);
    return Object.entries(FLAGS).filter(([_name, flag]) => effective?.has(flag)).map(([name]) => name);
  }
  async function textChannel(id: string): Promise<{ channel: TextChannel; bot: GuildMember }> {
    const found = await client.channels.fetch(id, { force: true });
    if (found?.type !== ChannelType.GuildText || !client.guilds.cache.has(found.guildId))
      throw new Error('Signup text channel is not available to this bot.');
    const bot = await member(await guild(found.guildId));
    return { channel: found, bot };
  }
  return {
    applicationId,
    botName: client.user!.username,
    async guilds() {
      return Promise.all([...client.guilds.cache.keys()].map(async id => {
        const item = await guild(id);
        return { id: item.id, name: item.name, ownerId: item.ownerId };
      }));
    },
    async channels(guildId): Promise<DiscoveredChannel[]> {
      const target = await guild(guildId);
      const bot = await member(target);
      const visible = await target.channels.fetch();
      return [...visible.values()].flatMap(item => {
        if (!item || (item.type !== ChannelType.GuildText && item.type !== ChannelType.GuildVoice)) return [];
        return [{ id: item.id, name: item.name,
          category: item.parent?.name ?? null,
          type: item.type === ChannelType.GuildText ? 'text' as const : 'voice' as const,
          permissions: permissions(item, bot), afk: item.id === target.afkChannelId }];
      })
        .filter(item => item.permissions.includes('View Channel'));
    },
    async createChannel(guildId, name, type) {
      const target = await guild(guildId);
      const channel = await target.channels.create({ name, type: type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        reason: 'Created in TCG Live setup' });
      // The channel exists now: a failed member lookup must not report "not created" and invite a duplicate on retry.
      const bot = await member(target).catch(() => null);
      return { id: channel.id, name: channel.name, category: null, type, permissions: bot ? permissions(channel, bot) : [], afk: false };
    },
    async guide(channelId, adminId, content, messageId, mentionAdmin) {
      const { channel, bot } = await textChannel(channelId);
      if (!channel.permissionsFor(bot)?.has(PermissionFlagsBits.SendMessages))
        throw new Error('The bot cannot post in the signup channel.');
      const rich = channel.permissionsFor(bot)?.has([PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]);
      const thumbnail = visualThumbnail('notice');
      const base = rich ? { content: mentionAdmin ? `<@${adminId}>` : '',
        embeds: [{ description: content, color: content.startsWith('Setup ready') ? 0x22c55e : 0xf59e0b,
          thumbnail }],
        allowedMentions: { parse: [] as [], users: mentionAdmin ? [adminId] : [] } } :
        { content: `${mentionAdmin ? `<@${adminId}> ` : ''}${content}`,
          embeds: [], allowedMentions: { parse: [] as [], users: mentionAdmin ? [adminId] : [] } };
      const file = visualFile(filenameFromThumbnail(thumbnail)!)!;
      if (!messageId) return (await channel.send(rich ? { ...base, files: [file] } : base)).id;
      const message = await channel.messages.fetch({ message: messageId, force: true });
      if (message.author.id !== botId) throw new Error('Setup guide is no longer bot-authored.');
      const retained = rich && retainedVisual(message, channel.id, botId, file.name);
      await message.edit({ ...base, content: rich ? '' : content,
        allowedMentions: { parse: [] as [], users: [] },
        ...(rich ? retained ? {} : { attachments: [], files: [file] } : { attachments: [] }) });
      return message.id;
    }
  };
}
