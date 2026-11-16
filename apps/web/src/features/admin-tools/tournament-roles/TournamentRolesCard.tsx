// Admin tools > Settings > Tournament roles: the two bot-managed Discord roles. Rename, colour, who holds each role, and the one-click
// creation for installs that predate them. The server owns the rules; this card shows its problem text as given.
import { DISCORD_ROLE_COLOR_PRESETS, TOURNAMENT_ROLE_DEFAULTS, type TournamentRoleDto, type TournamentRoleMemberDto,
  type TournamentRolesDto } from '@tcg-live/core';
import { Pencil, Plus, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Button, Field, IconButton, Input } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useAdminToolsCapability } from '../api';
import { useDebouncedValue, useMemberSearch } from '../members/api';
import { colorHex, parseHexColor, presetName, useTournamentRoleMutations, useTournamentRoles } from './api';

export const CREATE_ROLES_EXPLANATION = 'Until the roles exist, only the server owner and this dashboard act as organizer in Discord.';
const LEGACY_NOTE = 'Your existing tournament staff roles count as TCG Judge; give TCG Organizer to anyone who needs more.';
const STAFF_COMMAND_NOTE = '/tcg-staff is visible to everyone in Discord. The bot checks who may run each subcommand, so members without a role are refused.';
// The stored role is gone or cannot be changed by the bot: the server answers edits with a 409.
const NOT_EDITABLE: readonly (string | null)[] = ['missing', 'above-bot', 'managed', 'no-manage-roles'];
const roleLabel = (role: TournamentRoleDto) => role.name ?? TOURNAMENT_ROLE_DEFAULTS[role.kind].name;
const memberName = (member: Pick<TournamentRoleMemberDto, 'id' | 'displayName'>) => member.displayName ?? `Member …${member.id.slice(-4)}`;

function Swatches({ role, selected, disabled, onPick }: { role: TournamentRoleDto; selected: number | null; disabled: boolean; onPick(color: number): void }) {
  return <div role="radiogroup" aria-label={`Colour for ${roleLabel(role)}`} className="flex flex-wrap gap-1.5">
    {DISCORD_ROLE_COLOR_PRESETS.map(color => {
      const name = presetName(color);
      const checked = selected === color;
      return <button key={color} type="button" role="radio" aria-checked={checked} aria-label={name} title={name} disabled={disabled}
        onClick={() => onPick(color)} style={{ backgroundColor: colorHex(color) }}
        className="size-6 rounded-full border border-line outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent
          disabled:opacity-45 aria-checked:ring-2 aria-checked:ring-fg aria-checked:ring-offset-2 aria-checked:ring-offset-raised" />;
    })}
  </div>;
}

