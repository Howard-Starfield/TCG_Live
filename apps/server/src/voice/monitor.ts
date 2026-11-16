// Voice runtime core: decides which match rooms need a bot, assigns pool bots, joins, subscribes to the
// seated players only, and feeds packets to the recorder and the loudness detector. Library-free: every
// Discord or codec touch goes through transport.ts, so this runs against fakes in tests.
//
// Robustness: connection state changes are tracked; while a bot is not connected the recording gets an
// audited gap (files stay aligned by silence fill). A lost connection rejoins at once and, within
// REJOIN_WINDOW_MS, continues the SAME recording session; later, it is finalized and a new one starts.
// A recording stopped for storage is retried with backoff. Players seated mid-recording get their own
// track. Players who opted out are never subscribed, recorded or loudness-checked.
import { createHash } from 'node:crypto';
import { DEFAULT_MODERATION_SETTINGS, DEFAULT_VOICE_ROOM_POLICY, type MatchId, type ModerationSettingsBodyDto,
  type VoiceBotRuntimeStatus, type VoiceRoomPolicyDto } from '@tcg-live/core';
import type { MatchRoomInfo } from '../discord/features.js';
import type { ModerationFlagInput } from '../moderation/flags.js';
import type { OpsAuditInput } from '../ops/audit.js';
import type { VoiceRuntimeControlTarget } from './control.js';
import { VoicePoolIdentities } from './identities.js';
import { FRAME_MS, LoudnessDetector, loudnessConfig, type LoudnessSpike } from './loudness.js';
import { opusPacketSamples } from './ogg-writer.js';
import { MAIN_VOICE_BOT_ID, planVoiceAssignments, roomStatus, type CoverageRoom, type VoiceBotLiveState,
  type VoicePoolLiveState } from './pool.js';
import { monotonicNow, shouldRecord, type RecordingTarget } from './recorder.js';
import type { VoiceBotCredential } from './tokens.js';
import type { OpusDecoder, OpusDecoderFactory, VoiceBotTransport, VoiceChannelHandle, VoiceConnectionPhase,
  VoicePacketSubscription } from './transport.js';

export const DEFAULT_MONITOR_NOTICE = '🔴 Audio monitoring/recording is active for this match.';
const JOIN_RETRY_MS = 30_000;
const ORGANIZER_NOTICE_INTERVAL_MS = 60_000;
const SAFETY_RECONCILE_MS = 30_000;
/** Pending recordings left by a crash or a failed finalize are re-checked this often (not only at start). */
export const RECOVERY_INTERVAL_MS = 10 * 60_000;
/** A recording that could not start (for example evidence storage full) is retried after 30 s, doubling to 5 min. */
export const RECORDING_RETRY_MIN_MS = 30_000;
export const RECORDING_RETRY_MAX_MS = 5 * 60_000;
/** A lost connection that rejoins within this long continues the same recording session. */
export const REJOIN_WINDOW_MS = 2 * 60_000;
/** Shutdown waits at most this long for recordings to finalize (the runtime's watchdog is 5 s). */
export const SHUTDOWN_RECORDING_BUDGET_MS = 3_000;
/** At shutdown, an in-flight tick is awaited this long at most before the recordings are stopped. */
export const SHUTDOWN_TICK_WAIT_MS = 300;

/** Room info plus optional live match detail from the runtime. */
export type VoiceRoomInfo = MatchRoomInfo & { phase?: string; judgeCall?: boolean };

export interface RecordingHandle {
  readonly startedAtMs: number;
  /** False once the recording stopped on its own (for example evidence storage full). */
  readonly active?: boolean;
  write(userId: string, packet: Buffer, atMs: number): void;
  offsetMs(atMs: number): number;
  stop(reason?: string): Promise<void>;
  /** Players with a track. */
  players?(): string[];
  /** Adds a track for a player seated after the start. */
  addPlayer?(userId: string): Promise<unknown>;
  /** Audits a capture gap. */
  gap?(fromMs: number, toMs: number, reason: string): Promise<void>;
}
export interface RecorderLike {
  recover(): Promise<unknown>;
  start(target: RecordingTarget): Promise<RecordingHandle>;
  /** Stops every recording in parallel within a budget (shutdown). */
  stopAll?(reason?: string, budgetMs?: number): Promise<void>;
}

