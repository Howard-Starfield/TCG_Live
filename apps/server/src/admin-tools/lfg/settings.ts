// LFG settings (tcg_lfg_settings, migration 014): one versioned document per guild. Strict validation,
// including every template against Discord's limits with the longest possible placeholder values.
import type pg from 'pg';
import { DEFAULT_LFG_SETTINGS, LFG_LIMITS as L, lfgWorstCaseLength, unknownLfgPlaceholders, type LfgChannelDto, type LfgFormDto,
  type LfgGameDto, type LfgMessagesDto, type LfgPanelDto, type LfgSettingsBodyDto, type LfgSettingsDto } from '@tcg-live/core';
import { insertOpsAudit, type OpsActor, type OpsAuditStore } from '../../ops/audit.js';
import { OpsConflictError, OpsInputError } from '../../ops/errors.js';
import { SNOWFLAKE } from '../../ops/http.js';
import { transaction, withClient } from '../../rehearsal/store.js';
import { requireLfgSchema } from '../schema.js';
import { bool, colorOrNull, emojiOrNull, exactObject, fail, int, snowflakeList, snowflakeOrNull, text } from '../validate.js';

export class LfgVersionConflictError extends OpsConflictError {
  constructor(readonly current: LfgSettingsDto) {
    super('LFG settings changed in another tab. Review the current settings and save again.');
  }
}

export interface LfgSettingsStore {
  get(guildId: string): Promise<LfgSettingsDto>;
  /** LfgVersionConflictError when expectedVersion is stale, OpsInputError when invalid. Audits 'lfg.settings'. */
  put(guildId: string, expectedVersion: number, settings: unknown, actor: OpsActor): Promise<LfgSettingsDto>;
}

const PANEL_KEYS = ['title', 'text', 'color', 'buttonLabel', 'emoji'] as const;
const FORM_KEYS = ['title', 'gameLabel', 'gamePlaceholder', 'formatLabel', 'formatPlaceholder', 'noteLabel', 'notePlaceholder',
  'voiceLabel', 'voicePlaceholder'] as const;
const MESSAGE_KEYS = ['cardTitle', 'cardBody', 'cardColor', 'joinLabel', 'leaveLabel', 'closeLabel', 'closedText', 'expiredText',
  'postedText', 'joinedText', 'leftText', 'pingText'] as const;
export const LFG_SETTINGS_KEYS = ['enabled', 'channels', 'games', 'formats', 'panel', 'form', 'messages', 'expiryMinutes',
  'cooldownMinutes', 'maxOpenPerUser', 'pingRoleId', 'pingCooldownMinutes', 'voiceChannelIds', 'playerListLimit'] as const;

function parsePanel(value: unknown, label: string): LfgPanelDto {
  const panel = exactObject(value, PANEL_KEYS, label);
  return { title: text(panel.title, L.panelTitleLength, `${label} title`), text: text(panel.text, L.panelTextLength, `${label} text`, true),
    color: colorOrNull(panel.color, `${label} colour`), buttonLabel: text(panel.buttonLabel, L.buttonLabelLength, `${label} button label`),
    emoji: emojiOrNull(panel.emoji, `${label} button emoji`) };
}

