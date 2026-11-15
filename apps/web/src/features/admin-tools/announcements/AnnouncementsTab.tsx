// Announcements tab: compose an embed with a live Discord-like preview, choose mentions explicitly
// (none by default), send now, schedule or save a draft; edit/delete sent ones from the history.
import { ADMIN_TOOLS_LIMITS as L, type AnnouncementStatus, type MessageBodyDto } from '@tcg-live/core';
import { CalendarClock, Megaphone, Pencil, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useServerClock } from '../../../data';
import { Badge, Button, ConfirmDialog, EmptyState, Field, Switch, Textarea, Input, type Tone } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useAdminToolsCapability, useGuildMeta } from '../api';
import { ChannelSelect } from '../shared/ChannelSelect';
import { useAnnouncementMutations, useAnnouncements, type AnnouncementView, type SaveAnnouncementBody } from './api';
import { DiscordPreview } from './DiscordPreview';
import { EmbedEditor } from './EmbedEditor';
import { bodyProblems, emptyEmbed, normalizeBody } from './embed';

export interface AnnouncementDraft {
  id: string | null; status: AnnouncementStatus | null; channelId: string | null; body: MessageBodyDto;
  mentionRoleIds: string[]; mentionEveryone: boolean; when: 'now' | 'schedule'; scheduledAt: string;
}
export const newDraft = (): AnnouncementDraft => ({ id: null, status: null, channelId: null, body: { content: null, embed: emptyEmbed() },
  mentionRoleIds: [], mentionEveryone: false, when: 'now', scheduledAt: '' });

const pad = (n: number) => String(n).padStart(2, '0');
/** Local yyyy-mm-ddThh:mm for <input type="datetime-local">. */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const fromView = (item: AnnouncementView): AnnouncementDraft => ({ id: item.id, status: item.status, channelId: item.channelId,
  body: structuredClone(item.body), mentionRoleIds: [...item.mentionRoleIds], mentionEveryone: item.mentionEveryone,
  when: item.scheduledAtMs && item.status !== 'sent' ? 'schedule' : 'now', scheduledAt: item.scheduledAtMs ? toLocalInput(item.scheduledAtMs) : '' });

const STATUS: Record<AnnouncementStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' }, scheduled: { label: 'Scheduled', tone: 'accent' },
  sent: { label: 'Sent', tone: 'success' }, failed: { label: 'Failed', tone: 'danger' }
};
const when = (ms: number | null) => ms === null ? '' : new Date(ms).toLocaleString();
/** datetime-local is the browser's local time; NaN when empty or invalid. */
export const fromLocalInput = (value: string): number => value ? new Date(value).getTime() : Number.NaN;
const TIME_ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();

/** Who gets pinged, in words, for the confirm step. */
export function pingSummary(mentionEveryone: boolean, roleNames: readonly string[]): string {
  const targets = [...(mentionEveryone ? ['@everyone (every member of the server)'] : []), ...roleNames.map(name => `@${name}`)];
  return targets.length ? `Pings ${targets.join(', ')}.` : 'Nobody is pinged.';
}

type SubmitMode = 'send' | 'schedule' | 'draft';

