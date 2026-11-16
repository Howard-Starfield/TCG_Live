// Roles tab: button-role panels (editor with live preview and hierarchy warnings, post/update/repost)
// and bulk role jobs (dry-run preview, queued job with progress, cancel, per-member failures).
import { ADMIN_TOOLS_LIMITS as L, BUTTON_STYLES, type BulkRoleJobDto, type BulkRoleJobStatus, type BulkRoleTarget, type ButtonRoleButtonDto,
  type ButtonRoleMode, type MessageBodyDto } from '@tcg-live/core';
import { Plus, RefreshCw, Send, Tags, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useEvents } from '../../../data';
import { Badge, Button, ConfirmDialog, EmptyState, Field, IconButton, Input, Select, Switch, Textarea, cx, useToast, type Tone } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useAdminToolsCapability, useGuildMeta } from '../api';
import { DiscordPreview } from '../announcements/DiscordPreview';
import { EmbedEditor } from '../announcements/EmbedEditor';
import { bodyProblems, emptyEmbed, normalizeBody } from '../announcements/embed';
import { ChannelSelect, RoleSelect } from '../shared/ChannelSelect';
import { EditorDialog } from '../shared/EditorDialog';
import { HIGHLIGHT_CLASS, useHighlightNew } from '../shared/useHighlightNew';
import { parseMemberIds, rolePanelWarnings, useBulkJob, useBulkJobs, useBulkMutations, usePanelMutations, usePanels,
  type ButtonRolePanelView, type PanelMessageState } from './api';

export interface PanelDraft {
  id: string | null; channelId: string | null; body: MessageBodyDto; mode: ButtonRoleMode;
  buttons: Array<Omit<ButtonRoleButtonDto, 'roleId'> & { roleId: string | null }>; requiredRoleId: string | null; posted: boolean;
}
export const newPanelDraft = (): PanelDraft => ({ id: null, channelId: null, mode: 'toggle', requiredRoleId: null, posted: false,
  body: { content: null, embed: { ...emptyEmbed(), title: 'Pick your roles', description: 'Click a button to add or remove a role.' } },
  buttons: [{ roleId: null, label: '', emoji: null, style: 'primary' }] });
const fromPanel = (panel: ButtonRolePanelView): PanelDraft => ({ id: panel.id, channelId: panel.channelId, body: structuredClone(panel.body),
  mode: panel.mode, buttons: panel.buttons.map(button => ({ ...button })), requiredRoleId: panel.requiredRoleId,
  posted: panel.messageState === 'posted' });

const STATE: Record<PanelMessageState, { label: string; tone: Tone }> = {
  unpublished: { label: 'Not posted', tone: 'neutral' }, posted: { label: 'Posted', tone: 'success' }, missing: { label: 'Message deleted', tone: 'danger' }
};

