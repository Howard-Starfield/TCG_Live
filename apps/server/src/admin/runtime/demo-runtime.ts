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

/** Where an interactive scenario waits for the admin. */
export interface DemoPause {
  /** Index of the script step the scenario waits at. */
  step: number;
  /** The admin decision it waits for. */
  decision: 'publish' | 'signupClose' | 'signupReopen' | 'signupRemove' | 'judgeResume' | 'resolve' | 'correct';
  /** The match the decision concerns, or null for an event-level decision. */
  matchId: MatchId | null;
}

interface PausePoint extends DemoPause {
  /** skip: the scripted admin step is replaced by the admin's command; rerun: replay the step without
   * pausing again (the final hold before a restart); after: the step already ran (an expiry). */
  resume: 'skip' | 'rerun' | 'after';
}

type StepResult = 'advance' | 'stay' | 'hold';

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
  private readonly script: DemoStep[];
  private readonly startedAtMs: number;
  private readonly listeners = new ListenerSet<AdminRuntimeChange>();
  private readonly members = new Map(DEMO_MEMBERS.map(member => [member.id, member]));
  /** Applied console commands by stored command ID, like the audit table's unique (event, command_id). */
  private readonly webResults = new Map<string, { eventId: string; content: string; outcome: Outcome }>();
  private current: DemoEvent;
  private retired: DemoEvent[] = [];
  private stepIndex = 0;
  private timer: unknown;
  private running = false;
  private closed = false;
  private snowflake = 0n;
  private pause: PausePoint | null = null;
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

  /** Interactive mode: where the scenario waits for the admin, or null while it plays. */
  get pausedAt(): DemoPause | null {
    return this.pause ? { step: this.pause.step, decision: this.pause.decision, matchId: this.pause.matchId } : null;
  }

  /** Index of the next script step. */
  get step(): number { return this.stepIndex; }

  /**
   * Continues a paused interactive scenario without an admin command (the decision is skipped).
   * For tests and E2E. Returns false when the scenario was not paused.
   */
  resumeScript(): boolean {
    const pause = this.pause;
    if (!pause || this.closed) return false;
    this.pause = null;
    if (pause.resume === 'skip') this.stepIndex++;
    else if (pause.resume === 'rerun') this.released = this.stepIndex;
    this.scheduleNext();
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
   * The Discord store's order, atomically in memory: the event must exist (404), a stored result for the
   * command ID is returned before anything else (or 409 for other content), then the active-event and
   * precondition checks (409), then the real domain transition (422 on a rule error).
   */
  async applyAdminCommand(request: AdminCommandRequestDto, principal: AdminPrincipal): Promise<AdminCommandResultDto> {
    if (this.closed) throw new AdminUnavailableError('The demo has stopped.');
    const event = this.find(request.eventId);
    const command = this.ruled(() => toDomainCommand(request.command, event.session.identity_map.adminId));
    const commandId = webCommandId(request.commandId);
    const content = commandContent(request);
    const prior = this.webResults.get(commandId);
    if (prior) {
      if (prior.eventId !== request.eventId || prior.content !== content) throw new AdminConflictError(CONFLICT.reused);
      return this.commandResult(command, prior.outcome);
    }
    if (event !== this.current) throw new AdminConflictError(CONFLICT.inactive);
    if (!preconditionHolds(event.state, request.precondition)) throw new AdminConflictError(CONFLICT.changed);
    const nowMs = this.clock.now();
    const result = this.ruled(() => transition(event.state, ADMIN, command, nowMs, this.runnerId));
    if (result.outcome.applied) {
      this.record(result, ADMIN, command, nowMs, 'web', principal.id, commandId);
      this.webResults.set(commandId, { eventId: event.state.id, content, outcome: result.outcome });
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

  /** Interactive mode: an applied admin command for the decision being waited on resumes the scenario. */
  private adminCommandLanded(command: Command): void {
    const pause = this.pause;
    if (!pause) return;
    const matchId = 'matchId' in command ? command.matchId : null;
    const relevant = pause.decision === 'correct' && pause.matchId === null ? command.type === 'correct'
      : pause.matchId !== null ? matchId === pause.matchId : matchId === null;
    if (relevant) this.resumeScript();
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

  private get interactive(): boolean { return this.playMode === 'interactive'; }

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
        this.pause = { step: this.stepIndex, decision: 'correct', matchId: null, resume: 'rerun' };
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
      // Interactive: an expired match waits for the judge's resolution.
      if (this.interactive && this.current.state.matches.find(item => item.id === step.expire)?.phase === 'expired')
        this.pause = { step: this.stepIndex + 1, decision: 'resolve', matchId: step.expire, resume: 'after' };
      return 'advance';
    }
    if (this.interactive && step.who === 'admin') return this.holdFor(step.command, nowMs) ? 'hold' : 'advance';
    const { actor, principal } = this.resolveWho(step.who);
    this.apply(actor, step.command, nowMs, 'discord', principal, `discord:${this.nextSnowflake()}`);
    return 'advance';
  }

  /**
   * Interactive: pauses at a scripted admin step while the domain would accept it now. A decision that
   * is already moot (the admin acted early, or the state moved on) is skipped without pausing.
   */
  private holdFor(command: Command, nowMs: number): boolean {
    try {
      if (!transition(this.current.state, ADMIN, command, nowMs, this.runnerId).outcome.applied) return false;
    } catch (error) {
      if (error instanceof RuleError) return false;
      throw error;
    }
    this.pause = { step: this.stepIndex, decision: command.type as DemoPause['decision'],
      matchId: 'matchId' in command ? command.matchId : null, resume: 'skip' };
    return true;
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
    this.cycles++;
    const kept = new Set([this.current, ...this.retired].map(event => event.state.id));
    for (const [commandId, stored] of this.webResults) if (!kept.has(stored.eventId)) this.webResults.delete(commandId);
    this.listeners.emit({ type: 'event', eventId: this.current.state.id });
  }
}

