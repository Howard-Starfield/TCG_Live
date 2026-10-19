import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChannelType, ChatInputCommandInteraction, Events, MessageFlags, MessageType, PermissionFlagsBits, Routes,
  SlashCommandBuilder, type Guild, type GuildMember, type Interaction, type TextChannel, type VoiceChannel
} from 'discord.js';
import { readConfig } from '../config.js';
import { RuleError, type MatchId, type Player } from '../rehearsal/domain.js';
import { startServer } from '../server.js';
import { setupPrivateDiscordSchema } from '../rehearsal/store.js';
import { type CardPayload } from './cards.js';
import { readPrivateDiscordConfig, type PrivateDiscordConfig } from './config.js';
import { PrivateDiscordController, type CardTransport, type PrivateInteraction } from './controller.js';
import { acquireAdvisoryLease, getSessionState, prepareSession, prepareSignupSession, type AdvisoryLease } from './session.js';
import { privateDiscordClient, privateDiscordRest } from './sdk.js';
import { MatchRoomReconciler, type Room, type RoomOverwrite, type RoomTransport } from './match-rooms.js';
import { filenameFromThumbnail, noticeEmbed, visualFile, visualThumbnail } from './visuals.js';

function safeError(error: unknown): string {
  return error instanceof RuleError ? error.message : 'Private Discord operation failed.';
}

export function commandDefinition() {
  const match = { name: 'match', description: 'Practice match', type: 3, required: true,
    choices: [{ name: 'A vs B', value: 'M1' }, { name: 'C vs D', value: 'M2' }] };
  const winner = { name: 'winner', description: 'Fixture player', type: 3, required: true,
    choices: ['A', 'B', 'C', 'D'].map(name => ({ name, value: name })) };
  const reason = { name: 'reason', description: 'Required admin reason', type: 3, required: true };
  return new SlashCommandBuilder().setName('tcg-test').setDescription('Private practice fixture')
    .addSubcommand(sub => sub.setName('publish').setDescription('Publish the fixed practice round'))
    .addSubcommand(sub => sub.setName('signup-close').setDescription('Assign four signup members to A-D'))
    .addSubcommand(sub => sub.setName('signup-reopen').setDescription('Reopen signup before publication'))
    .addSubcommand(sub => sub.setName('signup-remove').setDescription('Remove a signup member while open')
      .addStringOption(option => option.setName('member-id').setDescription('Discord member ID').setRequired(true)))
    .addSubcommand(sub => sub.setName('refresh').setDescription('Create or repair the three practice cards'))
    .addSubcommand(sub => sub.setName('resolve').setDescription('Resolve a practice match')
      .addStringOption(option => option.setName(match.name).setDescription(match.description).setRequired(true)
        .addChoices(...match.choices))
      .addStringOption(option => option.setName(winner.name).setDescription(winner.description).setRequired(true)
        .addChoices(...winner.choices))
      .addStringOption(option => option.setName(reason.name).setDescription(reason.description).setRequired(true)))
    .addSubcommand(sub => sub.setName('correct').setDescription('Correct a finalized practice match')
      .addStringOption(option => option.setName(match.name).setDescription(match.description).setRequired(true)
        .addChoices(...match.choices))
      .addStringOption(option => option.setName(winner.name).setDescription(winner.description).setRequired(true)
        .addChoices(...winner.choices))
      .addStringOption(option => option.setName(reason.name).setDescription(reason.description).setRequired(true)))
    .addSubcommand(sub => sub.setName('judge-resume').setDescription('Override a practice pause')
      .addStringOption(option => option.setName(match.name).setDescription(match.description).setRequired(true)
        .addChoices(...match.choices))
      .addStringOption(option => option.setName(reason.name).setDescription(reason.description).setRequired(true)))
    .toJSON();
}

export async function registerPrivateCommand(config: PrivateDiscordConfig): Promise<void> {
  if (!config.token) throw new RuleError('TCG_DISCORD_TOKEN or DISCORD_BOT_TOKEN is required.');
  const rest = privateDiscordRest(config.token);
  const route = Routes.applicationGuildCommands(config.applicationId, config.guildId);
  const commands = await rest.get(route) as Array<{ id: string; name: string }>;
  const existing = commands.find(command => command.name === 'tcg-test');
  if (existing) await rest.patch(Routes.applicationGuildCommand(config.applicationId, config.guildId, existing.id),
    { body: commandDefinition() });
  else await rest.post(route, { body: commandDefinition() });
}

