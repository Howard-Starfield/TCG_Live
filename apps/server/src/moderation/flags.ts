// Moderation flags (tcg_moderation_flags): AutoMod keyword hits and voice loudness spikes. Each append
// also writes its ops-audit row (automod.executed or voice.spike) in the same transaction.
import { KEYWORD_ACTIONS, MODERATION_FLAG_PAGE_LIMIT, MODERATION_FLAG_REVIEW_STATES, type KeywordFlagDetailDto, type ModerationFlagDto,
  type ModerationFlagPageDto, type ModerationFlagReviewState, type VolumeFlagDetailDto } from '@tcg-live/core';
import { transaction, withClient } from '../rehearsal/store.js';
import { EvidenceSchemaUnavailableError, requireEvidenceSchema } from '../evidence/schema.js';
import { insertOpsAudit, type OpsActor, type OpsAuditStore } from '../ops/audit.js';
import { OpsInputError, OpsNotFoundError } from '../ops/errors.js';
import { readableText, SNOWFLAKE, UUID } from '../ops/http.js';

interface FlagInputBase {
  guildId: string;
  channelId?: string | null;
  eventId?: string | null;
  matchId?: string | null;
  userId?: string | null;
  occurredAtMs?: number;
}
export type ModerationFlagInput =
  | FlagInputBase & { kind: 'keyword'; detail: KeywordFlagDetailDto }
  | FlagInputBase & { kind: 'volume'; detail: VolumeFlagDetailDto };
export interface FlagPageQuery { after?: number; limit?: number; eventId?: string | null; matchId?: string | null }

export interface ModerationFlagStore {
  append(input: ModerationFlagInput): Promise<ModerationFlagDto>;
  list(guildId: string, query?: FlagPageQuery): Promise<ModerationFlagPageDto>;
  /**
   * Sets (or with null clears) the admin's triage of one flag and audits moderation.flag.reviewed in the same
   * transaction. Optional so hand-built stores keep compiling; the route answers 501 without it.
   */
  review?(guildId: string, id: number, state: ModerationFlagReviewState | null, actor: OpsActor): Promise<ModerationFlagDto>;
}

/** Validates the `state` of a PATCH /moderation/flags/:id body. */
export function parseReviewState(value: unknown): ModerationFlagReviewState | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !(MODERATION_FLAG_REVIEW_STATES as readonly string[]).includes(value))
    throw new OpsInputError('state must be acknowledged, dismissed or null.');
  return value as ModerationFlagReviewState;
}
const flagNotFound = () => new OpsNotFoundError('That flag does not exist.');
function reviewAudit(flag: ModerationFlagDto, state: ModerationFlagReviewState | null, actor: OpsActor) {
  return { kind: 'moderation.flag.reviewed' as const, actor, guildId: flag.guildId, eventId: flag.eventId,
    payload: { flagId: flag.id, flagKind: flag.kind, state, matchId: flag.matchId, userId: flag.userId } };
}

/** Flags come from Discord or the voice runtime; the bot (or system) is the audit actor. */
const FLAG_ACTOR: OpsActor = { kind: 'bot', id: 'bot' };
const fail = (message: string): never => { throw new OpsInputError(message); };
const idOrNull = (value: string | null | undefined, pattern: RegExp, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (!pattern.test(value)) fail(`Invalid flag ${label}.`);
  return value;
};
const finite = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`Invalid flag ${label}.`);
  return Math.round((value as number) * 10) / 10;
};
const shortText = (value: unknown, max: number, label: string): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(`Invalid flag ${label}.`);
  // Truncate rather than refuse: Discord decides this content, not the admin.
  const clipped = [...(value as string).replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, max).join('');
  return clipped;
};

export type NormalizedFlag = ModerationFlagDto extends infer F ? F extends ModerationFlagDto ? Omit<F, 'id'> : never : never;

