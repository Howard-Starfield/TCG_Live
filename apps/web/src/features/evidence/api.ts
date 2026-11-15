// Evidence API calls and queries. Everything goes through the admin API client (bearer header, 401
// handling, ApiError mapping); media URLs carry only a short-lived playback ticket, never the token.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EVIDENCE_ADMIN_MAX_BYTES, EVIDENCE_DELETE_REASON_MAX_LENGTH, EVIDENCE_FILE_TYPES, EVIDENCE_NOTE_MAX_LENGTH,
  EVIDENCE_URL_MAX_LENGTH, isEvidenceFileExtension, type CreateEvidenceResponseDto, type EvidenceItemDto,
  type EvidenceItemResponseDto, type EvidenceListDto, type MatchId, type PlaybackTicketDto } from '@tcg-live/core';
import { useCallback } from 'react';
import { ApiError, useAdminData, useSession, type ApiClient } from '../../data';

export const evidenceKeys = {
  all: ['admin', 'evidence'] as const,
  match: (eventId: string, matchId: MatchId) => ['admin', 'evidence', eventId, matchId] as const
};

/** What this session may do with evidence. Both need the runtime to mount the evidence routes. */
export function useEvidenceAccess(): { read: boolean; manage: boolean } {
  const session = useSession();
  const mounted = session.session?.evidence === true;
  return { read: mounted && session.hasCapability('evidence.read'), manage: mounted && session.hasCapability('evidence.manage') };
}

const matchPath = (eventId: string, matchId: MatchId) =>
  `/events/${encodeURIComponent(eventId)}/matches/${encodeURIComponent(matchId)}/evidence`;
const itemPath = (id: string) => `/evidence/${encodeURIComponent(id)}`;

export function listEvidence(api: ApiClient, eventId: string, matchId: MatchId, signal?: AbortSignal): Promise<EvidenceListDto> {
  return api.request<EvidenceListDto>('GET', matchPath(eventId, matchId), signal ? { signal } : {});
}

export async function addEvidenceLink(api: ApiClient, eventId: string, matchId: MatchId, url: string, note: string): Promise<EvidenceItemDto> {
  const body = await api.request<CreateEvidenceResponseDto>('POST', matchPath(eventId, matchId),
    { body: note ? { url, note } : { url } });
  return body.item;
}

/**
 * Uploads one file in a single request. `duplicate` is true when the server already had the same file
 * for this match and returned that item instead of storing a second copy.
 *
 * Follow-up: a resumable protocol (reserve an upload ID, PUT chunks at an offset, verify the SHA-256 at
 * the end) would let a dropped 2 GB upload continue; today a failed upload starts again from the start.
 */
export async function uploadEvidence(api: ApiClient, eventId: string, matchId: MatchId, file: File, note: string,
  options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {}): Promise<{ item: EvidenceItemDto; duplicate: boolean }> {
  const contentType = evidenceMime(file);
  if (!contentType) throw new Error(UNSUPPORTED_FILE);
  const search = note ? `?note=${encodeURIComponent(note)}` : '';
  const response = await api.requestRaw('POST', `${matchPath(eventId, matchId)}${search}`, {
    body: file, contentType, accept: 'application/json',
    ...(options.onProgress ? { onUploadProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  });
  const body = await response.json() as CreateEvidenceResponseDto;
  return { item: body.item, duplicate: body.duplicate === true };
}

/** A readable reason an upload failed, for each way it can fail. */
export function describeUploadError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 0: return 'The connection dropped during the upload: a network problem, or the server stopped waiting after a minute '
        + 'without data. Check the connection and upload again.';
      case 408: case 504: return 'The upload timed out. Check the connection and upload again.';
      case 413: return error.message || `The file is too large. Files can be up to ${formatBytes(EVIDENCE_ADMIN_MAX_BYTES)}.`;
      case 415: return error.message || UNSUPPORTED_FILE;
      case 507: return error.message || 'The server has no room for this file. Delete old evidence or free disk space first.';
      default: return describeError(error, 'The upload failed.');
    }
  }
  return describeError(error, 'The upload failed.');
}

/** Speed (bytes per second, over the recent samples) and time left, once enough has been sent to tell. */
export function uploadRate(samples: readonly { atMs: number; loaded: number }[], total: number): { bytesPerSecond: number; etaMs: number | null } | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const elapsed = last.atMs - first.atMs;
  if (elapsed < 500 || last.loaded <= first.loaded) return null;
  const bytesPerSecond = ((last.loaded - first.loaded) / elapsed) * 1000;
  return { bytesPerSecond, etaMs: total > 0 ? Math.max(0, ((total - last.loaded) / bytesPerSecond) * 1000) : null };
}

