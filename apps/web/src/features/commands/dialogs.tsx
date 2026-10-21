// Reason and confirmation dialogs (L10). What the admin decides on is captured when a dialog opens;
// the live cache (stream changes, a 409 snapshot) only raises a "changed since you opened this" notice.
import { ADMIN_REASON_MAX_LENGTH, type AdminCommandDto, type EventSnapshotDto, type JudgeReason, type MatchDto,
  type Seat } from '@tcg-live/core';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { memberName } from '../../data';
import { Badge, Button, Dialog, Field, Textarea, cx, useEscapeLayer } from '../../ui';
import { seatWithName } from '../shell/labels';
import type { CommandsApi, MatchActionRequest, RemoveRequest } from './CommandsProvider';
import { availableMatchActions, canRemoveMember, checkReason, conflictSummary, matchChangedSince, matchLine,
  signupChangedSince, type CommandType } from './model';

const COPY = {
  resolve: {
    title: (id: string) => `Resolve ${id}`,
    description: 'Records the winner and ends the match. The players are not asked to confirm.',
    confirm: 'Resolve match'
  },
  correct: {
    title: (id: string) => `Correct ${id}'s result`,
    description: 'Replaces a final result. Points and ratings are recomputed from the new winner.',
    confirm: 'Correct result'
  },
  judgeResume: {
    title: (id: string) => `Resume ${id} by judge override`,
    description: 'Restarts the paused clock without waiting for both players to agree.',
    confirm: 'Resume play'
  }
} as const;

const JUDGE_REASON: Record<JudgeReason, string> = { dispute: 'result disputed', called: 'judge called', expired: 'clock expired' };

type Notice = { tone: 'danger' | 'warning'; text: string } | null;

function NoticeBox({ notice }: { notice: NonNullable<Notice> }) {
  return (
    <div role="alert" className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-xs text-fg [&>svg]:mt-px [&>svg]:size-3.5 [&>svg]:shrink-0',
      notice.tone === 'danger' ? 'bg-danger-soft' : 'bg-warning-soft')}>
      {notice.tone === 'danger' ? <CircleAlert aria-hidden className="text-danger" /> : <AlertTriangle aria-hidden className="text-warning" />}
      <span className="min-w-0">{notice.text}</span>
    </div>
  );
}

/** What the admin is deciding on: phase, judge reasons, proposal and the recorded result. */
function MatchFacts({ snapshot, match }: { snapshot: EventSnapshotDto; match: MatchDto }) {
  const facts: ReactNode[] = [<span key="phase">Phase <b className="font-medium text-fg">{match.phase}</b></span>];
  if (match.judge) facts.push(<span key="judge">Needs a judge: {match.judge.reasons.map(reason => JUDGE_REASON[reason]).join(', ')}</span>);
  if (match.proposal) {
    facts.push(<span key="proposal">{seatWithName(snapshot, match.proposal.reporter)} reported Seat {match.proposal.winner} won
      ({match.proposal.decision}, rev {match.proposal.revision})</span>);
  }
  if (match.finalWinner) facts.push(<span key="final">Recorded winner: <b className="font-medium text-fg">{seatWithName(snapshot, match.finalWinner)}</b>{match.finalSource ? ` (${match.finalSource})` : ''}</span>);
  return (
    <ul aria-label="Match details" className="flex flex-col gap-0.5 rounded-lg bg-line-faint px-3 py-2 text-xs text-fg-muted">
      {facts.map((fact, index) => <li key={index}>{fact}</li>)}
    </ul>
  );
}

