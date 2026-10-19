// Live preview pane. L5 (web-flow) owns this folder; L6 (web-shell) hosts LivePreview and wires
// getServerNow from L4's stream clock. Keep LivePreviewProps stable.
import '@xyflow/react/dist/base.css';
import type { EventSnapshotDto, MatchId } from '@tcg-live/core';
import type { FlowGraph } from './types';
import {
  Background, BackgroundVariant, Panel, ReactFlow, ReactFlowProvider, useReactFlow, useStore
} from '@xyflow/react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { FlowContext, usePrefersReducedMotion, type FlowContextValue } from './context';
import { EdgeMarkers, edgeTypes } from './edge';
import { buildFlowGraph, reconcileGraph, resolveMatchId } from './layout';
import { nodeTypes } from './nodes';
import { useThrottledValue } from './throttle';
import { chooseOrientation, computeViewport, type PaneSize } from './viewport';

export type FlowView = 'event' | 'match';

export interface LivePreviewProps {
  snapshot: EventSnapshotDto;
  view: FlowView;
  /** The match shown in the Match view; null selects the first match needing attention, else M1. */
  matchId: MatchId | null;
  /** Clicking a match node in the Event view requests the Match view. */
  onViewChange(view: FlowView, matchId: MatchId | null): void;
  /** Server-corrected clock for countdowns; defaults to Date.now. */
  getServerNow?: () => number;
  className?: string;
}

export { buildEventGraph, buildFlowGraph, buildMatchGraph, reconcileGraph, resolveMatchId } from './layout';
export { GRAPH_UPDATE_INTERVAL_MS, useThrottledValue } from './throttle';
export type { FlowEdgeState, FlowGraph, FlowNodeState, FlowOrientation } from './types';
export { chooseOrientation, computeViewport, READABLE_ZOOM } from './viewport';