function HexField({ role, disabled, onApply }: { role: TournamentRoleDto; disabled: boolean; onApply(color: number): void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const apply = () => {
    const color = parseHexColor(text);
    if (color === null) { setError('Use six hex digits, for example #1ABC9C.'); return; }
    setError(null); setText(''); onApply(color);
  };
  return <form className="flex items-start gap-2" onSubmit={event => { event.preventDefault(); apply(); }}>
    <Field label={`Custom colour for ${roleLabel(role)}`} error={error} className="max-w-48">
      <Input value={text} maxLength={7} placeholder="#1ABC9C" disabled={disabled} spellCheck={false}
        onChange={event => { setText(event.target.value); setError(null); }} />
    </Field>
    <Button type="submit" size="sm" variant="secondary" disabled={disabled || !text.trim()} className="mt-[1.65rem]">Apply colour</Button>
  </form>;
}

function RenameRow({ role, canEdit, busy, onRename }: { role: TournamentRoleDto; canEdit: boolean; busy: boolean; onRename(name: string): Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const trimmed = (draft ?? '').trim();
  if (draft === null) return <span className="flex items-center gap-1.5">
    <h4 className="text-[13px] font-semibold text-fg">{roleLabel(role)}</h4>
    {canEdit && role.roleId && <IconButton size="sm" variant="ghost" aria-label={`Rename ${roleLabel(role)}`} icon={<Pencil />} onClick={() => setDraft(roleLabel(role))} />}
  </span>;
  const save = async () => { if (await onRename(trimmed)) setDraft(null); };
  return <form className="flex items-center gap-2" onSubmit={event => { event.preventDefault(); if (trimmed) void save(); }}>
    <Input aria-label={`New name for ${roleLabel(role)}`} value={draft} maxLength={100} autoFocus onChange={event => setDraft(event.target.value)} />
    <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!trimmed || trimmed === role.name}>Save name</Button>
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
  </form>;
}

function AddMember({ role, current, onAdd, disabled }: { role: TournamentRoleDto; current: ReadonlySet<string>; onAdd(id: string): void; disabled: boolean }) {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query);
  const search = useMemberSearch(debounced);
  const results = (search.data?.members ?? []).filter(member => !current.has(member.id));
  return <div className="flex flex-col gap-1.5">
    <Input aria-label={`Search members to add to ${roleLabel(role)}`} maxLength={100} value={query} disabled={disabled}
      placeholder="Add a member: name prefix or Discord ID" onChange={event => setQuery(event.target.value)} />
    {debounced.trim() && (search.error ? <p role="alert" className="text-xs text-danger">{describeError(search.error, 'Search failed.')}</p>
      : !search.data ? <p role="status" className="text-xs text-fg-muted">Searching…</p>
      : results.length === 0 ? <p className="text-xs text-fg-muted">No members match.</p>
      : <ul aria-label={`Members to add to ${roleLabel(role)}`} className="flex flex-col gap-1">
        {results.map(member => <li key={member.id} className="flex items-center gap-2">
          <Avatar src={member.avatarUrl} name={member.displayName ?? member.username} size="sm" decorative />
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{member.displayName ?? member.username}
            <span className="ml-1.5 text-xs text-fg-subtle">@{member.username}</span></span>
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={disabled}
            aria-label={`Add ${member.displayName ?? member.username} to ${roleLabel(role)}`}
            onClick={() => { onAdd(member.id); setQuery(''); }}>Add</Button>
        </li>)}
      </ul>)}
  </div>;
}

