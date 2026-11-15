import { createHash } from 'node:crypto';
import type { Command, EventState, MatchId, Outcome, Player } from '../rehearsal/domain.js';
import { isJudgeRequestCategory, MAX_JUDGE_REQUEST_LENGTH, type ArtworkGame, type OpenTournamentSignupResult } from '@tcg-live/core';
import { RuleError, scheduledPublishDue, signupTournamentComplete } from '../rehearsal/domain.js';
import { applyDiscordCommand, applyWebCommand, type WebCommandContext } from '../rehearsal/store.js';
import type { MatchLifecycleEvent } from './features.js';
import { evidenceWindowOpen, parseButtonId, renderCard, renderTournamentRecap, type CardOptions, type CardPayload,
  type ParsedButton } from './cards.js';
import { isTournamentStaff, STAFF_DENIED } from './staff.js';
import { channelForSlot, type PrivateDiscordConfig } from './config.js';
import { activateSignupDraft, adoptSessionClocks, bindCard, claimResumeReminder, clearDeletedSessionCards, completeStickyCard, deleteActiveTournament, deletedSessionsWithCards, getSessionState, messageId, sessionSlots, NoActiveSessionError, replaceStickyCard, suspendStickyCard,
  resolvePlayers, type CardSlot, type SessionRow } from './session.js';

export interface PrivateInteraction {
  id: string;
  applicationId: string;
  guildId: string | null;
  channelId: string | null;
  userId: string;
  kind: 'button' | 'command' | 'judgeRequest';
  showJudgeRequest?(): Promise<void>;
  judgeRequest?: { requesterId: string; category: string; description: string };
  customId?: string;
  messageId?: string;
  subcommand?: string;
  matchId?: MatchId;
  /** A seat, or (free text from `/tcg-staff`) a member mention or ID; resolved against the match. */
  winner?: string;
  reason?: string;
  memberId?: string;
  /** `/tcg-staff checkin-for player:` — a seat (A, P3) or a member mention/ID. */
  player?: string;
  /** Role IDs of the interacting member (tournament staff check). */
  roleIds?: string[];
  /** The "Submit evidence" card button: opens the evidence form. */
  showEvidenceForm?(): Promise<void>;
  acknowledge(): Promise<void>;
  reply(message: string, attachment?: { name: string; attachment: Buffer }): Promise<void>;
}

export interface CardTransport {
  send(payload: CardPayload, slot?: CardSlot, nonce?: string): Promise<string>;
  edit(id: string, payload: CardPayload, slot?: CardSlot): Promise<void>;
  pin(id: string, slot?: CardSlot): Promise<void>;
  findMatchCard?(eventId: string, slot: MatchId): Promise<string | null>;
  unpin?(id: string): Promise<void>;
  resumeReminder?(slot: MatchId, waitingIds: string[]): Promise<string>;
  remove?(id: string, slot: CardSlot, channelId?: string): Promise<void>;
  /** Distinguish a confirmed deleted card from a forbidden or ambiguous response. */
  classify(error: unknown): 'missing' | 'forbidden' | 'retry';
}

/** Admin console notifications. Delivered from a microtask and never awaited. */
export type ControllerChange =
  | { type: 'event'; eventId: string }     // committed command or timer application
  | { type: 'panels'; eventId: string }    // card bind, sticky repost or suspension (panelRevision moved)
  | { type: 'status' };                    // updatePending changed
export type ControllerListener = (change: ControllerChange) => void;
export interface ControllerStatus { updatePending: boolean; panelRevision: number }

/** The reply after a committed command; the admin console returns the same text as its `result`. */
export function savedReply(type: string, cardPending: boolean, roomWarning: string): string {
  return `Saved: ${type}.${cardPending ? ' Card update pending.' : ''}` + (roomWarning ? ` Room setup pending: ${roomWarning}` : '');
}

/** The reply when the domain made no change (for example `not_joined`). */
export function noChangeReply(result: string): string {
  return `No change: ${result}.`;
}

/** The controller is stopping, or the lease is lost: it takes no new admin console work. */
export class ControllerUnavailableError extends Error {}

/** An admin console command: the store's web context plus the mapped domain command. */
export interface WebAdminRequest extends Omit<WebCommandContext, 'config'> { command: Command }

export interface AdminApplyResult {
  /** The store's outcome; a replayed command ID returns the stored outcome unchanged. */
  outcome: Outcome;
  /** 'pending' when the card refresh after a committed change did not complete ("saved; display pending"). */
  cards: 'updated' | 'pending';
  roomWarning: string | null;
  /** The reply the Discord path sends. */
  reply: string;
  /** A failure after the commit; the retry is already scheduled. */
  degraded: boolean;
}

export interface ExplicitRefreshResult {
  cards: 'refreshed' | 'pending';
  /** A rule refusal from the card refresh, such as missing channel permissions; null otherwise. */
  cardError: string | null;
  roomWarning: string | null;
  /** The reply `/tcg-test refresh` sends. */
  reply: string;
}

type RefreshMode = 'known' | 'explicit';
const SLOTS: CardSlot[] = ['checkin', 'M1', 'M2'];
const SNOWFLAKE = /^[1-9]\d{14,21}$/;
interface StickyChannel {
  latestId: string;
  firstAt: number;
  lastAt: number;
  nextAt: number;
  timer?: NodeJS.Timeout;
  running: boolean;
}

export class PrivateDiscordController {
  private accepting = true;
  private dirty = 0;
  private refreshed = -1;
  private refreshTask: Promise<void> = Promise.resolve();
  private timers = new Map<MatchId, NodeJS.Timeout>();
  private retry: NodeJS.Timeout | undefined;
  private pending = new Set<Promise<unknown>>();
  private scheduledEventId: string | undefined;
  private scheduledVersion = -1;
  private deletedCardCleanup: Promise<void> | undefined;
  private sticky = new Map<string, StickyChannel>();
  private listeners = new Set<ControllerListener>();
  private matchListeners = new Set<(event: MatchLifecycleEvent) => void>();
  private panelRevision = 0;
  private lastPending = false;
  /** A refresh that has not started yet; later requests of the same mode join it. */
  private queuedRefresh: { mode: RefreshMode; task: Promise<void> } | undefined;
  /** An event whose signup card must still be posted after its activation. */
  private signupCardPending: string | undefined;
  /** The scheduled start (`eventId:startsAtMs`) the scheduler already decided on. */
  private publishDecided: string | undefined;
  /** The configured home signup channel; a draft without its own channel opens here. */
  private readonly homeChannelId: string;
  /** Tournament staff role IDs (admin-tools settings); none until the runtime sets a source. */
  private staffRoles: () => Promise<readonly string[]> = async () => [];
  /** Recording badge and recording policy for card rendering. */
  private cardOptions: () => CardOptions = () => ({});

