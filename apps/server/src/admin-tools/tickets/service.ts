// Ticket flows shared by the Discord feature (buttons) and the dashboard routes (close, reopen): open
// (idempotent per member), close (transcript, then delete the channel) and reopen within 24 h. Discord I/O
// goes through TicketGateway (live: live.ts, demo: demo.ts).
import type { BaseMessageOptions } from 'discord.js';
import type { OpsAuditKind, TicketDto, TicketSettingsDto } from '@tcg-live/core';
import type { OpsActor } from '../../ops/audit.js';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { discordErrorKind } from '../channels/sticky-engine.js';
import { ticketChannelName, ticketOverwrites, ticketWelcomeMessage, transcriptSummary, type OverwriteSpec } from './messages.js';
import type { TicketStore, TranscriptMessageInput } from './store.js';

export interface TicketGateway {
  botUserId(): string | null;
  everyoneRoleId(): string;
  /** The member's username, or null when they are not in the server. */
  member(userId: string): Promise<{ username: string } | null>;
  channelExists(channelId: string): Promise<boolean>;
  categoryExists(categoryId: string): Promise<boolean>;
  createChannel(spec: { name: string; categoryId: string; overwrites: OverwriteSpec[]; reason: string }): Promise<string>;
  send(channelId: string, message: BaseMessageOptions): Promise<string>;
  /** Oldest first. contentAvailable is false without the Message Content intent (others' text arrives empty). */
  fetchTranscript(channelId: string, max: number): Promise<{ messages: TranscriptMessageInput[]; contentAvailable: boolean }>;
  /** An already-deleted channel is not an error. */
  deleteChannel(channelId: string, reason: string): Promise<void>;
}

export interface TicketServiceDeps {
  guildId: string;
  store: TicketStore;
  gateway: TicketGateway;
  audit(kind: OpsAuditKind, payload: Record<string, unknown>, actor: OpsActor): Promise<unknown>;
  now(): number;
}

export type OpenTicketOutcome =
  | { kind: 'created'; ticket: TicketDto; channelId: string }
  | { kind: 'existing'; ticket: TicketDto; channelId: string }
  | { kind: 'pending' }
  | { kind: 'unavailable'; message: string };

/** Clicks being handled right now (duplicate clicks answer "being created"). */
const opening = new Set<string>();
/** Tickets being closed right now (a close is never run twice; channelDelete events from our own close are ignored). */
const closing = new Set<string>();
export const isTicketClosing = (ticketId: string) => closing.has(ticketId);

/** A ticket row without a channel this old is a failed earlier attempt, not a click in progress. */
const STALE_PENDING_MS = 60_000;
const TRANSCRIPT_MAX = 5_000;

const permissionHint = 'The bot needs Manage Channels and Manage Roles (to set the ticket permissions) in the ticket category.';
const player = (id: string): OpsActor => ({ kind: 'player', id });
const BOT: OpsActor = { kind: 'bot', id: 'bot' };

async function retire(deps: TicketServiceDeps, ticket: TicketDto, why: string): Promise<void> {
  const closed = await deps.store.close(deps.guildId, ticket.id, 'bot', 'deleted', []);
  if (closed) await deps.audit('ticket.deleted', { ticketId: ticket.id, number: ticket.number, openerId: ticket.openerId, reason: why }, BOT).catch(() => {});
}

