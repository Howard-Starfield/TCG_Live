// In-memory admin runtime for `npm run admin:demo`: a scripted event driven by the real domain transition().
import { randomUUID } from 'node:crypto';
import { AUDIT_PAGE_LIMIT, type AdminCommandRequestDto, type AdminCommandResultDto, type AuditEntryDto,
  type EventSnapshotDto, type EventSummaryDto, type MemberDto, type PanelRefreshResultDto, type RuntimeStatusDto,
  type Snowflake } from '@tcg-live/core';
import { ADMIN, createSignupFixture, RuleError, transition, type Command, type EventState, type MatchId,
  type Outcome, type Player, type Transition } from '../../rehearsal/domain.js';
import { noChangeReply, savedReply } from '../../discord/controller.js';
import type { CardSlot } from '../../discord/session.js';
import { commandContent, CONFLICT, preconditionHolds, toDomainCommand, webCommandId } from '../commands.js';
import type { DemoPlayMode } from '../config.js';
import { AdminConflictError, AdminNotFoundError, AdminRuleError, AdminUnavailableError, type AdminPrincipal,
  type AdminRuntime, type AdminRuntimeChange, type AdminRuntimeListener } from '../runtime-types.js';
import { defaultBuildId, ListenerSet } from './listeners.js';
import { mapAuditRow, mapSnapshot, type AdminAuditRow, type AdminSessionRow } from './mappers.js';

export const DEMO_ADMIN_ID: Snowflake = '910000000000000001';
export const DEMO_GUILD_ID: Snowflake = '910000000000000100';
export const DEMO_CHANNEL_ID: Snowflake = '910000000000000101';
export const DEMO_MATCH_CHANNELS: Record<MatchId, Snowflake> = { M1: '910000000000000102', M2: '910000000000000103' };
/** Fake people; no avatars. The fifth joins and is removed so signup removal shows up in the audit. */
export const DEMO_MEMBERS: readonly MemberDto[] = [
  { id: DEMO_ADMIN_ID, displayName: 'Organizer', avatarUrl: null },
  { id: '910000000000000011', displayName: 'Ava Chen', avatarUrl: null },
  { id: '910000000000000012', displayName: 'Ben Ortiz', avatarUrl: null },
  { id: '910000000000000013', displayName: 'Cy Park', avatarUrl: null },
  { id: '910000000000000014', displayName: 'Dee Ross', avatarUrl: null },
  { id: '910000000000000015', displayName: 'Eli Moss', avatarUrl: null }
];
const [, ava, ben, cy, dee, eli] = DEMO_MEMBERS.map(member => member.id) as [string, string, string, string, string, string];

