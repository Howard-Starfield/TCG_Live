// (D) logging logic, free of discord.js so it is fully testable: join/leave/role/nick log with the
// new-account flag, welcome and leave messages, auto-role, and the message edit/delete log with its bounded
// local store and retention purge. Every sub-feature acts only while it is enabled AND its privileged intent
// is 'on' in the running gateway; 'off' or 'missing' (refused by Discord) means do nothing.
import type { APIEmbed } from 'discord.js';
import type { LogEntryDto, LoggingSettingsDto, OpsAuditKind, PrivilegedIntentName, PrivilegedIntentState } from '@tcg-live/core';
import type { LoggingStore } from './store.js';
import { isNewAccount, renderLoggingTemplate, templateMentions } from './template.js';

export const DAY_MS = 86_400_000;
const COLOR = { join: 0x22c55e, leave: 0x64748b, flag: 0xf59e0b, update: 0x3b82f6, edit: 0x3b82f6, delete: 0xef4444 } as const;
const FIELD_MAX = 1024;
const BULK_POST_LINES = 10;

export interface LogPost { content?: string; embeds?: APIEmbed[]; allowedMentions: { parse: []; users?: string[] } }

export interface LoggingDeps {
  guildId: string;
  store: LoggingStore;
  settings(): Promise<LoggingSettingsDto>;
  intents(): Readonly<Record<PrivilegedIntentName, PrivilegedIntentState>>;
  /** Sends to a guild text channel; rejects when it cannot. */
  post(channelId: string, message: LogPost): Promise<void>;
  serverName(): Promise<string>;
  memberCount(): Promise<number | null>;
  /** Splits role IDs into ones the bot may assign and ones it may not (missing, managed, at or above the bot). */
  manageableRoles(roleIds: readonly string[]): Promise<{ ok: string[]; skipped: string[] }>;
  addRoles(userId: string, roleIds: readonly string[], reason: string): Promise<void>;
  audit(kind: OpsAuditKind, payload: Record<string, unknown>): Promise<unknown>;
  log(message: string): void;
  now(): number;
}

export interface JoinEvent { userId: string; username: string; bot: boolean; accountCreatedAtMs: number }
export interface LeaveEvent { userId: string; username: string; bot: boolean }
export interface MemberSnapshot { roleIds: readonly string[]; nick: string | null }
export interface MemberUpdateEvent { userId: string; before: MemberSnapshot | null; after: MemberSnapshot }
export interface MessageCreateEvent {
  guildId: string | null; messageId: string; channelId: string; authorId: string; bot: boolean; webhook: boolean;
  content: string; attachmentCount: number; createdAtMs: number;
}
export interface MessageUpdateEvent {
  guildId: string | null; messageId: string; channelId: string;
  /** Undefined when the update carries no content (embed unfurls). */
  content: string | undefined;
  attachmentCount: number | undefined;
  authorId: string | null; bot: boolean;
  /** Text from the gateway cache, used when no stored copy exists. */
  cachedBefore: string | null;
  editedAtMs: number;
}
export interface MessageDeleteEvent { guildId: string | null; channelId: string; messageIds: readonly string[]; bulk: boolean }

