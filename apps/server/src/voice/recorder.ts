// Match-room audio recorder: one Ogg Opus evidence file per seated player (kind 'voice', source 'bot').
// Rows are reserved through the evidence store, files follow its path layout, and a small local journal
// lists recordings in progress so a crash leaves nothing pending: recovery finalizes intact prefixes
// (stored) or marks the rest failed. Recovery also reads pending voice rows straight from the database,
// so a lost or corrupt journal cannot strand a recording, and it runs periodically, not only at start.
// A write or fsync error on one track never loses what that track already saved: the file is cut back to
// its last intact page and stored as partial (audited); the other tracks keep recording.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync,
  truncateSync, unlinkSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordingMode } from '@tcg-live/core';
import { DEFAULT_EVIDENCE_DIR, resolveEvidencePath, type EvidenceStore } from '../evidence/store.js';
import type { OpsActor, OpsAuditInput } from '../ops/audit.js';
import { buildOggPage, OggOpusWriter, OPUS_RATE, PAGE_EOS, readOggPages } from './ogg-writer.js';

export const DEFAULT_VOICE_JOURNAL = fileURLToPath(new URL('../../../../data/voice-recordings.json', import.meta.url));
export const RECORDER_ACTOR: OpsActor = Object.freeze({ kind: 'bot', id: 'voice-recorder' });
/** Storage is re-checked on this tick, but the (directory-walking) quota check runs only when enough was written or enough time passed. */
export const STORAGE_CHECK_MS = 30_000;
export const STORAGE_CHECK_BYTES = 64 * 1024 * 1024;
export const STORAGE_FULL_CHECK_BYTES = 8 * 1024 * 1024;
export const STORAGE_FULL_CHECK_MS = 5 * 60_000;
/** Pending voice rows younger than this are left alone by recovery (a start may still be opening them). */
export const PENDING_RECOVERY_MIN_AGE_MS = 60_000;
/** A single silence fill never exceeds this; a longer jump is audited as a gap instead of written as silence. */
export const MAX_SILENCE_FILL_MS = 2 * 60 * 60_000;
const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 250, 500, 1000];

/** Wall-clock milliseconds from a monotonic source: NTP steps or a changed system clock never jump it. */
export const monotonicNow = (): number => performance.timeOrigin + performance.now();

/** Recording refused: the evidence quota is full or the disk is below its free-space floor. */
export class RecordingStorageError extends Error {}

/** The evidence quota account (EvidenceFiles); recordings count against it like uploads. */
export interface RecorderStorage {
  storageProblem(extra?: number): Promise<string | null>;
  noteWritten(bytes: number): void;
}

/** A 'pending' voice row recorded by the bot, as read from the database for recovery. */
export interface PendingVoiceRow { id: string; eventId: string; matchId: string | null; storagePath: string | null; createdAtMs: number }

/** File operations the recorder uses; tests replace them to inject write, fsync and rename failures. */
export interface RecorderIo {
  writeSync(fd: number, data: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  rename(from: string, to: string): Promise<void>;
}
const nodeIo: RecorderIo = { writeSync: (fd, data, offset, length) => writeSync(fd, data, offset, length), fsyncSync, rename };

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
  /** Defaults to monotonicNow. */
  now?: () => number;
  log?(message: string): void;
  /** Quota and free-disk checks; omitted means unchecked (tests). Production passes sharedEvidenceFiles(). */
  storage?: RecorderStorage;
  /** Organizer notice (Discord) for storage stops and refusals. */
  notify?(text: string): Promise<void>;
  /** Pending bot voice rows in the database (recovery beyond the journal); omitted means journal only. */
  pendingVoiceRows?(): Promise<PendingVoiceRow[]>;
  io?: Partial<RecorderIo>;
  /** Override MAX_SILENCE_FILL_MS (tests). */
  maxFillMs?: number;
}

export interface RecordingTarget { eventId: string; matchId: string; channelId: string; playerIds: readonly string[] }

interface JournalEntry { evidenceId: string; eventId: string; matchId: string; userId: string; storagePath: string; startedAtMs: number }
interface Journal { version: 1; entries: JournalEntry[] }

interface Track {
  userId: string; evidenceId: string; file: string; fd: number | null; writer: OggOpusWriter | null; failed: string | null;
  /** Set once a write failed: the file was cut back to its intact prefix and holds this much audio. */
  partial: { atOffsetMs: number; durationMs: number } | null;
}

