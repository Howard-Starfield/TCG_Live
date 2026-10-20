// Command context (L10): one useAdminCommand per signed-in shell, plus the dialogs it opens.
// Action slots call useCommands(); without a provider (galleries, list tests) they render nothing.
import type { MatchAdminAction, MatchId, Seat, SessionDto, Snowflake } from '@tcg-live/core';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useEventSnapshot } from '../../data';
import type { CommandClient } from './client';
import { MatchActionDialog, RemoveMemberDialog } from './dialogs';
import { useAdminCommand, type AdminCommandApi } from './useAdminCommand';

export interface MatchActionRequest {
  eventId: string;
  matchId: MatchId;
  action: MatchAdminAction;
  /** Prefills from the composer. */
  winner?: Seat | null;
  reason?: string | null;
  /** Called once the command was accepted (applied or no change). */
  onDone?: () => void;
}

export interface RemoveRequest { eventId: string; memberId: Snowflake; onDone?: () => void }

export interface CommandsApi extends AdminCommandApi {
  session: SessionDto;
  /** Opens the reason dialog for resolve, correct or judge-resume. */
  openMatchAction(request: MatchActionRequest): void;
  /** Opens the removal confirmation for a signup member. */
  confirmRemove(request: RemoveRequest): void;
}

type DialogState = ({ kind: 'match' } & MatchActionRequest) | ({ kind: 'remove' } & RemoveRequest) | null;

const CommandsContext = createContext<CommandsApi | null>(null);

/** The command API, or null when commands are not mounted (read-only surfaces). */
export function useCommands(): CommandsApi | null {
  return useContext(CommandsContext);
}

export interface CommandsProviderProps {
  session: SessionDto;
  children?: ReactNode;
  /** Test seam: a client with fast retries. */
  client?: CommandClient;
}

export function CommandsProvider({ session, children, client }: CommandsProviderProps) {
  const commands = useAdminCommand(session, client ? { client } : {});
  // The last request stays mounted after closing so the dialog can animate out; `id` resets its fields.
  const [dialog, setDialog] = useState<{ id: number; open: boolean; state: DialogState }>({ id: 0, open: false, state: null });
  const show = useCallback((state: NonNullable<DialogState>) => setDialog(current => ({ id: current.id + 1, open: true, state })), []);
  const openMatchAction = useCallback((request: MatchActionRequest) => show({ kind: 'match', ...request }), [show]);
  const confirmRemove = useCallback((request: RemoveRequest) => show({ kind: 'remove', ...request }), [show]);
  const close = useCallback(() => setDialog(current => ({ ...current, open: false })), []);
  const api = useMemo<CommandsApi>(() => ({ ...commands, session, openMatchAction, confirmRemove }),
    [commands, session, openMatchAction, confirmRemove]);

  return (
    <CommandsContext.Provider value={api}>
      {children}
      {dialog.state && <DialogHost key={dialog.id} dialog={dialog.state} open={dialog.open} api={api} onClose={close} />}
    </CommandsContext.Provider>
  );
}

/** Reads the dialog's event live from the cache, so a 409 or a stream change shows up while it is open. */
function DialogHost({ dialog, open, api, onClose }: { dialog: NonNullable<DialogState>; open: boolean; api: CommandsApi; onClose(): void }) {
  const snapshot = useEventSnapshot(dialog.eventId).data;
  if (!snapshot) return null;
  if (dialog.kind === 'match') {
    return <MatchActionDialog open={open} api={api} snapshot={snapshot} request={dialog} onClose={onClose} />;
  }
  return <RemoveMemberDialog open={open} api={api} snapshot={snapshot} request={dialog} onClose={onClose} />;
}