export async function setEvidenceHold(api: ApiClient, id: string, hold: boolean): Promise<EvidenceItemDto> {
  return (await api.request<EvidenceItemResponseDto>('PATCH', itemPath(id), { body: { hold } })).item;
}

export async function deleteEvidence(api: ApiClient, id: string, reason: string): Promise<EvidenceItemDto> {
  return (await api.request<EvidenceItemResponseDto>('DELETE', itemPath(id), { body: { reason } })).item;
}

export function requestPlayback(api: ApiClient, id: string, signal?: AbortSignal): Promise<PlaybackTicketDto> {
  return api.request<PlaybackTicketDto>('POST', `${itemPath(id)}/playback`, { body: {}, ...(signal ? { signal } : {}) });
}

/** The ticket URL with `?download=1`, which the server answers with Content-Disposition: attachment. */
export function downloadUrl(ticketUrl: string): string {
  return `${ticketUrl}${ticketUrl.includes('?') ? '&' : '?'}download=1`;
}

/** Evidence for one match, newest data on mount. Disabled without evidence.read. */
export function useEvidenceList(eventId: string, matchId: MatchId, enabled = true) {
  const { api } = useAdminData();
  const access = useEvidenceAccess();
  return useQuery({
    queryKey: evidenceKeys.match(eventId, matchId),
    queryFn: ({ signal }) => listEvidence(api, eventId, matchId, signal),
    enabled: enabled && access.read,
    staleTime: 15_000,
    refetchOnMount: true,
    retry: retryTransient
  });
}

/** Puts a changed item into the cached list (or adds it) and refetches in the background. */
export function useEvidenceCacheUpdate(eventId: string, matchId: MatchId): (item: EvidenceItemDto) => void {
  const queryClient = useQueryClient();
  return useCallback((item: EvidenceItemDto) => {
    const key = evidenceKeys.match(eventId, matchId);
    queryClient.setQueryData<EvidenceListDto>(key, list => {
      if (!list) return list;
      const exists = list.items.some(entry => entry.id === item.id);
      return { ...list, items: exists ? list.items.map(entry => (entry.id === item.id ? item : entry)) : [...list.items, item] };
    });
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
  }, [eventId, matchId, queryClient]);
}

// ---------------------------------------------------------------- validation and formatting

export const UNSUPPORTED_FILE = 'Choose an MP4, MOV, WebM, Ogg, MP3, M4A or MKV file.';

/** The upload Content-Type: the browser's type when it is an allowed one, else from the extension. */
export function evidenceMime(file: File): string | null {
  const allowed = Object.values(EVIDENCE_FILE_TYPES).map(type => type.mime) as string[];
  if (file.type && allowed.includes(file.type)) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  return extension && isEvidenceFileExtension(extension) ? EVIDENCE_FILE_TYPES[extension].mime : null;
}

export function validateEvidenceFile(file: File): string | null {
  if (!evidenceMime(file)) return UNSUPPORTED_FILE;
  if (file.size < 1) return 'The file is empty.';
  if (file.size > EVIDENCE_ADMIN_MAX_BYTES) return `Files can be up to ${formatBytes(EVIDENCE_ADMIN_MAX_BYTES)}.`;
  return null;
}

/** Null when the link is acceptable; links must be https and at most EVIDENCE_URL_MAX_LENGTH characters. */
export function validateEvidenceUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Paste a link.';
  if (value.length > EVIDENCE_URL_MAX_LENGTH) return `Links can be up to ${EVIDENCE_URL_MAX_LENGTH} characters.`;
  let url: URL;
  try { url = new URL(value); } catch { return 'That is not a valid link.'; }
  if (url.protocol !== 'https:') return 'Use an https:// link.';
  if (url.username || url.password) return 'Links cannot contain a user name or password.';
  return null;
}

export function validateNote(note: string): string | null {
  return [...note].length > EVIDENCE_NOTE_MAX_LENGTH ? `Notes can be up to ${EVIDENCE_NOTE_MAX_LENGTH} characters.` : null;
}

export function validateDeleteReason(reason: string): string | null {
  const value = reason.trim();
  if (!value) return 'A reason is required.';
  return [...value].length > EVIDENCE_DELETE_REASON_MAX_LENGTH ? `Reasons can be up to ${EVIDENCE_DELETE_REASON_MAX_LENGTH} characters.` : null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** Readable message for a failed call; 501 means the server has not shipped that route yet. */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 501) return `Not available yet. ${error.message}`;
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Query retry policy: transient failures twice, never 4xx or 501 (the route is not shipped). */
export function retryTransient(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && (!error.isTransient || error.status === 501)) return false;
  return failureCount < 2;
}

export function isNotAvailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 501;
}