export class VoiceRecorder {
  private readonly root: string;
  private readonly journalFile: string;
  private readonly now: () => number;
  private readonly io: RecorderIo;
  private readonly sessions = new Set<RecordingSession>();
  /** Evidence IDs this process is writing or finalizing: recovery never touches them. */
  private readonly owned = new Set<string>();
  private journalQueue: Promise<unknown> = Promise.resolve();
  private recovering: Promise<{ stored: number; failed: number }> | null = null;
  private storageTimer: NodeJS.Timeout | undefined;
  private bytesSinceFullCheck = 0;
  private lastFullCheckAtMs = 0;
  /** A storage refusal was already audited and announced; reset by the next successful start. */
  private refusalReported = false;

  constructor(private readonly deps: RecorderDeps) {
    this.root = path.resolve(deps.root ?? DEFAULT_EVIDENCE_DIR);
    this.journalFile = deps.journalFile ?? DEFAULT_VOICE_JOURNAL;
    this.now = deps.now ?? monotonicNow;
    this.io = { ...nodeIo, ...deps.io };
  }

  /** @internal */
  get maxFillMs(): number { return this.deps.maxFillMs ?? MAX_SILENCE_FILL_MS; }

  // ---- journal ----
  private parseJournal(text: string): Journal | null {
    try {
      const raw = JSON.parse(text) as Journal;
      if (raw?.version === 1 && Array.isArray(raw.entries)) return { version: 1, entries: raw.entries.filter(validEntry) };
    } catch { /* Corrupt. */ }
    return null;
  }
  private async readJournal(): Promise<Journal> {
    let text: string;
    try { text = await readFile(this.journalFile, 'utf8'); } catch { return { version: 1, entries: [] }; }
    const parsed = this.parseJournal(text);
    if (parsed) return parsed;
    // Keep the unreadable journal for the operator; recovery still finds its rows through the database.
    try { copyFileSync(this.journalFile, `${this.journalFile}.corrupt`); } catch { /* Best effort. */ }
    this.deps.log?.('The voice recording journal was unreadable; a copy was kept as voice-recordings.json.corrupt.');
    return { version: 1, entries: [] };
  }
  private async writeJournal(journal: Journal): Promise<void> {
    const directory = path.dirname(this.journalFile);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.voice-recordings-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); }
      finally { await handle.close(); }
      // Windows: antivirus, indexers or a reader can hold the target briefly (EPERM/EACCES/EBUSY).
      for (let attempt = 0; ; attempt += 1) {
        try { await this.io.rename(temporary, this.journalFile); return; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= RENAME_RETRY_DELAYS_MS.length || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
        }
      }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  /** Serialized read-modify-write; a failure is logged, never thrown into a recording. */
  private journalUpdate(change: (entries: JournalEntry[]) => JournalEntry[]): Promise<boolean> {
    const run = async () => {
      const journal = await this.readJournal();
      await this.writeJournal({ version: 1, entries: change(journal.entries) });
      return true;
    };
    const next = this.journalQueue.then(run, run).catch(() => {
      this.deps.log?.('The voice recording journal could not be saved; recovery falls back to the database.');
      return false;
    });
    this.journalQueue = next;
    return next;
  }
  private journalAdd(entries: JournalEntry[]): Promise<boolean> { return this.journalUpdate(current => [...current, ...entries]); }
  /** @internal */
  journalRemove(ids: readonly string[]): Promise<boolean> {
    return this.journalUpdate(current => current.filter(entry => !ids.includes(entry.evidenceId)));
  }
  /** Evidence IDs the journal lists as in progress (tests and diagnostics). */
  journalIds(): string[] {
    try { return (this.parseJournal(readFileSync(this.journalFile, 'utf8'))?.entries ?? []).map(entry => entry.evidenceId); }
    catch { return []; }
  }
  /** Resolves once queued journal writes finished (tests). */
  async journalSettled(): Promise<void> { await this.journalQueue; }

  /**
   * Recovery: every recording the journal or the database lists as 'pending' that this process is not
   * writing is finalized from its intact Ogg prefix (stored) or marked failed. Safe to call any time.
   */
  recover(): Promise<{ stored: number; failed: number }> {
    this.recovering ??= this.recoverOnce().finally(() => { this.recovering = null; });
    return this.recovering;
  }

  private async recoverOnce(): Promise<{ stored: number; failed: number }> {
    const journal = await this.readJournal();
    const candidates = new Map<string, { evidenceId: string; eventId: string; matchId: string; storagePath: string | null; journaled: boolean }>();
    for (const entry of journal.entries)
      if (!this.owned.has(entry.evidenceId)) candidates.set(entry.evidenceId, { ...entry, journaled: true });
    if (this.deps.pendingVoiceRows) {
      try {
        const cutoff = Date.now() - PENDING_RECOVERY_MIN_AGE_MS;
        for (const row of await this.deps.pendingVoiceRows()) {
          if (this.owned.has(row.id) || candidates.has(row.id) || row.createdAtMs > cutoff) continue;
          candidates.set(row.id, { evidenceId: row.id, eventId: row.eventId, matchId: row.matchId ?? '', storagePath: row.storagePath, journaled: false });
        }
      } catch { this.deps.log?.('Pending voice recordings could not be listed from the database; the journal is used alone.'); }
    }
    let stored = 0;
    let failed = 0;
    const done: string[] = [];
    for (const entry of candidates.values()) {
      if (this.owned.has(entry.evidenceId)) continue;
      try {
        const record = await this.deps.evidence.get(entry.evidenceId);
        if (!record || record.status !== 'pending') { done.push(entry.evidenceId); continue; }
        const relative = record.storagePath ?? entry.storagePath;
        const file = relative ? resolveEvidencePath(relative, this.root) : null;
        const result = file && existsSync(file) ? repairOgg(file) : null;
        if (!result || !file) {
          await this.deps.evidence.markFailed(entry.evidenceId, 'The recording was interrupted before any audio was saved.', RECORDER_ACTOR);
          failed += 1;
          done.push(entry.evidenceId);
          continue;
        }
        await this.deps.evidence.markStored(entry.evidenceId, { ...(await digest(file)), durationMs: result.durationMs }, RECORDER_ACTOR);
        await this.auditStop(entry.eventId, entry.matchId, null, [entry.evidenceId], result.durationMs, 'recovered');
        stored += 1;
        done.push(entry.evidenceId);
      } catch {
        // Kept (journaled, or still pending in the database) so the next pass retries instead of leaving it pending.
        this.deps.log?.('A voice recording from a previous run could not be finalized; it is retried later.');
      }
    }
    if (done.length) await this.journalRemove(done);
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
      // Rows already reserved for this start must not stay pending until the next recovery.
      for (const track of tracks) await this.abandon(track, 'The recording could not start.');
      throw error;
    }
    const session = new RecordingSession(this, target, startedAtMs, tracks);
    for (const track of tracks) this.open(session, track, startedAtMs);
    this.sessions.add(session);
    this.armStorageTimer();
    await this.deps.audit({ kind: 'voice.recording.start', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId: target.eventId,
      occurredAtMs: Math.round(startedAtMs), payload: { matchId: target.matchId, channelId: target.channelId,
        evidenceIds: tracks.map(track => track.evidenceId), userIds: tracks.map(track => track.userId) } }).catch(() => {});
    return session;
  }

  private async abandon(track: Track, reason: string): Promise<void> {
    try {
      await this.deps.evidence.markFailed(track.evidenceId, reason, RECORDER_ACTOR);
      this.owned.delete(track.evidenceId);
      await this.journalRemove([track.evidenceId]);
    } catch { this.owned.delete(track.evidenceId); /* Left pending; recovery finalizes it. */ }
  }

  private async reserve(target: RecordingTarget, userId: string, startedAtMs: number, tracks: Track[]): Promise<Track> {
    const record = await this.deps.evidence.createPendingUpload({ eventId: target.eventId, matchId: target.matchId, kind: 'voice',
      extension: 'ogg', source: 'bot', submittedBy: 'bot', actor: RECORDER_ACTOR, originalName: `${target.matchId}-voice-${userId}.ogg`,
      note: `Match room audio of player ${userId}`, recordedUserId: userId, recordingStartedAtMs: Math.round(startedAtMs) });
    this.owned.add(record.id);
    const track: Track = { userId, evidenceId: record.id, file: resolveEvidencePath(record.storagePath!, this.root), fd: null, writer: null,
      failed: null, partial: null };
    tracks.push(track);
    await this.journalAdd([{ evidenceId: record.id, eventId: target.eventId, matchId: target.matchId, userId,
      storagePath: record.storagePath!, startedAtMs: Math.round(startedAtMs) }]);
    return track;
  }

  /** Opens a track's file; a file that cannot be created fails that track only. */
  private open(session: RecordingSession, track: Track, startedAtMs: number): void {
    try {
      mkdirSync(path.dirname(track.file), { recursive: true });
      const fd = openSync(track.file, 'wx', 0o600);
      track.fd = fd;
      track.writer = new OggOpusWriter(page => { this.writeAll(fd, page); this.metered(page.length); }, { startMs: startedAtMs,
        maxFillMs: this.maxFillMs, comments: [`TCG_MATCH=${session.target.matchId}`, `TCG_PLAYER=${track.userId}`,
          `TCG_START_MS=${Math.round(startedAtMs)}`] });
    } catch {
      if (track.fd !== null) { try { closeSync(track.fd); } catch { /* closed */ } track.fd = null; }
      track.writer = null;
      track.failed = 'The recording file could not be created.';
    }
  }

  private writeAll(fd: number, data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      const written = this.io.writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error('short write');
      offset += written;
    }
  }

  /** @internal Adds a player seated after the recording started: a new file aligned to the session start. */
  async addTrack(session: RecordingSession, tracks: Track[], userId: string): Promise<string | null> {
    if (!session.active || tracks.some(track => track.userId === userId)) return null;
    const problem = await this.deps.storage?.storageProblem().catch(() => null) ?? null;
    if (problem) { this.deps.log?.(`A player who joined match room ${session.target.matchId} is not recorded: evidence storage is full.`); return null; }
    const reserved: Track[] = [];
    let track: Track;
    try { track = await this.reserve(session.target, userId, session.startedAtMs, reserved); }
    catch {
      for (const item of reserved) await this.abandon(item, 'The recording could not start.');
      this.deps.log?.(`A player who joined match room ${session.target.matchId} could not be recorded.`);
      return null;
    }
    if (!session.active) { await this.abandon(track, 'The recording ended before this player joined.'); return null; }
    this.open(session, track, session.startedAtMs);
    const atMs = this.now();
    // Silence up to now keeps this file side by side with the others.
    if (track.writer) { try { this.fill(session, track, atMs); } catch { this.salvage(session, track, atMs); } }
    tracks.push(track);
    await this.deps.audit({ kind: 'voice.recording.start', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId: session.target.eventId,
      payload: { matchId: session.target.matchId, channelId: session.target.channelId, evidenceIds: [track.evidenceId], userIds: [userId],
        joinedAtOffsetMs: session.offsetMs(atMs) } }).catch(() => {});
    return track.evidenceId;
  }

  /** @internal Writes a packet; a write error salvages the track instead of failing it. */
  writeTrack(session: RecordingSession, track: Track, packet: Buffer, atMs: number): void {
    if (track.failed || track.partial || !track.writer) return;
    try {
      const skipped = track.writer.writePacket(packet, atMs);
      if (skipped > 0) this.clockGap(session, track, atMs, skipped);
    } catch { this.salvage(session, track, atMs); }
  }

  private fill(session: RecordingSession, track: Track, atMs: number): void {
    const skipped = track.writer!.fillTo(atMs);
    if (skipped > 0) this.clockGap(session, track, atMs, skipped);
  }

  private clockGap(session: RecordingSession, track: Track, atMs: number, skippedMs: number): void {
    this.deps.log?.(`Recording in match room ${session.target.matchId} skipped ${Math.round(skippedMs / 1000)} s of silence after a clock jump.`);
    void this.deps.audit({ kind: 'voice.recording.gap', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId: session.target.eventId,
      payload: { matchId: session.target.matchId, channelId: session.target.channelId, evidenceIds: [track.evidenceId],
        recordingOffsetMs: session.offsetMs(atMs), durationMs: Math.round(skippedMs), reason: 'clock' } }).catch(() => {});
  }

  /**
   * First write or fsync error on a track: close the file, cut it back to the last intact page (with an
   * EOS page) and keep it as partial. Audited at once, so the cut is visible even if the process dies.
   */
  private salvage(session: RecordingSession, track: Track, atMs: number): void {
    if (track.partial || track.failed) return;
    if (track.fd !== null) { try { closeSync(track.fd); } catch { /* closed */ } track.fd = null; }
    let result: { durationMs: number } | null = null;
    try { result = existsSync(track.file) ? repairOgg(track.file) : null; } catch { result = null; }
    if (!result) { track.failed = 'The recording file could not be written.'; track.writer = null; }
    else track.partial = { atOffsetMs: session.offsetMs(atMs), durationMs: result.durationMs };
    this.deps.log?.(`A voice recording in match room ${session.target.matchId} could not be written; what was saved is kept.`);
    void this.deps.audit({ kind: 'voice.recording.partial', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId: session.target.eventId,
      payload: { matchId: session.target.matchId, channelId: session.target.channelId, evidenceId: track.evidenceId, userId: track.userId,
        recordingOffsetMs: session.offsetMs(atMs), savedDurationMs: result?.durationMs ?? 0 } }).catch(() => {});
  }

  /** @internal Audits a capture gap (bot disconnected) on every track of the session. */
  async auditGap(session: RecordingSession, fromMs: number, toMs: number, reason: string): Promise<void> {
    await this.deps.audit({ kind: 'voice.recording.gap', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId: session.target.eventId,
      payload: { matchId: session.target.matchId, channelId: session.target.channelId, evidenceIds: [...session.evidenceIds.values()],
        recordingOffsetMs: session.offsetMs(fromMs), durationMs: Math.max(0, Math.round(toMs - fromMs)), reason } }).catch(() => {});
  }

  /** @internal */
  async finish(session: RecordingSession, tracks: Track[], reason: string): Promise<void> {
    this.sessions.delete(session);
    if (!this.sessions.size && this.storageTimer) { clearInterval(this.storageTimer); this.storageTimer = undefined; }
    const stopAtMs = this.now();
    for (const track of tracks) {
      if (track.failed || track.partial || !track.writer || track.fd === null) continue;
      try {
        track.writer.close(stopAtMs);
        this.io.fsyncSync(track.fd);
      } catch { this.salvage(session, track, stopAtMs); }
    }
    for (const track of tracks) if (track.fd !== null) { try { closeSync(track.fd); } catch { /* Already closed. */ } track.fd = null; }
    let durationMs = 0;
    const finalized: string[] = [];
    for (const track of tracks) {
      // Per track: one failure (database, digest) never blocks the others.
      try {
        if (track.failed || !track.writer) {
          await this.deps.evidence.markFailed(track.evidenceId, track.failed ?? 'The recording failed.', RECORDER_ACTOR);
        } else {
          const duration = track.partial ? track.partial.durationMs : Math.round(track.writer.durationMs);
          durationMs = Math.max(durationMs, duration);
          await this.deps.evidence.markStored(track.evidenceId, { ...(await digest(track.file)), durationMs: duration }, RECORDER_ACTOR);
        }
        finalized.push(track.evidenceId);
      } catch { this.deps.log?.('A voice recording could not be finalized; recovery retries it.'); }
      this.owned.delete(track.evidenceId);
    }
    if (finalized.length) await this.journalRemove(finalized);
    const partial = tracks.filter(track => track.partial).map(track => track.evidenceId);
    await this.auditStop(session.target.eventId, session.target.matchId, session.target.channelId,
      tracks.map(track => track.evidenceId), durationMs, reason, partial);
  }

  private metered(bytes: number): void {
    this.deps.storage?.noteWritten(bytes);
    this.bytesSinceFullCheck += bytes;
    if (this.bytesSinceFullCheck >= STORAGE_CHECK_BYTES) void this.checkAllStorage(true);
  }

  private armStorageTimer(): void {
    if (!this.deps.storage || this.storageTimer) return;
    this.lastFullCheckAtMs = this.now();
    this.storageTimer = setInterval(() => { void this.checkAllStorage(false); }, STORAGE_CHECK_MS);
    this.storageTimer.unref();
  }

  /**
   * One storage check for every active recording. The quota check walks the evidence folder, so the
   * timer runs it only after STORAGE_FULL_CHECK_BYTES were written or STORAGE_FULL_CHECK_MS passed.
   */
  async checkAllStorage(force: boolean): Promise<void> {
    if (!this.deps.storage || !this.sessions.size) return;
    const due = force || this.bytesSinceFullCheck >= STORAGE_FULL_CHECK_BYTES || this.now() - this.lastFullCheckAtMs >= STORAGE_FULL_CHECK_MS;
    if (!due) return;
    this.bytesSinceFullCheck = 0;
    this.lastFullCheckAtMs = this.now();
    let problem: string | null;
    try { problem = await this.deps.storage.storageProblem(); } catch { return; }
    if (!problem) return;
    await Promise.all([...this.sessions].map(session => this.stopForStorage(session, problem)));
  }

  /** Stops `session` cleanly (what is written is finalized) when the quota or the free-disk floor is crossed. */
  async checkStorage(session: RecordingSession): Promise<boolean> {
    if (!session.active || !this.deps.storage) return false;
    let problem: string | null;
    try { problem = await this.deps.storage.storageProblem(); } catch { return false; }
    if (!problem) return false;
    return this.stopForStorage(session, problem);
  }

  private async stopForStorage(session: RecordingSession, problem: string): Promise<boolean> {
    if (!session.active) return false;
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

  private async auditStop(eventId: string, matchId: string, channelId: string | null, evidenceIds: string[], durationMs: number,
    reason: string, partialEvidenceIds: string[] = []) {
    await this.deps.audit({ kind: 'voice.recording.stop', actor: RECORDER_ACTOR, guildId: this.deps.guildId, eventId,
      payload: { matchId, channelId, evidenceIds, durationMs, reason, ...(partialEvidenceIds.length ? { partialEvidenceIds } : {}) } })
      .catch(() => {});
  }

  /** Stops every active recording in parallel (shutdown). Resolves after `budgetMs` at the latest; the rest is recovered later. */
  async stopAll(reason = 'shutdown', budgetMs = Infinity): Promise<void> {
    const all = Promise.all([...this.sessions].map(session => session.stop(reason).catch(() => {})));
    if (!Number.isFinite(budgetMs)) { await all; return; }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise<void>(resolve => { timer = setTimeout(resolve, budgetMs); timer.unref(); })]);
    if (timer) clearTimeout(timer);
  }

  /** Recordings in progress (diagnostics and tests). */
  get activeCount(): number { return this.sessions.size; }
}

