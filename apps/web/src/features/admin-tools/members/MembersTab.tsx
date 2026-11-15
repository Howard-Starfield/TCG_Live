// Members tab: debounced prefix search (or an exact Discord ID) and a profile panel with roles, dates,
// timeout/ban state, mod actions, cases, private notes and tournament history.
import type { MemberProfileDto, MemberSummaryDto, ModAction, ModActionResultDto } from '@tcg-live/core';
import { Search, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Button, EmptyState, Input, Textarea } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useGuildMeta } from '../api';
import { useAdminToolsNavigation } from '../navigation';
import { useCanModerate, useDebouncedValue, useMemberProfile, useMemberSearch, useNoteMutations } from './api';
import { ACTION_LABEL, ModActionDialog, type ModTarget } from './ModActionDialog';

export const formatDate = (ms: number | null) => ms === null ? '—' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export const formatDateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const nameOf = (member: Pick<MemberSummaryDto, 'displayName' | 'username'>) => member.displayName ?? member.username;

function MemberFlags({ member, now }: { member: MemberSummaryDto; now: number }) {
  const { flags } = member;
  return <span className="flex flex-wrap gap-1">
    {flags.banned && <Badge tone="danger">Banned</Badge>}
    {flags.timedOutUntilMs !== null && flags.timedOutUntilMs > now && <Badge tone="warning">Timed out</Badge>}
    {flags.left && !flags.banned && <Badge tone="neutral">Not in server</Badge>}
    {flags.newAccount && <Badge tone="warning">New account</Badge>}
    {flags.bot && <Badge tone="neutral">Bot</Badge>}
    {member.caseCount > 0 && <Badge tone="neutral">{member.caseCount} case{member.caseCount === 1 ? '' : 's'}</Badge>}
  </span>;
}

export function MembersTab({ initialMemberId = null }: { initialMemberId?: string | null }) {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query);
  const search = useMemberSearch(debounced);
  const navigation = useAdminToolsNavigation();
  const [selected, setSelectedState] = useState<string | null>(initialMemberId ?? navigation.memberId);
  // Remembered by the page, so switching tabs (or Logs -> profile) keeps the open profile.
  const setSelected = (id: string) => { setSelectedState(id); navigation.setMemberId(id); };
  const now = Date.now();
  return <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
    <section aria-label="Member search" className="flex flex-col gap-2">
      <label className="relative flex items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2 size-3.5 text-fg-subtle" />
        <Input aria-label="Search members" maxLength={100} placeholder="Name prefix or Discord ID" value={query} className="pl-7"
          onChange={event => setQuery(event.target.value)} />
      </label>
      {!debounced.trim() ? <p className="text-xs text-fg-muted">Type the start of a username or nickname, or paste a Discord ID.</p>
        : search.error ? <p role="alert" className="text-xs text-danger">{describeError(search.error, 'Search failed.')}</p>
        : !search.data ? <p role="status" className="text-xs text-fg-muted">Searching…</p>
        : search.data.members.length === 0 ? <p className="text-xs text-fg-muted">No members match.</p>
        : <ul aria-label="Search results" className="flex flex-col gap-1">
          {search.data.members.map(member => <li key={member.id}>
            <button type="button" onClick={() => setSelected(member.id)} aria-current={selected === member.id || undefined}
              className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-line-faint aria-[current]:bg-line-faint">
              <Avatar src={member.avatarUrl} name={nameOf(member)} size="sm" decorative />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{nameOf(member)}</span>
                <span className="block truncate text-xs text-fg-subtle">@{member.username}</span>
              </span>
              <MemberFlags member={member} now={now} />
            </button>
          </li>)}
          {search.data.truncated && <li className="text-xs text-fg-subtle">More members match; keep typing to narrow it down.</li>}
        </ul>}
    </section>
    {selected ? <MemberProfilePanel memberId={selected} /> : <EmptyState icon={<UserRound />} title="No member selected"
      description="Search for a member to see their roles, cases, notes and tournaments." />}
  </div>;
}

export function MemberProfilePanel({ memberId }: { memberId: string }) {
  const profile = useMemberProfile(memberId);
  if (profile.error) return <p role="alert" className="text-xs text-danger">{describeError(profile.error, 'Member could not be loaded.')}</p>;
  if (!profile.data) return <p role="status" className="text-xs text-fg-muted">Loading member…</p>;
  return <MemberProfileView profile={profile.data} />;
}

