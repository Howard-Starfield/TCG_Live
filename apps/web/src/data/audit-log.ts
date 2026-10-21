import type { AuditEntryDto } from '@tcg-live/core';

/**
 * Cached audit for one event: a run of entries, ascending by sequence, without duplicates.
 * Per-event sequences start at 1 and are contiguous (only applied commands are stored).
 */
export interface AuditLog {
  entries: AuditEntryDto[];
  /** A backward page returned nothing new, so there is nothing older to load. */
  olderExhausted: boolean;
  /** The last forward HTTP page was full, so newer entries may exist (retired events). */
  hasMore: boolean;
}

/** An empty audit log. */
export const EMPTY_AUDIT_LOG: AuditLog = { entries: [], olderExhausted: false, hasMore: false };

/** Union by sequence, ascending; on a duplicate sequence the incoming entry wins. */
export function mergeAuditEntries(existing: readonly AuditEntryDto[], incoming: readonly AuditEntryDto[]): AuditEntryDto[] {
  if (incoming.length === 0) return existing as AuditEntryDto[];
  const bySequence = new Map<number, AuditEntryDto>();
  for (const entry of existing) bySequence.set(entry.sequence, entry);
  for (const entry of incoming) bySequence.set(entry.sequence, entry);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * Applies a stream `change` batch. `replace` discards the cache (new boot or event). `append` merges,
 * but if the batch starts beyond the cached tail (a gap the stream will never fill) it replaces too.
 */
export function applyStreamAudit(log: AuditLog | undefined, incoming: readonly AuditEntryDto[],
  mode: 'append' | 'replace'): AuditLog {
  const sorted = mergeAuditEntries([], incoming);
  if (mode === 'replace' || !log || log.entries.length === 0) {
    return { entries: sorted, olderExhausted: false, hasMore: false };
  }
  const last = log.entries[log.entries.length - 1]!.sequence;
  const first = sorted[0];
  if (first && first.sequence > last + 1) return { entries: sorted, olderExhausted: false, hasMore: false };
  const entries = mergeAuditEntries(log.entries, sorted);
  return entries === log.entries ? log : { ...log, entries };
}

/** True when entries before the first cached one may exist. */
export function auditHasOlder(log: AuditLog | undefined): boolean {
  if (!log || log.olderExhausted) return false;
  const first = log.entries[0];
  return first !== undefined && first.sequence > 1;
}

/** The `after`/`limit` for the page just before the cached run, or null when there is none. */
export function olderPageQuery(log: AuditLog | undefined, pageSize: number): { after: number; limit: number } | null {
  if (!auditHasOlder(log)) return null;
  const first = log!.entries[0]!.sequence;
  const after = Math.max(0, first - 1 - pageSize);
  return { after, limit: first - 1 - after };
}
