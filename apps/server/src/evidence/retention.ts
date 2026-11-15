// Hourly evidence retention. Deletes evidence once its event has ended and the configured retention
// (7, 30, custom days, or never) has passed. Held items and matches with an open dispute or judge call
// are skipped. Each deletion is a soft delete (audited as evidence.deleted, reason 'retention') plus
// removal of the file. Runs as a Discord feature so only the runtime holding the database lease acts.
import type { ModerationSettingsDto } from '@tcg-live/core';
import type { DiscordFeature, DiscordFeatureContext } from '../discord/features.js';
import type { OpsActor } from '../ops/audit.js';
import { EvidenceFiles, sharedEvidenceFiles } from './files.js';
import { pgEvidenceRetentionSource, type EvidenceRecord, type EvidenceRetentionSource, type EvidenceStore,
  type RetentionCandidate } from './store.js';

export const RETENTION_INTERVAL_MS = 60 * 60_000;
export const RETENTION_FIRST_RUN_MS = 60_000;
export const RETENTION_REASON = 'retention';
export const RETENTION_ACTOR: OpsActor = Object.freeze({ kind: 'system', id: 'retention' });
const DAY_MS = 24 * 60 * 60_000;
const BATCH = 200;
/** Deleted rows whose file removal is retried for this long. */
const FILE_RETRY_WINDOW_MS = 2 * DAY_MS;
/**
 * A non-voice row still 'pending' this long after creation was interrupted by a crash: an upload reserves
 * its row only after the whole file is on disk, then renames and marks it stored within seconds.
 */
export const STALE_PENDING_MS = 15 * 60_000;
export const STALE_PENDING_REASON = 'The upload was interrupted (the server stopped before it finished).';

export interface StalePendingSweepOptions {
  source: Pick<EvidenceRetentionSource, 'stalePendingUploads'>;
  store: Pick<EvidenceStore, 'markFailed'>;
  removeFile(record: EvidenceRecord): Promise<void>;
  now?: () => number;
}

/**
 * Marks interrupted non-voice uploads failed (audited as evidence.failed) and removes any file they left,
 * so the quota account matches what is stored. Voice rows are recovered by the voice recorder instead.
 * Returns how many rows were marked failed.
 */
export async function sweepStalePending(options: StalePendingSweepOptions): Promise<number> {
  if (!options.source.stalePendingUploads) return 0;
  const now = (options.now ?? Date.now)();
  let failed = 0;
  for (const record of await options.source.stalePendingUploads(now - STALE_PENDING_MS, BATCH)) {
    if (record.kind === 'voice' || record.status !== 'pending') continue;
    try { await options.store.markFailed(record.id, STALE_PENDING_REASON, RETENTION_ACTOR); }
    catch { continue; }   // Stored or failed since the query.
    failed++;
    try { await options.removeFile(record); } catch { /* A locked file is retried on the next sweep's temp pass. */ }
  }
  return failed;
}

/** True when the candidate may be deleted now. `days` null means never. */
export function retentionDue(candidate: RetentionCandidate, days: number | null, nowMs: number): boolean {
  if (days === null || !Number.isSafeInteger(days) || days < 1) return false;
  const { record } = candidate;
  if (record.hold || record.status === 'deleted' || candidate.matchOpen || candidate.eventEndedAtMs === null) return false;
  return candidate.eventEndedAtMs + days * DAY_MS <= nowMs;
}

export interface RetentionRunOptions {
  source: EvidenceRetentionSource;
  store: Pick<EvidenceStore, 'softDelete'>;
  removeFile(record: EvidenceRecord): Promise<void>;
  settings(): Promise<Pick<ModerationSettingsDto, 'retention'>>;
  now?: () => number;
  /** Checked between deletions; false stops the run early. */
  isActive?: () => boolean;
}
export interface RetentionRunResult { deleted: number; skipped: number; filesChecked: number }

export async function runRetention(options: RetentionRunOptions): Promise<RetentionRunResult> {
  const now = (options.now ?? Date.now)();
  const active = options.isActive ?? (() => true);
  const result: RetentionRunResult = { deleted: 0, skipped: 0, filesChecked: 0 };
  // Earlier removals that failed (for example a file locked by a player on Windows).
  for (const record of await options.source.deletedWithFiles(now - FILE_RETRY_WINDOW_MS, BATCH)) {
    if (!active()) return result;
    try { await options.removeFile(record); result.filesChecked++; } catch { /* Next hour. */ }
  }
  const days = (await options.settings()).retention.days;
  if (days === null) return result;
  for (const candidate of await options.source.candidates(now - days * DAY_MS, BATCH)) {
    if (!active()) break;
    if (!retentionDue(candidate, days, now)) { result.skipped++; continue; }
    let record: EvidenceRecord;
    try { record = await options.store.softDelete(candidate.record.id, RETENTION_REASON, RETENTION_ACTOR); }
    catch { result.skipped++; continue; }   // Held since the query, or already gone.
    result.deleted++;
    try { await options.removeFile(record); } catch { /* Retried by deletedWithFiles next run. */ }
  }
  return result;
}

export interface RetentionFeatureOptions {
  source?: EvidenceRetentionSource;
  files?: EvidenceFiles;
  intervalMs?: number;
  firstRunMs?: number;
  now?: () => number;
}

/** Registered in feature-registry.ts. Timers are unref'd and cleared on stop. */
export function evidenceRetentionFeature(options: RetentionFeatureOptions = {}): DiscordFeature & { runOnce(): Promise<RetentionRunResult | null> } {
  let context: DiscordFeatureContext | undefined;
  let interval: NodeJS.Timeout | undefined;
  let first: NodeJS.Timeout | undefined;
  let running: Promise<RetentionRunResult | null> | undefined;
  /** One line per failure streak, so an install without migration 012 does not log every hour. */
  let failing = false;
  // The shared instance, so removals leave the same quota account uploads and recordings count against.
  const files = options.files ?? sharedEvidenceFiles();
  const source = options.source ?? pgEvidenceRetentionSource();
  const runOnce = (): Promise<RetentionRunResult | null> => {
    const ctx = context;
    if (!ctx || !ctx.isActive()) return Promise.resolve(null);
    running ??= (async () => {
      try {
        await files.sweepTemp();
        const interrupted = await sweepStalePending({ source, store: ctx.evidence, removeFile: record => files.removeFile(record),
          ...(options.now ? { now: options.now } : {}) }).catch(() => 0);
        if (interrupted) ctx.log(`Evidence: marked ${interrupted} interrupted upload(s) failed.`);
        const result = await runRetention({ source, store: ctx.evidence, removeFile: record => files.removeFile(record),
          settings: () => ctx.moderationSettings(), isActive: () => ctx.isActive(), ...(options.now ? { now: options.now } : {}) });
        failing = false;
        if (result.deleted) ctx.log(`Evidence retention deleted ${result.deleted} item(s).`);
        return result;
      } catch {
        if (!failing) ctx.log('Evidence retention pass failed; retrying every hour.');
        failing = true;
        return null;
      } finally { running = undefined; }
    })();
    return running;
  };
  return {
    name: 'evidence-retention',
    start(ctx) {
      context = ctx;
      first = setTimeout(() => { void runOnce(); }, options.firstRunMs ?? RETENTION_FIRST_RUN_MS);
      first.unref();
      interval = setInterval(() => { void runOnce(); }, options.intervalMs ?? RETENTION_INTERVAL_MS);
      interval.unref();
    },
    async stop() {
      if (first) clearTimeout(first);
      if (interval) clearInterval(interval);
      context = undefined;
      await running;
    },
    runOnce
  };
}
