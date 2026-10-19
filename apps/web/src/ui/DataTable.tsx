import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';

export type SortDirection = 'asc' | 'desc';
export interface SortState { columnId: string; direction: SortDirection }

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable by this value (null sorts last). */
  sortValue?: (row: T) => string | number | null;
  /** Right-aligns and uses tabular numbers. */
  numeric?: boolean;
  align?: 'start' | 'center' | 'end';
  /** CSS width, e.g. "72px" or "20%". */
  width?: string;
  /** First click sorts descending (useful for scores and times). */
  descFirst?: boolean;
}

export interface DataTableProps<T> {
  /** Accessible name (rendered as a visually hidden caption). */
  label: string;
  columns: Array<Column<T>>;
  rows: T[];
  getRowId: (row: T) => string;
  /** Controlled sort; pair with onSortChange. */
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Click, Enter or Space on a row; rows become focusable when set. */
  onRowActivate?: (row: T) => void;
  /** Highlights a row (for example the one open in a detail view). */
  isRowSelected?: (row: T) => boolean;
  /** Shown instead of the body when there are no rows. */
  empty?: ReactNode;
  dense?: boolean;
  className?: string;
}

/** Stable sort by a column's sortValue; nulls always last. */
export function sortRows<T>(rows: T[], column: Column<T> | undefined, direction: SortDirection): T[] {
  if (!column?.sortValue) return rows;
  const value = column.sortValue;
  const factor = direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
      const order = typeof a.key === 'number' && typeof b.key === 'number'
        ? a.key - b.key
        : String(a.key).localeCompare(String(b.key), undefined, { numeric: true, sensitivity: 'base' });
      return order === 0 ? a.index - b.index : order * factor;
    })
    .map(entry => entry.row);
}

const ALIGN = { start: 'text-left', center: 'text-center', end: 'text-right' } as const;

/** Data table with sortable headers (`aria-sort`), a sticky header and optional row activation. */
export function DataTable<T>({ label, columns, rows, getRowId, sort, defaultSort = null, onSortChange, onRowActivate, isRowSelected, empty, dense = false, className }: DataTableProps<T>) {
  const [internalSort, setInternalSort] = useState<SortState | null>(defaultSort);
  const activeSort = sort === undefined ? internalSort : sort;
  const sortedRows = useMemo(() => {
    if (!activeSort) return rows;
    return sortRows(rows, columns.find(column => column.id === activeSort.columnId), activeSort.direction);
  }, [activeSort, columns, rows]);

  const toggleSort = (column: Column<T>) => {
    const first: SortDirection = column.descFirst ? 'desc' : 'asc';
    const next: SortState = activeSort?.columnId === column.id
      ? { columnId: column.id, direction: activeSort.direction === 'asc' ? 'desc' : 'asc' }
      : { columnId: column.id, direction: first };
    if (sort === undefined) setInternalSort(next);
    onSortChange?.(next);
  };

  const cellPad = dense ? 'px-2.5 py-1' : 'px-3 py-[7px]';
  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowActivate?.(row);
    }
  };

  return (
    <div className={cx('relative min-h-0 overflow-auto rounded-lg bg-raised shadow-[inset_0_0_0_1px_var(--color-line)]', className)}>
      <table className="w-full border-separate border-spacing-0 text-xs tabular-nums">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            {columns.map(column => {
              const sorted = activeSort?.columnId === column.id ? activeSort.direction : null;
              const align = column.align ?? (column.numeric ? 'end' : 'start');
              return (
                <th key={column.id} scope="col" style={{ width: column.width }}
                  aria-sort={column.sortValue ? (sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none') : undefined}
                  className={cx('sticky top-0 z-[1] whitespace-nowrap border-b border-line bg-raised font-medium text-fg-subtle first:rounded-tl-lg last:rounded-tr-lg',
                    dense ? 'px-2.5 py-1.5' : 'px-3 py-2', 'text-2xs', ALIGN[align])}>
                  {column.sortValue ? (
                    <button type="button" onClick={() => toggleSort(column)}
                      className={cx('-mx-1 inline-flex items-center gap-1 rounded-[5px] px-1 py-0.5 hover:bg-line-faint hover:text-fg',
                        sorted && 'text-fg', align === 'end' && 'flex-row-reverse')}>
                      {column.header}
                      {sorted === 'asc' ? <ArrowUp aria-hidden className="size-3" /> : sorted === 'desc' ? <ArrowDown aria-hidden className="size-3" />
                        : <ChevronsUpDown aria-hidden className="size-3 opacity-50" />}
                    </button>
                  ) : column.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-fg-subtle">{empty ?? 'Nothing to show yet.'}</td>
            </tr>
          ) : sortedRows.map(row => {
            const selected = isRowSelected?.(row) ?? false;
            return (
              <tr key={getRowId(row)} aria-current={selected || undefined} data-selected={selected || undefined}
                tabIndex={onRowActivate ? 0 : undefined}
                onClick={onRowActivate ? () => onRowActivate(row) : undefined}
                onKeyDown={onRowActivate ? event => onRowKeyDown(event, row) : undefined}
                className={cx('group/row text-fg [&:last-child>td]:border-b-0', onRowActivate && 'cursor-pointer outline-none',
                  selected ? '[&>td]:bg-accent-soft' : onRowActivate ? 'hover:[&>td]:bg-line-faint focus-visible:[&>td]:bg-line-faint' : 'hover:[&>td]:bg-line-faint/60')}>
                {columns.map(column => (
                  <td key={column.id}
                    className={cx('whitespace-nowrap border-b border-line-faint', cellPad, ALIGN[column.align ?? (column.numeric ? 'end' : 'start')],
                      'group-focus-visible/row:first:shadow-[inset_2px_0_0_var(--color-accent)]')}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
