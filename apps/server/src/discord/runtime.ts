import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChannelType, ChatInputCommandInteraction, Events, FileUploadBuilder, InteractionContextType, LabelBuilder, MessageFlags, MessageType,
  ModalBuilder, PermissionFlagsBits, Routes, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, type Client, type Guild, type GuildMember, type Interaction, type ModalSubmitInteraction,
  type SlashCommandSubcommandBuilder, type TextChannel, type VoiceChannel
} from 'discord.js';
import { EvidenceSubmitter } from '../evidence/discord-submit.js';
import { recordingOptOuts } from '../voice/optout.js';
import { onRecordingBadgeChange, recordingMatchIds, syncRecordingFromPool } from './recording-badge.js';
import { memberRoleIds } from './staff.js';
import { DEFAULT_MODERATION_NOTICE, JUDGE_REQUEST_CATEGORIES, MAX_JUDGE_REQUEST_LENGTH } from '@tcg-live/core';
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
import { baseIntents, privateDiscordClient, privateDiscordRest } from './sdk.js';
import { backupRoomOverwrites, MatchRoomReconciler, roomPlan, sameOverwrites, type Room, type RoomOverwrite, type RoomTransport } from './match-rooms.js';
import { filenameFromThumbnail, noticeEmbed, retainedVisual, setVisualArtworkStore, visualFile, visualThumbnail } from './visuals.js';
import { defaultArtworkStore } from '../artwork/store.js';
import { pgEvidenceStore } from '../evidence/store.js';
import { createEvidenceSeams } from '../evidence/seams.js';
import { discordAutoModSync } from '../moderation/automod.js';
import { pgModerationFlagStore } from '../moderation/flags.js';
import { pgModerationSettingsStore } from '../moderation/settings.js';
import { pgOpsAuditStore } from '../ops/audit.js';
import { VoiceBotTokenStore } from '../voice/tokens.js';
import { discordFeatures } from './feature-registry.js';
import { DiscordFeatureEvents, featureIntents, startDiscordFeatures, VoicePoolState, type DiscordFeatureContext,
  type MatchRoomInfo, type TournamentMembers } from './features.js';
import { ADMIN_COMMAND_NAME, adminCommandDefinition } from './admin-command.js';
import { FeatureInteractionRouter, isFeatureInteractionId } from './interactions.js';
import { loginWithIntentFallback, planIntents } from './intents.js';
import { HttpError } from '../admin/http/respond.js';
import { adminToolsBody, defaultAdminToolsSettings, pgAdminToolsSettingsStore } from '../admin-tools/settings.js';
import { AdminToolsRuntimeState } from '../admin-tools/status.js';
import { pgAnnouncementStore } from '../admin-tools/announcements/announcements.js';
import { pgStickyStore } from '../admin-tools/channels/sticky-store.js';
import { pgBulkRoleJobStore } from '../admin-tools/roles/bulk.js';
import { pgButtonRolePanelStore } from '../admin-tools/roles/panels.js';
import { lfgBody, pgLfgSettingsStore } from '../admin-tools/lfg/settings.js';
import { livePermissionMonitor, watchPermissionEvents } from '../permissions/live.js';
import { voiceRuntimeEnabled } from '../voice/feature.js';

function safeError(error: unknown): string {
  return error instanceof RuleError ? error.message : 'Private Discord operation failed.';
}

/** Per-key exponential backoff kept in memory, so a failing scheduled draft stops hammering Discord. */
export class RetryBackoff {
  private failures = new Map<string, { count: number; nextAt: number }>();
  constructor(private readonly baseMs = 3_000, private readonly capMs = 5 * 60_000,
    private readonly clock: () => number = Date.now) {}
  ready(key: string): boolean { return (this.failures.get(key)?.nextAt ?? 0) <= this.clock(); }
  failed(key: string): void {
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    this.failures.set(key, { count, nextAt: this.clock() + Math.min(this.capMs, this.baseMs * 2 ** (count - 1)) });
  }
  succeeded(key: string): void { this.failures.delete(key); }
}

