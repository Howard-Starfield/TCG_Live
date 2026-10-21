// Deterministic canvas layouts, mapped purely from an event snapshot. No clocks are read here:
// countdowns tick inside the node components, so a tick never re-runs the layout.
import { formatClock, type EventSnapshotDto, type EventStage, type MatchDto, type MatchId, type Seat } from '@tcg-live/core';
import { Position, type NodeHandle } from '@xyflow/react';
import { seatName } from './labels';
import type {
  FlowEdge, FlowEdgeData, FlowEdgeState, FlowGraph, FlowNode, FlowNodeState, FlowOrientation, FlowRect,
  MatchNodeData, MatchStatus, SeatRow, StageNodeData, StepId, StepNodeData
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

type Point = { x: number; y: number };

/** Space under a stage node for its title and subtitle, and how far that text reaches sideways. */
const STAGE_LABEL = { below: 42, side: 22 } as const;
/** States that mark where play is happening; the viewport keeps them in view. */
const FOCUS_STATES: ReadonlySet<FlowNodeState> = new Set(['live', 'waiting', 'interrupted', 'current', 'alert']);

/** Footprint of a node in flow pixels: its box, plus the label under a stage node. */
export function nodeFootprint(node: FlowNode): FlowRect {
  const { width, height } = NODE_SIZE[node.type as keyof typeof NODE_SIZE];
  if (node.type === 'stage') {
    return { x: node.position.x - STAGE_LABEL.side, y: node.position.y,
      width: width + STAGE_LABEL.side * 2, height: height + STAGE_LABEL.below };
  }
  return { x: node.position.x, y: node.position.y, width, height };
}

function union(rects: FlowRect[]): FlowRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function finishGraph(layoutKey: string, orientation: FlowOrientation, nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  const active = nodes.filter(node => FOCUS_STATES.has(node.data.state)).map(node => {
    const { width, height } = NODE_SIZE[node.type as keyof typeof NODE_SIZE];
    return { x: node.position.x, y: node.position.y, width, height };
  });
  const area = active.length > 0 ? union(active) : null;
  return {
    layoutKey, orientation, nodes, edges, bounds: union(nodes.map(nodeFootprint)),
    focus: area ? { x: area.x + area.width / 2, y: area.y + area.height / 2 } : null
  };
}

function keyFor(base: string, orientation: FlowOrientation): string {
  return orientation === 'horizontal' ? base : `${base}:${orientation}`;
}

type EventNodeId = 'signup' | 'checkin' | 'round' | 'M1' | 'M2' | 'standings';

/** Left to right: the stages in a row, the two matches stacked, standings last. */
const EVENT_HORIZONTAL: Record<EventNodeId, Point> = {
  signup: { x: 0, y: 102 }, checkin: { x: 140, y: 102 }, round: { x: 280, y: 102 },
  M1: { x: 420, y: 30 }, M2: { x: 420, y: 146 }, standings: { x: 692, y: 102 }
};
/** Top to bottom: the stages in a row, the two matches side by side under them, standings below. */
const EVENT_VERTICAL: Record<EventNodeId, Point> = {
  signup: { x: 40, y: 0 }, checkin: { x: 180, y: 0 }, round: { x: 320, y: 0 },
  M1: { x: 0, y: 170 }, M2: { x: 220, y: 170 }, standings: { x: 180, y: 320 }
};
/** Left to right, tightened for short wide panes (the sheet): no edge labels, so the gaps close up. */
const EVENT_STRIP: Record<EventNodeId, Point> = {
  signup: { x: 22, y: 68 }, checkin: { x: 126, y: 68 }, round: { x: 230, y: 68 },
  M1: { x: 330, y: 0 }, M2: { x: 330, y: 104 }, standings: { x: 570, y: 68 }
};
/** Top to bottom, tightened for short panes: the rows close up once the branch labels are gone. */
const EVENT_COMPACT: Record<EventNodeId, Point> = {
  signup: { x: 40, y: 0 }, checkin: { x: 180, y: 0 }, round: { x: 320, y: 0 },
  M1: { x: 0, y: 116 }, M2: { x: 220, y: 116 }, standings: { x: 180, y: 228 }
};

/** Event view: Signup → Check-in → Round 1 → M1 / M2 → Standings. */
export function buildEventGraph(snapshot: EventSnapshotDto, orientation: FlowOrientation = 'horizontal'): FlowGraph {
  const vertical = orientation === 'vertical' || orientation === 'compact';
  const compact = orientation === 'compact';
  const strip = orientation === 'strip';
  const place = strip ? EVENT_STRIP : compact ? EVENT_COMPACT : vertical ? EVENT_VERTICAL : EVENT_HORIZONTAL;
  /** The tight forms drop branch labels; the strip drops the stage-to-stage labels as well. */
  const branchLabels = !compact && !strip;
  const branchOut: Side = vertical ? 'bottom' : 'right';
  const branchIn: Side = vertical ? 'top' : 'left';
  const index = STAGE_INDEX[snapshot.stage];
  const signup = snapshot.signup;
  const matches = snapshot.matches;
  const finals = matches.filter(match => match.phase === 'final').length;

  const stage = (id: StageNodeData['stage'], data: Omit<StageNodeData, 'stage'>): FlowNode => ({
    id, type: 'stage', position: place[id], data: { stage: id, ...data }, ...sized('stage')
  });

  const nodes: FlowNode[] = [
    stage('signup', {
      title: 'Signup',
      subtitle: signup ? `${signup.roster.length} / ${signup.capacity} joined` : 'seats assigned',
      state: index === 0 ? 'live' : 'done'
    }),
    stage('checkin', {
      title: 'Check-in',
      subtitle: index === 0 ? 'after signup' : `${snapshot.checkins.length} / 4 in`,
      state: index < 1 ? 'pending' : index === 1 ? 'live' : 'done'
    }),
    stage('round', {
      title: 'Round 1',
      subtitle: !snapshot.published ? 'not published' : finals === matches.length ? 'complete' : `${matches.length - finals} in play`,
      state: snapshot.published ? 'done' : 'pending'
    })
  ];

  const edges: FlowEdge[] = [
    edge('signup', 'right', 'checkin', 'left', {
      state: index === 0 ? 'pending' : index === 1 ? 'active' : 'done',
      label: signup && !strip ? `${signup.roster.length} joined` : null
    }),
    edge('checkin', 'right', 'round', 'left', {
      state: index < 2 ? 'pending' : 'done',
      label: index === 0 || strip ? null : `${snapshot.checkins.length} / 4`
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
      id: match.id, type: 'match', position: place[match.id],
      data, ...sized('match')
    });
    // Stacked matches nudge their labels apart; side by side the labels sit on the curves.
    const labelOffset = vertical || !branchLabels ? null : { x: 0, y: position === 0 ? -10 : 10 };
    edges.push(edge('round', branchOut, match.id, branchIn, {
      state: snapshot.published ? edgeInto(state) : 'pending',
      label: branchLabels ? `${match.seats[0]} · ${match.seats[1]}` : null,
      ...(labelOffset ? { labelOffset } : {})
    }));
    let out: FlowEdgeData;
    if (!snapshot.published) out = { state: 'pending', label: null };
    else if (match.phase === 'final') out = { state: 'done', label: match.finalWinner ? `${match.finalWinner} won` : 'final' };
    else if (match.judge) out = { state: 'blocked', label: 'held' };
    else if (match.clock.state === 'interrupted') out = { state: 'blocked', label: 'interrupted' };
    else out = { state: 'pending', label: match.phase === 'setup' ? 'setup' : match.phase === 'paused' ? 'paused' : 'in play' };
    if (!branchLabels) out = { ...out, label: null };
    edges.push(edge(match.id, branchOut, 'standings', branchIn, { ...out, ...(labelOffset ? { labelOffset } : {}) }));
  });

  nodes.push(stage('standings', {
    title: 'Standings',
    subtitle: index === 3 ? `${finals} / ${matches.length} final` : snapshot.published ? `waiting on ${matches.length - finals}` : '—',
    state: index === 3 ? 'done' : 'pending'
  }));

  return finishGraph(keyFor('event', orientation), orientation, nodes, edges);
}

