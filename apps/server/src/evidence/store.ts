// Evidence rows (tcg_evidence). This module owns database state and the on-disk path layout only;
// file I/O (upload streaming, type sniffing, playback, retention) builds on these helpers.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { EVIDENCE_DELETE_REASON_MAX_LENGTH, EVIDENCE_FILE_TYPES, EVIDENCE_LIST_LIMIT, EVIDENCE_NOTE_MAX_LENGTH,
  EVIDENCE_ORIGINAL_NAME_MAX_LENGTH, EVIDENCE_URL_MAX_LENGTH, isEvidenceFileExtension, isMatchId, isSeatId,
  type EvidenceFileExtension, type EvidenceItemDto, type EvidenceKind, type EvidenceSource, type EvidenceStatus,
  type EvidenceSubmitter, type MatchId, type Seat } from '@tcg-live/core';
import { transaction, withClient } from '../rehearsal/store.js';
import { insertOpsAudit, type OpsActor, type OpsAuditInput, type OpsAuditStore } from '../ops/audit.js';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../ops/errors.js';
import { readableText, SNOWFLAKE, UUID } from '../ops/http.js';
import { requireEvidenceSchema } from './schema.js';

export const DEFAULT_EVIDENCE_DIR = fileURLToPath(new URL('../../../../data/evidence/', import.meta.url));
const RELATIVE_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{2,4})$/;

/** Server-only view: the DTO plus the relative storage path. Never send storagePath to a client. */
export interface EvidenceRecord extends EvidenceItemDto { storagePath: string | null }

interface NewEvidenceBase {
  eventId: string;
  matchId: string;
  source: EvidenceSource;
  submittedBy: EvidenceSubmitter;
  seat?: Seat | null;
  note?: string;
  proposalRevision?: number | null;
  actor: OpsActor;
}
export interface NewLinkEvidence extends NewEvidenceBase { url: string }
export interface NewFileEvidence extends NewEvidenceBase {
  kind: 'upload' | 'voice';
  extension: EvidenceFileExtension;
  originalName?: string | null;
  /** kind 'voice' only: the recorded seated player and the track's start time. */
  recordedUserId?: string | null;
  recordingStartedAtMs?: number | null;
}
export interface StoredFileInfo { byteSize: number; sha256: string; mime?: string; durationMs?: number | null }

export interface EvidenceStore {
  /** Validates an https link and records it as stored; audits evidence.submitted. */
  createLink(input: NewLinkEvidence): Promise<EvidenceItemDto>;
  /** Reserves an ID and relative storage path with status 'pending'; the caller then writes the file. */
  createPendingUpload(input: NewFileEvidence): Promise<EvidenceRecord>;
  /** pending -> stored; audits evidence.submitted. */
  markStored(id: string, file: StoredFileInfo, actor: OpsActor): Promise<EvidenceItemDto>;
  /** pending -> failed; audits evidence.failed with the safe reason. */
  markFailed(id: string, reason: string, actor: OpsActor): Promise<EvidenceItemDto>;
  /** Oldest first; deleted rows are included (with status 'deleted') so the review shows the trail. */
  list(eventId: string, matchId: string): Promise<EvidenceItemDto[]>;
  get(id: string): Promise<EvidenceRecord | null>;
  setHold(id: string, hold: boolean, actor: OpsActor): Promise<EvidenceItemDto>;
  /** Marks deleted and returns the record so the caller can remove its file. Held items refuse. Idempotent. */
  softDelete(id: string, reason: string, actor: OpsActor): Promise<EvidenceRecord>;
}

// ---- path layout ----

/** `<eventId>/<evidenceId>.<ext>`, the only form ever stored in storage_path. */
export function evidenceRelativePath(eventId: string, evidenceId: string, extension: EvidenceFileExtension): string {
  if (!UUID.test(eventId) || !UUID.test(evidenceId) || !isEvidenceFileExtension(extension)) throw new OpsInputError('Invalid evidence path.');
  return `${eventId.toLowerCase()}/${evidenceId.toLowerCase()}.${extension}`;
}

