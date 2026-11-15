// Moderation and ops-audit API calls. The server pages flags and ops audit oldest first after a cursor;
// views reverse them for display. No stream event carries flags, so the flags view polls with backoff.
import { useQuery } from '@tanstack/react-query';
import { MODERATION_FLAG_PAGE_LIMIT, type AddVoiceBotRequestDto, type AutoModSyncResultDto, type ModerationFlagDto,
  type ModerationFlagPageDto, type ModerationSettingsBodyDto, type ModerationSettingsConflictDto,
  type ModerationSettingsDto, type OpsAuditEntryDto, type OpsAuditPageDto, type VoiceBotPoolDto } from '@tcg-live/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, useAdminData, useSession, type ApiClient } from '../../data';
import { describeError, retryTransient } from '../evidence/api';

/** True when the runtime mounts the moderation routes and this session may manage them. */
export function useModerationAccess(): boolean {
  const session = useSession();
  return session.session?.moderation === true && session.hasCapability('moderation.manage');
}

export const getModerationSettings = (api: ApiClient, signal?: AbortSignal) =>
  api.request<ModerationSettingsDto>('GET', '/moderation/settings', signal ? { signal } : {});

export type SaveSettingsResult =
  | { ok: true; settings: ModerationSettingsDto }
  | { ok: false; conflict: ModerationSettingsDto; message: string };

/** PUT with optimistic concurrency; a 409 resolves with the server's current state instead of throwing. */
export async function saveModerationSettings(api: ApiClient, expectedVersion: number,
  settings: ModerationSettingsBodyDto): Promise<SaveSettingsResult> {
  try {
    const saved = await api.request<ModerationSettingsDto>('PUT', '/moderation/settings', { body: { expectedVersion, settings } });
    return { ok: true, settings: saved };
  } catch (error) {
    const body = error instanceof ApiError && error.status === 409 ? error.body as Partial<ModerationSettingsConflictDto> | null : null;
    if (body?.current) return { ok: false, conflict: body.current, message: error instanceof Error ? error.message : 'Conflict' };
    throw error;
  }
}

export const syncAutoMod = (api: ApiClient) => api.request<AutoModSyncResultDto>('POST', '/moderation/automod/sync');
export const getVoiceBots = (api: ApiClient, signal?: AbortSignal) =>
  api.request<VoiceBotPoolDto>('GET', '/moderation/voice-bots', signal ? { signal } : {});
export const addVoiceBot = (api: ApiClient, body: AddVoiceBotRequestDto) =>
  api.request<VoiceBotPoolDto>('POST', '/moderation/voice-bots', { body });
export const removeVoiceBot = (api: ApiClient, id: string) =>
  api.request<VoiceBotPoolDto>('DELETE', `/moderation/voice-bots/${encodeURIComponent(id)}`);

export function getFlagPage(api: ApiClient, after: number, limit: number, signal?: AbortSignal,
  filter: { eventId?: string; matchId?: string } = {}): Promise<ModerationFlagPageDto> {
  const params = new URLSearchParams({ after: String(after), limit: String(limit) });
  if (filter.eventId) params.set('eventId', filter.eventId);
  if (filter.matchId) params.set('matchId', filter.matchId);
  return api.request<ModerationFlagPageDto>('GET', `/moderation/flags?${params}`, signal ? { signal } : {});
}

export function getOpsAuditPage(api: ApiClient, query: { after: number; limit: number; eventId?: string },
  signal?: AbortSignal): Promise<OpsAuditPageDto> {
  const params = new URLSearchParams({ after: String(query.after), limit: String(query.limit) });
  if (query.eventId) params.set('eventId', query.eventId);
  return api.request<OpsAuditPageDto>('GET', `/ops/audit?${params}`, signal ? { signal } : {});
}

/** Pages (200 flags each) of one match's flags the drawer loads at most. */
export const MATCH_FLAG_MAX_PAGES = 5;

/** Volume flags for one match (filtered by the server on eventId and matchId), for markers in the evidence drawer. */
export function useMatchVolumeFlags(eventId: string, matchId: string, enabled: boolean) {
  const { api } = useAdminData();
  const access = useModerationAccess();
  return useQuery({
    queryKey: ['admin', 'moderation', 'flags', 'match', eventId, matchId],
    queryFn: async ({ signal }) => {
      const found: Array<Extract<ModerationFlagDto, { kind: 'volume' }>> = [];
      let after = 0;
      for (let pageIndex = 0; pageIndex < MATCH_FLAG_MAX_PAGES; pageIndex += 1) {
        const page = await getFlagPage(api, after, MODERATION_FLAG_PAGE_LIMIT, signal, { eventId, matchId });
        for (const flag of page.flags) {
          if (flag.kind === 'volume' && flag.eventId === eventId && flag.matchId === matchId) found.push(flag);
        }
        if (page.flags.length < MODERATION_FLAG_PAGE_LIMIT || page.nextAfter <= after) break;
        after = page.nextAfter;
      }
      return found;
    },
    enabled: enabled && access,
    staleTime: 15_000,
    retry: retryTransient
  });
}