/** Time and timers, injectable for deterministic tests. */
export interface DemoClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: DemoClock = {
  now: () => Date.now(),
  setTimeout(callback, ms) { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
  clearTimeout(handle) { clearTimeout(handle as NodeJS.Timeout); }
};

type Who = 'admin' | Player | { member: Snowflake };
export type DemoStep =
  | { wait: number; who: Who; command: Command }
  | { wait: number; expire: MatchId }          // waits for the match deadline, then applies the timer clockCheck
  | { wait: number; repost: CardSlot }         // a sticky card repost: new message ID, panelRevision moves
  | { wait: number; restart: true };           // retire this event and start the next one

/** The scripted scenario. `wait` is the delay in milliseconds after the previous step. */
export function demoScript(): DemoStep[] {
  const join: Command = { type: 'signupJoin' };
  return [
    { wait: 2_000, who: { member: ava }, command: join },
    { wait: 2_500, who: { member: ben }, command: join },
    { wait: 2_500, who: { member: eli }, command: join },
    { wait: 2_500, who: { member: cy }, command: join },
    { wait: 3_000, who: 'admin', command: { type: 'signupRemove', memberId: eli } },
    { wait: 2_500, who: { member: dee }, command: join },
    { wait: 3_000, who: 'admin', command: { type: 'signupClose', adminId: DEMO_ADMIN_ID } },
    { wait: 2_500, who: 'A', command: { type: 'checkin' } },
    { wait: 2_000, who: 'B', command: { type: 'checkin' } },
    { wait: 2_500, who: 'C', command: { type: 'checkin' } },
    { wait: 1_500, repost: 'checkin' },
    { wait: 1_500, who: 'D', command: { type: 'checkin' } },
    { wait: 3_000, who: 'admin', command: { type: 'publish' } },
    { wait: 2_500, who: 'A', command: { type: 'ready', matchId: 'M1' } },
    { wait: 1_500, who: 'B', command: { type: 'ready', matchId: 'M1' } },
    { wait: 2_000, who: 'C', command: { type: 'ready', matchId: 'M2' } },
    { wait: 1_500, who: 'D', command: { type: 'ready', matchId: 'M2' } },
    { wait: 12_000, who: 'A', command: { type: 'pause', matchId: 'M1' } },
    { wait: 5_000, who: 'B', command: { type: 'callJudge', matchId: 'M1' } },
    { wait: 6_000, who: 'admin', command: { type: 'judgeResume', matchId: 'M1', reason: 'Judge checked the board state.' } },
    { wait: 4_000, who: 'C', command: { type: 'propose', matchId: 'M2', winner: 'C', expectedRevision: 0 } },
    { wait: 6_000, who: 'D', command: { type: 'dispute', matchId: 'M2', revision: 1 } },
    // A dispute followed by a new proposal keeps the judge's attention (cli.ts:47-48).
    { wait: 6_000, who: 'D', command: { type: 'propose', matchId: 'M2', winner: 'D', expectedRevision: 1 } },
    { wait: 6_000, who: 'C', command: { type: 'dispute', matchId: 'M2', revision: 2 } },
    { wait: 8_000, who: 'admin', command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Judge ruling after review.' } },
    { wait: 0, expire: 'M1' },
    { wait: 5_000, who: 'A', command: { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 } },
    { wait: 5_000, who: 'B', command: { type: 'confirm', matchId: 'M1', revision: 1 } },
    { wait: 20_000, restart: true }
  ];
}

interface DemoEvent {
  state: EventState;
  session: AdminSessionRow;
  audit: AdminAuditRow[];
  panelRevision: number;
}

type AdminDecision = 'publish' | 'signupClose' | 'signupReopen' | 'signupRemove' | 'judgeResume' | 'resolve' | 'correct';

/** Where an interactive scenario waits. */
export interface DemoPause {
  /** Index of the script step the scenario waits at. */
  step: number;
  /** The admin decision needed now. It can differ from the scripted step: after a reopen at the publish
   * step it is `signupClose` until signup is closed again. */
  decision: AdminDecision;
  /** The match the decision concerns, or null for an event-level decision. */
  matchId: MatchId | null;
  /** 'players' while scripted players first refill a removed seat or check in again; 'admin' otherwise. */
  waitingFor: 'admin' | 'players';
  /** The end-of-event hold only: milliseconds until it releases on its own. Null for every other pause. */
  releasesInMs: number | null;
}

interface PausePoint {
  step: number;
  /** event: a scripted publish or signup step; match: a judge decision; final: the hold before a restart. */
  kind: 'event' | 'match' | 'final';
  /** The scripted (or, for an expiry, synthesized) admin command whose need the pause tracks. */
  command: Command;
  /** skip: the scripted admin step is replaced by the admin's command; rerun: replay the step without
   * pausing again (the final hold before a restart); after: the step already ran (an expiry). */
  resume: 'skip' | 'rerun' | 'after';
  decision: AdminDecision;
  matchId: MatchId | null;
  waitingFor: 'admin' | 'players';
  releasesAtMs: number | null;
}

type StepResult = 'advance' | 'stay' | 'hold';

/** Default end-of-event hold in interactive mode before the scenario moves on without a correction. */
export const DEMO_FINAL_HOLD_MS = 60_000;
/** How long scripted players take to refill a seat or check in again while the scenario waits. */
export const DEMO_RECOVERY_WAIT_MS = 2_000;
/** Stored console results kept for replays, across events (the audit table keeps them forever). */
const WEB_RESULTS_KEPT = 1_000;

export interface DemoAdminRuntimeOptions {
  clock?: DemoClock;
  newEventId?: () => string;
  bootId?: string;
  buildId?: string;
  /** Match length; short so the canvas visibly animates. */
  durationMs?: number;
  /** Retired events kept for the sidebar. */
  keepRetired?: number;
  script?: DemoStep[];
  /**
   * 'autoplay' (default) applies the scripted admin steps itself. 'interactive' keeps the players acting
   * but pauses wherever an admin decision is required, until the admin's console command lands.
   */
  mode?: DemoPlayMode;
  /** Interactive: how long a finished event is held for a correction before the scenario moves on. */
  finalHoldMs?: number;
}

/**
 * Plays a scripted signup event with fake names, using the real domain rules, then retires it and
 * starts another under a new event ID so a long-running demo keeps moving. No Discord, no PostgreSQL.
 * Console commands use the same validation, preconditions, prior-result semantics and audit as the
 * Discord runtime, with the store held in memory.
 */
export class DemoAdminRuntime implements AdminRuntime {
  readonly mode = 'demo' as const;
  readonly bootId: string;
  readonly buildId: string;
  readonly runnerId = 'demo-runner';
  readonly playMode: DemoPlayMode;
  private readonly clock: DemoClock;
  private readonly newEventId: () => string;
  private readonly durationMs: number;
  private readonly keepRetired: number;
  private readonly finalHoldMs: number;
  private readonly script: DemoStep[];
  private readonly startedAtMs: number;
  private readonly listeners = new ListenerSet<AdminRuntimeChange>();
  private readonly members = new Map(DEMO_MEMBERS.map(member => [member.id, member]));
  /**
   * Applied console commands by stored command ID, across every event (command IDs are browser UUIDs).
   * Kept past `keepRetired`, so a retry for an event no longer listed still gets its stored result.
   */
  private readonly webResults = new Map<string, { eventId: string; content: string; outcome: Outcome }>();
  private current: DemoEvent;
  private retired: DemoEvent[] = [];
  private stepIndex = 0;
  private timer: unknown;
  private running = false;
  private closed = false;
  private snowflake = 0n;
  private pause: PausePoint | null = null;
  /** Timers that only exist while paused: match deadlines, player recovery, the final hold. */
  private pauseTimers = new Set<unknown>();
  private recoveryArmed = false;
  /** Pause-time deadline timers already armed, as matchId:deadline. */
  private armedClocks = new Set<string>();
  /** Matches that expired on a pause timer; each becomes a resolve decision when the current pause ends. */
  private expiredWhilePaused = new Set<MatchId>();
  /** A rerun pause point that was released; its step then runs without pausing again. */
  private released = -1;
  /** Completed scenario runs. */
  cycles = 0;

  constructor(options: DemoAdminRuntimeOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.newEventId = options.newEventId ?? randomUUID;
    this.bootId = options.bootId ?? randomUUID();
    this.buildId = options.buildId ?? defaultBuildId();
    this.durationMs = options.durationMs ?? 90_000;
    this.keepRetired = options.keepRetired ?? 5;
    this.finalHoldMs = options.finalHoldMs ?? DEMO_FINAL_HOLD_MS;
    this.script = options.script ?? demoScript();
    this.playMode = options.mode ?? 'autoplay';
    this.startedAtMs = this.clock.now();
    this.current = this.createEvent();
  }

  /** Starts the scenario. */
  start(): void {
    if (this.running || this.closed) return;
    this.running = true;
    this.scheduleNext();
  }

  /** Interactive mode: where the scenario waits, or null while it plays. */
  get pausedAt(): DemoPause | null {
    const pause = this.pause;
    if (!pause) return null;
    return { step: pause.step, decision: pause.decision, matchId: pause.matchId, waitingFor: pause.waitingFor,
      releasesInMs: pause.releasesAtMs === null ? null : Math.max(0, pause.releasesAtMs - this.clock.now()) };
  }

  /** Index of the next script step. */
  get step(): number { return this.stepIndex; }

  /**
   * Continues a paused interactive scenario without an admin command (the decision is skipped).
   * For tests and E2E. Returns false when the scenario was not paused. A match that expired during the
   * pause can pause the scenario again right away, for its own resolution.
   */
  resumeScript(): boolean {
    if (!this.pause || this.closed) return false;
    this.release();
    return true;
  }

  status(): RuntimeStatusDto {
    return {
      mode: 'demo', bootId: this.bootId, buildId: this.buildId,
      serverTimeMs: this.clock.now(), startedAtMs: this.startedAtMs,
      gateway: 'not_applicable', database: 'not_configured', lease: 'not_applicable',
      cards: { updatePending: false }, rooms: { enabled: false, warning: null }, commandsEnabled: true
    };
  }

  async listEvents(): Promise<EventSummaryDto[]> {
    return [this.current, ...this.retired].map(event => ({
      eventId: event.state.id, status: event.session.status, kind: 'signup',
      createdAtMs: Number(event.session.created_at_ms),
      retiredAtMs: event.session.retired_at_ms === null ? null : Number(event.session.retired_at_ms),
      version: event.state.version
    }));
  }

  async activeEventId(): Promise<string | null> {
    return this.current.state.id;
  }

  async snapshot(eventId?: string): Promise<EventSnapshotDto> {
    const event = this.find(eventId ?? this.current.state.id);
    return mapSnapshot({ state: event.state, session: event.session, audit: event.audit.map(mapAuditRow),
      runnerId: this.runnerId, panelRevision: event.panelRevision, members: id => this.members.get(id) });
  }

  async audit(eventId: string, afterSequence: number, limit: number): Promise<AuditEntryDto[]> {
    const event = this.find(eventId);
    const size = Number.isSafeInteger(limit) ? Math.min(AUDIT_PAGE_LIMIT, Math.max(1, limit)) : AUDIT_PAGE_LIMIT;
    return event.audit.filter(row => Number(row.sequence) > afterSequence).slice(0, size).map(mapAuditRow);
  }

  subscribe(listener: AdminRuntimeListener): () => void {
    if (this.closed) return () => {};
    return this.listeners.add(listener);
  }

  /**
   * The Discord store's order, atomically in memory: a stored result for the command ID is returned
   * before anything else (or 409 for other content), then the event must exist (404), then the
   * active-event and precondition checks (409), then the real domain transition (422 on a rule error).
   */
  async applyAdminCommand(request: AdminCommandRequestDto, principal: AdminPrincipal): Promise<AdminCommandResultDto> {
    if (this.closed) throw new AdminUnavailableError('The demo has stopped.');
    // Every demo event has the same configured admin.
    const command = this.ruled(() => toDomainCommand(request.command, DEMO_ADMIN_ID));
    const commandId = webCommandId(request.commandId);
    const content = commandContent(request);
    const prior = this.webResults.get(commandId);
    if (prior) {
      if (prior.eventId !== request.eventId || prior.content !== content) throw new AdminConflictError(CONFLICT.reused);
      return this.commandResult(command, prior.outcome);
    }
    const event = this.find(request.eventId);
    if (event !== this.current) throw new AdminConflictError(CONFLICT.inactive);
    if (!preconditionHolds(event.state, request.precondition)) throw new AdminConflictError(CONFLICT.changed);
    const nowMs = this.clock.now();
    const result = this.ruled(() => transition(event.state, ADMIN, command, nowMs, this.runnerId));
    if (result.outcome.applied) {
      this.record(result, ADMIN, command, nowMs, 'web', principal.id, commandId);
      this.webResults.set(commandId, { eventId: event.state.id, content, outcome: result.outcome });
      if (this.webResults.size > WEB_RESULTS_KEPT) this.webResults.delete(this.webResults.keys().next().value!);
      this.adminCommandLanded(command);
    }
    return this.commandResult(command, result.outcome);
  }

  /** A no-op repair in the demo: the cards are in memory. It moves panelRevision like a Discord rebind. */
  async refreshPanels(eventId: string): Promise<PanelRefreshResultDto> {
    if (this.closed) throw new AdminUnavailableError('The demo has stopped.');
    const event = this.find(eventId);
    if (event !== this.current) throw new AdminConflictError(CONFLICT.inactive);
    event.panelRevision++;
    this.listeners.emit({ type: 'panels', eventId });
    return { cards: 'refreshed', roomWarning: null };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.running = false;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.clearPauseTimers();
    this.listeners.clear();
  }

  // Commands -------------------------------------------------------------------------------------

  private ruled<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      if (error instanceof RuleError) throw new AdminRuleError(error.message);
      throw error;
    }
  }