function WinnerPicker({ snapshot, match, action, winner, onChange, error, firstRef }: {
  snapshot: EventSnapshotDto; match: MatchDto; action: CommandType; winner: Seat | null; onChange(seat: Seat): void;
  error: string | null; firstRef: RefObject<HTMLInputElement | null>;
}) {
  const name = useId();
  const errorId = `${name}-error`;
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-1.5 p-0 text-[13px] font-medium text-fg">Winner<span aria-hidden className="ml-0.5 text-danger">*</span></legend>
      <div className="grid grid-cols-2 gap-2">
        {match.seats.map((seat, index) => {
          const current = match.finalWinner === seat;
          const disabled = action === 'correct' && current;
          const reported = match.proposal?.winner === seat;
          return (
            <label key={seat} className={cx('flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 shadow-[inset_0_0_0_1px_var(--color-line)] transition-shadow',
              'has-[:checked]:bg-accent-soft has-[:checked]:shadow-[inset_0_0_0_1.5px_var(--color-accent)] has-[:focus-visible]:shadow-[inset_0_0_0_1.5px_var(--color-accent),0_0_0_3px_var(--color-accent-ring)]',
              disabled && 'cursor-not-allowed opacity-50')}>
              <input ref={index === 0 ? firstRef : undefined} type="radio" name={name} value={seat} checked={winner === seat}
                disabled={disabled} onChange={() => onChange(seat)} className="mt-0.5 accent-[var(--color-accent)]" />
              <span className="min-w-0">
                <span className="block truncate font-medium text-fg">{seatWithName(snapshot, seat)}</span>
                <span className="flex flex-wrap gap-1 pt-0.5">
                  {current && <Badge tone="success">current winner</Badge>}
                  {reported && !current && <Badge tone={match.proposal?.decision === 'disputed' ? 'danger' : 'neutral'}>reported winner</Badge>}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {error && <p id={errorId} className="m-0 text-xs font-medium text-danger">{error}</p>}
    </fieldset>
  );
}

function ReasonField({ value, onChange, error, disabled, onSubmit, areaRef }: {
  value: string; onChange(value: string): void; error: string | null; disabled: boolean; onSubmit(): void;
  areaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const length = value.trim().length;
  return (
    <Field label="Reason" required error={error ?? undefined}
      description={(
        <span className="flex items-baseline justify-between gap-3">
          <span>Stored in the audit log with your action. Ctrl+Enter confirms.</span>
          <span className={cx('shrink-0 tabular-nums', length > ADMIN_REASON_MAX_LENGTH && 'font-medium text-danger')}>
            {length} / {ADMIN_REASON_MAX_LENGTH}
          </span>
        </span>
      )}>
      <Textarea ref={areaRef} value={value} rows={3} disabled={disabled} placeholder="Why this decision? Players and other judges can read it later."
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSubmit(); }
        }} />
    </Field>
  );
}

/** Escape closes the dialog, except while a request is in flight: then it is swallowed, so it never
 * reaches a lower layer either (the layer stays registered for the whole time the dialog is open). */
function useDialogEscape(open: boolean, pending: boolean, onClose: () => void) {
  useEscapeLayer(open, () => { if (!pending) onClose(); });
}

/** The state moved under an open dialog: the fresh facts, and what to do about them. */
function ChangedNotice({ what, children }: { what: string; children?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-col gap-1.5 rounded-lg bg-warning-soft px-3 py-2 text-xs text-fg" data-testid="changed-notice">
      <span className="flex items-start gap-2 [&>svg]:mt-px [&>svg]:size-3.5 [&>svg]:shrink-0">
        <AlertTriangle aria-hidden className="text-warning" />
        <span>{what} changed since you opened this. Now:</span>
      </span>
      {children}
      <span className="text-fg-muted">Choose <b className="font-medium text-fg">Review the change</b> to decide on the current state.</span>
    </div>
  );
}

export interface MatchActionDialogProps {
  open: boolean;
  api: CommandsApi;
  /** The live snapshot (from the cache). */
  snapshot: EventSnapshotDto;
  request: MatchActionRequest;
  onClose(): void;
}

/**
 * Resolve, correct or judge-resume: required reason, winner for resolve and correct, explicit confirm for
 * corrections. The facts shown and the precondition sent are captured when the dialog opens (`seen`);
 * when the live match moves on a precondition field, the dialog says so and the admin must re-capture
 * ("Review the change") before confirming.
 */
export function MatchActionDialog({ open, api, snapshot, request, onClose }: MatchActionDialogProps) {
  const { action, matchId } = request;
  const [seen, setSeen] = useState(snapshot);
  const match = seen.matches.find(item => item.id === matchId);
  const liveMatch = snapshot.matches.find(item => item.id === matchId);
  const [winner, setWinner] = useState<Seat | null>(request.winner ?? null);
  const [reason, setReason] = useState(request.reason ?? '');
  const [touched, setTouched] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const firstSeatRef = useRef<HTMLInputElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const acknowledgeId = useId();

  useDialogEscape(open, pending, onClose);

  const copy = COPY[action];
  const danger = action === 'correct';
  const needsWinner = action !== 'judgeResume';
  const changed = matchChangedSince(seen, snapshot, matchId);
  const available = !!liveMatch && availableMatchActions(api.session, snapshot, liveMatch).includes(action);
  // A correction can never pick the recorded winner.
  const chosen = winner && !(danger && match?.finalWinner === winner) ? winner : null;
  const check = checkReason(reason);
  const winnerError = touched && needsWinner && !chosen ? 'Pick the winning seat.' : null;
  const reasonError = touched && !check.ok ? check.error : null;
  const acknowledgeError = touched && danger && !acknowledged ? 'Confirm that you mean to change a final result.' : null;

  /** Adopts the live state as what the admin decides on; a correction must be acknowledged again. */
  const review = () => {
    setSeen(snapshot);
    setAcknowledged(false);
    setNotice(null);
  };

  const submit = async () => {
    if (changed) return;
    setTouched(true);
    if (!match || !available || pending || !check.ok || (needsWinner && !chosen) || (danger && !acknowledged)) return;
    const command: AdminCommandDto = action === 'judgeResume'
      ? { type: 'judgeResume', matchId, reason: check.reason }
      : { type: action, matchId, winner: chosen!, reason: check.reason };
    setPending(true);
    setNotice(null);
    // The precondition comes from `seen`: the state the admin read in this dialog.
    const outcome = await api.run(seen, command, { inline: true });
    setPending(false);
    if (outcome.status === 'applied' || outcome.status === 'noop') {
      request.onDone?.();
      onClose();
    } else if (outcome.status === 'conflict') {
      const what = conflictSummary(seen, outcome.snapshot, matchId);
      setNotice({ tone: 'warning', text: `${matchId} changed while you were deciding.${what ? ` ${what}` : ''} Review the change, then confirm again.` });
      setAcknowledged(false);
    } else if (outcome.status === 'failed') {
      setNotice({ tone: 'danger', text: outcome.message });
    }
  };

  const reviewing = changed && available;
  const initialFocus = needsWinner && !chosen ? firstSeatRef : reasonRef;
  return (
    <Dialog open={open} onClose={() => { if (!pending) onClose(); }} dismissible={!pending} tone={danger ? 'danger' : 'default'}
      role={danger ? 'alertdialog' : 'dialog'} title={copy.title(matchId)} description={copy.description} initialFocusRef={initialFocus}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          {reviewing ? (
            <Button variant="secondary" onClick={review}>Review the change</Button>
          ) : (
            <Button variant={danger ? 'danger' : 'primary'} onClick={() => { void submit(); }} loading={pending} disabled={!available}>
              {copy.confirm}
            </Button>
          )}
        </>
      )}>
      <form className="flex flex-col gap-3" noValidate onSubmit={event => { event.preventDefault(); if (reviewing) review(); else void submit(); }}
        data-testid="match-action-form" data-action={action} data-changed={changed || undefined}>
        {match ? (
          <>
            <p className="m-0 text-[13px] text-fg">{matchLine(seen, match)}</p>
            <MatchFacts snapshot={seen} match={match} />
          </>
        ) : <p className="m-0 text-fg-muted">{matchId} is not part of this event any more.</p>}
        {notice && <NoticeBox notice={notice} />}
        {changed && liveMatch && (
          <ChangedNotice what={matchId}><MatchFacts snapshot={snapshot} match={liveMatch} /></ChangedNotice>
        )}
        {!available && liveMatch && <NoticeBox notice={{ tone: 'warning', text: `This action is no longer available: ${matchId} is ${liveMatch.phase} now.` }} />}
        {needsWinner && match && (
          <WinnerPicker snapshot={seen} match={match} action={action} winner={chosen} onChange={setWinner}
            error={winnerError} firstRef={firstSeatRef} />
        )}
        <ReasonField value={reason} onChange={setReason} error={reasonError} disabled={pending} areaRef={reasonRef}
          onSubmit={() => { if (reviewing) review(); else void submit(); }} />
        {danger && (
          <div className="flex flex-col gap-1">
            <label htmlFor={acknowledgeId} className="flex cursor-pointer items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-fg">
              <input id={acknowledgeId} type="checkbox" checked={acknowledged} disabled={pending}
                onChange={event => setAcknowledged(event.target.checked)} className="mt-px accent-[var(--color-danger)]"
                aria-invalid={acknowledgeError ? true : undefined} />
              <span>I understand this replaces the recorded result of {matchId} and recomputes the standings.</span>
            </label>
            {acknowledgeError && <p className="m-0 text-xs font-medium text-danger">{acknowledgeError}</p>}
          </div>
        )}
      </form>
    </Dialog>
  );
}

