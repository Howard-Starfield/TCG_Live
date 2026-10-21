import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { AUDIT_PAGE_LIMIT, type AuditEntryDto, type Capability, type EventSnapshotDto,
  type EventSummaryDto, type RuntimeStatusDto, type SessionDto } from '@tcg-live/core';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useAdminData, type AdminData } from './admin-data';
import { auditHasOlder, mergeAuditEntries, olderPageQuery, type AuditLog } from './audit-log';
import { adminKeys, INACTIVE_EVENT_GC_MS, isSnapshotNewer } from './cache';
import { ApiError } from './errors';
import type { SessionState } from './session';
import type { StreamConnection } from './stream';

// ---------------------------------------------------------------- session

/** What `useSession()` returns. */
export interface SessionApi {
  state: SessionState;
  status: SessionState['status'];
  /** The signed-in session, or null. */
  session: SessionDto | null;
  /** Signs in with a pasted console link or launch token. */
  login(linkOrToken: string): Promise<void>;
  /** Ends the session and returns to signed-out. */
  logout(): Promise<void>;
  /** Prints a fresh console link in the server terminal; rejects with ApiError on failure. */
  rotateLink(): Promise<void>;
  /** Retries after an error state. */
  retry(): Promise<void>;
  hasCapability(capability: Capability): boolean;
}

/** The session state machine (`signed-out` | `signing-in` | `signed-in` | `error`) and its actions. */
export function useSession(): SessionApi {
  const { session } = useAdminData();
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  // Stable while the state is unchanged, so actions can sit in effect dependency lists.
  return useMemo<SessionApi>(() => ({
    state,
    status: state.status,
    session: state.status === 'signed-in' ? state.session : null,
    login: linkOrToken => session.login(linkOrToken),
    logout: () => session.logout(),
    rotateLink: () => session.rotateLink(),
    retry: () => session.retry(),
    hasCapability: capability => state.status === 'signed-in' && state.session.capabilities.includes(capability)
  }), [session, state]);
}

function useSignedIn(data: AdminData): boolean {
  const state = useSyncExternalStore(data.session.subscribe, data.session.getState, data.session.getState);
  return state.status === 'signed-in';
}

// ---------------------------------------------------------------- stream

/** Live stream connection state plus a manual reconnect action. */
export function useStreamConnection(): StreamConnection & { reconnect(): void } {
  const { stream } = useAdminData();
  const connection = useSyncExternalStore(stream.subscribe, stream.getSnapshot, stream.getSnapshot);
  return { ...connection, reconnect: () => stream.reconnectNow() };
}

// ---------------------------------------------------------------- queries

/** Runtime status: fetched once, then kept current by `hello` and `status` stream events. */
export function useRuntimeStatus(): UseQueryResult<RuntimeStatusDto> {
  const data = useAdminData();
  const signedIn = useSignedIn(data);
  return useQuery({
    queryKey: adminKeys.status(),
    queryFn: ({ signal }) => data.api.getStatus(signal),
    enabled: signedIn
  });
}

/** Session-backed events, newest first; refreshed on every `hello` and when a new event appears. */
export function useEvents(): UseQueryResult<EventSummaryDto[]> {
  const data = useAdminData();
  const signedIn = useSignedIn(data);
  return useQuery({
    queryKey: adminKeys.events(),
    queryFn: ({ signal }) => data.api.listEvents(signal),
    enabled: signedIn
  });
}

/**
 * The active event's ID: from the stream once `hello` arrived, otherwise from the events list.
 * Null when no event is active.
 */
export function useActiveEventId(): string | null {
  const connection = useStreamConnection();
  const events = useEvents();
  if (connection.helloReceived) return connection.activeEventId;
  return events.data?.find(item => item.status === 'active')?.eventId ?? null;
}

/**
 * One event's snapshot. The active event's snapshot is pushed by the stream; retired events (and the
 * active one before the stream delivers) are fetched over HTTP. A fetched snapshot never replaces a
 * newer cached one.
 */
export function useEventSnapshot(eventId: string | null | undefined): UseQueryResult<EventSnapshotDto> {
  const data = useAdminData();
  const signedIn = useSignedIn(data);
  const id = eventId ?? '';
  const activeId = useSyncExternalStore(data.stream.subscribe, () => data.stream.getSnapshot().activeEventId,
    () => data.stream.getSnapshot().activeEventId);
  return useQuery({
    queryKey: adminKeys.snapshot(id),
    // The stream keeps the active event's cache current; other events are re-read when needed.
    gcTime: eventId && eventId === activeId ? Infinity : INACTIVE_EVENT_GC_MS,
    queryFn: async ({ signal }) => {
      const fetched = await data.api.getSnapshot(id, signal);
      const cached = data.queryClient.getQueryData<EventSnapshotDto>(adminKeys.snapshot(id));
      return cached && !isSnapshotNewer(fetched, cached) ? cached : fetched;
    },
    enabled: signedIn && !!eventId
  });
}

/** The active event's snapshot. */
export interface ActiveSnapshot {
  eventId: string | null;
  snapshot: EventSnapshotDto | undefined;
  /** `none`: no active event. */
  status: 'none' | 'loading' | 'ready' | 'error';
  error: Error | null;
}

/** The active event's live snapshot (stream-fed). */
export function useActiveSnapshot(): ActiveSnapshot {
  const eventId = useActiveEventId();
  const query = useEventSnapshot(eventId);
  if (!eventId) return { eventId: null, snapshot: undefined, status: 'none', error: null };
  if (query.data) return { eventId, snapshot: query.data, status: 'ready', error: null };
  if (query.error) return { eventId, snapshot: undefined, status: 'error', error: query.error };
  return { eventId, snapshot: undefined, status: 'loading', error: null };
}

// ---------------------------------------------------------------- audit

