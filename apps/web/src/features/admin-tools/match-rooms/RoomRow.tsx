// One table in the Rooms tab: current and pending name, the queued notice, inline rename and "Use template", the match it
// serves, who is in it, and whether it is being recorded. Renames are queued by the server, never awaited here.
import { MATCH_ROOM_RENAME_NOTICE, validMatchRoomName, type MatchRoomDto } from '@tcg-live/core';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Button, ConfirmDialog, IconButton, Input } from '../../../ui';
import { formatTimeOfDay } from '../../../data';
import { describeError } from '../../evidence/api';
import { useMatchRoomActions } from './api';

const memberName = (member: { id: string; displayName: string | null }) => member.displayName ?? `Member …${member.id.slice(-4)}`;

export function RoomRow({ room, canEdit }: { room: MatchRoomDto; canEdit: boolean }) {
  const { rename, forget } = useMatchRoomActions();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const label = `Table ${room.table}`;
  const shown = room.name ?? (room.missing ? 'Channel deleted in Discord' : 'Unnamed channel');
  const draftError = draft === null ? null : validMatchRoomName(draft);
  const waiting = room.rename.state === 'queued' || room.rename.state === 'retrying';

  const run = async (customName: string | null): Promise<boolean> => {
    setError(null);
    try { await rename.mutateAsync({ channelId: room.channelId, customName }); return true; }
    catch (cause) { setError(describeError(cause, 'The room could not be renamed.')); return false; }
  };
  const remove = async () => {
    setError(null);
    try { await forget.mutateAsync(room.channelId); setRemoving(false); }
    catch (cause) { setRemoving(false); setError(describeError(cause, 'The room could not be removed.')); }
  };

  return <li data-table={room.table} aria-label={label} className="flex flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0">
    <div className="flex flex-wrap items-center gap-2">
      <Badge mono>{label}</Badge>
      {draft === null
        ? <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-[13px] font-medium text-fg">{shown}</span>
          {canEdit && !room.missing && <IconButton size="sm" variant="ghost" aria-label={`Rename ${label}`} icon={<Pencil />} onClick={() => { setDraft(room.customName ?? room.templateName); setError(null); }} />}
        </span>
        : <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={event => { event.preventDefault(); if (!draftError) void run(draft.trim()).then(ok => { if (ok) setDraft(null); }); }}>
          <Input aria-label={`New name for ${label}`} aria-invalid={draftError ? true : undefined} value={draft} maxLength={100} autoFocus className="min-w-[10rem] flex-1"
            onChange={event => setDraft(event.target.value)} />
          <Button type="submit" size="sm" variant="primary" loading={rename.isPending} disabled={!!draftError || draft.trim() === room.customName}>Save name</Button>
          <Button type="button" size="sm" variant="ghost" disabled={rename.isPending} onClick={() => setDraft(null)}>Cancel</Button>
        </form>}
      {room.origin === 'adopted' && <Badge tone="accent">Adopted</Badge>}
      {room.missing && <Badge tone="danger">Missing in Discord</Badge>}
      <span className="flex-1" />
      <Badge tone={room.assignedMatch ? 'accent' : 'neutral'} mono={!!room.assignedMatch}>{room.assignedMatch ? `Playing ${room.assignedMatch}` : 'Free'}</Badge>
      {room.recording === 'recording' ? <Badge tone="danger">Recording</Badge>
        : room.recording === 'monitored' ? <Badge tone="success">Monitored</Badge>
          : room.recording === 'unmonitored' ? <Badge tone="warning">Unmonitored</Badge> : null}
    </div>
    {draftError && <p role="alert" className="text-xs text-danger">{draftError}</p>}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      {room.customName !== null
        ? <span className="flex items-center gap-1.5"><Badge>Custom name</Badge>
          <span>Template would be “{room.templateName}”.</span>
          {canEdit && <Button size="sm" variant="ghost" loading={rename.isPending && rename.variables?.channelId === room.channelId}
            aria-label={`Use template for ${label}`} onClick={() => { void run(null); }}>Use template</Button>}
        </span>
        : <span>Named by the template: “{room.templateName}”.</span>}
      <span>{room.connected === null ? 'Who is connected: not available' : room.connected.length === 0 ? 'Nobody connected'
        : <>Connected: <span aria-label={`Connected to ${label}`}>{room.connected.map(memberName).join(', ')}</span></>}</span>
    </div>
    {room.connected && room.connected.length > 0 && <ul aria-label={`Members in ${label}`} className="flex flex-wrap gap-1">
      {room.connected.map(member => <li key={member.id}><Avatar src={member.avatarUrl} name={memberName(member)} size="xs" /></li>)}
    </ul>}
    {room.pendingName !== null && <p role="status" className="rounded-md bg-sunken p-2 text-xs text-fg">
      Renaming to <b className="font-medium">“{room.pendingName}”</b>.{' '}
      {waiting ? <>{MATCH_ROOM_RENAME_NOTICE}{room.rename.nextAttemptAtMs !== null && <> Next attempt at {formatTimeOfDay(room.rename.nextAttemptAtMs)}.</>}</> : null}
      {room.rename.state === 'retrying' && ' Discord asked the bot to wait; it will try again.'}
    </p>}
    {room.rename.state === 'failed' && <p role="alert" className="text-xs text-danger">
      The rename failed{room.rename.error ? `: ${room.rename.error}` : '.'}{room.rename.nextAttemptAtMs !== null && ` Next attempt at ${formatTimeOfDay(room.rename.nextAttemptAtMs)}.`}</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {canEdit && <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden />} disabled={room.removeBlockedReason !== null} aria-label={`Remove ${label} from the pool`}
        onClick={() => setRemoving(true)}>Remove from pool</Button>
      {room.removeBlockedReason && <span className="text-2xs text-fg-subtle">{room.removeBlockedReason}</span>}
    </div>}
    <ConfirmDialog open={removing} danger title={`Remove ${label} from the pool?`} confirmLabel="Remove from pool" pending={forget.isPending}
      description={room.origin === 'adopted'
        ? 'The bot stops using this channel. It keeps its current name and permissions; clean-up will not restore its original name.'
        : 'The voice channel stays in Discord. Clean-up will no longer delete it; delete it yourself if you don\u2019t need it.'}
      onCancel={() => setRemoving(false)} onConfirm={() => { void remove(); }} />
  </li>;
}