export interface VoiceMonitorDeps {
  guildId: string;
  isActive(): boolean;
  settings(): Promise<ModerationSettingsBodyDto>;
  rooms(): Promise<VoiceRoomInfo[]>;
  /** Helper credentials (secrets): used only to build transports, never logged or stored here. */
  helpers(): Promise<VoiceBotCredential[]>;
  main: VoiceBotTransport;
  createHelper(credential: VoiceBotCredential): VoiceBotTransport;
  decoder: OpusDecoderFactory;
  recorder: RecorderLike;
  appendFlag(input: ModerationFlagInput): Promise<unknown>;
  publish(state: VoicePoolLiveState | null): void;
  /** Posts in a voice channel's text chat. */
  postNotice(channelId: string, text: string): Promise<void>;
  /** Ops audit (notice failures); optional so tests can omit it. */
  audit?(input: OpsAuditInput): Promise<unknown>;
  /** Organizer notice; channelId null means the runtime's default destination. */
  notifyOrganizer(channelId: string | null, text: string): Promise<void>;
  identities?: VoicePoolIdentities;
  /** Policy timers (retry benches, backoff). */
  now?: () => number;
  /** Packet and gap timing; must share the recorder's clock. Defaults to `now` when given, else monotonicNow. */
  clock?: () => number;
  log(message: string): void;
  /** Disable the periodic safety reconcile and recovery (tests). */
  timers?: boolean;
}

interface Assignment {
  eventId: string; matchId: MatchId; channelId: string;
  handle: VoiceChannelHandle;
  subscriptions: Map<string, VoicePacketSubscription>;
  decoders: Map<string, OpusDecoder>;
  detector: LoudnessDetector;
  monitor: boolean;
  judgeCall: boolean;
  recording: RecordingHandle | null;
  recordingStart: Promise<void> | null;
  /** A refused start (storage full) is retried no sooner than this. */
  recordingRetryAtMs: number;
  recordingFailures: number;
  /** Clock time the connection left Ready (null while connected). */
  gapStartMs: number | null;
}
interface BotSlot {
  id: string;
  transport: VoiceBotTransport;
  /** Fingerprint of the helper credential; a changed token rebuilds the transport. */
  fingerprint: string | null;
  assignment: Assignment | null;
  joining: boolean;
  failedAtMs: number | null;
  lastErrorCode: VoiceBotLiveState['lastErrorCode'];
}
/** A recording whose bot lost its connection, kept for a quick rejoin. */
interface Suspended { recording: RecordingHandle; channelId: string; lostAtMs: number; lostAtPolicyMs: number }

const roomKey = (eventId: string, matchId: string) => `${eventId}:${matchId}`;

export class VoiceMonitor implements VoiceRuntimeControlTarget {
  private readonly bots = new Map<string, BotSlot>();
  private readonly judgeOpen = new Set<string>();
  private readonly resolved = new Set<string>();
  private readonly notices = new Set<string>();
  /** Rooms whose notice failed (audited once per activation); nothing is captured there until it posts. */
  private readonly noticeFailed = new Set<string>();
  private readonly suspended = new Map<string, Suspended>();
  /** Backoff of rooms whose recording could not start, kept across bot reassignments. */
  private readonly roomRetry = new Map<string, { atMs: number; failures: number }>();
  private readonly identities: VoicePoolIdentities;
  private readonly now: () => number;
  private readonly clock: () => number;
  private settingsCache: ModerationSettingsBodyDto = DEFAULT_MODERATION_SETTINGS;
  private coverage: CoverageRoom[] = [];
  private coverageEvents = new Map<MatchId, string>();
  private dirty = false;
  private running: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private lastOrganizerNoticeAtMs = -Infinity;
  private lastDropNoticeAtMs = -Infinity;

