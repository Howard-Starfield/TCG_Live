import type { EventSnapshotDto, MatchDto } from '@tcg-live/core';
import { checkin, final, liveDispute, liveInterrupted, signupOpen, snapshots, FIXTURE_NOW_MS } from '@tcg-live/core/fixtures';
import { describe, expect, it } from 'vitest';
import { describeMatch, describeStage, describeStep, seatName } from './labels';
import { buildEventGraph, buildFlowGraph, buildMatchGraph, matchNodeState, resolveMatchId } from './layout';
import type { FlowEdgeState, FlowGraph, FlowNodeState, MatchNodeData, StageNodeData, StepNodeData } from './types';

function nodeStates(graph: FlowGraph): Record<string, FlowNodeState> {
  return Object.fromEntries(graph.nodes.map(node => [node.id, node.data.state]));
}

function edgeStates(graph: FlowGraph): Record<string, FlowEdgeState> {
  return Object.fromEntries(graph.edges.map(edge => [edge.id, edge.data!.state]));
}

function edgeLabel(graph: FlowGraph, id: string): string | null {
  return graph.edges.find(edge => edge.id === id)?.data?.label ?? null;
}

function nodeData<T>(graph: FlowGraph, id: string): T {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node.data as T;
}

/** liveDispute with M1 replaced. */
function withM1(patch: Partial<MatchDto>): EventSnapshotDto {
  return { ...liveDispute, matches: [{ ...liveDispute.matches[0]!, ...patch }, liveDispute.matches[1]!] };
}

