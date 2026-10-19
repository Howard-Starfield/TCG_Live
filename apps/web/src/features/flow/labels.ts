// Pure text helpers for the canvas: names from the members directory and accessible descriptions.
import { formatClock, type EventSnapshotDto, type Seat } from '@tcg-live/core';
import type { FlowNodeState, MatchNodeData, StageNodeData, StepNodeData } from './types';

/** Display name for a seat, from `snapshot.seats` and `snapshot.members`. */
export function seatName(snapshot: EventSnapshotDto, seat: Seat): string {
  const id = snapshot.seats[seat];
  if (!id) return `Seat ${seat}`;
  return snapshot.members[id]?.displayName ?? `Member …${id.slice(-4)}`;
}

const STATE_WORDS: Record<FlowNodeState, string> = {
  done: 'done',
  live: 'in progress',
  waiting: 'waiting on a judge',
  interrupted: 'clock interrupted',
  current: 'current step',
  alert: 'needs attention',
  pending: 'not reached',
  muted: 'not taken'
};

export function stateWord(state: FlowNodeState): string {
  return STATE_WORDS[state];
}

/** For example "Check-in, in progress, 3 / 4 in". */
export function describeStage(data: StageNodeData): string {
  return [data.title, stateWord(data.state), data.subtitle].filter(Boolean).join(', ');
}

/**
 * Accessible label for a match card, for example "M2, paused, judge needed: dispute, 22:25 left".
 * `remainingMs` is the clock at render time, so the label follows the ticking clock.
 */
export function describeMatch(data: MatchNodeData, remainingMs: number): string {
  const parts: string[] = [data.matchId];
  if (!data.published) parts.push('not started');
  else parts.push(data.phase);
  if (data.judgeReasons) parts.push(`judge needed: ${data.judgeReasons.join(', ')}`);
  if (data.clock.state === 'interrupted') parts.push('clock interrupted');
  if (data.phase === 'final') {
    if (data.winnerName) parts.push(`${data.winnerName} won`);
  } else {
    parts.push(`${formatClock(remainingMs)} left`);
  }
  parts.push(`${data.seats[0].name} vs ${data.seats[1].name}`);
  return parts.join(', ');
}

/** Subtitle of a lifecycle step; the running step shows its clock. */
export function stepSubtitle(data: StepNodeData, remainingMs: number): string {
  if (!data.clock) return data.subtitle;
  if (data.phase === 'expired') return 'expired';
  return data.clock.state === 'interrupted' ? 'interrupted' : `${formatClock(remainingMs)} left`;
}

/** For example "M2 Judge, waiting on a judge, dispute". */
export function describeStep(data: StepNodeData, remainingMs: number): string {
  const subtitle = data.clock?.state === 'interrupted'
    ? `${formatClock(remainingMs)} left, frozen`
    : stepSubtitle(data, remainingMs);
  return [`${data.matchId} ${data.title}`, stateWord(data.state), subtitle === '—' ? '' : subtitle]
    .filter(Boolean).join(', ');
}
