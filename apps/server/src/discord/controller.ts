import type { Command, EventState, MatchId, Player } from '../rehearsal/domain.js';
import { RuleError } from '../rehearsal/domain.js';
import { applyDiscordCommand } from '../rehearsal/store.js';
import { parseButtonId, renderCard, type CardPayload } from './cards.js';
import { channelForSlot, type PrivateDiscordConfig } from './config.js';
import { bindCard, claimResumeReminder, completeStickyCard, getSessionState, messageId, replaceStickyCard, suspendStickyCard,
  resolvePlayers, type CardSlot, type SessionRow } from './session.js';

export interface PrivateInteraction {
  id: string;
  applicationId: string;
  guildId: string | null;
  channelId: string | null;
  userId: string;
  kind: 'button' | 'command';
  customId?: string;
  messageId?: string;
  subcommand?: string;
  matchId?: MatchId;
  winner?: Player;
  reason?: string;
  memberId?: string;
  acknowledge(): Promise<void>;
  reply(message: string): Promise<void>;
}

export interface CardTransport {
  send(payload: CardPayload, slot?: CardSlot): Promise<string>;
  edit(id: string, payload: CardPayload, slot?: CardSlot): Promise<void>;
  pin(id: string, slot?: CardSlot): Promise<void>;
  resumeReminder?(slot: MatchId, waitingIds: string[]): Promise<string>;
  remove?(id: string, slot: CardSlot): Promise<void>;
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
  private scheduledVersion = -1;
  private sticky = new Map<string, StickyChannel>();
  private listeners = new Set<ControllerListener>();
  private panelRevision = 0;
  private lastPending = false;

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
    private readonly syncRooms?: (explicit: boolean) => Promise<void>
  ) {}

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

  async start(): Promise<void> {
    const { state } = await this.read(this.config);
    this.schedule(state);
    void this.requestRefresh().catch(() => {});
  }

  reconnect(): void {
    if (this.accepting) void this.requestRefresh().catch(() => {});
  }

  private requestRefresh(mode: RefreshMode = 'known'): Promise<void> {
    this.dirty++;
    this.pendingChanged();
    const task = this.refreshTask.then(() => this.refresh(mode));
    this.refreshTask = task.catch(() => {});
    return this.track(task);
  }

  private async refresh(mode: RefreshMode): Promise<void> {
    if (!this.accepting) return;
    const ticket = this.dirty;
    let snapshot: Awaited<ReturnType<typeof getSessionState>>;
    try { snapshot = await this.read(this.config); }
    catch (error) { this.scheduleRetry(); throw error; }
    const { session, state } = snapshot;
    this.schedule(state);
    let failed = false;
    let retryable = false;
    for (const slot of SLOTS) {
      if (!this.accepting) return;
      const id = messageId(session, slot);
      const payload = renderCard(state, slot, this.runnerId, resolvePlayers(session, state) ?? undefined);
      if (!id) {
        if (mode !== 'explicit') continue;
        // Send is attempted once. An ambiguous response never triggers an automatic resend.
        const sent = await this.sendOnce(payload, slot);
        await this.bind(this.config, session.event_id, slot, sent);
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
        if (mode === 'explicit' && this.transport.classify(error) === 'missing') {
          const sent = await this.sendOnce(payload, slot);
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

  private async sendOnce(payload: CardPayload, slot: CardSlot): Promise<string> {
    try { return await this.transport.send(payload, slot); }
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
        !SLOTS.some(slot => channelId === channelForSlot(this.config, slot))) return;
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
    for (const slot of SLOTS) {
      if (!this.accepting || !this.canPost()) return;
      if (channelForSlot(this.config, slot) !== channelId || session.identity_map.stickySuspended?.includes(slot)) continue;
      const oldId = messageId(session, slot);
      if (!oldId || BigInt(observedId) <= BigInt(oldId)) continue;
      const payload = renderCard(state, slot, this.runnerId, resolvePlayers(session, state) ?? undefined);
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
        await this.stickyStore.complete(this.config, session.event_id, slot, newId);
        this.panelChanged(session.event_id);
      }
    }
  }

  private schedule(state: EventState): void {
    if (state.version < this.scheduledVersion) return;
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
      if (!this.accepting || this.scheduledVersion > version) return;
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
    this.schedule(latest.state);
    if (result.applied) await this.requestRefresh();
  }

  async handle(interaction: PrivateInteraction): Promise<void> {
    if (!this.accepting) return;
    const scope = interaction.applicationId === this.config.applicationId &&
      interaction.guildId === this.config.guildId && interaction.channelId !== null &&
      (interaction.kind === 'command' ? interaction.channelId === this.config.channelId :
        SLOTS.some(slot => interaction.channelId === channelForSlot(this.config, slot)));
    if (!scope) return;
    await this.track((async () => {
      try { await interaction.acknowledge(); } catch { return; }
      if (!this.accepting) return;
      await this.handleAcknowledged(interaction);
    })());
  }

  private async handleAcknowledged(interaction: PrivateInteraction): Promise<void> {
    let committed: { result: string; applied: boolean } | undefined;
    try {
      if (interaction.kind === 'command' && interaction.subcommand === 'refresh') {
        this.requireAdmin(interaction.userId);
        const { state } = await this.read(this.config);
        if (state.matches.some(match => match.phase === 'running' && match.runnerId !== this.runnerId))
          throw new RuleError('Private Discord session has an interrupted running clock; stop and prepare --replace.');
        let cardWarning = false;
        try { await this.requestRefresh('explicit'); }
        catch { cardWarning = true; }
        let roomWarning = '';
        try { await this.syncRooms?.(true); }
        catch (error) { roomWarning = error instanceof RuleError ? error.message : 'Public match room setup failed.'; }
        await interaction.reply((cardWarning ? 'Practice card refresh pending.' : 'Practice cards refreshed.') +
          (roomWarning ? ` Room setup pending: ${roomWarning}` : ''));
        return;
      }
      const { session, state } = await this.read(this.config);
      const { command, slot } = this.commandFor(interaction, session, state);
      const outcome = await this.apply({ config: this.config, eventId: session.event_id,
        principalId: interaction.userId, interactionId: interaction.id,
        ...(slot ? { message: { slot, id: interaction.messageId!, channelId: interaction.channelId! } } : {}) }, command, this.runnerId, this.clock);
      committed = outcome;
      if (outcome.applied) this.notify({ type: 'event', eventId: session.event_id });
      let roomWarning = '';
      if (outcome.applied && ['signupClose', 'signupReopen', 'publish'].includes(command.type)) {
        try { await this.syncRooms?.(false); }
        catch (error) { roomWarning = error instanceof RuleError ? error.message : 'Public match room setup failed.'; }
      }
      if (outcome.applied && command.type === 'resumeConsent' && this.transport.resumeReminder) {
        const waiting = await this.claimReminder(this.config, session.event_id,
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
      this.schedule(latest.state);
      if (outcome.applied) {
        let cardPending = false;
        try {
          await this.requestRefresh();
        } catch { cardPending = true; }
        await interaction.reply(`Saved: ${command.type}.${cardPending ? ' Card update pending.' : ''}` +
          (roomWarning ? ` Room setup pending: ${roomWarning}` : ''));
      } else await interaction.reply(`No change: ${outcome.result}.`);
    } catch (error) {
      if (committed?.applied) this.scheduleRetry();
      else if (interaction.kind === 'button' && error instanceof RuleError)
        void this.requestRefresh().catch(() => {});
      const message = committed?.applied ? `Saved: ${committed.result}. Card update pending.`
        : error instanceof RuleError ? error.message : 'Private Discord action failed.';
      try { await interaction.reply(message); } catch { /* Initial acknowledgment already succeeded. */ }
    }
  }

  private requireAdmin(userId: string): void {
    if (userId !== this.config.adminId) throw new RuleError('Private test admin action denied.');
  }

  private commandFor(interaction: PrivateInteraction, session: SessionRow, state: EventState): { command: Command; slot?: CardSlot } {
    if (interaction.kind === 'command') {
      this.requireAdmin(interaction.userId);
      const matchId = interaction.matchId;
      const winner = interaction.winner;
      const reason = interaction.reason;
      if (interaction.subcommand === 'publish') return { command: { type: 'publish' } };
      if (interaction.subcommand === 'signup-close') return { command: { type: 'signupClose', adminId: session.identity_map.adminId } };
      if (interaction.subcommand === 'signup-reopen') return { command: { type: 'signupReopen' } };
      if (interaction.subcommand === 'signup-remove' && interaction.memberId)
        return { command: { type: 'signupRemove', memberId: interaction.memberId } };
      if (!matchId || !['M1', 'M2'].includes(matchId)) throw new RuleError('Invalid match option.');
      if (interaction.subcommand === 'judge-resume' && reason?.trim())
        return { command: { type: 'judgeResume', matchId, reason } };
      if ((interaction.subcommand === 'resolve' || interaction.subcommand === 'correct') && winner && reason?.trim()) {
        const match = state.matches.find(item => item.id === matchId);
        if (!match?.players.includes(winner)) throw new RuleError('Winner is not in the selected match.');
        return { command: { type: interaction.subcommand, matchId, winner, reason } };
      }
      throw new RuleError('Invalid admin command options.');
    }
    const parsed = parseButtonId(interaction.customId ?? '');
    if (parsed.eventId !== session.event_id || interaction.channelId !== channelForSlot(this.config, parsed.slot) || !interaction.messageId ||
        interaction.messageId !== messageId(session, parsed.slot)) throw new RuleError('This control is not on the canonical card.');
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
      case 'judge': return { command: { type: 'callJudge', matchId }, slot };
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
