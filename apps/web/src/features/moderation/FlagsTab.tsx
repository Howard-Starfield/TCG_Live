// Flags tab: keyword (AutoMod) and volume flags, newest first. The server pages oldest first after a
// cursor, so the tab follows the cursor ("Load newer") and polls with backoff once caught up; the
// stream does not carry flags.
import type { EventSnapshotDto, MatchId, ModerationFlagDto, ModerationFlagKind } from '@tcg-live/core';
import { FileVideo, Flag, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatTimeOfDay, memberName } from '../../data';
import { Button, Chip, DataTable, EmptyState, Select, type Column } from '../../ui';
import { EvidenceDrawer, useEvidenceAccess } from '../evidence';
import { None, ToneBadge } from '../lists/shared';
import { useFlagFeed, useModerationAccess } from './api';

export const FLAG_POLL = { minMs: 5_000, maxMs: 60_000 } as const;

type KindFilter = 'all' | ModerationFlagKind;
type MatchFilter = 'all' | 'none' | MatchId;

export function filterFlags(flags: readonly ModerationFlagDto[], kind: KindFilter, match: MatchFilter): ModerationFlagDto[] {
  return flags.filter(flag => (kind === 'all' || flag.kind === kind)
    && (match === 'all' || (match === 'none' ? flag.matchId === null : flag.matchId === match)));
}

function Detail({ flag }: { flag: ModerationFlagDto }) {
  if (flag.kind === 'keyword') {
    const { ruleName, matchedKeyword, action } = flag.detail;
    return <span className="inline-flex min-w-0 items-center gap-1.5">
      <ToneBadge tone={action === 'flag' ? 'neutral' : 'danger'}>{action}</ToneBadge>
      <span className="truncate text-fg">{ruleName}</span>
      {matchedKeyword && <span className="truncate font-mono text-fg-subtle">“{matchedKeyword}”</span>}
    </span>;
  }
  const { peakDbfs, sustainedMs, thresholdDbfs } = flag.detail;
  return <span className="text-fg">peak {peakDbfs.toFixed(1)} dBFS for {sustainedMs} ms <span className="text-fg-subtle">(threshold {thresholdDbfs})</span></span>;
}

export function FlagsTab({ snapshot, pageLimit = 100 }: { snapshot: EventSnapshotDto; pageLimit?: number }) {
  const allowed = useModerationAccess();
  const evidence = useEvidenceAccess().read;
  const feed = useFlagFeed({ enabled: allowed, limit: pageLimit, poll: FLAG_POLL });
  const [kind, setKind] = useState<KindFilter>('all');
  const [match, setMatch] = useState<MatchFilter>('all');
  const [drawer, setDrawer] = useState<MatchId | null>(null);
  const rows = useMemo(() => filterFlags(feed.items, kind, match).reverse(), [feed.items, kind, match]);

  const columns = useMemo<Array<Column<ModerationFlagDto>>>(() => [
    { id: 'time', header: 'Time', cell: flag => <time dateTime={new Date(flag.occurredAtMs).toISOString()} className="text-fg-muted">{formatTimeOfDay(flag.occurredAtMs)}</time> },
    { id: 'kind', header: 'Kind', cell: flag => <ToneBadge tone={flag.kind === 'volume' ? 'warning' : 'accent'}>{flag.kind}</ToneBadge> },
    { id: 'match', header: 'Match', cell: flag => (flag.matchId ? <ToneBadge mono>{flag.matchId}</ToneBadge> : <None label="No match" />) },
    { id: 'who', header: 'Member', cell: flag => (flag.userId ? <span className="truncate text-fg">{memberName(snapshot, flag.userId)}</span> : <None label="Unknown" />) },
    { id: 'detail', header: 'Detail', cell: flag => <Detail flag={flag} /> },
    ...(evidence ? [{ id: 'evidence', header: <span className="sr-only">Evidence</span>, width: '96px', align: 'end' as const,
      cell: (flag: ModerationFlagDto) => (flag.matchId && flag.eventId === snapshot.eventId
        ? <Button size="sm" variant="ghost" icon={<FileVideo aria-hidden />} className="h-6 px-1.5"
          aria-label={`Open evidence for ${flag.matchId}`} onClick={() => setDrawer(flag.matchId)}>Evidence</Button> : null) }] : [])
  ], [evidence, snapshot]);

  if (!allowed) {
    return <div className="flex flex-1 items-center justify-center">
      <EmptyState compact icon={<Flag />} title="Flags are not available" description="This session cannot view moderation flags." />
    </div>;
  }
  if (feed.loading) return <div className="flex flex-1 items-center justify-center" role="status"><EmptyState compact icon={<Flag />} title="Loading flags…" /></div>;
  if (feed.error && feed.items.length === 0) {
    return <div className="flex flex-1 items-center justify-center" role="alert">
      <EmptyState compact icon={<Flag />} title={feed.unavailable ? 'Flags are not available yet' : 'Could not load flags'} description={feed.error}
        action={feed.unavailable ? undefined : <Button size="sm" onClick={() => void feed.refresh()}>Retry</Button>} />
    </div>;
  }
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    <div role="search" aria-label="Filter flags" className="flex flex-wrap items-center gap-1.5">
      <span className="lists-select w-[7.5rem] shrink-0">
        <Select aria-label="Flag kind" value={kind} onChange={event => setKind(event.target.value as KindFilter)}>
          <option value="all">All kinds</option>
          <option value="keyword">Keyword</option>
          <option value="volume">Volume</option>
        </Select>
      </span>
      <span className="lists-select w-[7.5rem] shrink-0">
        <Select aria-label="Flag match" value={match} onChange={event => setMatch(event.target.value as MatchFilter)}>
          <option value="all">All matches</option>
          {snapshot.matches.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
          <option value="none">No match</option>
        </Select>
      </span>
      <span className="ml-auto flex items-center gap-1.5 text-2xs tabular-nums text-fg-subtle">
        {rows.length} of {feed.items.length}
        <Chip tone={feed.error ? 'warning' : 'success'} dot live={!feed.error} className="h-5 px-2 text-2xs">{feed.error ? 'Retrying' : 'Auto-refresh'}</Chip>
        <Button size="sm" variant="ghost" className="h-6 px-2" icon={<RefreshCw aria-hidden />} onClick={() => void feed.refresh()}>Refresh</Button>
      </span>
    </div>
    <DataTable<ModerationFlagDto> dense className="lists-table min-h-[7rem] flex-1" columns={columns} rows={rows}
      getRowId={flag => String(flag.id)} label="Moderation flags, newest first"
      empty={<EmptyState compact icon={<Flag />} title={feed.items.length ? 'No flags match' : 'No flags yet'}
        description="Blocked or flagged messages and loud voice moments appear here." />} />
    {feed.error && <p role="alert" className="text-2xs font-medium text-danger">{feed.error}</p>}
    {feed.hasMore && <div className="flex justify-end">
      <Button size="sm" loading={feed.loadingMore} onClick={() => void feed.loadMore()}>Load newer flags</Button>
    </div>}
    {drawer && <EvidenceDrawer open onClose={() => setDrawer(null)} snapshot={snapshot} matchId={drawer} />}
  </div>;
}
