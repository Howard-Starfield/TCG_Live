// Mod cases (tcg_mod_cases) and private mod notes (tcg_mod_notes), with PostgreSQL and in-memory stores.
// Case numbers come from allocateAdminCounter('case') in the same transaction as the insert, the audit
// row and the Discord action itself: when Discord refuses, everything rolls back and no number is used.
import type pg from 'pg';
import type { AdminToolsAuditKind, MatchId, ModCaseDto, ModCaseKind, ModCasePageDto, ModCaseSource, ModNoteDto } from '@tcg-live/core';
import { insertOpsAudit, type OpsActor, type OpsAuditStore } from '../../ops/audit.js';
import { OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { transaction, withClient } from '../../rehearsal/store.js';
import { allocateAdminCounter, MemoryAdminCounters, requireAdminToolsSchema } from '../schema.js';

export interface NewModCase {
  kind: ModCaseKind;
  targetId: string;
  reason: string;
  evidenceIds: string[];
  eventId: string | null;
  matchId: MatchId | null;
  source: ModCaseSource;
  expiresAtMs: number | null;
}
export interface CaseQuery { targetId?: string | null; kind?: ModCaseKind | null; moderatorId?: string | null; before?: number | null;
  /** Only cases created before this time (mod-action audit trail paging). */
  createdBeforeMs?: number | null; limit: number }
export interface CasePatch { reason?: string; evidenceIds?: string[] }

export interface ModCaseStore {
  /** Allocates the number, runs `perform(number)` (the Discord action), inserts and audits; all or nothing. */
  create(guildId: string, input: NewModCase, actor: OpsActor, perform: (number: number) => Promise<void>): Promise<ModCaseDto>;
  list(guildId: string, query: CaseQuery): Promise<ModCasePageDto>;
  get(guildId: string, number: number): Promise<ModCaseDto>;
  update(guildId: string, number: number, patch: CasePatch, actor: OpsActor): Promise<ModCaseDto>;
  remove(guildId: string, number: number, reason: string, actor: OpsActor): Promise<void>;
  /** Number of cases per target. */
  counts(guildId: string, targetIds: readonly string[]): Promise<Map<string, number>>;
  /** Newest 'ban' case per target (ban list links). */
  latestBans(guildId: string, targetIds: readonly string[]): Promise<Map<string, ModCaseDto>>;
}

export interface ModNoteStore {
  list(guildId: string, targetId: string): Promise<ModNoteDto[]>;
  add(guildId: string, targetId: string, body: string, actor: OpsActor): Promise<ModNoteDto>;
  update(guildId: string, id: number, body: string, actor: OpsActor): Promise<ModNoteDto>;
  remove(guildId: string, id: number, actor: OpsActor): Promise<void>;
  counts(guildId: string, targetIds: readonly string[]): Promise<Map<string, number>>;
}

const caseAuditKind = (kind: ModCaseKind): AdminToolsAuditKind => `member.${kind}`;
const casePayload = (item: ModCaseDto) => ({ caseNumber: item.number, targetId: item.targetId, reason: item.reason,
  evidenceIds: item.evidenceIds, matchId: item.matchId, expiresAtMs: item.expiresAtMs, source: item.source });
const notFound = (number: number) => new OpsNotFoundError(`Case #${number} does not exist.`);
const noteMissing = () => new OpsNotFoundError('That note does not exist.');
const actorKind = (actor: OpsActor): ModCaseDto['moderatorKind'] => actor.kind === 'admin' ? 'admin' : actor.kind === 'bot' ? 'bot' : 'member';

// ------------------------------------------------------------------ PostgreSQL

interface CaseRow {
  guild_id: string; number: number; kind: ModCaseKind; target_id: string; moderator_kind: ModCaseDto['moderatorKind'];
  moderator_id: string; reason: string; evidence_ids: string[]; event_id: string | null; match_id: MatchId | null;
  source: ModCaseSource; created_at_ms: string; expires_at_ms: string | null; expiry_handled_at_ms: string | null;
}
const CASE_COLUMNS = `guild_id, number, kind, target_id, moderator_kind, moderator_id, reason, evidence_ids::text[] AS evidence_ids,
  event_id::text AS event_id, match_id, source, created_at_ms, expires_at_ms, expiry_handled_at_ms`;
const caseFromRow = (row: CaseRow): ModCaseDto => ({
  guildId: row.guild_id, number: row.number, kind: row.kind, targetId: row.target_id, moderatorKind: row.moderator_kind,
  moderatorId: row.moderator_id, reason: row.reason, evidenceIds: row.evidence_ids ?? [], eventId: row.event_id, matchId: row.match_id,
  source: row.source, createdAtMs: Number(row.created_at_ms), expiresAtMs: row.expires_at_ms === null ? null : Number(row.expires_at_ms),
  expiryHandledAtMs: row.expiry_handled_at_ms === null ? null : Number(row.expiry_handled_at_ms)
});
interface NoteRow { id: string; guild_id: string; target_id: string; author_id: string; body: string; created_at_ms: string; updated_at_ms: string }
const noteFromRow = (row: NoteRow): ModNoteDto => ({ id: Number(row.id), guildId: row.guild_id, targetId: row.target_id, authorId: row.author_id,
  body: row.body, createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms) });

