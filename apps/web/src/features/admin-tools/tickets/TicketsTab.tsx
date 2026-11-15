// Tickets tab: the `tickets` settings section (support channel, category, staff roles, panel look, naming,
// retention), "Post / refresh panel", and the open/closed ticket list with transcripts, close and reopen.
import { ADMIN_TOOLS_LIMITS as L, type TicketDto, type TicketPageDto, type TicketSettingsDto, type TicketStatus, type TranscriptDto } from '@tcg-live/core';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Ticket, X } from 'lucide-react';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, IconButton, Input, SegmentedControl, Switch, Textarea, type Tone } from '../../../ui';
import { describeError, retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess, useAdminToolsCapability, useAdminToolsSection, useAdminToolsStatus, useGuildMeta } from '../api';
import { useAction } from '../channels/useAction';
import { ChannelSelect, RoleSelect } from '../shared/ChannelSelect';
import { SectionFrame } from '../shared/SectionFrame';
import { ExportButtons, type ExportRow } from '../shared/exportData';
import { useAdminToolsNavigation } from '../navigation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<TicketStatus, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'success' }, closed: { label: 'Closed', tone: 'neutral' }, deleted: { label: 'Channel deleted', tone: 'warning' }
};
type Filter = TicketStatus | 'all';
const time = (ms: number) => new Date(ms).toLocaleString();

export function ticketSettingsProblem(value: TicketSettingsDto): string | null {
  if (!/^[a-z0-9{}_-]+$/.test(value.namingPattern) || !value.namingPattern.includes('{n}'))
    return 'The name pattern may use lowercase letters, digits, - and _, {name}, and must include {n}.';
  if (value.enabled && (!value.supportChannelId || !value.categoryId || !value.staffRoleIds.length))
    return 'Choose a support channel, a ticket category and at least one staff role before turning tickets on.';
  return null;
}