export interface RemoveMemberDialogProps {
  open: boolean;
  api: CommandsApi;
  snapshot: EventSnapshotDto;
  request: RemoveRequest;
  onClose(): void;
}

/** Confirms removing a member from the open signup. Focus starts on Cancel. Same capture rule as above. */
export function RemoveMemberDialog({ open, api, snapshot, request, onClose }: RemoveMemberDialogProps) {
  const [seen, setSeen] = useState(snapshot);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  useDialogEscape(open, pending, onClose);
  const name = memberName(seen, request.memberId);
  const available = canRemoveMember(api.session, snapshot, request.memberId);
  const changed = signupChangedSince(seen, snapshot);
  const reviewing = changed && available;
  const joined = (event: EventSnapshotDto) => `${event.signup?.roster.length ?? 0} of ${event.signup?.capacity ?? 4} joined`;

  const confirm = async () => {
    if (!available || pending || changed) return;
    setPending(true);
    setNotice(null);
    const outcome = await api.run(seen, { type: 'signupRemove', memberId: request.memberId }, { inline: true });
    setPending(false);
    if (outcome.status === 'applied' || outcome.status === 'noop') {
      request.onDone?.();
      onClose();
    } else if (outcome.status === 'conflict') {
      setNotice({ tone: 'warning', text: 'The signup changed while you were deciding. Review the change, then confirm again if you still mean it.' });
    } else if (outcome.status === 'failed') {
      setNotice({ tone: 'danger', text: outcome.message });
    }
  };

  return (
    <Dialog open={open} onClose={() => { if (!pending) onClose(); }} dismissible={!pending} tone="danger" role="alertdialog" width="sm"
      title={`Remove ${name} from the signup?`}
      description={`${name} leaves the roster (${joined(seen)} now). They can join again from the signup card while signup is open.`}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
          {reviewing
            ? <Button variant="secondary" onClick={() => { setSeen(snapshot); setNotice(null); }}>Review the change</Button>
            : <Button variant="danger" onClick={() => { void confirm(); }} loading={pending} disabled={!available}>Remove</Button>}
        </>
      )}>
      {(!available || notice || changed) && (
        <div className="flex flex-col gap-2">
          {notice && <NoticeBox notice={notice} />}
          {changed && (
            <ChangedNotice what="The signup">
              <span>Signup {snapshot.signup?.status ?? 'closed'}, {joined(snapshot)}: {(snapshot.signup?.roster ?? []).map(id => memberName(snapshot, id)).join(', ') || 'nobody'}.</span>
            </ChangedNotice>
          )}
          {!available && <NoticeBox notice={{ tone: 'warning', text: `${name} can no longer be removed: signup is ${snapshot.signup?.status === 'open' ? 'open, but they are not in the roster' : 'closed'}.` }} />}
        </div>
      )}
    </Dialog>
  );
}
