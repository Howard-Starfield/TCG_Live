// Moderation settings (tcg_moderation_settings): strict validation, defaults, optimistic version.
import type pg from 'pg';
import { DEFAULT_MODERATION_SETTINGS, KEYWORD_ACTIONS, KEYWORD_PRESETS, MODERATION_LIMITS as L, RECORDING_MODES,
  VOICE_MONITOR_SCOPES, VOICE_SENSITIVITIES, VOICE_SENSITIVITY_PRESETS, type CustomKeywordListDto, type KeywordAction,
  type ModerationSettingsBodyDto, type ModerationSettingsDto, type TextModerationSettingsDto,
  type VoiceLoudnessSettingsDto, type VoiceRoomPolicyDto, VOICE_ROOM_COVERAGES, VOICE_ROOM_PRIORITIES, VOICE_ROOM_RECORDINGS } from '@tcg-live/core';
import { transaction, withClient } from '../rehearsal/store.js';
import { requireEvidenceSchema } from '../evidence/schema.js';
import { insertOpsAudit, type OpsActor, type OpsAuditStore } from '../ops/audit.js';
import { OpsConflictError, OpsInputError } from '../ops/errors.js';
import { readableText, SNOWFLAKE } from '../ops/http.js';

/** The saved version moved on; `current` is the fresh state for the dashboard to show. */
export class ModerationVersionConflictError extends OpsConflictError {
  constructor(readonly current: ModerationSettingsDto) {
    super('Moderation settings changed in another tab. Review the current settings and save again.');
  }
}

/** Discord AutoMod rule IDs owned by the bot, keyed 'preset' or 'custom:<listId>'. */
export type AutoModRuleIds = Record<string, string>;

export interface ModerationSettingsStore {
  get(guildId: string): Promise<ModerationSettingsDto>;
  /** Rejects with ModerationVersionConflictError when expectedVersion is stale, OpsInputError when invalid. */
  put(guildId: string, expectedVersion: number, settings: unknown, actor: OpsActor): Promise<ModerationSettingsDto>;
  getAutoModRuleIds(guildId: string): Promise<AutoModRuleIds>;
  setAutoModRuleIds(guildId: string, ids: AutoModRuleIds): Promise<void>;
}

const fail = (message: string): never => { throw new OpsInputError(message); };