  constructor(
    readonly config: PrivateDiscordConfig,
    readonly runnerId: string,
    readonly transport: CardTransport,
    private readonly read = getSessionState,
    private readonly apply = applyDiscordCommand,
    private readonly bind = bindCard,
    private readonly clock: () => number = Date.now,
    private readonly retryDelayMs = 5_000,
    private readonly stickyStore = { suspend: suspendStickyCard, replace: replaceStickyCard,
      complete: completeStickyCard },
    private readonly canPost: () => boolean = () => true,
    private readonly stickyDelayMs = 4_000,
    private readonly claimReminder = claimResumeReminder,
    private readonly syncRooms?: (explicit: boolean) => Promise<void>,
    private readonly applyWeb = applyWebCommand,
    private readonly provisionRound?: (session: SessionRow, state: EventState) => Promise<void>,
    private readonly adoptClocks = adoptSessionClocks
  ) {
    this.homeChannelId = config.channelId;
  }

  /** Where the staff role IDs come from (the runtime reads the saved admin-tools settings). */
  setStaffRoles(source: () => Promise<readonly string[]>): void { this.staffRoles = source; }

  /** Runtime extras for every rendered card (recording badge, recording policy). */
  setCardOptions(source: () => CardOptions): void { this.cardOptions = source; }

  private render(state: EventState, slot: CardSlot, session: SessionRow): CardPayload {
    let options: CardOptions = {};
    try { options = this.cardOptions(); } catch { /* Extras never block a card. */ }
    return renderCard(state, slot, this.runnerId, resolvePlayers(session, state) ?? undefined, session.tournament, session.channel_id,
      { nowMs: this.clock(), ...options });
  }

  /** 'admin' for the configured organizer, 'staff' for a member with a staff role, null otherwise. */
  async staffLevel(userId: string, roleIds: readonly string[] = []): Promise<'admin' | 'staff' | null> {
    if (userId === this.config.adminId) return 'admin';
    let staffRoleIds: readonly string[] = [];
    try { staffRoleIds = await this.staffRoles(); } catch { /* Settings unavailable: only the organizer. */ }
    return isTournamentStaff({ userId, adminId: this.config.adminId, roleIds, staffRoleIds }) ? 'staff' : null;
  }

  /**
   * May this member submit evidence for the match now? Players of the match and staff, while the match
   * needs a judge or is disputed, and for 24 h after its result. Returns the refusal text, or null.
   */
  async evidenceRefusal(userId: string, roleIds: readonly string[], eventId: string, matchId: string): Promise<string | null> {
    let current: Awaited<ReturnType<typeof getSessionState>>;
    try { current = await this.read(this.config); } catch { return 'There is no active tournament.'; }
    const match = current.state.matches.find(item => item.id === matchId);
    if (current.state.id !== eventId || !match) return 'This match is no longer in the current round.';
    const players = resolvePlayers(current.session, current.state);
    const seated = match.players.some(seat => players?.[seat] === userId);
    if (!seated && !await this.staffLevel(userId, roleIds))
      return 'Only the two players in this match or tournament staff can submit evidence for it.';
    if (!evidenceWindowOpen(match, this.clock()))
      return 'Evidence for this match closed 24 hours after its result. Ask the organizer if you still need to send something.';
    return null;
  }

  /**
   * `/tcg-staff` autocomplete: match IDs from the live round, the seats of the chosen match (winner), seats
   * waiting to check in (player) or the signup roster (member-id). `nameOf` turns a Discord ID into a name.
   */
  async autocomplete(subcommand: string, focused: string, query: string, matchValue: string | null,
    nameOf: (id: string) => string | undefined = () => undefined): Promise<Array<{ name: string; value: string }>> {
    let current: Awaited<ReturnType<typeof getSessionState>>;
    try { current = await this.read(this.config); } catch { return []; }
    const { state, session } = current;
    const players = resolvePlayers(session, state) as Record<string, string> | null;
    const label = (seat: string) => {
      const id = players?.[seat];
      return id ? `${seat} · ${nameOf(id) ?? `member …${id.slice(-4)}`}` : seat;
    };
    const wanted = query.trim().toLowerCase();
    const fits = (...texts: string[]) => !wanted || texts.some(text => text.toLowerCase().includes(wanted));
    let choices: Array<{ name: string; value: string }> = [];
    if (focused === 'match') {
      choices = state.matches.filter(match => subcommand === 'correct' ? match.phase === 'final'
        : subcommand === 'judge-resume' ? match.phase === 'paused' : match.phase !== 'final' && match.phase !== 'setup')
        .map(match => ({ value: match.id, name: `${match.id} · ${match.players.map(label).join(' vs ')} · ${match.phase}` +
          (match.judgeAttention ? ' · judge needed' : '') }))
        .filter(choice => fits(choice.value, choice.name));
    } else if (focused === 'winner') {
      const match = state.matches.find(item => item.id === (matchValue ?? '').trim().toUpperCase());
      choices = (match?.players ?? []).map(seat => ({ value: seat, name: label(seat) })).filter(choice => fits(choice.name));
    } else if (focused === 'player') {
      const seats = Object.keys(players ?? {}).filter(seat => !state.checkins.includes(seat as Player));
      choices = state.published ? [] : seats.map(seat => ({ value: seat, name: label(seat) })).filter(choice => fits(choice.name));
    } else if (focused === 'member-id') {
      choices = (state.signup?.roster ?? []).map(id => ({ value: id, name: nameOf(id) ?? id }))
        .filter(choice => fits(choice.name, choice.value));
    }
    return choices.slice(0, 25).map(choice => ({ name: choice.name.slice(0, 100), value: choice.value }));
  }

  /**
   * Committed match transitions for Discord features (judge called, dispute opened, judge resumed,
   * match resolved). Same isolation as subscribe(); emitting never changes command handling.
   */
  onMatchEvent(listener: (event: MatchLifecycleEvent) => void): () => void {
    this.matchListeners.add(listener);
    return () => { this.matchListeners.delete(listener); };
  }

  private emitMatch(event: MatchLifecycleEvent): void {
    for (const listener of [...this.matchListeners]) {
      try {
        queueMicrotask(() => {
          try { listener(event); } catch { /* Features never affect Discord handling. */ }
        });
      } catch { /* Never reached; emission must not throw into the caller. */ }
    }
  }

