// Evidence & moderation audit (tcg_ops_audit), separate from the match command audit. Newest first;
// the server pages oldest first after a cursor, so "Load newer" follows it.
import { type EventSnapshotDto, type OpsAuditEntryDto, type OpsAuditKind } from '@tcg-live/core';
import { History, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatTimeOfDay, useSession } from '../../data';
import { Button, DataTable, EmptyState, Select, type Column } from '../../ui';
import { None, ToneBadge } from '../lists/shared';
import { useOpsAuditFeed } from './api';

/** True when this session may read the ops audit (GET /ops/audit needs evidence.read). */
export function useOpsAuditAccess(): boolean {
  const session = useSession();
  // GET /ops/audit is mounted with the moderation routes (it checks evidence.read).
  const mounted = session.session?.moderation === true;
  return mounted && session.hasCapability('evidence.read');
}

const KIND_TONE = (kind: OpsAuditKind) => (kind.startsWith('evidence.deleted') || kind === 'evidence.failed' ? 'danger'
  : kind.startsWith('evidence') ? 'accent' : kind.startsWith('voice') ? 'warning' : 'neutral');

export function summarizePayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
}

export function OpsAuditView({ snapshot, pageLimit = 200 }: { snapshot: EventSnapshotDto; pageLimit?: number }) {
  const [scope, setScope] = useState<'event' | 'all'>('event');
  const feed = useOpsAuditFeed({ enabled: true, limit: pageLimit, ...(scope === 'event' ? { eventId: snapshot.eventId } : {}) });
  const rows = useMemo(() => [...feed.items].reverse(), [feed.items]);
  const columns = useMemo<Array<Column<OpsAuditEntryDto>>>(() => [
    { id: 'id', header: '#', numeric: true, width: '44px', cell: entry => <span className="text-fg-muted">{entry.id}</span> },
    { id: 'time', header: 'Time', cell: entry => <time dateTime={new Date(entry.occurredAtMs).toISOString()} className="text-fg-muted">{formatTimeOfDay(entry.occurredAtMs)}</time> },
    { id: 'kind', header: 'Kind', cell: entry => <ToneBadge tone={KIND_TONE(entry.kind)} mono>{entry.kind}</ToneBadge> },
    { id: 'actor', header: 'Actor', cell: entry => <span className="text-fg">{entry.actorKind === 'admin' ? 'Admin' : entry.actorKind === 'bot' ? 'Bot'
      : entry.actorKind === 'system' ? 'System' : `Player …${entry.actorId.slice(-4)}`}</span> },
    { id: 'match', header: 'Match', cell: entry => (typeof entry.payload.matchId === 'string'
      ? <ToneBadge mono>{entry.payload.matchId}</ToneBadge> : <None label="No match" />) },
    { id: 'detail', header: 'Detail', cell: entry => {
      const text = summarizePayload(entry.payload);
      return <span className="block max-w-[18rem] truncate font-mono text-2xs text-fg-muted" title={JSON.stringify(entry.payload)}>{text}</span>;
    } }
  ], []);

  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    <div className="flex items-center gap-1.5">
      <span className="lists-select w-[9rem] shrink-0">
        <Select aria-label="Audit scope" value={scope} onChange={event => setScope(event.target.value as 'event' | 'all')}>
          <option value="event">This event</option>
          <option value="all">All (incl. settings)</option>
        </Select>
      </span>
      <span className="ml-auto flex items-center gap-1.5 text-2xs tabular-nums text-fg-subtle">
        {feed.items.length} loaded
        <Button size="sm" variant="ghost" className="h-6 px-2" icon={<RefreshCw aria-hidden />} onClick={() => void feed.refresh()}>Refresh</Button>
      </span>
    </div>
    {feed.loading ? <div role="status" className="flex flex-1 items-center justify-center"><EmptyState compact icon={<History />} title="Loading audit…" /></div>
      : feed.error && feed.items.length === 0 ? <div role="alert" className="flex flex-1 items-center justify-center">
        <EmptyState compact icon={<History />} title={feed.unavailable ? 'Not available yet' : 'Could not load the audit'} description={feed.error} />
      </div>
        : <DataTable<OpsAuditEntryDto> dense className="lists-table min-h-[7rem] flex-1" columns={columns} rows={rows}
          getRowId={entry => String(entry.id)} label="Evidence and moderation audit, newest first"
          empty={<EmptyState compact icon={<History />} title="Nothing recorded yet"
            description="Evidence submissions, views, deletions, holds and moderation changes appear here." />} />}
    {feed.error && feed.items.length > 0 && <p role="alert" className="text-2xs font-medium text-danger">{feed.error}</p>}
    {feed.hasMore && <div className="flex justify-end"><Button size="sm" loading={feed.loadingMore} onClick={() => void feed.loadMore()}>Load newer</Button></div>}
  </div>;
}
