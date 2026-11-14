// Voice runtime core: decides which match rooms need a bot, assigns pool bots, joins, subscribes to the
// seated players only, and feeds packets to the recorder and the loudness detector. Library-free: every
// Discord or codec touch goes through transport.ts, so this runs against fakes in tests.
import { createHash } from 'node:crypto';
import { DEFAULT_MODERATION_SETTINGS, type MatchId, type ModerationSettingsBodyDto, type VoiceBotRuntimeStatus } from '@tcg-live/core';
import type { MatchRoomInfo } from '../discord/features.js';
import type { ModerationFlagInput } from '../moderation/flags.js';
import type { OpsAuditInput } from '../ops/audit.js';
import { VoicePoolIdentities } from './identities.js';
import { FRAME_MS, LoudnessDetector, loudnessConfig, type LoudnessSpike } from './loudness.js';
import { opusPacketSamples } from './ogg-writer.js';
import { MAIN_VOICE_BOT_ID, planVoiceAssignments, roomStatus, type CoverageRoom, type VoicePoolLiveState } from './pool.js';
import { shouldRecord, type RecordingTarget } from './recorder.js';
import type { VoiceBotCredential } from './tokens.js';
import type { OpusDecoder, OpusDecoderFactory, VoiceBotTransport, VoiceChannelHandle, VoicePacketSubscription } from './transport.js';

export const DEFAULT_MONITOR_NOTICE = '🔴 Audio monitoring/recording is active for this match.';
const JOIN_RETRY_MS = 30_000;
const ORGANIZER_NOTICE_INTERVAL_MS = 60_000;
const SAFETY_RECONCILE_MS = 30_000;
/** A recording that could not start (for example evidence storage full) is retried after this long. */
const RECORDING_RETRY_MS = 5 * 60_000;

/** Room info plus optional live match detail from the runtime. */
export type VoiceRoomInfo = MatchRoomInfo & { phase?: string; judgeCall?: boolean };

export interface RecordingHandle {
  readonly startedAtMs: number;
  /** False once the recording stopped on its own (for example evidence storage full). */
  readonly active?: boolean;
  write(userId: string, packet: Buffer, atMs: number): void;
  offsetMs(atMs: number): number;
  stop(reason?: string): Promise<void>;
}
export interface RecorderLike {
  recover(): Promise<unknown>;
  start(target: RecordingTarget): Promise<RecordingHandle>;
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
  now?: () => number;
  log(message: string): void;
  /** Disable the periodic safety reconcile (tests). */
  timers?: boolean;
}

interface Assignment {
  eventId: string; matchId: MatchId; channelId: string;
  handle: VoiceChannelHandle;
  subscriptions: Map<string, VoicePacketSubscription>;
  decoders: Map<string, OpusDecoder>;
  detector: LoudnessDetector;
  monitor: boolean;
  recording: RecordingHandle | null;
  recordingStart: Promise<void> | null;
  /** A refused start (storage full) is retried no sooner than this. */
  recordingRetryAtMs: number;
}
interface BotSlot {
  id: string;
  transport: VoiceBotTransport;
  /** Fingerprint of the helper credential; a changed token rebuilds the transport. */
  fingerprint: string | null;
  assignment: Assignment | null;
  joining: boolean;
  failedAtMs: number | null;
}

const roomKey = (eventId: string, matchId: string) => `${eventId}:${matchId}`;

export class VoiceMonitor {
  private readonly bots = new Map<string, BotSlot>();
  private readonly judgeOpen = new Set<string>();
  private readonly resolved = new Set<string>();
  private readonly notices = new Set<string>();
  /** Rooms whose notice failed (audited once per activation); nothing is captured there until it posts. */
  private readonly noticeFailed = new Set<string>();
  private readonly identities: VoicePoolIdentities;
  private readonly now: () => number;
  private settingsCache: ModerationSettingsBodyDto = DEFAULT_MODERATION_SETTINGS;
  private coverage: CoverageRoom[] = [];
  private coverageEvents = new Map<MatchId, string>();
  private dirty = false;
  private running: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastOrganizerNoticeAtMs = -Infinity;

  constructor(private readonly deps: VoiceMonitorDeps) {
    this.identities = deps.identities ?? new VoicePoolIdentities();
    this.now = deps.now ?? Date.now;
    this.bots.set(MAIN_VOICE_BOT_ID, { id: MAIN_VOICE_BOT_ID, transport: deps.main, fingerprint: null, assignment: null, joining: false, failedAtMs: null });
  }

  async start(): Promise<void> {
    try { await this.deps.recorder.recover(); } catch { this.deps.log('Voice recordings from a previous run could not be checked.'); }
    await this.reloadHelpers();
    if (this.deps.timers !== false) {
      this.timer = setInterval(() => { void this.schedule(); }, SAFETY_RECONCILE_MS);
      this.timer.unref();
    }
    await this.schedule();
  }

