// Bulk role jobs (tcg_bulk_role_jobs): request parsing, target resolution, storage, and a paced runner.
// Member IDs are frozen when queued; progress (done + failed) is the cursor into that list, so a job that
// was running when the bot stopped resumes exactly where it left off. Per-member failures are kept in the
// target jsonb as { spec, failures } (the table has no failures column).
import type pg from 'pg';
import { ADMIN_TOOLS_LIMITS as L, BULK_ROLE_TARGET_KINDS, type BulkRoleJobDto, type BulkRoleJobStatus,
  type BulkRoleTarget, type OpsAuditKind } from '@tcg-live/core';
import type { TournamentMembers } from '../../discord/features.js';
import { OpsConflictError, OpsNotFoundError } from '../../ops/errors.js';
import { UUID } from '../../ops/http.js';
import { withClient } from '../../rehearsal/store.js';
import { requireAdminToolsSchema } from '../schema.js';
import { exactObject, fail, oneOf, reason as parseReason, shapedObject, snowflake, snowflakeList } from '../validate.js';
import { discordFailure, roleProblem, type RolesGuildPort } from './guild-port.js';
import type { BulkRoleFailureDto, BulkRoleJobDetailDto } from './types.js';

export interface BulkRoleRequest { action: 'add' | 'remove'; roleId: string; target: BulkRoleTarget; reason: string }
export interface StoredBulkJob extends BulkRoleJobDetailDto { userIds: string[]; createdBy: string }

/** Failures kept per job (the counters stay exact beyond it). */
export const MAX_STORED_FAILURES = 1000;

export function parseBulkTarget(value: unknown): BulkRoleTarget {
  const kind = oneOf((value as { kind?: unknown } | null)?.kind, BULK_ROLE_TARGET_KINDS, 'target');
  if (kind === 'ids') {
    const item = exactObject(value, ['kind', 'userIds'], 'Target');
    const userIds = snowflakeList(item.userIds, L.bulkRoleTargets, 'Member IDs');
    if (!userIds.length) fail('Paste at least one member ID.');
    return { kind, userIds };
  }
  const item = exactObject(value, ['kind', 'eventId'], 'Target');
  if (typeof item.eventId !== 'string' || !UUID.test(item.eventId)) fail('Choose a tournament.');
  return { kind, eventId: (item.eventId as string).toLowerCase() };
}

/** Strict parse; `reasonRequired` is false for the dry-run preview. */
export function parseBulkRequest(input: unknown, reasonRequired: boolean): BulkRoleRequest {
  const value = shapedObject(input, ['action', 'roleId', 'target', ...(reasonRequired ? ['reason'] : [])], reasonRequired ? [] : ['reason'], 'Bulk role job');
  return { action: oneOf(value.action, ['add', 'remove'] as const, 'action'), roleId: snowflake(value.roleId, 'Role'),
    target: parseBulkTarget(value.target),
    reason: value.reason === undefined && !reasonRequired ? 'Preview' : parseReason(value.reason) };
}

/** Discord user IDs for a target; null when the tournament is unknown. Never more than bulkRoleTargets. */
export async function resolveBulkTargets(target: BulkRoleTarget, members: (eventId: string) => Promise<TournamentMembers | null>): Promise<string[] | null> {
  if (target.kind === 'ids') return target.userIds.slice(0, L.bulkRoleTargets);
  const found = await members(target.eventId);
  if (!found) return null;
  const list = target.kind === 'checked-in' ? found.checkedIn : target.kind === 'roster' ? found.roster : found.players;
  return [...new Set(list)].slice(0, L.bulkRoleTargets);
}

export const jobDto = (job: StoredBulkJob): BulkRoleJobDto => ({ id: job.id, guildId: job.guildId, action: job.action, roleId: job.roleId,
  target: job.target, reason: job.reason, status: job.status, total: job.total, done: job.done, failed: job.failed, error: job.error,
  createdAtMs: job.createdAtMs, startedAtMs: job.startedAtMs, finishedAtMs: job.finishedAtMs });
export const jobDetail = (job: StoredBulkJob): BulkRoleJobDetailDto => ({ ...jobDto(job), failures: job.failures });

