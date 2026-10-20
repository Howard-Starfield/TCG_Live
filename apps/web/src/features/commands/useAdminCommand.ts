// useAdminCommand (L10): runs admin commands for the session, tracks pending actions, retries
// transient failures with the same commandId, maps errors, handles 409 and shows the toasts.
// Snapshots are never mutated optimistically; the authoritative change arrives over the stream.
import type { AdminCommandDto, AdminCommandResultDto, EventSnapshotDto, PanelRefreshResultDto,
  SessionDto } from '@tcg-live/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { adminKeys, ApiError, isSnapshotNewer, useAdminData } from '../../data';
import { useToast } from '../../ui';
import { createCommandClient, type CommandClient } from './client';
import { actionKey, canRefreshPanels, canRun, commandVerb, errorMessage, newCommandId, preconditionFor,
  REFRESH_KEY, refreshToasts, resultToasts, type ToastSpec } from './model';

export type CommandOutcome =
  | { status: 'applied' | 'noop'; result: AdminCommandResultDto }
  | { status: 'refreshed'; result: PanelRefreshResultDto }
  /** 409: the latest snapshot is in the cache now; the admin decides again (a new commandId). */
  | { status: 'conflict'; error: ApiError; message: string; snapshot: EventSnapshotDto | undefined }
  | { status: 'failed'; error: ApiError; message: string }
  /** The same action is already in flight, or the session may not run it. */
  | { status: 'skipped' };

export interface RunOptions {
  /** The caller shows failures itself (a dialog's inline alert); success toasts still appear. */
  inline?: boolean;
}

export interface AdminCommandApi {
  /** Sends `command` for the event as the admin sees it in `snapshot` (the precondition comes from it). */
  run(snapshot: EventSnapshotDto, command: AdminCommandDto, options?: RunOptions): Promise<CommandOutcome>;
  refreshPanels(snapshot: EventSnapshotDto, options?: RunOptions): Promise<CommandOutcome>;
  /** True while the action with this key (see `actionKey`) is in flight. */
  isPending(key: string): boolean;
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error
    : new ApiError({ code: 'internal', status: 0, message: 'Unexpected failure.', cause: error });
}

export function useAdminCommand(session: SessionDto, options: { client?: CommandClient } = {}): AdminCommandApi {
  const data = useAdminData();
  const toast = useToast();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  // Synchronous guard: two clicks in one frame must not send two intents.
  const inFlight = useRef(new Set<string>());
  const client = useMemo(() => options.client ?? createCommandClient(data.api), [options.client, data.api]);

  const show = useCallback((specs: ToastSpec[]) => {
    for (const spec of specs) toast.show(spec);
  }, [toast]);

  const track = useCallback(async <T,>(key: string, work: () => Promise<T>): Promise<T | null> => {
    if (inFlight.current.has(key)) return null;
    inFlight.current.add(key);
    setPending(new Set(inFlight.current));
    try {
      return await work();
    } finally {
      inFlight.current.delete(key);
      setPending(new Set(inFlight.current));
    }
  }, []);

  /** Shared failure path: 409 refreshes the cache first, 401 is left to the session gate. */
  const fail = useCallback((raw: unknown, title: string, runOptions: RunOptions): CommandOutcome => {
    const error = asApiError(raw);
    const message = errorMessage(error);
    if (error.code === 'conflict') {
      const snapshot = error.snapshot;
      if (snapshot) {
        data.queryClient.setQueryData<EventSnapshotDto>(adminKeys.snapshot(snapshot.eventId),
          current => (isSnapshotNewer(snapshot, current) ? snapshot : current));
      }
      if (!runOptions.inline) toast.show({ title: 'The event changed', description: message, tone: 'danger' });
      return { status: 'conflict', error, message, snapshot };
    }
    if (!runOptions.inline && !error.isUnauthenticated) toast.show({ title, description: message, tone: 'danger' });
    return { status: 'failed', error, message };
  }, [data.queryClient, toast]);

  const run = useCallback(async (snapshot: EventSnapshotDto, command: AdminCommandDto, runOptions: RunOptions = {}) => {
    if (!canRun(session, command.type) || snapshot.status !== 'active') return { status: 'skipped' } as const;
    // Built once per intent: automatic retries inside the client resend this exact object.
    const request = { commandId: newCommandId(), eventId: snapshot.eventId, command, precondition: preconditionFor(snapshot, command) };
    const outcome = await track(actionKey(command), async (): Promise<CommandOutcome> => {
      try {
        const result = await client.send(request);
        show(resultToasts(snapshot, command, result));
        return { status: result.applied ? 'applied' : 'noop', result };
      } catch (error) {
        return fail(error, `Could not ${commandVerb(snapshot, command)}`, runOptions);
      }
    });
    return outcome ?? { status: 'skipped' } as const;
  }, [client, fail, session, show, track]);

  const refreshPanels = useCallback(async (snapshot: EventSnapshotDto, runOptions: RunOptions = {}) => {
    if (!canRefreshPanels(session) || snapshot.status !== 'active') return { status: 'skipped' } as const;
    const outcome = await track(REFRESH_KEY, async (): Promise<CommandOutcome> => {
      try {
        const result = await client.refreshPanels({ eventId: snapshot.eventId });
        show(refreshToasts(result));
        return { status: 'refreshed', result };
      } catch (error) {
        return fail(error, 'Could not refresh the Discord panels', runOptions);
      }
    });
    return outcome ?? { status: 'skipped' } as const;
  }, [client, fail, session, show, track]);

  const isPending = useCallback((key: string) => pending.has(key), [pending]);
  return useMemo(() => ({ run, refreshPanels, isPending }), [run, refreshPanels, isPending]);
}
