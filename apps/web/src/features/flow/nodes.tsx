// Custom React Flow nodes: square stage nodes, match cards and lifecycle step chips.
// Nodes are read-only; each renders its own focusable root with a descriptive label.
import { formatClock, remainingMsAt, type ClockDto } from '@tcg-live/core';
import { Handle, Position, type NodeProps, type NodeTypes } from '@xyflow/react';
import {
  Bell, Check, ClipboardCheck, Flag, Gavel, Handshake, MessageSquareWarning, Pause, Snowflake, Timer,
  Trophy, UserCheck, Users, type LucideIcon
} from 'lucide-react';
import { memo, type KeyboardEvent } from 'react';
import { useFlowContext, useServerNow } from './context';
import { describeMatch, describeStage, describeStep, stepSubtitle } from './labels';
import { NODE_SIZE } from './layout';
import type {
  FlowNodeState, MatchFlowNode, MatchStatus, StageFlowNode, StageId, StepFlowNode, StepId
} from './types';

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left]
] as const;

/** Invisible anchors on every side; layouts pick sides with `s-<side>` and `t-<side>` handle ids. */
function Anchors() {
  return (
    <>
      {SIDES.map(([side, position]) => (
        <Handle key={`s-${side}`} id={`s-${side}`} type="source" position={position} isConnectable={false} className="tcg-flow-anchor" />
      ))}
      {SIDES.map(([side, position]) => (
        <Handle key={`t-${side}`} id={`t-${side}`} type="target" position={position} isConnectable={false} className="tcg-flow-anchor" />
      ))}
    </>
  );
}

function StateBadge({ state }: { state: FlowNodeState }) {
  if (state === 'done') return <span className="tcg-flow-badge is-done" aria-hidden><Check strokeWidth={3} /></span>;
  if (state === 'waiting') return <span className="tcg-flow-badge is-waiting" aria-hidden>!</span>;
  if (state === 'interrupted') return <span className="tcg-flow-badge is-interrupted" aria-hidden><Snowflake strokeWidth={2.6} /></span>;
  return null;
}

/** Gap between a node's border and its ring, and the ring's stroke width, in flow pixels. */
const RING_GAP = 3;
const RING_STROKE = 2.5;

/**
 * Activity ring for live and judge-waiting nodes: a rounded-rect stroke just outside the border. A
 * faint full track carries a bright comet (head plus fading tail) that travels around it with an
 * animated `stroke-dashoffset`; `pathLength` makes the dash lengths percentages of the perimeter.
 * Under reduced motion the comet is hidden and the track is drawn solid (flow.css).
 */
function ActivityRing({ kind, radius, state }: { kind: keyof typeof NODE_SIZE; radius: number; state: FlowNodeState }) {
  if (state !== 'live' && state !== 'waiting') return null;
  const { width, height } = NODE_SIZE[kind];
  const pad = RING_GAP + RING_STROKE;
  const rect = {
    x: pad - RING_GAP, y: pad - RING_GAP,
    width: width + RING_GAP * 2, height: height + RING_GAP * 2,
    rx: radius + RING_GAP, pathLength: 100
  };
  return (
    <svg className={`tcg-flow-ring is-${state}`} aria-hidden focusable="false"
      width={width + pad * 2} height={height + pad * 2} style={{ left: -pad, top: -pad }}>
      <rect className="tcg-flow-ring-track" {...rect} />
      <rect className="tcg-flow-ring-tail" {...rect} />
      <rect className="tcg-flow-ring-head" {...rect} />
    </svg>
  );
}

/** Remaining time of a clock at the current server time; ticks only while the clock runs. */
function useRemaining(clock: ClockDto | null): number {
  const now = useServerNow(clock?.state === 'running');
  return clock ? remainingMsAt(clock, now) : 0;
}

const STAGE_ICONS: Record<StageId, LucideIcon> = { signup: Users, checkin: UserCheck, round: Flag, standings: Trophy };

export const StageNode = memo(function StageNode({ data }: NodeProps<StageFlowNode>) {
  const Icon = STAGE_ICONS[data.stage];
  return (
    <div className={`tcg-flow-node tcg-flow-stage is-${data.state}`} data-state={data.state} data-node={data.stage}
      role="group" aria-roledescription="stage" aria-label={describeStage(data)} tabIndex={0}>
      <Anchors />
      <ActivityRing kind="stage" radius={14} state={data.state} />
      <Icon className="tcg-flow-stage-icon" aria-hidden />
      <StateBadge state={data.state} />
      <div className="tcg-flow-stage-label" aria-hidden>
        <b>{data.title}</b>
        <span>{data.subtitle}</span>
      </div>
    </div>
  );
});