export interface BulkRoleJobStore {
  create(job: StoredBulkJob): Promise<StoredBulkJob>;
  list(guildId: string, limit: number): Promise<StoredBulkJob[]>;
  get(guildId: string, id: string): Promise<StoredBulkJob | null>;
  /** Queued and running jobs, oldest first (restart resume). */
  open(guildId: string): Promise<StoredBulkJob[]>;
  /** queued -> running; returns the job, or null when it is no longer queued/running. */
  start(guildId: string, id: string, atMs: number): Promise<StoredBulkJob | null>;
  /** Adds progress (also for the batch in flight when cancelled); returns the status afterwards (cancelled stops the runner). */
  progress(guildId: string, id: string, done: number, failures: BulkRoleFailureDto[]): Promise<BulkRoleJobStatus | null>;
  /** running -> done/failed. */
  finish(guildId: string, id: string, status: 'done' | 'failed', error: string | null, atMs: number): Promise<StoredBulkJob | null>;
  /** queued/running -> cancelled; OpsConflictError when already finished, OpsNotFoundError when unknown. */
  cancel(guildId: string, id: string, atMs: number): Promise<StoredBulkJob>;
}

const isOpen = (status: BulkRoleJobStatus) => status === 'queued' || status === 'running';
const notFound = () => new OpsNotFoundError('That bulk role job no longer exists.');
const finished = () => new OpsConflictError('That job has already finished.');

export class MemoryBulkRoleJobStore implements BulkRoleJobStore {
  private readonly jobs = new Map<string, StoredBulkJob>();
  private find(guildId: string, id: string) { const job = this.jobs.get(id); return job?.guildId === guildId ? job : undefined; }
  async create(job: StoredBulkJob) { this.jobs.set(job.id, structuredClone(job)); return structuredClone(job); }
  async list(guildId: string, limit: number) {
    return [...this.jobs.values()].filter(job => job.guildId === guildId).sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, limit).map(job => structuredClone(job));
  }
  async get(guildId: string, id: string) { const job = this.find(guildId, id); return job ? structuredClone(job) : null; }
  async open(guildId: string) {
    return [...this.jobs.values()].filter(job => job.guildId === guildId && isOpen(job.status))
      .sort((a, b) => a.createdAtMs - b.createdAtMs).map(job => structuredClone(job));
  }
  async start(guildId: string, id: string, atMs: number) {
    const job = this.find(guildId, id);
    if (!job || !isOpen(job.status)) return null;
    job.status = 'running'; job.startedAtMs ??= atMs;
    return structuredClone(job);
  }
  async progress(guildId: string, id: string, done: number, failures: BulkRoleFailureDto[]) {
    const job = this.find(guildId, id);
    if (!job) return null;
    if (job.status !== 'running' && job.status !== 'cancelled') return job.status;
    job.done += done; job.failed += failures.length;
    job.failures = [...job.failures, ...failures].slice(0, MAX_STORED_FAILURES);
    return job.status;
  }
  async finish(guildId: string, id: string, status: 'done' | 'failed', error: string | null, atMs: number) {
    const job = this.find(guildId, id);
    if (!job || job.status !== 'running') return null;
    Object.assign(job, { status, error, finishedAtMs: atMs });
    return structuredClone(job);
  }
  async cancel(guildId: string, id: string, atMs: number) {
    const job = this.find(guildId, id);
    if (!job) throw notFound();
    if (!isOpen(job.status)) throw finished();
    Object.assign(job, { status: 'cancelled', finishedAtMs: atMs });
    return structuredClone(job);
  }
}

interface JobRow { id: string; guild_id: string; action: 'add' | 'remove'; role_id: string;
  target: { spec: BulkRoleTarget; failures: BulkRoleFailureDto[] }; user_ids: string[]; reason: string; status: BulkRoleJobStatus;
  total: number; done: number; failed: number; error: string | null; created_by: string; created_at_ms: string;
  started_at_ms: string | null; finished_at_ms: string | null }
const ms = (value: string | null) => value === null ? null : Number(value);
const fromRow = (row: JobRow): StoredBulkJob => ({ id: row.id, guildId: row.guild_id, action: row.action, roleId: row.role_id,
  target: row.target.spec, failures: row.target.failures ?? [], userIds: row.user_ids, reason: row.reason, status: row.status,
  total: row.total, done: row.done, failed: row.failed, error: row.error, createdBy: row.created_by, createdAtMs: Number(row.created_at_ms),
  startedAtMs: ms(row.started_at_ms), finishedAtMs: ms(row.finished_at_ms) });