function TicketSettings() {
  const { api } = useAdminData();
  const editor = useAdminToolsSection('tickets');
  const canEdit = useAdminToolsCapability('server.manage');
  const status = useAdminToolsStatus();
  const meta = useGuildMeta();
  const panel = useAction();
  const [addRole, setAddRole] = useState<string | null>(null);
  const value = editor.value;
  const set = (patch: Partial<TicketSettingsDto>) => { if (value) editor.setValue({ ...value, ...patch }); };
  const setPanel = (patch: Partial<TicketSettingsDto['panel']>) => { if (value) editor.setValue({ ...value, panel: { ...value.panel, ...patch } }); };
  const problem = value ? ticketSettingsProblem(value) : null;
  const contentOn = status.data?.privilegedIntents.messageContent === 'on';
  const roleName = (id: string) => meta.data?.roles.find(role => role.id === id)?.name ?? id;
  return <SectionFrame editor={editor} title="Ticket settings" canEdit={canEdit}
    description="Members press the panel button in the support channel to open a private channel that only they, the staff roles and the bot can see.">
    {value && <>
      <Field label="Tickets enabled" inline><Switch checked={value.enabled} disabled={!canEdit} onCheckedChange={enabled => set({ enabled })} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Support channel" description="The bot keeps the Create ticket panel at the bottom here.">
          <ChannelSelect value={value.supportChannelId} allowReserved={false} disabled={!canEdit} onChange={supportChannelId => set({ supportChannelId })} />
        </Field>
        <Field label="Ticket category" description="Ticket channels are created under this category.">
          <ChannelSelect value={value.categoryId} types={['category']} disabled={!canEdit} onChange={categoryId => set({ categoryId })} />
        </Field>
      </div>
      <Field label="Staff roles" description={`Can see every ticket, claim and close them (up to ${L.ticketStaffRoles}).`}>
        <div className="flex flex-col gap-2">
          <ul className="flex flex-wrap gap-1.5" aria-label="Staff roles">
            {value.staffRoleIds.map(id => <li key={id}><Badge tone="accent">@{roleName(id)}
              {canEdit && <IconButton aria-label={`Remove @${roleName(id)}`} size="sm" variant="ghost" icon={<X />}
                onClick={() => set({ staffRoleIds: value.staffRoleIds.filter(item => item !== id) })} />}</Badge></li>)}
            {!value.staffRoleIds.length && <li className="text-xs text-fg-subtle">No staff roles yet.</li>}
          </ul>
          {canEdit && value.staffRoleIds.length < L.ticketStaffRoles && <div className="flex gap-2">
            <RoleSelect value={addRole} onChange={setAddRole} placeholder="Add a staff role" allowElevated />
            <Button size="sm" variant="secondary" disabled={!addRole} onClick={() => {
              if (addRole && !value.staffRoleIds.includes(addRole)) set({ staffRoleIds: [...value.staffRoleIds, addRole] });
              setAddRole(null);
            }}>Add</Button>
          </div>}
        </div>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Panel title"><Input value={value.panel.title} maxLength={L.ticketPanelTitleLength} disabled={!canEdit} onChange={event => setPanel({ title: event.target.value })} /></Field>
        <Field label="Button label"><Input value={value.panel.buttonLabel} maxLength={L.ticketButtonLabelLength} disabled={!canEdit} onChange={event => setPanel({ buttonLabel: event.target.value })} /></Field>
        <Field label="Panel text" className="sm:col-span-2">
          <Textarea rows={3} value={value.panel.text} maxLength={L.ticketPanelTextLength} disabled={!canEdit} onChange={event => setPanel({ text: event.target.value })} />
        </Field>
        <Field label="Button emoji" description="One emoji, or a custom emoji from the list.">
          <div className="flex gap-2">
            <Input value={value.panel.emoji ?? ''} placeholder="🎫" disabled={!canEdit} onChange={event => setPanel({ emoji: event.target.value.trim() || null })} className="w-24" />
            {(meta.data?.emojis.length ?? 0) > 0 && <select aria-label="Custom emoji" className="rounded-md border border-line bg-transparent px-2 text-xs" disabled={!canEdit}
              value={meta.data!.emojis.some(emoji => emoji.id === value.panel.emoji) ? value.panel.emoji! : ''}
              onChange={event => setPanel({ emoji: event.target.value || null })}>
              <option value="">Custom…</option>
              {meta.data!.emojis.map(emoji => <option key={emoji.id} value={emoji.id}>:{emoji.name}:</option>)}
            </select>}
          </div>
        </Field>
        <Field label="Panel colour" description="Hex, e.g. #3b82f6. Empty for Discord's default.">
          {/* Uncontrolled while typing; the key resets it when the saved/draft colour changes (Undo, conflict, reload). */}
          <Input key={value.panel.color ?? 'none'} aria-label="Panel colour"
            defaultValue={value.panel.color === null ? '' : `#${value.panel.color.toString(16).padStart(6, '0')}`} disabled={!canEdit}
            onBlur={event => { const raw = event.target.value.trim(); if (!raw) setPanel({ color: null }); else if (/^#?[0-9a-f]{6}$/i.test(raw)) setPanel({ color: parseInt(raw.replace('#', ''), 16) }); }} />
        </Field>
        <Field label="Channel name pattern" description="{name} is the member's username, {n} the ticket number.">
          <Input value={value.namingPattern} maxLength={L.ticketNamingPatternLength} disabled={!canEdit} onChange={event => set({ namingPattern: event.target.value })} />
        </Field>
        <Field label="Keep transcripts (days)" description="Empty keeps them until deleted by hand.">
          <Input type="number" min={L.retentionDaysMin} max={L.retentionDaysMax} disabled={!canEdit} value={value.transcriptRetentionDays ?? ''}
            onChange={event => set({ transcriptRetentionDays: event.target.value === '' ? null : Number(event.target.value) })} />
        </Field>
      </div>
      <p className="text-xs text-fg-muted">Each member can have one open ticket. Staff can reopen a closed ticket from this page for 24 hours.</p>
      {!contentOn && <p className="flex gap-2 rounded-md bg-line-faint p-2 text-xs text-fg-muted">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>Enable the <b>Message Content intent</b> for full transcripts. Without it Discord hides other members' text and attachments from the bot, so
          transcripts keep authors and times only (plus the bot's own messages). The bot requests that intent while the message log is on.</span>
      </p>}
      {problem && canEdit && editor.dirty && <p role="alert" className="text-xs text-warning">{problem}</p>}
      {canEdit && <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" loading={panel.pending} disabled={editor.dirty || !editor.saved?.tickets.enabled}
          onClick={() => { void panel.run(() => api.request<{ message: string }>('POST', '/admin-tools/tickets/panel'), 'The panel could not be posted.', result => result.message); }}>
          Post / refresh panel</Button>
        {editor.dirty && <span className="text-xs text-fg-subtle">Save first.</span>}
        {panel.error && <span role="alert" className="text-xs text-danger">{panel.error}</span>}
        {panel.note && <span role="status" className="text-xs text-fg">{panel.note}</span>}
      </div>}
    </>}
  </SectionFrame>;
}

/** Transcript export rows: one per message, with the ticket's number and name. */
export function transcriptRows(transcript: TranscriptDto): ExportRow[] {
  return transcript.messages.map(message => ({ ticket: transcript.ticket.number, ticketName: transcript.ticket.name, seq: message.seq,
    at: new Date(message.createdAtMs).toISOString(), authorId: message.authorId, author: message.authorName, bot: message.authorBot,
    content: message.content, attachments: message.attachments.map(item => item.url) }));
}

function TranscriptDialog({ ticketId, ticket: known, onClose }: { ticketId: string; ticket?: TicketDto; onClose(): void }) {
  const { api } = useAdminData();
  const transcript = useQuery({ queryKey: adminToolsKeys.feature('tickets', 'transcript', ticketId), retry: retryTransient,
    queryFn: ({ signal }) => api.request<TranscriptDto>('GET', `/admin-tools/tickets/${ticketId}/transcript`, { signal }) });
  const ticket = known ?? transcript.data?.ticket;
  const data = transcript.data;
  return <Dialog open onClose={onClose} title={ticket ? `Ticket #${ticket.number} transcript` : 'Ticket transcript'} description={ticket?.name} width="lg"
    footer={<>{data && data.messages.length > 0 && <ExportButtons name={`ticket-${data.ticket.number}-transcript`} label="the transcript"
      collect={async () => ({ rows: transcriptRows(data), truncated: false })} />}<span className="flex-1" /><Button onClick={onClose}>Close</Button></>}>
    {transcript.error ? <p role="alert" className="text-xs text-danger">{describeError(transcript.error, 'The transcript could not be loaded.')}</p>
      : !transcript.data ? <p role="status" className="text-xs text-fg-muted">Loading transcript…</p>
      : transcript.data.messages.length === 0 ? <p className="text-xs text-fg-muted">No messages were saved{ticket?.status === 'open' ? ' yet: the transcript is saved when the ticket closes' : ''}.</p>
      : <ol className="flex flex-col gap-2" aria-label="Transcript">
        {transcript.data.messages.map(message => <li key={message.seq} className="text-xs">
          <span className="font-medium text-fg">{message.authorName}</span>{message.authorBot && <Badge tone="neutral">bot</Badge>}
          <span className="ml-2 text-fg-subtle">{time(message.createdAtMs)}</span>
          {message.content ? <p className="whitespace-pre-wrap text-fg-muted">{message.content}</p>
            : !message.attachments.length && <p className="italic text-fg-subtle">Text not available (Message Content intent off).</p>}
          {message.attachments.map(item => <a key={item.url} href={item.url} target="_blank" rel="noreferrer noopener" className="block text-accent underline">{item.name}</a>)}
        </li>)}
      </ol>}
  </Dialog>;
}

function TicketList() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  const canModerate = useAdminToolsCapability('members.moderate');
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');
  // The open transcript is part of the deep link (#/admin-tools/tickets/<ticket id>).
  const navigation = useAdminToolsNavigation();
  const [viewingId, setViewingId] = useState<string | null>(() => (navigation.item && UUID.test(navigation.item) ? navigation.item : null));
  const setViewing = (ticket: TicketDto | null) => { setViewingId(ticket?.id ?? null); navigation.setItem?.(ticket?.id ?? null); };
  const [pending, setPending] = useState<{ ticket: TicketDto; action: 'close' | 'reopen' } | null>(null);
  const action = useAction();
  const key = adminToolsKeys.feature('tickets', 'list', filter);
  const list = useInfiniteQuery({ queryKey: key, enabled: access, retry: retryTransient, refetchInterval: 30_000,
    initialPageParam: null as number | null, getNextPageParam: (page: TicketPageDto) => page.nextBefore,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (pageParam !== null) params.set('before', String(pageParam));
      const query = params.toString();
      return api.request<TicketPageDto>('GET', `/admin-tools/tickets${query ? `?${query}` : ''}`, { signal });
    } });
  const tickets = list.data?.pages.flatMap(page => page.tickets) ?? [];
  const now = Date.now();
  const confirm = () => {
    const current = pending;
    if (!current) return;
    void action.run(() => api.request<{ warning?: string | null }>('POST', `/admin-tools/tickets/${current.ticket.id}/${current.action}`),
      current.action === 'close' ? 'The ticket could not be closed.' : 'The ticket could not be reopened.',
      result => current.action === 'close' ? result.warning ?? `Ticket #${current.ticket.number} closed; transcript saved.` : `Ticket #${current.ticket.number} reopened.`)
      .then(async () => { setPending(null); await queryClient.invalidateQueries({ queryKey: adminToolsKeys.feature('tickets', 'list') }); });
  };
  return <section aria-label="Tickets" className="flex flex-col gap-3">
    <header className="flex items-center gap-2">
      <h3 className="flex-1 text-[13px] font-semibold text-fg">Tickets</h3>
      <SegmentedControl label="Ticket status" value={filter} onChange={setFilter}
        options={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: 'deleted', label: 'Deleted' }, { value: 'all', label: 'All' }]} />
    </header>
    {action.error && <p role="alert" className="text-xs text-danger">{action.error}</p>}
    {action.note && <p role="status" className="text-xs text-fg">{action.note}</p>}
    {list.error ? <p role="alert" className="text-xs text-danger">{describeError(list.error, 'Tickets could not be loaded.')}</p>
      : !list.data ? <p role="status" className="text-xs text-fg-muted">Loading tickets…</p>
      : tickets.length === 0 ? <EmptyState icon={<Ticket />} compact title="No tickets here" />
      : <ul className="flex flex-col gap-2">
        {tickets.map(ticket => {
          const reopenable = ticket.status === 'closed' && (ticket.reopenableUntilMs ?? 0) > now;
          return <li key={ticket.id} aria-label={`Ticket #${ticket.number}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3 text-xs">
            <b className="text-[13px] font-medium text-fg">#{ticket.number}</b>
            <span className="text-fg-muted">{ticket.name}</span>
            <Badge tone={STATUS[ticket.status].tone}>{STATUS[ticket.status].label}</Badge>
            <span className="flex-1 text-fg-subtle">opened {time(ticket.createdAtMs)}{ticket.closedAtMs ? ` · closed ${time(ticket.closedAtMs)}` : ''} · {ticket.messageCount} saved messages</span>
            <Button size="sm" variant="ghost" onClick={() => setViewing(ticket)}>Transcript</Button>
            {canModerate && ticket.status === 'open' && <Button size="sm" variant="secondary" onClick={() => { action.clear(); setPending({ ticket, action: 'close' }); }}>Close</Button>}
            {canModerate && reopenable && <Button size="sm" variant="secondary" onClick={() => { action.clear(); setPending({ ticket, action: 'reopen' }); }}>Reopen</Button>}
          </li>;
        })}
      </ul>}
    {list.hasNextPage && <span><Button size="sm" variant="ghost" loading={list.isFetchingNextPage}
      onClick={() => { void list.fetchNextPage(); }}>Older tickets</Button></span>}
    {viewingId && <TranscriptDialog ticketId={viewingId} {...(tickets.find(item => item.id === viewingId) ? { ticket: tickets.find(item => item.id === viewingId)! } : {})}
      onClose={() => setViewing(null)} />}
    <ConfirmDialog open={pending !== null} pending={action.pending} danger={pending?.action === 'close'}
      title={pending?.action === 'close' ? `Close ticket #${pending.ticket.number} (${pending.ticket.name})?` : `Reopen ticket #${pending?.ticket.number} (${pending?.ticket.name})?`}
      description={pending?.action === 'close' ? 'The transcript is saved and the ticket channel is deleted in Discord. You can reopen it for 24 hours from this page.'
        : 'A new private channel is created for the member with the last messages of the transcript.'}
      confirmLabel={pending?.action === 'close' ? 'Close ticket' : 'Reopen'} onCancel={() => setPending(null)} onConfirm={confirm} />
  </section>;
}

export function TicketsTab() {
  return <div className="flex flex-col gap-4">
    <TicketSettings />
    <TicketList />
  </div>;
}