// ---------------------------------------------------------------- cursor paging with polling

export interface CursorFeed<T> {
  /** Ascending by id, as the server sends them. */
  items: T[];
  loading: boolean;
  error: string | null;
  /** 501: the route exists in the contract but this server does not ship it yet. */
  unavailable: boolean;
  /** The last page was full: newer items wait behind the cursor. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
}

export interface CursorFeedOptions<T> {
  fetchPage(after: number, limit: number, signal: AbortSignal): Promise<{ items: T[]; nextAfter: number }>;
  limit: number;
  enabled: boolean;
  /** Poll for newer items while caught up: starts at `minMs`, doubles while nothing new arrives. */
  poll?: { minMs: number; maxMs: number };
  /** Resets the feed when it changes. */
  resetKey?: string;
}

/** Oldest-first cursor paging (`after` / `nextAfter`) with optional polling and backoff. */
export function useCursorFeed<T>({ fetchPage, limit, enabled, poll, resetKey = '' }: CursorFeedOptions<T>): CursorFeed<T> {
  const [items, setItems] = useState<T[]>([]);
  // Loading until the first page for this enabled/reset key has answered (no empty flash in between).
  const feedKey = `${enabled}:${resetKey}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = enabled && loadedKey !== feedKey;
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const cursor = useRef(0);
  const busy = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const fetcher = useRef(fetchPage);
  fetcher.current = fetchPage;
  const [generation, setGeneration] = useState(0);

  /** Fetches the next page; resolves with how many new items arrived, or null on failure. */
  const next = useCallback(async (): Promise<number | null> => {
    if (busy.current) return 0;
    busy.current = true;
    const controller = new AbortController();
    abort.current = controller;
    try {
      const page = await fetcher.current(cursor.current, limit, controller.signal);
      if (controller.signal.aborted) return null;
      cursor.current = Math.max(cursor.current, page.nextAfter);
      if (page.items.length > 0) setItems(current => [...current, ...page.items]);
      setHasMore(page.items.length >= limit);
      setError(null);
      setUnavailable(false);
      return page.items.length;
    } catch (cause) {
      if (isAbortError(cause) || controller.signal.aborted) return null;
      setUnavailable(cause instanceof ApiError && cause.status === 501);
      setError(describeError(cause, 'Could not load.'));
      return null;
    } finally {
      busy.current = false;
    }
  }, [limit]);

  useEffect(() => {
    cursor.current = 0;
    setItems([]);
    setHasMore(false);
    setError(null);
    if (!enabled) return;
    let live = true;
    void next().finally(() => { if (live) { setLoadedKey(feedKey); setGeneration(value => value + 1); } });
    return () => { live = false; abort.current?.abort(); busy.current = false; };
  }, [enabled, feedKey, next, resetKey]);

  // Polling: only while caught up and not blocked by a 501.
  const delay = useRef(poll?.minMs ?? 0);
  useEffect(() => {
    if (!enabled || !poll || loading || hasMore || unavailable) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(() => {
        void next().then(count => {
          if (!live) return;
          delay.current = count && count > 0 ? poll.minMs : Math.min(poll.maxMs, delay.current * 2);
          tick();
        });
      }, delay.current);
    };
    delay.current = poll.minMs;
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, poll?.minMs, poll?.maxMs, loading, hasMore, unavailable, next, generation]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try { await next(); } finally { setLoadingMore(false); }
  }, [next]);
  const refresh = useCallback(async () => {
    await next();
    setGeneration(value => value + 1);
  }, [next]);

  return { items, loading, error, unavailable, hasMore, loadingMore, loadMore, refresh };
}

export function useFlagFeed(options: { enabled: boolean; limit?: number; poll?: { minMs: number; maxMs: number } }): CursorFeed<ModerationFlagDto> {
  const { api } = useAdminData();
  const fetchPage = useCallback(async (after: number, limit: number, signal: AbortSignal) => {
    const page = await getFlagPage(api, after, limit, signal);
    return { items: page.flags, nextAfter: page.nextAfter };
  }, [api]);
  return useCursorFeed({ fetchPage, limit: options.limit ?? 100, enabled: options.enabled,
    ...(options.poll ? { poll: options.poll } : {}) });
}

export function useOpsAuditFeed(options: { enabled: boolean; eventId?: string; limit?: number }): CursorFeed<OpsAuditEntryDto> {
  const { api } = useAdminData();
  const { eventId } = options;
  const fetchPage = useCallback(async (after: number, limit: number, signal: AbortSignal) => {
    const page = await getOpsAuditPage(api, { after, limit, ...(eventId ? { eventId } : {}) }, signal);
    return { items: page.entries, nextAfter: page.nextAfter };
  }, [api, eventId]);
  return useCursorFeed({ fetchPage, limit: options.limit ?? 200, enabled: options.enabled, resetKey: eventId ?? '' });
}
