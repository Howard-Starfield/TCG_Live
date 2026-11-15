// Admin tools settings (tcg_admin_tools_settings): one versioned document per guild with the cases,
// tickets and logging sections. Strict validation, defaults, optimistic version, audited saves.
import type pg from 'pg';
import { ADMIN_TOOLS_LIMITS as L, ADMIN_TOOLS_SETTINGS_SECTIONS, DEFAULT_ADMIN_TOOLS_SETTINGS, type AdminToolsSettingsBodyDto,
  type AdminToolsSettingsDto, type CaseSettingsDto, type LoggingSettingsDto, type TicketSettingsDto } from '@tcg-live/core';
import { insertOpsAudit, type OpsActor, type OpsAuditStore } from '../ops/audit.js';
import { OpsConflictError, OpsInputError } from '../ops/errors.js';
import { SNOWFLAKE } from '../ops/http.js';
import { transaction, withClient } from '../rehearsal/store.js';
import { requireAdminToolsSchema } from './schema.js';
import { bool, colorOrNull, emojiOrNull, exactObject, fail, int, shapedObject, snowflakeList, snowflakeOrNull, text,
  textOrNull } from './validate.js';

/** The saved version moved on; `current` is the fresh state for the dashboard to show. */
export class AdminToolsVersionConflictError extends OpsConflictError {
  constructor(readonly current: AdminToolsSettingsDto) {
    super('Admin tools settings changed in another tab. Review the current settings and save again.');
  }
}

export interface AdminToolsSettingsStore {
  get(guildId: string): Promise<AdminToolsSettingsDto>;
  /** Rejects with AdminToolsVersionConflictError when expectedVersion is stale, OpsInputError when invalid. */
  put(guildId: string, expectedVersion: number, settings: unknown, actor: OpsActor): Promise<AdminToolsSettingsDto>;
}

/** Most tournament staff roles one server may configure. */
export const MAX_TOURNAMENT_STAFF_ROLES = 10;

function parseCases(value: unknown): CaseSettingsDto {
  const cases = shapedObject(value, ['dmMembers', 'logChannelId'], ['staffRoleIds'], 'Case settings');
  return { dmMembers: bool(cases.dmMembers, 'DM members'), logChannelId: snowflakeOrNull(cases.logChannelId, 'Case log channel'),
    // Optional and additive: absent stays absent, so older documents round-trip unchanged.
    ...(cases.staffRoleIds !== undefined
      ? { staffRoleIds: snowflakeList(cases.staffRoleIds, MAX_TOURNAMENT_STAFF_ROLES, 'Tournament staff roles') } : {}) };
}

function parseTickets(value: unknown): TicketSettingsDto {
  const tickets = exactObject(value, ['enabled', 'supportChannelId', 'categoryId', 'staffRoleIds', 'panel', 'namingPattern',
    'maxOpenPerUser', 'transcriptRetentionDays'], 'Ticket settings');
  const panel = exactObject(tickets.panel, ['title', 'text', 'emoji', 'buttonLabel', 'color'], 'Ticket panel');
  const namingPattern = text(tickets.namingPattern, L.ticketNamingPatternLength, 'Ticket name pattern');
  if (!/^[a-z0-9{}_-]+$/.test(namingPattern) || !namingPattern.includes('{n}'))
    fail('Ticket name pattern may use lowercase letters, digits, - and _, {name}, and must include {n}.');
  if (tickets.maxOpenPerUser !== 1) fail('Each member can have one open ticket.');
  const result: TicketSettingsDto = {
    enabled: bool(tickets.enabled, 'Tickets enabled'),
    supportChannelId: snowflakeOrNull(tickets.supportChannelId, 'Support channel'),
    categoryId: snowflakeOrNull(tickets.categoryId, 'Ticket category'),
    staffRoleIds: snowflakeList(tickets.staffRoleIds, L.ticketStaffRoles, 'Staff roles'),
    panel: {
      title: text(panel.title, L.ticketPanelTitleLength, 'Panel title'),
      text: text(panel.text, L.ticketPanelTextLength, 'Panel text', true),
      emoji: emojiOrNull(panel.emoji, 'Panel emoji'),
      buttonLabel: text(panel.buttonLabel, L.ticketButtonLabelLength, 'Button label'),
      color: colorOrNull(panel.color, 'Panel colour')
    },
    namingPattern,
    maxOpenPerUser: 1,
    transcriptRetentionDays: tickets.transcriptRetentionDays === null ? null
      : int(tickets.transcriptRetentionDays, L.retentionDaysMin, L.retentionDaysMax, 'Transcript retention days')
  };
  if (result.enabled && (!result.supportChannelId || !result.categoryId || result.staffRoleIds.length === 0))
    fail('Choose a support channel, a ticket category and at least one staff role before enabling tickets.');
  return result;
}

