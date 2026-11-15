// Match-room audio recorder: one Ogg Opus evidence file per seated player (kind 'voice', source 'bot').
// Rows are reserved through the evidence store, files follow its path layout, and a small local journal
// lists recordings in progress so a crash leaves nothing pending: the next start finalizes intact
// prefixes (stored) or marks the rest failed.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
  truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordingMode } from '@tcg-live/core';
import { DEFAULT_EVIDENCE_DIR, resolveEvidencePath, type EvidenceStore } from '../evidence/store.js';
import type { OpsActor, OpsAuditInput } from '../ops/audit.js';
import { buildOggPage, OggOpusWriter, OPUS_RATE, PAGE_EOS, readOggPages } from './ogg-writer.js';

export const DEFAULT_VOICE_JOURNAL = fileURLToPath(new URL('../../../../data/voice-recordings.json', import.meta.url));
export const RECORDER_ACTOR: OpsActor = Object.freeze({ kind: 'bot', id: 'voice-recorder' });
/** A recording re-checks the evidence quota and free-disk floor this often, and after this many bytes. */
export const STORAGE_CHECK_MS = 30_000;
export const STORAGE_CHECK_BYTES = 64 * 1024 * 1024;

/** Recording refused: the evidence quota is full or the disk is below its free-space floor. */
export class RecordingStorageError extends Error {}

/** The evidence quota account (EvidenceFiles); recordings count against it like uploads. */
export interface RecorderStorage {
  storageProblem(extra?: number): Promise<string | null>;
  noteWritten(bytes: number): void;
}

/** Whether a room records under `mode`, given whether it has an open judge call or dispute. */
export function shouldRecord(mode: RecordingMode, judgeCall: boolean): boolean {
  return mode === 'always' || (mode === 'judge-call' && judgeCall);
}

export interface RecorderDeps {
  evidence: Pick<EvidenceStore, 'createPendingUpload' | 'markStored' | 'markFailed' | 'get'>;
  audit(input: OpsAuditInput): Promise<unknown>;
  guildId: string;
  /** Evidence root (the store's layout is `<root>/<eventId>/<evidenceId>.ogg`). */
  root?: string;
  journalFile?: string;
  now?: () => number;
  log?(message: string): void;
  /** Quota and free-disk checks; omitted means unchecked (tests). Production passes sharedEvidenceFiles(). */
  storage?: RecorderStorage;
  /** Organizer notice (Discord) for storage stops and refusals. */
  notify?(text: string): Promise<void>;
}

export interface RecordingTarget { eventId: string; matchId: string; channelId: string; playerIds: readonly string[] }

interface JournalEntry { evidenceId: string; eventId: string; matchId: string; userId: string; storagePath: string; startedAtMs: number }
interface Journal { version: 1; entries: JournalEntry[] }

interface Track { userId: string; evidenceId: string; file: string; fd: number | null; writer: OggOpusWriter | null; failed: string | null }
interface Meter { bytes: number; session: RecordingSession | null }

export class VoiceRecorder {
  private readonly root: string;
  private readonly journalFile: string;
  private readonly now: () => number;
  private readonly sessions = new Set<RecordingSession>();
  /** A storage refusal was already audited and announced; reset by the next successful start. */
  private refusalReported = false;

  constructor(private readonly deps: RecorderDeps) {
    this.root = path.resolve(deps.root ?? DEFAULT_EVIDENCE_DIR);
    this.journalFile = deps.journalFile ?? DEFAULT_VOICE_JOURNAL;
    this.now = deps.now ?? Date.now;
  }