function MemberProfileView({ profile }: { profile: MemberProfileDto }) {
  const canModerate = useCanModerate();
  const meta = useGuildMeta();
  const [action, setAction] = useState<ModAction | null>(null);
  const [result, setResult] = useState<ModActionResultDto | null>(null);
  const now = Date.now();
  const timedOut = profile.flags.timedOutUntilMs !== null && profile.flags.timedOutUntilMs > now;
  const target: ModTarget = { id: profile.id, name: nameOf(profile) };
  const actions: ModAction[] = profile.flags.banned ? ['unban']
    : [...(profile.flags.left ? [] : ['warn', timedOut ? 'untimeout' : 'timeout', 'kick'] as ModAction[]), 'ban'];
  const roles = (meta.data?.roles ?? []).filter(role => profile.roleIds.includes(role.id));
  return <section aria-label={`Member ${nameOf(profile)}`} className="flex min-w-0 flex-col gap-4 rounded-lg border border-line p-4">
    <header className="flex items-start gap-3">
      <Avatar src={profile.avatarUrl} name={nameOf(profile)} size="lg" decorative />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold text-fg">{nameOf(profile)}</h3>
        <p className="truncate text-xs text-fg-subtle">@{profile.username} · <span className="font-mono">{profile.id}</span></p>
        <div className="mt-1"><MemberFlags member={profile} now={now} /></div>
      </div>
    </header>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
      <div><dt className="text-fg-subtle">Joined</dt><dd className="text-fg">{formatDate(profile.joinedAtMs)}</dd></div>
      <div><dt className="text-fg-subtle">Account created</dt><dd className="text-fg">{formatDate(profile.accountCreatedAtMs)}</dd></div>
      <div><dt className="text-fg-subtle">Timeout</dt><dd className="text-fg">{timedOut ? `Until ${formatDateTime(profile.flags.timedOutUntilMs!)}` : 'None'}</dd></div>
      <div><dt className="text-fg-subtle">Ban</dt><dd className="text-fg">{profile.flags.banned ? 'Banned' : 'Not banned'}</dd></div>
    </dl>
    {roles.length > 0 && <ul aria-label="Roles" className="flex flex-wrap gap-1">
      {roles.map(role => <li key={role.id}><Badge tone="neutral">{role.name}</Badge></li>)}
    </ul>}
    {canModerate && <div className="flex flex-wrap gap-2" aria-label="Moderation actions" role="group">
      {actions.map(item => <Button key={item} size="sm" variant={item === 'ban' || item === 'kick' ? 'danger' : 'secondary'}
        onClick={() => { setResult(null); setAction(item); }}>{ACTION_LABEL[item]}</Button>)}
    </div>}
    {result && <p role="status" className="text-xs text-fg-muted">Case #{result.case.number} saved.{' '}
      {result.dm === 'failed' ? 'The member could not be messaged (DMs closed).' : result.dm === 'sent' ? 'The member was messaged.' : ''}</p>}
    <ModActionDialog target={action ? target : null} action={action} onClose={() => setAction(null)} onDone={setResult} />

    <section aria-label="Cases" className="flex flex-col gap-1">
      <h4 className="text-[13px] font-semibold text-fg">Cases</h4>
      {profile.cases.length === 0 ? <p className="text-xs text-fg-muted">No cases.</p> : <ul className="flex flex-col gap-1 text-xs">
        {profile.cases.map(item => <li key={item.number} className="flex gap-2">
          <span className="font-mono text-fg-subtle">#{item.number}</span><Badge tone="neutral">{item.kind}</Badge>
          <span className="min-w-0 flex-1 truncate text-fg">{item.reason}</span>
          <span className="text-fg-subtle">{formatDate(item.createdAtMs)}</span>
        </li>)}
      </ul>}
    </section>
    <NotesSection profile={profile} canEdit={canModerate} />
    <section aria-label="Tournaments" className="flex flex-col gap-1">
      <h4 className="text-[13px] font-semibold text-fg">Tournaments</h4>
      {profile.tournaments.length === 0 ? <p className="text-xs text-fg-muted">No recent tournaments.</p> : <ul className="flex flex-col gap-1 text-xs">
        {profile.tournaments.map(ref => <li key={ref.eventId} className="flex gap-2">
          <span className="min-w-0 flex-1 truncate text-fg">{ref.name ?? `Tournament ${formatDate(ref.createdAtMs)}`}</span>
          <Badge tone="neutral">{ref.role}</Badge><Badge tone={ref.status === 'active' ? 'success' : 'neutral'}>{ref.status}</Badge>
        </li>)}
      </ul>}
    </section>
  </section>;
}

function NotesSection({ profile, canEdit }: { profile: MemberProfileDto; canEdit: boolean }) {
  const notes = useNoteMutations();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const error = notes.add.error ?? notes.update.error ?? notes.remove.error;
  return <section aria-label="Notes" className="flex flex-col gap-2">
    <h4 className="text-[13px] font-semibold text-fg">Private notes</h4>
    {profile.notes.length === 0 && <p className="text-xs text-fg-muted">No notes. Notes are only visible to staff.</p>}
    <ul className="flex flex-col gap-2">
      {profile.notes.map(note => <li key={note.id} className="rounded-md bg-line-faint p-2 text-xs">
        {editing?.id === note.id ? <div className="flex flex-col gap-1">
          <Textarea aria-label="Edit note" rows={2} value={editing.body} onChange={event => setEditing({ id: note.id, body: event.target.value })} />
          <span className="flex gap-1">
            <Button size="sm" variant="primary" disabled={!editing.body.trim()} loading={notes.update.isPending}
              onClick={() => notes.update.mutate({ id: note.id, body: editing.body.trim() }, { onSuccess: () => setEditing(null) })}>Save note</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          </span>
        </div> : <>
          <p className="whitespace-pre-wrap text-fg">{note.body}</p>
          <p className="mt-1 flex items-center gap-2 text-fg-subtle">{formatDateTime(note.updatedAtMs)} · {note.authorId}
            {canEdit && <><Button size="sm" variant="ghost" onClick={() => setEditing({ id: note.id, body: note.body })}>Edit</Button>
              <Button size="sm" variant="ghost" loading={notes.remove.isPending && notes.remove.variables === note.id}
                disabled={notes.remove.isPending} onClick={() => notes.remove.mutate(note.id)}>Delete</Button></>}</p>
        </>}
      </li>)}
    </ul>
    {canEdit && <form className="flex flex-col gap-1" onSubmit={event => {
      event.preventDefault();
      if (draft.trim()) notes.add.mutate({ targetId: profile.id, body: draft.trim() }, { onSuccess: () => setDraft('') });
    }}>
      <Textarea aria-label="New note" rows={2} maxLength={2000} placeholder="Add a private note" value={draft} onChange={event => setDraft(event.target.value)} />
      <span><Button type="submit" size="sm" disabled={!draft.trim()} loading={notes.add.isPending}>Add note</Button></span>
    </form>}
    {error && <p role="alert" className="text-xs text-danger">{describeError(error, 'The note could not be saved.')}</p>}
  </section>;
}
