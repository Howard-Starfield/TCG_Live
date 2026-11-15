// Cases tab: numbered cases with filters (member, kind, moderator), case detail with reason and evidence
// editing and audited delete, plus the mod-action audit trail (our cases merged with Discord's audit log).
import { MOD_CASE_KINDS, type ModCaseDto, type ModCaseKind, type ModCasePageDto } from '@tcg-live/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { adminToolsKeys, useAdminToolsAccess } from '../api';
import { retryTransient } from '../../evidence/api';
import { collectPages, ExportButtons, type ExportRow } from '../shared/exportData';
import { Badge, Button, ConfirmDialog, Dialog, Disclosure, Field, Input, Select, Textarea } from '../../../ui';
import { CaseEvidencePicker } from './CaseEvidencePicker';
import { describeError } from '../../evidence/api';
import { caseQueryString, SNOWFLAKE, useCanModerate, useCases, useDeleteCase, useDebouncedValue, useModAudit, useUpdateCase, type CaseFilter } from './api';
import { useAdminToolsNavigation } from '../navigation';
import { formatDateTime } from './MembersTab';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const caseNumberOf = (item: string | null | undefined): number | null => (item && /^[1-9]\d{0,9}$/.test(item) ? Number(item) : null);

/** One case by number (deep links to a case that is not on the loaded page). */
function useCaseByNumber(number: number | null, enabled: boolean) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  return useQuery({ queryKey: adminToolsKeys.feature('members', 'case', number), enabled: access && enabled && number !== null, retry: retryTransient,
    queryFn: ({ signal }) => api.request<ModCaseDto>('GET', `/admin-tools/cases/${number}`, { signal }) });
}

/** Every case matching the filter, newest first (capped), for CSV / JSON export. */
function useCaseExport(filter: CaseFilter) {
  const { api } = useAdminData();
  return () => collectPages<number>(0, async before => {
    const page = await api.request<ModCasePageDto>('GET', `/admin-tools/cases?${caseQueryString(filter, before || null)}`);
    return { rows: page.cases as unknown as ExportRow[], next: page.nextBefore };
  });
}

const moderatorLabel = (id: string) => id === 'local-admin' ? 'Dashboard (local admin)' : id === 'bot' ? 'Bot' : id;