/** Resolves a stored relative path under `root`, refusing anything that would leave it. */
export function resolveEvidencePath(relative: string, root: string = DEFAULT_EVIDENCE_DIR): string {
  const match = RELATIVE_PATH.exec(relative);
  if (!match || !isEvidenceFileExtension(match[3])) throw new OpsInputError('Invalid evidence path.');
  const base = path.resolve(root);
  const full = path.resolve(base, match[1]!, `${match[2]}.${match[3]}`);
  const inside = path.relative(base, full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new OpsInputError('Invalid evidence path.');
  return full;
}

// ---- validation ----

const fail = (message: string): never => { throw new OpsInputError(message); };

export function parseEvidenceUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > EVIDENCE_URL_MAX_LENGTH || /[\s\p{Cc}\p{Cf}]/u.test(raw))
    fail(`Link must be an https:// address of at most ${EVIDENCE_URL_MAX_LENGTH} characters.`);
  let url: URL;
  try { url = new URL(raw as string); } catch { return fail('Link must be a valid https:// address.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
    fail('Link must be an https:// address without a username or password.');
  if (url.href.length > EVIDENCE_URL_MAX_LENGTH) fail(`Link must be at most ${EVIDENCE_URL_MAX_LENGTH} characters.`);
  return url.href;
}
export function parseEvidenceNote(raw: unknown): string {
  if (raw === undefined) return '';
  if (typeof raw !== 'string' || !readableText(raw.trim(), EVIDENCE_NOTE_MAX_LENGTH, true))
    fail(`Note must be at most ${EVIDENCE_NOTE_MAX_LENGTH} readable characters.`);
  return (raw as string).trim();
}
export function parseDeleteReason(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || !readableText(raw.trim(), EVIDENCE_DELETE_REASON_MAX_LENGTH, true))
    fail(`A delete reason of 1-${EVIDENCE_DELETE_REASON_MAX_LENGTH} readable characters is required.`);
  return (raw as string).trim();
}
function evidenceId(id: string): string {
  if (!UUID.test(id)) throw new OpsNotFoundError('Evidence not found.');
  return id.toLowerCase();
}
function target(eventId: string, matchId: string): { eventId: string; matchId: MatchId } {
  if (!UUID.test(eventId)) fail('Invalid event ID.');
  if (!isMatchId(matchId) || matchId.length > 5) fail('Invalid match ID.');
  return { eventId: eventId.toLowerCase(), matchId: matchId as MatchId };
}
function base(input: NewEvidenceBase) {
  const where = target(input.eventId, input.matchId);
  if (!['discord', 'web', 'bot'].includes(input.source)) fail('Invalid evidence source.');
  if (typeof input.submittedBy !== 'string' || !(SNOWFLAKE.test(input.submittedBy) || input.submittedBy === 'local-admin' || input.submittedBy === 'bot'))
    fail('Invalid evidence submitter.');
  const seat = input.seat ?? null;
  if (seat !== null && (!isSeatId(seat) || seat.length > 5)) fail('Invalid seat.');
  const revision = input.proposalRevision ?? null;
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) fail('Invalid proposal revision.');
  return { ...where, source: input.source, submittedBy: input.submittedBy, seat, note: parseEvidenceNote(input.note), proposalRevision: revision };
}
function originalName(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  // A display label only: keep the base name, never a path, and drop anything unreadable.
  const name = [...path.basename(raw.replace(/\\/g, '/')).replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, EVIDENCE_ORIGINAL_NAME_MAX_LENGTH).join('');
  return name || null;
}
function recordingInfo(input: NewFileEvidence): [string | null, number | null] {
  const user = input.recordedUserId ?? null;
  const at = input.recordingStartedAtMs ?? null;
  if ((user !== null || at !== null) && input.kind !== 'voice') fail('Only voice recordings name a recorded player.');
  if (user !== null && (typeof user !== 'string' || !SNOWFLAKE.test(user))) fail('Invalid recorded player.');
  if (at !== null && (!Number.isSafeInteger(at) || at <= 0)) fail('Invalid recording start time.');
  return [user, at];
}
function fileInfo(file: StoredFileInfo, extension: EvidenceFileExtension | null): Required<StoredFileInfo> {
  if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0) fail('Invalid evidence size.');
  if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) fail('Invalid evidence digest.');
  const duration = file.durationMs ?? null;
  if (duration !== null && (!Number.isSafeInteger(duration) || duration < 0)) fail('Invalid evidence duration.');
  const mime = file.mime ?? (extension ? EVIDENCE_FILE_TYPES[extension].mime : undefined);
  if (typeof mime !== 'string' || mime.length > 100 || !/^[a-z]+\/[a-z0-9.+-]+$/.test(mime)) fail('Invalid evidence type.');
  return { byteSize: file.byteSize, sha256: file.sha256, mime: mime!, durationMs: duration };
}
function extensionOf(storagePath: string | null): EvidenceFileExtension | null {
  const ext = storagePath ? RELATIVE_PATH.exec(storagePath)?.[3] : undefined;
  return isEvidenceFileExtension(ext) ? ext : null;
}
function safeReason(reason: string): string {
  return [...String(reason).replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 200).join('') || 'failed';
}
/** The DTO for a record: storagePath stripped. */
export function publicEvidence(record: EvidenceRecord): EvidenceItemDto {
  const { storagePath: _omit, ...item } = record;
  return item;
}

