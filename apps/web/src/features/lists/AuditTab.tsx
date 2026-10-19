// Audit tab: the event's applied commands with filters, text search, paging and raw JSON.
//
// Order: newest first by default. The console's activity stream already reads chronologically (newest
// at the bottom, scroll-pinned); this table is the lookup view, so the latest changes sit at the top
// without scrolling, and "Load older" continues naturally below them. The # column re-sorts ascending.
import type { AuditEntryDto, EventSnapshotDto } from '@tcg-live/core';
import { Bot, ChevronRight, FileClock, History, Search, ShieldCheck, Terminal, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { formatAuditEntry, formatTimeOfDay, useAudit } from '../../data';
import { Avatar, Button, Chip, CodeBlock, DataTable, Disclosure, EmptyState, IconButton, Input, Select, cx,
  type Column, type SortState } from '../../ui';
import { EMPTY_AUDIT_FILTERS, commandDetails, commandTypes, filterAudit, hasActiveFilters,
  type ActorKindFilter, type AuditFilters, type MatchFilter, type ViaFilter } from './model';
import { None, SeatTag, ToneBadge } from './shared';

const VIA_TONE = { discord: 'neutral', web: 'accent', system: 'warning', cli: 'neutral' } as const;
const DEFAULT_SORT: SortState = { columnId: 'sequence', direction: 'desc' };

function ActorCell({ entry, snapshot }: { entry: AuditEntryDto; snapshot: EventSnapshotDto }) {
  const formatted = formatAuditEntry(entry, snapshot);
  const { actor } = entry;
  const icon = actor.kind === 'player' ? <SeatTag seat={actor.seat} />
    : actor.kind === 'member' ? <Avatar src={formatted.actorMemberId ? snapshot.members[formatted.actorMemberId]?.avatarUrl : null}
      name={formatted.actorLabel} size="xs" decorative />
      : actor.kind === 'admin' ? <ShieldCheck aria-hidden className="size-3.5 text-fg-subtle" />
        : <Bot aria-hidden className="size-3.5 text-fg-subtle" />;
  const name = actor.kind === 'player' ? formatted.actorName ?? formatted.actorLabel : formatted.actorLabel;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={formatted.actorLabel}>
      {icon}
      <span className="min-w-0 max-w-[9rem] truncate text-fg">{name}</span>
    </span>
  );
}

function CommandCell({ entry }: { entry: AuditEntryDto }) {
  const details = commandDetails(entry);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="font-mono text-xs text-fg">{entry.command.type}</span>
      {details && <span className="min-w-0 max-w-[10rem] truncate text-fg-subtle" title={details}>{details}</span>}
    </span>
  );
}

function AuditDetail({ entry, snapshot, onClose }: { entry: AuditEntryDto; snapshot: EventSnapshotDto; onClose(): void }) {
  const formatted = formatAuditEntry(entry, snapshot);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}
      className="lists-detail flex max-h-[45%] min-h-0 shrink-0 flex-col gap-1 overflow-auto rounded-lg bg-raised p-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="flex items-start gap-2 pl-1">
        <h3 id={headingId} className="min-w-0 flex-1 pt-1 text-xs font-semibold text-fg">
          <span className="mr-1.5 font-mono text-fg-subtle">#{entry.sequence}</span>{formatted.text}
        </h3>
        <IconButton aria-label={`Close entry ${entry.sequence}`} size="sm" icon={<X aria-hidden />} onClick={onClose} />
      </div>
      <p className="truncate pl-1 font-mono text-2xs text-fg-subtle" title={entry.commandId}>{entry.commandId}</p>
      <Disclosure summary="Raw JSON" meta="applied entry" defaultOpen>
        <CodeBlock code={JSON.stringify(entry, null, 2)} language="json" maxHeight={260} />
      </Disclosure>
    </section>
  );
}

function FilterBar({ filters, onChange, types, shown, loaded }: {
  filters: AuditFilters; onChange(next: AuditFilters): void; types: string[]; shown: number; loaded: number;
}) {
  const set = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => onChange({ ...filters, [key]: value });
  const active = hasActiveFilters(filters);
  return (
    <div role="search" aria-label="Filter audit entries" className="flex flex-wrap items-center gap-1.5">
      <span className="relative min-w-[9rem] flex-[1_1_12rem]">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <Input type="search" aria-label="Search audit" placeholder="Search actor, command, result…" value={filters.query}
          onChange={event => set('query', event.target.value)} className="h-7 pl-8 text-xs" />
      </span>
      <span className="lists-select shrink-0 w-[7.25rem]">
        <Select aria-label="Actor kind" value={filters.actor} onChange={event => set('actor', event.target.value as ActorKindFilter)}>
          <option value="all">All actors</option>
          <option value="player">Players</option>
          <option value="member">Members</option>
          <option value="admin">Admin</option>
          <option value="system">Timer</option>
        </Select>
      </span>
      <span className="lists-select shrink-0 w-[6.75rem]">
        <Select aria-label="Via" value={filters.via} onChange={event => set('via', event.target.value as ViaFilter)}>
          <option value="all">Any source</option>
          <option value="discord">Discord</option>
          <option value="web">Web</option>
          <option value="system">System</option>
          <option value="cli">CLI</option>
        </Select>
      </span>
      <span className="lists-select shrink-0 w-[6.75rem]">
        <Select aria-label="Match" value={filters.match} onChange={event => set('match', event.target.value as MatchFilter)}>
          <option value="all">All matches</option>
          <option value="M1">M1</option>
          <option value="M2">M2</option>
          <option value="none">No match</option>
        </Select>
      </span>
      <span className="lists-select shrink-0 w-[8.25rem]">
        <Select aria-label="Command type" value={filters.type} onChange={event => set('type', event.target.value)}>
          <option value="all">All commands</option>
          {types.map(type => <option key={type} value={type}>{type}</option>)}
          {filters.type !== 'all' && !types.includes(filters.type) && <option value={filters.type}>{filters.type}</option>}
        </Select>
      </span>
      <span className="ml-auto flex items-center gap-1.5 text-2xs text-fg-subtle tabular-nums" aria-live="polite">
        {active ? `${shown} of ${loaded}` : `${loaded} loaded`}
        {active && <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => onChange(EMPTY_AUDIT_FILTERS)}>Clear</Button>}
      </span>
    </div>
  );
}