  // ---- inputs ----
  judgeCalled(eventId: string, matchId: MatchId): Promise<void> { this.judgeOpen.add(roomKey(eventId, matchId)); return this.schedule(); }
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
    const wanted = new Map(credentials.map(credential => [credential.id, credential]));
    for (const [id, slot] of [...this.bots]) {
      if (id === MAIN_VOICE_BOT_ID) continue;
      const credential = wanted.get(id);
      if (credential && fingerprint(credential.token) === slot.fingerprint) continue;
      await this.release(slot, 'bot removed');
      await slot.transport.destroy().catch(() => {});
      this.bots.delete(id);
    }
    for (const credential of credentials) {
      if (this.bots.has(credential.id)) continue;
      this.bots.set(credential.id, { id: credential.id, transport: this.deps.createHelper(credential),
        fingerprint: fingerprint(credential.token), assignment: null, joining: false, failedAtMs: null });
    }
    this.refreshIdentities();
  }

  private refreshIdentities(): void {
    this.identities.retain(this.bots.keys());
    for (const slot of this.bots.values()) this.identities.set(slot.id, slot.transport.userId());
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
      const judgeCall = this.judgeOpen.has(key) || room.judgeCall === true;
      const record = shouldRecord(settings.recording.mode, judgeCall);
      const monitor = settings.voice.enabled && (settings.voice.scope === 'always' || judgeCall);
      if (!(record || monitor) || (!coverAll && !judgeCall)) continue;
      coverage.push({ matchId: room.matchId, channelId: room.voiceChannelId, judgeCall, record, monitor });
      events.set(room.matchId, room.eventId);
    }
    this.coverage = coverage;
    this.coverageEvents = events;
    // Lazy helper login: only when the rooms outnumber the bots that are ready.
    const ready = () => [...this.bots.values()].filter(slot => this.usable(slot)).map(slot => slot.id);
    // Logins run in the background so a judge-call room is never delayed by a slow helper; each finished
    // login reconciles again, and a helper that fails is skipped in favour of the next idle one.
    const starting = [...this.bots.values()].filter(slot => slot.transport.state() === 'logging-in').length;
    const shortfall = coverage.length - ready().length - starting;
    if (shortfall > 0) {
      const idle = [...this.bots.values()].filter(slot => slot.id !== MAIN_VOICE_BOT_ID && slot.transport.state() === 'idle');
      for (const slot of idle.slice(0, shortfall)) void slot.transport.ensureReady().then(() => { this.refreshIdentities(); return this.schedule(); });
    }
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
    this.publish();
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
      slot.joining = false;
      this.deps.log(`Voice bot ${slot.id === MAIN_VOICE_BOT_ID ? 'main' : 'helper'} could not join match room ${room.matchId}.`);
      this.dirty = true;
      return;
    }
    slot.joining = false;
    slot.failedAtMs = null;
    const config = loudnessConfig(this.settingsCache.voice);
    const assignment: Assignment = { eventId: info.eventId, matchId: room.matchId, channelId: room.channelId, handle,
      subscriptions: new Map(), decoders: new Map(), monitor: false, recording: null, recordingStart: null, recordingRetryAtMs: 0,
      detector: new LoudnessDetector(config, spike => { void this.onSpike(assignment, spike); }) };
    slot.assignment = assignment;
    handle.onLost(() => {
      if (slot.assignment !== assignment) return;
      slot.failedAtMs = this.now();
      void this.release(slot, 'disconnected').then(() => this.schedule());
    });
  }

  private async update(assignment: Assignment, room: CoverageRoom, info: VoiceRoomInfo): Promise<void> {
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
    // Seated players only: never spectators, judges or other bots.
    const seated = new Set(info.playerIds.filter(id => !this.identities.has(id)));
    for (const [userId, subscription] of [...assignment.subscriptions]) if (!seated.has(userId)) {
      subscription.close();
      assignment.subscriptions.delete(userId);
      assignment.decoders.get(userId)?.delete();
      assignment.decoders.delete(userId);
      assignment.detector.forget(userId);
    }
    for (const userId of seated) if (!assignment.subscriptions.has(userId))
      assignment.subscriptions.set(userId, assignment.handle.subscribe(userId, packet => this.onPacket(assignment, userId, packet)));
    if (room.record && !assignment.recording && !assignment.recordingStart && this.now() >= assignment.recordingRetryAtMs) {
      assignment.recordingStart = this.deps.recorder.start({ eventId: info.eventId, matchId: room.matchId, channelId: room.channelId,
        playerIds: [...seated] }).then(session => { assignment.recording = session; },
        () => {
          assignment.recordingRetryAtMs = this.now() + RECORDING_RETRY_MS;
          this.deps.log(`Recording could not start in match room ${room.matchId}.`);
        })
        .finally(() => { assignment.recordingStart = null; });
      await assignment.recordingStart;
    } else if (!room.record && assignment.recording) {
      const session = assignment.recording;
      assignment.recording = null;
      await session.stop('recording turned off');
    }
  }

  private onPacket(assignment: Assignment, userId: string, packet: Buffer): void {
    const atMs = this.now();
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

  private async release(slot: BotSlot, reason: string): Promise<void> {
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
    await recording?.stop(reason).catch(() => this.deps.log(`Recording in match room ${assignment.matchId} could not be finalized.`));
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
    for (const slot of this.bots.values()) bots[slot.id] = { connected: !!slot.assignment, status: this.botStatus(slot),
      assignedChannelId: slot.assignment?.channelId ?? null, assignedMatchId: slot.assignment?.matchId ?? null };
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
    await this.running?.catch(() => {});
    for (const slot of this.bots.values()) await this.release(slot, 'shutdown');
    for (const slot of this.bots.values()) await slot.transport.destroy().catch(() => {});
    this.identities.clear();
    this.deps.publish(null);
  }
}

function fingerprint(token: string): string { return createHash('sha256').update(token).digest('hex'); }