export function PanelEditor({ draft, open, onChange, onDone }: { draft: PanelDraft; open: boolean; onChange(next: PanelDraft): void; onDone(savedId?: string): void }) {
  const meta = useGuildMeta();
  const toast = useToast();
  const [dirty, setDirty] = useState(false);
  const { save, publish } = usePanelMutations();
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<PanelDraft>) => { setDirty(true); onChange({ ...draft, ...patch }); };
  const setButton = (index: number, patch: Partial<PanelDraft['buttons'][number]>) =>
    set({ buttons: draft.buttons.map((button, at) => at === index ? { ...button, ...patch } : button) });
  const roles = meta.data?.roles ?? [];
  const chosen = draft.buttons.filter((button): button is ButtonRoleButtonDto => button.roleId !== null);
  const warnings = meta.data ? rolePanelWarnings(chosen, roles, meta.data.guildId) : [];
  const roleIds = chosen.map(button => button.roleId);
  const problems = [...bodyProblems(normalizeBody(draft.body)), ...(!draft.channelId ? ['Choose a channel.'] : []),
    ...(draft.buttons.some(button => !button.roleId || !button.label.trim()) ? ['Every button needs a role and a label.'] : []),
    ...(new Set(roleIds).size !== roleIds.length ? ['Each role can appear on only one button.'] : [])];
  const submit = async (post: boolean) => {
    setError(null);
    if (save.isPending || publish.isPending) return;
    let stage: 'save' | 'post' = 'save';
    try {
      const saved = await save.mutateAsync({ id: draft.id, body: { channelId: draft.channelId!, body: normalizeBody(draft.body), mode: draft.mode,
        buttons: chosen.map(button => ({ ...button, label: button.label.trim() })), requiredRoleId: draft.requiredRoleId } });
      stage = 'post';
      // From here on the panel exists: a retry must update it, not create a second one.
      if (!draft.id) onChange({ ...draft, id: saved.id, posted: saved.messageState === 'posted' });
      setDirty(false);
      if (post && saved.messageState !== 'posted') await publish.mutateAsync(saved.id);
      toast.show({ title: draft.id ? 'Panel updated' : 'Panel created', description: post ? undefined : 'It is not posted yet.', tone: 'success' });
      onDone(saved.id);
    } catch (cause) {
      setError(stage === 'post' ? `Saved, but not posted: ${describeError(cause, 'the panel could not be posted.')}`
        : describeError(cause, 'The panel could not be saved.'));
    }
  };
  const busy = save.isPending || publish.isPending;
  return <EditorDialog open={open} title={draft.id ? 'Edit panel' : 'New panel'} busy={busy} dirty={dirty} onClose={() => onDone(draft.id ?? undefined)}
    preview={<DiscordPreview content={draft.body.content} embed={draft.body.embed} buttons={draft.buttons} label="Panel preview" />}
    footer={<>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDone()}>Cancel</Button>
      {!draft.posted && <Button size="sm" disabled={problems.length > 0 || save.isPending} onClick={() => { void submit(false); }}>Save without posting</Button>}
      <Button variant="primary" size="sm" icon={<Send />} loading={busy} disabled={problems.length > 0}
        onClick={() => { void submit(true); }}>{draft.posted ? 'Save and update message' : 'Save and post'}</Button>
    </>}>
    <div className="flex flex-col gap-3">
      <Field label="Channel" description={draft.posted ? 'Changing the channel moves the posted message.' : undefined}>
        <ChannelSelect value={draft.channelId} placeholder="Choose a channel" onChange={channelId => set({ channelId })} />
      </Field>
      <Field label="Mode" description={draft.mode === 'toggle' ? 'Each button adds its role, or removes it when the member has it.'
        : 'Members hold at most one role of this panel: picking one removes the others.'}>
        <Select value={draft.mode} onChange={event => set({ mode: event.target.value as ButtonRoleMode })}>
          <option value="toggle">Toggle (add/remove)</option><option value="unique">Unique (only one)</option>
        </Select>
      </Field>
      <Field label="Required role" description="Only members with this role can use the panel.">
        <RoleSelect value={draft.requiredRoleId} placeholder="Anyone" allowElevated onChange={requiredRoleId => set({ requiredRoleId })} />
      </Field>
      <Field label="Text"><Textarea rows={2} value={draft.body.content ?? ''}
        onChange={event => set({ body: { ...draft.body, content: event.target.value || null } })} /></Field>
      <Field label="Include embed" inline>
        <Switch checked={draft.body.embed !== null} onCheckedChange={on => set({ body: { ...draft.body, embed: on ? emptyEmbed() : null } })} />
      </Field>
      {draft.body.embed && <EmbedEditor value={draft.body.embed} onChange={embed => set({ body: { ...draft.body, embed } })} />}
      <section aria-label="Buttons" className="flex flex-col gap-2">
        <header className="flex items-center gap-2">
          <h4 className="flex-1 text-[13px] font-medium text-fg">Buttons ({draft.buttons.length}/{L.buttonsPerPanel}, five per row)</h4>
          <Button size="sm" icon={<Plus />} disabled={draft.buttons.length >= L.buttonsPerPanel}
            onClick={() => set({ buttons: [...draft.buttons, { roleId: null, label: '', emoji: null, style: 'secondary' }] })}>Add button</Button>
        </header>
        {draft.buttons.map((button, index) => <div key={index} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[1.4fr_1fr_4rem_7rem_auto]">
          <RoleSelect value={button.roleId} onChange={roleId => setButton(index, { roleId })} />
          <Input aria-label={`Button ${index + 1} label`} placeholder="Label" maxLength={L.buttonLabelLength} value={button.label}
            onChange={event => setButton(index, { label: event.target.value })} />
          <Input aria-label={`Button ${index + 1} emoji`} placeholder="🎮" value={button.emoji ?? ''}
            onChange={event => setButton(index, { emoji: event.target.value.trim() || null })} />
          <Select aria-label={`Button ${index + 1} style`} value={button.style}
            onChange={event => setButton(index, { style: event.target.value as ButtonRoleButtonDto['style'] })}>
            {BUTTON_STYLES.map(style => <option key={style} value={style}>{style}</option>)}
          </Select>
          <IconButton aria-label={`Remove button ${index + 1}`} icon={<Trash2 />} size="sm" disabled={draft.buttons.length <= 1}
            onClick={() => set({ buttons: draft.buttons.filter((_, at) => at !== index) })} />
        </div>)}
      </section>
      {warnings.length > 0 && <ul aria-label="Role warnings" className="flex flex-col gap-1 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
        {warnings.map(warning => <li key={warning.roleId} className="flex gap-1.5"><TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{warning.message}</li>)}
      </ul>}
      {problems.length > 0 && <ul aria-label="Problems" className="list-disc pl-4 text-xs text-danger">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
  </EditorDialog>;
}