/**
 * Command structure (next wave):
 *  - `/tcg-test`  — players, visible to everyone: `evidence` (evidence/discord-submit.ts) and `recording-optout`.
 *  - `/tcg-staff` — tournament staff (Manage Server by default; widen in Server Settings > Integrations, and
 *    staff roles are enforced in the bot): the former `/tcg-test` admin subcommands under the same names,
 *    plus `signup-add` and `checkin-for`.
 *  - `/tcg-admin` — admin tools (discord/admin-command.ts), including the moderation subcommands.
 */
export const PLAYER_COMMAND_NAME = 'tcg-test';
export const STAFF_COMMAND_NAME = 'tcg-staff';
/** The staff subcommands that lived under `/tcg-test` before; still accepted there from a stale client. */
export const STAFF_SUBCOMMANDS = ['publish', 'signup-close', 'signup-reopen', 'signup-remove', 'signup-add', 'checkin-for', 'refresh',
  'resolve', 'correct', 'judge-resume'] as const;

export const EVIDENCE_UNAVAILABLE = "Evidence submission isn't available right now. Please ask a staff member.";

/**
 * `/tcg-test evidence` is answered by the evidence-submit feature. When that feature is not running (no
 * features, or it failed to start), answer here so the member never sees "did not respond". True when answered.
 */