export function discordTransport(channel: TextChannel, matches?: Record<MatchId, VoiceChannel>, botId?: string): CardTransport {
  const payload = (card: CardPayload) => ({ embeds: card.embeds, components: card.components,
    allowedMentions: card.allowedMentions });
  const cardFile = (card: CardPayload) => {
    const filename = filenameFromThumbnail(card.embeds[0]?.thumbnail);
    return filename ? visualFile(filename) : null;
  };
  const destination = (slot: 'checkin' | MatchId = 'checkin') => slot === 'checkin' ? channel : matches?.[slot] ?? channel;
  return {
    async send(card, slot) {
      const file = cardFile(card);
      return (await destination(slot).send({ ...payload(card), ...(file ? { files: [file] } : {}) })).id;
    },
    async edit(id, card, slot) {
      const target = destination(slot);
      const message = await target.messages.fetch(id);
      const file = cardFile(card);
      if (!file) { await message.edit(payload(card)); return; }
      const attachments = message.attachments;
      const visibleAttachment = attachments?.size === 1 && [...attachments.values()][0]?.name === file.name;
      let embeddedAttachment = false;
      if (attachments?.size === 0 && botId && message.author?.id === botId) {
        try {
          const thumbnail = new URL(message.embeds?.[0]?.thumbnail?.url ?? '');
          const channelId = target.id;
          const path = thumbnail.pathname.match(/^\/attachments\/([1-9]\d{14,21})\/([1-9]\d{14,21})\/([^/]+)$/);
          embeddedAttachment = thumbnail.protocol === 'https:' && !thumbnail.port && !thumbnail.username &&
            !thumbnail.password && !thumbnail.hash &&
            ['cdn.discordapp.com', 'media.discordapp.net'].includes(thumbnail.hostname) &&
            path?.[1] === channelId && path[3] === file.name;
        } catch { /* An unexpected thumbnail is replaced with the known local asset. */ }
      }
      const retained = visibleAttachment || embeddedAttachment;
      await message.edit(retained ? payload(card) : { ...payload(card), attachments: [], files: [file] });
    },
    async resumeReminder(slot, waitingIds) {
      const ids = [...new Set(waitingIds)];
      if (!ids.length) throw new RuleError('Private Discord reminder has no waiting player.');
      const message = await destination(slot).send({
        content: `Waiting to resume: ${ids.map(id => `<@${id}>`).join(', ')}`,
        embeds: [{ description: 'Both players must choose Resume on the match card to continue.',
          color: 0xf59e0b, thumbnail: visualThumbnail('reminder') }],
        files: [visualFile('tcg-reminder-v1.gif')!],
        allowedMentions: { parse: [], users: ids }
      });
      return message.id;
    },
    async pin(id) {
      const before = await channel.messages.fetch({ limit: 10 });
      const message = await channel.messages.fetch(id);
      await message.pin();
      if (botId) {
        const after = await channel.messages.fetch({ limit: 10 });
        const notice = after.find(item => !before.has(item.id) && item.type === MessageType.ChannelPinnedMessage &&
          item.author.id === botId && item.reference?.messageId === id);
        if (notice) await notice.delete();
      }
    },
    async remove(id, slot) {
      if (!botId) throw new RuleError('Private Discord bot identity is unavailable for card cleanup.');
      const target = destination(slot);
      let message;
      try { message = await target.messages.fetch({ message: id, force: true }); }
      catch (error) { if ((error as { code?: number })?.code === 10008) return; throw error; }
      if (message.author.id !== botId) throw new RuleError('Private Discord card is not bot-authored.');
      try { await message.delete(); }
      catch (error) { if ((error as { code?: number })?.code !== 10008) throw error; }
    },
    classify(error) {
      const code = (error as { code?: number })?.code;
      return code === 10008 ? 'missing' : code === 50001 || code === 50013 ? 'forbidden' : 'retry';
    }
  };
}

