// Admin tools > Rooms: the bot's pool of numbered match voice rooms ("tables"). Names and the rename queue, the room name
// template, the category, the server baseline and the clean-up after a tournament. The server owns every rule.
import { MATCH_ROOM_LIMITS, type MatchRoomCategoryDto, type MatchRoomDto, type MatchRoomsDto } from '@tcg-live/core';
import { Plus, Sparkles, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useActiveSnapshot } from '../../../data';
import { Badge, Button, Field, Input, Select } from '../../../ui';
import { describeError, isNotAvailable } from '../../evidence/api';
import { useAdminToolsCapability } from '../api';
import { EditorDialog } from '../shared/EditorDialog';
import { useMatchRoomActions, useMatchRooms } from './api';
import { BaselineCard } from './BaselineCard';
import { CleanupDialog } from './CleanupDialog';
import { RoomRow } from './RoomRow';
import { TemplateEditor } from './TemplateEditor';

export const MEMORY_STORAGE_HINT = 'Rooms are only kept in memory right now. Run npm start so the bot can update its database; until then they reset on restart.';
const LOW_SLOTS = 25;

/** "N of 500 server channels free", with a bar that turns to a warning when the server is nearly full. */
function ChannelMeter({ free }: { free: number }) {
  const max = MATCH_ROOM_LIMITS.serverChannels;
  const low = free < LOW_SLOTS;
  return <div className="flex min-w-[12rem] flex-col gap-1">
    <p className={`text-xs ${low ? 'font-medium text-warning' : 'text-fg-muted'}`}>{free} of {max} server channels free</p>
    <div role="meter" aria-label="Free server channels" aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(free, max)}
      aria-valuetext={`${free} of ${max} server channels free`} className="h-1.5 overflow-hidden rounded-full bg-line-faint">
      <div className={`h-full rounded-full ${low ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${Math.max(0, Math.min(100, (free / max) * 100))}%` }} />
    </div>
  </div>;
}