export function answerEvidenceUnavailable(interaction: Interaction, featureRunning: boolean): boolean {
  if (featureRunning || !interaction.isChatInputCommand() || interaction.commandName !== PLAYER_COMMAND_NAME ||
      interaction.options.getSubcommand(false) !== 'evidence') return false;
  void interaction.reply({ content: EVIDENCE_UNAVAILABLE, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
  return true;
}

/** `/tcg-test`: what players use. */
export function commandDefinition() {
  return new SlashCommandBuilder().setName(PLAYER_COMMAND_NAME).setDescription('TCG Live tournament: player tools')
    .setContexts(InteractionContextType.Guild)
    // Handled by the evidence-submit feature (evidence/discord-submit.ts), not the controller.
    .addSubcommand(sub => sub.setName('evidence').setDescription('Submit a clip or link for your match')
      .addStringOption(option => option.setName('match').setDescription('Match, for example M1').setRequired(true).setMaxLength(5))
      .addAttachmentOption(option => option.setName('file').setDescription('Video or audio file (up to 100 MB)'))
      .addStringOption(option => option.setName('link').setDescription('https:// link to the clip').setMaxLength(2048))
      .addStringOption(option => option.setName('note').setDescription('What the clip shows').setMaxLength(500)))
    .addSubcommand(sub => sub.setName('recording-optout').setDescription('Opt out of (or back into) match audio recording')
      .addStringOption(option => option.setName('choice').setDescription('Opt out, or opt back in').setRequired(true)
        .addChoices({ name: 'Opt out: never record me', value: 'out' }, { name: 'Opt back in', value: 'in' })))
    .toJSON();
}

/** `/tcg-staff`: tournament staff. Match and player options autocomplete from the live round; free text is validated. */
export function staffCommandDefinition() {
  const reason = (sub: SlashCommandSubcommandBuilder) => sub.addStringOption(option => option.setName('reason')
    .setDescription('Required reason (stored in the audit log)').setRequired(true).setMaxLength(500));
  const match = (sub: SlashCommandSubcommandBuilder) => sub.addStringOption(option => option.setName('match')
    .setDescription('Match, for example M3').setRequired(true).setAutocomplete(true).setMaxLength(6));
  const winner = (sub: SlashCommandSubcommandBuilder) => sub.addStringOption(option => option.setName('winner')
    .setDescription('Winning seat (or mention the player)').setRequired(true).setAutocomplete(true).setMaxLength(40));
  return new SlashCommandBuilder().setName(STAFF_COMMAND_NAME).setDescription('TCG Live tournament: staff tools')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild)
    .addSubcommand(sub => sub.setName('publish').setDescription('Publish the round'))
    .addSubcommand(sub => sub.setName('signup-close').setDescription('Close signup and assign seats'))
    .addSubcommand(sub => sub.setName('signup-reopen').setDescription('Reopen signup before publication'))
    .addSubcommand(sub => sub.setName('signup-remove').setDescription('Remove a signup member while open')
      .addStringOption(option => option.setName('member-id').setDescription('Discord member ID').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub.setName('signup-add').setDescription('Add a member to the open signup')
      .addUserOption(option => option.setName('member').setDescription('The member to add').setRequired(true)))
    .addSubcommand(sub => sub.setName('checkin-for').setDescription('Check a seated player in for them')
      .addStringOption(option => option.setName('player').setDescription('Seat (for example A or P3) or a mention')
        .setRequired(true).setAutocomplete(true).setMaxLength(40)))
    .addSubcommand(sub => sub.setName('refresh').setDescription('Create or repair the tournament cards'))
    .addSubcommand(sub => reason(winner(match(sub.setName('resolve').setDescription('Resolve a match')))))
    .addSubcommand(sub => reason(winner(match(sub.setName('correct').setDescription('Correct a finalized match')))))
    .addSubcommand(sub => reason(match(sub.setName('judge-resume').setDescription('Override a pause and resume play'))))
    .toJSON();
}

/** Every guild command this bot owns, in registration order. */
export function guildCommandDefinitions(): Array<[string, Record<string, unknown>]> {
  return [[PLAYER_COMMAND_NAME, commandDefinition() as unknown as Record<string, unknown>],
    [STAFF_COMMAND_NAME, staffCommandDefinition() as unknown as Record<string, unknown>],
    [ADMIN_COMMAND_NAME, adminCommandDefinition() as unknown as Record<string, unknown>]];
}

/**
 * The parts of a command definition Discord stores, in a stable form: absent, null and false values,
 * localizations and server-assigned fields are dropped, so a definition compares equal to what GET returns.
 */
export function comparableCommand(value: unknown): unknown {
  const SERVER_FIELDS = new Set(['id', 'application_id', 'guild_id', 'version', 'default_permission', 'nsfw', 'integration_types', 'type',
    'dm_permission', 'handler']);
  const walk = (item: unknown, top: boolean): unknown => {
    if (Array.isArray(item)) return item.map(entry => walk(entry, false));
    if (!item || typeof item !== 'object') return item;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) {
      const entry = (item as Record<string, unknown>)[key];
      if (entry === undefined || entry === null || entry === false || key.endsWith('_localizations') || key.endsWith('_localized')) continue;
      if (top && SERVER_FIELDS.has(key)) continue;
      if (Array.isArray(entry) && !entry.length && key === 'options') continue;
      out[key] = walk(entry, false);
    }
    return out;
  };
  return walk(value, true);
}

export interface CommandRegistration { created: string[]; updated: string[]; unchanged: string[] }

/**
 * Upserts `/tcg-test`, `/tcg-staff` and `/tcg-admin` in the guild. Idempotent: a command whose stored
 * definition already matches is not PATCHed. Runs on every start, so existing installs get new subcommands.
 */
export async function registerPrivateCommand(config: PrivateDiscordConfig,
  rest: Pick<ReturnType<typeof privateDiscordRest>, 'get' | 'post' | 'patch'> | null = null): Promise<CommandRegistration> {
  if (!rest && !config.token) throw new RuleError('TCG_DISCORD_TOKEN or DISCORD_BOT_TOKEN is required.');
  const client = rest ?? privateDiscordRest(config.token!);
  const route = Routes.applicationGuildCommands(config.applicationId, config.guildId);
  const commands = await client.get(route) as Array<{ id: string; name: string }>;
  const result: CommandRegistration = { created: [], updated: [], unchanged: [] };
  for (const [name, body] of guildCommandDefinitions()) {
    const existing = commands.find(command => command.name === name);
    if (!existing) { await client.post(route, { body }); result.created.push(name); }
    else if (JSON.stringify(comparableCommand(existing)) === JSON.stringify(comparableCommand(body))) result.unchanged.push(name);
    else {
      await client.patch(Routes.applicationGuildCommand(config.applicationId, config.guildId, existing.id), { body });
      result.updated.push(name);
    }
  }
  return result;
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

export const EVIDENCE_MODAL_ID = /^evd:([0-9a-f-]{36}):(M[1-9]\d{0,3})$/i;
const EVIDENCE_FILE_FIELD = 'file';
const EVIDENCE_LINK_FIELD = 'link';
const EVIDENCE_NOTE_FIELD = 'note';

/** The match-card evidence form: an optional file upload, an optional link and a note. */
export function evidenceModal(eventId: string, matchId: string) {
  const file = new FileUploadBuilder().setCustomId(EVIDENCE_FILE_FIELD).setRequired(false).setMinValues(0).setMaxValues(1);
  const link = new TextInputBuilder().setCustomId(EVIDENCE_LINK_FIELD).setStyle(TextInputStyle.Short).setRequired(false)
    .setMaxLength(2048).setPlaceholder('https://… (a clip on YouTube, Twitch, Drive…)');
  const note = new TextInputBuilder().setCustomId(EVIDENCE_NOTE_FIELD).setStyle(TextInputStyle.Paragraph).setRequired(false)
    .setMaxLength(500).setPlaceholder('What does it show? Game, turn, moment.');
  return new ModalBuilder().setCustomId(`evd:${eventId}:${matchId}`).setTitle(`Evidence for ${matchId}`)
    .addLabelComponents(new LabelBuilder().setLabel('Video or audio file (optional)').setFileUploadComponent(file),
      new LabelBuilder().setLabel('Link (optional)').setTextInputComponent(link),
      new LabelBuilder().setLabel('Note (optional)').setTextInputComponent(note));
}

/** Reads the evidence form; null when it is not one. */
export function evidenceFormInput(interaction: ModalSubmitInteraction) {
  const id = EVIDENCE_MODAL_ID.exec(interaction.customId);
  if (!id) return null;
  const text = (field: string) => { try { return interaction.fields.getTextInputValue(field).trim() || null; } catch { return null; } };
  let file: { url: string; size: number; name: string; contentType: string | null } | null = null;
  try {
    const uploaded = interaction.fields.getUploadedFiles(EVIDENCE_FILE_FIELD)?.first();
    if (uploaded) file = { url: uploaded.url, size: uploaded.size, name: uploaded.name, contentType: uploaded.contentType ?? null };
  } catch { /* No file. */ }
  return { eventId: id[1]!.toLowerCase(), matchId: id[2]!.toUpperCase(), link: text(EVIDENCE_LINK_FIELD), note: text(EVIDENCE_NOTE_FIELD), file };
}

export function adapt(interaction: Interaction): PrivateInteraction | null {
  if (!interaction.isButton() && !interaction.isChatInputCommand() && !interaction.isModalSubmit()) return null;
  // Feature-owned controls (discord/interactions.ts) never reach the controller.
  if ((interaction.isButton() || interaction.isModalSubmit()) && isFeatureInteractionId(interaction.customId)) return null;
  // `/tcg-staff`, plus the old `/tcg-test <staff subcommand>` from a client that has not refreshed its commands.
  if (interaction.isChatInputCommand() && !(interaction.commandName === STAFF_COMMAND_NAME ||
    (interaction.commandName === PLAYER_COMMAND_NAME &&
      (STAFF_SUBCOMMANDS as readonly string[]).includes(interaction.options.getSubcommand(false) ?? '')))) return null;
  const base = {
    id: interaction.id, applicationId: interaction.applicationId,
    guildId: interaction.guildId, channelId: interaction.channelId,
    userId: interaction.user.id, roleIds: memberRoleIds((interaction as { member?: unknown }).member)
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
    ...(interaction.customId.endsWith(':E') ? {
      async showEvidenceForm() {
        const [, eventId, slot] = interaction.customId.split(':');
        await interaction.showModal(evidenceModal(eventId!, slot!));
      }
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
    winner: command.options.getString('winner') ?? undefined,
    reason: command.options.getString('reason') ?? undefined,
    memberId: command.options.getString('member-id') ?? command.options.getUser?.('member')?.id ?? undefined,
    player: command.options.getString('player') ?? undefined };
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
  const features = discordFeatures();
  // Placeholder until login: the real client is created with the planned intents (see loginWithIntentFallback).
  let client: Client = privateDiscordClient(!!config.publicMatchRooms, featureIntents(features));
  const adminToolsSettings = pgAdminToolsSettingsStore();
  const adminToolsState = new AdminToolsRuntimeState(features, 'discord');
  const featureLog = (message: string) => { process.stderr.write(`${message.replace(/[^\x20-\x7e]/g, '?').slice(0, 300)}\n`); };
  const interactions = new FeatureInteractionRouter({ applicationId: config.applicationId, guildId: config.guildId }, featureLog);
  let signupChannelId: string | null = null;
  /** Channels the tournament owns: general stickies and ticket panels are refused there. */
  const reservedChannelIds = async (): Promise<string[]> => {
    const ids = new Set<string | undefined>([config.channelId, ...Object.values(config.matchChannels ?? {}), ...Object.values(config.roundRooms ?? {})]);
    if (signupChannelId) ids.add(signupChannelId);
    try {
      const current = await getSessionState(config);
      ids.add(current.session.channel_id);
      for (const room of Object.values(current.session.identity_map.roundRooms ?? {})) if (room) ids.add(room);
    } catch { /* No active tournament or database down: the configured channels still count. */ }
    return [...ids].filter((id): id is string => !!id);
  };
  // Evidence and moderation storage (migration 012). Routes answer 503 until the schema exists.
  const opsAudit = pgOpsAuditStore();
  const moderationSettings = pgModerationSettingsStore();
  const moderationFlags = pgModerationFlagStore();
  const evidence = pgEvidenceStore();
  const voiceBots = new VoiceBotTokenStore();
  const featureEvents = new DiscordFeatureEvents();
  const voicePool = new VoicePoolState();
  let featureHandle: Awaited<ReturnType<typeof startDiscordFeatures>> | undefined;
  // Bot permission check for the enabled features (GET /api/v1/admin-tools/permissions, status push, banner).
  const permissionMonitor = livePermissionMonitor({
    client: () => client, guildId: config.guildId, applicationId: config.applicationId,
    tournament: () => ({ signupChannelId: signupChannelId ?? config.channelId,
      matchChannelIds: Object.values(config.matchChannels ?? {}).filter((id): id is string => !!id),
      publicMatchRooms: !!config.publicMatchRooms, signupMode: config.mode === 'signup' }),
    moderation: () => moderationSettings.get(config.guildId),
    voiceRuntime: (() => { try { return voiceRuntimeEnabled(); } catch { return false; } })(),
    adminToolsSettings: async () => adminToolsBody(await adminToolsSettings.get(config.guildId).catch(() => defaultAdminToolsSettings(config.guildId))),
    intents: settings => {
      const status = adminToolsState.describe(settings);
      return status.runtime === 'running' ? { wanted: status.wantedIntents, state: status.privilegedIntents } : null;
    },
    stores: { stickies: pgStickyStore(), panels: pgButtonRolePanelStore(), bulk: pgBulkRoleJobStore(), announcements: pgAnnouncementStore() },
    lfgSettings: async () => lfgBody(await pgLfgSettingsStore().get(config.guildId))
  });
  let stopPermissionWatch: (() => void) | undefined;
  let stopRecordingWatch: (() => void) | undefined;
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
        stopPermissionWatch?.();
        stopRecordingWatch?.();
        permissionMonitor.close();
        await featureHandle?.stop();
        adminToolsState.recordStopped();
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
    // Closing the Windows console window sends SIGHUP; recordings need a clean shutdown.
    process.once('SIGHUP', () => { void shutdown(); });
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
      evidence: { store: evidence, audit: opsAudit, seams: createEvidenceSeams().seams },
      moderation: { settings: moderationSettings, flags: moderationFlags, audit: opsAudit, voiceBots, voicePool,
        guildId: () => config.guildId, mainBotUserId: () => client.user?.id ?? config.applicationId,
        onSettingsSaved: settings => featureEvents.emit({ type: 'moderationSettingsChanged', settings }),
        onVoiceBotsChanged: () => featureEvents.emit({ type: 'voiceBotsChanged' }),
        // Lazy: the client is replaced at login.
        automodSync: (guildId, settings) => discordAutoModSync(client, moderationSettings)(guildId, settings) },
      adminTools: { settings: adminToolsSettings, audit: opsAudit, storage: 'postgres', guildId: () => config.guildId,
        status: adminToolsState, reservedChannelIds,
        discord: {
          guild: async () => {
            if (!client.isReady()) throw new HttpError(503, 'unavailable', 'Discord is not connected. Try again when the bot is online.');
            return client.guilds.fetch(config.guildId);
          },
          botUserId: () => client.user?.id ?? null
        },
        onSettingsSaved: settings => featureEvents.emit({ type: 'adminToolsSettingsChanged', settings }),
        onChanged: (area, id) => featureEvents.emit({ type: 'adminToolsChanged', area, id }),
        permissions: permissionMonitor },
      ...(guided ? { persistentSessions: true, ...(guided.launcher ? { launcher: guided.launcher } : {}) } : {}) });
    health = await startServer(healthConfig, admin ? { admin: admin.handler } : {});
    admin?.announce();
    ensureActive();
    // Privileged intents are opt-in per feature and read from the saved admin-tools settings at login.
    const toolsSettings = await adminToolsSettings.get(config.guildId).catch(() => defaultAdminToolsSettings(config.guildId));
    const plan = planIntents(baseIntents(!!config.publicMatchRooms), features, adminToolsBody(toolsSettings));
    await client.destroy();
    const login = await loginWithIntentFallback({ plan, log: featureLog,
      create: intents => { client = privateDiscordClient(!!config.publicMatchRooms, intents); return client; },
      login: (candidate, refused) => loginAndWaitReady(candidate, config.token!, () => stopping || lease?.isLost() === true || refused()) });
    client = login.client;
    adminToolsState.recordLogin({ requested: [...login.plan.privileged, ...login.missing], missing: login.missing });
    ensureActive();
    if (client.application?.id !== config.applicationId) throw new RuleError('Authenticated Discord application ID differs from configuration.');
    const channel = await client.channels.fetch(config.channelId);
    ensureActive();
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== config.guildId)
      throw new RuleError('Configured private Discord channel is not a text channel.');
    let signupChannel = channel;
    signupChannelId = channel.id;
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
        signupChannelId = target.id;
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
        if (voice.id !== savedId) {
          await bindRoundRoom(config, state.id, match.id, voice.id);
          featureEvents.emit({ type: 'matchRoomAssigned', eventId: state.id, matchId: match.id, channelId: voice.id, occurredAtMs: Date.now() });
        }
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
    controller.onMatchEvent(event => featureEvents.emit(event));
    // A tournament may have opened in its own signup channel before the restart.
    await controller.start(async id => {
      ensureActive();
      (await prepareSignupChannel!(id))();
    });
    if (config.mode === 'signup') {
      let checking = false;
      const draftBackoff = new RetryBackoff();
      const runTournamentSchedule = async () => {
        if (checking || stopping || lease?.isLost() || !client.isReady() || !controller) return;
        checking = true;
        try {
          await controller.publishDueRound();
          if (!adminConfig.commandsEnabled) return;
          for (const due of await dueSignupDrafts(Date.now())) {
            if (stopping || lease?.isLost() || !client.isReady()) break;
            if (!draftBackoff.ready(due.eventId)) continue;
            try {
              await controller.openSignup(due.eventId, due.activeId, async game => { await artwork.selectGame(game); },
                prepareSignupChannel, true);
              draftBackoff.succeeded(due.eventId);
              break;
            } catch { draftBackoff.failed(due.eventId); /* Retried on a later pass, with backoff. */ }
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
    // Every start upserts the guild commands (unchanged ones are skipped), so existing installs get new subcommands.
    try {
      const registered = await registerPrivateCommand(config);
      if (registered.created.length || registered.updated.length)
        process.stdout.write(`Guild commands registered: ${[...registered.created, ...registered.updated].map(name => `/${name}`).join(', ')}.\n`);
    } catch { process.stderr.write('Guild command registration is pending; it is retried on the next start (or run the registration command).\n'); }
    // Tournament staff roles (admin-tools settings, Cases section) may run the staff commands.
    controller.setStaffRoles(async () => (await adminToolsSettings.get(config.guildId)).cases.staffRoleIds ?? []);
    // Recording badge on match cards and the recording policy line on the signup card.
    let recordingNotice: string | null = null;
    const applyRecordingPolicy = (settings: { recording: { mode: string }; noticeText: string | null }) => {
      const next = settings.recording.mode === 'off' ? null : settings.noticeText ?? DEFAULT_MODERATION_NOTICE;
      if (next === recordingNotice) return false;
      recordingNotice = next;
      return true;
    };
    try { applyRecordingPolicy(await moderationSettings.get(config.guildId)); } catch { /* Schema missing: no policy line. */ }
    controller.setCardOptions(() => ({ recording: recordingMatchIds(), recordingNotice }));
    const offRecordingBadge = onRecordingBadgeChange(() => controller?.reconnect());
    const offRecordingPolicy = featureEvents.on('moderationSettingsChanged', event => {
      if (applyRecordingPolicy(event.settings)) controller?.reconnect();
    });
    stopRecordingWatch = () => { offRecordingBadge(); offRecordingPolicy(); };
    if (initializeFresh) {
      try {
        const initial = await controller.refreshExplicit();
        if (initial.cards === 'pending' || initial.roomWarning)
          process.stderr.write('Initial practice panels or room setup are pending; review the dashboard and use Refresh.\n');
      } catch { process.stderr.write('Initial practice panels are pending; review the dashboard and use Refresh.\n'); }
    }
    ensureActive();
    const evidenceMatchRoom = async (matchId: MatchId) => {
      try {
        const current = await getSessionState(config);
        const match = current.state.matches.find(item => item.id === matchId);
        if (!match) return null;
        const players = resolvePlayers(current.session, current.state);
        return { eventId: current.state.id, matchId, voiceChannelId: current.session.identity_map.roundRooms?.[matchId] ?? null,
          playerIds: match.players.flatMap(seat => players?.[seat] ? [players[seat]] : []) };
      } catch { return null; }
    };
    const optOuts = recordingOptOuts({ settings: moderationSettings, audit: input => opsAudit.append(input), guildId: () => config.guildId,
      onChanged: () => { void moderationSettings.get(config.guildId).then(settings =>
        featureEvents.emit({ type: 'moderationSettingsChanged', settings })).catch(() => {}); } });
    /** Player tools, the evidence form and `/tcg-staff` autocomplete. True when handled here. */
    const handleRuntimeInteraction = (interaction: Interaction): boolean => {
      if (interaction.applicationId !== config.applicationId || interaction.guildId !== config.guildId) return false;
      if (answerEvidenceUnavailable(interaction, !!featureHandle?.started.includes('evidence-submit'))) return true;
      if (interaction.isAutocomplete() && interaction.commandName === STAFF_COMMAND_NAME) {
        const focused = interaction.options.getFocused(true);
        const nameOf = (id: string) => interaction.guild?.members.cache.get(id)?.displayName;
        void (async () => {
          const choices = await controller!.staffLevel(interaction.user.id, memberRoleIds(interaction.member))
            ? await controller!.autocomplete(interaction.options.getSubcommand(false) ?? '', focused.name, String(focused.value),
              interaction.options.getString('match'), nameOf) : [];
          await interaction.respond(choices);
        })().catch(() => {});
        return true;
      }
      if (interaction.isChatInputCommand() && interaction.commandName === PLAYER_COMMAND_NAME &&
          interaction.options.getSubcommand(false) === 'recording-optout') {
        const optedOut = interaction.options.getString('choice', true) === 'out';
        void (async () => {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          let content: string;
          try {
            const result = await optOuts.setRecordingOptOut(interaction.user.id, optedOut, { kind: 'player', id: interaction.user.id });
            content = optedOut ? `${result.changed ? 'Done' : 'You had already opted out'}: your voice is never recorded or loudness-checked in match rooms. Use this command again to opt back in.`
              : `${result.changed ? 'Done' : 'You were already opted in'}: your voice may be recorded in match rooms when the organizer's recording policy applies.`;
          } catch (error) { content = error instanceof RuleError ? error.message : 'Your recording choice could not be saved. Try again in a moment.'; }
          await interaction.editReply({ content, allowedMentions: { parse: [] } });
        })().catch(() => {});
        return true;
      }
      if (interaction.isModalSubmit() && EVIDENCE_MODAL_ID.test(interaction.customId)) {
        const input = evidenceFormInput(interaction)!;
        void (async () => {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const roles = memberRoleIds(interaction.member);
          let content = await controller!.evidenceRefusal(interaction.user.id, roles, input.eventId, input.matchId);
          if (!content) {
            // Staff submit as the organizer would (actor kind admin) under their own Discord ID.
            const staff = await controller!.staffLevel(interaction.user.id, roles);
            const submitter = new EvidenceSubmitter({ guildId: config.guildId, adminId: staff ? interaction.user.id : config.adminId,
              evidence, matchRoom: evidenceMatchRoom });
            content = await submitter.submit({ guildId: interaction.guildId, userId: interaction.user.id, matchId: input.matchId,
              attachment: input.file, link: input.link, note: input.note });
          }
          await interaction.editReply({ content, allowedMentions: { parse: [] } });
        })().catch(() => {});
        return true;
      }
      return false;
    };
    client.on('interactionCreate', interaction => { if (!stopping && !lease?.isLost()) {
      if (interactions.dispatch(interaction)) return;
      if (handleRuntimeInteraction(interaction)) return;
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
    if (features.length) {
      const isActive = () => !stopping && !lease?.isLost();
      const roomsOf = async (): Promise<MatchRoomInfo[]> => {
        let current: Awaited<ReturnType<typeof getSessionState>>;
        try { current = await getSessionState(config); } catch { return []; }
        const players = resolvePlayers(current.session, current.state);
        return current.state.matches.map(match => ({ eventId: current.state.id, matchId: match.id,
          voiceChannelId: current.session.identity_map.roundRooms?.[match.id] ?? config.matchChannels?.[match.id] ?? null,
          playerIds: match.players.flatMap(player => players?.[player] ? [players[player]] : []),
          phase: match.phase, judgeCall: match.judgeAttention || match.proposal?.decision === 'disputed' }));
      };
      const tournamentMembers = async (): Promise<TournamentMembers | null> => {
        try {
          const current = await getSessionState(config);
          const players = resolvePlayers(current.session, current.state) as Record<string, string> | null;
          const user = (seat: string) => players?.[seat];
          const ids = (list: Array<string | undefined>) => [...new Set(list.filter((id): id is string => !!id))];
          return { eventId: current.state.id,
            roster: ids(current.state.signup?.roster ?? Object.values(players ?? {})),
            checkedIn: ids(current.state.checkins.map(user)),
            players: ids(current.state.matches.flatMap(match => match.players.map(user))) };
        } catch { return null; }
      };
      const featureContext: DiscordFeatureContext = {
        client, guildId: config.guildId, adminId: config.adminId, isActive,
        moderationSettings: () => moderationSettings.get(config.guildId),
        appendFlag: input => moderationFlags.append(input),
        appendAudit: input => opsAudit.append(input),
        evidence, voiceBots,
        publishVoicePool: state => { voicePool.publish(state); syncRecordingFromPool(state); },
        on: (type, listener) => featureEvents.on(type, listener),
        matchRoom: async matchId => (await roomsOf()).find(room => room.matchId === matchId) ?? null,
        activeMatchRooms: roomsOf,
        log: featureLog,
        guild: () => client.guilds.fetch(config.guildId),
        adminToolsSettings: () => adminToolsSettings.get(config.guildId).catch(() => defaultAdminToolsSettings(config.guildId)),
        adminToolsStatus: async () => adminToolsState.describe(adminToolsBody(
          await adminToolsSettings.get(config.guildId).catch(() => defaultAdminToolsSettings(config.guildId)))),
        privilegedIntents: () => adminToolsState.privilegedIntents(),
        audit: (kind, payload = {}, actor = { kind: 'bot', id: 'bot' }) => opsAudit.append({ kind, actor, guildId: config.guildId, payload }),
        tournamentMembers,
        reservedChannelIds,
        interactions
      };
      featureHandle = await startDiscordFeatures(features, featureContext);
      adminToolsState.recordFeatures(featureHandle);
      ensureActive();
    }
    // Re-check permissions after role, channel, server and moderation-settings changes (debounced); admin-tools
    // settings and feature data schedule a re-check from the routes. The first check runs now.
    admin?.runtime.attachPermissions(permissionMonitor);
    const scheduleCheck = () => { if (!stopping && !lease?.isLost()) permissionMonitor.schedule(); };
    const unwatch = watchPermissionEvents(client, config.guildId, scheduleCheck);
    const offModeration = featureEvents.on('moderationSettingsChanged', scheduleCheck);
    const offVoiceBots = featureEvents.on('voiceBotsChanged', scheduleCheck);
    stopPermissionWatch = () => { unwatch(); offModeration(); offVoiceBots(); };
    void permissionMonitor.recheck();
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