export function discordRoomTransport(guild: Guild, rooms: Record<MatchId, VoiceChannel>, bot: GuildMember,
  control: TextChannel, adminId: string): RoomTransport {
  const current = (room: Room): RoomOverwrite[] => [...rooms[room].permissionOverwrites.cache.values()].map(overwrite => ({
    id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString()
  }));
  const assertPermissions = async (room: Room, operation: 'policy' | 'move') => {
    const permissions = rooms[room].permissionsFor(bot);
    const needed = operation === 'policy' ? [
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers
    ] : [PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers];
    const names = operation === 'policy' ? ['View Channel', 'Connect', 'Send Messages', 'Read Message History',
      'Embed Links', 'Attach Files', 'Manage Roles', 'Manage Channels', 'Move Members'] : ['Connect', 'Move Members'];
    const missing = needed.filter(flag => !permissions?.has(flag)).map(flag => names[needed.indexOf(flag)]);
    if (missing.length) throw new RuleError(`Public match room ${room} requires bot ${missing.join(', ')} permission.`);
  };
  return {
    async current(room) { return current(room); },
    assertPermissions,
    async replace(room, overwrites) {
      await rooms[room].permissionOverwrites.set(overwrites.map(row => ({ id: row.id, type: row.type,
        allow: BigInt(row.allow), deny: BigInt(row.deny) })), 'TCG practice public match room policy');
    },
    voiceChannel(memberId) { return guild.voiceStates.cache.get(memberId)?.channelId ?? null; },
    async move(memberId, room) {
      const voice = guild.voiceStates.cache.get(memberId);
      if (!voice?.channelId) return;
      await voice.setChannel(rooms[room], 'TCG practice match placement');
    },
    async warnOrganizer(message) {
      await control.send({ content: `<@${adminId}>`, embeds: [{ description: message,
        color: 0xf59e0b, thumbnail: visualThumbnail('notice') }],
        files: [visualFile('tcg-notice-v1.gif')!],
        allowedMentions: { parse: [], users: [adminId] } });
    }
  };
}

export function assertPublicMatchRoomTargets(config: PrivateDiscordConfig,
  rooms: Record<MatchId, { id: string; name: string; guildId: string; type: ChannelType }>,
  afkChannelId: string | null): void {
  if (!config.publicMatchRooms) return;
  if (!config.matchChannels || rooms.M1.id === rooms.M2.id ||
      (['M1', 'M2'] as const).some(room => rooms[room].id !== config.matchChannels?.[room] ||
        rooms[room].type !== ChannelType.GuildVoice || rooms[room].guildId !== config.guildId ||
        rooms[room].id === afkChannelId || !rooms[room].name.startsWith('TCG Match ')))
    throw new RuleError('Public match rooms require two distinct dedicated TCG Match voice channels outside AFK in the configured guild.');
}

export function adapt(interaction: Interaction): PrivateInteraction | null {
  if (!interaction.isButton() && !interaction.isChatInputCommand()) return null;
  if (interaction.isChatInputCommand() && interaction.commandName !== 'tcg-test') return null;
  const base = {
    id: interaction.id, applicationId: interaction.applicationId,
    guildId: interaction.guildId, channelId: interaction.channelId,
    userId: interaction.user.id
  };
  const expire = (remove: () => Promise<unknown>) => {
    const timer = setTimeout(() => { void remove().catch(() => {}); }, 8_000);
    timer.unref();
  };
  if (interaction.isButton()) return {
    ...base, kind: 'button', customId: interaction.customId, messageId: interaction.message.id,
    async acknowledge() { await interaction.deferUpdate(); },
    async reply(message) {
      if ((message.startsWith('Saved: ') && !message.includes('pending')) || message.startsWith('No change: ')) return;
      const embed = noticeEmbed(message);
      const file = visualFile(filenameFromThumbnail(embed.thumbnail)!)!;
      const follow = await interaction.followUp({ embeds: [embed], files: [file], flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] } });
      expire(() => interaction.webhook.deleteMessage(follow.id));
    }
  };
  const command = interaction as ChatInputCommandInteraction;
  return { ...base, kind: 'command',
    async acknowledge() { await command.deferReply({ flags: MessageFlags.Ephemeral }); },
    async reply(message) {
      const embed = noticeEmbed(message);
      const file = visualFile(filenameFromThumbnail(embed.thumbnail)!)!;
      await command.editReply({ embeds: [embed], files: [file], allowedMentions: { parse: [] } });
      expire(() => command.deleteReply('@original'));
    },
    subcommand: command.options.getSubcommand(),
    matchId: (command.options.getString('match') ?? undefined) as MatchId | undefined,
    winner: (command.options.getString('winner') ?? undefined) as Player | undefined,
    reason: command.options.getString('reason') ?? undefined,
    memberId: command.options.getString('member-id') ?? undefined };
}

