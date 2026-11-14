// Append-only operations audit (tcg_ops_audit): evidence, moderation and voice actions. Kept apart from
// tcg_rehearsal_audit so the domain replay and its mappers stay unchanged.
import type pg from 'pg';
import { OPS_AUDIT_KINDS, OPS_AUDIT_PAGE_LIMIT, type OpsActorKind, type OpsAuditEntryDto, type OpsAuditKind,
  type OpsAuditPageDto } from '@tcg-live/core';
import { withClient } from '../rehearsal/store.js';
import { requireEvidenceSchema } from '../evidence/schema.js';
import { OpsInputError } from './errors.js';
import { SNOWFLAKE, UUID } from './http.js';

export interface OpsActor { kind: OpsActorKind; id: string }
export const LOCAL_ADMIN: OpsActor = Object.freeze({ kind: 'admin', id: 'local-admin' });

export interface OpsAuditInput {
  kind: OpsAuditKind;
  actor: OpsActor;
  eventId?: string | null;
  guildId?: string | null;
  payload?: Record<string, unknown>;
  occurredAtMs?: number;
}
export interface OpsAuditQuery { after?: number; limit?: number; eventId?: string | null }

export interface OpsAuditStore {
  append(input: OpsAuditInput): Promise<OpsAuditEntryDto>;
  list(query?: OpsAuditQuery): Promise<OpsAuditPageDto>;
}

export const MAX_OPS_PAYLOAD_BYTES = 8 * 1024;
const kinds = new Set<string>(OPS_AUDIT_KINDS);
const actorKinds = new Set(['admin', 'player', 'bot', 'system']);
/** Defense in depth: no secret-looking key may be written into the audit. */
const SECRET_KEY = /token|secret|password|authorization|cookie/i;

function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 8) throw new OpsInputError('Audit payload is nested too deeply.');
  if (Array.isArray(value)) { for (const item of value) assertNoSecrets(item, depth + 1); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new OpsInputError('Audit payloads cannot contain credentials.');
      assertNoSecrets(item, depth + 1);
    }
  }
}

export type NormalizedOpsAudit = Required<Omit<OpsAuditInput, 'payload'>> & { payload: Record<string, unknown> };

export function normalizeOpsAudit(input: OpsAuditInput, now: () => number): NormalizedOpsAudit {
  if (!kinds.has(input.kind)) throw new OpsInputError('Unknown audit kind.');
  if (!input.actor || !actorKinds.has(input.actor.kind) || typeof input.actor.id !== 'string' ||
      input.actor.id.length < 1 || input.actor.id.length > 64) throw new OpsInputError('Invalid audit actor.');
  const eventId = input.eventId ?? null;
  if (eventId !== null && !UUID.test(eventId)) throw new OpsInputError('Invalid audit event ID.');
  const guildId = input.guildId ?? null;
  if (guildId !== null && !SNOWFLAKE.test(guildId)) throw new OpsInputError('Invalid audit guild ID.');
  const payload = input.payload ?? {};
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new OpsInputError('Audit payload must be an object.');
  assertNoSecrets(payload);
  let encoded: string;
  try { encoded = JSON.stringify(payload); } catch { throw new OpsInputError('Audit payload must be JSON.'); }
  if (Buffer.byteLength(encoded) > MAX_OPS_PAYLOAD_BYTES) throw new OpsInputError('Audit payload is too large.');
  const occurredAtMs = input.occurredAtMs ?? now();
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs <= 0) throw new OpsInputError('Invalid audit time.');
  return { kind: input.kind, actor: { kind: input.actor.kind, id: input.actor.id }, eventId: eventId?.toLowerCase() ?? null,
    guildId, payload: JSON.parse(encoded) as Record<string, unknown>, occurredAtMs };
}

function pageQuery(query: OpsAuditQuery = {}): { after: number; limit: number; eventId: string | null } {
  const after = query.after ?? 0;
  const limit = query.limit ?? 200;
  if (!Number.isSafeInteger(after) || after < 0) throw new OpsInputError('after must be a non-negative integer.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OPS_AUDIT_PAGE_LIMIT) throw new OpsInputError(`limit must be 1-${OPS_AUDIT_PAGE_LIMIT}.`);
  const eventId = query.eventId ?? null;
  if (eventId !== null && !UUID.test(eventId)) throw new OpsInputError('Invalid event ID.');
  return { after, limit, eventId: eventId?.toLowerCase() ?? null };
}

interface AuditRow { id: string; event_id: string | null; guild_id: string | null; kind: OpsAuditKind; actor_kind: OpsActorKind;
  actor_id: string; payload: Record<string, unknown>; occurred_at_ms: string }
function entry(row: AuditRow): OpsAuditEntryDto {
  return { id: Number(row.id), eventId: row.event_id, guildId: row.guild_id, kind: row.kind, actorKind: row.actor_kind,
    actorId: row.actor_id, payload: row.payload, occurredAtMs: Number(row.occurred_at_ms) };
}
const COLUMNS = 'id, event_id::text AS event_id, guild_id, kind, actor_kind, actor_id, payload, occurred_at_ms';

/** For other stores' transactions: the audit row commits or rolls back with the change it records. */
export async function insertOpsAudit(client: pg.Client, input: OpsAuditInput, now: () => number = Date.now): Promise<OpsAuditEntryDto> {
  const value = normalizeOpsAudit(input, now);
  const result = await client.query<AuditRow>(
    `INSERT INTO public.tcg_ops_audit (event_id, guild_id, kind, actor_kind, actor_id, payload, occurred_at_ms)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING ${COLUMNS}`,
    [value.eventId, value.guildId, value.kind, value.actor.kind, value.actor.id, JSON.stringify(value.payload), value.occurredAtMs]);
  return entry(result.rows[0]!);
}

export function pgOpsAuditStore(now: () => number = Date.now): OpsAuditStore {
  return {
    async append(input) {
      normalizeOpsAudit(input, now);   // validate before connecting
      return withClient(async client => {
        await requireEvidenceSchema(client);
        return insertOpsAudit(client, input, now);
      });
    },
    async list(query) {
      const page = pageQuery(query);
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const result = await client.query<AuditRow>(
          `SELECT ${COLUMNS} FROM public.tcg_ops_audit WHERE id > $1 AND ($2::uuid IS NULL OR event_id = $2::uuid)
           ORDER BY id LIMIT $3`, [page.after, page.eventId, page.limit]);
        const entries = result.rows.map(entry);
        return { entries, nextAfter: entries.at(-1)?.id ?? page.after };
      });
    }
  };
}

/** In-memory store for tests and the demo runtime. */
export class MemoryOpsAuditStore implements OpsAuditStore {
  readonly entries: OpsAuditEntryDto[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  async append(input: OpsAuditInput): Promise<OpsAuditEntryDto> {
    const value = normalizeOpsAudit(input, this.now);
    const saved: OpsAuditEntryDto = { id: this.entries.length + 1, eventId: value.eventId, guildId: value.guildId, kind: value.kind,
      actorKind: value.actor.kind, actorId: value.actor.id, payload: value.payload, occurredAtMs: value.occurredAtMs };
    this.entries.push(saved);
    return structuredClone(saved);
  }
  async list(query?: OpsAuditQuery): Promise<OpsAuditPageDto> {
    const page = pageQuery(query);
    const entries = this.entries.filter(item => item.id > page.after && (page.eventId === null || item.eventId === page.eventId))
      .slice(0, page.limit).map(item => structuredClone(item));
    return { entries, nextAfter: entries.at(-1)?.id ?? page.after };
  }
}
