import { API_PREFIX, type AuditEntryDto, type EventSnapshotDto, type EventSummaryDto,
  type RuntimeStatusDto, type SessionDto, type SessionGrantDto } from '@tcg-live/core';
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

/** Typed client for `/api/v1`. Every method rejects with ApiError, or rethrows an AbortError unchanged. */
export interface ApiClient {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  createSession(launchToken: string, signal?: AbortSignal): Promise<SessionGrantDto>;
  getSession(signal?: AbortSignal): Promise<SessionDto>;
  deleteSession(signal?: AbortSignal): Promise<void>;
  rotateLink(signal?: AbortSignal): Promise<void>;
  getStatus(signal?: AbortSignal): Promise<RuntimeStatusDto>;
  listEvents(signal?: AbortSignal): Promise<EventSummaryDto[]>;
  getSnapshot(eventId: string, signal?: AbortSignal): Promise<EventSnapshotDto>;
  getAudit(eventId: string, query?: AuditPageQuery, signal?: AbortSignal): Promise<AuditEntryDto[]>;
  /** Opens `GET /stream`; resolves with the streaming response once headers arrive. */
  openStream(options: { lastEventId?: string | null; signal?: AbortSignal }): Promise<Response>;
}

/** Creates the admin API client. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = options.baseUrl ?? '';

  async function send(method: string, path: string, request: RequestOptions, accept: string): Promise<Response> {
    const auth = request.auth ?? true;
    const headers: Record<string, string> = { Accept: accept, ...request.headers };
    const token = auth ? options.getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers, cache: 'no-store', credentials: 'omit' };
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    if (request.signal) init.signal = request.signal;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${API_PREFIX}${path}`, init);
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
    createSession: (launchToken, signal) =>
      request<SessionGrantDto>('POST', '/session', { body: { token: launchToken }, auth: false, ...withSignal(signal) }),
    getSession: signal => request<SessionDto>('GET', '/session', withSignal(signal)),
    deleteSession: signal => request<void>('DELETE', '/session', withSignal(signal)),
    rotateLink: signal => request<void>('POST', '/session/rotate-link', withSignal(signal)),
    getStatus: signal => request<RuntimeStatusDto>('GET', '/status', withSignal(signal)),
    listEvents: signal => request<EventSummaryDto[]>('GET', '/events', withSignal(signal)),
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
