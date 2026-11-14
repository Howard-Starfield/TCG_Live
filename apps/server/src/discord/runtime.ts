import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChannelType, ChatInputCommandInteraction, Events, LabelBuilder, MessageFlags, MessageType, ModalBuilder,
  PermissionFlagsBits, Routes, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, type Guild, type GuildMember, type Interaction, type TextChannel, type VoiceChannel
} from 'discord.js';
import { JUDGE_REQUEST_CATEGORIES, MAX_JUDGE_REQUEST_LENGTH } from '@tcg-live/core';
import { readAdminConfig, type AdminConfig } from '../admin/config.js';
import { createDiscordAdmin, discordGateway, guildMembers, type DiscordAdmin, type DiscordAdminOptions } from '../admin/runtime/discord-wiring.js';
import { readConfig } from '../config.js';
import { RuleError, type EventState, type MatchId, type Player } from '../rehearsal/domain.js';
import { startServer } from '../server.js';
import { setupPrivateDiscordSchema } from '../rehearsal/store.js';
import { buttonId, type CardPayload } from './cards.js';
import { readPrivateDiscordConfig, type ConfiguredRooms, type PrivateDiscordConfig } from './config.js';
import { PrivateDiscordController, type CardTransport, type PrivateInteraction } from './controller.js';
import { acquireAdvisoryLease, bindRoundRoom, dueSignupDrafts, getSessionState, resolvePlayers, type SessionRow, prepareSession, prepareSignupSession, type AdvisoryLease } from './session.js';
import { privateDiscordClient, privateDiscordRest } from './sdk.js';
import { backupRoomOverwrites, MatchRoomReconciler, roomPlan, sameOverwrites, type Room, type RoomOverwrite, type RoomTransport } from './match-rooms.js';
import { filenameFromThumbnail, noticeEmbed, retainedVisual, setVisualArtworkStore, visualFile, visualThumbnail } from './visuals.js';
import { defaultArtworkStore } from '../artwork/store.js';

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

