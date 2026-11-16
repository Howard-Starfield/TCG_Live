// Channels tab: create a text or voice channel in one dialog (name, type, category and reason), or pick a channel, then lock/unlock, set or
// clear slowmode, or purge recent messages. Those actions ask for confirmation with a reason (written to the audit log).
import { ADMIN_TOOLS_LIMITS as L, type ChannelCreateRequestDto, type ChannelPurgeRequestDto, type ChannelPurgeResultDto, type ChannelStateDto,
  type GuildChannelDto } from '@tcg-live/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen, Plus, Timer, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useAdminData } from '../../../data';
import { Badge, Button, ConfirmDialog, Field, Input, SegmentedControl, Textarea, useToast } from '../../../ui';
import { describeError, retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsCapability, useGuildMeta } from '../api';
import { ChannelSelect } from '../shared/ChannelSelect';
import { EditorDialog } from '../shared/EditorDialog';
import { useAction } from './useAction';

const SNOWFLAKE = /^[1-9]\d{14,21}$/;

export function purgeMessage(result: ChannelPurgeResultDto): string {
  const base = `Deleted ${result.deleted} message${result.deleted === 1 ? '' : 's'}.`;
  return result.skippedTooOld ? `${base} ${result.skippedTooOld} older than 14 days could not be bulk-deleted (Discord limit); delete those by hand.` : base;
}

type Pending =
  | { kind: 'lock'; locked: boolean }
  | { kind: 'slowmode'; seconds: number }
  | { kind: 'purge'; request: PurgeDraft };
type PurgeDraft = ChannelPurgeRequestDto extends infer R ? R extends unknown ? Omit<R, 'reason'> : never : never;

function CreateChannelDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(channel: GuildChannelDto): void }) {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const toast = useToast();
  const formId = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [parentId, setParentId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useAction();
  const trimmedName = name.trim();
  const trimmedReason = reason.trim();
  const dirty = trimmedName !== '' || trimmedReason !== '';
  const reset = () => { setName(''); setType('text'); setParentId(null); setReason(''); setTouched(false); create.clear(); };
  const close = () => { onClose(); reset(); };
  const submit = async () => {
    setTouched(true);
    if (!trimmedName || !trimmedReason || create.pending) return;
    const body: ChannelCreateRequestDto = { name: trimmedName, type, parentId, reason: trimmedReason };
    const result = await create.run(() => api.request<GuildChannelDto>('POST', '/admin-tools/channels/create', { body }), 'The channel was not created.');
    if (!result) return;
    void queryClient.invalidateQueries({ queryKey: adminToolsKeys.guild() });
    toast.show({ title: `Created ${result.type === 'text' ? '#' : ''}${result.name}`, tone: 'success' });
    onCreated(result);
    close();
  };
  return <EditorDialog open={open} title="New channel" width="md" busy={create.pending} dirty={dirty} onClose={close}
    description="Needs the bot’s Manage Channels permission. Tournament match rooms must start with “TCG Match”."
    footer={<>
      <Button type="button" variant="ghost" size="sm" onClick={close} disabled={create.pending}>Cancel</Button>
      <Button type="submit" form={formId} variant="primary" size="sm" loading={create.pending}>Create channel</Button>
    </>}>
    <form id={formId} noValidate aria-label="New channel" className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Field label="Name" required error={touched && !trimmedName ? 'A name is required.' : undefined}
        description="Discord lowercases text channel names and replaces spaces with hyphens.">
        <Input value={name} maxLength={L.channelNameLength} placeholder={type === 'text' ? 'side-events' : 'TCG Match 3'}
          onChange={event => { setName(event.target.value); create.clear(); }} />
      </Field>
      <SegmentedControl label="Channel type" value={type} onChange={value => setType(value as 'text' | 'voice')}
        options={[{ value: 'text', label: 'Text' }, { value: 'voice', label: 'Voice' }]} />
      <Field label="Category" description="The channel starts with its category’s permissions (or the server defaults).">
        <ChannelSelect value={parentId} types={['category']} placeholder="No category" onChange={setParentId} />
      </Field>
      <Field label="Reason (for the audit log)" required error={touched && !trimmedReason ? 'A reason is required.' : undefined}>
        <Textarea value={reason} rows={3} disabled={create.pending} onChange={event => setReason(event.target.value)} onBlur={() => setTouched(true)} />
      </Field>
      {create.error && <p role="alert" className="text-xs text-danger">{create.error}</p>}
    </form>
  </EditorDialog>;
}

export function ChannelsTab() {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const canAct = useAdminToolsCapability('members.moderate');
  const canCreate = useAdminToolsCapability('server.manage');
  const [creating, setCreating] = useState(false);
  const meta = useGuildMeta();
  const [channelId, setChannelId] = useState<string | null>(null);
  const [slowmode, setSlowmode] = useState('10');
  const [mode, setMode] = useState<'count' | 'user'>('count');
  const [count, setCount] = useState('20');
  const [userId, setUserId] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const action = useAction();
  const stateKey = adminToolsKeys.feature('channels', 'state', channelId);
  const state = useQuery({ queryKey: stateKey, enabled: !!channelId, retry: retryTransient,
    queryFn: ({ signal }) => api.request<ChannelStateDto>('GET', `/admin-tools/channels/state/${channelId}`, { signal }) });
  const channel = meta.data?.channels.find(item => item.id === channelId);
  const reserved = channel?.reserved ?? false;
  const where = channel ? `#${channel.name}` : 'this channel';

  const ask = (next: Pending | null, error: string | null = null) => { setFormError(error); setPending(error ? null : next); action.clear(); };
  const askSlowmode = (seconds: number) => {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > L.slowmodeSecondsMax) return ask(null, `Slowmode must be 0-${L.slowmodeSecondsMax} seconds.`);
    ask({ kind: 'slowmode', seconds });
  };
  const askPurge = () => {
    const amount = Number(count);
    if (!Number.isInteger(amount) || amount < 1 || amount > L.purgeCountMax) return ask(null, `Purge 1-${L.purgeCountMax} messages at a time.`);
    if (mode === 'user' && !SNOWFLAKE.test(userId.trim())) return ask(null, 'Enter the member’s Discord ID.');
    ask({ kind: 'purge', request: mode === 'count' ? { channelId: channelId!, mode, count: amount } : { channelId: channelId!, mode, userId: userId.trim(), count: amount } });
  };
  const confirm = (reason: string) => {
    const current = pending;
    if (!current || !channelId) return;
    void action.run(async () => {
      if (current.kind === 'lock') return api.request<ChannelStateDto>('POST', '/admin-tools/channels/lock', { body: { channelId, locked: current.locked, reason } });
      if (current.kind === 'slowmode') return api.request<ChannelStateDto>('POST', '/admin-tools/channels/slowmode', { body: { channelId, seconds: current.seconds, reason } });
      return api.request<ChannelPurgeResultDto>('POST', '/admin-tools/channels/purge', { body: { ...current.request, reason } });
    }, 'That did not work.', result => {
      if ('deleted' in result) return purgeMessage(result);
      queryClient.setQueryData(stateKey, result);
      return current.kind === 'lock' ? (result.locked ? 'Channel locked.' : 'Channel unlocked.')
        : result.slowmodeSeconds ? `Slowmode set to ${result.slowmodeSeconds} s.` : 'Slowmode off.';
    }).then(() => setPending(null));
  };

  const title = !pending ? '' : pending.kind === 'lock' ? (pending.locked ? `Lock ${where}?` : `Unlock ${where}?`)
    : pending.kind === 'slowmode' ? (pending.seconds ? `Set slowmode in ${where} to ${pending.seconds} seconds?` : `Turn slowmode off in ${where}?`)
    : pending.request.mode === 'count' ? `Delete the last ${pending.request.count} messages in ${where}?`
    : `Delete up to ${pending.request.count} recent messages from member ${pending.request.userId} in ${where}?`;
  const description = !pending ? '' : pending.kind === 'lock' ? (pending.locked
    ? 'Members lose Send Messages here. Unlocking restores exactly the permission that was there before.'
    : 'Puts back the Send Messages permission that was there before the lock.')
    : pending.kind === 'purge' ? "This cannot be undone. The bot's own messages are always kept, and messages older than 14 days are skipped (Discord limit)."
    : 'Members wait this long between messages.';

  return <div className="flex flex-col gap-4">
    {canCreate && <header className="flex items-center gap-2">
      <p className="flex-1 text-xs text-fg-muted">Create a text or voice channel, or pick one below to lock it, set slowmode or purge messages.</p>
      <Button size="sm" variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>New channel</Button>
    </header>}
    <Field label="Channel" description="Tournament channels are marked; locking them can block players.">
      <ChannelSelect value={channelId} placeholder="Choose a channel" onChange={next => { setChannelId(next); ask(null); }} />
    </Field>
    {channelId && <section aria-label="Channel controls" className="flex flex-col gap-4 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {state.data ? <>
          <Badge tone={state.data.locked ? 'warning' : 'success'}>{state.data.locked ? 'Locked' : 'Open'}</Badge>
          <Badge tone="neutral">{state.data.slowmodeSeconds ? `Slowmode ${state.data.slowmodeSeconds} s` : 'No slowmode'}</Badge>
        </> : state.error ? <span role="alert" className="text-danger">{describeError(state.error, 'Channel state could not be loaded.')}</span>
          : <span role="status" className="text-fg-muted">Loading channel…</span>}
        {reserved && <Badge tone="warning">Tournament channel</Badge>}
      </div>
      {canAct ? <>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!state.data || state.data.locked || reserved} onClick={() => ask({ kind: 'lock', locked: true })}>
            <Lock aria-hidden className="size-3.5" />Lock</Button>
          <Button size="sm" variant="secondary" disabled={!state.data || !state.data.locked} onClick={() => ask({ kind: 'lock', locked: false })}>
            <LockOpen aria-hidden className="size-3.5" />Unlock</Button>
        </div>
        {reserved && <p className="text-xs text-fg-muted">Tournament channels cannot be locked: the bot would lose Send Messages there and
          stop posting match cards. Slowmode and purge still work.</p>}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Slowmode (seconds)">
            <Input type="number" min={1} max={L.slowmodeSecondsMax} value={slowmode} onChange={event => setSlowmode(event.target.value)} className="w-28" />
          </Field>
          <Button size="sm" variant="secondary" onClick={() => askSlowmode(Number(slowmode))}><Timer aria-hidden className="size-3.5" />Set slowmode</Button>
          <Button size="sm" variant="ghost" disabled={!state.data?.slowmodeSeconds} onClick={() => askSlowmode(0)}>Clear slowmode</Button>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-semibold text-fg">Purge</legend>
          <SegmentedControl label="Purge mode" value={mode} onChange={value => setMode(value as 'count' | 'user')}
            options={[{ value: 'count', label: 'Last messages' }, { value: 'user', label: 'By member' }]} />
          <div className="flex flex-wrap items-end gap-2">
            <Field label="How many"><Input type="number" min={1} max={L.purgeCountMax} value={count} onChange={event => setCount(event.target.value)} className="w-24" /></Field>
            {mode === 'user' && <Field label="Member ID"><Input value={userId} placeholder="Discord ID" onChange={event => setUserId(event.target.value)} /></Field>}
            <Button size="sm" variant="danger" onClick={askPurge}><Trash2 aria-hidden className="size-3.5" />Purge</Button>
          </div>
          <p className="text-[11px] text-fg-subtle">The bot’s own messages (match cards, panels, stickies, announcements) are never deleted, so fewer
            messages may go than you asked for. By member looks through the channel’s last 500 messages. Messages older than 14 days cannot be bulk-deleted.</p>
        </fieldset>
      </> : <p className="text-xs text-fg-muted">Your session can view channels but not change them.</p>}
      {(formError ?? action.error) && <p role="alert" className="text-xs text-danger">{formError ?? action.error}</p>}
      {action.note && <p role="status" className="text-xs text-fg">{action.note}</p>}
    </section>}
    <ConfirmDialog open={pending !== null} title={title} description={description} danger={pending?.kind === 'purge' || (pending?.kind === 'lock' && pending.locked)}
      confirmLabel={pending?.kind === 'purge' ? 'Delete messages' : 'Confirm'} requireReason reasonLabel="Reason (for the audit log)" pending={action.pending}
      onCancel={() => setPending(null)} onConfirm={confirm} />
    {canCreate && <CreateChannelDialog open={creating} onClose={() => setCreating(false)}
      onCreated={result => { if (result.type === 'text') { setChannelId(result.id); action.clear(); } }} />}
  </div>;
}
