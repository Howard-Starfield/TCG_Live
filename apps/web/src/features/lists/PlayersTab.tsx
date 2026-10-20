// Players tab: seats (or the signup roster before seats exist) with check-in, match and standings.
// Narrow panes: Status sits right after Member, and lower-priority columns drop out as the pane
// narrows (PLAYER_COLUMN_MIN_WIDTH), so seat, member and status stay visible down to about 360 px.
import type { EventSnapshotDto } from '@tcg-live/core';
import { Check, Users, X } from 'lucide-react';
import { useMemo } from 'react';
import { DataTable, EmptyState, type Column } from '../../ui';
import { memberName } from '../../data';
import { hasSeats, playerRows, type PlayerRow } from './model';
import { MemberName, None, ScrollCue, SeatTag, StatusChip, ToneBadge, useElementWidth } from './shared';

const SIGNUP_LABEL = { roster: 'In roster', assigned: 'Assigned', seated: 'Seated' } as const;
const STATUS_ORDER = { danger: 0, warning: 1, accent: 2, success: 3, neutral: 4 } as const;

/** Container width (px) from which each optional column is shown; lower-priority columns need more. */
export const PLAYER_COLUMN_MIN_WIDTH = { points: 330, checkin: 420, match: 480, rating: 540, signup: 620 } as const;
/** Below this width member names truncate sooner. */
const COMPACT_BELOW = 480;

type OptionalColumn = keyof typeof PLAYER_COLUMN_MIN_WIDTH;

function summary(snapshot: EventSnapshotDto): string {
  const signup = snapshot.signup;
  if (signup?.status === 'open') return `Signup open · ${signup.roster.length} of ${signup.capacity} joined · seats are assigned when signup closes`;
  const seated = Object.values(snapshot.seats).filter(Boolean).length;
  return `${seated} seated · ${snapshot.checkins.length} checked in${snapshot.published ? ' · round published' : ''}`;
}

export function PlayersTab({ snapshot }: { snapshot: EventSnapshotDto }) {
  const rows = useMemo(() => playerRows(snapshot), [snapshot]);
  const seated = hasSeats(snapshot);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const fits = (column: OptionalColumn) => width === null || width >= PLAYER_COLUMN_MIN_WIDTH[column];
  const compact = width !== null && width < COMPACT_BELOW;
  const visible = (['points', 'checkin', 'match', 'rating', 'signup'] as const).filter(fits);
  const key = visible.join(',');

  const columns = useMemo<Array<Column<PlayerRow>>>(() => {
    const show = new Set<OptionalColumn>(key ? key.split(',') as OptionalColumn[] : []);
    const list: Array<Column<PlayerRow>> = [];
    if (seated) {
      list.push({ id: 'seat', header: 'Seat', width: '48px', sortValue: row => row.seat,
        cell: row => (row.seat ? <SeatTag seat={row.seat} /> : <None />) });
    } else {
      list.push({ id: 'position', header: '#', width: '36px', numeric: true, sortValue: row => row.rosterPosition,
        cell: row => row.rosterPosition ?? <None /> });
    }
    list.push(
      { id: 'member', header: 'Member', sortValue: row => (row.memberId ? memberName(snapshot, row.memberId) : null),
        cell: row => <MemberName snapshot={snapshot} memberId={row.memberId} compact={compact} /> },
      { id: 'status', header: 'Status', sortValue: row => STATUS_ORDER[row.status.tone],
        cell: row => <StatusChip meta={row.status} /> }
    );
    // Check-in, match and standings mean nothing before seats exist.
    if (seated && show.has('checkin')) {
      list.push({ id: 'checkin', header: 'Check-in', align: 'center', sortValue: row => (row.checkedIn ? 1 : 0),
        cell: row => (row.checkedIn ? <Check aria-label="Checked in" role="img" className="inline size-3.5 text-success" />
          : <X aria-label="Not checked in" role="img" className="inline size-3.5 text-fg-subtle" />) });
    }
    if (seated && show.has('match')) {
      list.push({ id: 'match', header: 'Match', sortValue: row => row.match?.id ?? null,
        cell: row => (row.match ? <ToneBadge mono>{row.match.id}</ToneBadge> : <None />) });
    }
    if (seated && show.has('points')) {
      list.push({ id: 'points', header: 'Pts', numeric: true, descFirst: true, sortValue: row => row.standing?.points ?? null,
        cell: row => row.standing?.points ?? <None /> });
    }
    if (seated && show.has('rating')) {
      list.push({ id: 'rating', header: 'Rating', numeric: true, descFirst: true, sortValue: row => row.standing?.rating ?? null,
        cell: row => row.standing?.rating ?? <None /> });
    }
    if (show.has('signup') || !seated) {
      list.push({ id: 'signup', header: 'Signup', sortValue: row => row.rosterPosition,
        cell: row => (
          <span className="inline-flex items-center gap-1.5 text-fg-muted">
            {SIGNUP_LABEL[row.signup]}
            {row.signup === 'assigned' && row.rosterPosition !== null && (
              <span className="text-fg-subtle" title="Join order">#{row.rosterPosition}</span>
            )}
          </span>
        ) });
    }
    return list;
  }, [compact, key, seated, snapshot]);

  return (
    <div ref={measure} className="flex min-h-0 flex-1 flex-col gap-2" data-width={width ?? undefined}>
      <p className="truncate px-0.5 text-xs text-fg-muted">{summary(snapshot)}</p>
      <ScrollCue>
        <DataTable<PlayerRow> label={seated ? 'Players by seat' : 'Signup roster in join order'} dense
          className="lists-table flex-1" columns={columns} rows={rows} getRowId={row => row.key}
          empty={<EmptyState compact icon={<Users />} title="No one has joined yet"
            description="Members appear here as they join the signup in Discord." />} />
      </ScrollCue>
    </div>
  );
}