/** Read-only live canvas for one event: the Event view or one match's lifecycle. */
export function LivePreview(props: LivePreviewProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvas({ snapshot, view, matchId, onViewChange, getServerNow = Date.now, className }: LivePreviewProps) {
  // Streams can deliver many snapshots per second; the graph follows at most five times a second.
  const throttled = useThrottledValue(snapshot);
  const shownMatch = resolveMatchId(throttled, matchId);
  // The pane size React Flow measured; a tall or narrow dock pane switches to the top-to-bottom layout.
  const paneWidth = useStore(state => state.width);
  const paneHeight = useStore(state => state.height);
  const pane = useMemo<PaneSize | null>(
    () => (paneWidth > 0 && paneHeight > 0 ? { width: paneWidth, height: paneHeight } : null),
    [paneWidth, paneHeight]
  );
  const candidates = useMemo(() => ({
    horizontal: buildFlowGraph(throttled, view, shownMatch, 'horizontal'),
    vertical: buildFlowGraph(throttled, view, shownMatch, 'vertical')
  }), [throttled, view, shownMatch]);
  const orientation = chooseOrientation(pane, candidates.horizontal.bounds, candidates.vertical.bounds);
  // Unchanged nodes and edges keep their object identity, so React Flow keeps its internal state and
  // edge components (and their animations) stay mounted across updates.
  const previousGraph = useRef<FlowGraph | null>(null);
  const graph = useMemo(
    () => reconcileGraph(previousGraph.current, candidates[orientation]),
    [candidates, orientation]
  );
  useEffect(() => { previousGraph.current = graph; }, [graph]);
  const reducedMotion = usePrefersReducedMotion();
  const markerPrefix = `tcgf-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // Callbacks from the host may be inline functions; keep them in refs behind stable wrappers so a
  // parent re-render never re-renders every node or restarts every clock interval.
  const onViewChangeRef = useRef(onViewChange);
  const getServerNowRef = useRef(getServerNow);
  useLayoutEffect(() => {
    onViewChangeRef.current = onViewChange;
    getServerNowRef.current = getServerNow;
  }, [onViewChange, getServerNow]);
  const stableNow = useCallback(() => getServerNowRef.current(), []);

  // Opening a match from the keyboard unmounts the focused node; focus then moves to the switcher.
  const focusAfterViewChange = useRef(false);
  const context = useMemo<FlowContextValue>(() => ({
    markerPrefix, reducedMotion, getServerNow: stableNow,
    openMatch: view === 'event'
      ? (id: MatchId) => {
          focusAfterViewChange.current = true;
          onViewChangeRef.current('match', id);
        }
      : null
  }), [markerPrefix, reducedMotion, stableNow, view]);

  const { setViewport } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const duration = reducedMotion ? 0 : 220;

  // Place the camera when the layout (view, match, orientation) or the pane size changes, never on a
  // data update, so a user's own pan and zoom survive live updates. The fit keeps text readable.
  const graphRef = useRef(graph);
  useLayoutEffect(() => { graphRef.current = graph; }, [graph]);
  const placedLayout = useRef<string | null>(null);
  useEffect(() => {
    if (!pane) return;
    const layoutChanged = placedLayout.current !== null && placedLayout.current !== graph.layoutKey;
    placedLayout.current = graph.layoutKey;
    void setViewport(computeViewport(graphRef.current, pane), { duration: layoutChanged ? duration : 0 });
  }, [graph.layoutKey, pane, setViewport, duration]);

  /** The Fit view button shows everything, however small. */
  const fitAll = useCallback(() => {
    if (pane) void setViewport(computeViewport(graphRef.current, pane, 0), { duration });
  }, [pane, setViewport, duration]);

  useEffect(() => {
    if (!focusAfterViewChange.current) return;
    focusAfterViewChange.current = false;
    // The opened node is still mounted here (React Flow swaps nodes after this effect) but is about
    // to unmount, so move focus now rather than waiting for it to fall to <body>.
    containerRef.current?.querySelector<HTMLButtonElement>('.tcg-flow-toolbar button[aria-pressed="true"]')?.focus();
  }, [graph.layoutKey]);

  const viewTitle = view === 'event' ? 'Event view' : `Match ${shownMatch} lifecycle`;

  return (
    <div ref={containerRef} className={['tcg-flow', className].filter(Boolean).join(' ')}
      data-testid="live-preview" data-event={snapshot.eventId} data-view={view}
      data-match={view === 'match' ? shownMatch : undefined} data-orientation={graph.orientation}
      data-reduced-motion={reducedMotion || undefined}>
      <FlowContext.Provider value={context}>
        <EdgeMarkers prefix={markerPrefix} />
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          aria-label={`Live preview, ${viewTitle}`}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          edgesReconnectable={false}
          zoomOnDoubleClick={false}
          minZoom={0.35}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.1} color="var(--tcg-flow-grid)" />
          <Panel position="top-left">
            <ViewSwitcher snapshot={throttled} view={view} matchId={shownMatch} onViewChange={onViewChange} />
          </Panel>
          <Panel position="top-right" className="tcg-flow-legend-panel">
            <Legend />
          </Panel>
          <Panel position="bottom-left">
            <ZoomControls duration={duration} onFit={fitAll} />
          </Panel>
        </ReactFlow>
      </FlowContext.Provider>
    </div>
  );
}

function ViewSwitcher({ snapshot, view, matchId, onViewChange }: {
  snapshot: EventSnapshotDto; view: FlowView; matchId: MatchId; onViewChange: LivePreviewProps['onViewChange'];
}) {
  return (
    <div className="tcg-flow-toolbar" role="group" aria-label="Canvas view">
      <button type="button" aria-pressed={view === 'event'} onClick={() => onViewChange('event', matchId)}>Event</button>
      {snapshot.matches.map(match => (
        <button key={match.id} type="button" aria-pressed={view === 'match' && matchId === match.id}
          aria-label={`Match ${match.id}`} onClick={() => onViewChange('match', match.id)}>
          {match.id}
          {match.judge && <span className="tcg-flow-toolbar-flag" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

function ZoomControls({ duration, onFit }: { duration: number; onFit(): void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  return (
    <div className="tcg-flow-toolbar is-icons" role="group" aria-label="Zoom">
      <button type="button" aria-label="Fit view" title="Fit view" onClick={onFit}><Maximize aria-hidden /></button>
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => void zoomOut({ duration })}><Minus aria-hidden /></button>
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => void zoomIn({ duration })}><Plus aria-hidden /></button>
    </div>
  );
}

function Legend() {
  return (
    <ul className="tcg-flow-legend" aria-label="Legend">
      <li className="is-active">live</li>
      <li className="is-waiting">needs judge</li>
      <li className="is-done">done</li>
    </ul>
  );
}
