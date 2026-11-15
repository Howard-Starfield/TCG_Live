// GET/HEAD streaming for evidence files with single-range support, so <video> can seek.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError, SECURITY_HEADERS } from '../admin/http/respond.js';

export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const SINGLE = /^bytes=(\d{0,16})-(\d{0,16})$/;

/**
 * One `bytes=a-b`, `a-` or `-n` range. Multiple ranges and malformed headers are ignored (full 200,
 * as RFC 9110 allows); a well-formed range outside the file is unsatisfiable (416).
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return { kind: 'full' };
  const value = header.trim();
  if (value.includes(',')) return { kind: 'full' };
  const match = SINGLE.exec(value);
  if (!match) return { kind: 'full' };
  const [, first, last] = match as unknown as [string, string, string];
  if (first === '' && last === '') return { kind: 'full' };
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Number(last);
  if (last !== '' && end < start) return { kind: 'full' };
  if (start >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

/** True when `target` (after resolving links) is strictly inside `root` (after resolving links). */
export async function containedRealPath(root: string, target: string): Promise<string | null> {
  let base: string;
  let full: string;
  try {
    base = await realpath(root);
    full = await realpath(target);
  } catch { return null; }
  const inside = path.relative(base, full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return full;
}

const MIME = /^[a-z]+\/[a-z0-9.+-]{1,80}$/;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export interface ServeFileInput {
  request: IncomingMessage;
  response: ServerResponse;
  head: boolean;
  download: boolean;
  root: string;
  filePath: string;
  mime: string | null;
}

/** Streams a contained file. Throws HttpError before headers are sent; after that, aborts quietly. */
export async function serveEvidenceFile(input: ServeFileInput): Promise<void> {
  const { request, response } = input;
  const notFound = () => new HttpError(404, 'not_found', 'Not found.');
  const full = await containedRealPath(input.root, input.filePath);
  if (!full) throw notFound();
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw notFound();
  const size = info.size;
  const name = path.basename(full);
  const disposition = `${input.download ? 'attachment' : 'inline'}; filename="${SAFE_NAME.test(name) ? name : 'evidence'}"`;
  const base: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'Content-Type': input.mime && MIME.test(input.mime) ? input.mime : 'application/octet-stream',
    'Content-Disposition': disposition
  };
  const rangeHeader = request.headers.range;
  const range = parseRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, size);
  if (range.kind === 'unsatisfiable') {
    throw new HttpError(416, 'bad_request', 'Requested range not satisfiable.', { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
  }
  const start = range.kind === 'partial' ? range.start : 0;
  const end = range.kind === 'partial' ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  if (response.destroyed) return;
  response.writeHead(range.kind === 'partial' ? 206 : 200, {
    ...base,
    'Content-Length': length,
    ...(range.kind === 'partial' ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  });
  if (input.head || length === 0) { response.end(); return; }
  try {
    await pipeline(createReadStream(full, { start, end }), response);
  } catch {
    if (!response.writableEnded) response.destroy();
  }
}