export function normalizeFlag(input: ModerationFlagInput, now: () => number): NormalizedFlag {
  if (!input || (input.kind !== 'keyword' && input.kind !== 'volume')) fail('Unknown flag kind.');
  if (typeof input.guildId !== 'string' || !SNOWFLAKE.test(input.guildId)) fail('Invalid flag guild.');
  const occurredAtMs = input.occurredAtMs ?? now();
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs <= 0) fail('Invalid flag time.');
  const base = {
    guildId: input.guildId, channelId: idOrNull(input.channelId, SNOWFLAKE, 'channel'),
    eventId: idOrNull(input.eventId, UUID, 'event')?.toLowerCase() ?? null,
    matchId: idOrNull(input.matchId, /^M[1-9]\d{0,3}$/, 'match') as ModerationFlagDto['matchId'],
    userId: idOrNull(input.userId, SNOWFLAKE, 'user'), occurredAtMs
  };
  if (input.kind === 'keyword') {
    const detail = input.detail;
    if (!detail || typeof detail !== 'object') fail('Invalid keyword flag detail.');
    if (typeof detail.ruleName !== 'string' || !readableText(detail.ruleName, 100)) fail('Invalid flag rule name.');
    if (!KEYWORD_ACTIONS.includes(detail.action)) fail('Invalid flag action.');
    return { ...base, kind: 'keyword', detail: {
      ruleId: idOrNull(detail.ruleId, SNOWFLAKE, 'rule'), ruleName: detail.ruleName, action: detail.action,
      matchedKeyword: shortText(detail.matchedKeyword, 60, 'keyword'), matchedContent: shortText(detail.matchedContent, 200, 'content') } };
  }
  const detail = input.detail;
  if (!detail || typeof detail !== 'object') fail('Invalid volume flag detail.');
  return { ...base, kind: 'volume', detail: {
    peakDbfs: finite(detail.peakDbfs, -200, 0, 'peak'), rmsDbfs: finite(detail.rmsDbfs, -200, 0, 'RMS'),
    sustainedMs: finite(detail.sustainedMs, 0, 3_600_000, 'duration'), thresholdDbfs: finite(detail.thresholdDbfs, -200, 0, 'threshold'),
    ...(detail.recordingOffsetMs === undefined || detail.recordingOffsetMs === null ? {} :
      { recordingOffsetMs: finite(detail.recordingOffsetMs, 0, 86_400_000, 'recording offset') }) } };
}

const FLAG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAG_MATCH = /^M[1-9]\d{0,3}$/;
function pageQuery(query: FlagPageQuery = {}): { after: number; limit: number; eventId: string | null; matchId: string | null } {
  const after = query.after ?? 0;
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(after) || after < 0) fail('after must be a non-negative integer.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MODERATION_FLAG_PAGE_LIMIT) fail(`limit must be 1-${MODERATION_FLAG_PAGE_LIMIT}.`);
  const eventId = query.eventId ?? null;
  const matchId = query.matchId ?? null;
  if (eventId !== null && (typeof eventId !== 'string' || !FLAG_UUID.test(eventId))) fail('Invalid event ID.');
  if (matchId !== null && (typeof matchId !== 'string' || !FLAG_MATCH.test(matchId))) fail('Invalid match ID.');
  return { after, limit, eventId: eventId?.toLowerCase() ?? null, matchId };
}
function auditFor(flag: NormalizedFlag, id: number) {
  return { kind: flag.kind === 'keyword' ? 'automod.executed' as const : 'voice.spike' as const, actor: FLAG_ACTOR,
    guildId: flag.guildId, eventId: flag.eventId, occurredAtMs: flag.occurredAtMs,
    payload: { flagId: id, channelId: flag.channelId, matchId: flag.matchId, userId: flag.userId } };
}

interface FlagRow { id: string; kind: 'keyword' | 'volume'; guild_id: string; channel_id: string | null; event_id: string | null;
  match_id: string | null; user_id: string | null; detail: never; occurred_at_ms: string;
  review_state?: string | null; reviewed_at_ms?: string | number | null; reviewed_by?: string | null }
function flag(row: FlagRow): ModerationFlagDto {
  const state = (MODERATION_FLAG_REVIEW_STATES as readonly string[]).includes(row.review_state ?? '') ? row.review_state as ModerationFlagReviewState : null;
  const review = state && row.reviewed_at_ms != null && row.reviewed_by ? { state, atMs: Number(row.reviewed_at_ms), by: row.reviewed_by } : null;
  return { id: Number(row.id), kind: row.kind, guildId: row.guild_id, channelId: row.channel_id, eventId: row.event_id,
    matchId: row.match_id as ModerationFlagDto['matchId'], userId: row.user_id, detail: row.detail, occurredAtMs: Number(row.occurred_at_ms), review };
}
const COLUMNS = 'id, kind, guild_id, channel_id, event_id::text AS event_id, match_id, user_id, detail, occurred_at_ms';
// Review columns are read through to_jsonb, so a database that has not re-run the evidence setup yet still lists flags.
const READ_COLUMNS = `f.id, f.kind, f.guild_id, f.channel_id, f.event_id::text AS event_id, f.match_id, f.user_id, f.detail, f.occurred_at_ms,
  to_jsonb(f) ->> 'review_state' AS review_state, to_jsonb(f) ->> 'reviewed_at_ms' AS reviewed_at_ms, to_jsonb(f) ->> 'reviewed_by' AS reviewed_by`;

