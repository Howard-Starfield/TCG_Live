// Shell state: which event is viewed, which match the live canvas shows, and the preview dock.
import type { EventSnapshotDto, EventSummaryDto, MatchId, RuntimeStatusDto, SessionDto } from '@tcg-live/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useActiveEventId, useEvents, useEventSnapshot, useRuntimeStatus, type CanvasView } from '../../data';
import { useConsolePreferences } from '../../app/preferences';
import { NARROW_QUERY, useMediaQuery } from './useMediaQuery';

export type PaneKey = 'live' | 'list';

export interface ViewedEvent {
  eventId: string | null;
  summary: EventSummaryDto | undefined;
  snapshot: EventSnapshotDto | undefined;
  /** `none`: nothing to show (no active event and nothing selected). */
  status: 'none' | 'loading' | 'ready' | 'error';
  error: Error | null;
  /** A retired event: read-only history. */
  retired: boolean;
  /** Nothing to show because PostgreSQL is down (the stream reports no active event until it recovers). */
  waitingForDatabase: boolean;
  retry(): void;
}

export interface DockApi {
  /** Below 1100 px the dock is an overlay sheet. */
  narrow: boolean;
  /** Panes actually shown (desktop: the preferences; narrow: only while the sheet is open). */
  visible: Record<PaneKey, boolean>;
  sheetOpen: boolean;
  toggle(pane: PaneKey): void;
  open(pane: PaneKey): void;
  close(pane: PaneKey): void;
  dismissSheet(): void;
}

export interface ShellModel {
  session: SessionDto;
  status: RuntimeStatusDto | undefined;
  events: EventSummaryDto[];
  eventsState: 'loading' | 'error' | 'ready';
  refetchEvents(): void;
  activeEventId: string | null;
  viewed: ViewedEvent;
  /** Views an event; the active one means "follow live". */
  selectEvent(eventId: string): void;
  followActive(): void;
  canvasView: CanvasView;
  liveMatch: MatchId | null;
  setCanvas(view: CanvasView, matchId: MatchId | null): void;
  /** Opens the Live preview on a match's lifecycle. */
  openMatch(matchId: MatchId): void;
  dock: DockApi;
}

const ShellContext = createContext<ShellModel | null>(null);

export const ShellProvider = ShellContext.Provider;

export function useShell(): ShellModel {
  const model = useContext(ShellContext);
  if (!model) throw new Error('useShell() must be used inside the console shell.');
  return model;
}

function useDock(): DockApi {
  const [preferences, update] = useConsolePreferences();
  const narrow = useMediaQuery(NARROW_QUERY);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { if (!narrow) setSheetOpen(false); }, [narrow]);

  const { panes } = preferences;
  const showing = !narrow || sheetOpen;
  const visible = useMemo(() => ({ live: panes.live && showing, list: panes.list && showing }), [panes.live, panes.list, showing]);
  const anyOpen = visible.live || visible.list;

  const open = useCallback((pane: PaneKey) => {
    update({ panes: { [pane]: true } });
    if (narrow) setSheetOpen(true);
  }, [narrow, update]);
  const close = useCallback((pane: PaneKey) => update({ panes: { [pane]: false } }), [update]);
  const toggle = useCallback((pane: PaneKey) => {
    if (visible[pane]) close(pane);
    else open(pane);
  }, [visible, open, close]);
  const dismissSheet = useCallback(() => setSheetOpen(false), []);

  return { narrow, visible, sheetOpen: narrow && sheetOpen && anyOpen, toggle, open, close, dismissSheet };
}

/** Builds the shell model from the data layer and preferences. */
export function useShellModel(session: SessionDto): ShellModel {
  const [preferences, update] = useConsolePreferences();
  const status = useRuntimeStatus();
  const eventsQuery = useEvents();
  const activeEventId = useActiveEventId();
  const events = eventsQuery.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [liveMatch, setLiveMatch] = useState<MatchId | null>(null);

  // A selected event that left the list (or is the active one) falls back to following live.
  const selectedSummary = selected ? events.find(event => event.eventId === selected) : undefined;
  const following = !selected || selected === activeEventId || (eventsQuery.isSuccess && !selectedSummary);
  const viewedId = following ? activeEventId : selected;
  const snapshotQuery = useEventSnapshot(viewedId);
  const summary = viewedId ? events.find(event => event.eventId === viewedId) : undefined;
  const snapshot = snapshotQuery.data && snapshotQuery.data.eventId === viewedId ? snapshotQuery.data : undefined;

  useEffect(() => { setLiveMatch(null); }, [viewedId]);

  const refetchSnapshot = snapshotQuery.refetch;
  const viewed = useMemo<ViewedEvent>(() => ({
    eventId: viewedId,
    summary,
    snapshot,
    status: !viewedId ? 'none' : snapshot ? 'ready' : snapshotQuery.error ? 'error' : 'loading',
    error: snapshotQuery.error,
    retired: (snapshot?.status ?? summary?.status) === 'retired',
    waitingForDatabase: !snapshot && status.data?.database === 'unavailable',
    retry: () => { void refetchSnapshot(); }
  }), [viewedId, summary, snapshot, snapshotQuery.error, refetchSnapshot, status.data?.database]);

  const dock = useDock();
  const setCanvas = useCallback((view: CanvasView, matchId: MatchId | null) => {
    update({ canvasView: view });
    setLiveMatch(matchId);
  }, [update]);
  const openMatch = useCallback((matchId: MatchId) => {
    setCanvas('match', matchId);
    dock.open('live');
  }, [setCanvas, dock]);

  const refetchEvents = eventsQuery.refetch;
  return {
    session,
    status: status.data,
    events,
    eventsState: eventsQuery.data ? 'ready' : eventsQuery.error ? 'error' : 'loading',
    refetchEvents: () => { void refetchEvents(); },
    activeEventId,
    viewed,
    selectEvent: eventId => setSelected(eventId === activeEventId ? null : eventId),
    followActive: () => setSelected(null),
    canvasView: preferences.canvasView,
    liveMatch,
    setCanvas,
    openMatch,
    dock
  };
}