function parseLogging(value: unknown): LoggingSettingsDto {
  const logging = exactObject(value, ['joinLeave', 'welcome', 'autoRole', 'messageLog'], 'Logging settings');
  const joinLeave = exactObject(logging.joinLeave, ['enabled', 'channelId', 'newAccountDays', 'memberUpdates'], 'Join/leave log');
  const welcome = exactObject(logging.welcome, ['enabled', 'channelId', 'message', 'leaveMessage'], 'Welcome message');
  const autoRole = shapedObject(logging.autoRole, ['enabled', 'roleIds'], ['skipBots'], 'Auto-role');
  const messageLog = exactObject(logging.messageLog, ['enabled', 'channelId', 'retentionDays', 'ignoredChannelIds'], 'Message log');
  const result: LoggingSettingsDto = {
    joinLeave: { enabled: bool(joinLeave.enabled, 'Join/leave log enabled'), channelId: snowflakeOrNull(joinLeave.channelId, 'Join/leave log channel'),
      newAccountDays: int(joinLeave.newAccountDays, L.newAccountDaysMin, L.newAccountDaysMax, 'New account days'),
      memberUpdates: bool(joinLeave.memberUpdates, 'Role and nickname log') },
    welcome: { enabled: bool(welcome.enabled, 'Welcome enabled'), channelId: snowflakeOrNull(welcome.channelId, 'Welcome channel'),
      message: text(welcome.message, L.welcomeMessageLength, 'Welcome message', true),
      leaveMessage: textOrNull(welcome.leaveMessage, L.welcomeMessageLength, 'Leave message', true) },
    autoRole: { enabled: bool(autoRole.enabled, 'Auto-role enabled'), roleIds: snowflakeList(autoRole.roleIds, L.autoRoles, 'Auto-roles'),
      ...(autoRole.skipBots === undefined ? {} : { skipBots: bool(autoRole.skipBots, 'Skip bots') }) },
    messageLog: { enabled: bool(messageLog.enabled, 'Message log enabled'), channelId: snowflakeOrNull(messageLog.channelId, 'Message log channel'),
      retentionDays: int(messageLog.retentionDays, L.retentionDaysMin, L.retentionDaysMax, 'Message log retention days'),
      ignoredChannelIds: snowflakeList(messageLog.ignoredChannelIds, L.ignoredChannels, 'Ignored channels') }
  };
  if (result.joinLeave.enabled && !result.joinLeave.channelId) fail('Choose a channel for the join/leave log.');
  if (result.welcome.enabled && !result.welcome.channelId) fail('Choose a channel for welcome messages.');
  if (result.autoRole.enabled && result.autoRole.roleIds.length === 0) fail('Choose at least one auto-role.');
  return result;
}

/** Strict parse of a full settings body. Throws OpsInputError with a message safe to show. */
export function parseAdminToolsSettings(input: unknown): AdminToolsSettingsBodyDto {
  const value = exactObject(input, ADMIN_TOOLS_SETTINGS_SECTIONS, 'Admin tools settings');
  return { cases: parseCases(value.cases), tickets: parseTickets(value.tickets), logging: parseLogging(value.logging) };
}

/**
 * Channels a setting may not point at because the tournament owns them (signup/control channel with its
 * card sticky, match rooms). Returns a message for the first clash, or null.
 */
export function reservedChannelProblem(settings: AdminToolsSettingsBodyDto, reserved: ReadonlySet<string>): string | null {
  const support = settings.tickets.supportChannelId;
  if (support && reserved.has(support))
    return 'The ticket panel cannot share the tournament signup channel or a match room. Choose another support channel.';
  return null;
}

export function defaultAdminToolsSettings(guildId: string): AdminToolsSettingsDto {
  return { guildId, version: 0, updatedAtMs: null, ...structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto };
}

