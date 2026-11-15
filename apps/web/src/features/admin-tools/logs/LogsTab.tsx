// (D) Logs tab: filterable join/leave/role/nickname and message edit/delete log, plus the logging settings
// (channels, welcome templates with live preview, auto-role picker, message log retention and ignored
// channels), a privacy notice and the audited "Delete stored message history" action.
import { ADMIN_TOOLS_LIMITS as L, PRIVILEGED_INTENT_PORTAL_LABELS, type AdminToolsStatusDto, type GuildMetaDto, type LogEntryDto,
  type LoggingSettingsDto, type PrivilegedIntentName } from '@tcg-live/core';
import { Filter, ShieldAlert, Trash2, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, Select, Switch, Textarea } from '../../../ui';
import { describeError } from '../../evidence/api';
import { useAdminToolsCapability, useAdminToolsSection, useAdminToolsStatus, useGuildMeta } from '../api';
import { ChannelSelect, RoleSelect } from '../shared/ChannelSelect';
import { SectionFrame } from '../shared/SectionFrame';
import { useAdminToolsNavigation } from '../navigation';
import { isElevatedRole } from '../roles/api';
import { IntentStatusCard } from '../SettingsTab';
import { collectPages, ExportButtons, type ExportRow } from '../shared/exportData';
import { DEFAULT_LOG_FILTER, getLogPage, deleteMessageHistory, useInvalidateLogs, useLogPages, useMessageStoreStats, type LogFilter } from './api';
import { renderTemplatePreview, TEMPLATE_PLACEHOLDERS } from './template';

const SNOWFLAKE = /^[1-9]\d{14,21}$/;
const KIND_OPTIONS = [
  { value: 'member:', label: 'All member events' }, { value: 'member:join', label: 'Joins' }, { value: 'member:leave', label: 'Leaves' },
  { value: 'member:role', label: 'Role changes' }, { value: 'member:nick', label: 'Nickname changes' },
  { value: 'message:', label: 'All message events' }, { value: 'message:edit', label: 'Edits' }, { value: 'message:delete', label: 'Deletes' }
] as const;
const KIND_LABEL: Record<LogEntryDto['kind'], string> = { join: 'Joined', leave: 'Left', role: 'Roles', nick: 'Nickname', edit: 'Edited', delete: 'Deleted' };
const KIND_TONE = { join: 'success', leave: 'neutral', role: 'accent', nick: 'accent', edit: 'warning', delete: 'danger' } as const;

/** Which privileged intent each sub-feature needs, for the per-section notice. */
export function intentProblem(status: AdminToolsStatusDto | undefined, intent: PrivilegedIntentName, enabled: boolean): string | null {
  if (!enabled || !status || status.runtime === 'demo') return null;
  if (status.privilegedIntents[intent] === 'on') return null;
  return `Turn on ${PRIVILEGED_INTENT_PORTAL_LABELS[intent]} in the Discord Developer Portal → Bot, then restart.`;
}

function IntentNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="status" className="flex gap-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
    <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" /><span>{message}</span></p>;
}

const time = (ms: number) => new Date(ms).toLocaleString();
const roleName = (meta: GuildMetaDto | undefined, id: string) => `@${meta?.roles.find(role => role.id === id)?.name ?? id}`;
const channelName = (meta: GuildMetaDto | undefined, id: string) => `#${meta?.channels.find(channel => channel.id === id)?.name ?? id}`;

function EntryDetail({ entry, meta }: { entry: LogEntryDto; meta: GuildMetaDto | undefined }) {
  if (entry.stream === 'message') {
    return <div className="flex flex-col gap-1">
      <span className="text-fg-subtle">in {channelName(meta, entry.channelId)}{entry.attachmentCount ? ` · ${entry.attachmentCount} attachment(s)` : ''}</span>
      {entry.kind === 'edit' ? <>
        <span><b className="font-medium">Before:</b> <span className="whitespace-pre-wrap break-words">{entry.before ?? '(unknown)'}</span></span>
        <span><b className="font-medium">After:</b> <span className="whitespace-pre-wrap break-words">{entry.after ?? ''}</span></span>
      </> : <span className="whitespace-pre-wrap break-words">{entry.before || '(no text)'}</span>}
    </div>;
  }
  const { detail } = entry;
  if (entry.kind === 'join') return <span>
    {detail.accountCreatedAtMs ? `Account created ${new Date(detail.accountCreatedAtMs).toLocaleDateString()}` : ''}
    {detail.newAccount && <Badge tone="warning" className="ml-2">New account</Badge>}</span>;
  if (entry.kind === 'role') return <span>{[...(detail.addedRoleIds ?? []).map(id => `+ ${roleName(meta, id)}`),
    ...(detail.removedRoleIds ?? []).map(id => `− ${roleName(meta, id)}`)].join('  ')}</span>;
  if (entry.kind === 'nick') return <span>{detail.before ?? '(none)'} → {detail.after ?? '(none)'}</span>;
  return null;
}