  constructor(private readonly deps: VoiceMonitorDeps) {
    this.identities = deps.identities ?? new VoicePoolIdentities();
    this.now = deps.now ?? Date.now;
    this.clock = deps.clock ?? deps.now ?? monotonicNow;
    this.bots.set(MAIN_VOICE_BOT_ID, { id: MAIN_VOICE_BOT_ID, transport: deps.main, fingerprint: null, assignment: null, joining: false,
      failedAtMs: null, lastErrorCode: null });
  }

  async start(): Promise<void> {
    try { await this.deps.recorder.recover(); } catch { this.deps.log('Voice recordings from a previous run could not be checked.'); }
    await this.reloadHelpers();
    if (this.deps.timers !== false) {
      this.timer = setInterval(() => { void this.schedule(); }, SAFETY_RECONCILE_MS);
      this.timer.unref();
      this.recoveryTimer = setInterval(() => {
        void this.deps.recorder.recover().catch(() => this.deps.log('Pending voice recordings could not be checked.'));
      }, RECOVERY_INTERVAL_MS);
      this.recoveryTimer.unref();
    }
    await this.schedule();
  }

  // ---- inputs ----
  judgeCalled(eventId: string, matchId: MatchId): Promise<void> { this.judgeOpen.add(roomKey(eventId, matchId)); return this.schedule(); }
  /** The admin closed the judge request: the room stops counting as on a judge call. */
  judgeClosed(eventId: string, matchId: MatchId): Promise<void> { this.judgeOpen.delete(roomKey(eventId, matchId)); return this.schedule(); }
  matchResolved(eventId: string, matchId: MatchId): Promise<void> {
    const key = roomKey(eventId, matchId);
    this.judgeOpen.delete(key);
    this.resolved.add(key);
    return this.schedule();
  }
  /** A round (re)bound a voice room: the match is live again even if an earlier round resolved it. */
  roomAssigned(eventId: string, matchId: MatchId): Promise<void> {
    const key = roomKey(eventId, matchId);
    this.resolved.delete(key);
    this.judgeOpen.delete(key);
    return this.schedule();
  }
  settingsChanged(settings: ModerationSettingsBodyDto): Promise<void> { this.settingsCache = settings; return this.schedule(); }
  async helpersChanged(): Promise<void> { await this.reloadHelpers(); await this.schedule(); }

  /** Dashboard Retry: clears the bot's failure state and backoff, then reconciles. */
  async retryBot(botId: string): Promise<boolean> {
    const slot = this.bots.get(botId);
    if (!slot) return false;
    slot.failedAtMs = null;
    slot.lastErrorCode = null;
    slot.transport.resetFailure?.();
    if (slot.id !== MAIN_VOICE_BOT_ID && slot.transport.state() === 'idle')
      void slot.transport.ensureReady().then(() => { this.refreshIdentities(); return this.schedule(); });
    await this.schedule();
    return true;
  }

  /** Coalesced, serialized reconcile. */
  schedule(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.dirty = true;
    this.running ??= (async () => {
      try { while (this.dirty && !this.stopped && this.deps.isActive()) { this.dirty = false; await this.reconcile(); } }
      finally { this.running = null; }
    })();
    return this.running;
  }

  private async reloadHelpers(): Promise<void> {
    let credentials: VoiceBotCredential[];
    try { credentials = await this.deps.helpers(); } catch { this.deps.log('The helper voice bot list could not be read.'); return; }
    // Disabled helpers are never logged in or assigned.
    const wanted = new Map(credentials.filter(credential => credential.enabled !== false).map(credential => [credential.id, credential]));
    for (const [id, slot] of [...this.bots]) {
      if (id === MAIN_VOICE_BOT_ID) continue;
      const credential = wanted.get(id);
      if (credential && fingerprint(credential) === slot.fingerprint) continue;
      await this.release(slot, credential ? 'bot changed' : 'bot removed');
      await slot.transport.destroy().catch(() => {});
      this.bots.delete(id);
    }
    for (const credential of wanted.values()) {
      if (this.bots.has(credential.id)) continue;
      this.bots.set(credential.id, { id: credential.id, transport: this.deps.createHelper(credential),
        fingerprint: fingerprint(credential), assignment: null, joining: false, failedAtMs: null, lastErrorCode: null });
    }
    this.refreshIdentities();
  }

