// Match drawer > Room chat: the match's room text chat, saved when the room was given its next match or cleaned up.
// A list of transcripts, the messages of the one opened, and a hold switch that keeps it past the retention period.
import type { MatchId, MatchRoomTranscriptSummaryDto } from '@tcg-live/core';
import { useState } from 'react';
import { formatRelativeTime, useServerNow } from '../../data';
import { Badge, Button, Field, Switch } from '../../ui';
import { describeError } from '../evidence/api';
import { useAdminToolsCapability } from '../admin-tools/api';
import { useMatchTranscripts, useTranscript, useTranscriptHold } from '../admin-tools/match-rooms/api';
import { transcriptRows } from '../admin-tools/match-rooms/TranscriptExport';
import { ExportButtons } from '../admin-tools/shared/exportData';

export const NO_CONTENT_NOTE = 'Message text needs the Message Content intent. This transcript keeps who wrote, when, and any attachments.';
const REASON = { reassigned: 'Room reused for another match', cleanup: 'Cleaned up after the tournament', manual: 'Saved by hand' } as const;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Viewer({ id }: { id: string }) {
  const transcript = useTranscript(id);
  const hold = useTranscriptHold();
  const canHold = useAdminToolsCapability('server.manage');
  const [error, setError] = useState<string | null>(null);
  if (transcript.error) return <p role="alert" className="text-xs text-danger">{describeError(transcript.error, 'The transcript could not be loaded.')}</p>;
  const data = transcript.data;
  if (!data) return <p role="status" className="text-xs text-fg-muted">Loading the room chat…</p>;
  const toggle = async (next: boolean) => {
    setError(null);
    try { await hold.mutateAsync({ id: data.id, hold: next }); }
    catch (cause) { setError(describeError(cause, 'The hold could not be changed.')); }
  };
  return <div className="flex flex-col gap-2 rounded-md border border-line p-2">
    <div className="flex flex-wrap items-center gap-2">
      <Field label="Hold transcript" inline description="A held transcript is kept past the retention period.">
        <Switch checked={data.hold} disabled={!canHold || hold.isPending} onCheckedChange={next => { void toggle(next); }} />
      </Field>
      <span className="flex-1" />
      <ExportButtons name={`room-chat-${data.matchId}`} label="this transcript" collect={async () => ({ rows: transcriptRows(data), truncated: false })} />
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {!data.contentAvailable && <p role="note" className="rounded-md bg-line-faint p-2 text-xs text-fg-muted">{NO_CONTENT_NOTE}</p>}
    {data.skippedOld > 0 && <p className="text-xs text-fg-muted">{data.skippedOld} {data.skippedOld === 1 ? 'message was' : 'messages were'} older than
      14 days, so Discord would not let the bot clear {data.skippedOld === 1 ? 'it' : 'them'}.</p>}
    {data.messages.length === 0 ? <p className="text-xs text-fg-subtle">No messages were saved.</p>
      : <ol aria-label="Room chat messages" className="flex max-h-72 flex-col gap-2 overflow-auto">
        {data.messages.map(message => <li key={message.id} className="text-xs">
          <span className="font-medium text-fg">{message.authorName ?? `Member …${message.authorId.slice(-4)}`}</span>
          <span className="ml-2 text-fg-subtle">{time(message.createdAtMs)}</span>
          {message.content !== null ? <p className="whitespace-pre-wrap break-words text-fg-muted">{message.content}</p>
            : message.attachments.length === 0 && <p className="italic text-fg-subtle">Text not available.</p>}
          {message.attachments.map(item => <a key={item.url} href={item.url} target="_blank" rel="noreferrer noopener" className="block text-accent underline">{item.name}</a>)}
        </li>)}
      </ol>}
  </div>;
}

function Summary({ item, open, onToggle, now }: { item: MatchRoomTranscriptSummaryDto; open: boolean; onToggle(): void; now: number }) {
  const name = item.channelName ?? `Room …${item.channelId.slice(-4)}`;
  return <li className="flex flex-wrap items-center gap-2 text-xs">
    <span className="min-w-0 flex-1">
      <b className="font-medium text-fg">{name}</b>{' '}
      <span className="text-fg-muted">{REASON[item.reason]} · {formatRelativeTime(item.archivedAtMs, now)} · {item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'}</span>
    </span>
    {item.hold && <Badge tone="accent">Held</Badge>}
    {!item.contentAvailable && <Badge tone="warning">No message text</Badge>}
    <Button size="sm" variant={open ? 'secondary' : 'ghost'} aria-expanded={open} aria-label={`${open ? 'Hide' : 'View'} room chat from ${name}`}
      onClick={onToggle}>{open ? 'Hide' : 'View'}</Button>
  </li>;
}

export function RoomChatPanel({ eventId, matchId }: { eventId: string; matchId: MatchId }) {
  const list = useMatchTranscripts(eventId, matchId);
  const now = useServerNow(30_000);
  const [openId, setOpenId] = useState<string | null>(null);
  if (list.error) return <p role="alert" className="text-xs text-fg-muted">{describeError(list.error, 'Room chat could not be loaded.')}</p>;
  if (!list.data) return <p role="status" className="text-xs text-fg-muted">Loading room chat…</p>;
  if (list.data.length === 0) return <p className="text-xs text-fg-subtle">No room chat was saved for {matchId}. It is saved when the room is reused or cleaned up.</p>;
  return <div className="flex flex-col gap-2">
    <ul aria-label={`Room chat transcripts for ${matchId}`} className="flex flex-col gap-1.5">
      {list.data.map(item => <Summary key={item.id} item={item} now={now} open={openId === item.id}
        onToggle={() => setOpenId(current => current === item.id ? null : item.id)} />)}
    </ul>
    {openId && <Viewer key={openId} id={openId} />}
  </div>;
}