/** What `useAudit()` returns. Entries are ascending by sequence (newest last). */
export interface AuditView {
  entries: AuditEntryDto[];
  /** True while the first load is pending. */
  isLoading: boolean;
  error: Error | null;
  /** The list is fed by the live stream (the active event). */
  live: boolean;
  /** Older entries exist before `entries[0]` (load them with `fetchOlder`). */
  hasOlder: boolean;
  /** Newer entries may exist after the last one (retired events; load with `fetchMore`). */
  hasMore: boolean;
  isFetchingOlder: boolean;
  isFetchingMore: boolean;
  /** The last `fetchOlder`/`fetchMore` failure, cleared by the next success. */
  pageError: ApiError | null;
  /** Loads the page before the first entry. */
  fetchOlder(): Promise<void>;
  /** Loads the page after the last entry. */
  fetchMore(): Promise<void>;
}

/** Fetches the first audit page and merges it with whatever the stream already cached. */
async function loadAuditHead(data: AdminData, eventId: string, signal: AbortSignal): Promise<AuditLog> {
  const key = adminKeys.audit(eventId);
  const cached = data.queryClient.getQueryData<AuditLog>(key);
  const connection = data.stream.getSnapshot();
  if (cached && connection.state === 'live' && connection.activeEventId === eventId) return cached;
  const page = await data.api.getAudit(eventId, { after: 0, limit: AUDIT_PAGE_LIMIT }, signal);
  const latest = data.queryClient.getQueryData<AuditLog>(key);
  const pageLast = page[page.length - 1]?.sequence ?? 0;
  const latestFirst = latest?.entries[0]?.sequence;
  if (latest && latestFirst !== undefined && pageLast < latestFirst - 1) {
    return latest;   // the stream's tail is far past this page; keep the contiguous tail
  }
  const entries = mergeAuditEntries(latest?.entries ?? [], page);
  return {
    entries,
    olderExhausted: latest?.olderExhausted ?? false,
    hasMore: page.length >= AUDIT_PAGE_LIMIT && entries[entries.length - 1]?.sequence === pageLast
  };
}

function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error
    : new ApiError({ code: 'network', status: 0, message: 'Could not load audit entries.', cause: error });
}

/**
 * An event's audit log. For the active event it is stream-fed (the stream delivers the last 200 and
 * every new entry; `fetchOlder` backfills). For retired events it is paged over HTTP from the start
 * (`fetchMore` loads further pages).
 */
export function useAudit(eventId: string | null | undefined, pageSize: number = AUDIT_PAGE_LIMIT): AuditView {
  const data = useAdminData();
  const signedIn = useSignedIn(data);
  const connection = useSyncExternalStore(data.stream.subscribe, data.stream.getSnapshot, data.stream.getSnapshot);
  const id = eventId ?? '';
  const query = useQuery({
    queryKey: adminKeys.audit(id),
    gcTime: eventId && eventId === connection.activeEventId ? Infinity : INACTIVE_EVENT_GC_MS,
    queryFn: ({ signal }) => loadAuditHead(data, id, signal),
    enabled: signedIn && !!eventId
  });
  const [isFetchingOlder, setFetchingOlder] = useState(false);
  const [isFetchingMore, setFetchingMore] = useState(false);
  const [pageError, setPageError] = useState<ApiError | null>(null);
  const inFlight = useRef({ older: false, more: false });
  const limit = Math.max(1, Math.min(AUDIT_PAGE_LIMIT, pageSize));

  const fetchOlder = useCallback(async () => {
    if (!id || inFlight.current.older) return;
    const key = adminKeys.audit(id);
    const pageQuery = olderPageQuery(data.queryClient.getQueryData<AuditLog>(key), limit);
    if (!pageQuery) return;
    inFlight.current.older = true;
    setFetchingOlder(true);
    try {
      const page = await data.api.getAudit(id, pageQuery);
      data.queryClient.setQueryData<AuditLog>(key, latest => {
        if (!latest) return latest;
        const before = latest.entries[0]?.sequence ?? Infinity;
        const entries = mergeAuditEntries(latest.entries, page);
        const gained = (entries[0]?.sequence ?? Infinity) < before;
        return { ...latest, entries, olderExhausted: !gained };
      });
      setPageError(null);
    } catch (error) {
      setPageError(toApiError(error));
    } finally {
      inFlight.current.older = false;
      setFetchingOlder(false);
    }
  }, [data, id, limit]);

  const fetchMore = useCallback(async () => {
    if (!id || inFlight.current.more) return;
    const key = adminKeys.audit(id);
    const log = data.queryClient.getQueryData<AuditLog>(key);
    const after = log?.entries[log.entries.length - 1]?.sequence ?? 0;
    inFlight.current.more = true;
    setFetchingMore(true);
    try {
      const page = await data.api.getAudit(id, { after, limit });
      data.queryClient.setQueryData<AuditLog>(key, latest => {
        const base = latest ?? { entries: [], olderExhausted: false, hasMore: false };
        return { ...base, entries: mergeAuditEntries(base.entries, page), hasMore: page.length >= limit };
      });
      setPageError(null);
    } catch (error) {
      setPageError(toApiError(error));
    } finally {
      inFlight.current.more = false;
      setFetchingMore(false);
    }
  }, [data, id, limit]);

  const log = query.data;
  const live = !!eventId && connection.activeEventId === eventId && connection.state === 'live';
  return {
    entries: log?.entries ?? [],
    isLoading: !!eventId && signedIn && !log && query.isPending,
    error: query.error,
    live,
    hasOlder: auditHasOlder(log),
    hasMore: !live && (log?.hasMore ?? false),
    isFetchingOlder,
    isFetchingMore,
    pageError,
    fetchOlder,
    fetchMore
  };
}