function AddExistingRoom({ data }: { data: MatchRoomsDto }) {
  const { adopt } = useMatchRoomActions();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pooled = new Set(data.rooms.map(room => room.channelId));
  const choices = data.baseline.filter(item => item.type === 'voice' && !pooled.has(item.id));
  const close = () => { setOpen(false); setChannelId(''); setError(null); };
  const submit = async () => {
    if (!channelId) return;
    setError(null);
    try { await adopt.mutateAsync(channelId); close(); }
    catch (cause) { setError(describeError(cause, 'The channel could not be added.')); }
  };
  return <>
    <Button size="sm" variant="secondary" icon={<Plus aria-hidden />} onClick={() => setOpen(true)}>Add an existing voice channel</Button>
    <EditorDialog open={open} width="md" title="Add an existing voice channel" busy={adopt.isPending} dirty={channelId !== ''} onClose={close}
      description="The bot joins it to the pool as a table, renames it to the template at the next event and restores its name at clean-up."
      footer={<>
        <Button type="button" size="sm" variant="ghost" disabled={adopt.isPending} onClick={close}>Cancel</Button>
        <Button type="submit" form={formId} size="sm" variant="primary" loading={adopt.isPending} disabled={!channelId}>Add to pool</Button>
      </>}>
      <form id={formId} aria-label="Add a voice channel to the pool" className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <Field label="Voice channel">
          <Select value={channelId} onChange={event => setChannelId(event.target.value)}>
            <option value="">Choose a voice channel</option>
            {choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        {choices.length === 0 && <p className="text-xs text-fg-subtle">Every voice channel the bot can see is already a table.</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </form>
    </EditorDialog>
  </>;
}

function RoomGroups({ data, canEdit }: { data: MatchRoomsDto; canEdit: boolean }) {
  const names = new Map(data.baseline.map(item => [item.id, item.name]));
  const known = new Map<string, MatchRoomCategoryDto>(data.categories.map(category => [category.categoryId, category]));
  const byCategory = new Map<string, MatchRoomDto[]>();
  for (const room of [...data.rooms].sort((a, b) => a.table - b.table)) {
    const key = room.categoryId ?? '';
    byCategory.set(key, [...(byCategory.get(key) ?? []), room]);
  }
  const keys = [...byCategory.keys()].sort((a, b) => (byCategory.get(a)![0]!.table - byCategory.get(b)![0]!.table));
  return <div className="flex flex-col gap-3">
    {keys.map(key => {
      const category = known.get(key);
      const title = key === '' ? 'No category' : category?.name ?? names.get(key) ?? `Category …${key.slice(-4)}`;
      const rooms = byCategory.get(key)!;
      return <section key={key || 'none'} aria-label={title} className="flex flex-col rounded-md border border-line px-3 py-1">
        <header className="flex flex-wrap items-center gap-2 border-b border-line py-2">
          <h4 className="text-[13px] font-semibold text-fg">{title}</h4>
          {category && <span className="text-xs text-fg-subtle">Tables {category.from}–{category.to}</span>}
          {category?.origin === 'created' && <Badge tone="accent">bot-created</Badge>}
          {category?.missing && <Badge tone="danger">Missing in Discord</Badge>}
        </header>
        <ul aria-label={`Rooms in ${title}`}>{rooms.map(room => <RoomRow key={room.channelId} room={room} canEdit={canEdit} />)}</ul>
      </section>;
    })}
  </div>;
}

function Rooms({ data, canEdit }: { data: MatchRoomsDto; canEdit: boolean }) {
  const { ensure } = useMatchRoomActions();
  const active = useActiveSnapshot().snapshot;
  const suggested = Math.max(2, active?.matches.length ?? 0, data.rooms.length);
  const [tables, setTables] = useState<string>('');
  const [cleaning, setCleaning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wanted = Number(tables === '' ? suggested : tables);
  const validCount = Number.isInteger(wanted) && wanted >= 1 && wanted <= MATCH_ROOM_LIMITS.serverChannels;
  const disabledReason = !data.canManageChannels ? 'The bot needs the Manage Channels permission to create rooms.' : null;

  const create = async () => {
    setError(null); setMessage(null);
    try {
      const done = await ensure.mutateAsync(wanted);
      setMessage(done.created.length === 0 ? 'Every table already has a room.' : `Created ${done.created.length} ${done.created.length === 1 ? 'room' : 'rooms'}.`);
    } catch (cause) { setError(describeError(cause, 'The rooms could not be created.')); }
  };

  return <div className="flex flex-col gap-4">
    <section aria-label="Match rooms" className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-fg">Match rooms</h3>
          <p className="text-xs text-fg-muted">The bot creates a voice room for each match when a round publishes and reuses it in later rounds and events.
            {data.eventName ? ` Active event: ${data.eventName}.` : ''}</p>
        </div>
        {data.freeChannelSlots !== null && <ChannelMeter free={data.freeChannelSlots} />}
      </header>
      {canEdit && <div className="flex flex-wrap items-end gap-2">
        <Field label="Tables" className="w-24">
          <Input type="number" min={1} max={MATCH_ROOM_LIMITS.serverChannels} value={tables === '' ? String(suggested) : tables}
            onChange={event => setTables(event.target.value)} />
        </Field>
        <Button size="sm" variant="primary" icon={<Sparkles aria-hidden />} loading={ensure.isPending} disabled={!validCount || !!disabledReason} onClick={() => { void create(); }}>
          Create missing rooms</Button>
        <AddExistingRoom data={data} />
      </div>}
      {disabledReason && canEdit && <p className="text-xs text-warning">{disabledReason}</p>}
      {message && <p role="status" className="text-xs text-fg-muted">{message}</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {data.rooms.length === 0 ? <p className="text-xs text-fg-subtle">No rooms yet. The bot creates them when the first round publishes, or create them now.</p>
        : <RoomGroups data={data} canEdit={canEdit} />}
    </section>

    <TemplateEditor data={data} canEdit={canEdit} />
    <BaselineCard data={data} canEdit={canEdit} />

    <section aria-label="Clean up" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger p-4">
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-semibold text-fg">After the tournament</h3>
        <p className="text-xs text-fg-muted">Delete the rooms and categories the bot created, restore the channels it adopted, and archive each room chat first.
          You review everything before anything changes.</p>
      </div>
      <Button variant="danger" disabled={!canEdit} onClick={() => setCleaning(true)}>Clean up after tournament</Button>
    </section>
    <CleanupDialog open={cleaning} onClose={() => setCleaning(false)} />
  </div>;
}

export function MatchRoomsTab() {
  const rooms = useMatchRooms();
  const canEdit = useAdminToolsCapability('server.manage');
  const data = rooms.data;
  if (rooms.error) return <p role="alert" className="text-xs text-danger">{isNotAvailable(rooms.error)
    ? 'Rooms are not available in this version yet.' : describeError(rooms.error, 'Rooms could not be loaded.')}{' '}
    <Button size="sm" variant="ghost" onClick={() => { void rooms.refetch(); }}>Try again</Button></p>;
  if (!data) return <p role="status" className="text-xs text-fg-muted">Loading rooms…</p>;
  return <div className="flex flex-col gap-4">
    {data.problem && <p role="alert" className="flex gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" /><span>{data.problem}</span></p>}
    {data.storage === 'memory' && <p role="status" className="rounded-md bg-sunken p-2 text-xs text-fg-muted">{MEMORY_STORAGE_HINT}</p>}
    {!canEdit && <p className="text-xs text-fg-subtle">You can look at the rooms. Changing them needs the server management capability.</p>}
    <Rooms data={data} canEdit={canEdit} />
  </div>;
}
