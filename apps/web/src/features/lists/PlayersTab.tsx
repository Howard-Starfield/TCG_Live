// Players tab: seats (or the signup roster before seats exist) with check-in, match and standings.
import type { EventSnapshotDto } from '@tcg-live/core';
import { Check, Users, X } from 'lucide-react';
import { useMemo } from 'react';
import { DataTable, EmptyState, type Column } from '../../ui';
import { memberName } from '../../data';
import { hasSeats, playerRows, type PlayerRow } from './model';
import { MemberName, None, SeatTag, StatusChip, ToneBadge } from './shared';

const SIGNUP_LABEL = { roster: 'In roster', assigned: 'Assigned', seated: 'Seated' } as const;
const STATUS_ORDER = { danger: 0, warning: 1, accent: 2, success: 3, neutral: 4 } as const;

function summary(snapshot: EventSnapshotDto): string {
  const signup = snapshot.signup;
  if (signup?.status === 'open') return `Signup open · ${signup.roster.length} of ${signup.capacity} joined · seats are assigned when signup closes`;
  const seated = Object.values(snapshot.seats).filter(Boolean).length;
  return `${seated} seated · ${snapshot.checkins.length} checked in${snapshot.published ? ' · round published' : ''}`;
}

export function PlayersTab({ snapshot }: { snapshot: EventSnapshotDto }) {
  const rows = useMemo(() => playerRows(snapshot), [snapshot]);
  const seated = hasSeats(snapshot);

  const columns = useMemo<Array<Column<PlayerRow>>>(() => {
    const list: Array<Column<PlayerRow>> = [];
    if (seated) {
      list.push({ id: 'seat', header: 'Seat', width: '52px', sortValue: row => row.seat,
        cell: row => (row.seat ? <SeatTag seat={row.seat} /> : <None />) });
    } else {
      list.push({ id: 'position', header: '#', width: '40px', numeric: true, sortValue: row => row.rosterPosition,
        cell: row => row.rosterPosition ?? <None /> });
    }
    list.push(
      { id: 'member', header: 'Member', sortValue: row => (row.memberId ? memberName(snapshot, row.memberId) : null),
        cell: row => <MemberName snapshot={snapshot} memberId={row.memberId} /> },
      { id: 'signup', header: 'Signup', sortValue: row => row.rosterPosition,
        cell: row => (
          <span className="inline-flex items-center gap-1.5 text-fg-muted">
            {SIGNUP_LABEL[row.signup]}
            {row.signup === 'assigned' && row.rosterPosition !== null && (
              <span className="text-fg-subtle" title="Join order">#{row.rosterPosition}</span>
            )}
          </span>
        ) },
      { id: 'checkin', header: 'Check-in', align: 'center', sortValue: row => (row.checkedIn === null ? null : row.checkedIn ? 1 : 0),
        cell: row => (row.checkedIn === null ? <None label="Not applicable" />
          : row.checkedIn ? <Check aria-label="Checked in" role="img" className="inline size-3.5 text-success" />
            : <X aria-label="Not checked in" role="img" className="inline size-3.5 text-fg-subtle" />) },
      { id: 'match', header: 'Match', sortValue: row => row.match?.id ?? null,
        cell: row => (row.match && seated ? <ToneBadge mono>{row.match.id}</ToneBadge> : <None />) },
      { id: 'points', header: 'Pts', numeric: true, descFirst: true, sortValue: row => row.standing?.points ?? null,
        cell: row => row.standing?.points ?? <None /> },
      { id: 'rating', header: 'Rating', numeric: true, descFirst: true, sortValue: row => row.standing?.rating ?? null,
        cell: row => row.standing?.rating ?? <None /> },
      { id: 'status', header: 'Status', sortValue: row => STATUS_ORDER[row.status.tone],
        cell: row => <StatusChip meta={row.status} /> }
    );
    return list;
  }, [seated, snapshot]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="truncate px-0.5 text-xs text-fg-muted">{summary(snapshot)}</p>
      <DataTable<PlayerRow> label={seated ? 'Players by seat' : 'Signup roster in join order'} dense
        className="lists-table flex-1" columns={columns} rows={rows} getRowId={row => row.key}
        empty={<EmptyState compact icon={<Users />} title="No one has joined yet"
          description="Members appear here as they join the signup in Discord." />} />
    </div>
  );
}
