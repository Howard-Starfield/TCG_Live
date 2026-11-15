// Logs tab data: the filterable, newest-first log pages, message-store stats and the audited
// "Delete stored message history" action. Settings are edited through useAdminToolsSection('logging').
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LogPageDto, MemberLogKind, MessageLogKind } from '@tcg-live/core';
import { useAdminData, type ApiClient } from '../../../data';
import { retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess } from '../api';

export type LogStream = 'member' | 'message';
export interface LogFilter {
  stream: LogStream;
  kind: MemberLogKind | MessageLogKind | null;
  userId: string | null;
  channelId: string | null;
  /** yyyy-mm-dd (local), inclusive. */
  from: string | null;
  to: string | null;
}
export const DEFAULT_LOG_FILTER: LogFilter = { stream: 'member', kind: null, userId: null, channelId: null, from: null, to: null };
export const LOG_PAGE_SIZE = 50;

/** Same shapes as the server's MessageStoreStatsDto / MessageHistoryDeletedDto (feature-local, not in the contract). */
export interface MessageStoreStats { storedMessages: number; loggedEntries: number; oldestMs: number | null }
export interface MessageHistoryDeleted { storedMessages: number; loggedEntries: number }

const SNOWFLAKE = /^[1-9]\d{14,21}$/;
const dayStart = (date: string) => new Date(`${date}T00:00:00`).getTime();

/** Query string for one newest-first page; invalid member IDs are left out (the form flags them). */
export function logQueryString(filter: LogFilter, before: number, limit = LOG_PAGE_SIZE): string {
  const params = new URLSearchParams({ stream: filter.stream, order: 'newest', limit: String(limit) });
  if (before > 0) params.set('before', String(before));
  if (filter.kind) params.set('kind', filter.kind);
  if (filter.userId && SNOWFLAKE.test(filter.userId)) params.set('userId', filter.userId);
  if (filter.channelId && filter.stream === 'message') params.set('channelId', filter.channelId);
  if (filter.from) { const ms = dayStart(filter.from); if (Number.isFinite(ms)) params.set('fromMs', String(ms)); }
  if (filter.to) { const ms = new Date(`${filter.to}T23:59:59.999`).getTime(); if (Number.isFinite(ms)) params.set('toMs', String(ms)); }
  return params.toString();
}

export const getLogPage = (api: ApiClient, filter: LogFilter, before: number, signal?: AbortSignal) =>
  api.request<LogPageDto>('GET', `/admin-tools/logs?${logQueryString(filter, before)}`, signal ? { signal } : {});
export const getMessageStoreStats = (api: ApiClient, signal?: AbortSignal) =>
  api.request<MessageStoreStats>('GET', '/admin-tools/logs/message-store', signal ? { signal } : {});
export const deleteMessageHistory = (api: ApiClient) =>
  api.request<MessageHistoryDeleted>('DELETE', '/admin-tools/logs/messages');

export function useLogPages(filter: LogFilter) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useInfiniteQuery({
    queryKey: adminToolsKeys.feature('logs', filter),
    queryFn: ({ pageParam, signal }) => getLogPage(api, filter, pageParam, signal),
    initialPageParam: 0,
    // The server answers nextAfter 0 when there is nothing older.
    getNextPageParam: last => last.nextAfter > 0 ? last.nextAfter : undefined,
    enabled: access, staleTime: 15_000, retry: retryTransient
  });
}

export function useMessageStoreStats() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: adminToolsKeys.feature('logs-store'), queryFn: ({ signal }) => getMessageStoreStats(api, signal),
    enabled: access, staleTime: 30_000, retry: retryTransient });
}

export function useInvalidateLogs() {
  const queryClient = useQueryClient();
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: adminToolsKeys.feature('logs') }),
    queryClient.invalidateQueries({ queryKey: adminToolsKeys.feature('logs-store') })]);
}
