// Strict request parsing for the members module (agent A). Throws OpsInputError (400) with safe messages.
import { ADMIN_TOOLS_LIMITS as L, MOD_CASE_KINDS, type MatchId, type ModActionRequestDto, type ModCaseKind } from '@tcg-live/core';
import { UUID } from '../../ops/http.js';
import { exactObject, fail, int, oneOf, reason, shapedObject, snowflake, text, uuidList } from '../validate.js';

const ACTIONS = ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'] as const;
const MATCH_ID = /^M[1-9]\d{0,3}$/;

function context(record: Record<string, unknown>) {
  const evidenceIds = record.evidenceIds === undefined ? [] : uuidList(record.evidenceIds, L.evidencePerCase, 'Evidence');
  const eventId = record.eventId === undefined || record.eventId === null ? null
    : typeof record.eventId === 'string' && UUID.test(record.eventId) ? record.eventId.toLowerCase() : fail('Event must be a tournament ID.');
  const matchId = record.matchId === undefined || record.matchId === null ? null
    : typeof record.matchId === 'string' && MATCH_ID.test(record.matchId) ? record.matchId as MatchId : fail('Match must look like M1.');
  if (matchId && !eventId) fail('A match needs its tournament.');
  return { evidenceIds, eventId, matchId };
}

/** POST /admin-tools/actions body. */
export function parseModAction(input: unknown): ModActionRequestDto {
  const base = ['userId', 'reason', 'action'];
  const optional = ['evidenceIds', 'eventId', 'matchId'];
  const peek = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).action : undefined;
  const action = oneOf(peek, ACTIONS, 'action');
  const extra = action === 'timeout' ? ['durationMs'] : action === 'ban' ? ['deleteMessageSeconds', 'durationMs'] : [];
  const record = shapedObject(input, [...base, ...extra], optional, 'Moderation action');
  const common = { userId: snowflake(record.userId, 'Member'), reason: reason(record.reason), ...context(record) };
  switch (action) {
    case 'timeout': {
      if (typeof record.durationMs !== 'number' || !Number.isSafeInteger(record.durationMs) || record.durationMs < L.timeoutMsMin
        || record.durationMs > L.discordTimeoutMsMax)
        fail("Timeout must be from 1 minute to 28 days (Discord's limit).");
      return { ...common, action, durationMs: record.durationMs as number };
    }
    case 'ban': {
      const deleteMessageSeconds = int(record.deleteMessageSeconds, 0, L.deleteMessageSecondsMax, 'Delete messages window (seconds)');
      if (record.durationMs !== null) fail('Temporary bans are not available yet. Ban permanently and unban later.');
      return { ...common, action, deleteMessageSeconds, durationMs: null };
    }
    default: return { ...common, action };
  }
}

/** PUT /admin-tools/cases/:n body: a new reason and/or evidence links. */
export function parseCasePatch(input: unknown): { reason?: string; evidenceIds?: string[] } {
  const record = shapedObject(input, [], ['reason', 'evidenceIds'], 'Case update');
  if (record.reason === undefined && record.evidenceIds === undefined) fail('Change the reason or the evidence.');
  return { ...(record.reason !== undefined ? { reason: reason(record.reason) } : {}),
    ...(record.evidenceIds !== undefined ? { evidenceIds: uuidList(record.evidenceIds, L.evidencePerCase, 'Evidence') } : {}) };
}

export function parseDeleteCase(input: unknown): string {
  return reason(exactObject(input, ['reason'], 'Case delete').reason);
}

export function parseNoteBody(value: unknown): string { return text(value, L.noteLength, 'Note', true); }

export function parseCaseKind(value: string | null): ModCaseKind | null {
  return value === null ? null : oneOf(value, MOD_CASE_KINDS, 'case kind');
}

/** The member search query: 1-100 readable characters. */
export function parseSearchQuery(value: string | null): string {
  return text(value ?? '', L.memberSearchQueryLength, 'Search');
}