const clipField = (text: string | null) => !text ? '*(no text)*' : text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX - 1)}…` : text;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const ts = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;
const NONE = { parse: [] } as const satisfies LogPost['allowedMentions'];

export class LoggingProcessor {
  constructor(private readonly deps: LoggingDeps) {}

  private on(intent: PrivilegedIntentName): boolean { return this.deps.intents()[intent] === 'on'; }

  private async send(channelId: string | null, message: LogPost, what: string): Promise<boolean> {
    if (!channelId) return false;
    try { await this.deps.post(channelId, message); return true; }
    catch (error) { this.deps.log(`Logging: could not post the ${what} to channel ${channelId}: ${errorText(error)}`); return false; }
  }

  async memberJoined(event: JoinEvent): Promise<void> {
    if (!this.on('guildMembers')) return;
    const settings = await this.deps.settings();
    const now = this.deps.now();
    const { joinLeave, welcome, autoRole } = settings;
    if (joinLeave.enabled) {
      const newAccount = isNewAccount(event.accountCreatedAtMs, joinLeave.newAccountDays, now);
      await this.deps.store.recordMemberEvent(this.deps.guildId, { kind: 'join', userId: event.userId, occurredAtMs: now,
        detail: { newAccount, accountCreatedAtMs: event.accountCreatedAtMs } }).catch(error => this.deps.log(`Logging: join not stored: ${errorText(error)}`));
      await this.send(joinLeave.channelId, { allowedMentions: NONE, embeds: [{
        color: newAccount ? COLOR.flag : COLOR.join, title: newAccount ? 'Member joined (new account)' : 'Member joined',
        description: `<@${event.userId}> ${event.username}${event.bot ? ' (bot)' : ''}\nAccount created ${ts(event.accountCreatedAtMs)}`,
        footer: { text: `ID ${event.userId}` }, timestamp: new Date(now).toISOString() }] }, 'join log');
    }
    if (event.bot) {
      // Bots never get a welcome; auto-roles reach them only when "Skip bots" is turned off.
      if (autoRole.enabled && autoRole.skipBots === false && autoRole.roleIds.length) await this.assignAutoRoles(event.userId, autoRole.roleIds);
      return;
    }
    if (welcome.enabled && welcome.channelId) {
      const text = renderLoggingTemplate(welcome.message, { userId: event.userId, username: event.username,
        server: await this.deps.serverName(), memberCount: await this.deps.memberCount() });
      try { await this.deps.post(welcome.channelId, { content: text, allowedMentions: templateMentions('welcome', event.userId) }); }
      catch (error) {
        this.deps.log(`Logging: welcome message failed: ${errorText(error)}`);
        await this.deps.audit('welcome.failed', { userId: event.userId, channelId: welcome.channelId, error: errorText(error) }).catch(() => {});
      }
    }
    if (autoRole.enabled && autoRole.roleIds.length) await this.assignAutoRoles(event.userId, autoRole.roleIds);
  }

  private async assignAutoRoles(userId: string, roleIds: readonly string[]): Promise<void> {
    let ok: string[] = [];
    let skipped: string[] = [];
    let error: string | null = null;
    try {
      ({ ok, skipped } = await this.deps.manageableRoles(roleIds));
      if (ok.length) await this.deps.addRoles(userId, ok, 'Auto-role on join');
    } catch (cause) { error = errorText(cause); }
    if (!error && skipped.length === 0) return;
    const failed = error ? [...ok, ...skipped] : skipped;
    this.deps.log(`Logging: auto-role could not assign ${failed.length} role(s) to ${userId}${error ? `: ${error}` : ' (managed, missing, above the bot or a staff role)'}.`);
    await this.deps.audit('auto_role.failed', { userId, roleIds: failed, error: error ?? 'Role is missing, managed, above the bot or a staff role.' }).catch(() => {});
  }

  async memberLeft(event: LeaveEvent): Promise<void> {
    if (!this.on('guildMembers')) return;
    const { joinLeave, welcome } = await this.deps.settings();
    const now = this.deps.now();
    if (joinLeave.enabled) {
      await this.deps.store.recordMemberEvent(this.deps.guildId, { kind: 'leave', userId: event.userId, occurredAtMs: now, detail: {} })
        .catch(error => this.deps.log(`Logging: leave not stored: ${errorText(error)}`));
      await this.send(joinLeave.channelId, { allowedMentions: NONE, embeds: [{ color: COLOR.leave, title: 'Member left',
        description: `<@${event.userId}> ${event.username}${event.bot ? ' (bot)' : ''}`, footer: { text: `ID ${event.userId}` },
        timestamp: new Date(now).toISOString() }] }, 'leave log');
    }
    if (!event.bot && welcome.enabled && welcome.leaveMessage && welcome.channelId) {
      const text = renderLoggingTemplate(welcome.leaveMessage, { userId: event.userId, username: event.username,
        server: await this.deps.serverName(), memberCount: await this.deps.memberCount() });
      if (!await this.send(welcome.channelId, { content: text, allowedMentions: templateMentions('leave', event.userId) }, 'leave message'))
        await this.deps.audit('welcome.failed', { userId: event.userId, channelId: welcome.channelId, leave: true }).catch(() => {});
    }
  }

  async memberUpdated(event: MemberUpdateEvent): Promise<LogEntryDto[]> {
    if (!this.on('guildMembers') || !event.before) return [];
    const { joinLeave } = await this.deps.settings();
    if (!joinLeave.enabled || !joinLeave.memberUpdates) return [];
    const now = this.deps.now();
    const before = new Set(event.before.roleIds), after = new Set(event.after.roleIds);
    const addedRoleIds = [...after].filter(id => !before.has(id)), removedRoleIds = [...before].filter(id => !after.has(id));
    const written: LogEntryDto[] = [];
    const embeds: APIEmbed[] = [];
    if (addedRoleIds.length || removedRoleIds.length) {
      written.push(await this.deps.store.recordMemberEvent(this.deps.guildId, { kind: 'role', userId: event.userId, occurredAtMs: now,
        detail: { addedRoleIds, removedRoleIds } }));
      embeds.push({ color: COLOR.update, title: 'Roles changed', description: [`<@${event.userId}>`,
        ...addedRoleIds.map(id => `+ <@&${id}>`), ...removedRoleIds.map(id => `− <@&${id}>`)].join('\n').slice(0, 4000) });
    }
    if (event.before.nick !== event.after.nick) {
      written.push(await this.deps.store.recordMemberEvent(this.deps.guildId, { kind: 'nick', userId: event.userId, occurredAtMs: now,
        detail: { before: event.before.nick, after: event.after.nick } }));
      embeds.push({ color: COLOR.update, title: 'Nickname changed', description: `<@${event.userId}>`,
        fields: [{ name: 'Before', value: clipField(event.before.nick) }, { name: 'After', value: clipField(event.after.nick) }] });
    }
    if (embeds.length) await this.send(joinLeave.channelId, { allowedMentions: NONE, embeds }, 'member update log');
    return written;
  }

  /** Message log is active: enabled in settings and the Message Content intent granted. */
  private async messageLog(guildId: string | null, channelId: string): Promise<LoggingSettingsDto['messageLog'] | null> {
    // Never DMs or other guilds.
    if (guildId !== this.deps.guildId || !this.on('messageContent')) return null;
    const { messageLog } = await this.deps.settings();
    if (!messageLog.enabled || messageLog.ignoredChannelIds.includes(channelId) || channelId === messageLog.channelId) return null;
    return messageLog;
  }

  async messageCreated(event: MessageCreateEvent): Promise<boolean> {
    if (event.bot || event.webhook) return false;
    if (!event.content && event.attachmentCount === 0) return false;
    if (!await this.messageLog(event.guildId, event.channelId)) return false;
    await this.deps.store.storeMessage(this.deps.guildId, { messageId: event.messageId, channelId: event.channelId, authorId: event.authorId,
      content: event.content, attachmentCount: event.attachmentCount, createdAtMs: event.createdAtMs, editedAtMs: null });
    return true;
  }

  async messageUpdated(event: MessageUpdateEvent): Promise<LogEntryDto | null> {
    if (event.content === undefined || event.bot) return null;
    const messageLog = await this.messageLog(event.guildId, event.channelId);
    if (!messageLog) return null;
    const stored = await this.deps.store.getMessage(this.deps.guildId, event.messageId);
    const before = stored?.content ?? event.cachedBefore;
    if (before === event.content) return null;
    const authorId = stored?.authorId ?? event.authorId;
    const attachmentCount = event.attachmentCount ?? stored?.attachmentCount ?? 0;
    if (authorId) await this.deps.store.storeMessage(this.deps.guildId, { messageId: event.messageId, channelId: event.channelId, authorId,
      content: event.content, attachmentCount, createdAtMs: stored?.createdAtMs ?? event.editedAtMs, editedAtMs: event.editedAtMs });
    const entry = await this.deps.store.recordMessageEvent(this.deps.guildId, { kind: 'edit', channelId: event.channelId,
      messageId: event.messageId, authorId, before, after: event.content, attachmentCount, occurredAtMs: this.deps.now() });
    await this.send(messageLog.channelId, { allowedMentions: NONE, embeds: [{ color: COLOR.edit, title: 'Message edited',
      description: `${authorId ? `<@${authorId}> ` : ''}in <#${event.channelId}>`,
      fields: [{ name: 'Before', value: clipField(before) }, { name: 'After', value: clipField(event.content) }],
      footer: { text: `Message ${event.messageId}` } }] }, 'edit log');
    return entry;
  }

  /** Logs only messages with a stored copy (bot messages, ignored channels and older messages were never stored). */
  async messagesDeleted(event: MessageDeleteEvent): Promise<LogEntryDto[]> {
    const messageLog = await this.messageLog(event.guildId, event.channelId);
    if (!messageLog) return [];
    const taken = await this.deps.store.takeMessages(this.deps.guildId, event.messageIds);
    const now = this.deps.now();
    const entries: LogEntryDto[] = [];
    for (const message of taken.sort((a, b) => a.createdAtMs - b.createdAtMs)) {
      entries.push(await this.deps.store.recordMessageEvent(this.deps.guildId, { kind: 'delete', channelId: event.channelId,
        messageId: message.messageId, authorId: message.authorId, before: message.content, after: null,
        attachmentCount: message.attachmentCount, occurredAtMs: now }));
    }
    if (!entries.length) return entries;
    if (event.bulk) {
      const lines = taken.slice(0, BULK_POST_LINES).map(message => `<@${message.authorId}>: ${message.content.replace(/\s+/g, ' ').slice(0, 150) || '*(attachment)*'}`);
      if (taken.length > BULK_POST_LINES) lines.push(`…and ${taken.length - BULK_POST_LINES} more (see the dashboard).`);
      await this.send(messageLog.channelId, { allowedMentions: NONE, embeds: [{ color: COLOR.delete,
        title: `${taken.length} messages bulk deleted`, description: `in <#${event.channelId}>\n${lines.join('\n')}`.slice(0, 4000) }] }, 'bulk delete log');
    } else {
      const message = taken[0]!;
      await this.send(messageLog.channelId, { allowedMentions: NONE, embeds: [{ color: COLOR.delete, title: 'Message deleted',
        description: `<@${message.authorId}> in <#${event.channelId}>`,
        fields: [{ name: 'Content', value: clipField(message.content) },
          ...(message.attachmentCount ? [{ name: 'Attachments', value: String(message.attachmentCount) }] : [])],
        footer: { text: `Message ${message.messageId}` } }] }, 'delete log');
    }
    return entries;
  }

  /** Hourly retention: runs whether or not the log is enabled, so stored text never outlives retentionDays. */
  async purge(): Promise<{ storedMessages: number; loggedEntries: number }> {
    const { messageLog } = await this.deps.settings();
    const cutoff = this.deps.now() - messageLog.retentionDays * DAY_MS;
    const result = await this.deps.store.purgeMessagesBefore(this.deps.guildId, cutoff);
    if (result.storedMessages + result.loggedEntries > 0)
      await this.deps.audit('logging.retention', { reason: 'retention', retentionDays: messageLog.retentionDays, ...result }).catch(() => {});
    return result;
  }
}
