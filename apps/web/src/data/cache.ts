import { QueryClient } from '@tanstack/react-query';
import type { EventSnapshotDto, EventSummaryDto, RuntimeStatusDto, StreamEventDto } from '@tcg-live/core';
import { applyStreamAudit, type AuditLog } from './audit-log';
import type { ServerClock } from './clock';
import { ApiError } from './errors';
import type { StreamEventInfo } from './stream';

/** TanStack Query keys for admin data. Everything lives under `['admin']`. */
export const adminKeys = {
  all: ['admin'] as const,
  status: () => ['admin', 'status'] as const,
  events: () => ['admin', 'events'] as const,
  snapshots: () => ['admin', 'snapshot'] as const,
  snapshot: (eventId: string) => ['admin', 'snapshot', eventId] as const,
  audits: () => ['admin', 'audit'] as const,
  audit: (eventId: string) => ['admin', 'audit', eventId] as const
};

/**
 * QueryClient tuned for stream-fed data: nothing goes stale on its own (the stream pushes changes),
 * nothing is garbage-collected (the stream may append to an unobserved audit log), and client
 * errors (4xx) are never retried.
 */
export function createAdminQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: (failureCount, error) =>
          !(error instanceof ApiError && !error.isTransient) && failureCount < 2
      },
      mutations: { retry: false }
    }
  });
}

/**
 * True when `candidate` is at least as new as `current` (version, then panel revision). Retirement is
 * final and does not bump the version, and retired snapshots carry panel revision 0, so at the same
 * version the retired copy always wins over the active one.
 */
export function isSnapshotNewer(candidate: EventSnapshotDto, current: EventSnapshotDto | undefined): boolean {
  if (!current) return true;
  if (candidate.version !== current.version) return candidate.version > current.version;
  if (candidate.status !== current.status) return candidate.status === 'retired';
  return candidate.panelRevision >= current.panelRevision;
}

function summaryFrom(snapshot: EventSnapshotDto): EventSummaryDto {
  return { eventId: snapshot.eventId, status: snapshot.status, kind: snapshot.kind,
    createdAtMs: snapshot.createdAtMs, retiredAtMs: snapshot.retiredAtMs, version: snapshot.version };
}

/** How long an unobserved snapshot or audit log of a non-active event stays cached. */
export const INACTIVE_EVENT_GC_MS = 5 * 60_000;

/**
 * A new event became active: the stream no longer updates the previous one, whose cached snapshot
 * still says `active`. Observed queries refetch (they are retired now); unobserved ones are dropped,
 * so they neither show stale state later nor stay cached forever.
 */
function releasePreviousActive(queryClient: QueryClient, activeEventId: string): void {
  const cache = queryClient.getQueryCache();
  for (const [key, snapshot] of queryClient.getQueriesData<EventSnapshotDto>({ queryKey: adminKeys.snapshots() })) {
    if (!snapshot || snapshot.status !== 'active' || snapshot.eventId === activeEventId) continue;
    for (const queryKey of [key, adminKeys.audit(snapshot.eventId)]) {
      const query = cache.find({ queryKey, exact: true });
      if (!query) continue;
      if (query.getObserversCount() > 0) void queryClient.invalidateQueries({ queryKey, exact: true });
      else queryClient.removeQueries({ queryKey, exact: true });
    }
  }
}

/** Applies one stream event to the query cache and the server clock. */
export function applyStreamEvent(queryClient: QueryClient, clock: ServerClock, event: StreamEventDto,
  info: StreamEventInfo): void {
  switch (event.type) {
    case 'hello': {
      clock.observe(event.status.serverTimeMs, info.receivedAtMs);
      if (info.bootChanged) {
        // The server restarted: every cached snapshot and audit run may be from another world
        // (the demo runtime starts over). Reset them; mounted queries refetch, the stream refills.
        void queryClient.resetQueries({ queryKey: adminKeys.snapshots() });
        void queryClient.resetQueries({ queryKey: adminKeys.audits() });
      }
      queryClient.setQueryData<RuntimeStatusDto>(adminKeys.status(), event.status);
      void queryClient.invalidateQueries({ queryKey: adminKeys.events() });
      return;
    }
    case 'change': {
      if (event.snapshot.status === 'active') releasePreviousActive(queryClient, event.eventId);
      queryClient.setQueryData<EventSnapshotDto>(adminKeys.snapshot(event.eventId), event.snapshot);
      queryClient.setQueryData<AuditLog>(adminKeys.audit(event.eventId),
        log => applyStreamAudit(log, event.audit, info.auditMode));
      const list = queryClient.getQueryData<EventSummaryDto[]>(adminKeys.events());
      if (list && list.some(item => item.eventId === event.eventId)) {
        queryClient.setQueryData<EventSummaryDto[]>(adminKeys.events(),
          list.map(item => (item.eventId === event.eventId ? summaryFrom(event.snapshot) : item)));
      } else {
        void queryClient.invalidateQueries({ queryKey: adminKeys.events() });
      }
      return;
    }
    case 'status':
      clock.observe(event.status.serverTimeMs, info.receivedAtMs);
      queryClient.setQueryData<RuntimeStatusDto>(adminKeys.status(), event.status);
      return;
    case 'heartbeat':
      clock.observe(event.serverTimeMs, info.receivedAtMs);
      return;
  }
}
