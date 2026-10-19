import type { EventSnapshotDto, RuntimeStatusDto } from '@tcg-live/core';
import { Check } from 'lucide-react';
import { StatusDot, cx } from '../../ui';

type Stage = EventSnapshotDto['stage'];
type StepState = 'done' | 'current' | 'pending';

export interface StepModel {
  id: Stage;
  label: string;
  detail: string;
  state: StepState;
  /** Current step that needs the admin (a judge call). */
  attention: boolean;
}

const ORDER: Stage[] = ['signup', 'checkin', 'live', 'complete'];

/** Pure step model: counts and states from a snapshot. */
export function stepModel(snapshot: EventSnapshotDto): StepModel[] {
  const current = ORDER.indexOf(snapshot.stage);
  const state = (index: number): StepState => {
    if (snapshot.stage === 'complete' && index === 3) return 'done';
    return index < current ? 'done' : index === current ? 'current' : 'pending';
  };
  const seated = Object.values(snapshot.seats).filter(Boolean).length;
  const roster = snapshot.signup ? snapshot.signup.roster.length : seated;
  const capacity = snapshot.signup?.capacity ?? 4;
  const finals = snapshot.matches.filter(match => match.phase === 'final').length;
  const judges = snapshot.matches.filter(match => match.judge !== null).length;
  const running = snapshot.matches.filter(match => match.phase === 'running').length;

  const roundDetail = [`${finals}/${snapshot.matches.length} final`];
  if (snapshot.stage === 'live' && running > 0) roundDetail.push(`${running} live`);
  if (judges > 0) roundDetail.push(`${judges} judge`);

  return [
    { id: 'signup', label: 'Signup', detail: `${roster}/${capacity} joined`, state: state(0), attention: false },
    { id: 'checkin', label: 'Check-in', detail: `${snapshot.checkins.length}/4 in`, state: state(1), attention: false },
    { id: 'live', label: 'Round 1', detail: roundDetail.join(' · '), state: state(2), attention: snapshot.stage === 'live' && judges > 0 },
    { id: 'complete', label: 'Standings', detail: snapshot.stage === 'complete' ? 'Final' : 'Waiting', state: state(3), attention: false }
  ];
}

/** Signup → Check-in → Round 1 → Standings, with counts and the current stage highlighted. */
export function StageStepper({ snapshot, status, frozen }: { snapshot: EventSnapshotDto; status: RuntimeStatusDto | undefined; frozen: boolean }) {
  const steps = stepModel(snapshot);
  const cards = Object.values(snapshot.discord.cards);
  const posted = cards.filter(card => card.messageId !== null).length;
  const pending = !frozen && status?.cards.updatePending;

  return (
    <section aria-label="Event progress" className="console-card console-stepper">
      <div aria-hidden className="console-track">
        {steps.map(step => (
          <span key={step.id} className={cx('console-track-seg', `is-${step.state}`, step.attention && 'is-attention', frozen && 'is-frozen')} />
        ))}
      </div>
      <ol className="console-steps">
        {steps.map((step, index) => (
          <li key={step.id} className={cx('console-step', `is-${step.state}`, step.attention && 'is-attention')}
            aria-current={step.state === 'current' ? 'step' : undefined} data-step={step.id}>
            <span aria-hidden className="console-step-icon">
              {step.state === 'done' ? <Check strokeWidth={3} /> : index + 1}
            </span>
            <span className="console-step-label">{step.label}</span>
            <span className="console-step-detail">
              <span className="sr-only">{step.state === 'done' ? 'done' : step.state === 'current' ? 'current stage' : 'not reached'}: </span>
              {step.detail}
            </span>
          </li>
        ))}
      </ol>
      <div className="console-stepper-foot">
        <StatusDot tone={pending ? 'warning' : posted === cards.length ? 'success' : 'neutral'} size="sm" />
        <span>Discord cards posted · <span className="tabular-nums">{posted} / {cards.length}</span></span>
        {pending && <span className="text-warning">· update pending</span>}
        <span className="ml-auto tabular-nums">v{snapshot.version}{snapshot.panelRevision ? ` · panels r${snapshot.panelRevision}` : ''}</span>
      </div>
    </section>
  );
}