const STEP_X = [0, 162, 324, 486, 648] as const;
const STEP_ROW = 100;
const STEP_HORIZONTAL: Record<StepId, Point> = {
  paused: { x: STEP_X[1], y: 0 },
  ready: { x: STEP_X[0], y: STEP_ROW },
  running: { x: STEP_X[1], y: STEP_ROW },
  proposal: { x: STEP_X[2], y: STEP_ROW },
  confirm: { x: STEP_X[3], y: STEP_ROW },
  final: { x: STEP_X[4], y: STEP_ROW },
  dispute: { x: STEP_X[2], y: 196 },
  judge: { x: STEP_X[3], y: 286 }
};

/** Top to bottom: the main path in the middle column, Paused to its left, Dispute and Judge to its right. */
const STEP_COLUMN = [0, 150, 326] as const;
const STEP_LEVEL = [0, 104, 208, 312, 416] as const;
const STEP_VERTICAL: Record<StepId, Point> = {
  ready: { x: STEP_COLUMN[1], y: STEP_LEVEL[0] },
  running: { x: STEP_COLUMN[1], y: STEP_LEVEL[1] },
  paused: { x: STEP_COLUMN[0], y: STEP_LEVEL[1] },
  proposal: { x: STEP_COLUMN[1], y: STEP_LEVEL[2] },
  dispute: { x: STEP_COLUMN[2], y: STEP_LEVEL[2] },
  confirm: { x: STEP_COLUMN[1], y: STEP_LEVEL[3] },
  judge: { x: STEP_COLUMN[2], y: STEP_LEVEL[3] },
  final: { x: STEP_COLUMN[1], y: STEP_LEVEL[4] }
};