  /** The text the Discord path replies with; the demo's cards always update. */
  private commandResult(command: Command, outcome: Outcome): AdminCommandResultDto {
    return { applied: outcome.applied, result: outcome.applied ? savedReply(command.type, false, '') : noChangeReply(outcome.result),
      version: outcome.version, cards: 'updated', roomWarning: null };
  }

  /**
   * Interactive mode: after any applied admin command, the paused step is evaluated again. The scenario
   * resumes only when the scripted decision is done or moot; otherwise it stays paused, showing what is
   * needed now. The end-of-event hold releases on a correction (or on its own after finalHoldMs).
   */
  private adminCommandLanded(command: Command): void {
    const pause = this.pause;
    if (!pause) return;
    if (pause.kind === 'final') {
      if (command.type === 'correct') this.release();
      else this.armPauseClocks();
      return;
    }
    this.reconsider();
  }

  // Interactive pauses ---------------------------------------------------------------------------

  private get interactive(): boolean { return this.playMode === 'interactive'; }

  /** Whether the domain would accept `command` from the admin now. */
  private wouldApply(command: Command): boolean {
    try { return transition(this.current.state, ADMIN, command, this.clock.now(), this.runnerId).outcome.applied; }
    catch (error) {
      if (error instanceof RuleError) return false;
      throw error;
    }
  }

