// Read-only admin queries. Each call opens one connection through the store's withClient (store.ts:71-91).
import type pg from 'pg';
import { RuleError, type EventState } from '../../rehearsal/domain.js';
import { verifyState, withClient } from '../../rehearsal/store.js';
import { requireDiscordSchema } from '../../discord/session.js';
import type { AdminAuditRow, AdminSessionRow, SummaryRow } from './mappers.js';

export interface AdminEventRecord { session: AdminSessionRow; state: EventState; audit: AdminAuditRow[] }

/** The reads DiscordAdminRuntime needs. Not-found results are null; failures reject. */
export interface AdminStore {
  /** Session-backed events, newest first. */
  listEvents(): Promise<SummaryRow[]>;
  activeEventId(): Promise<string | null>;
  /** Session, aggregate and full audit of one session-backed event, read from one consistent snapshot. */
  readEvent(eventId: string): Promise<AdminEventRecord | null>;
  /** Audit with sequence > afterSequence, ascending, at most `limit`; null when the event has no session. */
  readAudit(eventId: string, afterSequence: number, limit: number): Promise<AdminAuditRow[] | null>;
  /** The active event's version, for the safety-net poll. */
  readActiveVersion(): Promise<{ eventId: string; version: number } | null>;
}

const SESSION_COLUMNS = `s.event_id::text AS event_id, s.application_id, s.guild_id, s.channel_id, s.identity_map,
  s.status, s.checkin_message_id, s.m1_message_id, s.m2_message_id,
  s.created_at_ms::float8 AS created_at_ms, s.retired_at_ms::float8 AS retired_at_ms`;
const AUDIT_COLUMNS = `sequence, command_id, actor_id, action, outcome, occurred_at_ms::float8 AS occurred_at_ms,
  mode, principal_kind, principal_id`;

async function readOnly<T>(client: pg.Client, operation: () => Promise<T>): Promise<T> {
  // One snapshot for session, aggregate and audit, so a concurrent commit cannot split them.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* The original error decides the outcome. */ }
    throw error;
  }
}

export function pgAdminStore(): AdminStore {
  return {
    listEvents: () => withClient(async client => {
      await requireDiscordSchema(client);
      const result = await client.query<SummaryRow>(
        `SELECT s.event_id::text AS event_id, s.status, s.identity_map->>'kind' AS kind,
           e.state->>'schemaVersion' AS schema_version, s.created_at_ms::float8 AS created_at_ms,
           s.retired_at_ms::float8 AS retired_at_ms, e.version
         FROM public.tcg_rehearsal_sessions s JOIN public.tcg_rehearsal_events e ON e.id = s.event_id
         ORDER BY s.created_at_ms DESC, s.event_id DESC`);
      return result.rows;
    }),
    activeEventId: () => withClient(async client => {
      await requireDiscordSchema(client);
      const result = await client.query<{ event_id: string }>(
        "SELECT event_id::text AS event_id FROM public.tcg_rehearsal_sessions WHERE status = 'active'");
      return result.rows[0]?.event_id ?? null;
    }),
    readEvent: eventId => withClient(async client => {
      await requireDiscordSchema(client);
      return readOnly(client, async () => {
        const session = await client.query<AdminSessionRow>(
          `SELECT ${SESSION_COLUMNS} FROM public.tcg_rehearsal_sessions s WHERE s.event_id = $1`, [eventId]);
        if (!session.rows[0]) return null;
        // Retired events are read here directly, never through getSessionState (active-only, config-bound).
        const event = await client.query<{ state: EventState; version: number }>(
          'SELECT state, version FROM public.tcg_rehearsal_events WHERE id = $1', [eventId]);
        if (!event.rows[0]) throw new RuleError('Private Discord event is missing.');
        verifyState(event.rows[0].state, eventId, event.rows[0].version);
        const audit = await client.query<AdminAuditRow>(
          `SELECT ${AUDIT_COLUMNS} FROM public.tcg_rehearsal_audit WHERE event_id = $1 ORDER BY sequence`, [eventId]);
        return { session: session.rows[0], state: event.rows[0].state, audit: audit.rows };
      });
    }),
    readAudit: (eventId, afterSequence, limit) => withClient(async client => {
      await requireDiscordSchema(client);
      return readOnly(client, async () => {
        const session = await client.query('SELECT 1 FROM public.tcg_rehearsal_sessions WHERE event_id = $1', [eventId]);
        if (!session.rows[0]) return null;
        const audit = await client.query<AdminAuditRow>(
          `SELECT ${AUDIT_COLUMNS} FROM public.tcg_rehearsal_audit WHERE event_id = $1 AND sequence > $2
           ORDER BY sequence LIMIT $3`, [eventId, afterSequence, limit]);
        return audit.rows;
      });
    }),
    readActiveVersion: () => withClient(async client => {
      await requireDiscordSchema(client);
      const result = await client.query<{ event_id: string; version: number }>(
        `SELECT s.event_id::text AS event_id, e.version FROM public.tcg_rehearsal_sessions s
         JOIN public.tcg_rehearsal_events e ON e.id = s.event_id WHERE s.status = 'active'`);
      const row = result.rows[0];
      return row ? { eventId: row.event_id, version: Number(row.version) } : null;
    })
  };
}
