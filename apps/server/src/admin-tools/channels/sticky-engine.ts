// Debounced "keep this message at the bottom" engine, shared by general stickies and the ticket panel.
// Discord-agnostic: a StickyPoster does the I/O, so tests drive it with a fake clock and poster.
//
// Timing: a sticky is re-posted at most once per `debounceMs`. After a member's message it waits for
// `quietMs` without new messages, but never longer than `debounceMs` after the first unanswered message,
// so a busy channel still gets its sticky back. The bot's own posts, other bots and webhooks never trigger a re-post.
import type { StickyRuntimeStatus } from './types.js';

export interface StickyPoster<P> {
  /** Posts and returns the new message ID. */
  post(channelId: string, payload: P): Promise<string>;
  /** Deletes one message; an already-deleted message is not an error. */
  remove(channelId: string, messageId: string): Promise<void>;
  /** The newest message ID in the channel, or null when empty. */
  latestMessageId(channelId: string): Promise<string | null>;
}

export interface StickyTarget<P> {
  key: string;
  channelId: string;
  debounceMs: number;
  lastMessageId: string | null;
  render(): P;
  /** Persist the current copy (survives restarts). */
  onPosted(messageId: string | null): Promise<void>;
  onStatus(status: StickyRuntimeStatus): void;
}

export interface StickyClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const realClock: StickyClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; },
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout)
};

export const STICKY_QUIET_MS = 2_000;

/** Discord API error codes that matter here. */
export function discordErrorKind(error: unknown): 'missing-permissions' | 'channel-missing' | 'unknown-message' | 'too-old' | 'other' {
  const code = (error as { code?: unknown })?.code;
  if (code === 50013 || code === 50001) return 'missing-permissions';
  if (code === 10003) return 'channel-missing';
  if (code === 10008) return 'unknown-message';
  if (code === 50034) return 'too-old';
  return 'other';
}

export function stickyFailureStatus(error: unknown, now: number): StickyRuntimeStatus {
  switch (discordErrorKind(error)) {
    case 'missing-permissions': return { state: 'missing-permissions', atMs: now,
      message: 'The bot needs View Channel, Send Messages, Embed Links and Manage Messages in this channel.' };
    case 'channel-missing': return { state: 'channel-missing', atMs: now, message: 'The channel no longer exists. Pick another channel or delete this sticky.' };
    default: return { state: 'failed', atMs: now, message: 'Discord did not accept the sticky. It will be tried again on the next message.' };
  }
}

interface Slot<P> {
  target: StickyTarget<P>;
  lastPostAt: number;
  pendingSince: number | null;
  lastActivityAt: number;
  timer: unknown;
  posting: Promise<void> | null;
  again: boolean;
}

export class StickyEngine<P> {
  private readonly slots = new Map<string, Slot<P>>();
  private readonly byChannel = new Map<string, string>();
  private stopped = false;

  constructor(private readonly poster: StickyPoster<P>, private readonly botUserId: () => string | null,
    private readonly clock: StickyClock = realClock, private readonly quietMs = STICKY_QUIET_MS) {}

  has(key: string): boolean { return this.slots.has(key); }
  keyForChannel(channelId: string): string | null { return this.byChannel.get(channelId) ?? null; }
  lastMessageId(key: string): string | null { return this.slots.get(key)?.target.lastMessageId ?? null; }

  /** Adds or replaces a target; timing state is kept when the key already exists on the same channel. */
  upsert(target: StickyTarget<P>): void {
    const existing = this.slots.get(target.key);
    if (existing && existing.target.channelId !== target.channelId) this.byChannel.delete(existing.target.channelId);
    const owner = this.byChannel.get(target.channelId);
    if (owner && owner !== target.key) throw new Error('One sticky per channel.');
    this.byChannel.set(target.channelId, target.key);
    if (existing && existing.target.channelId === target.channelId) { existing.target = target; return; }
    if (existing) this.clock.clearTimeout(existing.timer);
    this.slots.set(target.key, { target, lastPostAt: Number.NEGATIVE_INFINITY, pendingSince: null, lastActivityAt: 0, timer: null, posting: null, again: false });
  }