// ---- PostgreSQL ----

interface EvidenceRow {
  id: string; event_id: string; match_id: string; proposal_revision: number | null; kind: EvidenceKind; source: EvidenceSource;
  submitted_by: string; seat: string | null; note: string; storage_path: string | null; original_name: string | null;
  mime: string | null; byte_size: string | null; sha256: string | null; duration_ms: string | null; external_url: string | null;
  status: EvidenceStatus; hold: boolean; created_at_ms: string; deleted_at_ms: string | null; delete_reason: string | null;
  recorded_user_id: string | null; recording_started_at_ms: string | null;
}
const COLUMNS = `id::text AS id, event_id::text AS event_id, match_id, proposal_revision, kind, source, submitted_by, seat, note,
  storage_path, original_name, mime, byte_size, sha256, duration_ms, external_url, status, hold, created_at_ms, deleted_at_ms, delete_reason,
  recorded_user_id, recording_started_at_ms`;
const num = (value: string | null) => value === null ? null : Number(value);

export function evidenceFromRow(row: EvidenceRow): EvidenceRecord {
  const extension = extensionOf(row.storage_path);
  return {
    id: row.id, eventId: row.event_id, matchId: row.match_id as MatchId, proposalRevision: row.proposal_revision,
    kind: row.kind, source: row.source, submittedBy: row.submitted_by as EvidenceSubmitter, seat: row.seat as Seat | null,
    note: row.note, originalName: row.original_name, mime: row.mime, byteSize: num(row.byte_size), sha256: row.sha256,
    durationMs: num(row.duration_ms), externalUrl: row.external_url,
    playable: row.status === 'stored' && extension !== null && EVIDENCE_FILE_TYPES[extension].playable,
    status: row.status, hold: row.hold, createdAtMs: Number(row.created_at_ms), deletedAtMs: num(row.deleted_at_ms),
    deleteReason: row.delete_reason,
    ...(row.kind === 'voice' ? { recordedUserId: row.recorded_user_id, recordingStartedAtMs: num(row.recording_started_at_ms) } : {}),
    storagePath: row.storage_path
  };
}

function auditInput(kind: OpsAuditInput['kind'], record: EvidenceRecord, actor: OpsActor, extra: Record<string, unknown> = {}): OpsAuditInput {
  return { kind, actor, eventId: record.eventId,
    payload: { evidenceId: record.id, matchId: record.matchId, evidenceKind: record.kind, ...extra } };
}