export function LogList() {
  const meta = useGuildMeta();
  const navigation = useAdminToolsNavigation();
  const [filter, setFilter] = useState<LogFilter>(DEFAULT_LOG_FILTER);
  const [memberText, setMemberText] = useState('');
  // The server answers 400 for an inverted range; ask without the end date and flag it instead.
  const rangeInverted = !!filter.from && !!filter.to && filter.from > filter.to;
  const pages = useLogPages(rangeInverted ? { ...filter, to: null } : filter);
  const entries = pages.data?.pages.flatMap(page => page.entries) ?? [];
  const memberInvalid = memberText.trim() !== '' && !SNOWFLAKE.test(memberText.trim());
  const set = (patch: Partial<LogFilter>) => setFilter(current => ({ ...current, ...patch }));
  const byMember = (userId: string) => { setMemberText(userId); set({ userId }); };
  const { api } = useAdminData();
  const effective = rangeInverted ? { ...filter, to: null } : filter;
  const collect = () => collectPages<number>(0, async before => {
    const page = await getLogPage(api, effective, before);
    return { rows: page.entries as unknown as ExportRow[], next: page.nextAfter > 0 ? page.nextAfter : null };
  });
  return <section aria-label="Log entries" className="flex flex-col gap-3 rounded-lg border border-line p-4">
    <header className="flex flex-wrap items-center gap-2"><h3 className="flex-1 text-[13px] font-semibold text-fg">Log</h3>
      <ExportButtons name={`log-${filter.stream}`} label={`the ${filter.stream} log`} collect={collect} /></header>
    <form className="grid grid-cols-1 gap-2 sm:grid-cols-5" onSubmit={event => { event.preventDefault(); }} aria-label="Log filters">
      <Field label="Kind">
        <Select value={`${filter.stream}:${filter.kind ?? ''}`} onChange={event => {
          const [stream, kind] = event.target.value.split(':') as [LogFilter['stream'], string];
          set({ stream, kind: (kind || null) as LogFilter['kind'], channelId: stream === 'message' ? filter.channelId : null });
        }}>
          {KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
      <Field label="Member ID" error={memberInvalid ? 'Enter a Discord user ID.' : undefined}>
        <Input value={memberText} placeholder="Any member" onChange={event => {
          const value = event.target.value;
          setMemberText(value);
          const trimmed = value.trim();
          if (!trimmed || SNOWFLAKE.test(trimmed)) set({ userId: trimmed || null });
        }} />
      </Field>
      <Field label="Channel">
        <ChannelSelect value={filter.channelId} disabled={filter.stream !== 'message'} placeholder="Any channel"
          types={['text', 'announcement', 'voice', 'forum', 'stage']} onChange={channelId => set({ channelId })} />
      </Field>
      <Field label="From"><Input type="date" value={filter.from ?? ''} onChange={event => set({ from: event.target.value || null })} /></Field>
      <Field label="To" error={rangeInverted ? 'Must not be before From.' : undefined}><Input type="date" value={filter.to ?? ''} onChange={event => set({ to: event.target.value || null })} /></Field>
    </form>
    {filter !== DEFAULT_LOG_FILTER && <div><Button size="sm" variant="ghost" icon={<X />}
      onClick={() => { setFilter(DEFAULT_LOG_FILTER); setMemberText(''); }}>Clear filters</Button></div>}
    {pages.error ? <p role="alert" className="text-xs text-danger">{describeError(pages.error, 'The log could not be loaded.')}</p>
      : pages.isPending ? <p role="status" className="text-xs text-fg-muted">Loading log…</p>
      : entries.length === 0 ? <EmptyState icon={<Filter />} title="No log entries" description="Nothing matches these filters yet." />
      : <ol aria-label="Log" className="flex flex-col divide-y divide-line">
        {entries.map(entry => <li key={`${entry.stream}-${entry.id}`} className="flex flex-col gap-1 py-2 text-xs text-fg sm:flex-row sm:gap-3">
          <span className="w-40 shrink-0 text-fg-subtle">{time(entry.occurredAtMs)}</span>
          <span className="w-20 shrink-0"><Badge tone={KIND_TONE[entry.kind]}>{KIND_LABEL[entry.kind]}</Badge></span>
          <span className="flex w-44 shrink-0 flex-col items-start">{entry.userId ? <>
            <button type="button" className="font-mono text-accent hover:underline" title="Show only this member"
              onClick={() => byMember(entry.userId!)}>{entry.userId}</button>
            {navigation.openMember && <button type="button" className="text-fg-subtle hover:text-fg hover:underline"
              onClick={() => navigation.openMember!(entry.userId!)}>Open profile</button>}
          </> : <span className="text-fg-subtle">unknown</span>}</span>
          <span className="min-w-0 flex-1"><EntryDetail entry={entry} meta={meta.data} /></span>
        </li>)}
      </ol>}
    {pages.hasNextPage && <div><Button size="sm" loading={pages.isFetchingNextPage} onClick={() => { void pages.fetchNextPage(); }}>Load older</Button></div>}
  </section>;
}

function MessageHistoryPanel({ enabled, canEdit }: { enabled: boolean; canEdit: boolean }) {
  const { api } = useAdminData();
  const stats = useMessageStoreStats();
  const invalidate = useInvalidateLogs();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = (stats.data?.storedMessages ?? 0) + (stats.data?.loggedEntries ?? 0);
  return <div className="flex flex-col gap-2 rounded-md bg-line-faint p-3 text-xs text-fg-muted" aria-label="Stored message history" role="group">
    <p className="flex gap-2"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span><b className="text-fg">Privacy:</b> while the message log is on, the bot keeps a local copy of the text of new messages in
        non-ignored channels (never DMs or bot messages; attachments are counted, not downloaded) so it can show what was edited or
        deleted. Copies and log entries are deleted after the retention period, checked every hour. Tell your members the server
        logs edits and deletes.</span></p>
    <p>{stats.data ? `${stats.data.storedMessages} message copies and ${stats.data.loggedEntries} edit/delete entries stored` +
      (stats.data.oldestMs ? ` (oldest ${new Date(stats.data.oldestMs).toLocaleDateString()}).` : '.') : 'Checking stored history…'}
      {!enabled && total > 0 && ' The log is off: nothing new is stored.'}</p>
    {result && <p role="status" className="text-fg">{result}</p>}
    {canEdit && <div><Button size="sm" variant={enabled ? 'ghost' : 'secondary'} icon={<Trash2 />} disabled={total === 0}
      onClick={() => { setError(null); setConfirm(true); }}>Delete stored message history</Button></div>}
    <ConfirmDialog open={confirm} danger pending={pending} title="Delete stored message history?" confirmLabel="Delete history"
      description="Deletes every stored message copy and every edit/delete log entry for this server. This cannot be undone and is recorded in the audit log."
      onCancel={() => setConfirm(false)}
      onConfirm={() => {
        if (pending) return;
        setPending(true); setError(null);
        deleteMessageHistory(api).then(deleted => {
          setResult(`Deleted ${deleted.storedMessages} message copies and ${deleted.loggedEntries} log entries.`);
          setConfirm(false);
          return invalidate();
        }).catch(cause => setError(describeError(cause, 'History could not be deleted.'))).finally(() => setPending(false));
      }}>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </ConfirmDialog>
  </div>;
}

function idList(text: string): string[] { return [...new Set(text.split(/[\s,]+/).filter(Boolean))]; }

export function LoggingSettingsForm() {
  const editor = useAdminToolsSection('logging');
  const status = useAdminToolsStatus();
  const meta = useGuildMeta();
  const canEdit = useAdminToolsCapability('server.manage');
  const value = editor.value;
  const saved = editor.saved?.logging;
  const update = <K extends keyof LoggingSettingsDto>(key: K, patch: Partial<LoggingSettingsDto[K]>) => {
    if (value) editor.setValue({ ...value, [key]: { ...value[key], ...patch } });
  };
  const [roleToAdd, setRoleToAdd] = useState<string | null>(null);
  const preview = (template: string) => renderTemplatePreview(template, { user: '@NewMember', username: 'NewMember',
    server: meta.data?.name ?? 'your server', memberCount: meta.data?.memberCount ?? null });
  const membersEnabled = !!saved && (saved.joinLeave.enabled || saved.welcome.enabled || saved.autoRole.enabled);
  const unassignable = value?.autoRole.roleIds.filter(id => {
    const role = meta.data?.roles.find(item => item.id === id);
    return meta.data && (!role || role.managed || role.aboveBot || isElevatedRole(role));
  }) ?? [];
  const disabled = !canEdit;
  return <SectionFrame editor={editor} title="Logging settings" canEdit={canEdit}
    description="Join/leave log, welcome messages and auto-role need the Server Members Intent; the message log needs the Message Content Intent. Each is requested only while enabled.">
    {value && <>
      <IntentNotice message={intentProblem(status.data, 'guildMembers', membersEnabled)} />
      <fieldset className="flex flex-col gap-3" aria-label="Join and leave log">
        <legend className="text-xs font-semibold text-fg">Join/leave log</legend>
        <Field label="Log joins and leaves" inline description="Records joins (with account age) and leaves.">
          <Switch checked={value.joinLeave.enabled} disabled={disabled} onCheckedChange={enabled => update('joinLeave', { enabled })} />
        </Field>
        <Field label="Log channel" description="A compact embed is posted here for each event.">
          <ChannelSelect value={value.joinLeave.channelId} disabled={disabled} onChange={channelId => update('joinLeave', { channelId })} />
        </Field>
        <Field label="Flag accounts newer than (days)" description="0 turns the new-account flag off.">
          <Input type="number" min={L.newAccountDaysMin} max={L.newAccountDaysMax} value={value.joinLeave.newAccountDays} disabled={disabled}
            onChange={event => update('joinLeave', { newAccountDays: Number(event.target.value) })} />
        </Field>
        <Field label="Log role and nickname changes" inline>
          <Switch checked={value.joinLeave.memberUpdates} disabled={disabled} onCheckedChange={memberUpdates => update('joinLeave', { memberUpdates })} />
        </Field>
      </fieldset>
      <fieldset className="flex flex-col gap-3" aria-label="Welcome messages">
        <legend className="text-xs font-semibold text-fg">Welcome messages</legend>
        <Field label="Post a welcome message" inline description="Only the new member is pinged; @everyone and roles never are.">
          <Switch checked={value.welcome.enabled} disabled={disabled} onCheckedChange={enabled => update('welcome', { enabled })} />
        </Field>
        <Field label="Welcome channel">
          <ChannelSelect value={value.welcome.channelId} disabled={disabled} onChange={channelId => update('welcome', { channelId })} />
        </Field>
        <Field label="Welcome message" description={`Placeholders: ${TEMPLATE_PLACEHOLDERS.join(', ')}.`}>
          <Textarea rows={3} maxLength={L.welcomeMessageLength} value={value.welcome.message} disabled={disabled}
            onChange={event => update('welcome', { message: event.target.value })} />
        </Field>
        <p aria-label="Welcome preview" className="rounded-md bg-line-faint p-2 text-xs text-fg whitespace-pre-wrap">{preview(value.welcome.message)}</p>
        <Field label="Leave message" description="Optional; nobody is pinged. Leave empty for none.">
          <Textarea rows={2} maxLength={L.welcomeMessageLength} value={value.welcome.leaveMessage ?? ''} disabled={disabled}
            onChange={event => update('welcome', { leaveMessage: event.target.value || null })} />
        </Field>
        {value.welcome.leaveMessage && <p aria-label="Leave preview" className="rounded-md bg-line-faint p-2 text-xs text-fg whitespace-pre-wrap">
          {preview(value.welcome.leaveMessage)}</p>}
      </fieldset>
      <fieldset className="flex flex-col gap-3" aria-label="Auto-role">
        <legend className="text-xs font-semibold text-fg">Auto-role on join</legend>
        <Field label="Give roles to new members" inline description="Roles the bot cannot assign are skipped and logged.">
          <Switch checked={value.autoRole.enabled} disabled={disabled} onCheckedChange={enabled => update('autoRole', { enabled })} />
        </Field>
        <Field label="Skip bots" inline description="On: only human members get these roles. Off: bots that join get them too (they are never welcomed).">
          <Switch checked={value.autoRole.skipBots !== false} disabled={disabled} onCheckedChange={skipBots => update('autoRole', { skipBots })} />
        </Field>
        <ul className="flex flex-wrap gap-1.5" aria-label="Auto-roles">
          {value.autoRole.roleIds.map(id => <li key={id}><Badge tone={unassignable.includes(id) ? 'danger' : 'neutral'}>{roleName(meta.data, id)}
            {canEdit && <button type="button" aria-label={`Remove ${roleName(meta.data, id)}`} className="ml-1"
              onClick={() => update('autoRole', { roleIds: value.autoRole.roleIds.filter(roleId => roleId !== id) })}>×</button>}</Badge></li>)}
        </ul>
        {unassignable.length > 0 && <p role="alert" className="text-xs text-danger">
          {unassignable.map(id => roleName(meta.data, id)).join(', ')} cannot be assigned by the bot (managed, missing, above its role,
          or with staff-level permissions, which the bot refuses to hand out).</p>}
        {canEdit && value.autoRole.roleIds.length < L.autoRoles && <div className="flex gap-2">
          <RoleSelect value={roleToAdd} onChange={setRoleToAdd} placeholder="Add a role" />
          <Button size="sm" disabled={!roleToAdd || value.autoRole.roleIds.includes(roleToAdd)} onClick={() => {
            if (roleToAdd) update('autoRole', { roleIds: [...value.autoRole.roleIds, roleToAdd] });
            setRoleToAdd(null);
          }}>Add</Button>
        </div>}
      </fieldset>
      <fieldset className="flex flex-col gap-3" aria-label="Message log">
        <legend className="text-xs font-semibold text-fg">Message edit/delete log</legend>
        <IntentNotice message={intentProblem(status.data, 'messageContent', !!saved?.messageLog.enabled)} />
        <Field label="Log edited and deleted messages" inline description="Off by default. Stores message text locally; see the privacy notice below.">
          <Switch checked={value.messageLog.enabled} disabled={disabled} onCheckedChange={enabled => update('messageLog', { enabled })} />
        </Field>
        <Field label="Log channel" description="Optional; leave empty to log to the dashboard only.">
          <ChannelSelect value={value.messageLog.channelId} disabled={disabled} onChange={channelId => update('messageLog', { channelId })} />
        </Field>
        <Field label="Keep stored text for (days)">
          <Input type="number" min={L.retentionDaysMin} max={L.retentionDaysMax} value={value.messageLog.retentionDays} disabled={disabled}
            onChange={event => update('messageLog', { retentionDays: Number(event.target.value) })} />
        </Field>
        <Field label="Ignored channels" description="Messages here are never stored or logged.">
          <div className="flex flex-col gap-1.5">
            <ul className="flex flex-wrap gap-1.5" aria-label="Ignored channels">
              {value.messageLog.ignoredChannelIds.map(id => <li key={id}><Badge>{channelName(meta.data, id)}
                {canEdit && <button type="button" aria-label={`Stop ignoring ${channelName(meta.data, id)}`} className="ml-1"
                  onClick={() => update('messageLog', { ignoredChannelIds: value.messageLog.ignoredChannelIds.filter(channelId => channelId !== id) })}>×</button>}
              </Badge></li>)}
            </ul>
            {canEdit && value.messageLog.ignoredChannelIds.length < L.ignoredChannels &&
              <ChannelSelect value={null} placeholder="Ignore a channel…" onChange={id => {
                if (id) update('messageLog', { ignoredChannelIds: idList([...value.messageLog.ignoredChannelIds, id].join(' ')) });
              }} />}
          </div>
        </Field>
        <MessageHistoryPanel enabled={!!saved?.messageLog.enabled} canEdit={canEdit} />
      </fieldset>
    </>}
  </SectionFrame>;
}

export function LogsTab() {
  const status = useAdminToolsStatus();
  const showStatus = !!status.data && (status.data.restartRequired ||
    (['guildMembers', 'messageContent'] as const).some(name => status.data!.wantedIntents[name] && status.data!.privilegedIntents[name] !== 'on'));
  return <div className="flex flex-col gap-4">
    {showStatus && <IntentStatusCard status={status.data!} />}
    <LogList />
    <LoggingSettingsForm />
  </div>;
}