const STATUS_TEXT: Record<MatchStatus, string> = {
  waiting: 'Not started', setup: 'Setup', live: 'Live', paused: 'Paused', judge: 'Needs judge',
  interrupted: 'Interrupted', final: 'Final'
};

function MatchStatusLabel({ status }: { status: MatchStatus }) {
  return (
    <span className={`tcg-flow-status is-${status}`}>
      {status === 'live' && <span className="tcg-flow-status-dot" aria-hidden />}
      {status === 'judge' && <Bell aria-hidden />}
      {status === 'interrupted' && <Snowflake aria-hidden />}
      {status === 'final' && <Check aria-hidden strokeWidth={3} />}
      {STATUS_TEXT[status]}
    </span>
  );
}

export const MatchNode = memo(function MatchNode({ data }: NodeProps<MatchFlowNode>) {
  const { openMatch } = useFlowContext();
  const remaining = useRemaining(data.clock);
  const label = describeMatch(data, remaining);
  const interactive = openMatch !== null;
  const open = (): void => openMatch?.(data.matchId);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!interactive || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    open();
  };
  const clockState = data.clock.state;
  return (
    <div className={`tcg-flow-node tcg-flow-match is-${data.state}${interactive ? ' is-interactive nopan' : ''}`}
      data-state={data.state} data-node={data.matchId}
      role={interactive ? 'button' : 'group'} aria-roledescription={interactive ? undefined : 'match'}
      aria-label={label} title={interactive ? `Open ${data.matchId} lifecycle` : undefined} tabIndex={0}
      // React Flow disables pointer events on wrappers of non-selectable nodes; re-enable them to click.
      style={interactive ? { pointerEvents: 'all' } : undefined}
      onClick={interactive ? open : undefined} onKeyDown={onKeyDown}>
      <Anchors />
      <ActivityRing kind="match" radius={14} state={data.state} />
      <div className="tcg-flow-match-head" aria-hidden>
        <span className="tcg-flow-mid">{data.matchId}</span>
        <MatchStatusLabel status={data.status} />
        <span className="tcg-flow-clock" data-clock-state={clockState} data-testid={`clock-${data.matchId}`}>
          {clockState === 'interrupted' && data.status !== 'interrupted' && <small>interrupted</small>}
          {formatClock(remaining)}
        </span>
      </div>
      {data.seats.map(row => (
        <div key={row.seat} className="tcg-flow-seat-row" aria-hidden>
          <span className="tcg-flow-seat">{row.seat}</span>
          <span className="tcg-flow-seat-name">{row.name}</span>
          {row.meta && <span className={`tcg-flow-seat-meta tone-${row.tone}`}>{row.meta}</span>}
        </div>
      ))}
      <StateBadge state={data.state} />
    </div>
  );
});

const STEP_ICONS: Record<StepId, LucideIcon> = {
  ready: UserCheck, running: Timer, paused: Pause, proposal: ClipboardCheck, confirm: Handshake,
  dispute: MessageSquareWarning, judge: Gavel, final: Trophy
};

export const StepNode = memo(function StepNode({ data }: NodeProps<StepFlowNode>) {
  const Icon = STEP_ICONS[data.step];
  const remaining = useRemaining(data.clock);
  const subtitle = stepSubtitle(data, remaining);
  return (
    <div className={`tcg-flow-node tcg-flow-step is-${data.state}`} data-state={data.state} data-node={data.step}
      role="group" aria-roledescription="step" aria-label={describeStep(data, remaining)} tabIndex={0}>
      <Anchors />
      <ActivityRing kind="step" radius={12} state={data.state} />
      <Icon className="tcg-flow-step-icon" aria-hidden />
      <div className="tcg-flow-step-text" aria-hidden>
        <b>{data.title}</b>
        <span data-clock-state={data.clock?.state} data-testid={data.clock ? `step-clock-${data.matchId}` : undefined}>{subtitle}</span>
      </div>
      <StateBadge state={data.state} />
    </div>
  );
});

/** Stable module-level map, as React Flow requires. */
export const nodeTypes: NodeTypes = { stage: StageNode, match: MatchNode, step: StepNode };