const COLUMNS = 'id, guild_id, action, role_id, target, user_ids, reason, status, total, done, failed, error, created_by, created_at_ms, started_at_ms, finished_at_ms';

export function pgBulkRoleJobStore(): BulkRoleJobStore {
  const run = <T>(work: (client: pg.Client) => Promise<T>) => withClient(async client => { await requireAdminToolsSchema(client); return work(client); });
  const one = async (client: pg.Client, sql: string, values: unknown[]) => {
    const row = (await client.query<JobRow>(sql, values)).rows[0];
    return row ? fromRow(row) : null;
  };
  return {
    create: job => run(async client => {
      await client.query(`INSERT INTO public.tcg_bulk_role_jobs (${COLUMNS}) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [job.id, job.guildId, job.action, job.roleId, JSON.stringify({ spec: job.target, failures: job.failures }), JSON.stringify(job.userIds),
          job.reason, job.status, job.total, job.done, job.failed, job.error, job.createdBy, job.createdAtMs, job.startedAtMs, job.finishedAtMs]);
      return job;
    }),
    list: (guildId, limit) => run(async client => (await client.query<JobRow>(
      `SELECT ${COLUMNS} FROM public.tcg_bulk_role_jobs WHERE guild_id = $1 ORDER BY created_at_ms DESC LIMIT $2`, [guildId, limit])).rows.map(fromRow)),
    get: (guildId, id) => run(client => one(client, `SELECT ${COLUMNS} FROM public.tcg_bulk_role_jobs WHERE guild_id = $1 AND id = $2`, [guildId, id])),
    open: guildId => run(async client => (await client.query<JobRow>(
      `SELECT ${COLUMNS} FROM public.tcg_bulk_role_jobs WHERE guild_id = $1 AND status IN ('queued', 'running') ORDER BY created_at_ms`, [guildId])).rows.map(fromRow)),
    start: (guildId, id, atMs) => run(client => one(client, `UPDATE public.tcg_bulk_role_jobs SET status = 'running',
      started_at_ms = COALESCE(started_at_ms, $3) WHERE guild_id = $1 AND id = $2 AND status IN ('queued', 'running') RETURNING ${COLUMNS}`, [guildId, id, atMs])),
    progress: (guildId, id, done, failures) => run(async client => {
      const updated = await client.query<{ status: BulkRoleJobStatus }>(`UPDATE public.tcg_bulk_role_jobs SET done = done + $3, failed = failed + $4,
        target = jsonb_set(target, '{failures}', (SELECT COALESCE(jsonb_agg(item), '[]'::jsonb) FROM (SELECT item FROM jsonb_array_elements(
          COALESCE(target->'failures', '[]'::jsonb) || $5::jsonb) AS item LIMIT ${MAX_STORED_FAILURES}) AS kept))
        WHERE guild_id = $1 AND id = $2 AND status IN ('running', 'cancelled') RETURNING status`, [guildId, id, done, failures.length, JSON.stringify(failures)]);
      if (updated.rows[0]) return updated.rows[0].status;
      return (await client.query<{ status: BulkRoleJobStatus }>('SELECT status FROM public.tcg_bulk_role_jobs WHERE guild_id = $1 AND id = $2',
        [guildId, id])).rows[0]?.status ?? null;
    }),
    finish: (guildId, id, status, error, atMs) => run(client => one(client, `UPDATE public.tcg_bulk_role_jobs SET status = $3, error = $4,
      finished_at_ms = $5 WHERE guild_id = $1 AND id = $2 AND status = 'running' RETURNING ${COLUMNS}`, [guildId, id, status, error, atMs])),
    cancel: (guildId, id, atMs) => run(async client => {
      const job = await one(client, `UPDATE public.tcg_bulk_role_jobs SET status = 'cancelled', finished_at_ms = $3
        WHERE guild_id = $1 AND id = $2 AND status IN ('queued', 'running') RETURNING ${COLUMNS}`, [guildId, id, atMs]);
      if (job) return job;
      const exists = await one(client, `SELECT ${COLUMNS} FROM public.tcg_bulk_role_jobs WHERE guild_id = $1 AND id = $2`, [guildId, id]);
      throw exists ? finished() : notFound();
    })
  };
}

export interface BulkRoleRunnerOptions {
  store: BulkRoleJobStore;
  guildId: string;
  port(): Promise<RolesGuildPort>;
  /** Members changed at once; discord.js still queues each request behind its rate-limit buckets. */
  concurrency?: number;
  /** Pause between batches (rate-limit friendly pacing). */
  pauseMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  isActive?(): boolean;
  audit?(kind: OpsAuditKind, payload: Record<string, unknown>): Promise<unknown>;
  log?(message: string): void;
}

export const BULK_ROLE_CONCURRENCY = 2;
export const BULK_ROLE_PAUSE_MS = 400;
const defaultSleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** Runs open jobs one at a time. kick() is safe to call any time; stop() leaves a running job resumable. */
export class BulkRoleRunner {
  private loop: Promise<void> | null = null;
  /** A storage failure is logged once per outage (the resume timer retries every minute; migration 013 may be missing). */
  private storageFailing = false;
  private again = false;
  private stopped = false;
  constructor(private readonly options: BulkRoleRunnerOptions) {}

  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.loop) { this.again = true; return this.loop; }
    this.loop = (async () => {
      try {
        do { this.again = false; await this.drain(); } while (this.again && this.active());
        this.storageFailing = false;
      } catch {
        if (!this.storageFailing) this.options.log?.('Bulk roles: a job paused after a storage error; it resumes on the next change or restart.');
        this.storageFailing = true;
      }
      finally { this.loop = null; }
    })();
    return this.loop;
  }
  stop(): void { this.stopped = true; }
  private active() { return !this.stopped && (this.options.isActive?.() ?? true); }

  private async drain(): Promise<void> {
    for (const job of await this.options.store.open(this.options.guildId)) {
      if (!this.active()) return;
      await this.run(job);
    }
  }

  private async run(queued: StoredBulkJob): Promise<void> {
    const { store, guildId } = this.options;
    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? defaultSleep;
    const size = Math.max(1, this.options.concurrency ?? BULK_ROLE_CONCURRENCY);
    const job = await store.start(guildId, queued.id, now());
    if (!job) return;
    let port: RolesGuildPort;
    try { port = await this.options.port(); }
    catch { return; /* Discord offline: stays running and resumes later. */ }
    // Re-checked when the job runs (it may have been queued while Discord was offline, or the role changed since):
    // never hand out a managed, too-high or staff role.
    let problem: string | null;
    try {
      const { roles, botTopPosition } = await port.roles();
      problem = roleProblem(roles.find(role => role.id === job.roleId), guildId, botTopPosition);
    } catch { return; /* Discord offline: resumes later. */ }
    if (problem) {
      const failed = await store.finish(guildId, job.id, 'failed', `The bot cannot ${job.action} that role (${problem}).`, now());
      if (failed) await this.options.audit?.('bulk_roles.finished', { jobId: failed.id, roleId: failed.roleId, action: failed.action,
        status: failed.status, total: failed.total, done: failed.done, failed: failed.failed, refused: problem }).catch(() => {});
      return;
    }
    let cursor = job.done + job.failed;
    while (cursor < job.userIds.length) {
      if (!this.active()) return;
      if ((await store.get(guildId, job.id))?.status !== 'running') return; // Cancelled from the dashboard.
      const batch = job.userIds.slice(cursor, cursor + size);
      const results = await Promise.all(batch.map(async userId => {
        try {
          if (job.action === 'add') await port.addRole(userId, job.roleId, job.reason);
          else await port.removeRole(userId, job.roleId, job.reason);
          return null;
        } catch (error) { return { userId, error: discordFailure(error) }; }
      }));
      const failures = results.filter((item): item is BulkRoleFailureDto => item !== null);
      const status = await store.progress(guildId, job.id, batch.length - failures.length, failures);
      cursor += batch.length;
      if (status !== 'running') return; // Cancelled from the dashboard.
      if (cursor < job.userIds.length) await sleep(this.options.pauseMs ?? BULK_ROLE_PAUSE_MS);
    }
    const final = await store.get(guildId, job.id);
    const allFailed = !!final && final.total > 0 && final.failed === final.total;
    const done = await store.finish(guildId, job.id, allFailed ? 'failed' : 'done', allFailed ? 'Every member failed; see the failures.' : null, now());
    if (done) await this.options.audit?.('bulk_roles.finished', { jobId: done.id, roleId: done.roleId, action: done.action,
      status: done.status, total: done.total, done: done.done, failed: done.failed }).catch(() => {});
  }
}
