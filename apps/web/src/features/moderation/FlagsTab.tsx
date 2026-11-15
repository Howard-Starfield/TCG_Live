// Flags tab: keyword (AutoMod) and volume flags, newest first. The server pages oldest first after a
// cursor, so the tab follows the cursor ("Load newer") and polls with backoff once caught up; the
// stream does not carry flags. Each flag can be acknowledged, dismissed or reopened (audited on the server),
// its member moderated, and the list exported as CSV or JSON.
import type { EventSnapshotDto, MatchId, ModerationFlagDto, ModerationFlagKind, ModerationFlagReviewDto,
  ModerationFlagReviewState } from '@tcg-live/core';
import { Check, FileVideo, Flag, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatTimeOfDay, memberName, useAdminData, type ApiClient } from '../../data';
import { Button, Chip, DataTable, EmptyState, IconButton, Select, Tooltip, type Column } from '../../ui';
import { collectPages, ExportButtons, type ExportRow } from '../admin-tools/shared/exportData';
import { ModerateMembersMenu } from '../admin-tools/members/ModerateMembersMenu';
import { EvidenceDrawer, useEvidenceAccess } from '../evidence';
import { describeError } from '../evidence/api';
import { None, ToneBadge } from '../lists/shared';
import { getFlagPage, useFlagFeed, useModerationAccess } from './api';

export const FLAG_POLL = { minMs: 5_000, maxMs: 60_000 } as const;

type KindFilter = 'all' | ModerationFlagKind;
type MatchFilter = 'all' | 'none' | MatchId;
/** 'open': not yet acknowledged or dismissed. */
export type ReviewFilter = 'all' | 'open' | ModerationFlagReviewState;

export function filterFlags(flags: readonly ModerationFlagDto[], kind: KindFilter, match: MatchFilter, review: ReviewFilter = 'all'): ModerationFlagDto[] {
  return flags.filter(flag => (kind === 'all' || flag.kind === kind)
    && (match === 'all' || (match === 'none' ? flag.matchId === null : flag.matchId === match))
    && (review === 'all' || (review === 'open' ? !flag.review : flag.review?.state === review)));
}

/** PATCH /moderation/flags/:id; null reopens. */
export const reviewFlag = (api: ApiClient, id: number, state: ModerationFlagReviewState | null) =>
  api.request<ModerationFlagDto>('PATCH', `/moderation/flags/${id}`, { body: { state } });

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

const REVIEW_LABEL: Record<ModerationFlagReviewState, string> = { acknowledged: 'Acknowledged', dismissed: 'Dismissed' };

function ReviewCell({ flag, pending, onReview }: { flag: ModerationFlagDto; pending: boolean; onReview(state: ModerationFlagReviewState | null): void }) {
  const review = flag.review;
  if (review) {
    return <span className="inline-flex items-center gap-1">
      <ToneBadge tone={review.state === 'acknowledged' ? 'success' : 'neutral'} title={`${REVIEW_LABEL[review.state]} at ${formatTimeOfDay(review.atMs)}`}>
        {REVIEW_LABEL[review.state]}</ToneBadge>
      <Tooltip content="Reopen" describe={false}>
        <IconButton size="sm" aria-label={`Reopen flag ${flag.id}`} disabled={pending} icon={<RotateCcw aria-hidden />} onClick={() => onReview(null)} />
      </Tooltip>
    </span>;
  }
  return <span className="inline-flex items-center gap-1">
    <Tooltip content="Acknowledge: seen and handled" describe={false}>
      <IconButton size="sm" aria-label={`Acknowledge flag ${flag.id}`} disabled={pending} icon={<Check aria-hidden />} onClick={() => onReview('acknowledged')} />
    </Tooltip>
    <Tooltip content="Dismiss: not a problem" describe={false}>
      <IconButton size="sm" aria-label={`Dismiss flag ${flag.id}`} disabled={pending} icon={<X aria-hidden />} onClick={() => onReview('dismissed')} />
    </Tooltip>
  </span>;
}