  private refreshIdentities(): void {
    this.identities.retain(this.bots.keys());
    for (const slot of this.bots.values()) this.identities.set(slot.id, slot.transport.userId());
  }

  private policy(channelId: string): VoiceRoomPolicyDto {
    const policy = this.settingsCache.voice.rooms?.[channelId] ?? DEFAULT_VOICE_ROOM_POLICY;
    // A pin to a bot that no longer exists falls back to auto.
    return policy.pinnedBotId && !this.bots.has(policy.pinnedBotId) ? { ...policy, pinnedBotId: null } : policy;
  }

  // ---- reconcile ----
  private async reconcile(): Promise<void> {
    try { this.settingsCache = await this.deps.settings(); } catch { /* Keep the last known settings. */ }
    let rooms: VoiceRoomInfo[];
    try { rooms = await this.deps.rooms(); } catch { rooms = []; }
    const settings = this.settingsCache;
    const coverAll = settings.recording.mode === 'always' || (settings.voice.enabled && settings.voice.scope === 'always');
    const coverage: CoverageRoom[] = [];
    const events = new Map<MatchId, string>();
    for (const room of rooms) {
      const key = roomKey(room.eventId, room.matchId);
      if (!room.voiceChannelId || !room.playerIds.length || room.phase === 'final' || this.resolved.has(key)) continue;
      const policy = this.policy(room.voiceChannelId);
      if (policy.coverage === 'never') continue;
      const judgeCall = this.judgeOpen.has(key) || room.judgeCall === true;
      const record = shouldRecord(policy.recording === 'inherit' ? settings.recording.mode : policy.recording, judgeCall);
      const monitor = settings.voice.enabled && (settings.voice.scope === 'always' || judgeCall || policy.coverage === 'always');
      // A room may record more than the global setting (it still shows its notice before capturing anything).
      const roomCoverAll = policy.coverage === 'always' || coverAll || policy.recording === 'always';
      if (!(record || monitor) || (!roomCoverAll && !judgeCall)) continue;
      coverage.push({ matchId: room.matchId, channelId: room.voiceChannelId, judgeCall, record, monitor,
        priority: policy.priority, pinnedBotId: policy.pinnedBotId });
      events.set(room.matchId, room.eventId);
    }
    this.coverage = coverage;
    this.coverageEvents = events;
    await this.expireSuspended();
    // Lazy helper login: only when the rooms outnumber the bots that are ready (or a needed room pins an idle helper).
    const ready = () => [...this.bots.values()].filter(slot => this.usable(slot)).map(slot => slot.id);
    // Logins run in the background so a judge-call room is never delayed by a slow helper; each finished
    // login reconciles again, and a helper that fails is skipped in favour of the next idle one.
    const starting = [...this.bots.values()].filter(slot => slot.transport.state() === 'logging-in').length;
    const shortfall = coverage.length - ready().length - starting;
    const idle = [...this.bots.values()].filter(slot => slot.id !== MAIN_VOICE_BOT_ID && slot.transport.state() === 'idle');
    const login = new Set<BotSlot>(shortfall > 0 ? idle.slice(0, shortfall) : []);
    for (const room of coverage) { const pinned = idle.find(slot => slot.id === room.pinnedBotId); if (pinned) login.add(pinned); }
    for (const slot of login) void slot.transport.ensureReady().then(() => { this.refreshIdentities(); return this.schedule(); });
    const current = new Map<string, MatchId>();
    for (const slot of this.bots.values()) if (slot.assignment) current.set(slot.id, slot.assignment.matchId);
    const plan = planVoiceAssignments(coverage, ready(), current);
    // Releases first, so a reclaimed bot is free before it joins elsewhere.
    for (const slot of this.bots.values()) {
      const target = plan.bots.get(slot.id);
      const room = target ? coverage.find(item => item.matchId === target) : undefined;
      const assignment = slot.assignment;
      if (assignment && (!room || assignment.matchId !== room.matchId || assignment.channelId !== room.channelId ||
          assignment.eventId !== events.get(room.matchId))) await this.release(slot, room ? 'room changed' : 'not needed');
    }
    for (const slot of this.bots.values()) {
      if (!this.deps.isActive() || this.stopped) return;
      const target = plan.bots.get(slot.id);
      const room = target ? coverage.find(item => item.matchId === target) : undefined;
      if (!room) continue;
      const info = rooms.find(item => item.matchId === room.matchId)!;
      if (!slot.assignment) await this.join(slot, room, info);
      if (slot.assignment) await this.update(slot.assignment, room, info);
    }
    for (const set of [this.notices, this.noticeFailed])
      for (const key of [...set]) if (!coverage.some(room => roomKey(events.get(room.matchId)!, room.matchId) === key)) set.delete(key);
    for (const key of [...this.roomRetry.keys()])
      if (!coverage.some(room => roomKey(events.get(room.matchId)!, room.matchId) === key)) this.roomRetry.delete(key);
    this.publish();
  }