export function AnnouncementComposer({ draft, onChange, onDone, canEdit }: {
  draft: AnnouncementDraft; onChange(next: AnnouncementDraft): void; onDone(): void; canEdit: boolean;
}) {
  const meta = useGuildMeta();
  // The server checks the schedule against its own clock, so compare with server time.
  const clock = useServerClock();
  const { save } = useAnnouncementMutations();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Exclude<SubmitMode, 'draft'> | null>(null);
  const roles = (meta.data?.roles ?? []).filter(role => role.id !== meta.data?.guildId);
  const sent = draft.status === 'sent';
  // Same count as the server: "@everyone <@&id> ..." joined by spaces, plus one space before the text.
  const prefix = [...(draft.mentionEveryone ? ['@everyone'] : []), ...draft.mentionRoleIds.map(id => `<@&${id}>`)].join(' ');
  const mentionLength = prefix.length + (prefix && draft.body.content?.trim() ? 1 : 0);
  const scheduledAtMs = fromLocalInput(draft.scheduledAt);
  const problems = [...bodyProblems(normalizeBody(draft.body), mentionLength),
    ...(!draft.channelId ? ['Choose a channel.'] : []),
    ...(draft.when === 'schedule' && !sent && !(scheduledAtMs > clock.now()) ? ['Choose a time in the future.'] : [])];
  const channelLabel = (id: string | null) => { const channel = meta.data?.channels.find(item => item.id === id); return channel ? `#${channel.name}` : 'the channel'; };
  const roleNames = draft.mentionRoleIds.map(id => roles.find(role => role.id === id)?.name ?? id);
  const submit = async (mode: SubmitMode) => {
    if (save.isPending) return;
    setError(null);
    const body: SaveAnnouncementBody = { channelId: draft.channelId!, body: normalizeBody(draft.body), mentionRoleIds: draft.mentionRoleIds,
      mentionEveryone: draft.mentionEveryone,
      scheduledAtMs: (mode === 'schedule' || (mode === 'draft' && draft.when === 'schedule')) && Number.isFinite(scheduledAtMs) ? scheduledAtMs : null,
      ...(mode === 'draft' ? { draft: true } : {}) };
    try { await save.mutateAsync({ id: draft.id, body }); setConfirming(null); onDone(); }
    catch (cause) { setError(describeError(cause, 'The announcement could not be saved.')); }
  };
  const set = (patch: Partial<AnnouncementDraft>) => onChange({ ...draft, ...patch });
  return <section aria-label="Compose announcement" className="grid gap-4 rounded-lg border border-line p-4 xl:grid-cols-2">
    <div className="flex flex-col gap-3">
      <h3 className="text-[13px] font-semibold text-fg">{draft.id ? sent ? 'Edit sent announcement' : 'Edit announcement' : 'New announcement'}</h3>
      <Field label="Channel" description={sent ? 'A sent announcement stays in its channel.' : undefined}>
        <ChannelSelect value={draft.channelId} disabled={!canEdit || sent} placeholder="Choose a channel" onChange={channelId => set({ channelId })} />
      </Field>
      <Field label="Text" description={`Optional, above the embed. ${[...(draft.body.content ?? '')].length}/${L.messageContentLength}`}>
        <Textarea rows={2} value={draft.body.content ?? ''} disabled={!canEdit}
          onChange={event => set({ body: { ...draft.body, content: event.target.value || null } })} />
      </Field>
      <Field label="Include embed" inline>
        <Switch checked={draft.body.embed !== null} disabled={!canEdit}
          onCheckedChange={on => set({ body: { ...draft.body, embed: on ? emptyEmbed() : null } })} />
      </Field>
      {draft.body.embed && <EmbedEditor value={draft.body.embed} disabled={!canEdit} onChange={embed => set({ body: { ...draft.body, embed } })} />}
      <fieldset className="flex flex-col gap-2" disabled={!canEdit}>
        <legend className="text-[13px] font-medium text-fg">Mentions</legend>
        <p className="text-xs text-fg-subtle">Nobody is pinged unless you choose it here. Mentions typed in the text never ping.</p>
        <div className="flex flex-wrap gap-2">
          {roles.map(role => <label key={role.id} className="flex items-center gap-1 text-xs text-fg">
            <input type="checkbox" checked={draft.mentionRoleIds.includes(role.id)}
              disabled={!draft.mentionRoleIds.includes(role.id) && draft.mentionRoleIds.length >= L.announcementMentionRoles}
              onChange={event => set({ mentionRoleIds: event.target.checked ? [...draft.mentionRoleIds, role.id]
                : draft.mentionRoleIds.filter(id => id !== role.id) })} />@{role.name}
          </label>)}
        </div>
        <Field label="Ping @everyone" inline description="Notifies every member of the server. Off by default.">
          <Switch checked={draft.mentionEveryone} onCheckedChange={mentionEveryone => set({ mentionEveryone })} />
        </Field>
      </fieldset>
      {!sent && <Field label="Schedule for later" inline description="The bot must be running at that time; if it was off, it sends on start when less than 1 hour late, otherwise it is marked missed.">
        <Switch checked={draft.when === 'schedule'} disabled={!canEdit} onCheckedChange={on => set({ when: on ? 'schedule' : 'now' })} />
      </Field>}
      {!sent && draft.when === 'schedule' && <Field label="Send at" description={`Your local time${TIME_ZONE ? ` (${TIME_ZONE})` : ''}.`}>
        <Input type="datetime-local" value={draft.scheduledAt} min={toLocalInput(clock.now())} disabled={!canEdit}
          onChange={event => set({ scheduledAt: event.target.value })} />
      </Field>}
      {problems.length > 0 && <ul aria-label="Problems" className="list-disc pl-4 text-xs text-danger">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {canEdit && <div className="flex flex-wrap gap-2">
        {sent ? <Button variant="primary" icon={<Pencil />} loading={save.isPending} disabled={problems.length > 0}
          onClick={() => { setError(null); setConfirming('send'); }}>Update message</Button>
          : draft.when === 'schedule'
            ? <Button variant="primary" icon={<CalendarClock />} loading={save.isPending} disabled={problems.length > 0}
              onClick={() => { setError(null); setConfirming('schedule'); }}>Schedule</Button>
            : <Button variant="primary" icon={<Send />} loading={save.isPending} disabled={problems.length > 0}
              onClick={() => { setError(null); setConfirming('send'); }}>Send now</Button>}
        {!sent && <Button disabled={save.isPending || !draft.channelId} onClick={() => { void submit('draft'); }}>Save draft</Button>}
        {draft.id && <Button variant="ghost" onClick={onDone}>Cancel</Button>}
      </div>}
    </div>
    <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-fg">Preview</h3>
      <DiscordPreview content={draft.body.content} embed={draft.body.embed} mentionRoleIds={draft.mentionRoleIds}
        mentionEveryone={draft.mentionEveryone} roles={roles} />
    </div>
    <ConfirmDialog open={confirming !== null} danger={draft.mentionEveryone} pending={save.isPending} onCancel={() => setConfirming(null)}
      onConfirm={() => { if (confirming) void submit(confirming); }}
      confirmLabel={sent ? 'Update message' : confirming === 'schedule' ? 'Schedule' : 'Send now'}
      title={sent ? `Update the sent announcement in ${channelLabel(draft.channelId)}?`
        : confirming === 'schedule' ? `Schedule for ${when(scheduledAtMs)} in ${channelLabel(draft.channelId)}?`
        : `Send now to ${channelLabel(draft.channelId)}?`}
      description={sent ? 'The posted message is edited in place; editing does not ping anyone again.'
        : `${pingSummary(draft.mentionEveryone, roleNames)}${confirming === 'schedule' ? ' The bot must be running at that time.' : ' This posts immediately.'}`}>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </ConfirmDialog>
  </section>;
}

export function AnnouncementsTab() {
  const canEdit = useAdminToolsCapability('server.manage');
  const list = useAnnouncements();
  const { send, remove } = useAnnouncementMutations();
  const [draft, setDraft] = useState<AnnouncementDraft>(newDraft);
  const [deleting, setDeleting] = useState<AnnouncementView | null>(null);
  const [sending, setSending] = useState<AnnouncementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = useGuildMeta();
  const items = list.data?.announcements ?? [];
  const channelLabel = (id: string) => { const channel = meta.data?.channels.find(item => item.id === id); return channel ? `#${channel.name}` : 'its channel'; };
  const roleName = (id: string) => meta.data?.roles.find(role => role.id === id)?.name ?? id;
  const titleOf = (item: AnnouncementView) => item.body.embed?.title ?? item.body.content?.slice(0, 60) ?? 'Announcement';
  return <div className="flex flex-col gap-4">
    <AnnouncementComposer key={draft.id ?? 'new'} draft={draft} onChange={setDraft} onDone={() => setDraft(newDraft())} canEdit={canEdit} />
    <section aria-label="Announcement history" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-fg">History</h3>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {list.error ? <p role="alert" className="text-xs text-danger">{describeError(list.error, 'Announcements could not be loaded.')}</p>
        : list.isPending ? <p role="status" className="text-xs text-fg-muted">Loading announcements…</p>
        : items.length === 0 ? <EmptyState icon={<Megaphone />} title="No announcements yet" description="Sent, scheduled and draft announcements appear here." />
        : <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {items.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2 p-3 text-xs">
            <Badge tone={STATUS[item.status].tone}>{item.missed ? 'Missed' : STATUS[item.status].label}</Badge>
            <span className="min-w-0 flex-1 truncate text-fg">{item.body.embed?.title ?? item.body.content ?? 'Announcement'}</span>
            <span className="text-fg-subtle">{item.status === 'sent' ? `Sent ${when(item.sentAtMs)}` : item.scheduledAtMs ? `For ${when(item.scheduledAtMs)}` : ''}</span>
            {item.error && <span className="w-full text-danger">{item.error}</span>}
            {canEdit && <span className="flex gap-1">
              <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setDraft(fromView(item))}>Edit</Button>
              {item.status !== 'sent' && <Button size="sm" variant="ghost" icon={<Send />} loading={send.isPending && send.variables === item.id}
                disabled={send.isPending} onClick={() => { setError(null); send.reset(); setSending(item); }}>Send now</Button>}
              <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(item)}>Delete</Button>
            </span>}
          </li>)}
        </ul>}
    </section>
    <ConfirmDialog open={sending !== null} danger={!!sending?.mentionEveryone} pending={send.isPending} confirmLabel="Send now"
      title={sending ? `Send "${titleOf(sending)}" to ${channelLabel(sending.channelId)} now?` : ''}
      description={sending ? `${pingSummary(sending.mentionEveryone, sending.mentionRoleIds.map(roleName))} This posts immediately.` : ''}
      onCancel={() => setSending(null)}
      onConfirm={() => { if (sending && !send.isPending) send.mutate(sending.id, { onSuccess: () => setSending(null) }); }}>
      {send.error && <p role="alert" className="text-xs text-danger">{describeError(send.error, 'Sending failed.')}</p>}
    </ConfirmDialog>
    <ConfirmDialog open={deleting !== null} danger confirmLabel="Delete" pending={remove.isPending}
      title={deleting ? `Delete the ${deleting.status} announcement "${titleOf(deleting)}"?` : ''}
      description={deleting?.status === 'sent' ? `The message is also deleted in Discord (${channelLabel(deleting.channelId)}). This cannot be undone.`
        : 'It will not be sent. This cannot be undone.'}
      onCancel={() => setDeleting(null)}
      onConfirm={() => {
        if (!deleting) return;
        const id = deleting.id;
        remove.mutate(id, { onSuccess: () => { setDeleting(null); if (draft.id === id) setDraft(newDraft()); },
          onError: cause => { setDeleting(null); setError(describeError(cause, 'The announcement could not be deleted.')); } });
      }} />
  </div>;
}