export function FlagsTab({ snapshot, pageLimit = 100 }: { snapshot: EventSnapshotDto; pageLimit?: number }) {
  const allowed = useModerationAccess();
  const evidence = useEvidenceAccess().read;
  const { api } = useAdminData();
  const feed = useFlagFeed({ enabled: allowed, limit: pageLimit, poll: FLAG_POLL });
  const [kind, setKind] = useState<KindFilter>('all');
  const [match, setMatch] = useState<MatchFilter>('all');
  const [review, setReview] = useState<ReviewFilter>('all');
  const [drawer, setDrawer] = useState<MatchId | null>(null);
  // Reviews saved in this tab, by flag ID (the feed only appends; a reload reads them from the server).
  const [reviews, setReviews] = useState<Record<number, ModerationFlagReviewDto | null>>({});
  const [pending, setPending] = useState<number | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const items = useMemo(() => feed.items.map(flag => (flag.id in reviews ? { ...flag, review: reviews[flag.id] ?? null } : flag)), [feed.items, reviews]);
  const rows = useMemo(() => filterFlags(items, kind, match, review).reverse(), [items, kind, match, review]);
  const openCount = items.filter(flag => !flag.review).length;

  const columns = useMemo<Array<Column<ModerationFlagDto>>>(() => {
    const save = async (flag: ModerationFlagDto, state: ModerationFlagReviewState | null) => {
      setPending(flag.id); setReviewError(null);
      try {
        const saved = await reviewFlag(api, flag.id, state);
        setReviews(current => ({ ...current, [flag.id]: saved.review ?? null }));
      } catch (cause) { setReviewError(describeError(cause, 'The flag could not be updated.')); }
      finally { setPending(null); }
    };
    return [
      { id: 'time', header: 'Time', cell: flag => <time dateTime={new Date(flag.occurredAtMs).toISOString()} className="text-fg-muted">{formatTimeOfDay(flag.occurredAtMs)}</time> },
      { id: 'kind', header: 'Kind', cell: flag => <ToneBadge tone={flag.kind === 'volume' ? 'warning' : 'accent'}>{flag.kind}</ToneBadge> },
      { id: 'match', header: 'Match', cell: flag => (flag.matchId ? <ToneBadge mono>{flag.matchId}</ToneBadge> : <None label="No match" />) },
      { id: 'who', header: 'Member', cell: flag => (flag.userId ? <span className="truncate text-fg">{memberName(snapshot, flag.userId)}</span> : <None label="Unknown" />) },
      { id: 'detail', header: 'Detail', cell: flag => <Detail flag={flag} /> },
      { id: 'review', header: 'Review', cell: flag => <ReviewCell flag={flag} pending={pending === flag.id} onReview={state => void save(flag, state)} /> },
      { id: 'actions', header: <span className="sr-only">Actions</span>, width: '128px', align: 'end' as const,
        cell: (flag: ModerationFlagDto) => <span className="inline-flex items-center gap-1">
          {flag.userId && <ModerateMembersMenu members={[{ id: flag.userId, name: memberName(snapshot, flag.userId) }]}
            eventId={flag.eventId} matchId={flag.matchId} />}
          {evidence && flag.matchId && flag.eventId === snapshot.eventId
            && <Button size="sm" variant="ghost" icon={<FileVideo aria-hidden />} className="h-6 px-1.5"
              aria-label={`Open evidence for ${flag.matchId}`} onClick={() => setDrawer(flag.matchId)}>Evidence</Button>}
        </span> }
    ];
  }, [api, evidence, pending, snapshot]);

  const collect = () => collectPages<number>(0, async after => {
    const page = await getFlagPage(api, after, 200);
    return { rows: page.flags.map(flag => ({ ...flag, member: flag.userId ? memberName(snapshot, flag.userId) : null })) as unknown as ExportRow[],
      next: page.flags.length ? page.nextAfter : null };
  });

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
      <span className="lists-select w-[8.5rem] shrink-0">
        <Select aria-label="Flag review" value={review} onChange={event => setReview(event.target.value as ReviewFilter)}>
          <option value="all">Any review</option>
          <option value="open">Open ({openCount})</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="dismissed">Dismissed</option>
        </Select>
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1.5 text-2xs tabular-nums text-fg-subtle">
        {rows.length} of {feed.items.length}
        <Chip tone={feed.error ? 'warning' : 'success'} dot live={!feed.error} className="h-5 px-2 text-2xs">{feed.error ? 'Retrying' : 'Auto-refresh'}</Chip>
        <Button size="sm" variant="ghost" className="h-6 px-2" icon={<RefreshCw aria-hidden />} onClick={() => void feed.refresh()}>Refresh</Button>
        <ExportButtons name="flags" label="flags" collect={collect} />
      </span>
    </div>
    <DataTable<ModerationFlagDto> dense className="lists-table min-h-[7rem] flex-1" columns={columns} rows={rows}
      getRowId={flag => String(flag.id)} label="Moderation flags, newest first"
      empty={<EmptyState compact icon={<Flag />} title={feed.items.length ? 'No flags match' : 'No flags yet'}
        description="Blocked or flagged messages and loud voice moments appear here." />} />
    {reviewError && <p role="alert" className="text-2xs font-medium text-danger">{reviewError}</p>}
    {feed.error && <p role="alert" className="text-2xs font-medium text-danger">{feed.error}</p>}
    {feed.hasMore && <div className="flex justify-end">
      <Button size="sm" loading={feed.loadingMore} onClick={() => void feed.loadMore()}>Load newer flags</Button>
    </div>}
    {drawer && <EvidenceDrawer open onClose={() => setDrawer(null)} snapshot={snapshot} matchId={drawer} />}
  </div>;
}