export async function openTicket(deps: TicketServiceDeps, settings: TicketSettingsDto, user: { id: string; username: string }): Promise<OpenTicketOutcome> {
  if (!settings.enabled || !settings.categoryId) return { kind: 'unavailable', message: 'Tickets are turned off right now. Please contact the staff directly.' };
  const key = `${deps.guildId}:${user.id}`;
  if (opening.has(key)) return { kind: 'pending' };
  opening.add(key);
  try {
    if (!(await deps.gateway.categoryExists(settings.categoryId)))
      return { kind: 'unavailable', message: 'The ticket category is missing. Please tell the staff (they need to pick a category in the dashboard).' };
    const name = (number: number) => ticketChannelName(settings.namingPattern, user.username, number);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { ticket, created } = await deps.store.open(deps.guildId, user.id, name);
      if (!created) {
        if (ticket.channelId && await deps.gateway.channelExists(ticket.channelId)) return { kind: 'existing', ticket, channelId: ticket.channelId };
        if (!ticket.channelId && deps.now() - ticket.createdAtMs < STALE_PENDING_MS) return { kind: 'pending' };
        // Its channel was deleted outside the bot, or an earlier attempt failed: retire it and open a fresh one.
        await retire(deps, ticket, ticket.channelId ? 'channel-missing' : 'stale');
        continue;
      }
      let channelId: string;
      try {
        channelId = await deps.gateway.createChannel({ name: ticket.name, categoryId: settings.categoryId, reason: `Ticket #${ticket.number} for ${user.id}`,
          overwrites: ticketOverwrites({ everyoneRoleId: deps.gateway.everyoneRoleId(), openerId: user.id, staffRoleIds: settings.staffRoleIds,
            botUserId: deps.gateway.botUserId() }) });
      } catch (error) {
        await retire(deps, ticket, 'channel-create-failed');
        return { kind: 'unavailable', message: discordErrorKind(error) === 'missing-permissions'
          ? `The ticket could not be created. ${permissionHint}` : 'The ticket could not be created. Please try again in a moment.' };
      }
      await deps.store.setChannel(deps.guildId, ticket.id, channelId);
      await deps.gateway.send(channelId, ticketWelcomeMessage(ticket, settings.staffRoleIds)).catch(() => {});
      await deps.audit('ticket.opened', { ticketId: ticket.id, number: ticket.number, channelId, openerId: user.id }, player(user.id));
      return { kind: 'created', ticket: { ...ticket, channelId }, channelId };
    }
    return { kind: 'unavailable', message: 'The ticket could not be created. Please try again in a moment.' };
  } finally { opening.delete(key); }
}

export interface CloseTicketOutcome {
  ticket: TicketDto;
  contentAvailable: boolean;
  /** False when the channel could not be deleted (permissions): staff should delete it by hand. */
  channelDeleted: boolean;
  warning: string | null;
}

/** Saves the transcript, marks the ticket closed, then deletes its channel. Conflicts when not open. */
export async function closeTicket(deps: TicketServiceDeps, ticketId: string, actor: OpsActor): Promise<CloseTicketOutcome> {
  if (closing.has(ticketId)) throw new OpsConflictError('This ticket is already being closed.');
  closing.add(ticketId);
  try {
    const ticket = await deps.store.get(deps.guildId, ticketId);
    if (!ticket) throw new OpsNotFoundError('That ticket does not exist.');
    if (ticket.status !== 'open') throw new OpsConflictError('This ticket is already closed.');
    let transcript: { messages: TranscriptMessageInput[]; contentAvailable: boolean } = { messages: [], contentAvailable: false };
    const channelId = ticket.channelId;
    const live = channelId ? await deps.gateway.channelExists(channelId) : false;
    if (channelId && live) transcript = await deps.gateway.fetchTranscript(channelId, TRANSCRIPT_MAX);
    const closed = await deps.store.close(deps.guildId, ticket.id, actor.id, 'closed', transcript.messages);
    if (!closed) throw new OpsConflictError('This ticket is already closed.');
    let channelDeleted = !live;
    let warning: string | null = null;
    if (channelId && live) {
      try { await deps.gateway.deleteChannel(channelId, `Ticket #${ticket.number} closed`); channelDeleted = true; }
      catch (error) {
        warning = discordErrorKind(error) === 'missing-permissions'
          ? 'The transcript was saved, but the bot could not delete the channel (needs Manage Channels). Delete it by hand.'
          : 'The transcript was saved, but the channel could not be deleted. Delete it by hand.';
      }
    }
    if (channelDeleted) await deps.store.setChannel(deps.guildId, ticket.id, null);
    await deps.audit('ticket.closed', { ticketId: ticket.id, number: ticket.number, channelId, openerId: ticket.openerId,
      messages: transcript.messages.length, contentAvailable: transcript.contentAvailable, channelDeleted }, actor);
    return { ticket: { ...closed, channelId: channelDeleted ? null : channelId }, contentAvailable: transcript.contentAvailable, channelDeleted, warning };
  } finally { closing.delete(ticketId); }
}