export function pgModerationFlagStore(now: () => number = Date.now): ModerationFlagStore {
  return {
    async append(input) {
      const value = normalizeFlag(input, now);
      return withClient(async client => {
        await requireEvidenceSchema(client);
        return transaction(client, async () => {
          const result = await client.query<FlagRow>(
            `INSERT INTO public.tcg_moderation_flags (kind, guild_id, channel_id, event_id, match_id, user_id, detail, occurred_at_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING ${COLUMNS}`,
            [value.kind, value.guildId, value.channelId, value.eventId, value.matchId, value.userId, JSON.stringify(value.detail), value.occurredAtMs]);
          const saved = flag(result.rows[0]!);
          await insertOpsAudit(client, auditFor(value, saved.id), now);
          return saved;
        });
      });
    },
    async list(guildId, query) {
      if (!SNOWFLAKE.test(guildId)) fail('The Discord server is not configured.');
      const page = pageQuery(query);
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const result = await client.query<FlagRow>(
          `SELECT ${READ_COLUMNS} FROM public.tcg_moderation_flags f WHERE f.guild_id = $1 AND f.id > $2
             AND ($4::uuid IS NULL OR f.event_id = $4::uuid) AND ($5::text IS NULL OR f.match_id = $5::text) ORDER BY f.id LIMIT $3`,
          [guildId, page.after, page.limit, page.eventId, page.matchId]);
        const flags = result.rows.map(flag);
        return { flags, nextAfter: flags.at(-1)?.id ?? page.after };
      });
    },
    async review(guildId, id, state, actor) {
      if (!SNOWFLAKE.test(guildId)) fail('The Discord server is not configured.');
      if (!Number.isSafeInteger(id) || id < 1) throw flagNotFound();
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const columns = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'tcg_moderation_flags' AND column_name = 'review_state'`);
        if (columns.rows[0]?.n !== '1') throw new EvidenceSchemaUnavailableError(
          'Flag review needs the updated moderation storage. Restart with the launcher or run npm run db:evidence-setup -w @tcg-live/server.');
        return transaction(client, async () => {
          const at = now();
          const result = await client.query<FlagRow>(
            `UPDATE public.tcg_moderation_flags f SET review_state = $3, reviewed_at_ms = CASE WHEN $3::text IS NULL THEN NULL ELSE $4::bigint END,
               reviewed_by = CASE WHEN $3::text IS NULL THEN NULL ELSE $5::text END
             WHERE f.guild_id = $1 AND f.id = $2 RETURNING ${READ_COLUMNS}`, [guildId, id, state, at, actor.id]);
          const row = result.rows[0];
          if (!row) throw flagNotFound();
          const saved = flag(row);
          await insertOpsAudit(client, reviewAudit(saved, state, actor), now);
          return saved;
        });
      });
    }
  };
}

/** In-memory store for tests and the demo runtime. */
export class MemoryModerationFlagStore implements ModerationFlagStore {
  readonly flags: ModerationFlagDto[] = [];
  constructor(private readonly audit: OpsAuditStore, private readonly now: () => number = Date.now) {}
  async append(input: ModerationFlagInput): Promise<ModerationFlagDto> {
    const value = normalizeFlag(input, this.now);
    const saved = { id: this.flags.length + 1, ...value } as ModerationFlagDto;
    this.flags.push(saved);
    await this.audit.append(auditFor(value, saved.id));
    return structuredClone(saved);
  }
  async list(guildId: string, query?: FlagPageQuery): Promise<ModerationFlagPageDto> {
    if (!SNOWFLAKE.test(guildId)) fail('The Discord server is not configured.');
    const page = pageQuery(query);
    const flags = this.flags.filter(item => item.guildId === guildId && item.id > page.after &&
      (page.eventId === null || item.eventId === page.eventId) && (page.matchId === null || item.matchId === page.matchId))
      .slice(0, page.limit).map(item => structuredClone(item));
    return { flags, nextAfter: flags.at(-1)?.id ?? page.after };
  }
  async review(guildId: string, id: number, state: ModerationFlagReviewState | null, actor: OpsActor): Promise<ModerationFlagDto> {
    if (!SNOWFLAKE.test(guildId)) fail('The Discord server is not configured.');
    const item = this.flags.find(flag => flag.id === id && flag.guildId === guildId);
    if (!item) throw flagNotFound();
    const previous = item.review;
    item.review = state === null ? null : { state, atMs: this.now(), by: actor.id };
    try { await this.audit.append(reviewAudit(item, state, actor)); }
    catch (error) { item.review = previous; throw error; }
    return structuredClone(item);
  }
}