describe('Event view mapping', () => {
  it('lays out Signup → Check-in → Round 1 → M1 / M2 → Standings deterministically', () => {
    const graph = buildEventGraph(liveDispute);
    expect(graph.nodes.map(node => node.id)).toEqual(['signup', 'checkin', 'round', 'M1', 'M2', 'standings']);
    expect(graph.edges.map(edge => edge.id)).toEqual([
      'signup->checkin', 'checkin->round', 'round->M1', 'M1->standings', 'round->M2', 'M2->standings'
    ]);
    expect(buildEventGraph(liveDispute)).toEqual(graph);
    expect(graph.layoutKey).toBe('event');
    // Every edge uses the custom dotted edge and named side anchors.
    for (const edge of graph.edges) {
      expect(edge.type).toBe('flow');
      expect(edge.sourceHandle).toMatch(/^s-(top|right|bottom|left)$/);
      expect(edge.targetHandle).toMatch(/^t-(top|right|bottom|left)$/);
    }
  });

  it('signup open: signup is live, everything after it pending', () => {
    const graph = buildEventGraph(signupOpen);
    expect(nodeStates(graph)).toEqual({
      signup: 'live', checkin: 'pending', round: 'pending', M1: 'pending', M2: 'pending', standings: 'pending'
    });
    expect(new Set(Object.values(edgeStates(graph)))).toEqual(new Set(['pending']));
    expect(nodeData<StageNodeData>(graph, 'signup').subtitle).toBe('3 / 4 joined');
    expect(edgeLabel(graph, 'signup->checkin')).toBe('3 joined');
    expect(nodeData<MatchNodeData>(graph, 'M1').status).toBe('waiting');
  });

  it('check-in: the edge flows into the live check-in node', () => {
    const graph = buildEventGraph(checkin);
    expect(nodeStates(graph)).toMatchObject({ signup: 'done', checkin: 'live', round: 'pending', standings: 'pending' });
    expect(edgeStates(graph)).toMatchObject({ 'signup->checkin': 'active', 'checkin->round': 'pending', 'round->M1': 'pending' });
    expect(nodeData<StageNodeData>(graph, 'checkin').subtitle).toBe('3 / 4 in');
  });

  it('live with a dispute: M1 live with an active edge, M2 waits on a judge and holds standings', () => {
    const graph = buildEventGraph(liveDispute);
    expect(nodeStates(graph)).toEqual({
      signup: 'done', checkin: 'done', round: 'done', M1: 'live', M2: 'waiting', standings: 'pending'
    });
    expect(edgeStates(graph)).toEqual({
      'signup->checkin': 'done', 'checkin->round': 'done',
      'round->M1': 'active', 'M1->standings': 'pending',
      'round->M2': 'waiting', 'M2->standings': 'blocked'
    });
    expect(edgeLabel(graph, 'M2->standings')).toBe('held');
    const m2 = nodeData<MatchNodeData>(graph, 'M2');
    expect(m2.status).toBe('judge');
    expect(m2.judgeReasons).toEqual(['dispute']);
    expect(m2.seats.map(row => [row.name, row.meta, row.tone])).toEqual([
      ['Cy Park', 'reported win', 'default'], ['Dee Ross', 'disputed', 'danger']
    ]);
    expect(nodeData<MatchNodeData>(graph, 'M1').seats.map(row => row.name)).toEqual(['Ava Chen', 'Ben Ortiz']);
  });

  it('interrupted clock: frozen, labelled, never a live ring, and the edge is blocked', () => {
    const graph = buildEventGraph(liveInterrupted);
    expect(nodeStates(graph).M1).toBe('interrupted');
    expect(nodeData<MatchNodeData>(graph, 'M1').status).toBe('interrupted');
    expect(edgeStates(graph)).toMatchObject({ 'round->M1': 'blocked', 'M1->standings': 'blocked' });
    expect(edgeLabel(graph, 'M1->standings')).toBe('interrupted');
    expect(Object.values(edgeStates(graph))).not.toContain('active');
  });

  it('final: every edge is done and standings complete', () => {
    const graph = buildEventGraph(final);
    expect(new Set(Object.values(nodeStates(graph)))).toEqual(new Set(['done']));
    expect(new Set(Object.values(edgeStates(graph)))).toEqual(new Set(['done']));
    expect(edgeLabel(graph, 'M1->standings')).toBe('A won');
    expect(edgeLabel(graph, 'M2->standings')).toBe('D won');
    expect(nodeData<StageNodeData>(graph, 'standings').subtitle).toBe('2 / 2 final');
    const m2 = nodeData<MatchNodeData>(graph, 'M2');
    expect(m2.winnerName).toBe('Dee Ross');
    expect(m2.seats[1]).toMatchObject({ meta: 'winner · judge', tone: 'success' });
    expect(nodeData<MatchNodeData>(graph, 'M1').seats[1]).toMatchObject({ meta: 'confirmed' });
  });

  it('a judge outranks an interrupted clock, a final match outranks everything', () => {
    const judgeAndInterrupted = withM1({
      clock: { ...liveDispute.matches[0]!.clock, state: 'interrupted' },
      judge: { reasons: ['called'], sinceMs: FIXTURE_NOW_MS, raisedBy: ['A'] }
    });
    expect(matchNodeState(judgeAndInterrupted, judgeAndInterrupted.matches[0]!)).toBe('waiting');
    expect(matchNodeState(final, final.matches[0]!)).toBe('done');
    const paused = withM1({ phase: 'paused', clock: { ...liveDispute.matches[0]!.clock, state: 'frozen', runningSinceMs: null } });
    expect(matchNodeState(paused, paused.matches[0]!)).toBe('current');
    expect(buildEventGraph(paused).edges.find(edge => edge.id === 'round->M1')!.data!.state).toBe('active');
  });

  it('a legacy event without signup shows signup as done', () => {
    const legacy: EventSnapshotDto = { ...liveDispute, kind: 'legacy', signup: null };
    const graph = buildEventGraph(legacy);
    expect(nodeData<StageNodeData>(graph, 'signup')).toMatchObject({ state: 'done', subtitle: 'seats assigned' });
    expect(edgeLabel(graph, 'signup->checkin')).toBeNull();
  });
});