function PanelsSection({ canEdit }: { canEdit: boolean }) {
  const panels = usePanels();
  const meta = useGuildMeta();
  const { publish, remove } = usePanelMutations();
  const [draft, setDraft] = useState<PanelDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const highlight = useHighlightNew();
  // Remounts the editor per opening, not per id (a new panel gets its id on first save and keeps its editor).
  const [editorKey, setEditorKey] = useState(0);
  const openEditor = (next: PanelDraft) => { setEditorKey(key => key + 1); setDraft(next); setEditorOpen(true); };
  const [deleting, setDeleting] = useState<ButtonRolePanelView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const channelName = (id: string) => meta.data?.channels.find(channel => channel.id === id)?.name ?? id;
  const list = panels.data?.panels ?? [];
  return <section aria-label="Button-role panels" className="flex flex-col gap-3">
    <header className="flex items-center gap-2">
      <div className="flex-1"><h3 className="text-[13px] font-semibold text-fg">Button-role panels</h3>
        <p className="text-xs text-fg-muted">Members click a button to get or drop a role. The bot needs Manage Roles, and its role must sit above these roles.</p></div>
      {canEdit && <Button size="sm" variant="primary" icon={<Plus />} disabled={list.length >= L.buttonRolePanels}
        onClick={() => openEditor(newPanelDraft())}>New panel</Button>}
    </header>
    {draft && <PanelEditor key={editorKey} draft={draft} open={editorOpen} onChange={setDraft}
      onDone={savedId => { setEditorOpen(false); if (savedId) highlight.highlight(savedId); }} />}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {panels.error ? <p role="alert" className="text-xs text-danger">{describeError(panels.error, 'Panels could not be loaded.')}</p>
      : panels.isPending ? <p role="status" className="text-xs text-fg-muted">Loading panels…</p>
      : list.length === 0 ? <EmptyState icon={<Tags />} title="No panels yet" description="Create a panel with up to 25 role buttons." />
      : <ul className="flex flex-col gap-2">{list.map(panel => <li key={panel.id} aria-label={`Panel ${panel.body.embed?.title ?? panel.id}`} ref={highlight.ref(panel.id)}
        className={cx('flex flex-col gap-2 rounded-lg border border-line p-3 text-xs transition-shadow', highlight.isHighlighted(panel.id) && HIGHLIGHT_CLASS)}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATE[panel.messageState].tone}>{STATE[panel.messageState].label}</Badge>
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{panel.body.embed?.title ?? panel.body.content ?? 'Panel'}</span>
          <span className="text-fg-subtle">#{channelName(panel.channelId)} · {panel.mode} · {panel.buttons.length} buttons</span>
        </div>
        {panel.messageState === 'missing' && <p className="text-danger">The panel message was deleted in Discord. Repost it to bring the buttons back.</p>}
        {panel.warnings.length > 0 && <ul aria-label="Role warnings" className="flex flex-col gap-0.5 text-fg">
          {panel.warnings.map(warning => <li key={warning.roleId} className="flex gap-1.5"><TriangleAlert aria-hidden className="mr-1 size-3.5 shrink-0 text-warning" />{warning.message}</li>)}
        </ul>}
        {canEdit && <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => openEditor(fromPanel(panel))}>Edit</Button>
          {panel.messageState !== 'posted' && <Button size="sm" variant="ghost" icon={panel.messageState === 'missing' ? <RefreshCw /> : <Send />}
            loading={publish.isPending && publish.variables === panel.id}
            onClick={() => { setError(null); publish.mutate(panel.id, { onError: cause => setError(describeError(cause, 'The panel could not be posted.')) }); }}>
            {panel.messageState === 'missing' ? 'Repost' : 'Post'}</Button>}
          <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(panel)}>Delete</Button>
        </div>}
      </li>)}</ul>}
    <ConfirmDialog open={deleting !== null} danger confirmLabel="Delete panel" pending={remove.isPending}
      title={deleting ? `Delete the panel "${deleting.body.embed?.title ?? deleting.body.content ?? 'Panel'}" in #${channelName(deleting.channelId)}?` : ''}
      description={deleting?.messageState === 'posted' ? 'The posted message is deleted in Discord too. Members keep the roles they already have.'
        : 'Members keep the roles they already have.'}
      onCancel={() => setDeleting(null)}
      onConfirm={() => { if (deleting) remove.mutate(deleting.id, { onSettled: () => setDeleting(null),
        onError: cause => setError(describeError(cause, 'The panel could not be deleted.')) }); }} />
  </section>;
}