  /** Events known from the command alone, emitted right after the commit. */
  private emitCommitted(eventId: string, command: Command, actorId: string | null): void {
    if (!this.matchListeners.size) return;
    const occurredAtMs = this.clock();
    if (command.type === 'callJudge')
      this.emitMatch({ type: 'judgeCalled', eventId, matchId: command.matchId, reason: 'called', requestedBy: actorId, occurredAtMs });
    else if (command.type === 'dispute')
      this.emitMatch({ type: 'disputeOpened', eventId, matchId: command.matchId, revision: command.revision, requestedBy: actorId, occurredAtMs });
    else if (command.type === 'judgeResume')
      this.emitMatch({ type: 'judgeResumed', eventId, matchId: command.matchId, occurredAtMs });
  }

  /** Events that depend on the committed state: a final result, or a clock that expired into a judge call. */
  private emitFromState(eventId: string, command: Command, state: EventState): void {
    if (!this.matchListeners.size || state.id !== eventId || !('matchId' in command)) return;
    const match = state.matches.find(item => item.id === command.matchId);
    if (!match) return;
    const occurredAtMs = this.clock();
    if ((command.type === 'confirm' || command.type === 'resolve' || command.type === 'correct') && match.phase === 'final')
      this.emitMatch({ type: 'matchResolved', eventId, matchId: match.id, winner: match.finalWinner,
        source: command.type === 'confirm' ? 'agreed' : 'admin', occurredAtMs });
    else if (command.type === 'clockCheck' && match.phase === 'expired')
      this.emitMatch({ type: 'judgeCalled', eventId, matchId: match.id, reason: 'expired', requestedBy: null, occurredAtMs });
  }