/** Staff reopen from the dashboard (24 h window): recreates the channel and posts the transcript tail. */
export async function reopenTicket(deps: TicketServiceDeps, settings: TicketSettingsDto, ticketId: string, actor: OpsActor): Promise<TicketDto> {
  const ticket = await deps.store.get(deps.guildId, ticketId);
  if (!ticket) throw new OpsNotFoundError('That ticket does not exist.');
  if (ticket.status !== 'closed') throw new OpsConflictError('Only a closed ticket can be reopened.');
  if ((ticket.reopenableUntilMs ?? 0) <= deps.now()) throw new OpsConflictError('This ticket can no longer be reopened: the 24-hour window has passed.');
  if (!settings.categoryId || !(await deps.gateway.categoryExists(settings.categoryId)))
    throw new OpsInputError('Choose an existing ticket category in the ticket settings first.');
  if (!(await deps.gateway.member(ticket.openerId))) throw new OpsConflictError('The member who opened this ticket has left the server.');
  const reopened = await deps.store.reopen(deps.guildId, ticket.id);
  let channelId: string;
  try {
    channelId = await deps.gateway.createChannel({ name: ticket.name, categoryId: settings.categoryId, reason: `Ticket #${ticket.number} reopened`,
      overwrites: ticketOverwrites({ everyoneRoleId: deps.gateway.everyoneRoleId(), openerId: ticket.openerId, staffRoleIds: settings.staffRoleIds,
        botUserId: deps.gateway.botUserId() }) });
  } catch (error) {
    await deps.store.close(deps.guildId, ticket.id, actor.id, 'closed', []);
    if (discordErrorKind(error) === 'missing-permissions') throw new OpsInputError(`The ticket channel could not be created. ${permissionHint}`);
    throw new OpsInputError('The ticket channel could not be created. Try again in a moment.');
  }
  await deps.store.setChannel(deps.guildId, ticket.id, channelId);
  const transcript = await deps.store.transcript(deps.guildId, ticket.id);
  await deps.gateway.send(channelId, { content: transcriptSummary(ticket.number, transcript?.messages.slice(-20) ?? []), allowedMentions: { parse: [] } }).catch(() => {});
  await deps.gateway.send(channelId, ticketWelcomeMessage(ticket, settings.staffRoleIds, true)).catch(() => {});
  await deps.audit('ticket.reopened', { ticketId: ticket.id, number: ticket.number, channelId, openerId: ticket.openerId }, actor);
  return { ...reopened, channelId };
}

/** A ticket channel vanished (deleted by hand): the open ticket becomes 'deleted'. Our own closes are ignored. */
export async function ticketChannelDeleted(deps: TicketServiceDeps, channelId: string): Promise<boolean> {
  const ticket = await deps.store.byChannel(deps.guildId, channelId);
  if (!ticket || ticket.status !== 'open' || closing.has(ticket.id)) return false;
  const closed = await deps.store.close(deps.guildId, ticket.id, 'external', 'deleted', []);
  if (!closed) return false;
  await deps.store.setChannel(deps.guildId, ticket.id, null);
  await deps.audit('ticket.deleted', { ticketId: ticket.id, number: ticket.number, channelId, openerId: ticket.openerId, reason: 'channel-deleted' },
    { kind: 'system', id: 'discord' });
  return true;
}