function RoleRow({ role, canEdit }: { role: TournamentRoleDto; canEdit: boolean }) {
  const { edit, addMember, removeMember } = useTournamentRoleMutations();
  const [error, setError] = useState<string | null>(null);
  const label = roleLabel(role);
  const editable = canEdit && role.roleId !== null && !NOT_EDITABLE.includes(role.problem as never);
  // The server refuses to assign a role in any of these states, so the add box is not offered.
  const blocksAssign = role.problem !== null && role.problem !== 'not-created';
  const run = async (action: Promise<unknown>, fallback: string): Promise<boolean> => {
    setError(null);
    try { await action; return true; } catch (cause) { setError(describeError(cause, fallback)); return false; }
  };
  const current = new Set(role.members.map(member => member.id));
  return <section aria-label={label} className="flex flex-col gap-3 rounded-md border border-line p-3">
    <header className="flex flex-wrap items-center gap-2">
      {role.color !== null && <span aria-hidden className="size-3 rounded-full border border-line" style={{ backgroundColor: colorHex(role.color) }} />}
      <div className="min-w-0 flex-1">
        <RenameRow role={role} canEdit={editable} busy={edit.isPending}
          onRename={name => run(edit.mutateAsync({ kind: role.kind, name }), 'The role could not be renamed.')} />
      </div>
      {role.roleId === null ? <Badge tone="warning">Not created</Badge>
        : role.problem ? <Badge tone="danger">Needs attention</Badge> : <Badge tone="success">Ready</Badge>}
    </header>
    {role.problem && role.problem !== 'not-created' && <p role="alert" className="flex gap-2 rounded-md bg-warning-soft p-2 text-xs text-fg">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>{role.problemText ?? 'This role cannot be managed right now.'}</span></p>}
    {role.roleId !== null && role.problem !== 'missing' && <>
      <div className="flex flex-col gap-2">
        <Swatches role={role} selected={role.color} disabled={!editable || edit.isPending}
          onPick={color => { void run(edit.mutateAsync({ kind: role.kind, color }), 'The colour could not be changed.'); }} />
        {editable && <HexField role={role} disabled={edit.isPending}
          onApply={color => { void run(edit.mutateAsync({ kind: role.kind, color }), 'The colour could not be changed.'); }} />}
      </div>
      <div className="flex flex-col gap-2">
        <h5 className="text-xs font-medium text-fg-muted">Members ({role.members.length})</h5>
        {role.members.length === 0 ? <p className="text-xs text-fg-subtle">No one has this role yet.</p>
          : <ul aria-label={`Members of ${label}`} className="flex flex-col gap-1">
            {role.members.map(member => <li key={member.id} className="flex items-center gap-2">
              <Avatar src={member.avatarUrl} name={memberName(member)} size="sm" decorative />
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{memberName(member)}</span>
              {editable && <IconButton size="sm" variant="ghost" icon={<X />} aria-label={`Remove ${memberName(member)} from ${label}`}
                disabled={removeMember.isPending}
                onClick={() => { void run(removeMember.mutateAsync({ kind: role.kind, userId: member.id }), 'The member could not be removed.'); }} />}
            </li>)}
          </ul>}
        {!role.membersComplete && <p role="status" className="text-xs text-fg-muted">
          List may be incomplete. Without the Server Members intent the bot can only list members it has seen; the role may have more holders.</p>}
        {editable && !blocksAssign && <AddMember role={role} current={current} disabled={addMember.isPending}
          onAdd={id => { void run(addMember.mutateAsync({ kind: role.kind, userId: id }), 'The member could not be added.'); }} />}
      </div>
    </>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}

type CreateOutcome = { tone: 'ok' | 'warning'; text: string };

function CreateRoles({ data, canEdit, onOutcome }: { data: TournamentRolesDto; canEdit: boolean; onOutcome(outcome: CreateOutcome | null): void }) {
  const { ensure } = useTournamentRoleMutations();
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setError(null); onOutcome(null);
    try {
      const done = await ensure.mutateAsync();
      if (done.organizer === 'failed' || done.judge === 'failed') setError(done.problem ?? 'The roles could not be created.');
      else if (done.assigned && !done.problem) onOutcome({ tone: 'ok', text: 'The roles are ready.' });
      else onOutcome({ tone: 'warning', text: `The roles exist, but the organizer was not assigned. ${done.problem ?? ''}`.trim() });
    } catch (cause) { setError(describeError(cause, 'The roles could not be created.')); }
  };
  return <div role="region" aria-label="Create TCG roles" className="flex flex-col gap-2 rounded-md border border-warning bg-warning-soft p-3">
    <p className="flex gap-2 text-[13px] font-medium text-fg"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      The TCG roles do not exist yet.</p>
    <p className="text-xs text-fg">{CREATE_ROLES_EXPLANATION}</p>
    {!data.canManageRoles && <p className="text-xs text-fg-muted">The bot needs the Manage Roles permission to create them.</p>}
    <div><Button variant="primary" loading={ensure.isPending} disabled={!canEdit || !data.canManageRoles} onClick={() => { void create(); }}>Create TCG roles</Button></div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}

export function TournamentRolesCard() {
  const roles = useTournamentRoles();
  const canEdit = useAdminToolsCapability('server.manage');
  const data = roles.data;
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  return <section aria-label="Tournament roles" className="flex flex-col gap-3 rounded-lg border border-line p-4">
    <header className="flex flex-col gap-0.5">
      <h3 className="text-[13px] font-semibold text-fg">Tournament roles</h3>
      <p className="text-xs text-fg-muted">TCG Organizer can do every staff action. TCG Judge can only rule on matches, check players in and handle evidence.
        The server owner always counts as organizer, and either role can also play.</p>
    </header>
    {roles.error ? <p role="alert" className="text-xs text-danger">{describeError(roles.error, 'Roles could not be loaded.')}{' '}
      <Button size="sm" variant="ghost" onClick={() => { void roles.refetch(); }}>Try again</Button></p>
      : !data ? <p role="status" className="text-xs text-fg-muted">Loading roles…</p>
      : <>
        {outcome && <p role={outcome.tone === 'warning' ? 'alert' : 'status'}
          className={outcome.tone === 'warning' ? 'rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg' : 'text-xs text-fg-muted'}>{outcome.text}</p>}
        {data.roles.some(role => role.roleId === null || role.problem === 'missing') && <CreateRoles data={data} canEdit={canEdit} onOutcome={setOutcome} />}
        {data.roles.map(role => <RoleRow key={role.kind} role={role} canEdit={canEdit} />)}
        {data.legacyStaffRoleIds.length > 0 && <p className="text-xs text-fg-muted">{LEGACY_NOTE}</p>}
        <p className="text-xs text-fg-subtle">{STAFF_COMMAND_NOTE}</p>
      </>}
  </section>;
}