  /** Subscribers run in isolated microtasks; a throwing subscriber cannot affect replies, cards or shutdown. */
  subscribe(listener: ControllerListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Read-only view for the admin console. */
  status(): ControllerStatus {
    return { updatePending: this.pendingNow(), panelRevision: this.panelRevision };
  }

  private pendingNow(): boolean {
    // A requested refresh (dirty ticket) has not yet completed without failure.
    return this.dirty > 0 && this.refreshed !== this.dirty;
  }

  private notify(change: ControllerChange): void {
    for (const listener of [...this.listeners]) {
      try {
        queueMicrotask(() => {
          try { listener(change); } catch { /* Subscribers never affect Discord handling. */ }
        });
      } catch { /* Never reached; notification must not throw into the caller. */ }
    }
  }

  private panelChanged(eventId: string): void {
    this.panelRevision++;
    this.notify({ type: 'panels', eventId });
  }

  private pendingChanged(): void {
    const pending = this.pendingNow();
    if (pending === this.lastPending) return;
    this.lastPending = pending;
    this.notify({ type: 'status' });
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }

  /**
   * Adopts the active tournament's saved signup channel (`adoptChannel` switches the transport and
   * throws when the channel is unusable) and the running clocks left by a stopped process, then arms
   * their timers. The advisory lease guarantees the previous runner is gone.
   */
  async start(adoptChannel?: (channelId: string) => Promise<void>): Promise<void> {
    try {
      let { session, state } = await this.read(this.config);
      if (session.channel_id !== this.config.channelId) {
        await adoptChannel?.(session.channel_id);
        this.config.channelId = session.channel_id;
      }
      if (state.matches.some(match => match.phase === 'running' && match.runnerId !== this.runnerId)) {
        await this.adoptClocks(this.config, state.id, this.runnerId);
        ({ session, state } = await this.read(this.config));
      }
      this.schedule(state);
      void this.requestRefresh().catch(() => {});
    } catch (error) {
      if (!(error instanceof NoActiveSessionError)) throw error;
    }
  }

  reconnect(): void {
    if (this.accepting) void this.requestRefresh().catch(() => {});
  }

  private requestRefresh(mode: RefreshMode = 'known'): Promise<void> {
    this.dirty++;
    this.pendingChanged();
    // A queued refresh has not read state yet, so it already covers this request.
    if (this.queuedRefresh?.mode === mode) return this.queuedRefresh.task;
    const entry: { mode: RefreshMode; task: Promise<void> } = { mode, task: Promise.resolve() };
    const task = this.refreshTask.then(() => {
      if (this.queuedRefresh === entry) this.queuedRefresh = undefined;
      return this.refresh(mode);
    });
    entry.task = this.track(task);
    this.queuedRefresh = entry;
    this.refreshTask = task.catch(() => {});
    return entry.task;
  }

  private async refresh(mode: RefreshMode): Promise<void> {
    if (!this.accepting) return;
    const ticket = this.dirty;
    let snapshot: Awaited<ReturnType<typeof getSessionState>>;
    try { snapshot = await this.read(this.config); }
    catch (error) {
      if (error instanceof NoActiveSessionError && mode === 'known') {
        if (ticket === this.dirty) this.refreshed = ticket;
        this.pendingChanged();
        return;
      }
      if (!(error instanceof NoActiveSessionError)) this.scheduleRetry();
      throw error;
    }
    const { session, state } = snapshot;
    this.schedule(state);
    if (signupTournamentComplete(state) && this.transport.unpin) {
      try { await this.finishTournamentCards(session, state, mode === 'explicit'); }
      catch (error) { this.scheduleRetry(); throw error; }
      if (ticket === this.dirty) this.refreshed = ticket;
      this.pendingChanged();
      return;
    }
    if (state.firstRound && state.published && this.provisionRound) {
      try {
        await this.provisionRound(session, state);
        if (state.matches.some(match => !session.identity_map.roundRooms?.[match.id])) await this.syncRooms?.(false);
      }
      catch (error) { this.scheduleRetry(); throw error; }
    }
    let failed = false;
    let retryable = false;
    const slots: CardSlot[] = state.firstRound ? ['checkin', ...state.matches.map(match => match.id)] : SLOTS;
    if (this.signupCardPending && (this.signupCardPending !== state.id || messageId(session, 'checkin')))
      this.signupCardPending = undefined;
    for (const slot of slots) {
      if (!this.accepting) return;
      const id = messageId(session, slot);
      // After an activation whose first post failed, a background retry creates the signup card.
      const signupCard = slot === 'checkin' && this.signupCardPending === state.id;
      const payload = this.render(state, slot, session);
      const dynamicMatch = state.firstRound && slot !== 'checkin' &&
        state.matches.some(match => match.id === slot && match.phase !== 'final') && this.transport.findMatchCard;
      const nonce = dynamicMatch || signupCard ? createHash('sha256').update(`${state.id}:${slot}`).digest('hex').slice(0, 25) : undefined;
      if (!id) {
        if (mode !== 'explicit' && !dynamicMatch && !signupCard) continue;
        let sent: string;
        try {
          sent = (dynamicMatch ? await this.transport.findMatchCard!(state.id, slot) : null)
            ?? await this.sendOnce(payload, slot, nonce);
          await this.bind(this.config, session.event_id, slot, sent);
        } catch (error) {
          if (dynamicMatch || signupCard) this.scheduleRetry();
          throw error;
        }
        if (signupCard) this.signupCardPending = undefined;
        this.panelChanged(session.event_id);
        if (slot === 'checkin') await this.transport.pin(sent, slot);
        continue;
      }
      try {
        await this.transport.edit(id, payload, slot);
        if (mode === 'explicit' && session.identity_map.stickySuspended?.includes(slot)) {
          await this.bind(this.config, session.event_id, slot, id);
          this.panelChanged(session.event_id);
        }
        if (mode === 'explicit' && slot === 'checkin') await this.transport.pin(id, slot);
      } catch (error) {
        if ((mode === 'explicit' || dynamicMatch) && this.transport.classify(error) === 'missing') {
          const sent = (dynamicMatch ? await this.transport.findMatchCard!(state.id, slot) : null)
            ?? await this.sendOnce(payload, slot, nonce);
          await this.bind(this.config, session.event_id, slot, sent);
          this.panelChanged(session.event_id);
          if (slot === 'checkin') await this.transport.pin(sent, slot);
        } else {
          failed = true;
          const kind = this.transport.classify(error);
          retryable ||= kind === 'retry';
          if (mode === 'explicit') throw error;
        }
      }
    }
    if (!failed && ticket === this.dirty) this.refreshed = ticket;
    this.pendingChanged();
    if (retryable || (!failed && this.refreshed !== this.dirty)) this.scheduleRetry();
    if (failed) throw new RuleError('Card update pending.');
  }

  private async finishTournamentCards(session: SessionRow, state: EventState, repair = false): Promise<void> {
    if (!this.transport.unpin || !this.transport.remove) throw new RuleError('Discord results cleanup is unavailable.');
    const payload = renderTournamentRecap(state, resolvePlayers(session, state), session.tournament);
    let recapId = messageId(session, 'checkin');
    if (recapId) {
      try { await this.transport.edit(recapId, payload, 'checkin'); }
      catch (error) {
        if (this.transport.classify(error) !== 'missing') throw error;
        recapId = null;
      }
    }
    for (const slot of sessionSlots(session)) {
      const ids = new Set([slot === 'checkin' ? null : messageId(session, slot), ...(session.identity_map.stickyPrevious?.[slot] ?? [])]);
      for (const id of ids) {
        if (!id || id === recapId) continue;
        const channelId = slot === 'checkin' ? session.channel_id : session.identity_map.roundRooms?.[slot];
        try { await this.transport.remove(id, slot, channelId); }
        catch (error) { if (this.transport.classify(error) !== 'missing') throw error; }
      }
    }
    if (!recapId) {
      if (!repair) throw new RuleError('The signup card is missing. Use Refresh to post the results.');
      recapId = await this.sendOnce(payload, 'checkin');
      await this.bind(this.config, session.event_id, 'checkin', recapId);
    }
    await this.transport.unpin(recapId);
  }

  private async sendOnce(payload: CardPayload, slot: CardSlot, nonce?: string): Promise<string> {
    try { return await (nonce ? this.transport.send(payload, slot, nonce) : this.transport.send(payload, slot)); }
    catch (error) {
      if (this.transport.classify(error) === 'forbidden')
        throw new RuleError('Private Discord card permission denied; fix channel permissions before refresh.');
      throw new RuleError('Card creation is uncertain; inspect the channel before another explicit refresh. A stray card may remain.');
    }
  }

  private scheduleRetry(): void {
    if (this.retry || !this.accepting) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.requestRefresh().catch(() => {});
    }, this.retryDelayMs);
  }

  onMessage(message: { guildId: string | null; channelId: string; id: string;
    authorBot: boolean; webhookId?: string | null }): void {
    if (message.guildId !== this.config.guildId || message.authorBot || message.webhookId) return;
    this.onHumanMessage(message.channelId, message.id);
  }

  private onHumanMessage(channelId: string, messageId: string): void {
    if (!this.accepting || !SNOWFLAKE.test(messageId) ||
        !this.isControlChannel(channelId)) return;
    const now = Date.now();
    const prior = this.sticky.get(channelId);
    if (prior) {
      if (BigInt(messageId) <= BigInt(prior.latestId)) return;
      prior.latestId = messageId;
      prior.lastAt = now;
      if (!prior.running) this.armSticky(channelId, prior);
      return;
    }
    const entry: StickyChannel = { latestId: messageId, firstAt: now, lastAt: now, nextAt: 0, running: false };
    this.sticky.set(channelId, entry);
    this.armSticky(channelId, entry);
  }

  private armSticky(channelId: string, entry: StickyChannel): void {
    if (entry.timer) clearTimeout(entry.timer);
    const due = Math.max(entry.nextAt, Math.min(entry.lastAt + this.stickyDelayMs,
      entry.firstAt + 2 * this.stickyDelayMs));
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (!this.accepting || !this.canPost()) return;
      const observed = entry.latestId;
      entry.running = true;
      entry.nextAt = Date.now() + this.stickyDelayMs;
      const task = this.refreshTask.then(() => this.bumpSticky(channelId, observed));
      this.refreshTask = task.catch(() => {});
      void this.track(task).catch(() => {}).finally(() => {
        entry.running = false;
        if (this.accepting && this.canPost() && BigInt(entry.latestId) > BigInt(observed)) {
          entry.firstAt = Date.now();
          this.armSticky(channelId, entry);
        }
      });
    }, Math.max(0, due - Date.now()));
  }

  private async bumpSticky(channelId: string, observedId: string): Promise<void> {
    if (!this.transport.remove) return;
    const { session, state } = await this.read(this.config);
    if (signupTournamentComplete(state)) return;
    for (const slot of sessionSlots(session)) {
      if (!this.accepting || !this.canPost()) return;
      if (channelForSlot(this.config, slot) !== channelId || session.identity_map.stickySuspended?.includes(slot)) continue;
      const oldId = messageId(session, slot);
      if (!oldId || BigInt(observedId) <= BigInt(oldId)) continue;
      const payload = this.render(state, slot, session);
      // Persist a reservation before POST: a crash or ambiguous response leaves
      // this slot suspended until a deliberate admin refresh.
      if (!await this.stickyStore.suspend(this.config, session.event_id, slot, oldId)) continue;
      this.panelChanged(session.event_id);
      if (!this.accepting || !this.canPost()) return;
      let newId: string;
      try { newId = await this.transport.send(payload, slot); }
      catch { continue; }
      if (!this.accepting || !this.canPost()) {
        try { await this.transport.remove?.(newId, slot); } catch { /* Known new card needs manual inspection. */ }
        return;
      }
      let bound = false;
      let uncertain = false;
      try { bound = await this.stickyStore.replace(this.config, session.event_id, slot, oldId, newId); }
      catch {
        // The transaction may have committed before its reply was lost. Never
        // delete the new card until a fresh read proves it is not canonical.
        try { bound = messageId((await this.read(this.config)).session, slot) === newId; }
        catch { uncertain = true; }
      }
      if (!bound) {
        if (!uncertain) {
          try { await this.transport.remove?.(newId, slot); } catch { /* Manual inspection may be needed. */ }
        }
        continue;
      }
      this.panelChanged(session.event_id);
      // Queue a fresh render behind this replacement. A command may have
      // committed while the network POST was in flight.
      void this.requestRefresh().catch(() => {});
      let cleaned = true;
      if (slot === 'checkin') {
        try { await this.transport.pin(newId, slot); }
        catch { cleaned = false; }
      }
      try { await this.transport.remove?.(oldId, slot); }
      catch (error) { if (this.transport.classify(error) !== 'missing') cleaned = false; }
      if (cleaned) {
        await this.stickyStore.complete(this.config, session.event_id, slot, newId, oldId);
        this.panelChanged(session.event_id);
      }
    }
  }

  private schedule(state: EventState): void {
    if (state.id === this.scheduledEventId && state.version < this.scheduledVersion) return;
    this.scheduledEventId = state.id;
    this.scheduledVersion = state.version;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (!this.accepting) return;
    for (const match of state.matches) {
      if (match.phase !== 'running' || match.runnerId !== this.runnerId || match.startedAtMs === null) continue;
      const deadlineMs = match.startedAtMs + match.remainingMs;
      const wait = Math.min(2_147_483_647, Math.max(1, deadlineMs - this.clock()));
      this.timers.set(match.id, setTimeout(() => {
        this.timers.delete(match.id);
        this.runTimer(state.id, state.version, match.id, match.pauseGeneration, deadlineMs);
      }, wait));
    }
  }

  private runTimer(eventId: string, version: number, matchId: MatchId, generation: number, deadlineMs: number): void {
    void this.track(this.fireTimer(eventId, matchId, generation, deadlineMs)).catch(() => {
      if (!this.accepting || this.scheduledEventId !== eventId || this.scheduledVersion > version) return;
      const alreadyArmed = this.timers.get(matchId);
      if (alreadyArmed) clearTimeout(alreadyArmed);
      this.timers.set(matchId, setTimeout(() => {
        this.timers.delete(matchId);
        this.runTimer(eventId, version, matchId, generation, deadlineMs);
      }, this.retryDelayMs));
    });
  }

  private async fireTimer(eventId: string, matchId: MatchId, pauseGeneration: number, deadlineMs: number): Promise<void> {
    if (!this.accepting) return;
    const result = await this.apply({ config: this.config, eventId, principalId: 'system:timer',
      timer: { matchId, pauseGeneration, deadlineMs } }, { type: 'clockCheck', matchId }, this.runnerId, this.clock);
    if (result.applied) this.notify({ type: 'event', eventId });
    const latest = await this.read(this.config);
    if (result.applied) this.emitFromState(eventId, { type: 'clockCheck', matchId }, latest.state);
    this.schedule(latest.state);
    if (result.applied) await this.requestRefresh();
  }

  async publishDueRound(): Promise<void> {
    if (!this.accepting || !this.canPost()) return;
    let state: EventState;
    try { ({ state } = await this.read(this.config)); }
    catch (error) {
      if (error instanceof NoActiveSessionError) return;
      throw error;
    }
    if (!this.accepting || !this.canPost() || !state.signup || state.published || state.startsAtMs === undefined ||
        this.clock() < state.startsAtMs) return;
    const startsAtMs = state.startsAtMs;
    const decision = `${state.id}:${startsAtMs}`;
    if (this.publishDecided === decision) return;
    // One decision at the scheduled start: publish with whoever checked in, or leave it to the admin.
    if (!scheduledPublishDue(state, this.clock())) { this.publishDecided = decision; return; }
    const command = { type: 'publish' } as const;
    await this.track(this.commit(state.id, command, () => this.apply({
      config: this.config, eventId: state.id, principalId: 'system:scheduler', scheduledPublish: { startsAtMs }
    }, command, this.runnerId, this.clock)));
    this.publishDecided = decision;
  }

  private isControlChannel(channelId: string): boolean {
    return channelId === this.config.channelId || Object.values(this.config.matchChannels ?? {}).includes(channelId) ||
      Object.values(this.config.roundRooms ?? {}).includes(channelId);
  }

  async handle(interaction: PrivateInteraction): Promise<void> {
    if (!this.accepting) return;
    const scope = interaction.applicationId === this.config.applicationId &&
      interaction.guildId === this.config.guildId && interaction.channelId !== null &&
      (interaction.kind === 'command' ? interaction.channelId === this.config.channelId :
        this.isControlChannel(interaction.channelId));
    if (!scope) return;
    await this.track((async () => {
      if (interaction.showEvidenceForm) {
        try {
          const parsed = this.canonicalButton(interaction, (await this.read(this.config)).session);
          const refusal = parsed.action !== 'evidence' || parsed.slot === 'checkin' ? 'Invalid private Discord control.'
            : await this.evidenceRefusal(interaction.userId, interaction.roleIds ?? [], parsed.eventId, parsed.slot);
          if (refusal) throw new RuleError(refusal);
          if (!this.accepting) return;
          await interaction.showEvidenceForm();
        } catch (error) {
          try {
            await interaction.acknowledge();
            await interaction.reply(error instanceof RuleError ? error.message : 'The evidence form could not be opened.');
          } catch { /* Discord may already have accepted the modal. */ }
        }
        return;
      }
      if (interaction.showJudgeRequest) {
        try {
          if (!this.canPost()) throw new RuleError('The Discord bot is unavailable.');
          const { session, state } = await this.read(this.config);
          const { command } = this.commandFor(interaction, session, state);
          if (!this.accepting) return;
          if (command.type !== 'callJudge' || !state.published ||
              state.matches.find(match => match.id === command.matchId)?.phase === 'final')
            throw new RuleError('Judge call is unavailable.');
          await interaction.showJudgeRequest();
        } catch (error) {
          try {
            await interaction.acknowledge();
            await interaction.reply(error instanceof RuleError ? error.message : 'The judge request form could not be opened.');
          } catch { /* Discord may already have accepted the modal. */ }
        }
        return;
      }
      try { await interaction.acknowledge(); } catch { return; }
      if (!this.accepting) return;
      await this.handleAcknowledged(interaction);
    })());
  }

  /**
   * Admin console command (principal_kind 'web'). Goes through the same accepting and lease gates,
   * tracking, store transaction body, room sync, timer scheduling and card refresh as a slash command.
   * Rejects with ControllerUnavailableError while not accepting; store refusals reject as RuleErrors.
   */
  applyAdmin(request: WebAdminRequest): Promise<AdminApplyResult> {
    if (!this.accepting || !this.canPost()) return Promise.reject(new ControllerUnavailableError('Private Discord runtime is not accepting commands.'));
    const { command, ...context } = request;
    return this.track(this.commit(request.eventId, command,
      () => this.applyWeb({ config: this.config, ...context }, command, this.runnerId, this.clock), request.principalId));
  }

  /**
   * The explicit card and room repair behind `/tcg-test refresh` and the console's panel refresh.
   * `cardError` carries a rule refusal from the card refresh (for example missing permissions); the
   * slash command reports it as pending, as it always has.
   */
  refreshExplicit(): Promise<ExplicitRefreshResult> {
    if (!this.accepting || !this.canPost()) return Promise.reject(new ControllerUnavailableError('Private Discord runtime is not accepting commands.'));
    return this.track(this.explicitRefresh());
  }

  private async removeDeletedCards(session: SessionRow): Promise<boolean> {
    let failed = false;
    for (const slot of sessionSlots(session)) {
      const ids = new Set([messageId(session, slot), ...(session.identity_map.stickyPrevious?.[slot] ?? [])]);
      const channelId = slot === 'checkin' ? session.channel_id : session.identity_map.roundRooms?.[slot] ?? session.identity_map.matchChannels?.[slot] ?? session.channel_id;
      for (const id of ids) {
        if (!id) continue;
        if (!this.accepting || !this.canPost() || !this.transport.remove) return false;
        try { await this.transport.remove(id, slot, channelId); }
        catch (error) { if (this.transport.classify(error) !== 'missing') failed = true; }
      }
    }
    if (failed) return false;
    try { await clearDeletedSessionCards(session.event_id); } catch { return false; }
    return true;
  }

  retryDeletedCards(): Promise<void> {
    if (!this.accepting || !this.canPost()) return Promise.resolve();
    if (this.deletedCardCleanup) return this.deletedCardCleanup;
    const task = this.refreshTask.then(async () => {
      for (const session of await deletedSessionsWithCards(this.config)) {
        if (!this.accepting || !this.canPost()) return;
        await this.removeDeletedCards(session);
      }
    });
    this.refreshTask = task.catch(() => {});
    this.deletedCardCleanup = this.track(task.finally(() => { this.deletedCardCleanup = undefined; }));
    return this.deletedCardCleanup;
  }

  deleteTournament(eventId: string): Promise<{ cleanupPending: boolean }> {
    const available = () => this.accepting && this.canPost();
    if (!available()) return Promise.reject(new ControllerUnavailableError('The Discord bot is unavailable.'));
    const task = this.refreshTask.then(async () => {
      const session = await deleteActiveTournament(this.config, eventId, available);
      if (this.scheduledEventId === eventId) {
        this.scheduledEventId = undefined;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
      }
      this.notify({ type: 'event', eventId });
      let cleanupPending = !await this.removeDeletedCards(session);
      try { await this.syncRooms?.(true); } catch { cleanupPending = true; }
      return { cleanupPending };
    });
    this.refreshTask = task.then(() => {}, () => {});
    return this.track(task);
  }

  openSignup(eventId: string, expectedActiveEventId: string | null,
    selectArtwork: (game: ArtworkGame) => Promise<void>,
    prepareChannel?: Parameters<typeof activateSignupDraft>[4], scheduled = false): Promise<OpenTournamentSignupResult> {
    const available = () => this.accepting && this.canPost();
    if (!available()) return Promise.reject(new ControllerUnavailableError('The Discord bot is unavailable.'));
    const task = this.refreshTask.then(async (): Promise<OpenTournamentSignupResult> => {
      let finishCurrent: (() => Promise<void>) | undefined;
      if (this.transport.unpin) {
        const current = await this.read(this.config).catch(error => {
          if (error instanceof NoActiveSessionError) return null;
          throw error;
        });
        if (current && current.state.id !== eventId && signupTournamentComplete(current.state))
          finishCurrent = () => this.finishTournamentCards(current.session, current.state, true);
      }
      // The results cleanup runs only once the activation has passed its checks.
      const result = await activateSignupDraft(this.config, eventId, expectedActiveEventId, available, prepareChannel, scheduled,
        { defaultChannelId: this.homeChannelId, ...(finishCurrent ? { beforeActivate: finishCurrent } : {}) });
      const removeOld = result.installChannel?.();
      this.config.channelId = result.channelId;
      if (expectedActiveEventId !== eventId) this.config.roundRooms = undefined;
      this.notify({ type: 'event', eventId });
      this.signupCardPending = eventId;
      let panels: OpenTournamentSignupResult['panels'] = 'posted';
      try { await selectArtwork(result.game); } catch { panels = 'pending'; }
      try {
        if (!available()) throw new ControllerUnavailableError('The Discord bot is unavailable.');
        await this.refresh('explicit');
      } catch {
        panels = 'pending';
        this.scheduleRetry();
      }
      if (available() && panels === 'posted') {
        for (const { id, slot, channelId } of result.retiredCards) {
          try { if (this.transport.remove) await this.transport.remove(id, slot, channelId); else await removeOld?.(id, slot); } catch { /* Retired card controls are invalid. */ }
        }
      }
      try { if (available()) await this.syncRooms?.(true); } catch { panels = 'pending'; }
      return { eventId, panels };
    });
    this.refreshTask = task.then(() => {}, () => {});
    return this.track(task);
  }

  /** Applies a visual selection only to existing canonical cards. Never sends, pins, binds or clears suspension. */
  refreshArtworkExisting(): Promise<{ status: 'applied' | 'pending'; message?: string }> {
    if (!this.accepting || !this.canPost()) return Promise.resolve({ status: 'pending', message: 'The Discord controller is unavailable.' });
    const task = this.refreshTask.then(() => this.editArtworkExisting());
    this.refreshTask = task.then(() => {}, () => {});
    return this.track(task);
  }

  private async editArtworkExisting(): Promise<{ status: 'applied' | 'pending'; message?: string }> {
    if (!this.accepting || !this.canPost()) return { status: 'pending', message: 'The Discord controller is unavailable.' };
    let snapshot: Awaited<ReturnType<typeof getSessionState>>;
    try { snapshot = await this.read(this.config); }
    catch { return { status: 'pending', message: 'Active Discord panels could not be loaded.' }; }
    const { session, state } = snapshot;
    const players = resolvePlayers(session, state) ?? undefined;
    if (signupTournamentComplete(state) && this.transport.unpin) return { status: 'applied' };
    let pending = false;
    let changed = false;
    for (const slot of state.firstRound ? ['checkin' as const, ...state.matches.map(match => match.id)] : SLOTS) {
      if (!this.accepting || !this.canPost()) { pending = true; break; }
      const id = messageId(session, slot);
      if (!id || session.identity_map.stickySuspended?.includes(slot)) { pending = true; continue; }
      try {
        await this.transport.edit(id, this.render(state, slot, session), slot);
        changed = true;
      } catch { pending = true; }
    }
    if (changed) this.panelChanged(session.event_id);
    return pending ? { status: 'pending', message: 'One or more existing panels could not be updated.' } : { status: 'applied' };
  }

  private async explicitRefresh(): Promise<ExplicitRefreshResult> {
    const { state } = await this.read(this.config);
    if (state.matches.some(match => match.phase === 'running' && match.runnerId !== this.runnerId))
      throw new RuleError('Private Discord session has an interrupted running clock; stop and prepare --replace.');
    let cardWarning = false;
    let cardError: string | null = null;
    try { await this.requestRefresh('explicit'); }
    catch (error) {
      cardWarning = true;
      if (error instanceof RuleError) cardError = error.message;
    }
    let roomWarning = '';
    try { await this.syncRooms?.(true); }
    catch (error) { roomWarning = error instanceof RuleError ? error.message : 'Public match room setup failed.'; }
    return {
      cards: cardWarning ? 'pending' : 'refreshed', cardError, roomWarning: roomWarning || null,
      reply: (cardWarning ? 'Practice card refresh pending.' : 'Practice cards refreshed.') +
        (roomWarning ? ` Room setup pending: ${roomWarning}` : '')
    };
  }

  /**
   * Applies one command and runs everything that follows a commit: the change notice, room sync after
   * signup and publication, the resume reminder, timer scheduling from the latest state (a judge-resume
   * arms its expiry timer) and the card refresh. Errors before the commit reject. After a committed
   * change nothing rejects: a later failure schedules a retry and reports "saved; display pending".
   */
  private async commit(eventId: string, command: Command, apply: () => Promise<Outcome>,
    actorId: string | null = null): Promise<AdminApplyResult> {
    const outcome = await apply();
    try {
      if (outcome.applied) this.notify({ type: 'event', eventId });
      if (outcome.applied) this.emitCommitted(eventId, command, actorId);
      let roomWarning = '';
      if (outcome.applied && ['signupClose', 'signupReopen', 'publish'].includes(command.type)) {
        try { await this.syncRooms?.(false); }
        catch (error) { roomWarning = error instanceof RuleError ? error.message : 'Public match room setup failed.'; }
      }
      if (outcome.applied && command.type === 'resumeConsent' && this.transport.resumeReminder) {
        const waiting = await this.claimReminder(this.config, eventId,
          command.matchId, command.pauseGeneration);
        if (waiting?.length && this.accepting && this.canPost()) {
          const reminderId = await this.transport.resumeReminder(command.matchId, waiting);
          this.onHumanMessage(channelForSlot(this.config, command.matchId), reminderId);
          if (this.transport.remove) {
            const timer = setTimeout(() => {
              void this.transport.remove!(reminderId, command.matchId).catch(() => {});
            }, 8_000);
            timer.unref();
          }
        }
      }
      const latest = await this.read(this.config);
      if (outcome.applied) this.emitFromState(eventId, command, latest.state);
      this.schedule(latest.state);
      if (!outcome.applied) return { outcome, cards: 'updated', roomWarning: null, reply: noChangeReply(outcome.result), degraded: false };
      let cardPending = false;
      try {
        await this.requestRefresh();
      } catch { cardPending = true; }
      return { outcome, cards: cardPending ? 'pending' : 'updated', roomWarning: roomWarning || null, degraded: false,
        reply: savedReply(command.type, cardPending, roomWarning) };
    } catch (error) {
      if (!outcome.applied) throw error;
      this.scheduleRetry();
      return { outcome, cards: 'pending', roomWarning: null, degraded: true,
        reply: `Saved: ${outcome.result}. Card update pending.` };
    }
  }

  private async handleAcknowledged(interaction: PrivateInteraction): Promise<void> {
    let committed: AdminApplyResult | undefined;
    try {
      // Staff commands: the organizer or a member with a tournament staff role (admin-tools settings).
      const level = interaction.kind === 'command' ? await this.staffLevel(interaction.userId, interaction.roleIds) : null;
      if (interaction.kind === 'command' && !level) throw new RuleError(STAFF_DENIED);
      if (interaction.kind === 'command' && interaction.subcommand === 'refresh') {
        await interaction.reply((await this.explicitRefresh()).reply);
        return;
      }
      const { session, state } = await this.read(this.config);
      if (interaction.kind === 'button' && this.canonicalButton(interaction, session).action === 'signupRoster') {
        if (!state.signup) throw new RuleError('Signup roster is unavailable.');
        const { roster, capacity = 4 } = state.signup;
        const title = `Signup roster (${roster.length}/${capacity}):`;
        const names = roster.map((id, index) => `${index + 1}. <@${id}>`).join('\n') || 'No players have joined yet.';
        const message = `${title}\n${names}`;
        if (message.length <= 3_500) {
          await interaction.reply(message);
        } else {
          const csv = ['position,discord_user_id', ...roster.map((id, index) => `${index + 1},${id}`)].join('\r\n');
          await interaction.reply(`${title} Download the complete roster below.`, {
            name: 'signup-roster.csv', attachment: Buffer.from(csv)
          });
        }
        return;
      }
      if (level === 'staff' && Object.values(resolvePlayers(session, state) ?? {}).includes(interaction.userId))
        throw new RuleError('Staff who play in this tournament cannot run staff commands for it. Ask the organizer or another staff member.');
      const { command, slot } = this.commandFor(interaction, session, state);
      const cardId = slot && interaction.kind === 'judgeRequest' ? messageId(session, slot) : interaction.messageId;
      // A staff member acts as the organizer in the domain; principal_id keeps the real Discord user.
      committed = await this.commit(session.event_id, command, () => this.apply({ config: this.config, eventId: session.event_id,
        principalId: interaction.userId, interactionId: interaction.id, ...(level === 'staff' ? { staff: true } : {}),
        ...(slot && cardId ? { message: { slot, id: cardId, channelId: interaction.channelId! } } : {}) }, command, this.runnerId, this.clock),
        interaction.userId);
      if (committed.degraded) {
        // A post-commit failure already scheduled the retry; one reply attempt, as before.
        try { await interaction.reply(committed.reply); } catch { /* Initial acknowledgment already succeeded. */ }
        return;
      }
      await interaction.reply(committed.reply);
    } catch (error) {
      if (committed?.outcome.applied) this.scheduleRetry();
      else if (interaction.kind === 'button' && error instanceof RuleError)
        void this.requestRefresh().catch(() => {});
      const message = committed?.outcome.applied ? `Saved: ${committed.outcome.result}. Card update pending.`
        : error instanceof RuleError ? error.message : 'Private Discord action failed.';
      try { await interaction.reply(message); } catch { /* Initial acknowledgment already succeeded. */ }
    }
  }

  private canonicalButton(interaction: PrivateInteraction, session: SessionRow): ParsedButton {
    const parsed = parseButtonId(interaction.customId ?? '');
    if (parsed.eventId !== session.event_id || interaction.channelId !== channelForSlot(this.config, parsed.slot) || !interaction.messageId ||
        interaction.messageId !== messageId(session, parsed.slot)) throw new RuleError('This control is not on the canonical card.');
    return parsed;
  }

  private commandFor(interaction: PrivateInteraction, session: SessionRow, state: EventState): { command: Command; slot?: CardSlot } {
    if (interaction.kind === 'command') {
      // The organizer or tournament staff only: checked (asynchronously) in handleAcknowledged.
      const matchId = interaction.matchId ? interaction.matchId.trim().toUpperCase() as MatchId : undefined;
      const reason = interaction.reason;
      const players = resolvePlayers(session, state) as Record<string, string> | null;
      /** A seat letter (A, P3), a `<@id>` mention or a bare member ID, as the seat it names. */
      const seatOf = (raw: string | undefined): Player | undefined => {
        const text = (raw ?? '').trim();
        const id = /^<@!?(\d{15,22})>$/.exec(text)?.[1] ?? (/^\d{15,22}$/.test(text) ? text : null);
        if (id) return Object.entries(players ?? {}).find(([, member]) => member === id)?.[0] as Player | undefined;
        return text ? text.toUpperCase() as Player : undefined;
      };
      const winner = seatOf(interaction.winner);
      if (interaction.subcommand === 'signup-add') {
        if (!interaction.memberId) throw new RuleError('Choose the member to add.');
        if (interaction.memberId === session.identity_map.adminId) throw new RuleError('Signup admin cannot play.');
        return { command: { type: 'signupAdd', memberId: interaction.memberId } };
      }
      if (interaction.subcommand === 'checkin-for') {
        const seat = seatOf(interaction.player);
        if (!seat || !players?.[seat]) throw new RuleError('Choose a seated player (for example A or P3, or mention them).');
        return { command: { type: 'checkinFor', seat } };
      }
      if (interaction.subcommand === 'publish') return { command: { type: 'publish' } };
      if (interaction.subcommand === 'signup-close') return { command: { type: 'signupClose', adminId: session.identity_map.adminId } };
      if (interaction.subcommand === 'signup-reopen') return { command: { type: 'signupReopen' } };
      if (interaction.subcommand === 'signup-remove' && interaction.memberId)
        return { command: { type: 'signupRemove', memberId: interaction.memberId } };
      if (!matchId || !state.matches.some(match => match.id === matchId))
        throw new RuleError(`Unknown match. Choose one of ${state.matches.map(match => match.id).join(', ') || 'none (no round yet)'}.`);
      if (interaction.subcommand === 'judge-resume' && reason?.trim())
        return { command: { type: 'judgeResume', matchId, reason } };
      if ((interaction.subcommand === 'resolve' || interaction.subcommand === 'correct') && winner && reason?.trim()) {
        const match = state.matches.find(item => item.id === matchId);
        if (!match?.players.includes(winner))
          throw new RuleError(`Winner is not in the selected match (${match?.players.join(' vs ') ?? matchId}).`);
        return { command: { type: interaction.subcommand, matchId, winner, reason } };
      }
      throw new RuleError('Invalid admin command options.');
    }
    const parsed = interaction.kind === 'judgeRequest'
      ? parseButtonId(interaction.customId ?? '')
      : this.canonicalButton(interaction, session);
    if (interaction.kind === 'judgeRequest' &&
        (parsed.action !== 'judge' || parsed.eventId !== session.event_id ||
          interaction.channelId !== channelForSlot(this.config, parsed.slot) || !messageId(session, parsed.slot) ||
          interaction.judgeRequest?.requesterId !== interaction.userId))
      throw new RuleError('This judge request is no longer valid. Open the form from your current match card.');
    const players = resolvePlayers(session, state);
    const player = (Object.entries(players ?? {}) as Array<[Player, string]>).find(([, id]) => id === interaction.userId)?.[0];
    const slot = parsed.slot;
    if (parsed.action === 'signupJoin' || parsed.action === 'signupWithdraw') {
      if (!state.signup || state.signup.status !== 'open') throw new RuleError('Signup is closed.');
      if (interaction.userId === session.identity_map.adminId) throw new RuleError('Signup admin cannot play.');
      return { command: { type: parsed.action }, slot };
    }
    if (!player) throw new RuleError('Private fixture player action denied.');
    if (slot === 'checkin') return { command: { type: 'checkin' }, slot };
    if (!state.matches.find(match => match.id === slot)?.players.includes(player)) throw new RuleError('Match participant action denied.');
    const matchId = slot;
    switch (parsed.action) {
      case 'ready': return { command: { type: 'ready', matchId }, slot };
      case 'pause': return { command: { type: 'pause', matchId }, slot };
      case 'judge': {
        if (interaction.kind !== 'judgeRequest') return { command: { type: 'callJudge', matchId }, slot };
        const category = interaction.judgeRequest?.category;
        const description = interaction.judgeRequest?.description.trim();
        if (!isJudgeRequestCategory(category) || !description || description.length > MAX_JUDGE_REQUEST_LENGTH)
          throw new RuleError('Choose a category and describe what you need help with.');
        return { command: { type: 'callJudge', matchId, judgeRequest: { category, description } }, slot };
      }
      case 'resume': return { command: { type: 'resumeConsent', matchId, pauseGeneration: parsed.revision! }, slot };
      case 'won': case 'lost': {
        const match = state.matches.find(item => item.id === matchId)!;
        const winner = parsed.action === 'won' ? player : match.players.find(item => item !== player)!;
        return { command: { type: 'propose', matchId, winner, expectedRevision: parsed.revision! }, slot };
      }
      case 'confirm': case 'dispute': return { command: { type: parsed.action, matchId, revision: parsed.revision! }, slot };
      default: throw new RuleError('Invalid private Discord control.');
    }
  }

  async stop(): Promise<void> {
    this.accepting = false;
    if (this.retry) clearTimeout(this.retry);
    for (const entry of this.sticky.values()) if (entry.timer) clearTimeout(entry.timer);
    this.sticky.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.pending]);
  }
}
