import type { QueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { applyStreamEvent, createAdminQueryClient } from './cache';
import { createApiClient, type ApiClient, type FetchLike } from './client';
import { serverClock, type ServerClock } from './clock';
import { SessionController, type HistoryLike, type LocationLike } from './session';
import { browserSessionStorage, type KeyValueStorage } from './storage';
import { StreamClient, type StreamClientOptions } from './stream';

/** Everything the console's data layer needs, wired together. One per app (or per test). */
export interface AdminData {
  api: ApiClient;
  session: SessionController;
  stream: StreamClient;
  queryClient: QueryClient;
  clock: ServerClock;
  /** Runs the session bootstrap once (fragment login) and keeps the stream tied to the session. Idempotent. */
  start(): void;
  /** Detaches the session wiring and closes the stream; `start()` may be called again. */
  stop(): void;
}

export interface AdminDataOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** Token storage; defaults to the tab's sessionStorage. */
  sessionStorage?: KeyValueStorage;
  location?: LocationLike | null;
  history?: HistoryLike | null;
  queryClient?: QueryClient;
  /** Defaults to the app-wide `serverClock` behind `getServerNow()`. */
  clock?: ServerClock;
  /** Build the page was loaded with; null latches the first `hello`'s build. */
  expectedBuildId?: string | null;
  reload?: () => void;
  /** Overrides for the stream client (timers, jitter, online detection). */
  stream?: Omit<StreamClientOptions, 'api' | 'onEvent' | 'onUnauthorized' | 'reload' | 'expectedBuildId' | 'storage'>;
}

/** Creates the data layer: API client, session, stream, query cache and clock, wired together. */
export function createAdminData(options: AdminDataOptions = {}): AdminData {
  const storage = options.sessionStorage ?? browserSessionStorage();
  const clock = options.clock ?? serverClock;
  const queryClient = options.queryClient ?? createAdminQueryClient();

  let session: SessionController;
  const api = createApiClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    getToken: () => session.getToken(),
    onUnauthorized: (_error, tokenUsed) => session.handleUnauthorized(tokenUsed)
  });
  session = new SessionController({
    api, storage,
    ...(options.location !== undefined ? { location: options.location } : {}),
    ...(options.history !== undefined ? { history: options.history } : {})
  });
  const stream = new StreamClient({
    ...options.stream,
    api,
    storage,
    expectedBuildId: options.expectedBuildId ?? null,
    ...(options.reload ? { reload: options.reload } : {}),
    onEvent: (event, info) => applyStreamEvent(queryClient, clock, event, info),
    onUnauthorized: () => session.handleUnauthorized()
  });

  let detach: (() => void) | null = null;
  let lastStatus: string | null = null;
  const sync = () => {
    const state = session.getState();
    if (state.status === lastStatus) return;
    lastStatus = state.status;
    if (state.status === 'signed-in') {
      stream.start();
    } else {
      stream.stop();
      if (state.status === 'signed-out') {
        queryClient.clear();
        clock.reset();
      }
    }
  };

  return {
    api, session, stream, queryClient, clock,
    start() {
      if (detach) return;
      lastStatus = null;
      const unsubscribe = session.subscribe(sync);
      detach = unsubscribe;
      void session.bootstrap();
      sync();
    },
    stop() {
      detach?.();
      detach = null;
      lastStatus = null;
      stream.stop();
    }
  };
}

/** React context carrying the AdminData instance; provided by `AdminDataProvider`. */
export const AdminDataContext = createContext<AdminData | null>(null);

/** The AdminData in scope; throws outside `AdminDataProvider`. */
export function useAdminData(): AdminData {
  const data = useContext(AdminDataContext);
  if (!data) throw new Error('useAdminData() must be used inside <AdminDataProvider>.');
  return data;
}
