// Members, bans, cases, notes and the mod-action audit trail (admin tools A): queries, mutations and the
// debounce used by member search. Feature-local wire shapes that are not in the contract live here.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BanListDto, MemberProfileDto, MemberSearchDto, ModActionRequestDto, ModActionResultDto, ModAuditPageDto, ModCaseDto,
  ModCaseKind, ModCasePageDto, ModNoteDto } from '@tcg-live/core';
import { useEffect, useState } from 'react';
import { useAdminData, type ApiClient } from '../../../data';
import { retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess, useAdminToolsCapability } from '../api';

/** Same as the server's ModAuditPageWithStateDto: whether Discord's audit log could be read. */
export interface ModAuditPage extends ModAuditPageDto { discordAudit: 'ok' | 'missing-permission' | 'unavailable' }
export interface CaseFilter { targetId: string; kind: ModCaseKind | ''; moderatorId: string }

export const SNOWFLAKE = /^[1-9]\d{14,21}$/;
export const SEARCH_DEBOUNCE_MS = 300;
export const BAN_PAGE_SIZE = 200;
export const CASE_PAGE_SIZE = 50;

export const membersKeys = {
  all: () => adminToolsKeys.feature('members'),
  search: (q: string) => adminToolsKeys.feature('members', 'search', q),
  profile: (id: string) => adminToolsKeys.feature('members', 'profile', id),
  bans: () => adminToolsKeys.feature('members', 'bans'),
  cases: (filter: CaseFilter) => adminToolsKeys.feature('members', 'cases', filter),
  modAudit: () => adminToolsKeys.feature('members', 'mod-audit')
};

/** The value after it stopped changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const withSignal = (signal?: AbortSignal) => signal ? { signal } : {};
export const searchMembers = (api: ApiClient, q: string, signal?: AbortSignal) =>
  api.request<MemberSearchDto>('GET', `/admin-tools/members?q=${encodeURIComponent(q)}`, withSignal(signal));
export const getMemberProfile = (api: ApiClient, id: string, signal?: AbortSignal) =>
  api.request<MemberProfileDto>('GET', `/admin-tools/members/${id}`, withSignal(signal));
export const listBans = (api: ApiClient, after: string | null, signal?: AbortSignal) =>
  api.request<BanListDto>('GET', `/admin-tools/bans?limit=${BAN_PAGE_SIZE}${after ? `&after=${after}` : ''}`, withSignal(signal));
export const postModAction = (api: ApiClient, body: ModActionRequestDto) =>
  api.request<ModActionResultDto>('POST', '/admin-tools/actions', { body });

export function caseQueryString(filter: CaseFilter, before: number | null): string {
  const params = new URLSearchParams({ limit: String(CASE_PAGE_SIZE) });
  if (SNOWFLAKE.test(filter.targetId.trim())) params.set('targetId', filter.targetId.trim());
  if (filter.kind) params.set('kind', filter.kind);
  const moderator = filter.moderatorId.trim();
  if (moderator && (SNOWFLAKE.test(moderator) || moderator === 'local-admin' || moderator === 'bot')) params.set('moderatorId', moderator);
  if (before !== null) params.set('before', String(before));
  return params.toString();
}

/** Member search: debounced by the caller; at least one character, or an exact Discord ID. */
export function useMemberSearch(query: string) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  const q = query.trim();
  return useQuery({ queryKey: membersKeys.search(q), queryFn: ({ signal }) => searchMembers(api, q, signal),
    enabled: access && q.length > 0, staleTime: 15_000, retry: retryTransient });
}

export function useMemberProfile(id: string | null) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: membersKeys.profile(id ?? ''), queryFn: ({ signal }) => getMemberProfile(api, id!, signal),
    enabled: access && !!id, staleTime: 10_000, retry: retryTransient });
}

export function useBanList() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useInfiniteQuery({ queryKey: membersKeys.bans(), initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => listBans(api, pageParam, signal),
    getNextPageParam: page => page.nextAfter, enabled: access, staleTime: 15_000, retry: retryTransient });
}

export function useCases(filter: CaseFilter) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useInfiniteQuery({ queryKey: membersKeys.cases(filter), initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => api.request<ModCasePageDto>('GET', `/admin-tools/cases?${caseQueryString(filter, pageParam)}`, withSignal(signal)),
    getNextPageParam: page => page.nextBefore, enabled: access, staleTime: 10_000, retry: retryTransient });
}

export function useModAudit() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useInfiniteQuery({ queryKey: membersKeys.modAudit(), initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => api.request<ModAuditPage>('GET', `/admin-tools/mod-audit?limit=50${pageParam ? `&before=${pageParam}` : ''}`,
      withSignal(signal)),
    getNextPageParam: page => page.nextBefore, enabled: access, staleTime: 15_000, retry: retryTransient });
}

/** After any change every members query is stale (profiles, bans, cases, audit trail). */
function useInvalidateMembers() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: membersKeys.all() });
}

export function useCanModerate(): boolean { return useAdminToolsCapability('members.moderate'); }

export function useModAction() {
  const { api } = useAdminData();
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: (body: ModActionRequestDto) => postModAction(api, body), onSettled: () => { void invalidate(); } });
}

export function useUpdateCase() {
  const { api } = useAdminData();
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: ({ number, ...body }: { number: number; reason?: string; evidenceIds?: string[] }) =>
    api.request<ModCaseDto>('PUT', `/admin-tools/cases/${number}`, { body }), onSettled: () => { void invalidate(); } });
}

export function useDeleteCase() {
  const { api } = useAdminData();
  const invalidate = useInvalidateMembers();
  return useMutation({ mutationFn: ({ number, reason }: { number: number; reason: string }) =>
    api.request<{ deleted: number }>('DELETE', `/admin-tools/cases/${number}`, { body: { reason } }), onSettled: () => { void invalidate(); } });
}

export function useNoteMutations() {
  const { api } = useAdminData();
  const invalidate = useInvalidateMembers();
  const settle = { onSettled: () => { void invalidate(); } };
  return {
    add: useMutation({ mutationFn: (body: { targetId: string; body: string }) => api.request<ModNoteDto>('POST', '/admin-tools/notes', { body }), ...settle }),
    update: useMutation({ mutationFn: ({ id, body }: { id: number; body: string }) =>
      api.request<ModNoteDto>('PUT', `/admin-tools/notes/${id}`, { body: { body } }), ...settle }),
    remove: useMutation({ mutationFn: (id: number) => api.request<{ deleted: number }>('DELETE', `/admin-tools/notes/${id}`), ...settle })
  };
}