  /** Finalizes suspended recordings past the rejoin window or whose room no longer records. */
  private async expireSuspended(): Promise<void> {
    for (const [key, entry] of [...this.suspended]) {
      const room = this.coverage.find(item => roomKey(this.coverageEvents.get(item.matchId) ?? '', item.matchId) === key);
      const expired = this.now() - entry.lostAtPolicyMs >= REJOIN_WINDOW_MS;
      if (!expired && room && room.record && room.channelId === entry.channelId) continue;
      this.suspended.delete(key);
      await entry.recording.gap?.(entry.lostAtMs, this.clock(), 'disconnected').catch(() => {});
      await entry.recording.stop('disconnected').catch(() => this.deps.log('A voice recording could not be finalized.'));
    }
  }

  private usable(slot: BotSlot): boolean {
    if (slot.transport.state() !== 'ready') return false;
    return slot.failedAtMs === null || this.now() - slot.failedAtMs >= JOIN_RETRY_MS;
  }

  private async join(slot: BotSlot, room: CoverageRoom, info: VoiceRoomInfo): Promise<void> {
    slot.joining = true;
    this.publish();
    let handle: VoiceChannelHandle;
    try { handle = await slot.transport.join(room.channelId); }
    catch {
      slot.failedAtMs = this.now();
      slot.lastErrorCode = 'join-failed';
      slot.joining = false;
      this.deps.log(`Voice bot ${slot.id === MAIN_VOICE_BOT_ID ? 'main' : 'helper'} could not join match room ${room.matchId}.`);
      this.dirty = true;
      return;
    }
    slot.joining = false;
    slot.failedAtMs = null;
    slot.lastErrorCode = null;
    const config = loudnessConfig(this.settingsCache.voice);
    const key = roomKey(info.eventId, room.matchId);
    const retry = this.roomRetry.get(key);
    const assignment: Assignment = { eventId: info.eventId, matchId: room.matchId, channelId: room.channelId, handle,
      subscriptions: new Map(), decoders: new Map(), monitor: false, judgeCall: room.judgeCall, recording: null, recordingStart: null,
      recordingRetryAtMs: retry?.atMs ?? 0, recordingFailures: retry?.failures ?? 0, gapStartMs: null,
      detector: new LoudnessDetector(config, spike => { void this.onSpike(assignment, spike); }) };
    // Rejoined within the window: continue the same recording, with the time away audited as a gap.
    const suspended = this.suspended.get(key);
    if (suspended && suspended.channelId === room.channelId) {
      this.suspended.delete(key);
      if (suspended.recording.active !== false) {
        assignment.recording = suspended.recording;
        await suspended.recording.gap?.(suspended.lostAtMs, this.clock(), 'disconnected').catch(() => {});
      }
    }
    slot.assignment = assignment;
    handle.onState?.(state => this.onConnectionState(slot, assignment, state));
    handle.onLost(() => {
      if (slot.assignment !== assignment) return;
      slot.lastErrorCode = 'disconnected';
      if (slot.id !== MAIN_VOICE_BOT_ID && assignment.judgeCall) void this.dropNotice(assignment);
      // No bench: rejoin at once (a failing join benches it), keeping the recording for REJOIN_WINDOW_MS.
      void this.release(slot, 'disconnected', true).then(() => this.schedule());
    });
  }