export function AuditTab({ snapshot }: { snapshot: EventSnapshotDto }) {
  const audit = useAudit(snapshot.eventId);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [selected, setSelected] = useState<number | null>(null);
  const types = useMemo(() => commandTypes(audit.entries), [audit.entries]);
  const rows = useMemo(() => filterAudit(audit.entries, filters, snapshot), [audit.entries, filters, snapshot]);
  const selectedEntry = selected === null ? undefined : audit.entries.find(entry => entry.sequence === selected);

  const columns = useMemo<Array<Column<AuditEntryDto>>>(() => [
    { id: 'expand', header: <span className="sr-only">Details</span>, width: '22px',
      cell: entry => (
        <ChevronRight aria-hidden className={cx('inline size-3 text-fg-subtle transition-transform duration-150',
          entry.sequence === selected && 'rotate-90 text-accent-text')} />
      ) },
    { id: 'sequence', header: '#', numeric: true, width: '44px', descFirst: true, sortValue: entry => entry.sequence,
      cell: entry => <span className="text-fg-muted">{entry.sequence}</span> },
    { id: 'time', header: 'Time', descFirst: true, sortValue: entry => entry.occurredAtMs,
      cell: entry => (
        <time dateTime={new Date(entry.occurredAtMs).toISOString()} className="text-fg-muted">{formatTimeOfDay(entry.occurredAtMs)}</time>
      ) },
    { id: 'actor', header: 'Actor', sortValue: entry => formatAuditEntry(entry, snapshot).actorLabel,
      cell: entry => <ActorCell entry={entry} snapshot={snapshot} /> },
    { id: 'via', header: 'Via', sortValue: entry => entry.via,
      cell: entry => <ToneBadge tone={VIA_TONE[entry.via]} mono>{entry.via}</ToneBadge> },
    { id: 'command', header: 'Command', sortValue: entry => entry.command.type,
      cell: entry => <CommandCell entry={entry} /> },
    { id: 'match', header: 'Match', sortValue: entry => entry.command.matchId ?? null,
      cell: entry => (entry.command.matchId ? <ToneBadge mono>{entry.command.matchId}</ToneBadge> : <None label="No match" />) },
    { id: 'result', header: 'Result', sortValue: entry => entry.result,
      cell: entry => <span className="block max-w-[12rem] truncate font-mono text-2xs text-fg-muted" title={entry.result}>{entry.result}</span> }
  ], [selected, snapshot]);

  if (audit.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center" role="status">
        <EmptyState compact icon={<FileClock />} title="Loading audit…" description="Fetching the event's applied changes." />
      </div>
    );
  }
  if (audit.error && audit.entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center" role="alert">
        <EmptyState compact icon={<FileClock />} title="Could not load the audit" description={audit.error.message} />
      </div>
    );
  }

  const filtered = hasActiveFilters(filters);
  if (audit.entries.length === 0 && !audit.hasOlder && !audit.hasMore) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1">
        <EmptyState compact icon={<History />} title="No applied changes yet"
          description="Commands appear here once they change the event. Rejected and no-op attempts are never stored." />
        {audit.live && <Chip tone="success" dot live className="h-5 px-2 text-2xs">Live</Chip>}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <FilterBar filters={filters} onChange={setFilters} types={types} shown={rows.length} loaded={audit.entries.length} />
      <DataTable<AuditEntryDto> dense className="lists-table min-h-[7rem] flex-1" columns={columns} rows={rows}
        getRowId={entry => String(entry.sequence)} defaultSort={DEFAULT_SORT}
        label="Audit log, newest first. Press Enter on a row to show its raw JSON."
        onRowActivate={entry => setSelected(current => (current === entry.sequence ? null : entry.sequence))}
        isRowSelected={entry => entry.sequence === selected}
        empty={filtered
          ? <EmptyState compact icon={<Search />} title="No entries match"
            description="Try another search or clear the filters."
            action={<Button size="sm" onClick={() => setFilters(EMPTY_AUDIT_FILTERS)}>Clear filters</Button>} />
          : <EmptyState compact icon={<History />} title="No applied changes yet"
            description="Commands appear here once they change the event." />} />
      {selectedEntry && <AuditDetail entry={selectedEntry} snapshot={snapshot} onClose={() => setSelected(null)} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-0.5">
        {audit.live && <Chip tone="success" dot live className="h-5 px-2 text-2xs">Live</Chip>}
        <p className="min-w-0 flex-1 text-2xs text-fg-subtle">
          <Terminal aria-hidden className="mr-1 inline size-3 align-[-2px]" />
          Only applied changes are stored; rejected and no-op attempts never appear.
        </p>
        {audit.pageError && <p role="alert" className="text-2xs font-medium text-danger">{audit.pageError.message}</p>}
        <div className="flex items-center gap-1.5">
          {audit.hasMore && (
            <Button size="sm" onClick={() => void audit.fetchMore()} loading={audit.isFetchingMore}>Load newer</Button>
          )}
          {audit.hasOlder && (
            <Button size="sm" onClick={() => void audit.fetchOlder()} loading={audit.isFetchingOlder}>Load older</Button>
          )}
        </div>
      </div>
    </div>
  );
}