function parseForm(value: unknown): LfgFormDto {
  const form = exactObject(value, FORM_KEYS, 'Form');
  const out = {} as Record<(typeof FORM_KEYS)[number], string>;
  for (const key of FORM_KEYS) {
    const max = key === 'title' ? L.modalTitleLength : key.endsWith('Label') ? L.modalLabelLength : L.modalPlaceholderLength;
    out[key] = text(form[key], max, `Form ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
  }
  return out;
}

function name(value: unknown, max: number, label: string): string {
  const result = text(value, max, label);
  if (/[{}]/.test(result)) fail(`${label} may not contain { or }.`);
  return result;
}

function parseGames(value: unknown): LfgGameDto[] {
  if (!Array.isArray(value) || value.length > L.games) fail(`Games must be a list of at most ${L.games}.`);
  const games = (value as unknown[]).map((item, index) => {
    const game = exactObject(item, ['name', 'emoji', 'pingRoleId'], `Game ${index + 1}`);
    return { name: name(game.name, L.gameNameLength, `Game ${index + 1} name`), emoji: emojiOrNull(game.emoji, `Game ${index + 1} emoji`),
      pingRoleId: snowflakeOrNull(game.pingRoleId, `Game ${index + 1} ping role`) };
  });
  const names = games.map(game => game.name.toLowerCase());
  if (new Set(names).size !== names.length) fail('Each game can be listed once.');
  return games;
}

function parseFormats(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > L.formats) fail(`Formats must be a list of at most ${L.formats}.`);
  const formats = (value as unknown[]).map((item, index) => name(item, L.formatLength, `Format ${index + 1}`));
  if (new Set(formats.map(item => item.toLowerCase())).size !== formats.length) fail('Each format can be listed once.');
  return formats;
}

function parseChannel(value: unknown, index: number, games: readonly LfgGameDto[]): LfgChannelDto {
  const label = `LFG channel ${index + 1}`;
  const channel = exactObject(value, ['channelId', 'panel', 'games', 'pingRoleId', 'voiceChannelIds'], label);
  if (!Array.isArray(channel.games) || channel.games.length > L.games) fail(`${label} games must be a list of at most ${L.games}.`);
  const known = new Map(games.map(game => [game.name.toLowerCase(), game.name]));
  const allowed = [...new Set((channel.games as unknown[]).map(item => {
    if (typeof item !== 'string' || !known.has(item.trim().toLowerCase())) fail(`${label} allows a game that is not in the games list.`);
    return known.get((item as string).trim().toLowerCase())!;
  }))];
  return { channelId: snowflakeOrNull(channel.channelId, `${label} channel`) ?? fail(`Choose a channel for ${label}.`),
    panel: channel.panel === null ? null : parsePanel(channel.panel, `${label} panel`), games: allowed,
    pingRoleId: snowflakeOrNull(channel.pingRoleId, `${label} ping role`),
    voiceChannelIds: channel.voiceChannelIds === null ? null : snowflakeList(channel.voiceChannelIds, L.voiceChannels, `${label} voice rooms`) };
}

function template(value: unknown, max: number, label: string, settings: Pick<LfgSettingsBodyDto, 'games' | 'formats'>, limit: number,
  allowRole = false): string {
  const result = text(value, max, label, true);
  const unknown = unknownLfgPlaceholders(result, allowRole);
  if (unknown.length) fail(`${label} uses unknown placeholders: ${unknown.map(item => `{${item}}`).join(', ')}.`);
  const worst = lfgWorstCaseLength(result, settings);
  if (worst > limit) fail(`${label} can reach ${worst} characters with long names and notes; Discord allows ${limit}. Shorten it or use fewer placeholders.`);
  return result;
}

function parseMessages(value: unknown, lists: Pick<LfgSettingsBodyDto, 'games' | 'formats'>): LfgMessagesDto {
  const m = exactObject(value, MESSAGE_KEYS, 'Messages');
  const pingText = template(m.pingText, L.pingLength, 'Ping text', lists, L.contentLength, true);
  if (!pingText.includes('{role}')) fail('Ping text must contain {role}.');
  return {
    // Titles are a single line.
    cardTitle: (() => { const title = template(m.cardTitle, L.cardTitleLength, 'Card title', lists, L.cardTitleLength);
      if (/\n/.test(title)) fail('Card title must be one line.'); return title; })(),
    cardBody: template(m.cardBody, L.cardTemplateLength, 'Card text', lists, L.cardBodyLength),
    cardColor: colorOrNull(m.cardColor, 'Card colour'),
    joinLabel: text(m.joinLabel, L.buttonLabelLength, 'Join button label'),
    leaveLabel: text(m.leaveLabel, L.buttonLabelLength, 'Leave button label'),
    closeLabel: text(m.closeLabel, L.buttonLabelLength, 'Close button label'),
    closedText: template(m.closedText, L.cardTemplateLength, 'Closed text', lists, L.cardBodyLength),
    expiredText: template(m.expiredText, L.cardTemplateLength, 'Expired text', lists, L.cardBodyLength),
    postedText: template(m.postedText, L.replyLength, 'Posted reply', lists, L.contentLength),
    joinedText: template(m.joinedText, L.replyLength, 'Joined reply', lists, L.contentLength),
    leftText: template(m.leftText, L.replyLength, 'Left reply', lists, L.contentLength),
    pingText
  };
}

/** Strict parse of a full LFG settings body. Throws OpsInputError with a message safe to show. */
export function parseLfgSettings(input: unknown): LfgSettingsBodyDto {
  const value = exactObject(input, LFG_SETTINGS_KEYS, 'LFG settings');
  const games = parseGames(value.games);
  const formats = parseFormats(value.formats);
  if (!Array.isArray(value.channels) || value.channels.length > L.channels) fail(`Choose at most ${L.channels} LFG channels.`);
  const channels = (value.channels as unknown[]).map((item, index) => parseChannel(item, index, games));
  if (new Set(channels.map(channel => channel.channelId)).size !== channels.length) fail('Each LFG channel can be listed once.');
  const voiceChannelIds = snowflakeList(value.voiceChannelIds, L.voiceChannels, 'Voice rooms');
  const result: LfgSettingsBodyDto = {
    enabled: bool(value.enabled, 'LFG enabled'), channels, games, formats,
    panel: parsePanel(value.panel, 'Panel'), form: parseForm(value.form), messages: parseMessages(value.messages, { games, formats }),
    expiryMinutes: int(value.expiryMinutes, L.expiryMinutesMin, L.expiryMinutesMax, 'Expiry (minutes)'),
    cooldownMinutes: int(value.cooldownMinutes, 0, L.cooldownMinutesMax, 'Post cooldown (minutes)'),
    maxOpenPerUser: int(value.maxOpenPerUser, 0, L.maxOpenPerUserMax, 'Open posts per member'),
    pingRoleId: snowflakeOrNull(value.pingRoleId, 'Ping role'),
    pingCooldownMinutes: int(value.pingCooldownMinutes, 0, L.pingCooldownMinutesMax, 'Ping cooldown (minutes)'),
    voiceChannelIds,
    playerListLimit: int(value.playerListLimit, L.playerListLimitMin, L.playerListLimitMax, 'Names shown on the card')
  };
  if (result.enabled && !result.channels.length) fail('Choose at least one LFG channel before turning LFG on.');
  return result;
}

/** Channels the LFG feature may not use, given the tournament's channels and other bot messages there. */
export function lfgChannelProblem(settings: LfgSettingsBodyDto, blocked: { reserved: ReadonlySet<string>; voice: ReadonlySet<string>;
  stickies: ReadonlySet<string>; ticketPanel: string | null }): string | null {
  for (const channel of settings.channels) {
    if (blocked.reserved.has(channel.channelId)) return 'An LFG channel cannot be a tournament channel (signup channel or match room).';
    if (blocked.stickies.has(channel.channelId)) return 'An LFG channel already has a sticky message. Remove the sticky or pick another channel.';
    if (channel.channelId === blocked.ticketPanel) return 'An LFG channel cannot be the ticket support channel.';
  }
  const voice = [...settings.voiceChannelIds, ...settings.channels.flatMap(channel => channel.voiceChannelIds ?? [])];
  if (voice.some(id => blocked.reserved.has(id))) return 'Match rooms cannot be offered as LFG voice rooms.';
  if (voice.some(id => !blocked.voice.has(id))) return 'LFG voice rooms must be voice channels of this server.';
  return null;
}

export function defaultLfgSettings(guildId: string): LfgSettingsDto {
  return { guildId, version: 0, updatedAtMs: null, ...structuredClone(DEFAULT_LFG_SETTINGS) as LfgSettingsBodyDto };
}
export function lfgBody(settings: LfgSettingsDto): LfgSettingsBodyDto {
  const { guildId: _g, version: _v, updatedAtMs: _u, ...body } = settings;
  return body;
}

/** What changed, for the audit (names of top-level keys only, never template text). */
export function changedLfgKeys(before: LfgSettingsBodyDto, after: LfgSettingsBodyDto): string[] {
  return LFG_SETTINGS_KEYS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

const guild = (guildId: string) => { if (!SNOWFLAKE.test(guildId)) throw new OpsInputError('The Discord server is not configured.'); return guildId; };
const expected = (version: unknown) => {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new OpsInputError('expectedVersion must be a non-negative integer.');
  return version;
};
function fromRow(guildId: string, row: { version: number; settings: unknown; updated_at_ms: string } | undefined): LfgSettingsDto {
  if (!row) return defaultLfgSettings(guildId);
  let body: LfgSettingsBodyDto;
  try { body = parseLfgSettings(row.settings); } catch { body = { ...structuredClone(DEFAULT_LFG_SETTINGS) as LfgSettingsBodyDto, enabled: false }; }
  return { guildId, version: row.version, updatedAtMs: Number(row.updated_at_ms), ...body };
}

export function pgLfgSettingsStore(now: () => number = Date.now): LfgSettingsStore {
  const read = async (client: pg.Client, guildId: string, lock: boolean) => fromRow(guildId, (await client.query<{ version: number; settings: unknown; updated_at_ms: string }>(
    `SELECT version, settings, updated_at_ms FROM public.tcg_lfg_settings WHERE guild_id = $1${lock ? ' FOR UPDATE' : ''}`, [guildId])).rows[0]);
  return {
    async get(guildId) {
      guild(guildId);
      return withClient(async client => { await requireLfgSchema(client); return read(client, guildId, false); });
    },
    async put(guildId, expectedVersion, input, actor) {
      guild(guildId);
      const version = expected(expectedVersion);
      const body = parseLfgSettings(input);
      return withClient(async client => {
        await requireLfgSchema(client);
        return transaction(client, async () => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_lfg_settings:' || $1))", [guildId]);
          const current = await read(client, guildId, true);
          if (current.version !== version) throw new LfgVersionConflictError(current);
          const updatedAtMs = now();
          await client.query(`INSERT INTO public.tcg_lfg_settings (guild_id, version, settings, updated_at_ms, updated_by)
            VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (guild_id) DO UPDATE SET version = EXCLUDED.version,
            settings = EXCLUDED.settings, updated_at_ms = EXCLUDED.updated_at_ms, updated_by = EXCLUDED.updated_by`,
          [guildId, version + 1, JSON.stringify(body), updatedAtMs, actor.id]);
          await insertOpsAudit(client, { kind: 'lfg.settings', actor, guildId,
            payload: { version: version + 1, changed: changedLfgKeys(current, body), enabled: body.enabled, channels: body.channels.length },
            occurredAtMs: updatedAtMs }, now);
          return { guildId, version: version + 1, updatedAtMs, ...body };
        });
      });
    }
  };
}

export class MemoryLfgSettingsStore implements LfgSettingsStore {
  private readonly saved = new Map<string, LfgSettingsDto>();
  constructor(private readonly audit: OpsAuditStore, private readonly now: () => number = Date.now) {}
  async get(guildId: string) { guild(guildId); return structuredClone(this.saved.get(guildId) ?? defaultLfgSettings(guildId)); }
  async put(guildId: string, expectedVersion: number, input: unknown, actor: OpsActor) {
    guild(guildId);
    const version = expected(expectedVersion);
    const body = parseLfgSettings(input);
    const current = await this.get(guildId);
    if (current.version !== version) throw new LfgVersionConflictError(current);
    const next: LfgSettingsDto = { guildId, version: version + 1, updatedAtMs: this.now(), ...body };
    this.saved.set(guildId, next);
    await this.audit.append({ kind: 'lfg.settings', actor, guildId,
      payload: { version: next.version, changed: changedLfgKeys(current, body), enabled: body.enabled, channels: body.channels.length } });
    return structuredClone(next);
  }
}

/** Effective config of one LFG channel (its overrides on top of the globals). */
export interface LfgChannelConfig {
  channelId: string; panel: LfgPanelDto; games: LfgGameDto[]; voiceChannelIds: string[];
  /** Ping role for a game here, or null. */
  pingRoleFor(game: string): string | null;
}
export function lfgChannelConfig(settings: LfgSettingsBodyDto, channelId: string): LfgChannelConfig | null {
  const channel = settings.channels.find(item => item.channelId === channelId);
  if (!channel) return null;
  const games = channel.games.length ? settings.games.filter(game => channel.games.includes(game.name)) : settings.games;
  return { channelId, panel: channel.panel ?? settings.panel, games, voiceChannelIds: channel.voiceChannelIds ?? settings.voiceChannelIds,
    pingRoleFor: game => settings.games.find(item => item.name === game)?.pingRoleId ?? channel.pingRoleId ?? settings.pingRoleId };
}