  // ---- journal ----
  private readJournal(): Journal {
    try {
      const raw = JSON.parse(readFileSync(this.journalFile, 'utf8')) as Journal;
      if (raw?.version === 1 && Array.isArray(raw.entries)) return { version: 1, entries: raw.entries.filter(validEntry) };
    } catch { /* Missing or unreadable: nothing to recover. */ }
    return { version: 1, entries: [] };
  }
  private writeJournal(journal: Journal): void {
    mkdirSync(path.dirname(this.journalFile), { recursive: true });
    const temporary = path.join(path.dirname(this.journalFile), `.voice-recordings-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600 });
    renameSync(temporary, this.journalFile);
  }
  private journalAdd(entries: JournalEntry[]): void {
    const journal = this.readJournal();
    this.writeJournal({ version: 1, entries: [...journal.entries, ...entries] });
  }
  /** @internal */
  journalRemove(ids: readonly string[]): void {
    const journal = this.readJournal();
    this.writeJournal({ version: 1, entries: journal.entries.filter(entry => !ids.includes(entry.evidenceId)) });
  }
  /** Evidence IDs the journal lists as in progress (tests and diagnostics). */
  journalIds(): string[] { return this.readJournal().entries.map(entry => entry.evidenceId); }

  /**
   * Crash recovery: every journaled recording still 'pending' is finalized from its intact Ogg prefix
   * (stored) or marked failed. Call once before the first start().
   */
  async recover(): Promise<{ stored: number; failed: number }> {
    const journal = this.readJournal();
    let stored = 0;
    let failed = 0;
    const retry: JournalEntry[] = [];
    for (const entry of journal.entries) {
      try {
        const record = await this.deps.evidence.get(entry.evidenceId);
        if (!record || record.status !== 'pending') continue;
        const file = resolveEvidencePath(record.storagePath ?? entry.storagePath, this.root);
        const result = existsSync(file) ? repairOgg(file) : null;
        if (!result) {
          await this.deps.evidence.markFailed(entry.evidenceId, 'The recording was interrupted before any audio was saved.', RECORDER_ACTOR);
          failed += 1;
          continue;
        }
        await this.deps.evidence.markStored(entry.evidenceId, { ...(await digest(file)), durationMs: result.durationMs }, RECORDER_ACTOR);
        await this.auditStop(entry.eventId, entry.matchId, null, [entry.evidenceId], result.durationMs, 'recovered');
        stored += 1;
      } catch {
        // Keep it journaled (for example PostgreSQL was down) so the next start retries instead of leaving it pending.
        retry.push(entry);
        this.deps.log?.('A voice recording from a previous run could not be finalized.');
      }
    }
    this.writeJournal({ version: 1, entries: retry });
    return { stored, failed };
  }

  /** Reserves one evidence row and file per seated player and starts writing. */
  async start(target: RecordingTarget): Promise<RecordingSession> {
    const startedAtMs = this.now();
    const tracks: Track[] = [];
    const problem = await this.deps.storage?.storageProblem().catch(() => null) ?? null;
    if (problem) {
      if (!this.refusalReported) {
        this.refusalReported = true;
        await this.storageAudit(target, [], problem, 'not_started');
        await this.notify(`Recording could not start in ${target.matchId}: ${problem}`);
      }
      throw new RecordingStorageError(problem);
    }
    this.refusalReported = false;
    try {
      for (const userId of [...new Set(target.playerIds)]) await this.reserve(target, userId, startedAtMs, tracks);
    } catch (error) {
      // Rows already reserved for this start must not stay pending until the next process start.
      for (const track of tracks) {
        try {
          await this.deps.evidence.markFailed(track.evidenceId, 'The recording could not start.', RECORDER_ACTOR);
          this.journalRemove([track.evidenceId]);
        } catch { /* Left journaled; recover() finalizes it on the next start. */ }
      }
      throw error;
    }
    return this.begin(target, startedAtMs, tracks);
  }

  private async reserve(target: RecordingTarget, userId: string, startedAtMs: number, tracks: Track[]): Promise<void> {
    const record = await this.deps.evidence.createPendingUpload({ eventId: target.eventId, matchId: target.matchId, kind: 'voice',
      extension: 'ogg', source: 'bot', submittedBy: 'bot', actor: RECORDER_ACTOR, originalName: `${target.matchId}-voice-${userId}.ogg`,
      note: `Match room audio of player ${userId}`, recordedUserId: userId, recordingStartedAtMs: startedAtMs });
    tracks.push({ userId, evidenceId: record.id, file: resolveEvidencePath(record.storagePath!, this.root), fd: null, writer: null, failed: null });
    this.journalAdd([{ evidenceId: record.id, eventId: target.eventId, matchId: target.matchId, userId,
      storagePath: record.storagePath!, startedAtMs }]);
  }

  private async begin(target: RecordingTarget, startedAtMs: number, tracks: Track[]): Promise<RecordingSession> {
    const meter: Meter = { bytes: 0, session: null };
    for (const track of tracks) {
      try {
        mkdirSync(path.dirname(track.file), { recursive: true });
        const fd = openSync(track.file, 'wx', 0o600);
        track.fd = fd;
        track.writer = new OggOpusWriter(page => { writeSync(fd, page); this.metered(meter, page.length); }, { startMs: startedAtMs,
          comments: [`TCG_MATCH=${target.matchId}`, `TCG_PLAYER=${track.userId}`, `TCG_START_MS=${startedAtMs}`] });
      } catch { track.failed = 'The recording file could not be created.'; }
    }
    const session = new RecordingSession(this, target, startedAtMs, tracks);
    meter.session = session;
    this.sessions.add(session);
    if (this.deps.storage) {
      session.storageTimer = setInterval(() => { void this.checkStorage(session); }, STORAGE_CHECK_MS);
      session.storageTimer.unref();
    }
    await this.deps.audit({ kind: 'voice.recording.start', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId: target.eventId,
      occurredAtMs: startedAtMs, payload: { matchId: target.matchId, channelId: target.channelId,
        evidenceIds: tracks.map(track => track.evidenceId), userIds: tracks.map(track => track.userId) } }).catch(() => {});
    return session;
  }

  /** @internal */
  async finish(session: RecordingSession, tracks: Track[], reason: string): Promise<void> {
    this.sessions.delete(session);
    if (session.storageTimer) { clearInterval(session.storageTimer); session.storageTimer = undefined; }
    const stopAtMs = this.now();
    for (const track of tracks) {
      try {
        if (!track.failed && track.writer && track.fd !== null) {
          track.writer.close(stopAtMs);
          fsyncSync(track.fd);
        }
      } catch { track.failed = 'The recording file could not be written.'; }
      if (track.fd !== null) { try { closeSync(track.fd); } catch { /* Already closed. */ } track.fd = null; }
    }
    let durationMs = 0;
    for (const track of tracks) {
      try {
        if (track.failed || !track.writer) {
          await this.deps.evidence.markFailed(track.evidenceId, track.failed ?? 'The recording failed.', RECORDER_ACTOR);
          continue;
        }
        const duration = Math.round(track.writer.durationMs);
        durationMs = Math.max(durationMs, duration);
        await this.deps.evidence.markStored(track.evidenceId, { ...(await digest(track.file)), durationMs: duration }, RECORDER_ACTOR);
      } catch { this.deps.log?.('A voice recording could not be finalized; it is retried on the next start.'); continue; }
      this.journalRemove([track.evidenceId]);
    }
    await this.auditStop(session.target.eventId, session.target.matchId, session.target.channelId,
      tracks.map(track => track.evidenceId), durationMs, reason);
  }

  private metered(meter: Meter, bytes: number): void {
    this.deps.storage?.noteWritten(bytes);
    meter.bytes += bytes;
    if (meter.session && meter.bytes >= STORAGE_CHECK_BYTES) { meter.bytes = 0; void this.checkStorage(meter.session); }
  }

  /** Stops `session` cleanly (what is written is finalized) when the quota or the free-disk floor is crossed. */
  async checkStorage(session: RecordingSession): Promise<boolean> {
    if (!session.active || !this.deps.storage) return false;
    let problem: string | null;
    try { problem = await this.deps.storage.storageProblem(); } catch { return false; }
    if (!problem || !session.active) return false;
    this.deps.log?.(`Recording in match room ${session.target.matchId} stopped: evidence storage is full.`);
    await session.stop('storage');
    await this.storageAudit(session.target, [...session.evidenceIds.values()], problem, 'stopped');
    await this.notify(`Recording in ${session.target.matchId} stopped: ${problem} What was recorded so far is saved.`);
    return true;
  }

  private async storageAudit(target: RecordingTarget, evidenceIds: string[], message: string, phase: 'stopped' | 'not_started') {
    await this.deps.audit({ kind: 'voice.recording.stopped_storage', actor: RECORDER_ACTOR, guildId: this.deps.guildId,
      eventId: target.eventId, payload: { matchId: target.matchId, channelId: target.channelId, evidenceIds, phase, message } }).catch(() => {});
  }

  private async notify(text: string): Promise<void> {
    try { await this.deps.notify?.(text); } catch { this.deps.log?.('The recording storage notice could not be sent.'); }
  }

  private async auditStop(eventId: string, matchId: string, channelId: string | null, evidenceIds: string[], durationMs: number, reason: string) {
    await this.deps.audit({ kind: 'voice.recording.stop', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId,
      payload: { matchId, channelId, evidenceIds, durationMs, reason } }).catch(() => {});
  }

  /** Stops every active recording (shutdown). */
  async stopAll(reason = 'shutdown'): Promise<void> {
    await Promise.all([...this.sessions].map(session => session.stop(reason)));
  }
}

export class RecordingSession {
  private stopping: Promise<void> | null = null;
  /** @internal Periodic storage check, cleared on finish. */
  storageTimer: NodeJS.Timeout | undefined;
  constructor(private readonly recorder: VoiceRecorder, readonly target: RecordingTarget, readonly startedAtMs: number,
    private readonly tracks: Track[]) {}

  get evidenceIds(): Map<string, string> { return new Map(this.tracks.map(track => [track.userId, track.evidenceId])); }
  get active(): boolean { return this.stopping === null; }
  /** Milliseconds into this recording at wall-clock `atMs`. */
  offsetMs(atMs: number): number { return Math.max(0, Math.round(atMs - this.startedAtMs)); }

  /** Writes one original Opus packet for `userId`; packets of anyone else are ignored. */
  write(userId: string, packet: Buffer, atMs: number): void {
    if (this.stopping) return;
    const track = this.tracks.find(item => item.userId === userId);
    if (!track || track.failed || !track.writer) return;
    try { track.writer.writePacket(packet, atMs); }
    catch { track.failed = 'The recording file could not be written.'; }
  }

  stop(reason = 'stopped'): Promise<void> {
    this.stopping ??= this.recorder.finish(this, this.tracks, reason);
    return this.stopping;
  }
}

function validEntry(value: unknown): value is JournalEntry {
  const entry = value as JournalEntry;
  return !!entry && typeof entry.evidenceId === 'string' && typeof entry.storagePath === 'string' &&
    typeof entry.eventId === 'string' && typeof entry.matchId === 'string';
}

async function digest(file: string): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve()).on('error', reject);
  });
  return { byteSize: statSync(file).size, sha256: hash.digest('hex') };
}

/**
 * Keeps the intact page prefix of an interrupted Ogg Opus file and closes it with an EOS page. Returns
 * null when not even the two header pages survived (the file is then removed).
 */
export function repairOgg(file: string): { durationMs: number } | null {
  const data = readFileSync(file);
  const { pages, validLength } = readOggPages(data);
  const headersOk = pages.length >= 2 && pages[0]!.packets[0]?.toString('latin1', 0, 8) === 'OpusHead' &&
    pages[1]!.packets[0]?.toString('latin1', 0, 8) === 'OpusTags';
  if (!headersOk) { try { unlinkSync(file); } catch { /* Best effort. */ } return null; }
  const last = pages[pages.length - 1]!;
  if (validLength < data.length) truncateSync(file, validLength);
  if (!(last.flags & PAGE_EOS)) {
    const fd = openSync(file, 'a');
    try { writeSync(fd, buildOggPage(last.serial, last.sequence + 1, last.granule, PAGE_EOS, [])); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  return { durationMs: Math.round(Number(last.granule) / (OPUS_RATE / 1000)) };
}