export function pgEvidenceStore(now: () => number = Date.now): EvidenceStore {
  const lockRow = async (client: pg.Client, id: string): Promise<EvidenceRecord> => {
    const result = await client.query<EvidenceRow>(`SELECT ${COLUMNS} FROM public.tcg_evidence WHERE id = $1 FOR UPDATE`, [id]);
    if (!result.rows[0]) throw new OpsNotFoundError('Evidence not found.');
    return evidenceFromRow(result.rows[0]);
  };
  const mutate = <T>(operation: (client: pg.Client) => Promise<T>) => withClient(async client => {
    await requireEvidenceSchema(client);
    return transaction(client, () => operation(client));
  });
  const insert = async (client: pg.Client, values: unknown[]) => {
    const result = await client.query<EvidenceRow>(
      `INSERT INTO public.tcg_evidence (id, event_id, match_id, proposal_revision, kind, source, submitted_by, seat, note,
         storage_path, original_name, mime, external_url, status, created_at_ms, recorded_user_id, recording_started_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${COLUMNS}`, values);
    return evidenceFromRow(result.rows[0]!);
  };
  return {
    async createLink(input) {
      const value = base(input);
      const url = parseEvidenceUrl(input.url);
      return mutate(async client => {
        const record = await insert(client, [randomUUID(), value.eventId, value.matchId, value.proposalRevision, 'link', value.source,
          value.submittedBy, value.seat, value.note, null, null, null, url, 'stored', now(), null, null]);
        await insertOpsAudit(client, auditInput('evidence.submitted', record, input.actor, { source: record.source }), now);
        return publicEvidence(record);
      });
    },
    async createPendingUpload(input) {
      const value = base(input);
      if (input.kind !== 'upload' && input.kind !== 'voice') fail('Invalid evidence kind.');
      const [recordedUserId, recordingStartedAtMs] = recordingInfo(input);
      const id = randomUUID();
      const storagePath = evidenceRelativePath(value.eventId, id, input.extension);
      return mutate(client => insert(client, [id, value.eventId, value.matchId, value.proposalRevision, input.kind, value.source,
        value.submittedBy, value.seat, value.note, storagePath, originalName(input.originalName),
        EVIDENCE_FILE_TYPES[input.extension].mime, null, 'pending', now(), recordedUserId, recordingStartedAtMs]));
    },
    async markStored(id, file, actor) {
      const key = evidenceId(id);
      return mutate(async client => {
        const current = await lockRow(client, key);
        if (current.status !== 'pending') throw new OpsConflictError('Only a pending upload can be marked stored.');
        const info = fileInfo(file, extensionOf(current.storagePath));
        const result = await client.query<EvidenceRow>(`UPDATE public.tcg_evidence SET status = 'stored', byte_size = $2, sha256 = $3,
          mime = $4, duration_ms = $5 WHERE id = $1 RETURNING ${COLUMNS}`, [key, info.byteSize, info.sha256, info.mime, info.durationMs]);
        const record = evidenceFromRow(result.rows[0]!);
        await insertOpsAudit(client, auditInput('evidence.submitted', record, actor,
          { source: record.source, byteSize: info.byteSize, sha256: info.sha256 }), now);
        return publicEvidence(record);
      });
    },
    async markFailed(id, reason, actor) {
      const key = evidenceId(id);
      return mutate(async client => {
        const current = await lockRow(client, key);
        if (current.status !== 'pending') throw new OpsConflictError('Only a pending upload can be marked failed.');
        const result = await client.query<EvidenceRow>(`UPDATE public.tcg_evidence SET status = 'failed' WHERE id = $1 RETURNING ${COLUMNS}`, [key]);
        const record = evidenceFromRow(result.rows[0]!);
        await insertOpsAudit(client, auditInput('evidence.failed', record, actor, { reason: safeReason(reason) }), now);
        return publicEvidence(record);
      });
    },
    async list(eventId, matchId) {
      const where = target(eventId, matchId);
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const result = await client.query<EvidenceRow>(`SELECT ${COLUMNS} FROM public.tcg_evidence
          WHERE event_id = $1 AND match_id = $2 ORDER BY created_at_ms, id LIMIT $3`, [where.eventId, where.matchId, EVIDENCE_LIST_LIMIT]);
        return result.rows.map(row => publicEvidence(evidenceFromRow(row)));
      });
    },
    async get(id) {
      if (!UUID.test(id)) return null;
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const result = await client.query<EvidenceRow>(`SELECT ${COLUMNS} FROM public.tcg_evidence WHERE id = $1`, [id.toLowerCase()]);
        return result.rows[0] ? evidenceFromRow(result.rows[0]) : null;
      });
    },
    async setHold(id, hold, actor) {
      const key = evidenceId(id);
      if (typeof hold !== 'boolean') fail('hold must be true or false.');
      return mutate(async client => {
        const current = await lockRow(client, key);
        if (current.status === 'deleted') throw new OpsConflictError('Deleted evidence cannot be held.');
        if (current.hold === hold) return publicEvidence(current);
        const result = await client.query<EvidenceRow>(`UPDATE public.tcg_evidence SET hold = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [key, hold]);
        const record = evidenceFromRow(result.rows[0]!);
        await insertOpsAudit(client, auditInput('evidence.hold', record, actor, { hold }), now);
        return publicEvidence(record);
      });
    },
    async softDelete(id, reason, actor) {
      const key = evidenceId(id);
      const why = parseDeleteReason(reason);
      return mutate(async client => {
        const current = await lockRow(client, key);
        if (current.status === 'deleted') return current;
        if (current.hold) throw new OpsConflictError('Remove the hold before deleting this evidence.');
        const result = await client.query<EvidenceRow>(`UPDATE public.tcg_evidence SET status = 'deleted', deleted_at_ms = $2,
          delete_reason = $3 WHERE id = $1 RETURNING ${COLUMNS}`, [key, now(), why]);
        const record = evidenceFromRow(result.rows[0]!);
        await insertOpsAudit(client, auditInput('evidence.deleted', record, actor, { reason: why }), now);
        return record;
      });
    }
  };
}

// ---- memory ----

/** In-memory store for tests and the demo runtime; `events` lists event IDs that exist (null accepts any). */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly records = new Map<string, EvidenceRecord>();
  constructor(private readonly audit: OpsAuditStore, private readonly now: () => number = Date.now,
    private readonly events: Set<string> | null = null) {}

  private exists(eventId: string): void {
    if (this.events && !this.events.has(eventId)) throw new OpsNotFoundError('That tournament does not exist.');
  }
  private row(id: string): EvidenceRecord {
    const record = this.records.get(evidenceId(id));
    if (!record) throw new OpsNotFoundError('Evidence not found.');
    return record;
  }
  private save(record: EvidenceRecord): EvidenceRecord {
    const extension = extensionOf(record.storagePath);
    record.playable = record.status === 'stored' && extension !== null && EVIDENCE_FILE_TYPES[extension].playable;
    this.records.set(record.id, record);
    return structuredClone(record);
  }
  private blank(value: ReturnType<typeof base>, id: string): EvidenceRecord {
    return { id, eventId: value.eventId, matchId: value.matchId, proposalRevision: value.proposalRevision, kind: 'link', source: value.source,
      submittedBy: value.submittedBy, seat: value.seat, note: value.note, originalName: null, mime: null, byteSize: null, sha256: null,
      durationMs: null, externalUrl: null, playable: false, status: 'pending', hold: false, createdAtMs: this.now(), deletedAtMs: null,
      deleteReason: null, storagePath: null };
  }
  async createLink(input: NewLinkEvidence) {
    const value = base(input);
    const url = parseEvidenceUrl(input.url);
    this.exists(value.eventId);
    const record = this.save({ ...this.blank(value, randomUUID()), kind: 'link', externalUrl: url, status: 'stored' });
    await this.audit.append(auditInput('evidence.submitted', record, input.actor, { source: record.source }));
    return publicEvidence(record);
  }
  async createPendingUpload(input: NewFileEvidence) {
    const value = base(input);
    if (input.kind !== 'upload' && input.kind !== 'voice') fail('Invalid evidence kind.');
    const [recordedUserId, recordingStartedAtMs] = recordingInfo(input);
    this.exists(value.eventId);
    const id = randomUUID();
    return this.save({ ...this.blank(value, id), kind: input.kind, storagePath: evidenceRelativePath(value.eventId, id, input.extension),
      originalName: originalName(input.originalName), mime: EVIDENCE_FILE_TYPES[input.extension].mime,
      ...(input.kind === 'voice' ? { recordedUserId, recordingStartedAtMs } : {}) });
  }
  async markStored(id: string, file: StoredFileInfo, actor: OpsActor) {
    const current = this.row(id);
    if (current.status !== 'pending') throw new OpsConflictError('Only a pending upload can be marked stored.');
    const info = fileInfo(file, extensionOf(current.storagePath));
    const record = this.save({ ...current, ...info, status: 'stored' });
    await this.audit.append(auditInput('evidence.submitted', record, actor, { source: record.source, byteSize: info.byteSize, sha256: info.sha256 }));
    return publicEvidence(record);
  }
  async markFailed(id: string, reason: string, actor: OpsActor) {
    const current = this.row(id);
    if (current.status !== 'pending') throw new OpsConflictError('Only a pending upload can be marked failed.');
    const record = this.save({ ...current, status: 'failed' });
    await this.audit.append(auditInput('evidence.failed', record, actor, { reason: safeReason(reason) }));
    return publicEvidence(record);
  }
  async list(eventId: string, matchId: string) {
    const where = target(eventId, matchId);
    return [...this.records.values()].filter(item => item.eventId === where.eventId && item.matchId === where.matchId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)).slice(0, EVIDENCE_LIST_LIMIT)
      .map(item => publicEvidence(structuredClone(item)));
  }
  async get(id: string) {
    if (!UUID.test(id)) return null;
    const record = this.records.get(id.toLowerCase());
    return record ? structuredClone(record) : null;
  }
  async setHold(id: string, hold: boolean, actor: OpsActor) {
    const current = this.row(id);
    if (typeof hold !== 'boolean') fail('hold must be true or false.');
    if (current.status === 'deleted') throw new OpsConflictError('Deleted evidence cannot be held.');
    if (current.hold === hold) return publicEvidence(structuredClone(current));
    const record = this.save({ ...current, hold });
    await this.audit.append(auditInput('evidence.hold', record, actor, { hold }));
    return publicEvidence(record);
  }
  async softDelete(id: string, reason: string, actor: OpsActor) {
    const current = this.row(id);
    const why = parseDeleteReason(reason);
    if (current.status === 'deleted') return structuredClone(current);
    if (current.hold) throw new OpsConflictError('Remove the hold before deleting this evidence.');
    const record = this.save({ ...current, status: 'deleted', deletedAtMs: this.now(), deleteReason: why });
    await this.audit.append(auditInput('evidence.deleted', record, actor, { reason: why }));
    return record;
  }
}

// ---- retention queries ----

/** A non-deleted, unheld item with what retention needs to know about its event and match. */
export interface RetentionCandidate {
  record: EvidenceRecord;
  /** When the event ended (all matches final, session retired, or tournament deleted); null while running. */
  eventEndedAtMs: number | null;
  /** The match has an open dispute or judge call. */
  matchOpen: boolean;
}
export interface EvidenceRetentionSource {
  /** Unheld, non-deleted items whose event ended at or before `endedAtOrBeforeMs`, oldest first. */
  candidates(endedAtOrBeforeMs: number, limit: number): Promise<RetentionCandidate[]>;
  /** Deleted rows that still name a file, deleted at or after `sinceMs`, so a failed file removal is retried. */
  deletedWithFiles(sinceMs: number, limit: number): Promise<EvidenceRecord[]>;
}

/**
 * When an event ended, for retention. Conservative: only a retired session (tournament finished or replaced)
 * or a deleted tournament counts. "Every match final" is NOT an end: a Swiss event paused between rounds
 * looks exactly like that. Events without a session row never end, so their evidence is never auto-deleted.
 */
export const RETENTION_EVENT_ENDED_SQL = `CASE
                 WHEN s.deleted_at_ms IS NOT NULL THEN s.deleted_at_ms
                 WHEN s.status = 'retired' THEN s.retired_at_ms
               END`;

export function pgEvidenceRetentionSource(): EvidenceRetentionSource {
  return {
    async candidates(endedAtOrBeforeMs, limit) {
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const result = await client.query<EvidenceRow & { ended_at_ms: string | null; match_open: boolean }>(
          `WITH scope AS (
             SELECT e.*, ev.state AS event_state,
               ${RETENTION_EVENT_ENDED_SQL} AS ended_at_ms
             FROM public.tcg_evidence e
             JOIN public.tcg_rehearsal_events ev ON ev.id = e.event_id
             LEFT JOIN public.tcg_rehearsal_sessions s ON s.event_id = e.event_id
             WHERE e.status <> 'deleted' AND e.hold = false)
           SELECT ${COLUMNS}, ended_at_ms, EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(event_state->'matches', '[]'::jsonb)) m
               WHERE m->>'id' = scope.match_id AND m->>'phase' IS DISTINCT FROM 'final' AND (m->>'judgeAttention' = 'true'
                 OR m->'proposal'->>'decision' = 'disputed' OR m->>'phase' IN ('paused', 'expired'))) AS match_open
           FROM scope WHERE ended_at_ms IS NOT NULL AND ended_at_ms <= $1
           ORDER BY created_at_ms, id LIMIT $2`, [endedAtOrBeforeMs, limit]);
        return result.rows.map(row => ({ record: evidenceFromRow(row), eventEndedAtMs: num(row.ended_at_ms), matchOpen: row.match_open }));
      });
    },
    async deletedWithFiles(sinceMs, limit) {
      return withClient(async client => {
        await requireEvidenceSchema(client);
        const result = await client.query<EvidenceRow>(`SELECT ${COLUMNS} FROM public.tcg_evidence
          WHERE status = 'deleted' AND storage_path IS NOT NULL AND deleted_at_ms >= $1 ORDER BY deleted_at_ms LIMIT $2`, [sinceMs, limit]);
        return result.rows.map(evidenceFromRow);
      });
    }
  };
}
