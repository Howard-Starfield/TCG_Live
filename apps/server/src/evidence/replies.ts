// Delivering an evidence reply to a match's players in Discord. The store keeps the thread and the delivery
// status; this module runs one attempt and records how it ended. The Discord side is a seam
// (EvidenceReplyDelivery) supplied by the runtime, so the routes stay testable without a gateway.
import type { EvidenceReplyDto, MatchId } from '@tcg-live/core';
import type { OpsActor } from '../ops/audit.js';
import type { EvidenceStore, ReplyAttempt } from './store.js';

/** A delivery failure whose message is safe to show the admin (it is stored on the reply). */
export class ReplyDeliveryError extends Error {}

export interface ReplyDeliveryInput {
  eventId: string;
  matchId: MatchId;
  replyId: string;
  body: string;
}
export interface EvidenceReplyDelivery {
  /**
   * Posts the reply where this match already talks to its players, mentioning only its seated players, and
   * resolves with the Discord message ID. Rejects with ReplyDeliveryError (a readable reason) when it cannot.
   */
  deliver(input: ReplyDeliveryInput): Promise<{ messageId: string }>;
}

const GENERIC_FAILURE = 'Discord could not deliver this message.';

/** One delivery attempt for a 'pending' reply. Never throws for a Discord failure: the reply is kept, marked failed. */
export async function attemptReplyDelivery(store: EvidenceStore, delivery: EvidenceReplyDelivery, started: ReplyAttempt,
  actor: OpsActor): Promise<EvidenceReplyDto> {
  const { attempt, ...reply } = started;
  let outcome: { messageId: string } | { error: string };
  try {
    const sent = await delivery.deliver({ eventId: reply.eventId, matchId: reply.matchId, replyId: reply.id, body: reply.body });
    outcome = { messageId: sent.messageId };
  } catch (error) {
    // Only an error that chose its words is shown; anything else (a driver or HTTP message) is not.
    outcome = { error: error instanceof ReplyDeliveryError ? error.message : GENERIC_FAILURE };
  }
  // The post may already be out there: if recording the outcome fails once, try again before giving up (the Discord
  // nonce, derived from the reply ID, makes a repeated post idempotent in any case).
  try { return await store.finishReplyDelivery(reply.id, outcome, actor, attempt); }
  catch { return store.finishReplyDelivery(reply.id, outcome, actor, attempt); }
}

/** Discord's nonce (at most 25 characters), stable per reply: a retry within Discord's dedupe window returns the first message. */
export function replyNonce(replyId: string): string { return replyId.replace(/-/g, '').slice(0, 25); }

/** The demo has no Discord: every players reply counts as delivered, with a made-up message ID. */
export function demoReplyDelivery(): EvidenceReplyDelivery {
  let counter = 0;
  return { async deliver() { counter += 1; return { messageId: String(1_400_000_000_000_000_000n + BigInt(counter)) }; } };
}

/** What the bot posts in the match room. Mentions are an allow-list of the seated players: never everyone, never a role. */
export interface MatchRoomMessage {
  content: string;
  embeds: Array<{ description: string; color: number }>;
  allowedMentions: { parse: never[]; users: string[] };
}
export function matchReplyMessage(matchId: MatchId, userIds: readonly string[], body: string): MatchRoomMessage {
  const users = [...new Set(userIds)];
  return {
    content: `${users.map(id => `<@${id}>`).join(' ')} A message from the tournament staff about match ${matchId}:`,
    embeds: [{ description: body, color: 0x3b82f6 }],
    allowedMentions: { parse: [], users }
  };
}

/** A readable reason for a Discord API failure, never the raw driver message. */
export function describeDiscordFailure(error: unknown): string {
  const code = (error as { code?: number })?.code;
  if (code === 50001 || code === 50013) return 'The bot is not allowed to post in this match room. Check its channel permissions.';
  if (code === 10003) return 'The match room no longer exists.';
  if (code === 50007) return 'Discord blocked the message.';
  return GENERIC_FAILURE;
}

export interface ReplyDeliveryDeps {
  /** Discord is connected and the bot can send. */
  ready(): boolean;
  /** The Discord user IDs seated in this match; throws ReplyDeliveryError when this event has no live match room. */
  seatedPlayers(eventId: string, matchId: MatchId): Promise<string[]>;
  /**
   * Sends into the room where the match already talks to its players (its card's channel) and resolves the message ID.
   * `nonce` must go to Discord with enforceNonce, so a repeat of the same reply is not posted twice.
   */
  post(matchId: MatchId, message: MatchRoomMessage, nonce: string): Promise<string>;
}

/** The live delivery: posts to the match room through the bot, mentioning only the match's seated players. */
export function createReplyDelivery(deps: ReplyDeliveryDeps): EvidenceReplyDelivery {
  return {
    async deliver({ eventId, matchId, replyId, body }) {
      if (!deps.ready()) throw new ReplyDeliveryError('Discord is not connected. Try again when the bot is online.');
      const users = await deps.seatedPlayers(eventId, matchId);
      if (!users.length) throw new ReplyDeliveryError('This match has no seated players to message yet.');
      try { return { messageId: await deps.post(matchId, matchReplyMessage(matchId, users, body), replyNonce(replyId)) }; }
      catch (error) { throw new ReplyDeliveryError(describeDiscordFailure(error)); }
    }
  };
}