  private onConnectionState(slot: BotSlot, assignment: Assignment, state: VoiceConnectionPhase): void {
    if (slot.assignment !== assignment) return;
    if (state !== 'ready') {
      if (assignment.gapStartMs === null) assignment.gapStartMs = this.clock();
      return;
    }
    const from = assignment.gapStartMs;
    assignment.gapStartMs = null;
    if (from !== null && assignment.recording) void assignment.recording.gap?.(from, this.clock(), 'reconnecting').catch(() => {});
  }

  private async dropNotice(assignment: Assignment): Promise<void> {
    if (this.now() - this.lastDropNoticeAtMs < ORGANIZER_NOTICE_INTERVAL_MS) return;
    this.lastDropNoticeAtMs = this.now();
    await this.deps.notifyOrganizer(this.settingsCache.voice.notifyChannelId,
      `⚠️ The helper bot covering the judge call in ${assignment.matchId} lost its voice connection; it is rejoining.`)
      .catch(() => this.deps.log('The helper drop notice could not be sent.'));
  }

  private optedOut(): Set<string> { return new Set(this.settingsCache.recording.optOutUserIds ?? []); }

  private async update(assignment: Assignment, room: CoverageRoom, info: VoiceRoomInfo): Promise<void> {
    assignment.judgeCall = room.judgeCall;
    // Consent: the notice is posted BEFORE anyone is subscribed or recorded. If it cannot be posted, nothing
    // is captured in this room (audited once); the next reconcile retries.
    const key = roomKey(info.eventId, room.matchId);
    if (!this.notices.has(key)) {
      try {
        await this.deps.postNotice(room.channelId, this.settingsCache.noticeText?.trim() || DEFAULT_MONITOR_NOTICE);
        this.notices.add(key);
        this.noticeFailed.delete(key);
      } catch {
        this.deps.log(`The monitoring notice could not be posted in match room ${room.matchId}; audio is not captured there until it can be.`);
        if (!this.noticeFailed.has(key)) {
          this.noticeFailed.add(key);
          await this.deps.audit?.({ kind: 'voice.notice_failed', actor: { kind: 'bot', id: 'voice-monitor' }, guildId: this.deps.guildId,
            eventId: info.eventId, payload: { matchId: room.matchId, channelId: room.channelId, record: room.record, monitor: room.monitor } })
            .catch(() => {});
        }
        assignment.monitor = false;
        return;
      }
    }
    assignment.monitor = room.monitor;
    assignment.detector.configure(loudnessConfig(this.settingsCache.voice));
    // Seated players only: never spectators, judges, other bots or players who opted out.
    const optedOut = this.optedOut();
    const seated = new Set(info.playerIds.filter(id => !this.identities.has(id) && !optedOut.has(id)));
    for (const [userId, subscription] of [...assignment.subscriptions]) if (!seated.has(userId)) {
      subscription.close();
      assignment.subscriptions.delete(userId);
      assignment.decoders.get(userId)?.delete();
      assignment.decoders.delete(userId);
      assignment.detector.forget(userId);
    }
    for (const userId of seated) if (!assignment.subscriptions.has(userId))
      assignment.subscriptions.set(userId, assignment.handle.subscribe(userId, packet => this.onPacket(assignment, userId, packet)));
    // A recording that stopped on its own (storage full) is cleared so it can be retried with backoff.
    if (assignment.recording && assignment.recording.active === false) {
      assignment.recording = null;
      this.backoff(assignment, key);
    }
    if (room.record && !assignment.recording && !assignment.recordingStart && seated.size && this.now() >= assignment.recordingRetryAtMs) {
      assignment.recordingStart = this.deps.recorder.start({ eventId: info.eventId, matchId: room.matchId, channelId: room.channelId,
        playerIds: [...seated] }).then(session => {
        assignment.recording = session;
        assignment.recordingFailures = 0;
        this.roomRetry.delete(key);
      }, () => {
        this.backoff(assignment, key);
        this.deps.log(`Recording could not start in match room ${room.matchId}.`);
      })
        .finally(() => { assignment.recordingStart = null; });
      await assignment.recordingStart;
    } else if (!room.record && assignment.recording) {
      const session = assignment.recording;
      assignment.recording = null;
      await session.stop('recording turned off');
    } else if (assignment.recording?.addPlayer && assignment.recording.players) {
      // Seated after the start (late arrival, seat swap): a new track aligned to the session start.
      const recorded = new Set(assignment.recording.players());
      for (const userId of seated) if (!recorded.has(userId)) void assignment.recording.addPlayer(userId).catch(() => {});
    }
  }