/** Evidence IDs must name existing, not deleted, match evidence. */
async function checkEvidence(client: pg.Client, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const result = await client.query<{ found: number }>(
    `SELECT count(*)::int AS found FROM public.tcg_evidence WHERE id = ANY($1::uuid[]) AND status <> 'deleted'`, [ids]);
  if ((result.rows[0]?.found ?? 0) !== ids.length) throw new OpsInputError('Some evidence IDs do not exist or were deleted.');
}

export function pgModCaseStore(now: () => number = Date.now): ModCaseStore {
  const run = <T>(work: (client: pg.Client) => Promise<T>) => withClient(async client => { await requireAdminToolsSchema(client); return work(client); });
  const lockCase = async (client: pg.Client, guildId: string, number: number) => {
    const result = await client.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM public.tcg_mod_cases WHERE guild_id = $1 AND number = $2 FOR UPDATE`, [guildId, number]);
    if (!result.rows[0]) throw notFound(number);
    return caseFromRow(result.rows[0]);
  };
  return {
    create: (guildId, input, actor, perform) => run(client => transaction(client, async () => {
      await checkEvidence(client, input.evidenceIds);
      const number = await allocateAdminCounter(client, guildId, 'case');
      const createdAtMs = now();
      const result = await client.query<CaseRow>(`INSERT INTO public.tcg_mod_cases (guild_id, number, kind, target_id, moderator_kind,
        moderator_id, reason, evidence_ids, event_id, match_id, source, created_at_ms, expires_at_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9::uuid, $10, $11, $12, $13) RETURNING ${CASE_COLUMNS}`,
      [guildId, number, input.kind, input.targetId, actorKind(actor), actor.id, input.reason, input.evidenceIds, input.eventId, input.matchId,
        input.source, createdAtMs, input.expiresAtMs]);
      const saved = caseFromRow(result.rows[0]!);
      await insertOpsAudit(client, { kind: caseAuditKind(input.kind), actor, guildId, eventId: input.eventId, payload: casePayload(saved),
        occurredAtMs: createdAtMs }, now);
      // Last: a Discord refusal rolls the case, its number and its audit row back.
      await perform(number);
      return saved;
    })),
    list: (guildId, query) => run(async client => {
      const result = await client.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM public.tcg_mod_cases WHERE guild_id = $1
        AND ($2::text IS NULL OR target_id = $2) AND ($3::text IS NULL OR kind = $3) AND ($4::text IS NULL OR moderator_id = $4)
        AND ($5::int IS NULL OR number < $5) AND ($7::bigint IS NULL OR created_at_ms < $7) ORDER BY number DESC LIMIT $6`,
      [guildId, query.targetId ?? null, query.kind ?? null, query.moderatorId ?? null, query.before ?? null, query.limit + 1, query.createdBeforeMs ?? null]);
      const cases = result.rows.slice(0, query.limit).map(caseFromRow);
      return { cases, nextBefore: result.rows.length > query.limit ? cases.at(-1)!.number : null };
    }),
    get: (guildId, number) => run(async client => {
      const result = await client.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM public.tcg_mod_cases WHERE guild_id = $1 AND number = $2`, [guildId, number]);
      if (!result.rows[0]) throw notFound(number);
      return caseFromRow(result.rows[0]);
    }),
    update: (guildId, number, patch, actor) => run(client => transaction(client, async () => {
      const before = await lockCase(client, guildId, number);
      if (patch.evidenceIds) await checkEvidence(client, patch.evidenceIds);
      const result = await client.query<CaseRow>(`UPDATE public.tcg_mod_cases SET reason = $3, evidence_ids = $4::uuid[]
        WHERE guild_id = $1 AND number = $2 RETURNING ${CASE_COLUMNS}`,
      [guildId, number, patch.reason ?? before.reason, patch.evidenceIds ?? before.evidenceIds]);
      const saved = caseFromRow(result.rows[0]!);
      await insertOpsAudit(client, { kind: 'member.case.updated', actor, guildId, payload: { caseNumber: number, action: 'edited',
        reasonBefore: patch.reason !== undefined ? before.reason : undefined, reason: patch.reason, evidenceIds: patch.evidenceIds } }, now);
      return saved;
    })),
    remove: (guildId, number, reason, actor) => run(client => transaction(client, async () => {
      const before = await lockCase(client, guildId, number);
      await client.query('DELETE FROM public.tcg_mod_cases WHERE guild_id = $1 AND number = $2', [guildId, number]);
      await insertOpsAudit(client, { kind: 'member.case.updated', actor, guildId, payload: { caseNumber: number, action: 'deleted',
        deleteReason: reason, kind: before.kind, targetId: before.targetId, reason: before.reason } }, now);
    })),
    counts: (guildId, targetIds) => targetIds.length ? run(async client => {
      const result = await client.query<{ target_id: string; count: number }>(`SELECT target_id, count(*)::int AS count FROM public.tcg_mod_cases
        WHERE guild_id = $1 AND target_id = ANY($2::text[]) GROUP BY target_id`, [guildId, targetIds]);
      return new Map(result.rows.map(row => [row.target_id, row.count]));
    }) : Promise.resolve(new Map()),
    latestBans: (guildId, targetIds) => targetIds.length ? run(async client => {
      const result = await client.query<CaseRow>(`SELECT DISTINCT ON (target_id) ${CASE_COLUMNS} FROM public.tcg_mod_cases
        WHERE guild_id = $1 AND kind = 'ban' AND target_id = ANY($2::text[]) ORDER BY target_id, number DESC`, [guildId, targetIds]);
      return new Map(result.rows.map(row => [row.target_id, caseFromRow(row)]));
    }) : Promise.resolve(new Map())
  };
}

export function pgModNoteStore(now: () => number = Date.now): ModNoteStore {
  const run = <T>(work: (client: pg.Client) => Promise<T>) => withClient(async client => { await requireAdminToolsSchema(client); return work(client); });
  const COLUMNS = 'id, guild_id, target_id, author_id, body, created_at_ms, updated_at_ms';
  return {
    list: (guildId, targetId) => run(async client => (await client.query<NoteRow>(`SELECT ${COLUMNS} FROM public.tcg_mod_notes
      WHERE guild_id = $1 AND target_id = $2 AND deleted_at_ms IS NULL ORDER BY id DESC`, [guildId, targetId])).rows.map(noteFromRow)),
    add: (guildId, targetId, body, actor) => run(client => transaction(client, async () => {
      const at = now();
      const note = noteFromRow((await client.query<NoteRow>(`INSERT INTO public.tcg_mod_notes (guild_id, target_id, author_id, body, created_at_ms,
        updated_at_ms) VALUES ($1, $2, $3, $4, $5, $5) RETURNING ${COLUMNS}`, [guildId, targetId, actor.id, body, at])).rows[0]!);
      await insertOpsAudit(client, { kind: 'member.note.added', actor, guildId, payload: { noteId: note.id, targetId } }, now);
      return note;
    })),
    update: (guildId, id, body, actor) => run(client => transaction(client, async () => {
      const result = await client.query<NoteRow>(`UPDATE public.tcg_mod_notes SET body = $3, updated_at_ms = GREATEST($4, created_at_ms)
        WHERE guild_id = $1 AND id = $2 AND deleted_at_ms IS NULL RETURNING ${COLUMNS}`, [guildId, id, body, now()]);
      if (!result.rows[0]) throw noteMissing();
      const note = noteFromRow(result.rows[0]);
      await insertOpsAudit(client, { kind: 'member.note.updated', actor, guildId, payload: { noteId: id, targetId: note.targetId } }, now);
      return note;
    })),
    remove: (guildId, id, actor) => run(client => transaction(client, async () => {
      const result = await client.query<{ target_id: string }>(`UPDATE public.tcg_mod_notes SET deleted_at_ms = $3
        WHERE guild_id = $1 AND id = $2 AND deleted_at_ms IS NULL RETURNING target_id`, [guildId, id, now()]);
      if (!result.rows[0]) throw noteMissing();
      await insertOpsAudit(client, { kind: 'member.note.deleted', actor, guildId, payload: { noteId: id, targetId: result.rows[0].target_id } }, now);
    })),
    counts: (guildId, targetIds) => targetIds.length ? run(async client => {
      const result = await client.query<{ target_id: string; count: number }>(`SELECT target_id, count(*)::int AS count FROM public.tcg_mod_notes
        WHERE guild_id = $1 AND target_id = ANY($2::text[]) AND deleted_at_ms IS NULL GROUP BY target_id`, [guildId, targetIds]);
      return new Map(result.rows.map(row => [row.target_id, row.count]));
    }) : Promise.resolve(new Map())
  };
}

// ------------------------------------------------------------------ memory (tests, demo)

/** MemoryAdminCounters plus a read of the last value (the number a create will use if it succeeds). */
class PeekableCounters extends MemoryAdminCounters {
  private readonly last = new Map<string, number>();
  peek(guildId: string, name: 'case'): number { return this.last.get(guildId + ':' + name) ?? 0; }
  override next(guildId: string, name: 'case'): number {
    const value = super.next(guildId, name);
    this.last.set(guildId + ':' + name, value);
    return value;
  }
}

export class MemoryModCaseStore implements ModCaseStore {
  readonly cases: ModCaseDto[] = [];
  private readonly counters = new PeekableCounters();
  /** Serializes creates so numbers stay gap-free like the row-locked counter. */
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly audit: OpsAuditStore, private readonly now: () => number = Date.now) {}

  create(guildId: string, input: NewModCase, actor: OpsActor, perform: (number: number) => Promise<void>): Promise<ModCaseDto> {
    const next = this.chain.then(async () => {
      const number = this.counters.peek(guildId, 'case') + 1;
      await perform(number);
      this.counters.next(guildId, 'case');
      const saved: ModCaseDto = { guildId, number, kind: input.kind, targetId: input.targetId, moderatorKind: actorKind(actor),
        moderatorId: actor.id, reason: input.reason, evidenceIds: [...input.evidenceIds], eventId: input.eventId, matchId: input.matchId,
        source: input.source, createdAtMs: this.now(), expiresAtMs: input.expiresAtMs, expiryHandledAtMs: null };
      this.cases.push(saved);
      await this.audit.append({ kind: caseAuditKind(input.kind), actor, guildId, eventId: input.eventId, payload: casePayload(saved) });
      return structuredClone(saved);
    });
    this.chain = next.catch(() => {});
    return next;
  }
  async list(guildId: string, query: CaseQuery): Promise<ModCasePageDto> {
    const rows = this.cases.filter(item => item.guildId === guildId && (!query.targetId || item.targetId === query.targetId)
      && (!query.kind || item.kind === query.kind) && (!query.moderatorId || item.moderatorId === query.moderatorId)
      && (query.before == null || item.number < query.before)
      && (query.createdBeforeMs == null || item.createdAtMs < query.createdBeforeMs)).sort((a, b) => b.number - a.number);
    const cases = rows.slice(0, query.limit).map(item => structuredClone(item));
    return { cases, nextBefore: rows.length > query.limit ? cases.at(-1)!.number : null };
  }
  private find(guildId: string, number: number): ModCaseDto {
    const item = this.cases.find(entry => entry.guildId === guildId && entry.number === number);
    if (!item) throw notFound(number);
    return item;
  }
  async get(guildId: string, number: number) { return structuredClone(this.find(guildId, number)); }
  async update(guildId: string, number: number, patch: CasePatch, actor: OpsActor) {
    const item = this.find(guildId, number);
    const reasonBefore = item.reason;
    if (patch.reason !== undefined) item.reason = patch.reason;
    if (patch.evidenceIds) item.evidenceIds = [...patch.evidenceIds];
    await this.audit.append({ kind: 'member.case.updated', actor, guildId, payload: { caseNumber: number, action: 'edited',
      reasonBefore: patch.reason !== undefined ? reasonBefore : undefined, reason: patch.reason, evidenceIds: patch.evidenceIds } });
    return structuredClone(item);
  }
  async remove(guildId: string, number: number, reason: string, actor: OpsActor) {
    const item = this.find(guildId, number);
    this.cases.splice(this.cases.indexOf(item), 1);
    await this.audit.append({ kind: 'member.case.updated', actor, guildId, payload: { caseNumber: number, action: 'deleted', deleteReason: reason,
      kind: item.kind, targetId: item.targetId, reason: item.reason } });
  }
  async counts(guildId: string, targetIds: readonly string[]) {
    const counts = new Map<string, number>();
    for (const item of this.cases) if (item.guildId === guildId && targetIds.includes(item.targetId)) counts.set(item.targetId, (counts.get(item.targetId) ?? 0) + 1);
    return counts;
  }
  async latestBans(guildId: string, targetIds: readonly string[]) {
    const latest = new Map<string, ModCaseDto>();
    for (const item of this.cases) {
      if (item.guildId !== guildId || item.kind !== 'ban' || !targetIds.includes(item.targetId)) continue;
      if ((latest.get(item.targetId)?.number ?? 0) < item.number) latest.set(item.targetId, structuredClone(item));
    }
    return latest;
  }
}

export class MemoryModNoteStore implements ModNoteStore {
  private readonly notes: Array<ModNoteDto & { deleted: boolean }> = [];
  constructor(private readonly audit: OpsAuditStore, private readonly now: () => number = Date.now) {}
  private find(guildId: string, id: number) {
    const note = this.notes.find(item => item.guildId === guildId && item.id === id && !item.deleted);
    if (!note) throw noteMissing();
    return note;
  }
  private plain({ deleted: _deleted, ...note }: ModNoteDto & { deleted: boolean }): ModNoteDto { return structuredClone(note); }
  async list(guildId: string, targetId: string) {
    return this.notes.filter(item => item.guildId === guildId && item.targetId === targetId && !item.deleted).sort((a, b) => b.id - a.id)
      .map(item => this.plain(item));
  }
  async add(guildId: string, targetId: string, body: string, actor: OpsActor) {
    const at = this.now();
    const note = { id: this.notes.length + 1, guildId, targetId, authorId: actor.id, body, createdAtMs: at, updatedAtMs: at, deleted: false };
    this.notes.push(note);
    await this.audit.append({ kind: 'member.note.added', actor, guildId, payload: { noteId: note.id, targetId } });
    return this.plain(note);
  }
  async update(guildId: string, id: number, body: string, actor: OpsActor) {
    const note = this.find(guildId, id);
    note.body = body; note.updatedAtMs = Math.max(this.now(), note.createdAtMs);
    await this.audit.append({ kind: 'member.note.updated', actor, guildId, payload: { noteId: id, targetId: note.targetId } });
    return this.plain(note);
  }
  async remove(guildId: string, id: number, actor: OpsActor) {
    const note = this.find(guildId, id);
    note.deleted = true;
    await this.audit.append({ kind: 'member.note.deleted', actor, guildId, payload: { noteId: id, targetId: note.targetId } });
  }
  async counts(guildId: string, targetIds: readonly string[]) {
    const counts = new Map<string, number>();
    for (const item of this.notes) if (item.guildId === guildId && !item.deleted && targetIds.includes(item.targetId)) counts.set(item.targetId, (counts.get(item.targetId) ?? 0) + 1);
    return counts;
  }
}