  /** A scripted event step is done (or moot) once its purpose is met; nothing more is waited for. */
  private eventDone(command: Command): boolean {
    const { signup, published } = this.current.state;
    switch (command.type) {
      // The removal makes room for the next scripted joiner; any removal does, and so does closing.
      case 'signupRemove': return !signup || signup.status !== 'open' || signup.roster.length < 4;
      case 'signupClose': return !signup || signup.status !== 'open';
      case 'signupReopen': return !signup || signup.status === 'open' || published;
      case 'publish': return published;
      default: return true;
    }
  }

  /**
   * What an unfinished event step needs now: an admin decision, or scripted players first (a seat to
   * refill while signup is open, or check-ins again after a reopen and close).
   */
  private eventNeed(command: Command): { decision: AdminDecision; players: boolean } {
    const { signup, checkins } = this.current.state;
    if (command.type === 'signupRemove' || command.type === 'signupReopen') return { decision: command.type, players: false };
    if (signup?.status === 'open') return { decision: 'signupClose', players: signup.roster.length < 4 };
    return { decision: 'publish', players: checkins.length < 4 };
  }

  /** Pauses at `point` unless its decision is already done. Returns whether the scenario is paused. */
  private enterPause(point: Omit<PausePoint, 'decision' | 'matchId' | 'waitingFor' | 'releasesAtMs'>): boolean {
    const matchId = point.kind !== 'final' && 'matchId' in point.command ? point.command.matchId : null;
    this.pause = { ...point, decision: point.command.type as AdminDecision, matchId, waitingFor: 'admin', releasesAtMs: null };
    if (point.kind === 'final') {
      const releasesAtMs = this.clock.now() + this.finalHoldMs;
      this.pause.releasesAtMs = releasesAtMs;
      this.addPauseTimer(() => { if (this.pause?.kind === 'final') this.release(); }, this.finalHoldMs);
      this.armPauseClocks();
      return true;
    }
    if (!this.evaluate()) {
      this.pause = null;
      return false;
    }
    return true;
  }