  private backoff(assignment: Assignment, key: string): void {
    assignment.recordingFailures += 1;
    const delay = Math.min(RECORDING_RETRY_MAX_MS, RECORDING_RETRY_MIN_MS * 2 ** Math.min(10, assignment.recordingFailures - 1));
    assignment.recordingRetryAtMs = this.now() + delay;
    this.roomRetry.set(key, { atMs: assignment.recordingRetryAtMs, failures: assignment.recordingFailures });
  }

  private onPacket(assignment: Assignment, userId: string, packet: Buffer): void {
    const atMs = this.clock();
    assignment.recording?.write(userId, packet, atMs);
    if (!assignment.monitor) return;
    let decoder = assignment.decoders.get(userId);
    if (!decoder) {
      try { decoder = this.deps.decoder(); } catch { return; }
      assignment.decoders.set(userId, decoder);
    }
    let pcm: Int16Array;
    try { pcm = decoder.decode(packet); } catch { return; }
    const samples = opusPacketSamples(packet);
    assignment.detector.pushFrame(userId, pcm, atMs, samples ? samples / 48 : FRAME_MS);
  }

  private async onSpike(assignment: Assignment, spike: LoudnessSpike): Promise<void> {
    const recordingOffsetMs = assignment.recording ? assignment.recording.offsetMs(spike.startedAtMs) : null;
    const thresholdDbfs = assignment.detector.current().thresholdDbfs;
    try {
      await this.deps.appendFlag({ kind: 'volume', guildId: this.deps.guildId, channelId: assignment.channelId, eventId: assignment.eventId,
        matchId: assignment.matchId, userId: spike.userId, occurredAtMs: Math.round(spike.startedAtMs),
        detail: { peakDbfs: spike.peakDbfs, rmsDbfs: spike.rmsDbfs, sustainedMs: spike.durationMs, thresholdDbfs, recordingOffsetMs } });
    } catch { this.deps.log(`A loudness flag in match room ${assignment.matchId} could not be saved.`); }
    const voice = this.settingsCache.voice;
    if (voice.notifyDiscord && this.now() - this.lastOrganizerNoticeAtMs >= ORGANIZER_NOTICE_INTERVAL_MS) {
      this.lastOrganizerNoticeAtMs = this.now();
      await this.deps.notifyOrganizer(voice.notifyChannelId,
        `🔊 Loud audio in ${assignment.matchId} from <@${spike.userId}> (peak ${spike.peakDbfs} dBFS for ${spike.durationMs} ms). Review it on the dashboard.`)
        .catch(() => this.deps.log('The loudness notice could not be sent.'));
    }
  }