type TargetKind = BulkRoleTarget['kind'];
const TARGET_LABEL: Record<TargetKind, string> = { 'checked-in': 'Checked-in players', roster: 'Roster', 'event-players': 'Players seated in matches',
  ids: 'Pasted member IDs' };
const JOB_TONE: Record<BulkRoleJobStatus, Tone> = { queued: 'neutral', running: 'accent', done: 'success', failed: 'danger', cancelled: 'warning' };

function JobFailures({ id }: { id: string }) {
  const job = useBulkJob(id);
  if (!job.data) return <p role="status" className="text-fg-muted">Loading failures…</p>;
  if (!job.data.failures.length) return <p className="text-fg-muted">No failures.</p>;
  return <ul aria-label="Failures" className="flex flex-col gap-0.5">
    {job.data.failures.map(failure => <li key={failure.userId}><code>{failure.userId}</code>: {failure.error}</li>)}</ul>;
}

function JobRow({ job, canEdit, roleName }: { job: BulkRoleJobDto; canEdit: boolean; roleName(id: string): string }) {
  const { cancel } = useBulkMutations();
  const [open, setOpen] = useState(false);
  const processed = job.done + job.failed;
  return <li className="flex flex-col gap-1.5 p-3 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={JOB_TONE[job.status]}>{job.status}</Badge>
      <span className="flex-1 text-fg">{job.action === 'add' ? 'Add' : 'Remove'} @{roleName(job.roleId)} · {TARGET_LABEL[job.target.kind]}</span>
      <span className="text-fg-subtle">{processed}/{job.total}{job.failed ? ` · ${job.failed} failed` : ''}</span>
      {job.failed > 0 && <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? 'Hide failures' : 'Show failures'}</Button>}
      {canEdit && (job.status === 'queued' || job.status === 'running') &&
        <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(job.id)}>Cancel</Button>}
    </div>
    <div role="progressbar" aria-label="Job progress" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={processed}
      className="h-1.5 overflow-hidden rounded bg-line-faint"><div className="h-full bg-accent-fill" style={{ width: `${job.total ? (processed / job.total) * 100 : 0}%` }} /></div>
    {job.error && <p className="text-danger">{job.error}</p>}
    {open && <JobFailures id={job.id} />}
  </li>;
}