  /** Updates the current pause from the state. False when its decision is done. */
  private evaluate(): boolean {
    const pause = this.pause!;
    if (pause.kind === 'match') {
      if (!this.wouldApply(pause.command)) return false;
    } else if (pause.kind === 'event') {
      if (this.eventDone(pause.command)) return false;
      const need = this.eventNeed(pause.command);
      pause.decision = need.decision;
      pause.waitingFor = need.players ? 'players' : 'admin';
      if (need.players) this.armRecovery();
    }
    this.armPauseClocks();
    return true;
  }

  /** Re-evaluates the current pause after a change; resumes when its decision is done. */
  private reconsider(): void {
    if (this.pause && this.pause.kind !== 'final' && !this.evaluate()) this.release();
  }

  /** Ends the current pause and continues the script, unless a match that expired meanwhile needs a judge. */
  private release(): void {
    const pause = this.pause;
    if (!pause) return;
    this.pause = null;
    this.clearPauseTimers();
    if (pause.resume === 'skip') this.stepIndex++;
    else if (pause.resume === 'rerun') this.released = this.stepIndex;
    for (const matchId of [...this.expiredWhilePaused]) {
      this.expiredWhilePaused.delete(matchId);
      const match = this.current.state.matches.find(item => item.id === matchId)!;
      if (match.phase !== 'expired') continue;
      if (this.enterPause({ step: this.stepIndex, kind: 'match', resume: 'after',
        command: { type: 'resolve', matchId, winner: match.players[0], reason: 'Expired.' } })) return;
    }
    this.scheduleNext();
  }