function object(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.some(key => !keys.includes(key) && !optional.includes(key))) fail(`${label} has unknown fields.`);
  if (keys.some(key => !Object.hasOwn(record, key))) fail(`${label} is missing fields.`);
  return record;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value as boolean;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${label} must be a whole number from ${min} to ${max}.`);
  return value as number;
}
function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(`Choose a valid ${label}.`);
  return value as T;
}
function snowflakeOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) fail(`${label} must be a Discord ID.`);
  return value as string;
}
function snowflakes(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list of at most ${max} Discord IDs.`);
  const items = value as unknown[];
  if (items.some(item => typeof item !== 'string' || !SNOWFLAKE.test(item))) fail(`${label} must contain Discord IDs only.`);
  return [...new Set(items as string[])];
}
/** Trimmed, case-insensitively de-duplicated words; AutoMod matching is case-insensitive. */
function words(value: unknown, max: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} can hold at most ${max} entries.`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') fail(`${label} must contain text only.`);
    const word = (item as string).trim();
    if (!word || [...word].length > maxLength || /[\p{Cc}\p{Cf}]/u.test(word)) fail(`${label} entries must be 1-${maxLength} readable characters.`);
    const key = word.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(word); }
  }
  return result;
}

function parseCustomList(value: unknown, index: number): CustomKeywordListDto {
  const label = `Custom list ${index + 1}`;
  const list = object(value, ['id', 'name', 'enabled', 'words', 'regexPatterns', 'allowList', 'action', 'timeoutSeconds'], label);
  if (typeof list.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(list.id)) fail(`${label} needs an ID of 1-32 lowercase letters, digits or dashes.`);
  if (typeof list.name !== 'string' || !list.name.trim() || !readableText(list.name.trim(), L.listNameLength))
    fail(`${label} needs a name of 1-${L.listNameLength} readable characters.`);
  const action = choice<KeywordAction>(list.action, KEYWORD_ACTIONS, `${label} action`);
  return {
    id: list.id as string, name: (list.name as string).trim(), enabled: boolean(list.enabled, `${label} enabled`),
    words: words(list.words, L.wordsPerList, L.wordLength, `${label} words`),
    regexPatterns: words(list.regexPatterns, L.regexPerList, L.regexLength, `${label} patterns`),
    allowList: words(list.allowList, L.allowListPerCustomList, L.wordLength, `${label} allow list`),
    action, timeoutSeconds: integer(list.timeoutSeconds, L.timeoutSecondsMin, L.timeoutSecondsMax, `${label} timeout`)
  };
}

function parseText(value: unknown): TextModerationSettingsDto {
  const text = object(value, ['enabled', 'preset', 'customLists', 'alertChannelId', 'blockMessage', 'exemptChannelIds', 'exemptRoleIds'], 'Text moderation');
  const preset = object(text.preset, ['enabled', 'presets', 'action', 'allowList'], 'Preset filter');
  const presets = object(preset.presets, KEYWORD_PRESETS, 'Preset lists');
  if (!Array.isArray(text.customLists) || text.customLists.length > L.customLists) fail(`At most ${L.customLists} custom word lists are allowed.`);
  const customLists = (text.customLists as unknown[]).map(parseCustomList);
  if (new Set(customLists.map(list => list.id)).size !== customLists.length) fail('Custom word list IDs must be unique.');
  if (typeof text.blockMessage !== 'string' || !readableText(text.blockMessage.trim(), L.blockMessageLength))
    fail(`Block message must be at most ${L.blockMessageLength} readable characters.`);
  return {
    enabled: boolean(text.enabled, 'Text moderation enabled'),
    preset: { enabled: boolean(preset.enabled, 'Preset filter enabled'),
      presets: { profanity: boolean(presets.profanity, 'Profanity'), sexual: boolean(presets.sexual, 'Sexual content'),
        slurs: boolean(presets.slurs, 'Slurs') },
      // Discord rejects a timeout on the preset rule.
      action: choice(preset.action, ['flag', 'block'] as const, 'preset filter action'),
      allowList: words(preset.allowList, L.allowListPreset, L.wordLength, 'Preset allow list') },
    customLists,
    alertChannelId: snowflakeOrNull(text.alertChannelId, 'Alert channel'),
    blockMessage: (text.blockMessage as string).trim(),
    exemptChannelIds: snowflakes(text.exemptChannelIds, L.exemptChannels, 'Exempt channels'),
    exemptRoleIds: snowflakes(text.exemptRoleIds, L.exemptRoles, 'Exempt roles')
  };
}

function parseVoice(value: unknown): VoiceLoudnessSettingsDto {
  const voice = object(value, ['enabled', 'scope', 'sensitivity', 'thresholdDbfs', 'sustainMs', 'cooldownMs', 'notifyDiscord', 'notifyChannelId'],
    'Voice monitoring', ['rooms']);
  const sensitivity = choice(voice.sensitivity, VOICE_SENSITIVITIES, 'sensitivity');
  const thresholdDbfs = integer(voice.thresholdDbfs, L.thresholdDbfsMin, L.thresholdDbfsMax, 'Loudness threshold (dBFS)');
  const sustainMs = integer(voice.sustainMs, L.sustainMsMin, L.sustainMsMax, 'Sustain time (ms)');
  // A named preset owns threshold and sustain; only 'custom' keeps the advanced values as sent.
  const tuned = sensitivity === 'custom' ? { thresholdDbfs, sustainMs } : { ...VOICE_SENSITIVITY_PRESETS[sensitivity] };
  return {
    enabled: boolean(voice.enabled, 'Voice monitoring enabled'), scope: choice(voice.scope, VOICE_MONITOR_SCOPES, 'monitoring scope'),
    sensitivity, ...tuned, cooldownMs: integer(voice.cooldownMs, L.cooldownMsMin, L.cooldownMsMax, 'Cooldown (ms)'),
    notifyDiscord: boolean(voice.notifyDiscord, 'Discord notice'), notifyChannelId: snowflakeOrNull(voice.notifyChannelId, 'Notice channel'),
    rooms: parseVoiceRooms(voice.rooms)
  };
}

const BOT_ID = /^(main|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** Per voice room policies keyed by voice channel ID; absent means {}. Pins to a missing bot fall back to auto at runtime. */
export function parseVoiceRooms(value: unknown): Record<string, VoiceRoomPolicyDto> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Room settings must be an object keyed by voice channel ID.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > L.voiceRoomPolicies) fail(`At most ${L.voiceRoomPolicies} voice rooms can have their own settings.`);
  const rooms: Record<string, VoiceRoomPolicyDto> = {};
  for (const [channelId, raw] of entries) {
    if (!SNOWFLAKE.test(channelId)) fail('Room settings must be keyed by voice channel ID.');
    const room = object(raw, ['coverage', 'recording', 'priority', 'pinnedBotId'], 'Room setting');
    if (room.pinnedBotId !== null && (typeof room.pinnedBotId !== 'string' || !BOT_ID.test(room.pinnedBotId)))
      fail('A room can only be pinned to the main bot or a helper bot.');
    rooms[channelId] = { coverage: choice(room.coverage, VOICE_ROOM_COVERAGES, 'room coverage'),
      recording: choice(room.recording, VOICE_ROOM_RECORDINGS, 'room recording'),
      priority: choice(room.priority, VOICE_ROOM_PRIORITIES, 'room priority'),
      pinnedBotId: room.pinnedBotId === null ? null : (room.pinnedBotId as string).toLowerCase() };
  }
  return rooms;
}

/** Strict parse of a full settings body. Throws OpsInputError with a message safe to show. */
export function parseModerationSettings(input: unknown): ModerationSettingsBodyDto {
  const value = object(input, ['text', 'voice', 'recording', 'retention', 'noticeText'], 'Moderation settings');
  const recording = object(value.recording, ['mode'], 'Recording', ['optOutUserIds']);
  const retention = object(value.retention, ['days'], 'Retention');
  if (value.noticeText !== null && (typeof value.noticeText !== 'string' || !value.noticeText.trim() ||
      !readableText(value.noticeText.trim(), L.noticeTextLength, true)))
    fail(`Notice text must be 1-${L.noticeTextLength} readable characters, or null for the default.`);
  return {
    text: parseText(value.text),
    voice: parseVoice(value.voice),
    recording: { mode: choice(recording.mode, RECORDING_MODES, 'recording mode'),
      optOutUserIds: recording.optOutUserIds === undefined ? [] : snowflakes(recording.optOutUserIds, L.recordingOptOuts, 'Recording opt-outs') },
    retention: { days: retention.days === null ? null : integer(retention.days, L.retentionDaysMin, L.retentionDaysMax, 'Retention days') },
    noticeText: value.noticeText === null ? null : (value.noticeText as string).trim()
  };
}

export function defaultModerationSettings(guildId: string): ModerationSettingsDto {
  return { guildId, version: 0, updatedAtMs: null, ...structuredClone(DEFAULT_MODERATION_SETTINGS) as ModerationSettingsBodyDto };
}

function guild(guildId: string): string {
  if (!SNOWFLAKE.test(guildId)) throw new OpsInputError('The Discord server is not configured.');
  return guildId;
}
function expected(version: unknown): number {
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new OpsInputError('expectedVersion must be a non-negative integer.');
  return version;
}
/** Which top-level sections differ; the audit records these, never the word lists. */
export function changedSections(before: ModerationSettingsBodyDto, after: ModerationSettingsBodyDto): string[] {
  return (['text', 'voice', 'recording', 'retention', 'noticeText'] as const)
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
/** Recording opt-out changes for the settings audit (Discord user IDs, never anything secret); {} when unchanged. */
export function optOutChanges(before: ModerationSettingsBodyDto, after: ModerationSettingsBodyDto): { optOut?: { added: string[]; removed: string[] } } {
  const was = new Set(before.recording.optOutUserIds ?? []);
  const now = new Set(after.recording.optOutUserIds ?? []);
  const added = [...now].filter(id => !was.has(id));
  const removed = [...was].filter(id => !now.has(id));
  return added.length || removed.length ? { optOut: { added: added.slice(0, 50), removed: removed.slice(0, 50) } } : {};
}
/** A saved row that no longer validates (for example after a downgrade) falls back to defaults until saved. */
function fromRow(guildId: string, row: { version: number; settings: unknown; updated_at_ms: string } | undefined): ModerationSettingsDto {
  if (!row) return defaultModerationSettings(guildId);
  let body: ModerationSettingsBodyDto;
  try { body = parseModerationSettings(row.settings); } catch { body = structuredClone(DEFAULT_MODERATION_SETTINGS) as ModerationSettingsBodyDto; }
  return { guildId, version: row.version, updatedAtMs: Number(row.updated_at_ms), ...body };
}

export function pgModerationSettingsStore(now: () => number = Date.now): ModerationSettingsStore {
  const read = async (client: pg.Client, guildId: string, lock: boolean) => {
    const result = await client.query<{ version: number; settings: unknown; updated_at_ms: string }>(
      `SELECT version, settings, updated_at_ms FROM public.tcg_moderation_settings WHERE guild_id = $1${lock ? ' FOR UPDATE' : ''}`, [guildId]);
    return fromRow(guildId, result.rows[0]);
  };
  return {
    async get(guildId) {
      guild(guildId);
      return withClient(async client => { await requireEvidenceSchema(client); return read(client, guildId, false); });
    },
    async put(guildId, expectedVersion, input, actor) {
      guild(guildId);
      const version = expected(expectedVersion);
      const body = parseModerationSettings(input);
      return withClient(async client => {
        await requireEvidenceSchema(client);
        // Serializes first saves for a guild that has no row yet.
        return transaction(client, async () => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_moderation_settings:' || $1))", [guildId]);
          const current = await read(client, guildId, true);
          if (current.version !== version) throw new ModerationVersionConflictError(current);
          const updatedAtMs = now();
          await client.query(`INSERT INTO public.tcg_moderation_settings (guild_id, version, settings, updated_at_ms, updated_by)
            VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (guild_id) DO UPDATE SET version = EXCLUDED.version,
            settings = EXCLUDED.settings, updated_at_ms = EXCLUDED.updated_at_ms, updated_by = EXCLUDED.updated_by`,
          [guildId, version + 1, JSON.stringify(body), updatedAtMs, actor.id]);
          await insertOpsAudit(client, { kind: 'moderation.settings', actor, guildId,
            payload: { version: version + 1, sections: changedSections(current, body), ...optOutChanges(current, body) }, occurredAtMs: updatedAtMs }, now);
          return { guildId, version: version + 1, updatedAtMs, ...body };
        });
      });
    },
    async getAutoModRuleIds(guildId) {
      guild(guildId);
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const result = await client.query<{ automod_rule_ids: AutoModRuleIds }>(
          'SELECT automod_rule_ids FROM public.tcg_moderation_settings WHERE guild_id = $1', [guildId]);
        return result.rows[0]?.automod_rule_ids ?? {};
      });
    },
    async setAutoModRuleIds(guildId, ids) {
      guild(guildId);
      if (Object.entries(ids).some(([key, id]) => !/^(preset|custom:[a-z0-9-]{1,32})$/.test(key) || !SNOWFLAKE.test(id)))
        throw new OpsInputError('Invalid AutoMod rule IDs.');
      await withClient(async client => {
        await requireEvidenceSchema(client);
        // Rule IDs belong to a saved settings row; with no row yet the defaults have nothing to sync.
        await client.query('UPDATE public.tcg_moderation_settings SET automod_rule_ids = $2::jsonb WHERE guild_id = $1',
          [guildId, JSON.stringify(ids)]);
      });
    }
  };
}

/** In-memory store for tests and the demo runtime; audits through the given ops audit store. */
export class MemoryModerationSettingsStore implements ModerationSettingsStore {
  private readonly saved = new Map<string, ModerationSettingsDto>();
  private readonly rules = new Map<string, AutoModRuleIds>();
  constructor(private readonly audit: OpsAuditStore, private readonly now: () => number = Date.now) {}
  async get(guildId: string) { guild(guildId); return structuredClone(this.saved.get(guildId) ?? defaultModerationSettings(guildId)); }
  async put(guildId: string, expectedVersion: number, input: unknown, actor: OpsActor) {
    guild(guildId);
    const version = expected(expectedVersion);
    const body = parseModerationSettings(input);
    const current = await this.get(guildId);
    if (current.version !== version) throw new ModerationVersionConflictError(current);
    const next: ModerationSettingsDto = { guildId, version: version + 1, updatedAtMs: this.now(), ...body };
    this.saved.set(guildId, next);
    await this.audit.append({ kind: 'moderation.settings', actor, guildId, payload: { version: next.version, sections: changedSections(current, body), ...optOutChanges(current, body) } });
    return structuredClone(next);
  }
  async getAutoModRuleIds(guildId: string) { guild(guildId); return { ...this.rules.get(guildId) }; }
  async setAutoModRuleIds(guildId: string, ids: AutoModRuleIds) { guild(guildId); this.rules.set(guildId, { ...ids }); }
}