interface ReadyGateway {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  login(token: string): Promise<unknown>;
  isReady(): boolean;
}

export async function loginAndWaitReady(
  client: ReadyGateway, token: string, cancelled: () => boolean = () => false, timeoutMs = 15_000
): Promise<void> {
  let finish!: (ready: boolean) => void;
  const ready = new Promise<boolean>(resolve => {
    let settled = false;
    const onReady = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const cancellation = setInterval(() => { if (cancelled()) finish(false); }, 100);
    finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancellation);
      client.off(Events.ClientReady, onReady);
      resolve(value);
    };
    client.once(Events.ClientReady, onReady);
  });
  try {
    await client.login(token);
    if (client.isReady()) finish(true);
    if (!await ready || cancelled()) throw new RuleError('Private Discord Gateway readiness was interrupted or timed out.');
  } catch (error) {
    finish(false);
    throw error;
  }
}

export async function runPrivateDiscord(config: PrivateDiscordConfig = readPrivateDiscordConfig(process.env, true)): Promise<void> {
  const healthConfig = readConfig();
  const runnerId = randomUUID();
  const client = privateDiscordClient(!!config.publicMatchRooms);
  let stopping = false;
  let shutdownTask: Promise<void> | undefined;
  let controller: PrivateDiscordController | undefined;
  let health: Awaited<ReturnType<typeof startServer>> | undefined;
  let lease: AdvisoryLease | undefined;
  let roomSync: MatchRoomReconciler | undefined;
  const reportedRoomFailures = new Set<string>();
  const reportRoomFailure = (error: unknown) => {
    const message = safeError(error);
    if (message.includes('policy is pending') || reportedRoomFailures.has(message)) return;
    reportedRoomFailures.add(message);
    process.stderr.write(`Room setup pending: ${message}\n`);
  };
  async function shutdown(): Promise<void> {
    if (shutdownTask) return shutdownTask;
    stopping = true;
    shutdownTask = (async () => {
      const watchdog = setTimeout(() => { process.stderr.write('Private Discord shutdown deadline exceeded.\n'); process.exit(1); }, 5_000);
      try {
        await controller?.stop();
        await roomSync?.stop();
        await client.destroy();
        await lease?.release();
        await health?.stop();
        process.stdout.write('Private Discord runtime stopped.\n');
      } catch {
        process.stderr.write('Private Discord shutdown failed.\n');
        process.exit(1);
      } finally { clearTimeout(watchdog); }
    })();
    return shutdownTask;
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGBREAK', () => { void shutdown(); });
  const ensureActive = () => {
    if (stopping || lease?.isLost()) throw new RuleError('Private Discord startup was interrupted.');
  };
  try {
    lease = await acquireAdvisoryLease(config, () => {
      process.stderr.write('Private Discord database ownership lost.\n');
      process.exitCode = 1;
      void shutdown();
    });
    ensureActive();
    health = await startServer(healthConfig);
    ensureActive();
    await loginAndWaitReady(client, config.token!, () => stopping || lease?.isLost() === true);
    ensureActive();
    if (client.application?.id !== config.applicationId) throw new RuleError('Authenticated Discord application ID differs from configuration.');
    const channel = await client.channels.fetch(config.channelId);
    ensureActive();
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== config.guildId)
      throw new RuleError('Configured private Discord channel is not a text channel.');
    const guild = await client.guilds.fetch(config.guildId);
    const bot = await guild.members.fetchMe();
    const textPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];
    if (!channel.permissionsFor(bot)?.has(textPermissions))
      throw new RuleError('Private Discord control channel requires bot View Channel, Send Messages, Read Message History, Embed Links, and Attach Files permissions.');
    let matches: Record<MatchId, VoiceChannel> | undefined;
    if (config.matchChannels) {
      const m1 = await client.channels.fetch(config.matchChannels.M1);
      const m2 = await client.channels.fetch(config.matchChannels.M2);
      ensureActive();
      if (m1?.type !== ChannelType.GuildVoice || m2?.type !== ChannelType.GuildVoice ||
          m1.guildId !== config.guildId || m2.guildId !== config.guildId)
        throw new RuleError('Configured private Discord match channel is not a guild voice channel.');
      assertPublicMatchRoomTargets(config, { M1: m1, M2: m2 }, guild.afkChannelId);
      const voicePermissions = [...textPermissions, PermissionFlagsBits.Connect];
      if (!config.publicMatchRooms && (!m1.permissionsFor(bot)?.has(voicePermissions) || !m2.permissionsFor(bot)?.has(voicePermissions)))
        throw new RuleError('Private Discord match channels require bot View Channel, Connect, Send Messages, Read Message History, Embed Links, and Attach Files permissions.');
      matches = { M1: m1, M2: m2 };
    }
    if (config.publicMatchRooms) {
      if (!matches) throw new RuleError('Public match rooms require both match channels.');
      const roomTransport: RoomTransport = discordRoomTransport(guild, matches, bot, channel, config.adminId);
      await roomTransport.assertPermissions('M1', 'policy');
      await roomTransport.assertPermissions('M2', 'policy');
      roomSync = new MatchRoomReconciler(config, bot.id, guild.afkChannelId, roomTransport,
        () => getSessionState(config), () => !stopping && !lease?.isLost());
      await roomSync.trigger();
    }
    ensureActive();
    controller = new PrivateDiscordController(config, runnerId, discordTransport(channel, matches, client.user!.id),
      undefined, undefined, undefined, undefined, undefined, undefined, () => !stopping && !lease?.isLost(),
      undefined, undefined, explicit => roomSync?.trigger(explicit) ?? Promise.resolve());
    await controller.start();
    ensureActive();
    client.on('interactionCreate', interaction => { if (!stopping && !lease?.isLost()) {
      const adapted = adapt(interaction);
      if (adapted) void controller?.handle(adapted).catch(() => {});
    } });
    client.on('messageCreate', message => {
      if (!stopping && !lease?.isLost()) controller?.onMessage({
        guildId: message.guildId, channelId: message.channelId, id: message.id,
        authorBot: message.author.bot, webhookId: message.webhookId
      });
    });
    client.on('voiceStateUpdate', (before, after) => {
      if (!roomSync || stopping || lease?.isLost() || before.guild.id !== config.guildId ||
          before.channelId === after.channelId) return;
      void roomSync.trigger(false, after.id).catch(reportRoomFailure);
    });
    client.on('channelUpdate', (_before, after) => {
      if (roomSync && config.matchChannels && Object.values(config.matchChannels).includes(after.id))
        void roomSync.trigger().catch(reportRoomFailure);
    });
    const reconnect = () => { controller?.reconnect(); void roomSync?.trigger().catch(reportRoomFailure); };
    client.on('shardResume', reconnect);
    client.on('shardReady', reconnect);
    process.stdout.write(`Private Discord runtime ready; health on 127.0.0.1:${health.port}.\n`);
  } catch (error) {
    await shutdown();
    // A cancellation can arrive while an awaited acquisition is still in flight.
    await lease?.release();
    await health?.stop();
    throw new RuleError(safeError(error));
  }
}

