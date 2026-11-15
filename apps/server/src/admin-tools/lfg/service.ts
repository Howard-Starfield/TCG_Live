// LFG flows shared by the Discord feature (buttons, modal, expiry) and the dashboard routes (close, delete):
// create a post (limits, cooldown, ping cooldown), join/leave (idempotent), close/expire/delete, and the card
// refresher that coalesces rapid clicks into as few message edits as possible. Discord I/O goes through LfgGateway.
import type { LfgPostDto, LfgSettingsBodyDto, OpsAuditKind } from '@tcg-live/core';
import type { OpsActor } from '../../ops/audit.js';
import { discordErrorKind } from '../channels/sticky-engine.js';
import { lfgCardMessage, lfgFirstMessage, lfgReply, type LfgMessage } from './messages.js';
import { lfgChannelConfig } from './settings.js';
import type { CloseStatus, LfgPostStore } from './store.js';

export interface LfgGateway {
  /** Posts and returns the message ID. */
  send(channelId: string, message: LfgMessage): Promise<string>;
  /** 'missing' when the message or channel is gone. */
  edit(channelId: string, messageId: string, message: LfgMessage): Promise<'ok' | 'missing'>;
  /** An already-deleted message is not an error. */
  remove(channelId: string, messageId: string): Promise<void>;
}

export interface LfgServiceDeps {
  guildId: string;
  store: LfgPostStore;
  gateway: LfgGateway;
  settings(): Promise<LfgSettingsBodyDto>;
  audit(kind: OpsAuditKind, payload: Record<string, unknown>, actor: OpsActor): Promise<unknown>;
  now(): number;
  log?(message: string): void;
}

const player = (id: string): OpsActor => ({ kind: 'player', id });
const BOT: OpsActor = { kind: 'bot', id: 'bot' };
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export type CreateOutcome =
  | { kind: 'created'; post: LfgPostDto }
  | { kind: 'refused'; message: string };

/** Clicks being handled right now per member (a double-submit answers "already posting"). */
const creating = new Set<string>();

export async function createLfgPost(deps: LfgServiceDeps, input: { channelId: string; authorId: string; game: string; format: string | null;
  note: string | null; voiceChannelId: string | null }): Promise<CreateOutcome> {
  const settings = await deps.settings();
  const config = settings.enabled ? lfgChannelConfig(settings, input.channelId) : null;
  if (!config) return { kind: 'refused', message: 'LFG is not available in this channel right now.' };
  const key = `${deps.guildId}:${input.authorId}`;
  if (creating.has(key)) return { kind: 'refused', message: 'Your post is already being created.' };
  creating.add(key);
  try {
    const now = deps.now();
    const result = await deps.store.create({ guildId: deps.guildId, ...input, nowMs: now, expiresAtMs: now + settings.expiryMinutes * 60_000,
      cooldownMs: settings.cooldownMinutes * 60_000, maxOpen: settings.maxOpenPerUser, pingRoleId: config.pingRoleFor(input.game),
      pingCooldownMs: settings.pingCooldownMinutes * 60_000 });
    if (result.kind === 'max-open') return { kind: 'refused', message: result.max === 1
      ? 'You already have an open LFG post. Close it before posting a new one.'
      : `You already have ${result.open} open LFG posts (the limit is ${result.max}). Close one before posting again.` };
    if (result.kind === 'cooldown') return { kind: 'refused', message: `You can post again in ${minutes(result.retryAtMs - now)} minute(s).` };
    let messageId: string;
    try { messageId = await deps.gateway.send(input.channelId, lfgFirstMessage(result.post, settings)); }
    catch (error) {
      await deps.store.discard(deps.guildId, result.post.id).catch(() => {});
      deps.log?.('LFG: a card could not be posted (check the bot\'s permissions in the LFG channel).');
      return { kind: 'refused', message: discordErrorKind(error) === 'missing-permissions'
        ? 'The bot cannot post in this channel. Please tell the staff.' : 'The post could not be created. Try again in a moment.' };
    }
    const post = await deps.store.setMessage(deps.guildId, result.post.id, messageId);
    if (!post) {
      // Closed or deleted from the dashboard while the card was being sent.
      const current = await deps.store.get(deps.guildId, result.post.id);
      if (current) await refreshLfgCard(deps, current.id);
      return { kind: 'refused', message: 'Your post was closed while it was being created.' };
    }
    await deps.audit('lfg.posted', { postId: post.id, channelId: post.channelId, messageId, game: post.game, format: post.format,
      voiceChannelId: post.voiceChannelId, pingedRoleId: post.pingedRoleId }, player(input.authorId)).catch(() => {});
    return { kind: 'created', post };
  } finally { creating.delete(key); }
}

// ---------------------------------------------------------------- card refresh (coalesced per post)

interface RefreshSlot { running: Promise<void>; again: boolean }
const refreshing = new Map<string, RefreshSlot>();