  /** Leaves the room. `suspend` keeps an active recording for a quick rejoin instead of finalizing it. */
  private async release(slot: BotSlot, reason: string, suspend = false): Promise<void> {
    const assignment = slot.assignment;
    if (!assignment) return;
    slot.assignment = null;
    if (assignment.recordingStart) await assignment.recordingStart;
    for (const subscription of assignment.subscriptions.values()) subscription.close();
    for (const decoder of assignment.decoders.values()) { try { decoder.delete(); } catch { /* freed */ } }
    assignment.subscriptions.clear();
    assignment.decoders.clear();
    try { assignment.handle.leave(); } catch { /* already gone */ }
    const recording = assignment.recording;
    assignment.recording = null;
    if (!recording) return;
    if (suspend && recording.active !== false && !this.stopped) {
      this.suspended.set(roomKey(assignment.eventId, assignment.matchId), { recording, channelId: assignment.channelId,
        lostAtMs: assignment.gapStartMs ?? this.clock(), lostAtPolicyMs: this.now() });
      return;
    }
    await recording.stop(reason).catch(() => this.deps.log(`Recording in match room ${assignment.matchId} could not be finalized.`));
  }

  private botStatus(slot: BotSlot): VoiceBotRuntimeStatus {
    if (slot.assignment) return 'connected';
    if (slot.joining) return 'connecting';
    if (slot.failedAtMs !== null && this.now() - slot.failedAtMs < JOIN_RETRY_MS) return 'error';
    return slot.transport.state();
  }

  /** The live state the dashboard reads; never carries a token. */
  snapshot(): VoicePoolLiveState {
    const bots: VoicePoolLiveState['bots'] = {};
    for (const slot of this.bots.values()) {
      const health = slot.transport.health?.();
      bots[slot.id] = { connected: !!slot.assignment, status: this.botStatus(slot),
        assignedChannelId: slot.assignment?.channelId ?? null, assignedMatchId: slot.assignment?.matchId ?? null,
        ...(health ? { lastReadyAtMs: health.lastReadyAtMs, consecutiveFailures: health.consecutiveFailures } : {}),
        lastErrorCode: slot.lastErrorCode ?? health?.lastErrorCode ?? null };
    }
    const rooms = this.coverage.map(room => {
      const slot = [...this.bots.values()].find(item => item.assignment?.matchId === room.matchId &&
        item.assignment.eventId === this.coverageEvents.get(room.matchId));
      const botId = slot?.id ?? null;
      return { matchId: room.matchId, channelId: room.channelId, botId,
        status: roomStatus({ record: room.record && !!slot?.assignment?.recording && slot.assignment.recording.active !== false }, botId) };
    });
    return { bots, rooms };
  }

  private publish(): void { if (!this.stopped) this.deps.publish(this.snapshot()); }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    // A tick may be inside a 15-20 s voice join or helper login: wait for it briefly only, so the recordings
    // below still get their budget (anything the tick starts afterwards is finalized by recovery).
    if (this.running) {
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([this.running.catch(() => {}), new Promise<void>(resolve => { wait = setTimeout(resolve, SHUTDOWN_TICK_WAIT_MS); wait.unref(); })]);
      if (wait) clearTimeout(wait);
    }
    // Recordings first, all in parallel and within the shutdown budget; what does not finish is recovered on the next start.
    const recordings: RecordingHandle[] = [...this.suspended.values()].map(entry => entry.recording);
    this.suspended.clear();
    for (const slot of this.bots.values()) if (slot.assignment?.recording) recordings.push(slot.assignment.recording);
    const stopping = Promise.all(recordings.map(recording => recording.stop('shutdown').catch(() => {})));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([stopping, new Promise<void>(resolve => { timer = setTimeout(resolve, SHUTDOWN_RECORDING_BUDGET_MS); timer.unref(); })]);
    if (timer) clearTimeout(timer);
    await Promise.all([...this.bots.values()].map(slot => this.release(slot, 'shutdown').catch(() => {})));
    await Promise.all([...this.bots.values()].map(slot => slot.transport.destroy().catch(() => {})));
    this.identities.clear();
    this.deps.publish(null);
  }
}

function fingerprint(credential: Pick<VoiceBotCredential, 'token'>): string {
  return createHash('sha256').update(credential.token).digest('hex');
}