describe('Match view mapping', () => {
  const STEPS = ['ready', 'running', 'paused', 'proposal', 'confirm', 'dispute', 'judge', 'final'];

  it('has the full lifecycle, with Running ⇄ Paused drawn both ways', () => {
    const graph = buildMatchGraph(liveDispute, 'M1');
    expect(graph.nodes.map(node => node.id)).toEqual(STEPS);
    expect(graph.layoutKey).toBe('match:M1');
    expect(graph.edges.find(edge => edge.id === 'running->paused')!.data!.bidirectional).toBe(true);
    expect(buildMatchGraph(liveDispute, 'M1')).toEqual(graph);
  });

  it('before publication every step is pending', () => {
    for (const snapshot of [signupOpen, checkin]) {
      const graph = buildMatchGraph(snapshot, 'M1');
      expect(new Set(Object.values(nodeStates(graph)))).toEqual(new Set(['pending']));
      expect(new Set(Object.values(edgeStates(graph)))).toEqual(new Set(['pending']));
      expect(nodeData<StepNodeData>(graph, 'ready').subtitle).toBe('unpublished');
      expect(nodeData<StepNodeData>(graph, 'running')).toMatchObject({ clock: null, subtitle: '50:00 clock' });
    }
  });

  it('running: Ready done, the edge flows into the live Running step carrying the clock', () => {
    const graph = buildMatchGraph(liveDispute, 'M1');
    expect(nodeStates(graph)).toMatchObject({ ready: 'done', running: 'live', paused: 'pending', judge: 'pending', final: 'pending' });
    expect(edgeStates(graph)).toMatchObject({ 'ready->running': 'active', 'running->proposal': 'pending', 'judge->final': 'pending' });
    expect(nodeData<StepNodeData>(graph, 'running').clock).toBe(liveDispute.matches[0]!.clock);
  });

  it('paused with a dispute: Paused current, Dispute alert, Judge waiting with a slow red edge', () => {
    const graph = buildMatchGraph(liveDispute, 'M2');
    expect(nodeStates(graph)).toEqual({
      ready: 'done', running: 'done', paused: 'current', proposal: 'done', confirm: 'pending',
      dispute: 'alert', judge: 'waiting', final: 'pending'
    });
    expect(edgeStates(graph)).toEqual({
      'ready->running': 'done', 'running->paused': 'active', 'running->proposal': 'done',
      'proposal->confirm': 'pending', 'confirm->final': 'pending', 'proposal->dispute': 'done',
      'dispute->judge': 'waiting', 'running->judge': 'pending', 'judge->final': 'pending'
    });
    expect(nodeData<StepNodeData>(graph, 'judge').subtitle).toBe('dispute');
    expect(nodeData<StepNodeData>(graph, 'dispute').subtitle).toBe('by D');
    expect(nodeData<StepNodeData>(graph, 'proposal').subtitle).toBe('C won? · r1');
    expect(nodeData<StepNodeData>(graph, 'paused').subtitle).toBe('0 / 2 to resume');
  });

  it('interrupted running clock: Running is interrupted (no ring) and its edge is blocked', () => {
    const graph = buildMatchGraph(liveInterrupted, 'M1');
    expect(nodeStates(graph).running).toBe('interrupted');
    expect(edgeStates(graph)['ready->running']).toBe('blocked');
    expect(Object.values(nodeStates(graph))).not.toContain('live');
  });

  it('final by agreement: the confirm path is done and the judge branch muted', () => {
    const graph = buildMatchGraph(final, 'M1');
    expect(nodeStates(graph)).toEqual({
      ready: 'done', running: 'done', paused: 'muted', proposal: 'done', confirm: 'done',
      dispute: 'muted', judge: 'muted', final: 'done'
    });
    expect(edgeStates(graph)).toMatchObject({
      'proposal->confirm': 'done', 'confirm->final': 'done', 'judge->final': 'muted', 'dispute->judge': 'muted'
    });
    expect(nodeData<StepNodeData>(graph, 'confirm').subtitle).toBe('by B');
  });

  it('final by the judge after a dispute: the dispute and judge path is done, confirm muted', () => {
    const graph = buildMatchGraph(final, 'M2');
    expect(nodeStates(graph)).toEqual({
      ready: 'done', running: 'done', paused: 'done', proposal: 'done', confirm: 'muted',
      dispute: 'done', judge: 'done', final: 'done'
    });
    expect(edgeStates(graph)).toMatchObject({
      'proposal->dispute': 'done', 'dispute->judge': 'done', 'judge->final': 'done',
      'running->judge': 'muted', 'proposal->confirm': 'muted', 'running->paused': 'done'
    });
    expect(nodeData<StepNodeData>(graph, 'final').subtitle).toBe('D won · judge');
  });

  it('setup: Ready is live with the ready count', () => {
    const setup = withM1({ phase: 'setup', ready: ['A'], clock: { durationMs: 3_000_000, remainingMs: 3_000_000, runningSinceMs: null, state: 'frozen' } });
    const graph = buildMatchGraph(setup, 'M1');
    expect(nodeStates(graph)).toMatchObject({ ready: 'live', running: 'pending' });
    expect(nodeData<StepNodeData>(graph, 'ready').subtitle).toBe('1 / 2 ready');
    expect(edgeLabel(graph, 'ready->running')).toBe('1 / 2');
    expect(buildEventGraph(setup).nodes.find(node => node.id === 'M1')!.data.state).toBe('live');
  });

  it('a called judge waits on the call · expiry branch', () => {
    const called = withM1({ judge: { reasons: ['called'], sinceMs: FIXTURE_NOW_MS, raisedBy: ['B'] } });
    const graph = buildMatchGraph(called, 'M1');
    expect(nodeStates(graph)).toMatchObject({ running: 'live', judge: 'waiting' });
    expect(edgeStates(graph)).toMatchObject({ 'running->judge': 'waiting', 'dispute->judge': 'pending' });
    expect(edgeLabel(graph, 'running->judge')).toBe('called');
    expect(nodeData<MatchNodeData>(buildEventGraph(called), 'M1').seats[1]).toMatchObject({ meta: 'called judge', tone: 'danger' });
  });

  it('an expired clock: Running alert, judge waiting on expiry', () => {
    const expired = withM1({
      phase: 'expired', clock: { durationMs: 3_000_000, remainingMs: 0, runningSinceMs: null, state: 'frozen' },
      judge: { reasons: ['expired'], sinceMs: FIXTURE_NOW_MS, raisedBy: [] }
    });
    const graph = buildMatchGraph(expired, 'M1');
    expect(nodeStates(graph)).toMatchObject({ running: 'alert', judge: 'waiting' });
    expect(edgeStates(graph)['running->judge']).toBe('waiting');
  });

  it('an open proposal while running: the report edge flows into Proposal, Confirm awaits the opponent', () => {
    const proposing = withM1({ proposal: { revision: 1, winner: 'A', reporter: 'A', decision: 'open' } });
    const graph = buildMatchGraph(proposing, 'M1');
    expect(nodeStates(graph)).toMatchObject({ running: 'live', proposal: 'current', confirm: 'pending' });
    expect(edgeStates(graph)['running->proposal']).toBe('active');
    expect(nodeData<StepNodeData>(graph, 'confirm').subtitle).toBe('awaiting B');
    const seats = nodeData<MatchNodeData>(buildEventGraph(proposing), 'M1').seats;
    expect(seats.map(row => row.meta)).toEqual(['reported win', 'to confirm']);
  });
});