/**
 * Re-renders a card from the stored state. Concurrent calls for one post coalesce: while an edit runs,
 * further calls only mark it dirty and one more edit (with the newest state) follows. A card that no
 * longer exists marks an open post deleted.
 */
export function refreshLfgCard(deps: LfgServiceDeps, postId: string): Promise<void> {
  const key = `${deps.guildId}:${postId}`;
  const slot = refreshing.get(key);
  if (slot) { slot.again = true; return slot.running; }
  const next: RefreshSlot = { again: false, running: Promise.resolve() };
  next.running = (async () => {
    try {
      do {
        next.again = false;
        const post = await deps.store.get(deps.guildId, postId);
        if (!post?.messageId) return;
        if (post.status === 'deleted') { await deps.gateway.remove(post.channelId, post.messageId).catch(() => {}); return; }
        const outcome = await deps.gateway.edit(post.channelId, post.messageId, lfgCardMessage(post, await deps.settings())).catch(() => 'ok' as const);
        if (outcome === 'missing') { await cardMissing(deps, post); return; }
      } while (next.again);
    } finally { refreshing.delete(key); }
  })();
  refreshing.set(key, next);
  return next.running;
}

async function cardMissing(deps: LfgServiceDeps, post: LfgPostDto): Promise<void> {
  const closed = await deps.store.close(deps.guildId, post.id, 'deleted', 'message-deleted', deps.now());
  if (closed) await deps.audit('lfg.deleted', { postId: post.id, channelId: post.channelId, game: post.game, reason: 'message-deleted' }, BOT).catch(() => {});
}

// ---------------------------------------------------------------- member actions

export type MemberAction = 'join' | 'leave';
export interface MemberActionOutcome { message: string; post: LfgPostDto | null; changed: boolean }

export async function lfgMemberAction(deps: LfgServiceDeps, action: MemberAction, postId: string, userId: string): Promise<MemberActionOutcome> {
  const settings = await deps.settings();
  const result = action === 'join' ? await deps.store.join(deps.guildId, postId, userId, deps.now()) : await deps.store.leave(deps.guildId, postId, userId);
  if (result.kind === 'missing') return { message: 'This post no longer exists.', post: null, changed: false };
  const post = result.post;
  switch (result.kind) {
    case 'closed': return { message: 'This post is closed.', post, changed: false };
    case 'author': return { message: action === 'join' ? 'You are hosting this game.' : 'You host this game; use Close to end it.', post, changed: false };
    case 'already': return { message: 'You already joined this game.', post, changed: false };
    case 'not-joined': return { message: 'You have not joined this game.', post, changed: false };
  }
  await deps.audit(action === 'join' ? 'lfg.joined' : 'lfg.left', { postId: post.id, channelId: post.channelId, game: post.game,
    players: post.players.length }, player(userId)).catch(() => {});
  void refreshLfgCard(deps, post.id).catch(() => {});
  return { message: lfgReply(action === 'join' ? settings.messages.joinedText : settings.messages.leftText, post, settings), post, changed: true };
}

/** Closes (author, staff, dashboard), expires (scheduler) or deletes (dashboard; the card is removed). Acts once. */
export async function endLfgPost(deps: LfgServiceDeps, postId: string, status: CloseStatus, by: string, actor: OpsActor): Promise<LfgPostDto | null> {
  const post = await deps.store.close(deps.guildId, postId, status, by, deps.now());
  if (!post) return null;
  const kind = status === 'expired' ? 'lfg.expired' : status === 'deleted' ? 'lfg.deleted' : 'lfg.closed';
  await deps.audit(kind, { postId: post.id, channelId: post.channelId, game: post.game, players: post.players.length, by }, actor).catch(() => {});
  await refreshLfgCard(deps, post.id).catch(() => {});
  return post;
}

/** Expires every due post (restart catch-up included). Returns how many were expired. */
export async function expireDueLfgPosts(deps: LfgServiceDeps): Promise<number> {
  let count = 0;
  for (const post of await deps.store.due(deps.guildId, deps.now())) {
    if (await endLfgPost(deps, post.id, 'expired', 'expired', BOT)) count += 1;
  }
  return count;
}

/** Cards deleted by hand (or their channel): their open posts are marked deleted, never re-posted. */
export async function lfgCardsDeleted(deps: LfgServiceDeps, where: { messageIds?: readonly string[]; channelId?: string }): Promise<number> {
  let count = 0;
  for (const post of await deps.store.findActive(deps.guildId, where)) {
    const closed = await deps.store.close(deps.guildId, post.id, 'deleted', 'message-deleted', deps.now());
    if (!closed) continue;
    count += 1;
    await deps.audit('lfg.deleted', { postId: post.id, channelId: post.channelId, game: post.game, reason: where.channelId ? 'channel-deleted' : 'message-deleted' },
      BOT).catch(() => {});
  }
  return count;
}

/** Test seam: forget in-flight state between tests. */
export function resetLfgServiceState(): void { creating.clear(); refreshing.clear(); }
