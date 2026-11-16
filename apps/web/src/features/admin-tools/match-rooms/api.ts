// Match rooms (the bot's pool of numbered voice "tables"): queries and mutations for the Rooms tab, the cleanup flow and the
// room chat transcripts. The server owns every rule; these only carry the DTOs from packages/core/src/match-rooms-contract.ts.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CleanupPlanDto, CleanupResultDto, MatchId, MatchRoomDto, MatchRoomsDto, MatchRoomTranscriptDto,
  MatchRoomTranscriptSummaryDto, SaveMatchRoomSettingsRequestDto } from '@tcg-live/core';
import { ApiError, useAdminData, type ApiClient } from '../../../data';
import { retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess } from '../api';

export const matchRoomsKeys = {
  all: () => adminToolsKeys.feature('match-rooms'),
  rooms: () => adminToolsKeys.feature('match-rooms', 'rooms'),
  transcripts: (eventId: string, matchId?: MatchId) => adminToolsKeys.feature('match-rooms', 'transcripts', eventId, matchId ?? null),
  transcript: (id: string) => adminToolsKeys.feature('match-rooms', 'transcript', id)
};

const BASE = '/admin-tools/match-rooms';
export const REVIEW_AGAIN = 'The rooms changed; review again.';
/** Renames take minutes (Discord allows two per ten minutes), so the tab re-reads while any are waiting. */
export const ROOMS_POLL_MS = 5000;

export const getMatchRooms = (api: ApiClient, signal?: AbortSignal) =>
  api.request<MatchRoomsDto>('GET', BASE, signal ? { signal } : {});
export const getCleanupPlan = (api: ApiClient, signal?: AbortSignal) =>
  api.request<CleanupPlanDto>('GET', `${BASE}/cleanup`, signal ? { signal } : {});
export const confirmCleanup = (api: ApiClient, planToken: string) =>
  api.request<CleanupResultDto>('POST', `${BASE}/cleanup`, { body: { planToken } });
export const getTranscripts = (api: ApiClient, eventId: string, matchId?: MatchId, signal?: AbortSignal) =>
  api.request<MatchRoomTranscriptSummaryDto[]>('GET', `${BASE}/transcripts?eventId=${encodeURIComponent(eventId)}${matchId ? `&matchId=${encodeURIComponent(matchId)}` : ''}`,
    signal ? { signal } : {});
export const getTranscript = (api: ApiClient, id: string, signal?: AbortSignal) =>
  api.request<MatchRoomTranscriptDto>('GET', `${BASE}/transcripts/${encodeURIComponent(id)}`, signal ? { signal } : {});

/** 409 is the server's RuleError: a stale version, or a plan that no longer matches. */
export const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

const retryRooms = (count: number, error: unknown) => !(error instanceof ApiError && error.status === 503) && retryTransient(count, error);

export function useMatchRooms() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: matchRoomsKeys.rooms(), queryFn: ({ signal }) => getMatchRooms(api, signal), enabled: access, staleTime: 10_000,
    retry: retryRooms,
    refetchInterval: query => query.state.data?.rooms.some(room => room.pendingName !== null && (room.rename.state === 'queued' || room.rename.state === 'retrying')) ? ROOMS_POLL_MS : false });
}

function patchRoom(client: QueryClient, room: MatchRoomDto) {
  client.setQueryData<MatchRoomsDto>(matchRoomsKeys.rooms(), current => current
    ? { ...current, rooms: current.rooms.map(item => item.channelId === room.channelId ? room : item) } : current);
}

export function useMatchRoomActions() {
  const { api } = useAdminData();
  const client = useQueryClient();
  const settle = () => { void client.invalidateQueries({ queryKey: matchRoomsKeys.rooms() }); };
  const put = (dto: MatchRoomsDto) => { client.setQueryData(matchRoomsKeys.rooms(), dto); };
  const saveSettings = useMutation({ onSuccess: put, onError: settle,
    mutationFn: (body: SaveMatchRoomSettingsRequestDto) => api.request<MatchRoomsDto>('PUT', `${BASE}/settings`, { body }) });
  const rename = useMutation({ onSuccess: room => patchRoom(client, room), onError: settle,
    mutationFn: ({ channelId, customName }: { channelId: string; customName: string | null }) =>
      api.request<MatchRoomDto>('PATCH', `${BASE}/rooms/${encodeURIComponent(channelId)}`, { body: { customName } }) });
  const ensure = useMutation({ onSuccess: result => put(result.rooms), onError: settle,
    mutationFn: (tables: number) => api.request<{ created: string[]; rooms: MatchRoomsDto }>('POST', `${BASE}/ensure`, { body: { tables } }) });
  const adopt = useMutation({ onSettled: settle,
    mutationFn: (channelId: string) => api.request<MatchRoomDto>('POST', `${BASE}/adopt`, { body: { channelId } }) });
  const forget = useMutation({ onSettled: settle,
    mutationFn: (channelId: string) => api.request<void>('DELETE', `${BASE}/rooms/${encodeURIComponent(channelId)}`) });
  return { saveSettings, rename, ensure, adopt, forget };
}

/** Transcripts of one match (or the whole event). Off until the drawer or export asks. */
export function useMatchTranscripts(eventId: string, matchId: MatchId | undefined, enabled = true) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: matchRoomsKeys.transcripts(eventId, matchId), queryFn: ({ signal }) => getTranscripts(api, eventId, matchId, signal),
    enabled: access && enabled, staleTime: 15_000, retry: retryRooms });
}

export function useTranscript(id: string | null) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: matchRoomsKeys.transcript(id ?? ''), queryFn: ({ signal }) => getTranscript(api, id!, signal),
    enabled: access && id !== null, staleTime: 30_000, retry: retryRooms });
}

export function useTranscriptHold() {
  const { api } = useAdminData();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, hold }: { id: string; hold: boolean }) => api.request<void>('PATCH', `${BASE}/transcripts/${encodeURIComponent(id)}`, { body: { hold } }),
    onSettled: () => { void client.invalidateQueries({ queryKey: adminToolsKeys.feature('match-rooms') }); }
  });
}

/** Channel ID -> the room's current Discord name, for screens that list rooms by ID. Empty until the rooms load (or without access). */
export function useRoomNames(): ReadonlyMap<string, string> {
  const rooms = useMatchRooms().data?.rooms;
  return new Map((rooms ?? []).filter(room => room.name).map(room => [room.channelId, room.name!]));
}
