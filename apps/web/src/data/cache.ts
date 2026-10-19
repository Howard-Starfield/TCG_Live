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

/** True when `candidate` is at least as new as `current` (version, then panel revision). */
export function isSnapshotNewer(candidate: EventSnapshotDto, current: EventSnapshotDto | undefined): boolean {
  if (!current) return true;
  if (candidate.version !== current.version) return candidate.version > current.version;
  return candidate.panelRevision >= current.panelRevision;
}

function summaryFrom(snapshot: EventSnapshotDto): EventSummaryDto {
  return { eventId: snapshot.eventId, status: snapshot.status, kind: snapshot.kind,
    createdAtMs: snapshot.createdAtMs, retiredAtMs: snapshot.retiredAtMs, version: snapshot.version };
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
