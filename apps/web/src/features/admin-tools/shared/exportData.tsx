// CSV / JSON exports generated in the browser: page through an API with a row cap, flatten rows, and save
// a file. Used by Cases, the ops audit, the event audit, Logs, ticket transcripts and Flags.
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../ui';
import { describeError } from '../../evidence/api';

/** Most rows one export collects; the file says so when there were more. */
export const EXPORT_ROW_CAP = 5000;

export type ExportRow = Record<string, unknown>;
export interface ExportResult { rows: ExportRow[]; truncated: boolean }

/** Flattens nested objects into dotted keys; arrays become JSON text. */
export function flattenRow(value: Record<string, unknown>, prefix = ''): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item === null || item === undefined) out[name] = null;
    else if (Array.isArray(item)) out[name] = JSON.stringify(item);
    else if (typeof item === 'object') Object.assign(out, flattenRow(item as Record<string, unknown>, name));
    else if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[name] = item;
    else out[name] = String(item);
  }
  return out;
}

/**
 * Cells a spreadsheet would run as a formula: = + - @ (and their full-width forms), tab or CR first, also after
 * leading spaces or newlines, which some spreadsheets trim.
 */
const FORMULA_START = /^[\s]*[=+\-@＝＋－＠]|^[\t\r]/;

/** One CSV cell: quoted when needed; cells a spreadsheet would run as a formula get a leading apostrophe. */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV with a header of every flattened key (in first-seen order), CRLF line ends. */
export function toCsv(rows: readonly ExportRow[]): string {
  const flat = rows.map(row => flattenRow(row));
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of flat) for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); columns.push(key); }
  const lines = [columns.map(csvCell).join(','), ...flat.map(row => columns.map(column => csvCell(row[column] ?? null)).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Collects pages until `next` is null or the cap is reached. `fetchPage(cursor)` returns its rows and the
 * cursor of the next page (null at the end).
 */
export async function collectPages<C>(first: C, fetchPage: (cursor: C) => Promise<{ rows: ExportRow[]; next: C | null }>,
  cap = EXPORT_ROW_CAP): Promise<ExportResult> {
  const rows: ExportRow[] = [];
  let cursor: C | null = first;
  for (let pages = 0; cursor !== null && pages < 1000; pages += 1) {
    const page: { rows: ExportRow[]; next: C | null } = await fetchPage(cursor);
    rows.push(...page.rows);
    if (rows.length >= cap) return { rows: rows.slice(0, cap), truncated: rows.length > cap || page.next !== null };
    if (page.rows.length === 0) break;
    cursor = page.next;
  }
  return { rows, truncated: false };
}

/** A safe file name stem with today's date: `tcg-live-cases-2026-11-15`. */
export function exportFileName(stem: string, extension: 'csv' | 'json', now = new Date()): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `tcg-live-${stem.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${day}.${extension}`;
}

export function saveFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportContent(result: ExportResult, format: 'csv' | 'json', meta: Record<string, unknown> = {}): string {
  // The byte-order mark makes Excel read the file as UTF-8 (member names, emoji); other tools ignore it.
  if (format === 'csv') return `\uFEFF${toCsv(result.rows)}`;
  return `${JSON.stringify({ exportedAt: new Date().toISOString(), rowCount: result.rows.length, truncated: result.truncated,
    ...(result.truncated ? { note: `Only the first ${EXPORT_ROW_CAP} rows were exported.` } : {}), ...meta, rows: result.rows }, null, 2)}\n`;
}

/** "CSV" and "JSON" buttons; collects on click, then saves. Notes when the row cap cut the export short. */
export function ExportButtons({ name, collect, label, disabled }: {
  /** File name stem, e.g. "cases". */
  name: string;
  collect(): Promise<ExportResult>;
  /** What is exported, for the accessible names ("Export cases as CSV"). */
  label: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (format: 'csv' | 'json') => {
    setBusy(format); setError(null); setNote(null);
    try {
      const result = await collect();
      saveFile(exportFileName(name, format), exportContent(result, format), format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json');
      setNote(result.truncated ? `Exported the first ${EXPORT_ROW_CAP} rows only. Narrow the filters to export the rest.`
        : `Exported ${result.rows.length} ${result.rows.length === 1 ? 'row' : 'rows'}.`);
    } catch (cause) {
      setError(describeError(cause, 'The export failed.'));
    } finally { setBusy(null); }
  };
  return <span className="inline-flex flex-wrap items-center gap-1.5">
    <Button size="sm" variant="ghost" className="h-6 px-2" icon={<Download aria-hidden />} loading={busy === 'csv'} disabled={disabled || busy !== null}
      aria-label={`Export ${label} as CSV`} onClick={() => void run('csv')}>CSV</Button>
    <Button size="sm" variant="ghost" className="h-6 px-2" icon={<Download aria-hidden />} loading={busy === 'json'} disabled={disabled || busy !== null}
      aria-label={`Export ${label} as JSON`} onClick={() => void run('json')}>JSON</Button>
    {note && <span role="status" className="text-2xs text-fg-subtle">{note}</span>}
    {error && <span role="alert" className="text-2xs text-danger">{error}</span>}
  </span>;
}
