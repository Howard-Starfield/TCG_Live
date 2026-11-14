// Evidence file pipeline shared by dashboard uploads and Discord attachments: stream to a temp file with
// a byte cap while hashing, sniff the type, enforce quota and free-disk floor, then move into
// data/evidence/<eventId>/<evidenceId>.<ext> and mark the row stored (or failed).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE_MIN_FREE_BYTES, EVIDENCE_QUOTA_BYTES, type EvidenceItemDto } from '@tcg-live/core';
import type { OpsActor } from '../ops/audit.js';
import { DEFAULT_EVIDENCE_DIR, parseEvidenceNote, resolveEvidencePath, type EvidenceRecord, type EvidenceStore,
  type NewFileEvidence } from './store.js';
import { SNIFF_BYTES, sniffEvidenceType } from './sniff.js';

/** Temp files live under the evidence root so the final rename never crosses volumes. */
export const EVIDENCE_TEMP_DIR = '.tmp';
/** Free space is re-checked after every this many bytes of a stream. */
const FREE_CHECK_INTERVAL = 64 * 1024 * 1024;
const STALE_TEMP_MS = 24 * 60 * 60_000;

/** A refusal whose message is safe to show; status is the HTTP status the dashboard should see. */
export class EvidenceFileError extends Error {
  constructor(readonly status: 400 | 413 | 415 | 507, message: string) { super(message); }
}

export interface EvidenceDiskOptions {
  root?: string;
  quotaBytes?: number;
  minFreeBytes?: number;
  /** Free bytes on the volume holding `root`; defaults to fs.statfs. */
  freeBytes?(root: string): Promise<number>;
  /** Bytes of stored evidence under `root` (temp files excluded); defaults to a directory walk. */
  usedBytes?(root: string): Promise<number>;
  now?: () => number;
}