  private addPauseTimer(callback: () => void, ms: number): void {
    const handle = this.clock.setTimeout(() => {
      this.pauseTimers.delete(handle);
      if (this.closed || !this.running || !this.pause) return;
      callback();
    }, Math.max(0, ms));
    this.pauseTimers.add(handle);
  }

  private clearPauseTimers(): void {
    for (const handle of this.pauseTimers) this.clock.clearTimeout(handle);
    this.pauseTimers.clear();
    this.recoveryArmed = false;
    this.armedClocks.clear();
  }

  /**
   * While paused, running clocks still run out: each is applied as the timer's clockCheck at its
   * deadline, as in autoplay, and the expired match becomes the next decision.
   */
  private armPauseClocks(): void {
    for (const match of this.current.state.matches) {
      const deadline = this.deadline(match.id);
      if (deadline === null || match.runnerId !== this.runnerId || this.armedClocks.has(`${match.id}:${deadline}`)) continue;
      this.armedClocks.add(`${match.id}:${deadline}`);
      const generation = match.pauseGeneration;
      this.addPauseTimer(() => {
        if (this.deadline(match.id) !== deadline) return;      // Decided or re-armed meanwhile.
        this.apply(ADMIN, { type: 'clockCheck', matchId: match.id }, this.clock.now(), 'system', 'system:timer',
          `timer:${match.id}:${generation}:${deadline}`);
        if (this.current.state.matches.find(item => item.id === match.id)?.phase === 'expired') this.expiredWhilePaused.add(match.id);
        this.reconsider();
      }, deadline - this.clock.now());
    }
  }

  /** Scripted players act once more while an event step waits on them, then the step is re-evaluated. */
  private armRecovery(): void {
    if (this.recoveryArmed) return;
    this.recoveryArmed = true;
    this.addPauseTimer(() => {
      this.recoveryArmed = false;
      this.recoverOnce();
      this.reconsider();
    }, DEMO_RECOVERY_WAIT_MS);
  }