/** Sides for each lifecycle edge: [horizontal from, to, vertical from, to]. */
const STEP_EDGE_SIDES: Record<string, [Side, Side, Side, Side]> = {
  'ready->running': ['right', 'left', 'bottom', 'top'],
  'running->paused': ['top', 'bottom', 'left', 'right'],
  'running->proposal': ['right', 'left', 'bottom', 'top'],
  'proposal->confirm': ['right', 'left', 'bottom', 'top'],
  'confirm->final': ['right', 'left', 'bottom', 'top'],
  'proposal->dispute': ['bottom', 'top', 'right', 'left'],
  'dispute->judge': ['right', 'top', 'bottom', 'top'],
  'running->judge': ['bottom', 'left', 'right', 'left'],
  'judge->final': ['right', 'bottom', 'bottom', 'right']
};

const STEP_TITLES: Record<StepId, string> = {
  ready: 'Ready', running: 'Running', paused: 'Paused', proposal: 'Proposal',
  confirm: 'Confirm', dispute: 'Dispute', judge: 'Judge', final: 'Final'
};

/** Steps in reading and focus order. */
const STEP_ORDER: StepId[] = ['ready', 'running', 'paused', 'proposal', 'confirm', 'dispute', 'judge', 'final'];

/** Match view: Ready → Running ⇄ Paused → Proposal → Confirm / Dispute → Final, with the Judge branch. */
export function buildMatchGraph(snapshot: EventSnapshotDto, matchId: MatchId,
  orientation: FlowOrientation = 'horizontal'): FlowGraph {
  // The lifecycle has no tight forms: compact uses the top-to-bottom layout, strip the left-to-right one.
  const vertical = orientation === 'vertical' || orientation === 'compact';
  const match = snapshot.matches.find(item => item.id === matchId) ?? snapshot.matches[0];
  if (!match) return finishGraph(keyFor(`match:${matchId}`, orientation), orientation, [], []);
  const place = vertical ? STEP_VERTICAL : STEP_HORIZONTAL;
  const edge = (source: StepId, target: StepId, data: FlowEdgeData): FlowEdge => {
    const id = `${source}->${target}`;
    const sides = STEP_EDGE_SIDES[id]!;
    return {
      id, type: 'flow', source, target,
      ...handles(vertical ? sides[2] : sides[0], vertical ? sides[3] : sides[1]), data
    };
  };

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
      id: step, type: 'step', position: place[step], data, ...sized('step')
    };
  });

  const edges: FlowEdge[] = [
    edge('ready', 'running', {
      state: !started ? 'pending' : phase === 'running' ? (interrupted ? 'blocked' : 'active') : 'done',
      label: published ? `${match.ready.length} / 2` : null
    }),
    // Stacked, Paused sits in a narrow gap beside Running: the double arrow speaks for itself.
    edge('running', 'paused', {
      state: phase === 'paused' ? 'current' : everPaused ? 'done' : untakenEdge,
      label: vertical ? null : 'pause · resume', bidirectional: true
    }),
    edge('running', 'proposal', {
      state: proposal ? (openProposal ? 'current' : 'done') : untakenEdge, label: 'report'
    }),
    edge('proposal', 'confirm', {
      state: agreed ? 'done' : untakenEdge, label: 'confirm'
    }),
    edge('confirm', 'final', { state: agreed ? 'done' : untakenEdge, label: null }),
    edge('proposal', 'dispute', {
      state: disputed ? 'done' : untakenEdge, label: 'dispute'
    }),
    edge('dispute', 'judge', {
      state: judge?.reasons.includes('dispute') ? 'waiting' : adminFinal && disputed ? 'done' : untakenEdge, label: null
    }),
    edge('running', 'judge', {
      state: otherReasons.length > 0 ? 'waiting' : adminFinal && !disputed ? 'done' : untakenEdge,
      label: otherReasons.length > 0 ? otherReasons.join(' · ') : 'call · expiry',
      // Stacked, this curve crosses the dispute edge's midpoint; lift its label into the row gap.
      ...(vertical ? { labelOffset: { x: 0, y: -50 } } : {})
    }),
    edge('judge', 'final', {
      state: adminFinal ? 'done' : judge ? 'pending' : untakenEdge, label: 'resolve'
    })
  ];

  return finishGraph(keyFor(`match:${match.id}`, orientation), orientation, nodes, edges);
}

/** The graph for a view. Pure: the same snapshot, view and match always give the same graph. */
export function buildFlowGraph(snapshot: EventSnapshotDto, view: FlowView, matchId: MatchId | null,
  orientation: FlowOrientation = 'horizontal'): FlowGraph {
  return view === 'event'
    ? buildEventGraph(snapshot, orientation)
    : buildMatchGraph(snapshot, resolveMatchId(snapshot, matchId), orientation);
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
  return changed ? { ...next, nodes, edges } : previous;
}
