import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, sortRows, type Column } from './DataTable';

interface Row { seat: string; name: string; points: number | null }
const rows: Row[] = [
  { seat: 'C', name: 'Gary', points: 3 },
  { seat: 'A', name: 'Ash', points: 0 },
  { seat: 'D', name: 'Brock', points: null },
  { seat: 'B', name: 'misty', points: 1 }
];
const columns: Array<Column<Row>> = [
  { id: 'seat', header: 'Seat', sortValue: row => row.seat, cell: row => row.seat },
  { id: 'name', header: 'Name', sortValue: row => row.name, cell: row => row.name },
  { id: 'points', header: 'Pts', numeric: true, descFirst: true, sortValue: row => row.points, cell: row => row.points ?? '—' },
  { id: 'note', header: 'Note', cell: () => 'n/a' }
];

const bodySeats = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row').map(row => within(row).getAllByRole('cell')[0]!.textContent);

describe('sortRows', () => {
  it('sorts case-insensitively, keeps nulls last and is stable', () => {
    expect(sortRows(rows, columns[1], 'asc').map(row => row.name)).toEqual(['Ash', 'Brock', 'Gary', 'misty']);
    expect(sortRows(rows, columns[2], 'desc').map(row => row.points)).toEqual([3, 1, 0, null]);
    expect(sortRows(rows, columns[2], 'asc').map(row => row.points)).toEqual([0, 1, 3, null]);
  });
});

describe('DataTable', () => {
  it('sorts by header buttons and reports aria-sort', async () => {
    const user = userEvent.setup();
    render(<DataTable label="Players" columns={columns} rows={rows} getRowId={row => row.seat} />);
    expect(screen.getByRole('table', { name: 'Players' })).toBeInTheDocument();
    const seatHeader = screen.getByRole('columnheader', { name: /seat/i });
    expect(seatHeader).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Note' })).not.toHaveAttribute('aria-sort');
    expect(bodySeats()).toEqual(['C', 'A', 'D', 'B']);

    await user.click(within(seatHeader).getByRole('button'));
    expect(seatHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(bodySeats()).toEqual(['A', 'B', 'C', 'D']);

    await user.click(within(seatHeader).getByRole('button'));
    expect(seatHeader).toHaveAttribute('aria-sort', 'descending');
    expect(bodySeats()).toEqual(['D', 'C', 'B', 'A']);

    const pointsHeader = screen.getByRole('columnheader', { name: /pts/i });
    await user.click(within(pointsHeader).getByRole('button'));
    expect(pointsHeader).toHaveAttribute('aria-sort', 'descending');
    expect(seatHeader).toHaveAttribute('aria-sort', 'none');
    expect(bodySeats()).toEqual(['C', 'B', 'A', 'D']);
  });

  it('supports controlled sorting', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(<DataTable label="Players" columns={columns} rows={rows} getRowId={row => row.seat}
      sort={{ columnId: 'name', direction: 'asc' }} onSortChange={onSortChange} />);
    expect(bodySeats()).toEqual(['A', 'D', 'C', 'B']);
    await user.click(within(screen.getByRole('columnheader', { name: /name/i })).getByRole('button'));
    expect(onSortChange).toHaveBeenCalledWith({ columnId: 'name', direction: 'desc' });
    expect(bodySeats()).toEqual(['A', 'D', 'C', 'B']);
  });

  it('activates rows by click, Enter and Space', async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    render(<DataTable label="Players" columns={columns} rows={rows} getRowId={row => row.seat} onRowActivate={onRowActivate}
      isRowSelected={row => row.seat === 'A'} />);
    const rowsInBody = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row');
    await user.click(rowsInBody[0]!);
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[0]);
    rowsInBody[1]!.focus();
    await user.keyboard('{Enter}');
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[1]);
    await user.keyboard(' ');
    expect(onRowActivate).toHaveBeenCalledTimes(3);
    expect(rowsInBody[1]).toHaveAttribute('aria-current', 'true');
    expect(rowsInBody[0]).not.toHaveAttribute('aria-current');
  });

  it('shows the empty state', () => {
    render(<DataTable label="Matches" columns={columns} rows={[]} getRowId={row => row.seat} empty="No matches yet" />);
    expect(screen.getByRole('cell', { name: 'No matches yet' })).toHaveAttribute('colspan', '4');
  });
});