  /** Stops tracking; optionally deletes the posted copy. */
  async remove(key: string, deleteCopy: boolean): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.clock.clearTimeout(slot.timer);
    this.slots.delete(key);
    if (this.byChannel.get(slot.target.channelId) === key) this.byChannel.delete(slot.target.channelId);
    await slot.posting?.catch(() => {});
    const copy = slot.target.lastMessageId;
    if (deleteCopy && copy) {
      try { await this.poster.remove(slot.target.channelId, copy); } catch { /* Best effort; the admin can delete it by hand. */ }
      await slot.target.onPosted(null).catch(() => {});
    }
  }

  /** A message arrived anywhere in the guild. */
  onMessage(message: { channelId: string; messageId: string; authorId: string; bot?: boolean }): void {
    if (this.stopped) return;
    const key = this.byChannel.get(message.channelId);
    const slot = key ? this.slots.get(key) : undefined;
    if (!slot) return;
    // Other bots and webhooks never trigger a re-post either: two sticky bots in one channel would re-post forever.
    if (message.bot || message.authorId === this.botUserId() || message.messageId === slot.target.lastMessageId) return;
    const now = this.clock.now();
    slot.pendingSince ??= now;
    slot.lastActivityAt = now;
    if (slot.posting) { slot.again = true; return; }
    this.schedule(slot);
  }

  /** Startup / after an edit: re-post unless our copy is already the newest message. */
  async ensureAtBottom(key: string, force = false): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot || this.stopped) return;
    if (!force && slot.target.lastMessageId) {
      try {
        const latest = await this.poster.latestMessageId(slot.target.channelId);
        if (latest === slot.target.lastMessageId) {
          slot.target.onStatus({ state: 'posted', message: null, atMs: this.clock.now() });
          return;
        }
      } catch (error) {
        slot.target.onStatus(stickyFailureStatus(error, this.clock.now()));
        return;
      }
    }
    this.clock.clearTimeout(slot.timer);
    slot.pendingSince = null;
    await this.run(slot);
  }

  stop(): void {
    this.stopped = true;
    for (const slot of this.slots.values()) this.clock.clearTimeout(slot.timer);
  }

  private schedule(slot: Slot<P>): void {
    const debounce = slot.target.debounceMs;
    const pendingSince = slot.pendingSince ?? slot.lastActivityAt;
    const fireAt = Math.max(slot.lastPostAt + debounce, Math.min(slot.lastActivityAt + this.quietMs, pendingSince + debounce));
    this.clock.clearTimeout(slot.timer);
    slot.target.onStatus({ state: 'waiting', message: null, atMs: this.clock.now() });
    slot.timer = this.clock.setTimeout(() => { slot.timer = null; void this.fire(slot); }, Math.max(0, fireAt - this.clock.now()));
  }

  private async fire(slot: Slot<P>): Promise<void> {
    if (this.stopped || this.slots.get(slot.target.key) !== slot) return;
    slot.pendingSince = null;
    await this.run(slot);
  }

  private async run(slot: Slot<P>): Promise<void> {
    if (slot.posting) { slot.again = true; return slot.posting; }
    slot.posting = this.repost(slot).finally(() => {
      slot.posting = null;
      if (slot.again && !this.stopped && this.slots.get(slot.target.key) === slot) {
        slot.again = false;
        slot.pendingSince ??= this.clock.now();
        this.schedule(slot);
      }
    });
    return slot.posting;
  }

  private async repost(slot: Slot<P>): Promise<void> {
    const { target } = slot;
    const previous = target.lastMessageId;
    let posted: string;
    try { posted = await this.poster.post(target.channelId, target.render()); }
    catch (error) { target.onStatus(stickyFailureStatus(error, this.clock.now())); return; }
    slot.lastPostAt = this.clock.now();
    target.lastMessageId = posted;
    await target.onPosted(posted).catch(() => {});
    target.onStatus({ state: 'posted', message: null, atMs: this.clock.now() });
    if (previous && previous !== posted) {
      try { await this.poster.remove(target.channelId, previous); }
      catch (error) {
        if (discordErrorKind(error) === 'missing-permissions')
          target.onStatus({ state: 'missing-permissions', atMs: this.clock.now(),
            message: 'Posted, but the old copy could not be deleted: give the bot Manage Messages in this channel.' });
      }
    }
  }
}