async function main(): Promise<void> {
  try {
    const verb = process.argv[2];
    if (verb === 'setup') {
      process.stdout.write(`Private Discord schema ${await setupPrivateDiscordSchema()}.\n`);
    } else if (verb === 'prepare' || verb === 'signup-prepare') {
      if (process.argv.slice(3).some(arg => arg !== '--replace')) throw new RuleError('Unknown prepare option.');
      const config = verb === 'signup-prepare' ? readPrivateDiscordConfig(process.env, false, 'signup') :
        readPrivateDiscordConfig(process.env, false, 'legacy');
      const session = await (verb === 'signup-prepare' ? prepareSignupSession : prepareSession)(config, process.argv.includes('--replace'));
      process.stdout.write(`Private Discord session prepared: ${session.event_id}.\n`);
    } else if (verb === 'register' || verb === 'signup-register') {
      await registerPrivateCommand(verb === 'signup-register' ? readPrivateDiscordConfig(process.env, true, 'signup') :
        readPrivateDiscordConfig(process.env, true, 'legacy'));
      process.stdout.write('Private Discord guild command registered.\n');
    } else if (verb === 'run' || verb === 'signup-run') await runPrivateDiscord(
      verb === 'signup-run' ? readPrivateDiscordConfig(process.env, true, 'signup') :
        readPrivateDiscordConfig(process.env, true, 'legacy'));
    else throw new RuleError('Unknown private Discord command.');
  } catch (error) {
    process.stderr.write(`${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) void main();