export function adminToolsBody(settings: AdminToolsSettingsDto): AdminToolsSettingsBodyDto {
  return { cases: settings.cases, tickets: settings.tickets, logging: settings.logging };
}

function guild(guildId: string): string {
  if (!SNOWFLAKE.test(guildId)) throw new OpsInputError('The Discord server is not configured.');
  return guildId;
}
function expected(version: unknown): number {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new OpsInputError('expectedVersion must be a non-negative integer.');
  return version;
}
/** Which sections differ; the audit records these, never message templates. */
export function changedAdminToolsSections(before: AdminToolsSettingsBodyDto, after: AdminToolsSettingsBodyDto): string[] {
  return ADMIN_TOOLS_SETTINGS_SECTIONS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
/** A saved row that no longer validates falls back to defaults until saved. */
function fromRow(guildId: string, row: { version: number; settings: unknown; updated_at_ms: string } | undefined): AdminToolsSettingsDto {
  if (!row) return defaultAdminToolsSettings(guildId);
  let body: AdminToolsSettingsBodyDto;
  try { body = parseAdminToolsSettings(row.settings); } catch { body = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto; }
  return { guildId, version: row.version, updatedAtMs: Number(row.updated_at_ms), ...body };
}

export function pgAdminToolsSettingsStore(now: () => number = Date.now): AdminToolsSettingsStore {
  const read = async (client: pg.Client, guildId: string, lock: boolean) => {
    const result = await client.query<{ version: number; settings: unknown; updated_at_ms: string }>(
      `SELECT version, settings, updated_at_ms FROM public.tcg_admin_tools_settings WHERE guild_id = $1${lock ? ' FOR UPDATE' : ''}`, [guildId]);
    return fromRow(guildId, result.rows[0]);
  };
  return {
    async get(guildId) {
      guild(guildId);
      return withClient(async client => { await requireAdminToolsSchema(client); return read(client, guildId, false); });
    },
    async put(guildId, expectedVersion, input, actor) {
      guild(guildId);
      const version = expected(expectedVersion);
      const body = parseAdminToolsSettings(input);
      return withClient(async client => {
        await requireAdminToolsSchema(client);
        return transaction(client, async () => {
          // Serializes first saves for a guild that has no row yet.
          await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_admin_tools_settings:' || $1))", [guildId]);
          const current = await read(client, guildId, true);
          if (current.version !== version) throw new AdminToolsVersionConflictError(current);
          const updatedAtMs = now();
          await client.query(`INSERT INTO public.tcg_admin_tools_settings (guild_id, version, settings, updated_at_ms, updated_by)
            VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (guild_id) DO UPDATE SET version = EXCLUDED.version,
            settings = EXCLUDED.settings, updated_at_ms = EXCLUDED.updated_at_ms, updated_by = EXCLUDED.updated_by`,
          [guildId, version + 1, JSON.stringify(body), updatedAtMs, actor.id]);
          await insertOpsAudit(client, { kind: 'admin_tools.settings', actor, guildId,
            payload: { version: version + 1, sections: changedAdminToolsSections(current, body) }, occurredAtMs: updatedAtMs }, now);
          return { guildId, version: version + 1, updatedAtMs, ...body };
        });
      });
    }
  };
}

/** In-memory store for tests and the demo runtime; audits through the given ops audit store. */
export class MemoryAdminToolsSettingsStore implements AdminToolsSettingsStore {
  private readonly saved = new Map<string, AdminToolsSettingsDto>();
  constructor(private readonly audit: OpsAuditStore, private readonly now: () => number = Date.now) {}
  async get(guildId: string) { guild(guildId); return structuredClone(this.saved.get(guildId) ?? defaultAdminToolsSettings(guildId)); }
  async put(guildId: string, expectedVersion: number, input: unknown, actor: OpsActor) {
    guild(guildId);
    const version = expected(expectedVersion);
    const body = parseAdminToolsSettings(input);
    const current = await this.get(guildId);
    if (current.version !== version) throw new AdminToolsVersionConflictError(current);
    const next: AdminToolsSettingsDto = { guildId, version: version + 1, updatedAtMs: this.now(), ...body };
    this.saved.set(guildId, next);
    await this.audit.append({ kind: 'admin_tools.settings', actor, guildId,
      payload: { version: next.version, sections: changedAdminToolsSections(current, body) } });
    return structuredClone(next);
  }
}