export function BulkRolesSection({ canEdit }: { canEdit: boolean }) {
  const meta = useGuildMeta();
  const events = useEvents();
  const jobs = useBulkJobs();
  const { preview, queue } = useBulkMutations();
  const [action, setAction] = useState<'add' | 'remove'>('add');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [kind, setKind] = useState<TargetKind>('checked-in');
  const [eventId, setEventId] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [reason, setReason] = useState('');
  const [previewed, setPreviewed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const parsed = parseMemberIds(pasted);
  const target: BulkRoleTarget | null = kind === 'ids' ? (parsed.ids.length ? { kind, userIds: parsed.ids } : null) : eventId ? { kind, eventId } : null;
  const formKey = JSON.stringify({ action, roleId, target });
  const ready = roleId !== null && target !== null;
  const fresh = previewed === formKey && preview.data !== undefined;
  const roleName = (id: string) => meta.data?.roles.find(role => role.id === id)?.name ?? id;
  const run = () => {
    if (!ready) return;
    setError(null);
    preview.mutate({ action, roleId: roleId!, target: target! }, { onSuccess: () => setPreviewed(formKey),
      onError: cause => setError(describeError(cause, 'The preview failed.')) });
  };
  const start = () => {
    if (!ready || !reason.trim()) return;
    setError(null);
    if (queue.isPending) return;
    queue.mutate({ action, roleId: roleId!, target: target!, reason: reason.trim() }, {
      onSuccess: () => { setConfirming(false); setPreviewed(null); setReason(''); },
      onError: cause => setError(describeError(cause, 'The job could not be queued.')) });
  };
  const jobList = jobs.data?.jobs ?? [];
  return <section aria-label="Bulk roles" className="flex flex-col gap-3">
    <header><h3 className="text-[13px] font-semibold text-fg">Bulk roles</h3>
      <p className="text-xs text-fg-muted">Give or remove a role for many members. Runs as a paced background job; it resumes after a restart.</p></header>
    {canEdit && <div className="grid gap-3 rounded-lg border border-line p-4 sm:grid-cols-2">
      <Field label="Action"><Select value={action} onChange={event => setAction(event.target.value as 'add' | 'remove')}>
        <option value="add">Add role</option><option value="remove">Remove role</option></Select></Field>
      <Field label="Role"><RoleSelect value={roleId} onChange={setRoleId} /></Field>
      <Field label="Members"><Select value={kind} onChange={event => setKind(event.target.value as TargetKind)}>
        {(Object.keys(TARGET_LABEL) as TargetKind[]).map(item => <option key={item} value={item}>{TARGET_LABEL[item]}</option>)}</Select></Field>
      {kind === 'ids' ? <Field label="Member IDs" description={`${parsed.ids.length} IDs${parsed.invalid.length ? `, ${parsed.invalid.length} ignored` : ''}. Separate with spaces, commas or new lines.`}>
        <Textarea rows={3} value={pasted} onChange={event => setPasted(event.target.value)} /></Field>
        : <Field label="Tournament"><Select value={eventId ?? ''} onChange={event => setEventId(event.target.value || null)}>
          <option value="">{events.isPending ? 'Loading tournaments…' : 'Choose a tournament'}</option>
          {(events.data ?? []).map(event => <option key={event.eventId} value={event.eventId}>
            {event.status === 'active' ? 'Active' : 'Retired'} · {new Date(event.createdAtMs).toLocaleDateString()} · {event.eventId.slice(0, 8)}</option>)}
        </Select></Field>}
      <Field label="Reason" description="Shown in Discord's audit log." className="sm:col-span-2">
        <Input value={reason} maxLength={L.reasonLength} onChange={event => setReason(event.target.value)} /></Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        {fresh && <p role="status" className="text-xs text-fg">
          Dry run: <b>{preview.data!.total}</b> member{preview.data!.total === 1 ? '' : 's'} would {action === 'add' ? 'get' : 'lose'} @{roleName(roleId!)}. Nothing changed yet.</p>}
        {fresh && preview.data!.warning && <p className="flex gap-1.5 text-xs text-danger"><TriangleAlert aria-hidden className="size-3.5" />{preview.data!.warning.message}</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex gap-2">
          <Button disabled={!ready} loading={preview.isPending} onClick={run}>Preview</Button>
          <Button variant="primary" disabled={!fresh || !preview.data!.total || !!preview.data!.warning || !reason.trim()} loading={queue.isPending}
            onClick={() => { setError(null); setConfirming(true); }}>Start job</Button>
        </div>
      </div>
    </div>}
    <ConfirmDialog open={confirming && fresh} danger={action === 'remove'} pending={queue.isPending} onCancel={() => setConfirming(false)} onConfirm={start}
      confirmLabel={action === 'add' ? 'Add role' : 'Remove role'}
      title={fresh ? `${action === 'add' ? 'Give' : 'Remove'} @${roleName(roleId!)} ${action === 'add' ? 'to' : 'from'} ${preview.data!.total} member${preview.data!.total === 1 ? '' : 's'}?` : ''}
      description={`Target: ${target ? TARGET_LABEL[target.kind] : ''}. Runs in the background and can be cancelled, but members already done keep the change. Reason: ${reason.trim()}`}>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </ConfirmDialog>
    {jobs.error ? <p role="alert" className="text-xs text-danger">{describeError(jobs.error, 'Jobs could not be loaded.')}</p>
      : jobList.length > 0 && <ul aria-label="Bulk role jobs" className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {jobList.map(job => <JobRow key={job.id} job={job} canEdit={canEdit} roleName={roleName} />)}</ul>}
  </section>;
}

export function RolesTab() {
  const canEdit = useAdminToolsCapability('server.manage');
  return <div className="flex flex-col gap-6"><PanelsSection canEdit={canEdit} /><BulkRolesSection canEdit={canEdit} /></div>;
}
