// The reply thread under a match's evidence: what staff said, to whom, and whether Discord got it. The
// composer answers the match's players in Discord by default; "Staff note only" keeps a reply in the dashboard.
import { EVIDENCE_REPLY_MAX_LENGTH, type EventSnapshotDto, type EvidenceReplyDto, type MatchId } from '@tcg-live/core';
import { RotateCw, Send } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { formatTimeOfDay, memberName, useAdminData } from '../../data';
import { Badge, Button, Field, Switch, Textarea, cx } from '../../ui';
import { seatName } from '../shell/labels';
import { describeError, retryReply, sendReply, useEvidenceAccess, useEvidenceReplies, useReplyCacheUpdate, validateReplyBody } from './api';

function authorLabel(snapshot: EventSnapshotDto, reply: EvidenceReplyDto): string {
  return reply.author === 'local-admin' ? 'Admin (dashboard)' : memberName(snapshot, reply.author);
}

function ReplyRow({ snapshot, reply, retrying, canRetry, onRetry }: {
  snapshot: EventSnapshotDto; reply: EvidenceReplyDto; retrying: boolean; canRetry: boolean; onRetry(): void;
}) {
  const failed = reply.status === 'failed';
  return <li data-reply={reply.id} className={cx('flex flex-col gap-1 rounded-lg px-2.5 py-2',
    reply.audience === 'players' ? 'bg-accent-soft' : 'bg-sunken')}>
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="min-w-0 truncate text-xs font-medium text-fg">{authorLabel(snapshot, reply)}</span>
      <Badge tone={reply.audience === 'players' ? 'accent' : 'neutral'}>{reply.audience === 'players' ? 'To players' : 'Staff only'}</Badge>
      {reply.status === 'delivered' && <Badge tone="success">Delivered</Badge>}
      {reply.status === 'pending' && <Badge tone="neutral">Sending…</Badge>}
      {failed && <Badge tone="danger">Not delivered</Badge>}
      <time dateTime={new Date(reply.createdAtMs).toISOString()} className="ml-auto font-mono text-2xs text-fg-subtle">
        {formatTimeOfDay(reply.createdAtMs)}
      </time>
    </span>
    <span className="whitespace-pre-wrap break-words text-xs text-fg">{reply.body}</span>
    {failed && <span className="flex flex-wrap items-center gap-2">
      {reply.deliveryError && <span className="text-2xs text-danger">{reply.deliveryError}</span>}
      {canRetry && <Button size="sm" variant="secondary" icon={<RotateCw aria-hidden />} loading={retrying}
        aria-label={`Retry delivering the reply from ${formatTimeOfDay(reply.createdAtMs)}`} onClick={onRetry}>Retry</Button>}
    </span>}
  </li>;
}

export function ReplyThread({ snapshot, matchId }: { snapshot: EventSnapshotDto; matchId: MatchId }) {
  const { api } = useAdminData();
  const access = useEvidenceAccess();
  const eventId = snapshot.eventId;
  const list = useEvidenceReplies(eventId, matchId, access.read);
  const update = useReplyCacheUpdate(eventId, matchId);
  const [text, setText] = useState('');
  const [staffOnly, setStaffOnly] = useState(false);
  const [sending, setSending] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // A ref, not state: two Ctrl+Enter presses in one tick would both see sending=false and post twice.
  const inFlight = useRef(false);
  const retrying = useRef(new Set<string>());
  const toggleId = useId();
  const match = snapshot.matches.find(entry => entry.id === matchId);
  const names = match ? match.seats.map(seat => seatName(snapshot, seat)) : [];
  const replies = list.data?.replies ?? [];
  const bodyError = validateReplyBody(text);

  const send = async () => {
    setTouched(true);
    if (inFlight.current || bodyError) return;
    inFlight.current = true; setSending(true); setError(null);
    try {
      const reply = await sendReply(api, eventId, matchId, text.trim(), staffOnly ? 'staff' : 'players');
      update(reply);
      setText(''); setTouched(false);
    } catch (cause) {
      setError(describeError(cause, 'The reply could not be sent.'));
    } finally { inFlight.current = false; setSending(false); }
  };
  const retry = async (reply: EvidenceReplyDto) => {
    if (retrying.current.has(reply.id)) return;
    retrying.current.add(reply.id); setRetryingId(reply.id); setError(null);
    try { update(await retryReply(api, eventId, matchId, reply.id)); }
    catch (cause) { setError(describeError(cause, 'The reply could not be retried.')); }
    finally { retrying.current.delete(reply.id); setRetryingId(current => (current === reply.id ? null : current)); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter is a newline; Ctrl/Cmd+Enter sends. Never while an IME is composing.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return <section aria-label="Replies" className="flex flex-col gap-2 border-t border-line pt-3">
    <h3 className="text-xs font-semibold text-fg">Replies</h3>
    {list.isLoading && <p role="status" className="text-xs text-fg-muted">Loading replies…</p>}
    {!!list.error && !list.data && <p role="alert" className="text-xs text-danger">{describeError(list.error, 'Replies could not be loaded.')}</p>}
    {list.data && (replies.length === 0
      ? <p className="text-xs text-fg-muted">No replies yet. A reply goes to the match's players in Discord unless it is a staff note.</p>
      : <ul aria-label="Replies, oldest first" className="flex flex-col gap-1.5">
        {replies.map(reply => <ReplyRow key={reply.id} snapshot={snapshot} reply={reply} retrying={retryingId === reply.id}
          canRetry={access.reply} onRetry={() => void retry(reply)} />)}
      </ul>)}
    {access.reply
      ? <form aria-label="Reply to this match" className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void send(); }}>
        <Field label="Reply" description={staffOnly ? 'Only visible in this dashboard.'
          : `Posted in Discord to ${names.length ? names.join(' and ') : "the match's players"}; only they are mentioned.`}
        error={touched ? bodyError : undefined}>
          <Textarea rows={3} value={text} maxLength={EVIDENCE_REPLY_MAX_LENGTH + 200} readOnly={sending}
            placeholder="Write a reply. Ctrl+Enter sends." onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Switch id={toggleId} size="sm" checked={staffOnly} onCheckedChange={setStaffOnly} aria-label="Staff note only" />
            <label htmlFor={toggleId} className="text-xs text-fg-muted">Staff note only</label>
          </span>
          <Button type="submit" size="sm" variant="primary" loading={sending} icon={<Send aria-hidden />}>Send</Button>
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </form>
      : <p className="text-xs text-fg-muted">Replying needs dashboard actions turned on for this console.</p>}
  </section>;
}