export interface IngestInput {
  /** Raw bytes: an IncomingMessage, a fetch body, or any async iterable. */
  source: AsyncIterable<Uint8Array>;
  maxBytes: number;
  /** Content-Length or attachment size when known; refused up front when over the cap or the space left. */
  declaredBytes?: number | null;
  evidence: Omit<NewFileEvidence, 'extension' | 'kind'> & { kind?: NewFileEvidence['kind'] };
  store: EvidenceStore;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
export function formatBytes(bytes: number): string {
  return bytes >= GIB ? `${+(bytes / GIB).toFixed(1)} GiB` : `${Math.max(1, Math.round(bytes / MIB))} MB`;
}

export async function statfsFreeBytes(root: string): Promise<number> {
  const info = await statfs(root);
  return Number(info.bavail) * Number(info.bsize);
}

export async function walkUsedBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === EVIDENCE_TEMP_DIR) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += await walkUsedBytes(full);
    else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export class EvidenceFiles {
  readonly root: string;
  readonly quotaBytes: number;
  readonly minFreeBytes: number;
  private readonly free: (root: string) => Promise<number>;
  private readonly used: (root: string) => Promise<number>;
  private readonly now: () => number;
  /** Bytes being written by streams in progress; counted against the quota so parallel uploads cannot overshoot. */
  private inflight = 0;
  /** Bytes moved into the root by this instance; uploads that finish during another upload count against its quota. */
  private landed = 0;

  constructor(options: EvidenceDiskOptions = {}) {
    this.root = path.resolve(options.root ?? DEFAULT_EVIDENCE_DIR);
    this.quotaBytes = options.quotaBytes ?? EVIDENCE_QUOTA_BYTES;
    this.minFreeBytes = options.minFreeBytes ?? EVIDENCE_MIN_FREE_BYTES;
    this.free = options.freeBytes ?? statfsFreeBytes;
    this.used = options.usedBytes ?? walkUsedBytes;
    this.now = options.now ?? Date.now;
  }

  get tempDir(): string { return path.join(this.root, EVIDENCE_TEMP_DIR); }

  private async checkFree(extra: number): Promise<void> {
    if (await this.free(this.root) - extra < this.minFreeBytes)
      throw new EvidenceFileError(507, `Not enough free disk space: evidence keeps at least ${formatBytes(this.minFreeBytes)} free.`);
  }
  private quotaError(): EvidenceFileError {
    return new EvidenceFileError(507, `The evidence storage quota (${formatBytes(this.quotaBytes)}) is full. Delete old evidence first.`);
  }

  /** Streams, hashes, sniffs and stores one file. Temp files never survive a failure or abort. */
  async ingest(input: IngestInput): Promise<EvidenceItemDto> {
    const { store, maxBytes } = input;
    const actor: OpsActor = input.evidence.actor;
    const tooLarge = () => new EvidenceFileError(413, `Files can be at most ${formatBytes(maxBytes)}.`);
    // Validate cheap inputs before reading a byte.
    parseEvidenceNote(input.evidence.note);
    const declared = input.declaredBytes ?? null;
    if (declared !== null && declared > maxBytes) throw tooLarge();
    await mkdir(this.tempDir, { recursive: true });
    await this.checkFree(declared ?? 0);
    const landedAtStart = this.landed;
    const usedAtStart = await this.used(this.root);
    const used = () => usedAtStart + (this.landed - landedAtStart) + this.inflight;
    if (used() + (declared ?? 0) > this.quotaBytes) throw this.quotaError();

    const temp = path.join(this.tempDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headLength = 0;
    let size = 0;
    let reserved = 0;
    let nextFreeCheck = FREE_CHECK_INTERVAL;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try {
        for await (const raw of input.source) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          size += chunk.length;
          if (size > maxBytes) throw tooLarge();
          this.inflight += size - reserved;
          reserved = size;
          if (used() > this.quotaBytes) throw this.quotaError();
          if (size >= nextFreeCheck) { nextFreeCheck += FREE_CHECK_INTERVAL; await this.checkFree(0); }
          hash.update(chunk);
          if (headLength < SNIFF_BYTES) {
            const part = chunk.subarray(0, SNIFF_BYTES - headLength);
            head.push(part);
            headLength += part.length;
          }
          let offset = 0;
          while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
        }
      } finally { await handle.close(); }
      const extension = size > 0 ? sniffEvidenceType(Buffer.concat(head)) : null;
      if (!extension)
        throw new EvidenceFileError(415, 'Unsupported file type. Use MP4, MOV, WebM, MKV, Ogg, MP3 or M4A.');
      const pending = await store.createPendingUpload({ ...input.evidence, kind: input.evidence.kind ?? 'upload', extension });
      try {
        const final = resolveEvidencePath(pending.storagePath!, this.root);
        await mkdir(path.dirname(final), { recursive: true });
        await rename(temp, final);
        this.landed += size;
        try {
          return await store.markStored(pending.id, { byteSize: size, sha256: hash.digest('hex') }, actor);
        } catch (error) {
          await rm(final, { force: true }).catch(() => {});
          throw error;
        }
      } catch (error) {
        await store.markFailed(pending.id, 'The file could not be stored.', actor).catch(() => {});
        throw error;
      }
    } finally {
      this.inflight -= reserved;
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  /**
   * Bytes written straight into the root outside ingest() (voice recordings). Counted like a finished
   * upload, so an upload in progress sees a recording growing beside it.
   */
  noteWritten(bytes: number): void { if (bytes > 0) this.landed += bytes; }

  /**
   * null when `extra` more bytes fit under the quota (stored files plus uploads in progress) and above
   * the free-disk floor; otherwise the safe refusal message.
   */
  async storageProblem(extra = 0): Promise<string | null> {
    try { await this.checkFree(extra); }
    catch (error) { if (error instanceof EvidenceFileError) return error.message; throw error; }
    if (await this.used(this.root) + this.inflight + extra > this.quotaBytes) return this.quotaError().message;
    return null;
  }

  /** Absolute path for a record's file, contained in the evidence root. */
  pathOf(record: Pick<EvidenceRecord, 'storagePath'>): string {
    if (!record.storagePath) throw new EvidenceFileError(400, 'This evidence has no stored file.');
    return resolveEvidencePath(record.storagePath, this.root);
  }

  /** Removes a record's file; a missing file is fine. */
  async removeFile(record: Pick<EvidenceRecord, 'storagePath'>): Promise<void> {
    if (!record.storagePath) return;
    await rm(this.pathOf(record), { force: true });
  }

  /** Deletes temp files left by a crash. Returns how many were removed. */
  async sweepTemp(): Promise<number> {
    let removed = 0;
    let names: string[];
    try { names = await readdir(this.tempDir); } catch { return 0; }
    for (const name of names) {
      if (!name.endsWith('.part')) continue;
      const full = path.join(this.tempDir, name);
      const info = await stat(full).catch(() => null);
      if (info && this.now() - info.mtimeMs > STALE_TEMP_MS) {
        await rm(full, { force: true }).catch(() => {});
        removed++;
      }
    }
    return removed;
  }
}

let shared: EvidenceFiles | undefined;
/** The process-wide instance for the default evidence root: uploads, Discord attachments and voice
 * recordings share one quota account, so concurrent writers count against each other. */
export function sharedEvidenceFiles(): EvidenceFiles { return shared ??= new EvidenceFiles(); }