export function discordTransport(channel: TextChannel | (() => TextChannel), matches?: ConfiguredRooms<VoiceChannel>, botId?: string, roundRoom?: (slot: MatchId) => VoiceChannel | undefined): CardTransport {
  const payload = (card: CardPayload) => ({ embeds: card.embeds, components: card.components,
    allowedMentions: card.allowedMentions });
  const cardFile = (card: CardPayload) => {
    const filename = filenameFromThumbnail(card.embeds[0]?.image ?? card.embeds[0]?.thumbnail);
    return filename ? visualFile(filename) : null;
  };
  const signup = () => typeof channel === 'function' ? channel() : channel;
  const destination = (slot: 'checkin' | MatchId = 'checkin') => slot === 'checkin' ? signup() : roundRoom?.(slot) ?? matches?.[slot] ?? signup();
  return {
    async findMatchCard(eventId, slot) {
      const target = destination(slot);
      if (target.type !== ChannelType.GuildVoice) throw new RuleError('The tournament match voice room is not ready.');
      const ids = new Set([buttonId(eventId, slot, 'ready'), buttonId(eventId, slot, 'judge')]);
      const messages = await target.messages.fetch({ limit: 20 });
      return messages.find(message => message.author.id === botId &&
        message.components.some(row => 'components' in row && row.components.some(component =>
          'customId' in component && component.customId !== null && ids.has(component.customId))))?.id ?? null;
    },
    async send(card, slot, nonce) {
      const file = cardFile(card);
      return (await destination(slot).send({ ...payload(card), ...(file ? { files: [file] } : {}),
        ...(nonce ? { nonce, enforceNonce: true } : {}) })).id;
    },
    async edit(id, card, slot) {
      const target = destination(slot);
      const message = await target.messages.fetch(id);
      const file = cardFile(card);
      if (!file) { await message.edit({ ...payload(card), attachments: [] }); return; }
      const retained = retainedVisual(message, target.id, botId ?? '', file.name);
      await message.edit(retained ? payload(card) : { ...payload(card), attachments: [], files: [file] });
    },
    async resumeReminder(slot, waitingIds) {
      const ids = [...new Set(waitingIds)];
      if (!ids.length) throw new RuleError('Private Discord reminder has no waiting player.');
      const reminder = visualThumbnail('reminder');
      const message = await destination(slot).send({
        content: `Waiting to resume: ${ids.map(id => `<@${id}>`).join(', ')}`,
        embeds: [{ description: 'Both players must choose Resume on the match card to continue.',
          color: 0xf59e0b, thumbnail: reminder }],
        files: [visualFile(filenameFromThumbnail(reminder)!)!],
        allowedMentions: { parse: [], users: ids }
      });
      return message.id;
    },
    async pin(id) {
      const channel = signup();
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
    async unpin(id) {
      const message = await signup().messages.fetch({ message: id, force: true });
      if (message.pinned) await message.unpin();
    },
    async remove(id, slot, channelId) {
      if (!botId) throw new RuleError('Private Discord bot identity is unavailable for card cleanup.');
      const current = destination(slot);
      let target = current;
      if (channelId && channelId !== current.id) {
        const saved = await current.client.channels.fetch(channelId).catch(error => {
          if ((error as { code?: number })?.code === 10003) return null;
          throw error;
        });
        if (!saved) return;
        if ((saved.type !== ChannelType.GuildText && saved.type !== ChannelType.GuildVoice) || saved.guildId !== current.guildId)
          throw new RuleError('Saved Discord card channel is outside the configured server.');
        target = saved;
      }
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

export function discordRoomTransport(guild: Guild, rooms: ConfiguredRooms<VoiceChannel>, bot: GuildMember,
  control: TextChannel | (() => TextChannel), adminId: string): RoomTransport {
  const current = (room: Room): RoomOverwrite[] => [...rooms[room]!.permissionOverwrites.cache.values()].map(overwrite => ({
    id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString()
  }));
  const assertPermissions = async (room: Room, operation: 'policy' | 'move') => {
    const permissions = rooms[room]!.permissionsFor(bot);
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
      await rooms[room]!.permissionOverwrites.set(overwrites.map(row => ({ id: row.id, type: row.type,
        allow: BigInt(row.allow), deny: BigInt(row.deny) })), 'TCG practice public match room policy');
    },
    voiceChannel(memberId) { return guild.voiceStates.cache.get(memberId)?.channelId ?? null; },
    async move(memberId, room) {
      const voice = guild.voiceStates.cache.get(memberId);
      if (!voice?.channelId) return;
      await voice.setChannel(rooms[room]!, 'TCG practice match placement');
    },
    async warnOrganizer(message) {
      const notice = visualThumbnail('notice');
      await (typeof control === 'function' ? control() : control).send({ content: `<@${adminId}>`, embeds: [{ description: message,
        color: 0xf59e0b, thumbnail: notice }],
        files: [visualFile(filenameFromThumbnail(notice)!)!],
        allowedMentions: { parse: [], users: [adminId] } });
    }
  };
}

export function assertPublicMatchRoomTargets(config: PrivateDiscordConfig,
  rooms: ConfiguredRooms<{ id: string; name: string; guildId: string; type: ChannelType }>,
  afkChannelId: string | null): void {
  if (!config.publicMatchRooms) return;
  if (!config.matchChannels || rooms.M1.id === rooms.M2.id ||
      (['M1', 'M2'] as const).some(room => rooms[room]!.id !== config.matchChannels?.[room] ||
        rooms[room]!.type !== ChannelType.GuildVoice || rooms[room]!.guildId !== config.guildId ||
        rooms[room]!.id === afkChannelId || !rooms[room]!.name.startsWith('TCG Match ')))
    throw new RuleError('Public match rooms require two distinct dedicated TCG Match voice channels outside AFK in the configured guild.');
}

const JUDGE_MODAL_ID = /^judge:([1-9]\d{14,21}):(p1:.*)$/;
const JUDGE_CATEGORY_FIELD = 'category';
const JUDGE_DESCRIPTION_FIELD = 'description';

function judgeModal(buttonId: string, requesterId: string) {
  const categories = new StringSelectMenuBuilder().setCustomId(JUDGE_CATEGORY_FIELD).setRequired(true)
    .addOptions(Object.entries(JUDGE_REQUEST_CATEGORIES).map(([value, label]) => ({ value, label })));
  const description = new TextInputBuilder().setCustomId(JUDGE_DESCRIPTION_FIELD)
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(MAX_JUDGE_REQUEST_LENGTH)
    .setPlaceholder('Tell the organizer what happened or what you need help with.');
  return new ModalBuilder().setCustomId(`judge:${requesterId}:${buttonId}`).setTitle('Request a judge')
    .addLabelComponents(new LabelBuilder().setLabel('Category').setStringSelectMenuComponent(categories),
      new LabelBuilder().setLabel('What happened?').setTextInputComponent(description));
}

export function adapt(interaction: Interaction): PrivateInteraction | null {
  if (!interaction.isButton() && !interaction.isChatInputCommand() && !interaction.isModalSubmit()) return null;
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
  if (interaction.isModalSubmit()) {
    const modal = JUDGE_MODAL_ID.exec(interaction.customId);
    if (!modal) return null;
    const requesterId = modal[1]!;
    const customId = modal[2]!;
    let category = '';
    let description = '';
    try {
      const values = interaction.fields.getStringSelectValues(JUDGE_CATEGORY_FIELD);
      if (values.length === 1) category = values[0] ?? '';
      description = interaction.fields.getTextInputValue(JUDGE_DESCRIPTION_FIELD);
    } catch { /* The controller responds with the field validation error. */ }
    return { ...base, kind: 'judgeRequest', customId, judgeRequest: { requesterId, category, description },
      async acknowledge() {
        if (interaction.isFromMessage()) await interaction.deferUpdate();
        else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      },
      async reply(message) {
        const saved = (message.startsWith('Saved: ') && !message.includes('pending')) || message.startsWith('No change: ');
        if (saved) {
          if (!interaction.isFromMessage()) await interaction.deleteReply();
        } else if (interaction.isFromMessage()) {
          const follow = await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
          expire(() => interaction.webhook.deleteMessage(follow.id));
        } else {
          await interaction.editReply({ content: message });
          expire(() => interaction.deleteReply());
        }
      }
    };
  }
  if (interaction.isButton()) return {
    ...base, kind: 'button', customId: interaction.customId, messageId: interaction.message.id,
    ...(interaction.customId.endsWith(':J') ? {
      async showJudgeRequest() { await interaction.showModal(judgeModal(interaction.customId, interaction.user.id)); }
    } : {}),
    async acknowledge() { await interaction.deferUpdate(); },
    async reply(message, attachment) {
      if ((message.startsWith('Saved: ') && !message.includes('pending')) || message.startsWith('No change: ')) return;
      const embed = noticeEmbed(message);
      const file = visualFile(filenameFromThumbnail(embed.thumbnail)!)!;
      const follow = await interaction.followUp({ embeds: [embed], files: attachment ? [file, attachment] : [file], flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] } });
      if (!message.startsWith('Signup roster (')) expire(() => interaction.webhook.deleteMessage(follow.id));
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

function readAdminSettings(): AdminConfig {
  // Refuses demo-only settings (TCG_ADMIN_LOGIN_TOKEN, TCG_ADMIN_DEV_ORIGIN) before anything starts.
  try { return readAdminConfig('discord'); }
  catch (error) { throw new RuleError(error instanceof Error ? error.message : 'Invalid admin console configuration.'); }
}

export async function runPrivateDiscord(config: PrivateDiscordConfig = readPrivateDiscordConfig(process.env, true),
  onReady?: (loginUrl: string | null) => void, manageSignals = true,
  initializeFresh = false, guided?: { launcher?: { instanceId: string; secret: string };
    browserAutoOpen?: boolean }): Promise<{ stop(): Promise<void> }> {
  const healthConfig = readConfig();
  const adminConfig = readAdminSettings();
  const artwork = defaultArtworkStore();
  setVisualArtworkStore(artwork);
  const runnerId = randomUUID();
  const client = privateDiscordClient(!!config.publicMatchRooms);
  let stopping = false;
  let shutdownTask: Promise<void> | undefined;
  let deletedCardRetry: ReturnType<typeof setInterval> | undefined;
  let signupSchedule: ReturnType<typeof setInterval> | undefined;
  let controller: PrivateDiscordController | undefined;
  let health: Awaited<ReturnType<typeof startServer>> | undefined;
  let lease: AdvisoryLease | undefined;
  let roomSync: MatchRoomReconciler | undefined;
  let admin: DiscordAdmin | undefined;
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
    if (deletedCardRetry) clearInterval(deletedCardRetry);
    if (signupSchedule) clearInterval(signupSchedule);
    shutdownTask = (async () => {
      const watchdog = setTimeout(() => { process.stderr.write('Private Discord shutdown deadline exceeded.\n'); process.exit(1); }, 5_000);
      try {
        // Ends console streams and polling first, so open streams cannot hold the watchdog budget.
        await admin?.close();
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
  if (manageSignals) {
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGBREAK', () => { void shutdown(); });
  }
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
    let listSignupChannels: DiscordAdminOptions['signupChannels'];
    let prepareSignupChannel: DiscordAdminOptions['prepareSignupChannel'];
    admin = createDiscordAdmin({ adminConfig, port: healthConfig.port, runnerId, artwork,
      publicMatchRooms: !!config.publicMatchRooms, lease,
      signupChannels: async () => {
        if (!listSignupChannels || !client.isReady()) throw new RuleError('Discord is not ready.');
        return listSignupChannels();
      },
      prepareSignupChannel: async id => {
        if (!prepareSignupChannel || !client.isReady()) throw new RuleError('Discord is not ready.');
        return prepareSignupChannel(id);
      },
      ...(guided ? { persistentSessions: true, ...(guided.launcher ? { launcher: guided.launcher } : {}) } : {}) });
    health = await startServer(healthConfig, admin ? { admin: admin.handler } : {});
    admin?.announce();
    ensureActive();
    await loginAndWaitReady(client, config.token!, () => stopping || lease?.isLost() === true);
    ensureActive();
    if (client.application?.id !== config.applicationId) throw new RuleError('Authenticated Discord application ID differs from configuration.');
    const channel = await client.channels.fetch(config.channelId);
    ensureActive();
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== config.guildId)
      throw new RuleError('Configured private Discord channel is not a text channel.');
    let signupChannel = channel;
    const guild = await client.guilds.fetch(config.guildId);
    admin?.attachClient(discordGateway(client), guildMembers(guild));
    const bot = await guild.members.fetchMe();
    const textPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];
    if (!channel.permissionsFor(bot)?.has(textPermissions))
      throw new RuleError('Private Discord control channel requires bot View Channel, Send Messages, Read Message History, Embed Links, and Attach Files permissions.');
    const supportsSignup = (target: TextChannel) => target.permissionsFor(bot)?.has(
      [...textPermissions, PermissionFlagsBits.PinMessages]) === true;
    listSignupChannels = async () => {
      const channels = await guild.channels.fetch();
      return [...channels.values()].flatMap(target => target?.type === ChannelType.GuildText &&
        (target.id === signupChannel.id || supportsSignup(target)) ? [{ id: target.id, name: target.name }] : [])
        .sort((left, right) => left.name.localeCompare(right.name));
    };
    let matches: ConfiguredRooms<VoiceChannel> | undefined;
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
      const roomTransport: RoomTransport = discordRoomTransport(guild, matches, bot, () => signupChannel, config.adminId);
      await roomTransport.assertPermissions('M1', 'policy');
      await roomTransport.assertPermissions('M2', 'policy');
      roomSync = new MatchRoomReconciler(config, bot.id, guild.afkChannelId, roomTransport,
        () => getSessionState(config), () => !stopping && !lease?.isLost());
      admin?.attachRooms(roomSync);
      await roomSync.trigger();
    }
    ensureActive();
    const botId = client.user!.id;
    prepareSignupChannel = async id => {
      const target = await client.channels.fetch(id, { force: true }).catch(() => null);
      if (target?.type !== ChannelType.GuildText || target.guildId !== config.guildId || !supportsSignup(target))
        throw new RuleError('Choose a text channel in this server where the bot can send, read and pin messages, attach files and embed links.');
      return () => {
        const previous = discordTransport(signupChannel, matches, botId);
        signupChannel = target;
        return async (messageId, slot) => { await previous.remove?.(messageId, slot); };
      };
    };
    const roundRooms = new Map<MatchId, VoiceChannel>();
    const provisionRound = async (session: SessionRow, state: EventState) => {
      const savedRooms = { ...session.identity_map.roundRooms };
      const players = resolvePlayers(session, state);
      if (!players) throw new RuleError('The checked-in player assignments are unavailable.');
      let discovered: Awaited<ReturnType<typeof guild.channels.fetch>> | undefined;
      for (const match of state.matches) {
        ensureActive();
        const savedId = savedRooms[match.id];
        const cached = roundRooms.get(match.id);
        if (savedId && cached?.id === savedId) continue;
        const saved = savedId ? await guild.channels.fetch(savedId).catch(error => {
          if ((error as { code?: number }).code === 10003) return null;
          throw error;
        }) : null;
        let voice = saved?.type === ChannelType.GuildVoice ? saved : config.matchChannels?.[match.id] ? matches?.[match.id] : undefined;
        const desired = roomPlan(config.guildId, botId, config.adminId, match.players.map(player => players[player]!));
        const permissionOverwrites = desired.map(overwrite => ({ ...overwrite, allow: BigInt(overwrite.allow), deny: BigInt(overwrite.deny) }));
        if (!voice) {
          const roomName = `TCG Match ${match.id} · ${config.applicationId}`;
          discovered ??= await guild.channels.fetch();
          const existing = discovered.find(room => room?.type === ChannelType.GuildVoice && room.name === roomName);
          if (existing?.type === ChannelType.GuildVoice) voice = existing;
          else {
            if (!bot.permissions.has(PermissionFlagsBits.ManageChannels))
              throw new RuleError(`The bot needs Manage Channels to create the ${match.id} voice room.`);
            voice = await guild.channels.create({ name: roomName, type: ChannelType.GuildVoice, permissionOverwrites });
          }
        }
        const current = [...voice.permissionOverwrites.cache.values()].map(overwrite => ({
          id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield.toString(), deny: overwrite.deny.bitfield.toString()
        }));
        if (!sameOverwrites(current, desired)) {
          await backupRoomOverwrites(config.guildId, voice.id, current);
          ensureActive();
          await voice.permissionOverwrites.set(permissionOverwrites);
        }
        if (voice.id !== savedId) await bindRoundRoom(config, state.id, match.id, voice.id);
        savedRooms[match.id] = voice.id;
        roundRooms.set(match.id, voice);
        if (matches && match.id !== 'M1' && match.id !== 'M2') matches[match.id] = voice;
      }
      config.roundRooms = savedRooms;
    };
    controller = new PrivateDiscordController(config, runnerId,
      discordTransport(() => signupChannel, matches, botId, slot =>
        config.roundRooms?.[slot] === roundRooms.get(slot)?.id ? roundRooms.get(slot) : undefined),
      undefined, undefined, undefined, undefined, undefined, undefined, () => !stopping && !lease?.isLost(),
      undefined, undefined, explicit => roomSync?.trigger(explicit) ?? Promise.resolve(), undefined, provisionRound);
    admin?.attachController(controller);
    await controller.start();
    if (config.mode === 'signup') {
      let checking = false;
      const runTournamentSchedule = async () => {
        if (checking || stopping || lease?.isLost() || !client.isReady() || !controller) return;
        checking = true;
        try {
          await controller.publishDueRound();
          if (!adminConfig.commandsEnabled) return;
          for (const due of await dueSignupDrafts(Date.now())) {
            if (stopping || lease?.isLost() || !client.isReady()) break;
            try {
              await controller.openSignup(due.eventId, due.activeId, async game => { await artwork.selectGame(game); },
                prepareSignupChannel, true);
              break;
            } catch { /* A failed channel or concurrent change can be retried on a later pass. */ }
          }
        } catch { /* Retry after database or schema recovery. */ }
        finally { checking = false; }
      };
      signupSchedule = setInterval(() => { void runTournamentSchedule(); }, 3_000);
      signupSchedule.unref();
      void runTournamentSchedule();
    }
    const cleanupDeletedCards = () => { if (client.isReady()) void controller?.retryDeletedCards().catch(() => {}); };
    cleanupDeletedCards();
    deletedCardRetry = setInterval(cleanupDeletedCards, 60_000);
    deletedCardRetry.unref();
    if (initializeFresh) {
      try { await registerPrivateCommand(config); }
      catch { process.stderr.write('Initial guild command registration is pending; use the existing registration command to retry.\n'); }
      try {
        const initial = await controller.refreshExplicit();
        if (initial.cards === 'pending' || initial.roomWarning)
          process.stderr.write('Initial practice panels or room setup are pending; review the dashboard and use Refresh.\n');
      } catch { process.stderr.write('Initial practice panels are pending; review the dashboard and use Refresh.\n'); }
    }
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
    const reconnect = () => { cleanupDeletedCards(); controller?.reconnect(); void roomSync?.trigger().catch(reportRoomFailure); };
    client.on('shardResume', reconnect);
    client.on('shardReady', reconnect);
    process.stdout.write(`Private Discord runtime ready; health on 127.0.0.1:${health.port}.\n`);
    if (onReady) onReady(guided?.launcher ?
      guided.browserAutoOpen === false ? null : admin?.handler.claimLauncherOpen?.() ?? null :
      admin?.handler.loginUrl() ?? null);
    return { stop: shutdown };
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