export function CasesTab() {
  const [filter, setFilter] = useState<CaseFilter>({ targetId: '', kind: '', moderatorId: '' });
  const debounced = useDebouncedValue(filter);
  const cases = useCases(debounced);
  // The open case is part of the deep link (#/admin-tools/cases/<number>), so a reload reopens it.
  const navigation = useAdminToolsNavigation();
  const [openNumber, setOpenNumber] = useState<number | null>(() => caseNumberOf(navigation.item));
  const setOpen = (item: ModCaseDto | null) => { setOpenNumber(item?.number ?? null); navigation.setItem?.(item ? String(item.number) : null); };
  const memberInvalid = filter.targetId.trim() !== '' && !SNOWFLAKE.test(filter.targetId.trim());
  const rows = cases.data?.pages.flatMap(page => page.cases) ?? [];
  const listed = openNumber === null ? undefined : rows.find(item => item.number === openNumber);
  const fetched = useCaseByNumber(openNumber, !listed && !cases.isPending);
  const open = listed ?? fetched.data ?? null;
  const exporter = useCaseExport(debounced);
  return <div className="flex flex-col gap-6">
    <section aria-label="Case log" className="flex flex-col gap-3">
      <div className="flex items-center gap-2"><h3 className="flex-1 text-[13px] font-semibold text-fg">Case log</h3>
        <ExportButtons name="cases" label="cases" collect={exporter} /></div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label="Member ID" error={memberInvalid ? 'Enter a Discord ID.' : undefined}>
          <Input value={filter.targetId} placeholder="Any member" onChange={event => setFilter({ ...filter, targetId: event.target.value })} />
        </Field>
        <Field label="Kind">
          <Select value={filter.kind} onChange={event => setFilter({ ...filter, kind: event.target.value as ModCaseKind | '' })}>
            <option value="">All kinds</option>
            {MOD_CASE_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </Select>
        </Field>
        <Field label="Moderator">
          <Input value={filter.moderatorId} placeholder="local-admin or a Discord ID" onChange={event => setFilter({ ...filter, moderatorId: event.target.value })} />
        </Field>
      </div>
      {cases.isPending ? <p role="status" className="text-xs text-fg-muted">Loading cases…</p>
        : cases.error ? <p role="alert" className="text-xs text-danger">{describeError(cases.error, 'Cases could not be loaded.')}</p>
        : rows.length === 0 ? <p className="text-xs text-fg-muted">No cases.</p>
        : <ul aria-label="Cases" className="flex flex-col divide-y divide-line">
          {rows.map(item => <li key={item.number}>
            <button type="button" onClick={() => setOpen(item)} className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-xs hover:bg-line-faint sm:flex-nowrap">
              <span className="w-12 font-mono text-fg-subtle">#{item.number}</span><Badge tone="neutral">{item.kind}</Badge>
              <span className="font-mono text-fg-muted">{item.targetId}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{item.reason}</span>
              <span className="text-fg-subtle">{formatDateTime(item.createdAtMs)}</span>
            </button>
          </li>)}
        </ul>}
      {cases.hasNextPage && <span><Button size="sm" variant="ghost" loading={cases.isFetchingNextPage} onClick={() => { void cases.fetchNextPage(); }}>Older cases</Button></span>}
      <CaseDetailDialog item={open} onClose={() => setOpen(null)} />
    </section>
    <ModAuditTrail />
  </div>;
}

export function CaseDetailDialog({ item, onClose }: { item: ModCaseDto | null; onClose(): void }) {
  const canModerate = useCanModerate();
  const navigation = useAdminToolsNavigation();
  const update = useUpdateCase();
  const remove = useDeleteCase();
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (item && loadedFor !== item.number) {
    setLoadedFor(item.number); setReason(item.reason); setEvidence(item.evidenceIds.join('\n')); update.reset(); remove.reset();
  }
  if (!item) return null;
  const evidenceIds = evidence.split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
  const evidenceInvalid = evidenceIds.some(value => !UUID.test(value)) || evidenceIds.length > 10;
  const dirty = reason.trim() !== item.reason || evidenceIds.join(',') !== item.evidenceIds.join(',');
  const close = () => { setLoadedFor(null); onClose(); };
  return <>
    <Dialog open={!confirmDelete} onClose={close} title={`Case #${item.number}`} width="lg"
      description={`${item.kind} · member ${item.targetId} · ${formatDateTime(item.createdAtMs)} · by ${moderatorLabel(item.moderatorId)}`}
      footer={canModerate ? <>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete case</Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={close}>Close</Button>
        <Button variant="primary" disabled={!dirty || !reason.trim() || evidenceInvalid} loading={update.isPending}
          onClick={() => update.mutate({ number: item.number, ...(reason.trim() !== item.reason ? { reason: reason.trim() } : {}), evidenceIds },
            { onSuccess: close })}>Save</Button>
      </> : <Button onClick={close}>Close</Button>}>
      <div className="flex flex-col gap-3">
        <Field label="Reason" required><Textarea rows={3} value={reason} disabled={!canModerate} maxLength={500} onChange={event => setReason(event.target.value)} /></Field>
        {item.eventId && item.matchId ? <>
          <CaseEvidencePicker eventId={item.eventId} matchId={item.matchId} value={evidenceIds} disabled={!canModerate}
            onChange={ids => setEvidence(ids.join('\n'))} />
          <Disclosure summary="Evidence IDs" meta={`${evidenceIds.length} attached`}>
            <Field label="Evidence IDs" description="Paste IDs from another match, one per line (up to 10)." error={evidenceInvalid ? 'Use evidence IDs from the Evidence drawer.' : undefined}>
              <Textarea rows={2} value={evidence} disabled={!canModerate} onChange={event => setEvidence(event.target.value)} />
            </Field>
          </Disclosure>
        </> : <Field label="Evidence IDs" description="Match evidence IDs, one per line (up to 10). Copy them in the Evidence drawer." error={evidenceInvalid ? 'Use evidence IDs from the Evidence drawer.' : undefined}>
          <Textarea rows={2} value={evidence} disabled={!canModerate} onChange={event => setEvidence(event.target.value)} />
        </Field>}
        {navigation.openMember && <span><Button size="sm" variant="ghost"
          onClick={() => { const open = navigation.openMember!; close(); open(item.targetId); }}>Open member profile</Button></span>}
        {item.matchId && <p className="text-xs text-fg-muted">From match {item.matchId}.</p>}
        {item.expiresAtMs !== null && <p className="text-xs text-fg-muted">Ends {formatDateTime(item.expiresAtMs)}.</p>}
        {update.error && <p role="alert" className="text-xs text-danger">{describeError(update.error, 'The case could not be saved.')}</p>}
      </div>
    </Dialog>
    <ConfirmDialog open={confirmDelete} danger requireReason title={`Delete case #${item.number}?`} confirmLabel="Delete case"
      description="The case is removed from the log. The deletion and your reason stay in the audit log. Its number is never reused."
      pending={remove.isPending} onCancel={() => setConfirmDelete(false)}
      onConfirm={why => remove.mutate({ number: item.number, reason: why }, { onSuccess: () => { setConfirmDelete(false); close(); } })}>
      {remove.error && <p role="alert" className="text-xs text-danger">{describeError(remove.error, 'The case could not be deleted.')}</p>}
    </ConfirmDialog>
  </>;
}

const AUDIT_HINT = {
  'missing-permission': 'Bans, kicks and timeouts done outside the bot are hidden: give the bot the View Audit Log permission.',
  unavailable: 'Discord did not answer, so only actions done through the bot are shown.'
} as const;

export function ModAuditTrail() {
  const audit = useModAudit();
  const entries = audit.data?.pages.flatMap(page => page.entries) ?? [];
  const state = audit.data?.pages[0]?.discordAudit ?? 'ok';
  return <section aria-label="Mod-action audit trail" className="flex flex-col gap-2">
    <h3 className="text-[13px] font-semibold text-fg">Mod-action audit trail</h3>
    <p className="text-xs text-fg-muted">Cases from the dashboard and Discord, plus bans, kicks and timeouts done directly in Discord.</p>
    {state !== 'ok' && <p role="note" className="rounded-md bg-warning-soft p-2 text-xs text-fg">{AUDIT_HINT[state]}</p>}
    {audit.isPending ? <p role="status" className="text-xs text-fg-muted">Loading…</p>
      : audit.error ? <p role="alert" className="text-xs text-danger">{describeError(audit.error, 'The audit trail could not be loaded.')}</p>
      : entries.length === 0 ? <p className="text-xs text-fg-muted">No moderation actions yet.</p>
      : <ul className="flex flex-col divide-y divide-line">
        {entries.map(entry => <li key={entry.id} className="flex items-center gap-2 py-1.5 text-xs">
          <span className="w-36 text-fg-subtle">{formatDateTime(entry.occurredAtMs)}</span>
          <Badge tone="neutral">{entry.kind}</Badge>
          <Badge tone={entry.source === 'external' ? 'warning' : 'accent'}>{entry.source === 'external' ? 'Outside the bot' : entry.caseNumber !== null ? `Case #${entry.caseNumber}` : entry.source}</Badge>
          <span className="font-mono text-fg-muted">{entry.targetId ?? '—'}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{entry.reason ?? 'No reason'}</span>
          <span className="text-fg-subtle">{entry.moderatorId ? moderatorLabel(entry.moderatorId) : ''}</span>
        </li>)}
      </ul>}
    {audit.hasNextPage && <span><Button size="sm" variant="ghost" loading={audit.isFetchingNextPage} onClick={() => { void audit.fetchNextPage(); }}>Older</Button></span>}
  </section>;
}
