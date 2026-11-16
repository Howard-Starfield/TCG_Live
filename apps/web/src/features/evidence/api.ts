// Evidence API calls and queries. Everything goes through the admin API client (bearer header, 401
// handling, ApiError mapping); media URLs carry only a short-lived playback ticket, never the token.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EVIDENCE_ADMIN_MAX_BYTES, EVIDENCE_DELETE_REASON_MAX_LENGTH, EVIDENCE_FILE_TYPES, EVIDENCE_NOTE_MAX_LENGTH,
  EVIDENCE_NOTE_TEXT_MAX_LENGTH, EVIDENCE_REPLY_MAX_LENGTH, EVIDENCE_URL_MAX_LENGTH, isEvidenceFileExtension,
  type CreateEvidenceResponseDto, type EvidenceItemDto, type EvidenceItemResponseDto, type EvidenceListDto,
  type EvidenceReplyAudience, type EvidenceReplyDto, type EvidenceReplyListDto, type EvidenceReplyResponseDto, type MatchId,
  type PlaybackTicketDto } from '@tcg-live/core';
import { useCallback } from 'react';
import { ApiError, useAdminData, useSession, type ApiClient } from '../../data';

export const evidenceKeys = {
  all: ['admin', 'evidence'] as const,
  match: (eventId: string, matchId: MatchId) => ['admin', 'evidence', eventId, matchId] as const,
  replies: (eventId: string, matchId: MatchId) => ['admin', 'evidence', eventId, matchId, 'replies'] as const
};

/**
 * What this session may do with evidence. All need the runtime to mount the evidence routes. `reply` is sending in
 * the match thread: it needs match.judge (the same gate as the match actions), which a read-only console lacks.
 */
export function useEvidenceAccess(): { read: boolean; manage: boolean; reply: boolean } {
  const session = useSession();
  const mounted = session.session?.evidence === true;
  return { read: mounted && session.hasCapability('evidence.read'), manage: mounted && session.hasCapability('evidence.manage'),
    reply: mounted && session.hasCapability('evidence.read') && session.hasCapability('match.judge') };
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

/** Saves typed text as evidence of kind 'note': no file and no link. */
export async function addEvidenceNote(api: ApiClient, eventId: string, matchId: MatchId, text: string): Promise<EvidenceItemDto> {
  const body = await api.request<CreateEvidenceResponseDto>('POST', matchPath(eventId, matchId), { body: { kind: 'note', text } });
  return body.item;
}

const repliesPath = (eventId: string, matchId: MatchId) => `${matchPath(eventId, matchId)}/replies`;

export function listReplies(api: ApiClient, eventId: string, matchId: MatchId, signal?: AbortSignal): Promise<EvidenceReplyListDto> {
  return api.request<EvidenceReplyListDto>('GET', repliesPath(eventId, matchId), signal ? { signal } : {});
}

/** Sends a reply: to the match's players in Discord, or (audience 'staff') only into the dashboard thread. A failed Discord post still resolves, with status 'failed'. */
export async function sendReply(api: ApiClient, eventId: string, matchId: MatchId, body: string, audience: EvidenceReplyAudience): Promise<EvidenceReplyDto> {
  return (await api.request<EvidenceReplyResponseDto>('POST', repliesPath(eventId, matchId), { body: { body, audience } })).reply;
}

export async function retryReply(api: ApiClient, eventId: string, matchId: MatchId, replyId: string): Promise<EvidenceReplyDto> {
  return (await api.request<EvidenceReplyResponseDto>('POST', `${repliesPath(eventId, matchId)}/${encodeURIComponent(replyId)}/retry`, { body: {} })).reply;
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

/** The reply thread for one match. Disabled without evidence.read. */
export function useEvidenceReplies(eventId: string, matchId: MatchId, enabled = true) {
  const { api } = useAdminData();
  const access = useEvidenceAccess();
  return useQuery({
    queryKey: evidenceKeys.replies(eventId, matchId),
    queryFn: ({ signal }) => listReplies(api, eventId, matchId, signal),
    enabled: enabled && access.read,
    staleTime: 15_000,
    refetchOnMount: true,
    retry: retryTransient
  });
}

/** Puts a new or changed reply into the cached thread and refetches in the background. */
export function useReplyCacheUpdate(eventId: string, matchId: MatchId): (reply: EvidenceReplyDto) => void {
  const queryClient = useQueryClient();
  return useCallback((reply: EvidenceReplyDto) => {
    const key = evidenceKeys.replies(eventId, matchId);
    queryClient.setQueryData<EvidenceReplyListDto>(key, list => {
      if (!list) return list;
      const exists = list.replies.some(entry => entry.id === reply.id);
      return { ...list, replies: exists ? list.replies.map(entry => (entry.id === reply.id ? reply : entry)) : [...list.replies, reply] };
    });
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
  }, [eventId, matchId, queryClient]);
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

/** Null when the typed evidence text is acceptable. */
export function validateNoteText(text: string): string | null {
  const value = text.trim();
  if (!value) return 'Type some text.';
  return [...value].length > EVIDENCE_NOTE_TEXT_MAX_LENGTH ? `Text can be up to ${EVIDENCE_NOTE_TEXT_MAX_LENGTH} characters.` : null;
}

export function validateReplyBody(text: string): string | null {
  const value = text.trim();
  if (!value) return 'Type a reply.';
  return [...value].length > EVIDENCE_REPLY_MAX_LENGTH ? `Replies can be up to ${EVIDENCE_REPLY_MAX_LENGTH} characters.` : null;
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
