// Stickies tab: messages the bot keeps at the bottom of a channel (text or a simple embed), with the running
// bot's status (posted, waiting, missing permissions...). Reserved tournament channels cannot be picked.
import { ADMIN_TOOLS_LIMITS as L, type EmbedDto, type SaveStickyRequestDto } from '@tcg-live/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pin, Plus } from 'lucide-react';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, Switch, Textarea, type Tone } from '../../../ui';
import { describeError, retryTransient } from '../../evidence/api';
import { adminToolsKeys, useAdminToolsAccess, useAdminToolsCapability, useGuildMeta } from '../api';
import { useAction } from '../channels/useAction';
import { ChannelSelect } from '../shared/ChannelSelect';
import type { StickyListDto, StickyListItemDto, StickyRuntimeState } from './types';

const STATE: Record<StickyRuntimeState, { label: string; tone: Tone }> = {
  posted: { label: 'At the bottom', tone: 'success' },
  waiting: { label: 'Re-posting soon', tone: 'accent' },
  'missing-permissions': { label: 'Missing permissions', tone: 'danger' },
  'channel-missing': { label: 'Channel missing', tone: 'danger' },
  reserved: { label: 'Paused (tournament channel)', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  disabled: { label: 'Off', tone: 'neutral' }
};

export const stickiesKey = () => adminToolsKeys.feature('stickies');

interface Draft { id: string | null; channelId: string | null; enabled: boolean; delaySeconds: string; content: string;
  useEmbed: boolean; title: string; description: string; color: string;
  /** The saved embed, so fields this editor does not show (footer, images, fields) survive a save. */
  baseEmbed?: EmbedDto | null }

const emptyDraft = (): Draft => ({ id: null, channelId: null, enabled: true, delaySeconds: '15', content: '', useEmbed: false, title: '', description: '',
  color: '', baseEmbed: null });
const draftOf = (sticky: StickyListItemDto): Draft => ({ id: sticky.id, channelId: sticky.channelId, enabled: sticky.enabled, baseEmbed: sticky.embed,
  delaySeconds: String(Math.round(sticky.debounceMs / 1000)), content: sticky.content ?? '', useEmbed: sticky.embed !== null,
  title: sticky.embed?.title ?? '', description: sticky.embed?.description ?? '',
  color: sticky.embed?.color == null ? '' : `#${sticky.embed.color.toString(16).padStart(6, '0')}` });

/** Client-side checks mirror the server's; the server stays the authority. */
export function stickyRequest(draft: Draft): { request: SaveStickyRequestDto } | { error: string } {
  if (!draft.channelId) return { error: 'Choose a channel.' };
  const seconds = Number(draft.delaySeconds);
  if (!Number.isInteger(seconds) || seconds * 1000 < L.stickyDebounceMsMin || seconds * 1000 > L.stickyDebounceMsMax)
    return { error: `The re-post delay must be ${L.stickyDebounceMsMin / 1000}-${L.stickyDebounceMsMax / 1000} seconds.` };
  let embed: EmbedDto | null = null;
  if (draft.useEmbed) {
    const color = draft.color.trim();
    if (color && !/^#?[0-9a-f]{6}$/i.test(color)) return { error: 'Colour must look like #3b82f6.' };
    if (!draft.title.trim() && !draft.description.trim() && !draft.baseEmbed?.fields.length && !draft.baseEmbed?.imageUrl)
      return { error: 'The embed needs a title or a description.' };
    const base = draft.baseEmbed;
    embed = { title: draft.title.trim() || null, description: draft.description.trim() || null, color: color ? parseInt(color.replace('#', ''), 16) : null,
      url: base?.url ?? null, imageUrl: base?.imageUrl ?? null, thumbnailUrl: base?.thumbnailUrl ?? null, footer: base?.footer ?? null,
      fields: base ? structuredClone(base.fields) : [] };
  }
  const content = draft.content.trim() || null;
  if (!content && !embed) return { error: 'Write a message or add an embed.' };
  return { request: { channelId: draft.channelId, enabled: draft.enabled, debounceMs: seconds * 1000, content, embed } };
}

function StickyEditor({ initial, onDone }: { initial: Draft; onDone(): void }) {
  const { api } = useAdminData();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const action = useAction();
  const [local, setLocal] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setLocal(null); };
  const save = async () => {
    const built = stickyRequest(draft);
    if ('error' in built) { setLocal(built.error); return; }
    const saved = await action.run(() => draft.id
      ? api.request('PUT', `/admin-tools/stickies/${draft.id}`, { body: built.request })
      : api.request('POST', '/admin-tools/stickies', { body: built.request }), 'The sticky could not be saved.');
    if (saved) { await queryClient.invalidateQueries({ queryKey: stickiesKey() }); onDone(); }
  };
  return <form aria-label={draft.id ? 'Edit sticky' : 'New sticky'} className="flex flex-col gap-3 rounded-lg border border-line p-4"
    onSubmit={event => { event.preventDefault(); void save(); }}>
    <Field label="Channel" description="Tournament channels (signup, match rooms) and the ticket support channel cannot hold a sticky.">
      <ChannelSelect value={draft.channelId} allowReserved={false} placeholder="Choose a channel" onChange={channelId => set({ channelId })} />
    </Field>
    <Field label="Message text" description={`Up to ${L.messageContentLength} characters. Mentions never ping.`}>
      <Textarea rows={3} value={draft.content} maxLength={L.messageContentLength} onChange={event => set({ content: event.target.value })} />
    </Field>
    <Field label="Add an embed" inline><Switch checked={draft.useEmbed} onCheckedChange={useEmbed => set({ useEmbed })} /></Field>
    {draft.useEmbed && <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
      <Field label="Embed title"><Input value={draft.title} maxLength={L.embedTitleLength} onChange={event => set({ title: event.target.value })} /></Field>
      <Field label="Colour"><Input value={draft.color} placeholder="#3b82f6" onChange={event => set({ color: event.target.value })} /></Field>
      <Field label="Embed text" className="sm:col-span-2">
        <Textarea rows={3} value={draft.description} maxLength={L.embedDescriptionLength} onChange={event => set({ description: event.target.value })} />
      </Field>
    </div>}
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Re-post delay (seconds)" description="The sticky is re-posted at most this often, after the channel goes quiet.">
        <Input type="number" min={L.stickyDebounceMsMin / 1000} max={L.stickyDebounceMsMax / 1000} value={draft.delaySeconds}
          onChange={event => set({ delaySeconds: event.target.value })} />
      </Field>
      <Field label="Enabled" inline><Switch checked={draft.enabled} onCheckedChange={enabled => set({ enabled })} /></Field>
    </div>
    {(local ?? action.error) && <p role="alert" className="text-xs text-danger">{local ?? action.error}</p>}
    <footer className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={action.pending}>Cancel</Button>
      <Button type="submit" variant="primary" size="sm" loading={action.pending}>Save sticky</Button>
    </footer>
  </form>;
}

export function StickiesTab() {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  const canEdit = useAdminToolsCapability('server.manage');
  const queryClient = useQueryClient();
  const meta = useGuildMeta();
  const list = useQuery({ queryKey: stickiesKey(), enabled: access, retry: retryTransient, refetchInterval: 30_000,
    queryFn: ({ signal }) => api.request<StickyListDto>('GET', '/admin-tools/stickies', { signal }) });
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<StickyListItemDto | null>(null);
  const remove = useAction();
  const channelName = (id: string) => meta.data?.channels.find(channel => channel.id === id)?.name ?? id;

  if (list.error) return <p role="alert" className="text-xs text-danger">{describeError(list.error, 'Stickies could not be loaded.')}</p>;
  if (!list.data) return <p role="status" className="text-xs text-fg-muted">Loading stickies…</p>;
  const stickies = list.data.stickies;
  return <div className="flex flex-col gap-3">
    <header className="flex items-center gap-2">
      <p className="flex-1 text-xs text-fg-muted">The bot re-posts each sticky at the bottom of its channel and deletes the previous copy. It needs Send Messages,
        Embed Links and Manage Messages there.</p>
      {canEdit && !editing && <Button size="sm" variant="primary" onClick={() => setEditing(emptyDraft())}><Plus aria-hidden className="size-3.5" />New sticky</Button>}
    </header>
    {editing && <StickyEditor key={editing.id ?? 'new'} initial={editing} onDone={() => setEditing(null)} />}
    {remove.error && <p role="alert" className="text-xs text-danger">{remove.error}</p>}
    {stickies.length === 0 && !editing ? <EmptyState icon={<Pin />} title="No sticky messages" description="Add one to keep rules or how-to-report notes visible." />
      : <ul className="flex flex-col gap-2" aria-label="Sticky messages">
        {stickies.map(sticky => {
          const state = sticky.status ? STATE[sticky.status.state] : { label: 'Waiting for the bot', tone: 'neutral' as Tone };
          return <li key={sticky.id} className="flex flex-col gap-1 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              <b className="flex-1 text-[13px] font-medium text-fg">#{channelName(sticky.channelId)}</b>
              <Badge tone={state.tone}>{state.label}</Badge>
              {canEdit && <>
                <Button size="sm" variant="ghost" onClick={() => setEditing(draftOf(sticky))}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(sticky)}>Delete</Button>
              </>}
            </div>
            <p className="line-clamp-2 text-xs text-fg-muted">{sticky.content ?? sticky.embed?.title ?? sticky.embed?.description}</p>
            {sticky.status?.message && <p className="text-xs text-danger">{sticky.status.message}</p>}
            <p className="text-[11px] text-fg-subtle">Re-posted at most every {Math.round(sticky.debounceMs / 1000)} s</p>
          </li>;
        })}
      </ul>}
    <ConfirmDialog open={deleting !== null} danger title={deleting ? `Delete the sticky in #${channelName(deleting.channelId)}?` : ''}
      confirmLabel="Delete sticky" pending={remove.pending}
      description="The bot removes its posted copy from the channel and stops re-posting it. This cannot be undone."
      onCancel={() => setDeleting(null)}
      onConfirm={() => {
        const target = deleting;
        if (!target) return;
        void remove.run(() => api.request('DELETE', `/admin-tools/stickies/${target.id}`), 'The sticky could not be deleted.').then(async done => {
          setDeleting(null);
          if (done) await queryClient.invalidateQueries({ queryKey: stickiesKey() });
        });
      }} />
  </div>;
}