  /**
   * One player action toward the scripted decision: a member joins an open roster with room (someone who
   * never left first, otherwise whoever was removed longest ago), or a seated player checks in again.
   */
  private recoverOnce(): void {
    const { signup, checkins } = this.current.state;
    const nowMs = this.clock.now();
    if (signup?.status === 'open' && signup.roster.length < 4) {
      const removals = this.current.audit.filter(row => (row.action as Command).type === 'signupRemove')
        .map(row => (row.action as { memberId: string }).memberId);
      const lastRemoval = (id: string) => removals.lastIndexOf(id);
      const waiting = DEMO_MEMBERS.slice(1).map(member => member.id).filter(id => !signup.roster.includes(id))
        .sort((left, right) => lastRemoval(left) - lastRemoval(right));
      const member = waiting[0];
      if (member) this.apply(`member:${member}`, { type: 'signupJoin' }, nowMs, 'discord', member, `discord:${this.nextSnowflake()}`);
      return;
    }
    const seat = (['A', 'B', 'C', 'D'] as const).find(item => !checkins.includes(item));
    if (seat) {
      const { actor, principal } = this.resolveWho(seat);
      this.apply(actor, { type: 'checkin' }, nowMs, 'discord', principal, `discord:${this.nextSnowflake()}`);
    }
  }

  // Scenario -------------------------------------------------------------------------------------

  private find(eventId: string): DemoEvent {
    const event = [this.current, ...this.retired].find(item => item.state.id === eventId);
    if (!event) throw new AdminNotFoundError('Unknown event.');
    return event;
  }

  private nextSnowflake(): Snowflake {
    this.snowflake += 1n;
    return (920000000000000000n + this.snowflake).toString();
  }

  private createEvent(): DemoEvent {
    const id = this.newEventId();
    return {
      state: createSignupFixture(id, this.durationMs),
      session: {
        event_id: id, application_id: '910000000000000000', guild_id: DEMO_GUILD_ID, channel_id: DEMO_CHANNEL_ID,
        identity_map: { kind: 'signup', adminId: DEMO_ADMIN_ID, matchChannels: { ...DEMO_MATCH_CHANNELS } },
        status: 'active',
        checkin_message_id: this.nextSnowflake(), m1_message_id: this.nextSnowflake(), m2_message_id: this.nextSnowflake(),
        created_at_ms: this.clock.now(), retired_at_ms: null
      },
      audit: [], panelRevision: 0
    };
  }

