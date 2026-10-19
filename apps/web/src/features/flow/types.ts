// Graph model for the Live preview canvas. Everything here is plain data produced by the pure
// layout functions in layout.ts; the React Flow node and edge components only render it.
import type { Edge, Node } from '@xyflow/react';
import type { ClockDto, JudgeReason, MatchId, MatchPhase, Seat } from '@tcg-live/core';

/**
 * Node states (see Canvas semantics in docs/ADMIN_DASHBOARD_PLAN.md):
 * - `done`: completed, static green;
 * - `live`: happening now, rotating clay ring;
 * - `waiting`: waiting on a judge, slow red ring;
 * - `interrupted`: a persisted running clock owned by another process; frozen, never a ring;
 * - `current`: the current step, but nothing is running (for example a player pause);
 * - `alert`: a step that went wrong and is now in the judge's hands (a disputed result);
 * - `pending`: not reached yet;
 * - `muted`: a branch this match did not take.
 */
export const NODE_STATES = ['done', 'live', 'waiting', 'interrupted', 'current', 'alert', 'pending', 'muted'] as const;
export type FlowNodeState = typeof NODE_STATES[number];

/**
 * Edge states. Active (live play) and waiting (a judge) edges flow toward the node where something is
 * happening; `current` leads to a current step where nothing runs, so it is clay but static.
 */
export const EDGE_STATES = ['done', 'active', 'current', 'waiting', 'blocked', 'pending', 'muted'] as const;
export type FlowEdgeState = typeof EDGE_STATES[number];

export type StageId = 'signup' | 'checkin' | 'round' | 'standings';
export type StepId = 'ready' | 'running' | 'paused' | 'proposal' | 'confirm' | 'dispute' | 'judge' | 'final';

export type StageNodeData = {
  stage: StageId;
  title: string;
  subtitle: string;
  state: FlowNodeState;
};

/** Header status of a match card. */
export type MatchStatus = 'waiting' | 'setup' | 'live' | 'paused' | 'judge' | 'interrupted' | 'final';

export type SeatTone = 'default' | 'success' | 'danger' | 'accent';

export type SeatRow = {
  seat: Seat;
  name: string;
  meta: string;
  tone: SeatTone;
};

export type MatchNodeData = {
  matchId: MatchId;
  state: FlowNodeState;
  status: MatchStatus;
  phase: MatchPhase;
  published: boolean;
  clock: ClockDto;
  judgeReasons: JudgeReason[] | null;
  winnerName: string | null;
  seats: [SeatRow, SeatRow];
};

export type StepNodeData = {
  matchId: MatchId;
  step: StepId;
  title: string;
  /** Static subtitle; the running step derives its subtitle from `clock` at render time instead. */
  subtitle: string;
  state: FlowNodeState;
  clock: ClockDto | null;
  phase: MatchPhase;
};

export type StageFlowNode = Node<StageNodeData, 'stage'>;
export type MatchFlowNode = Node<MatchNodeData, 'match'>;
export type StepFlowNode = Node<StepNodeData, 'step'>;
export type FlowNode = StageFlowNode | MatchFlowNode | StepFlowNode;

export type FlowEdgeData = {
  state: FlowEdgeState;
  label: string | null;
  /** Shift the label away from the curve's midpoint, in flow pixels. */
  labelOffset?: { x: number; y: number };
  /** Draw arrowheads at both ends (Running ⇄ Paused). */
  bidirectional?: boolean;
};

export type FlowEdge = Edge<FlowEdgeData, 'flow'>;

export interface FlowGraph {
  /** Changes only when the layout itself changes (view or match), never on a data update. */
  layoutKey: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