describe('view resolution', () => {
  it('picks the requested match, else the first needing a judge, else the first', () => {
    expect(resolveMatchId(liveDispute, 'M1')).toBe('M1');
    expect(resolveMatchId(liveDispute, null)).toBe('M2');
    expect(resolveMatchId(final, null)).toBe('M1');
    expect(buildFlowGraph(liveDispute, 'match', null).layoutKey).toBe('match:M2');
    expect(buildFlowGraph(liveDispute, 'event', 'M2').layoutKey).toBe('event');
  });

  it('maps every fixture in both views without throwing', () => {
    for (const snapshot of Object.values(snapshots)) {
      expect(buildFlowGraph(snapshot, 'event', null).nodes).toHaveLength(6);
      for (const match of snapshot.matches) {
        expect(buildFlowGraph(snapshot, 'match', match.id).nodes).toHaveLength(8);
      }
    }
  });
});

describe('labels', () => {
  it('names seats from the members directory', () => {
    expect(seatName(liveDispute, 'C')).toBe('Cy Park');
    expect(seatName(signupOpen, 'A')).toBe('Seat A');
    expect(seatName({ ...liveDispute, members: {} }, 'D')).toBe('Member …0014');
  });

  it('describes a paused match waiting on a judge', () => {
    const m2 = nodeData<MatchNodeData>(buildEventGraph(liveDispute), 'M2');
    expect(describeMatch(m2, 1_345_000)).toBe('M2, paused, judge needed: dispute, 22:25 left, Cy Park vs Dee Ross');
  });

  it('describes interrupted, final and unpublished matches', () => {
    const m1 = nodeData<MatchNodeData>(buildEventGraph(liveInterrupted), 'M1');
    expect(describeMatch(m1, 840_000)).toBe('M1, running, clock interrupted, 14:00 left, Ava Chen vs Ben Ortiz');
    const won = nodeData<MatchNodeData>(buildEventGraph(final), 'M2');
    expect(describeMatch(won, 0)).toBe('M2, final, Dee Ross won, Cy Park vs Dee Ross');
    const waiting = nodeData<MatchNodeData>(buildEventGraph(checkin), 'M1');
    expect(describeMatch(waiting, 3_000_000)).toBe('M1, not started, 50:00 left, Ava Chen vs Ben Ortiz');
  });

  it('describes stages and steps', () => {
    expect(describeStage(nodeData<StageNodeData>(buildEventGraph(checkin), 'checkin'))).toBe('Check-in, in progress, 3 / 4 in');
    const judge = nodeData<StepNodeData>(buildMatchGraph(liveDispute, 'M2'), 'judge');
    expect(describeStep(judge, 0)).toBe('M2 Judge, waiting on a judge, dispute');
    const running = nodeData<StepNodeData>(buildMatchGraph(liveInterrupted, 'M1'), 'running');
    expect(describeStep(running, 840_000)).toBe('M1 Running, clock interrupted, 14:00 left, frozen');
  });
});