  private scheduleNext(): void {
    if (!this.running || this.closed || this.pause) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const step = this.script[this.stepIndex];
    if (!step) {
      if (!this.script.length) return;
      this.restart();
      this.scheduleNext();
      return;
    }
    let wait = step.wait;
    if ('expire' in step) {
      const deadline = this.deadline(step.expire);
      wait = deadline === null ? 0 : Math.max(0, deadline - this.clock.now());
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.running || this.closed) return;
      const result = this.runStep(step);
      if (result === 'hold') return;                         // An admin command (or resumeScript) continues.
      if (result === 'advance') this.stepIndex++;
      this.scheduleNext();                                   // Returns at once while paused after a step.
    }, wait);
  }

  private deadline(matchId: MatchId): number | null {
    const match = this.current.state.matches.find(item => item.id === matchId);
    return match?.phase === 'running' && match.startedAtMs !== null ? match.startedAtMs + match.remainingMs : null;
  }

  /**
   * Applies one step. 'stay' re-runs the same index (a timer that fired early is rescheduled for the true
   * deadline; a restart starts over), 'hold' pauses at this step for the admin.
   */
  private runStep(step: DemoStep): StepResult {
    const nowMs = this.clock.now();
    if ('restart' in step) {
      // Interactive: hold a finished event so the admin can still correct a result.
      if (this.interactive && this.released !== this.stepIndex &&
          this.current.state.matches.some(match => match.phase === 'final')) {
        this.enterPause({ step: this.stepIndex, kind: 'final', resume: 'rerun',
          command: { type: 'correct', matchId: 'M1', winner: 'A', reason: 'Hold.' } });
        return 'hold';
      }
      this.restart();
      return 'stay';
    }
    if ('repost' in step) {
      const column = step.repost === 'checkin' ? 'checkin_message_id' : step.repost === 'M1' ? 'm1_message_id' : 'm2_message_id';
      this.current.session = { ...this.current.session, [column]: this.nextSnowflake() };
      this.current.panelRevision++;
      this.listeners.emit({ type: 'panels', eventId: this.current.state.id });
      return 'advance';
    }
    if ('expire' in step) {
      const match = this.current.state.matches.find(item => item.id === step.expire)!;
      const deadline = this.deadline(step.expire);
      if (deadline === null) return 'advance';               // Already decided; nothing to expire.
      if (nowMs < deadline) return 'stay';                   // Early timer, like obsolete_or_early_timer.
      this.apply(ADMIN, { type: 'clockCheck', matchId: step.expire }, nowMs, 'system', 'system:timer',
        `timer:${step.expire}:${match.pauseGeneration}:${deadline}`);
      // Interactive: an expired match waits for the judge's resolution. The pause starts after this step.
      if (this.interactive && this.current.state.matches.find(item => item.id === step.expire)?.phase === 'expired')
        this.enterPause({ step: this.stepIndex + 1, kind: 'match', resume: 'after',
          command: { type: 'resolve', matchId: step.expire, winner: match.players[0], reason: 'Expired.' } });
      return 'advance';
    }
    if (this.interactive && step.who === 'admin') {
      const kind = 'matchId' in step.command ? 'match' : 'event';
      return this.enterPause({ step: this.stepIndex, kind, resume: 'skip', command: step.command }) ? 'hold' : 'advance';
    }
    const { actor, principal } = this.resolveWho(step.who);
    this.apply(actor, step.command, nowMs, 'discord', principal, `discord:${this.nextSnowflake()}`);
    return 'advance';
  }

  private resolveWho(who: Who): { actor: string; principal: string } {
    if (who === 'admin') return { actor: ADMIN, principal: DEMO_ADMIN_ID };
    if (typeof who === 'object') return { actor: `member:${who.member}`, principal: who.member };
    const assignment = this.current.state.signup?.assignment;
    return { actor: `player:${who}`, principal: assignment?.[who] ?? DEMO_ADMIN_ID };
  }

  private apply(actor: string, command: Command, nowMs: number, principalKind: 'discord' | 'system',
    principalId: string, commandId: string): void {
    let result;
    try { result = transition(this.current.state, actor, command, nowMs, this.runnerId); }
    catch (error) {
      // The script follows the rules; a rejection means the scenario drifted (or the admin acted first).
      // Skip the step and keep playing.
      if (error instanceof RuleError) return;
      throw error;
    }
    if (!result.outcome.applied) return;
    this.record(result, actor, command, nowMs, principalKind, principalId, commandId);
  }

  /** Commits a transition to the active event, with its audit row, and notifies subscribers. */
  private record(result: Transition, actor: string, command: Command, nowMs: number,
    principalKind: 'discord' | 'system' | 'web', principalId: string, commandId: string): void {
    this.current.state = result.state;
    this.current.audit.push({
      sequence: result.state.version, command_id: commandId, actor_id: actor, action: command,
      outcome: result.outcome, occurred_at_ms: nowMs, mode: 'matchId' in command ? 'CAM' : null,
      principal_kind: principalKind, principal_id: principalId
    });
    this.listeners.emit({ type: 'event', eventId: result.state.id });
  }

  /** Retires the active event and starts the next one in the same step, so an active event always exists. */
  private restart(): void {
    const finished = this.current;
    finished.session = { ...finished.session, status: 'retired', retired_at_ms: this.clock.now() };
    this.retired = [finished, ...this.retired].slice(0, this.keepRetired);
    this.current = this.createEvent();
    this.stepIndex = 0;
    this.released = -1;
    this.pause = null;
    this.clearPauseTimers();
    this.expiredWhilePaused.clear();
    this.cycles++;
    this.listeners.emit({ type: 'event', eventId: this.current.state.id });
  }
}
