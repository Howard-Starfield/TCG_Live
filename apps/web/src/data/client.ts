import { API_PREFIX, type AuditEntryDto, type EventSnapshotDto, type EventSummaryDto,
  type RuntimeStatusDto, type SessionDto, type SessionGrantDto, type SetupStatusDto,
  type SetupGuildDto, type SetupChannelDto, type SetupSelectionDto, type SetupCheckDto,
  type SetupFinishDto, type TournamentDirectoryDto,
  type TournamentDirectoryEntryDto, type CreateTournamentDraftDto } from '@tcg-live/core';
import { ApiError, errorFromResponse, isAbortError, networkError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Origin prefix, '' for same origin (the default). */
  baseUrl?: string;
  /** Current bearer token, or null when signed out. */
  getToken: () => string | null;
  /** Called once per 401 on an authenticated request (with the token it sent), before the ApiError is thrown. */
  onUnauthorized?: (error: ApiError, tokenUsed: string | null) => void;
}

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** Send the bearer token (default true). Only `POST /session` sets false. */
  auth?: boolean;
  headers?: Record<string, string>;
}

export interface AuditPageQuery { after?: number; limit?: number }

/** Options for `requestRaw`: a body sent as is (binary uploads) and the raw response back. */
export interface RawRequestOptions {
  body?: BodyInit;
  /** Content-Type of `body`. */
  contentType?: string;
  signal?: AbortSignal;
  /** Accept header; defaults to any type. */
  accept?: string;
  /**
   * Upload progress for `body`. With the browser's own fetch this sends through XMLHttpRequest (fetch has
   * no upload progress); with an injected fetch it reports 0 before and the full size after the request.
   */
  onUploadProgress?: (loaded: number, total: number) => void;
}

/** Typed client for `/api/v1`. Every method rejects with ApiError, or rethrows an AbortError unchanged. */
export interface ApiClient {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  /**
   * Like `request`, but sends `body` unchanged and resolves with the successful Response (for binary
   * bodies such as artwork). Failures reject with ApiError exactly like `request`.
   */
  requestRaw(method: string, path: string, options?: RawRequestOptions): Promise<Response>;
  createSession(launchToken: string, signal?: AbortSignal): Promise<SessionGrantDto>;
  getSession(signal?: AbortSignal): Promise<SessionDto>;
  deleteSession(signal?: AbortSignal): Promise<void>;
  rotateLink(signal?: AbortSignal): Promise<void>;
  getStatus(signal?: AbortSignal): Promise<RuntimeStatusDto>;
  listEvents(signal?: AbortSignal): Promise<EventSummaryDto[]>;
  listTournaments(query: string, signal?: AbortSignal): Promise<TournamentDirectoryDto>;
  createTournamentDraft(input: CreateTournamentDraftDto): Promise<TournamentDirectoryEntryDto>;
  getSnapshot(eventId: string, signal?: AbortSignal): Promise<EventSnapshotDto>;
  getAudit(eventId: string, query?: AuditPageQuery, signal?: AbortSignal): Promise<AuditEntryDto[]>;
  getSetupStatus(signal?: AbortSignal): Promise<SetupStatusDto>;
  listSetupGuilds(signal?: AbortSignal): Promise<SetupGuildDto[]>;
  listSetupChannels(guildId: string, signal?: AbortSignal): Promise<SetupChannelDto[]>;
  checkSetup(selection: SetupSelectionDto): Promise<SetupCheckDto>;
  finishSetup(selection: SetupSelectionDto): Promise<SetupFinishDto>;
  /** Opens `GET /stream`; resolves with the streaming response once headers arrive. */
  openStream(options: { lastEventId?: string | null; signal?: AbortSignal }): Promise<Response>;
}

