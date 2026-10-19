import type { ErrorCode, ErrorDto, EventSnapshotDto } from '@tcg-live/core';

/** Contract error codes, plus client-side codes for failures that never reached a JSON error body. */
export type ApiErrorCode = ErrorCode | 'internal' | 'network' | 'invalid_response';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'bad_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found',
  405: 'method_not_allowed', 409: 'conflict', 422: 'rule', 429: 'too_many_requests', 503: 'unavailable'
};

const KNOWN_CODES = new Set<string>(['unauthenticated', 'forbidden', 'bad_host', 'bad_origin', 'bad_request',
  'not_found', 'method_not_allowed', 'conflict', 'rule', 'unavailable', 'too_many_requests', 'internal']);

/** A failed admin API call. `status` is 0 when no HTTP response arrived. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ApiErrorCode;
  readonly status: number;
  /** The latest snapshot, sent with 409 conflicts (Wave 3 commands). */
  readonly snapshot: EventSnapshotDto | undefined;
  /** From a `Retry-After` header, for 429 and 503. */
  readonly retryAfterMs: number | undefined;

  constructor(init: { code: ApiErrorCode; status: number; message: string; snapshot?: EventSnapshotDto;
    retryAfterMs?: number; cause?: unknown }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.snapshot = init.snapshot;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** True for 401: the session is gone and the console must sign in again. */
  get isUnauthenticated(): boolean { return this.status === 401; }
  /** True for failures worth retrying: network errors, 429, 5xx. */
  get isTransient(): boolean { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

/** True for an `AbortError` raised by an aborted fetch or stream read. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function isErrorDto(value: unknown): value is ErrorDto {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string';
}

/** Maps a non-2xx response to an ApiError, reading an `ErrorDto` body when there is one. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const fallback: ApiErrorCode = STATUS_CODES[response.status] ?? (response.status >= 500 ? 'internal' : 'bad_request');
  if (isErrorDto(body)) {
    const code = KNOWN_CODES.has(body.error.code) ? body.error.code : fallback;
    return new ApiError({ code, status: response.status, message: body.error.message,
      ...(body.snapshot ? { snapshot: body.snapshot } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }
  return new ApiError({ code: fallback, status: response.status,
    message: response.status >= 500 ? 'The server could not complete the request.' : `Request failed (${response.status}).`,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
}

/** Wraps a fetch rejection (not an abort) as a network ApiError. */
export function networkError(cause: unknown): ApiError {
  return new ApiError({ code: 'network', status: 0, message: 'The console server could not be reached.', cause });
}
