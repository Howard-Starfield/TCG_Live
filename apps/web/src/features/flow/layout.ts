// Deterministic canvas layouts, mapped purely from an event snapshot. No clocks are read here:
// countdowns tick inside the node components, so a tick never re-runs the layout.
import { formatClock, type EventSnapshotDto, type EventStage, type MatchDto, type MatchId, type Seat } from '@tcg-live/core';
import { Position, type NodeHandle } from '@xyflow/react';
import { seatName } from './labels';
import type {
  FlowEdge, FlowEdgeData, FlowEdgeState, FlowGraph, FlowNode, FlowNodeState, MatchNodeData, MatchStatus,
  SeatRow, StageNodeData, StepId, StepNodeData
} from './types';
import type { FlowView } from './index';

/** Rendered node sizes in flow pixels; flow.css uses the same values. */
export const NODE_SIZE = {
  stage: { width: 56, height: 56 },
  match: { width: 196, height: 88 },
  step: { width: 118, height: 52 }
} as const;

type Side = 'top' | 'right' | 'bottom' | 'left';

const SIDE_POSITIONS: [Side, Position][] = [
  ['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom], ['left', Position.Left]
];

/**
 * Explicit 1px anchors on each side's midpoint, as both source (`s-<side>`) and target (`t-<side>`).
 * With `measured` and `handles` set, React Flow never has to re-measure a node when the snapshot
 * changes, so edges stay mounted between updates.
 */
export function nodeAnchors(width: number, height: number): NodeHandle[] {
  const box: Record<Side, { x: number; y: number }> = {
    top: { x: width / 2 - 0.5, y: 0 },
    right: { x: width - 1, y: height / 2 - 0.5 },
    bottom: { x: width / 2 - 0.5, y: height - 1 },
    left: { x: 0, y: height / 2 - 0.5 }
  };
  return (['source', 'target'] as const).flatMap(type => SIDE_POSITIONS.map(([side, position]) => ({
    id: `${type === 'source' ? 's' : 't'}-${side}`, type, position, ...box[side], width: 1, height: 1
  })));
}

/** Fixed size, measured size and anchors for a node kind. */
function sized(kind: keyof typeof NODE_SIZE) {
  const { width, height } = NODE_SIZE[kind];
  return { width, height, measured: { width, height }, handles: nodeAnchors(width, height) };
}

const STAGE_INDEX: Record<EventStage, number> = { signup: 0, checkin: 1, live: 2, complete: 3 };

/** The match shown in the Match view: the requested one, else the first needing a judge, else the first. */
export function resolveMatchId(snapshot: EventSnapshotDto, requested: MatchId | null): MatchId {
  if (requested && snapshot.matches.some(match => match.id === requested)) return requested;
  return (snapshot.matches.find(match => match.judge !== null) ?? snapshot.matches[0])?.id ?? 'M1';
}

/** Event view node state of a match. A judge outranks an interrupted clock; neither is ever a live ring. */
export function matchNodeState(snapshot: EventSnapshotDto, match: MatchDto): FlowNodeState {
  if (!snapshot.published) return 'pending';
  if (match.phase === 'final') return 'done';
  if (match.judge) return 'waiting';
  if (match.clock.state === 'interrupted') return 'interrupted';
  if (match.phase === 'running' || match.phase === 'setup') return 'live';
  return 'current';
}

function matchStatus(snapshot: EventSnapshotDto, match: MatchDto): MatchStatus {
  if (!snapshot.published) return 'waiting';
  if (match.phase === 'final') return 'final';
  if (match.judge) return 'judge';
  if (match.clock.state === 'interrupted') return 'interrupted';
  if (match.phase === 'running') return 'live';
  if (match.phase === 'paused') return 'paused';
  return 'setup';
}

/** The edge flowing into a node mirrors what is happening at that node. */
export function edgeInto(state: FlowNodeState): FlowEdgeState {
  switch (state) {
    case 'done': return 'done';
    case 'live': return 'active';
    case 'current': return 'current';
    case 'waiting':
    case 'alert': return 'waiting';
    case 'interrupted': return 'blocked';
    case 'pending': return 'pending';
    case 'muted': return 'muted';
  }
}

function seatRow(snapshot: EventSnapshotDto, match: MatchDto, seat: Seat): SeatRow {
  const row: SeatRow = { seat, name: seatName(snapshot, seat), meta: '', tone: 'default' };
  const proposal = match.proposal;
  if (match.phase === 'final') {
    if (match.finalWinner === seat) Object.assign(row, { meta: match.finalSource === 'admin' ? 'winner · judge' : 'winner', tone: 'success' });
    else if (match.confirmedBy === seat) row.meta = 'confirmed';
  } else if (proposal?.decision === 'disputed' && proposal.reporter !== seat) {
    Object.assign(row, { meta: 'disputed', tone: 'danger' });
  } else if (match.judge?.raisedBy.includes(seat)) {
    Object.assign(row, { meta: 'called judge', tone: 'danger' });
  } else if (proposal && proposal.reporter === seat) {
    row.meta = proposal.winner === seat ? 'reported win' : `reported ${proposal.winner} won`;
  } else if (proposal?.decision === 'open') {
    row.meta = 'to confirm';
  } else if (match.phase === 'setup' && snapshot.published) {
    Object.assign(row, match.ready.includes(seat) ? { meta: 'ready', tone: 'success' } : { meta: 'not ready' });
  } else if (match.phase === 'paused' && match.resumeConsents.includes(seat)) {
    row.meta = 'resume ok';
  }
  return row;
}

function handles(from: Side, to: Side): { sourceHandle: string; targetHandle: string } {
  return { sourceHandle: `s-${from}`, targetHandle: `t-${to}` };
}

function edge(source: string, from: Side, target: string, to: Side, data: FlowEdgeData): FlowEdge {
  return { id: `${source}->${target}`, type: 'flow', source, target, ...handles(from, to), data };
}

const STAGE_Y = 102;
const STAGE_X = { signup: 0, checkin: 140, round: 280, matches: 420, standings: 692 } as const;
const MATCH_Y: Record<number, number> = { 0: 30, 1: 146 };

/** Event view: Signup → Check-in → Round 1 → M1 / M2 → Standings. */
export function buildEventGraph(snapshot: EventSnapshotDto): FlowGraph {
  const index = STAGE_INDEX[snapshot.stage];
  const signup = snapshot.signup;
  const matches = snapshot.matches;
  const finals = matches.filter(match => match.phase === 'final').length;

  const stage = (id: StageNodeData['stage'], x: number, data: Omit<StageNodeData, 'stage'>): FlowNode => ({
    id, type: 'stage', position: { x, y: STAGE_Y }, data: { stage: id, ...data }, ...sized('stage')
  });

  const nodes: FlowNode[] = [
    stage('signup', STAGE_X.signup, {
      title: 'Signup',
      subtitle: signup ? `${signup.roster.length} / ${signup.capacity} joined` : 'seats assigned',
      state: index === 0 ? 'live' : 'done'
    }),
    stage('checkin', STAGE_X.checkin, {
      title: 'Check-in',
      subtitle: index === 0 ? 'after signup' : `${snapshot.checkins.length} / 4 in`,
      state: index < 1 ? 'pending' : index === 1 ? 'live' : 'done'
    }),
    stage('round', STAGE_X.round, {
      title: 'Round 1',
      subtitle: !snapshot.published ? 'not published' : finals === matches.length ? 'complete' : `${matches.length - finals} in play`,
      state: snapshot.published ? 'done' : 'pending'
    })
  ];

  const edges: FlowEdge[] = [
    edge('signup', 'right', 'checkin', 'left', {
      state: index === 0 ? 'pending' : index === 1 ? 'active' : 'done',
      label: signup ? `${signup.roster.length} joined` : null
    }),
    edge('checkin', 'right', 'round', 'left', {
      state: index < 2 ? 'pending' : 'done',
      label: index === 0 ? null : `${snapshot.checkins.length} / 4`
    })
  ];

  matches.forEach((match, position) => {
    const state = matchNodeState(snapshot, match);
    const data: MatchNodeData = {
      matchId: match.id, state, status: matchStatus(snapshot, match), phase: match.phase,
      published: snapshot.published, clock: match.clock,
      judgeReasons: match.judge ? [...match.judge.reasons] : null,
      winnerName: match.finalWinner ? seatName(snapshot, match.finalWinner) : null,
      seats: [seatRow(snapshot, match, match.seats[0]), seatRow(snapshot, match, match.seats[1])]
    };
    nodes.push({
      id: match.id, type: 'match', position: { x: STAGE_X.matches, y: MATCH_Y[position] ?? 30 + position * 116 },
      data, ...sized('match')
    });
    const above = position === 0;
    edges.push(edge('round', 'right', match.id, 'left', {
      state: snapshot.published ? edgeInto(state) : 'pending',
      label: `${match.seats[0]} · ${match.seats[1]}`,
      labelOffset: { x: 0, y: above ? -10 : 10 }
    }));
    let out: FlowEdgeData;
    if (!snapshot.published) out = { state: 'pending', label: null };
    else if (match.phase === 'final') out = { state: 'done', label: match.finalWinner ? `${match.finalWinner} won` : 'final' };
    else if (match.judge) out = { state: 'blocked', label: 'held' };
    else if (match.clock.state === 'interrupted') out = { state: 'blocked', label: 'interrupted' };
    else out = { state: 'pending', label: match.phase === 'setup' ? 'setup' : match.phase === 'paused' ? 'paused' : 'in play' };
    edges.push(edge(match.id, 'right', 'standings', 'left', { ...out, labelOffset: { x: 0, y: above ? -10 : 10 } }));
  });

  nodes.push(stage('standings', STAGE_X.standings, {
    title: 'Standings',
    subtitle: index === 3 ? `${finals} / ${matches.length} final` : snapshot.published ? `waiting on ${matches.length - finals}` : '—',
    state: index === 3 ? 'done' : 'pending'
  }));

  return { layoutKey: 'event', nodes, edges };
}

const STEP_X = [0, 162, 324, 486, 648] as const;
const STEP_ROW = 100;
const STEP_POSITION: Record<StepId, { x: number; y: number }> = {
  paused: { x: STEP_X[1], y: 0 },
  ready: { x: STEP_X[0], y: STEP_ROW },
  running: { x: STEP_X[1], y: STEP_ROW },
  proposal: { x: STEP_X[2], y: STEP_ROW },
  confirm: { x: STEP_X[3], y: STEP_ROW },
  final: { x: STEP_X[4], y: STEP_ROW },
  dispute: { x: STEP_X[2], y: 196 },
  judge: { x: STEP_X[3], y: 286 }
};

const STEP_TITLES: Record<StepId, string> = {
  ready: 'Ready', running: 'Running', paused: 'Paused', proposal: 'Proposal',
  confirm: 'Confirm', dispute: 'Dispute', judge: 'Judge', final: 'Final'
};

/** Steps in reading and focus order. */
const STEP_ORDER: StepId[] = ['ready', 'running', 'paused', 'proposal', 'confirm', 'dispute', 'judge', 'final'];

/** Match view: Ready → Running ⇄ Paused → Proposal → Confirm / Dispute → Final, with the Judge branch. */
export function buildMatchGraph(snapshot: EventSnapshotDto, matchId: MatchId): FlowGraph {
  const match = snapshot.matches.find(item => item.id === matchId) ?? snapshot.matches[0];
  if (!match) return { layoutKey: `match:${matchId}`, nodes: [], edges: [] };

  const published = snapshot.published;
  const phase = match.phase;
  const started = published && phase !== 'setup';
  const final = phase === 'final';
  const proposal = match.proposal;
  const disputed = proposal?.decision === 'disputed';
  const openProposal = proposal?.decision === 'open' && !final;
  const judge = match.judge;
  const agreed = final && match.finalSource === 'agreed';
  const adminFinal = final && match.finalSource === 'admin';
  const everPaused = match.pauseGeneration > 0;
  const interrupted = match.clock.state === 'interrupted';
  const otherReasons = judge?.reasons.filter(reason => reason !== 'dispute') ?? [];
  const reporterOpponent = proposal ? match.seats.find(seat => seat !== proposal.reporter) ?? null : null;
  /** Untaken branches are muted once the match is final, and otherwise not reached yet. */
  const untaken: FlowNodeState = final ? 'muted' : 'pending';
  const untakenEdge: FlowEdgeState = final ? 'muted' : 'pending';

  const states: Record<StepId, FlowNodeState> = {
    ready: !published ? 'pending' : phase === 'setup' ? (judge ? 'current' : 'live') : 'done',
    running: !started ? 'pending'
      : phase === 'running' ? (interrupted ? 'interrupted' : 'live')
        : phase === 'expired' ? 'alert' : 'done',
    paused: phase === 'paused' ? 'current' : everPaused ? 'done' : untaken,
    proposal: proposal ? (openProposal ? 'current' : 'done') : untaken,
    confirm: agreed ? 'done' : untaken,
    dispute: disputed ? (final ? 'done' : 'alert') : untaken,
    judge: judge ? 'waiting' : adminFinal ? 'done' : untaken,
    final: final ? 'done' : 'pending'
  };

  const subtitles: Record<StepId, string> = {
    ready: !published ? 'unpublished' : phase === 'setup' ? `${match.ready.length} / 2 ready` : `${match.seats[0]} vs ${match.seats[1]}`,
    running: started ? '' : `${formatClock(match.clock.durationMs)} clock`,
    paused: phase === 'paused' ? `${match.resumeConsents.length} / 2 to resume` : everPaused ? `paused ×${match.pauseGeneration}` : '—',
    proposal: proposal ? `${proposal.winner} won? · r${proposal.revision}` : '—',
    confirm: agreed && match.confirmedBy ? `by ${match.confirmedBy}` : openProposal && reporterOpponent ? `awaiting ${reporterOpponent}` : '—',
    dispute: disputed && reporterOpponent ? `by ${reporterOpponent}` : '—',
    judge: judge ? judge.reasons.join(' · ') : adminFinal ? 'resolved' : '—',
    final: final && match.finalWinner ? `${match.finalWinner} won${adminFinal ? ' · judge' : ''}` : '—'
  };

  const nodes: FlowNode[] = STEP_ORDER.map(step => {
    const data: StepNodeData = {
      matchId: match.id, step, title: STEP_TITLES[step], subtitle: subtitles[step], state: states[step],
      clock: step === 'running' && started ? match.clock : null, phase
    };
    return {
      id: step, type: 'step', position: STEP_POSITION[step], data, ...sized('step')
    };
  });

  const edges: FlowEdge[] = [
    edge('ready', 'right', 'running', 'left', {
      state: !started ? 'pending' : phase === 'running' ? (interrupted ? 'blocked' : 'active') : 'done',
      label: published ? `${match.ready.length} / 2` : null
    }),
    edge('running', 'top', 'paused', 'bottom', {
      state: phase === 'paused' ? 'current' : everPaused ? 'done' : untakenEdge,
      label: 'pause · resume', bidirectional: true
    }),
    edge('running', 'right', 'proposal', 'left', {
      state: proposal ? (openProposal ? 'current' : 'done') : untakenEdge, label: 'report'
    }),
    edge('proposal', 'right', 'confirm', 'left', {
      state: agreed ? 'done' : untakenEdge, label: 'confirm'
    }),
    edge('confirm', 'right', 'final', 'left', { state: agreed ? 'done' : untakenEdge, label: null }),
    edge('proposal', 'bottom', 'dispute', 'top', {
      state: disputed ? 'done' : untakenEdge, label: 'dispute'
    }),
    edge('dispute', 'right', 'judge', 'top', {
      state: judge?.reasons.includes('dispute') ? 'waiting' : adminFinal && disputed ? 'done' : untakenEdge, label: null
    }),
    edge('running', 'bottom', 'judge', 'left', {
      state: otherReasons.length > 0 ? 'waiting' : adminFinal && !disputed ? 'done' : untakenEdge,
      label: otherReasons.length > 0 ? otherReasons.join(' · ') : 'call · expiry'
    }),
    edge('judge', 'right', 'final', 'bottom', {
      state: adminFinal ? 'done' : judge ? 'pending' : untakenEdge, label: 'resolve'
    })
  ];

  return { layoutKey: `match:${match.id}`, nodes, edges };
}

/** The graph for a view. Pure: the same snapshot, view and match always give the same graph. */
export function buildFlowGraph(snapshot: EventSnapshotDto, view: FlowView, matchId: MatchId | null): FlowGraph {
  return view === 'event' ? buildEventGraph(snapshot) : buildMatchGraph(snapshot, resolveMatchId(snapshot, matchId));
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `next`, reusing every node and edge object from `previous` that did not change, and `previous`
 * itself when nothing changed. React Flow then keeps its internal node state and edge components.
 */
export function reconcileGraph(previous: FlowGraph | null, next: FlowGraph): FlowGraph {
  if (!previous || previous.layoutKey !== next.layoutKey) return next;
  const oldNodes = new Map(previous.nodes.map(node => [node.id, node]));
  const oldEdges = new Map(previous.edges.map(edge => [edge.id, edge]));
  let changed = previous.nodes.length !== next.nodes.length || previous.edges.length !== next.edges.length;
  const nodes = next.nodes.map((node, index) => {
    const old = oldNodes.get(node.id);
    if (old && sameValue(old, node)) {
      if (previous.nodes[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return node;
  });
  const edges = next.edges.map((edge, index) => {
    const old = oldEdges.get(edge.id);
    if (old && sameValue(old, edge)) {
      if (previous.edges[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return edge;
  });
  return changed ? { layoutKey: next.layoutKey, nodes, edges } : previous;
}