/** Creates the admin API client. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = options.baseUrl ?? '';

  async function send(method: string, path: string, request: RequestOptions, accept: string,
    raw?: { body: BodyInit; contentType: string | undefined; onUploadProgress?: ((loaded: number, total: number) => void) | undefined }): Promise<Response> {
    const auth = request.auth ?? true;
    const headers: Record<string, string> = { Accept: accept, ...request.headers };
    const token = auth ? options.getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers, cache: 'no-store', credentials: 'omit' };
    if (raw) {
      if (raw.contentType) headers['Content-Type'] = raw.contentType;
      init.body = raw.body;
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    if (request.signal) init.signal = request.signal;

    let response: Response;
    const progress = raw?.onUploadProgress;
    const total = raw && raw.body instanceof Blob ? raw.body.size : 0;
    try {
      if (progress && !options.fetch && typeof XMLHttpRequest !== 'undefined') {
        response = await xhrFetch(`${baseUrl}${API_PREFIX}${path}`, init, progress);
      } else {
        progress?.(0, total);
        response = await doFetch(`${baseUrl}${API_PREFIX}${path}`, init);
        if (response.ok) progress?.(total, total);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw networkError(error);
    }
    if (!response.ok) {
      const error = await errorFromResponse(response);
      if (error.status === 401 && auth) options.onUnauthorized?.(error, token);
      throw error;
    }
    return response;
  }

  async function request<T>(method: string, path: string, request: RequestOptions = {}): Promise<T> {
    const response = await send(method, path, request, 'application/json');
    if (response.status === 204) return undefined as T;
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw networkError(error);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new ApiError({ code: 'invalid_response', status: response.status, message: 'The server sent an unreadable response.', cause });
    }
  }

  const withSignal = (signal: AbortSignal | undefined): RequestOptions => (signal ? { signal } : {});
  const segment = (value: string) => encodeURIComponent(value);

  return {
    request,
    requestRaw: (method, path, raw = {}) => send(method, path, withSignal(raw.signal), raw.accept ?? '*/*',
      raw.body === undefined ? undefined : { body: raw.body, contentType: raw.contentType, onUploadProgress: raw.onUploadProgress }),
    createSession: (launchToken, signal) =>
      request<SessionGrantDto>('POST', '/session', { body: { token: launchToken }, auth: false, ...withSignal(signal) }),
    getSession: signal => request<SessionDto>('GET', '/session', withSignal(signal)),
    deleteSession: signal => request<void>('DELETE', '/session', withSignal(signal)),
    rotateLink: signal => request<void>('POST', '/session/rotate-link', withSignal(signal)),
    getStatus: signal => request<RuntimeStatusDto>('GET', '/status', withSignal(signal)),
    listEvents: signal => request<EventSummaryDto[]>('GET', '/events', withSignal(signal)),
    listTournaments: (query, signal) => request<TournamentDirectoryDto>('GET',
      `/tournaments${query ? `?q=${encodeURIComponent(query)}` : ''}`, withSignal(signal)),
    createTournamentDraft: input => request<TournamentDirectoryEntryDto>('POST', '/tournaments/drafts', { body: input }),
    getSnapshot: (eventId, signal) =>
      request<EventSnapshotDto>('GET', `/events/${segment(eventId)}/snapshot`, withSignal(signal)),
    getAudit: (eventId, query = {}, signal) => {
      const params = new URLSearchParams();
      if (query.after !== undefined) params.set('after', String(query.after));
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const encoded = params.toString();
      const search = encoded ? `?${encoded}` : '';
      return request<AuditEntryDto[]>('GET', `/events/${segment(eventId)}/audit${search}`, withSignal(signal));
    },
    getSetupStatus: signal => request<SetupStatusDto>('GET', '/setup', withSignal(signal)),
    listSetupGuilds: signal => request<SetupGuildDto[]>('GET', '/setup/guilds', withSignal(signal)),
    listSetupChannels: (guildId, signal) => request<SetupChannelDto[]>('GET',
      `/setup/channels?guildId=${segment(guildId)}`, withSignal(signal)),
    checkSetup: selection => request<SetupCheckDto>('POST', '/setup/check', { body: selection }),
    finishSetup: selection => request<SetupFinishDto>('POST', '/setup/finish', { body: selection }),
    async openStream({ lastEventId, signal }) {
      const response = await send('GET', '/stream', {
        ...withSignal(signal),
        ...(lastEventId ? { headers: { 'Last-Event-ID': lastEventId } } : {})
      }, 'text/event-stream');
      if (!response.body) {
        throw new ApiError({ code: 'invalid_response', status: response.status, message: 'The event stream has no body.' });
      }
      return response;
    }
  };
}

/** fetch-shaped XMLHttpRequest for uploads that report progress. Rejects like fetch: TypeError or AbortError. */
function xhrFetch(url: string, init: RequestInit, onProgress: (loaded: number, total: number) => void): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const signal = init.signal ?? undefined;
    const abort = () => xhr.abort();
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    xhr.open(init.method ?? 'GET', url);
    xhr.responseType = 'blob';
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : 0);
    const done = () => signal?.removeEventListener('abort', abort);
    xhr.onload = () => {
      done();
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const at = line.indexOf(':');
        if (at > 0) headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      const empty = xhr.status === 204 || xhr.status === 205 || xhr.status === 304;
      resolve(new Response(empty ? null : xhr.response as Blob, { status: xhr.status, statusText: xhr.statusText, headers }));
    };
    xhr.onerror = () => { done(); reject(new TypeError('Network request failed')); };
    xhr.onabort = () => { done(); reject(new DOMException('Aborted', 'AbortError')); };
    xhr.send((init.body ?? null) as XMLHttpRequestBodyInit | null);
  });
}
