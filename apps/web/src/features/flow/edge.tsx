// The one custom edge: a dotted bezier whose state sets colour, motion, arrowheads and label tone.
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps, type EdgeTypes } from '@xyflow/react';
import { memo } from 'react';
import { useFlowContext } from './context';
import { EDGE_STATES, type FlowEdge as FlowEdgeType, type FlowEdgeState } from './types';

export function markerId(prefix: string, state: FlowEdgeState): string {
  return `${prefix}-arrow-${state}`;
}

/** Arrowhead definitions, one per state. Rendered inside each canvas so markers inherit its theme. */
export function EdgeMarkers({ prefix }: { prefix: string }) {
  return (
    <svg className="tcg-flow-markers" aria-hidden focusable="false" width="0" height="0">
      <defs>
        {EDGE_STATES.map(state => (
          <marker key={state} id={markerId(prefix, state)} viewBox="-10 -10 20 20" markerWidth="14" markerHeight="14"
            markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path className={`tcg-flow-arrow is-${state}`} d="M-6.5,-4.5 L0,0 L-6.5,4.5 Q-5,0 -6.5,-4.5 Z" />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

/** Seconds for the traveling dot to cross an active edge. */
const TRAVEL_SECONDS = 1.6;

export const FlowEdge = memo(function FlowEdge(props: EdgeProps<FlowEdgeType>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const { markerPrefix, reducedMotion } = useFlowContext();
  const state: FlowEdgeState = data?.state ?? 'pending';
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.32
  });
  const marker = `url(#${markerId(markerPrefix, state)})`;
  const offset = data?.labelOffset ?? { x: 0, y: 0 };
  return (
    <>
      <BaseEdge path={path} className={`tcg-flow-edge is-${state}`} interactionWidth={0}
        markerEnd={marker} markerStart={data?.bidirectional ? marker : undefined} data-state={state} />
      {state === 'active' && !reducedMotion && (
        <g className="tcg-flow-traveler" aria-hidden>
          <circle r={6} className="tcg-flow-traveler-halo">
            <animateMotion dur={`${TRAVEL_SECONDS}s`} repeatCount="indefinite" path={path} />
          </circle>
          <circle r={3}>
            <animateMotion dur={`${TRAVEL_SECONDS}s`} repeatCount="indefinite" path={path} />
          </circle>
        </g>
      )}
      {data?.label && (
        <EdgeLabelRenderer>
          <div className={`tcg-flow-edge-label is-${state}`} aria-hidden
            style={{ transform: `translate(-50%, -50%) translate(${labelX + offset.x}px, ${labelY + offset.y}px)` }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** Stable module-level map, as React Flow requires. */
export const edgeTypes: EdgeTypes = { flow: FlowEdge };