export class RecordingSession {
  private stopping: Promise<void> | null = null;
  private readonly adding = new Map<string, Promise<string | null>>();
  constructor(private readonly recorder: VoiceRecorder, readonly target: RecordingTarget, readonly startedAtMs: number,
    private readonly tracks: Track[]) {}

  get evidenceIds(): Map<string, string> { return new Map(this.tracks.map(track => [track.userId, track.evidenceId])); }
  get active(): boolean { return this.stopping === null; }
  /** Players with a track (or one being added). */
  players(): string[] { return [...new Set([...this.tracks.map(track => track.userId), ...this.adding.keys()])]; }
  /** Evidence IDs of tracks stored as partial so far. */
  get partialEvidenceIds(): string[] { return this.tracks.filter(track => track.partial).map(track => track.evidenceId); }
  /** Milliseconds into this recording at wall-clock `atMs`. */
  offsetMs(atMs: number): number { return Math.max(0, Math.round(atMs - this.startedAtMs)); }

  /** Writes one original Opus packet for `userId`; packets of anyone else are ignored. */
  write(userId: string, packet: Buffer, atMs: number): void {
    if (this.stopping) return;
    const track = this.tracks.find(item => item.userId === userId);
    if (track) this.recorder.writeTrack(this, track, packet, atMs);
  }

  /** Starts a track for a player seated after the recording began (silence-filled from the session start). */
  addPlayer(userId: string): Promise<string | null> {
    if (this.stopping || this.tracks.some(track => track.userId === userId)) return Promise.resolve(null);
    const existing = this.adding.get(userId);
    if (existing) return existing;
    const adding = this.recorder.addTrack(this, this.tracks, userId).finally(() => { this.adding.delete(userId); });
    this.adding.set(userId, adding);
    return adding;
  }

  /** Audits a capture gap between two wall-clock times (the files are silence-filled across it). */
  gap(fromMs: number, toMs: number, reason: string): Promise<void> { return this.recorder.auditGap(this, fromMs, toMs, reason); }

  stop(reason = 'stopped'): Promise<void> {
    this.stopping ??= (async () => {
      await Promise.allSettled([...this.adding.values()]);
      await this.recorder.finish(this, this.tracks, reason);
    })();
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
 * null when not even the two header pages survived (the file is then removed). Idempotent.
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
