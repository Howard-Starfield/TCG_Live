// Command client (L10): POST /commands and /panels/refresh over the data layer's request helper, with
// bounded automatic retries that resend the exact same body (same commandId), so the server's
// `web:<commandId>` record turns a retried success into the stored 200 rather than a second apply.
import type { AdminCommandRequestDto, AdminCommandResultDto, PanelRefreshRequestDto,
  PanelRefreshResultDto } from '@tcg-live/core';
import { ApiError, type ApiClient } from '../../data';

/** Waits between automatic retries: one per entry, so `[500, 1500]` means at most three attempts. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500];
/** A `Retry-After` longer than this is not waited for; the admin gets the error instead. */
const MAX_RETRY_AFTER_MS = 5000;

export interface CommandClientOptions {
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface CommandClient {
  /** Sends one user intent; automatic retries reuse `request` unchanged. Rejects with ApiError. */
  send(request: AdminCommandRequestDto): Promise<AdminCommandResultDto>;
  refreshPanels(request: PanelRefreshRequestDto): Promise<PanelRefreshResultDto>;
}

/** Retry only what cannot have been decided by the server: no response at all, or 503. */
export function isRetryable(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 0 || error.status === 503);
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function createCommandClient(api: Pick<ApiClient, 'request'>, options: CommandClientOptions = {}): CommandClient {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;

  async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    for (let index = 0; ; index += 1) {
      try {
        return await attempt();
      } catch (error) {
        const delay = delays[index];
        if (!isRetryable(error) || delay === undefined) throw error;
        if (error.retryAfterMs !== undefined && error.retryAfterMs > MAX_RETRY_AFTER_MS) throw error;
        await sleep(Math.max(delay, error.retryAfterMs ?? 0));
      }
    }
  }

  return {
    send: request => withRetry(() => api.request<AdminCommandResultDto>('POST', '/commands', { body: request })),
    refreshPanels: request => withRetry(() => api.request<PanelRefreshResultDto>('POST', '/panels/refresh', { body: request }))
  };
}
