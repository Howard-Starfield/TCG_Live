// Tickets (tcg_tickets, tcg_ticket_messages): numbered per guild with allocateAdminCounter('ticket'), one
// open ticket per member (unique index), transcripts saved at close, reopen within 24 h.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ADMIN_TOOLS_LIMITS as L, type TicketDto, type TicketPageDto, type TicketStatus, type TranscriptAttachmentDto,
  type TranscriptDto, type TranscriptMessageDto } from '@tcg-live/core';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { SNOWFLAKE, UUID } from '../../ops/http.js';
import { transaction, withClient } from '../../rehearsal/store.js';
import { allocateAdminCounter, MemoryAdminCounters, requireAdminToolsSchema } from '../schema.js';

export type TranscriptMessageInput = Omit<TranscriptMessageDto, 'seq'>;
export interface OpenTicketResult { ticket: TicketDto; created: boolean }
export interface TicketListQuery { status?: TicketStatus | null; before?: number | null; limit?: number }

export interface TicketStore {
  /** Idempotent per member: returns the member's open ticket (created false) or a new numbered one. */
  open(guildId: string, openerId: string, name: (number: number) => string): Promise<OpenTicketResult>;
  setChannel(guildId: string, id: string, channelId: string | null): Promise<void>;
  get(guildId: string, id: string): Promise<TicketDto | null>;
  byChannel(guildId: string, channelId: string): Promise<TicketDto | null>;
  /** Newest first by number; `before` is a ticket number cursor. */
  list(guildId: string, query?: TicketListQuery): Promise<TicketPageDto>;
  /** Closes an open ticket and appends its transcript. Null when it was not open (already closed). */
  close(guildId: string, id: string, closedBy: string, status: 'closed' | 'deleted', messages: readonly TranscriptMessageInput[]): Promise<TicketDto | null>;
  /** Reopens a closed ticket inside the window; conflicts when expired or the member has another open ticket. */
  reopen(guildId: string, id: string): Promise<TicketDto>;
  transcript(guildId: string, id: string): Promise<TranscriptDto | null>;
  /** Deletes closed/deleted tickets (and transcripts) closed before the cutoff; returns how many. */
  purgeClosedBefore(guildId: string, cutoffMs: number): Promise<number>;
}

export const TICKET_PAGE_LIMIT = 100;
const notFound = () => new OpsNotFoundError('That ticket does not exist.');
const checkGuild = (guildId: string) => { if (!SNOWFLAKE.test(guildId)) throw new OpsInputError('The Discord server is not configured.'); };
const expired = () => new OpsConflictError('This ticket can no longer be reopened: the 24-hour window has passed.');
const notClosed = () => new OpsConflictError('Only a closed ticket can be reopened.');
const busy = () => new OpsConflictError('The member already has another open ticket.');

export function reopenableUntil(status: TicketStatus, closedAtMs: number | null): number | null {
  return status === 'closed' && closedAtMs !== null ? closedAtMs + L.ticketReopenWindowMs : null;
}
function limitOf(query: TicketListQuery): number {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TICKET_PAGE_LIMIT) throw new OpsInputError(`limit must be 1-${TICKET_PAGE_LIMIT}.`);
  return limit;
}
/** Fits a message into the transcript table's limits. */
export function clampTranscriptMessage(message: TranscriptMessageInput): TranscriptMessageInput {
  return { ...message, authorName: [...message.authorName].slice(0, 100).join('') || 'unknown',
    content: [...message.content].slice(0, 4000).join(''),
    attachments: message.attachments.slice(0, 10).map(item => ({ name: item.name.slice(0, 200), url: item.url.slice(0, L.urlLength), size: item.size })) };
}

interface Row { id: string; guild_id: string; number: number; opener_id: string; name: string; channel_id: string | null; status: TicketStatus;
  created_at_ms: string; closed_at_ms: string | null; closed_by: string | null; message_count: number }
const COLUMNS = `t.id::text AS id, t.guild_id, t.number, t.opener_id, t.name, t.channel_id, t.status, t.created_at_ms, t.closed_at_ms, t.closed_by,
  (SELECT count(*)::int FROM public.tcg_ticket_messages m WHERE m.ticket_id = t.id) AS message_count`;
const fromRow = (row: Row): TicketDto => {
  const closedAtMs = row.closed_at_ms === null ? null : Number(row.closed_at_ms);
  return { id: row.id, guildId: row.guild_id, number: row.number, openerId: row.opener_id, name: row.name, channelId: row.channel_id,
    status: row.status, createdAtMs: Number(row.created_at_ms), closedAtMs, closedBy: row.closed_by,
    reopenableUntilMs: reopenableUntil(row.status, closedAtMs), messageCount: row.message_count };
};

export function pgTicketStore(now: () => number = Date.now): TicketStore {
  const run = <T>(operation: (client: pg.Client) => Promise<T>) =>
    withClient(async client => { await requireAdminToolsSchema(client); return operation(client); });
  const select = async (client: pg.Client, where: string, values: unknown[]) =>
    (await client.query<Row>(`SELECT ${COLUMNS} FROM public.tcg_tickets t WHERE ${where}`, values)).rows.map(fromRow);
  return {
    async open(guildId, openerId, name) {
      checkGuild(guildId);
      if (!SNOWFLAKE.test(openerId)) throw new OpsInputError('Invalid member.');
      return run(async client => {
        const attempt = () => transaction(client, async () => {
          const existing = (await select(client, "t.guild_id = $1 AND t.opener_id = $2 AND t.status = 'open'", [guildId, openerId]))[0];
          if (existing) return { ticket: existing, created: false };
          const number = await allocateAdminCounter(client, guildId, 'ticket');
          const id = randomUUID();
          await client.query(`INSERT INTO public.tcg_tickets (id, guild_id, number, opener_id, name, channel_id, status, created_at_ms)
            VALUES ($1, $2, $3, $4, $5, NULL, 'open', $6)`, [id, guildId, number, openerId, name(number).slice(0, 100), now()]);
          return { ticket: (await select(client, 't.id = $1', [id]))[0]!, created: true };
        });
        try { return await attempt(); }
        catch (error) {
          // A concurrent click won the one-open-ticket index: answer with that ticket (the counter rolled back too).
          if ((error as { code?: string }).code !== '23505') throw error;
          const existing = (await select(client, "t.guild_id = $1 AND t.opener_id = $2 AND t.status = 'open'", [guildId, openerId]))[0];
          if (!existing) throw error;
          return { ticket: existing, created: false };
        }
      });
    },
    async setChannel(guildId, id, channelId) {
      checkGuild(guildId);
      if (!UUID.test(id)) throw notFound();
      await run(client => client.query('UPDATE public.tcg_tickets SET channel_id = $3 WHERE guild_id = $1 AND id = $2', [guildId, id, channelId]));
    },
    async get(guildId, id) {
      checkGuild(guildId);
      if (!UUID.test(id)) return null;
      return run(async client => (await select(client, 't.guild_id = $1 AND t.id = $2', [guildId, id]))[0] ?? null);
    },
    async byChannel(guildId, channelId) {
      checkGuild(guildId);
      if (!SNOWFLAKE.test(channelId)) return null;
      return run(async client => (await select(client, "t.guild_id = $1 AND t.channel_id = $2 ORDER BY t.status = 'open' DESC, t.number DESC LIMIT 1", [guildId, channelId]))[0] ?? null);
    },
    async list(guildId, query = {}) {
      checkGuild(guildId);
      const limit = limitOf(query);
      return run(async client => {
        const rows = await select(client, `t.guild_id = $1 AND ($2::text IS NULL OR t.status = $2) AND ($3::int IS NULL OR t.number < $3)
          ORDER BY t.number DESC LIMIT $4`, [guildId, query.status ?? null, query.before ?? null, limit + 1]);
        const tickets = rows.slice(0, limit);
        return { tickets, nextBefore: rows.length > limit ? tickets.at(-1)!.number : null };
      });
    },
    async close(guildId, id, closedBy, status, messages) {
      checkGuild(guildId);
      if (!UUID.test(id)) throw notFound();
      return run(client => transaction(client, async () => {
        const updated = await client.query<{ id: string }>(`UPDATE public.tcg_tickets SET status = $3, closed_at_ms = $4, closed_by = $5
          WHERE guild_id = $1 AND id = $2 AND status = 'open' RETURNING id`, [guildId, id, status, now(), closedBy.slice(0, 64)]);
        if (!updated.rows[0]) return null;
        const start = (await client.query<{ seq: number }>('SELECT coalesce(max(seq), 0)::int AS seq FROM public.tcg_ticket_messages WHERE ticket_id = $1', [id])).rows[0]!.seq;
        const batch = messages.slice(0, L.transcriptMessages).map(clampTranscriptMessage);
        for (let index = 0; index < batch.length; index += 200) {
          const chunk = batch.slice(index, index + 200);
          const values: unknown[] = [];
          const tuples = chunk.map((message, offset) => {
            values.push(id, start + index + offset + 1, message.messageId, message.authorId, message.authorName, message.authorBot, message.content,
              JSON.stringify(message.attachments), message.createdAtMs);
            const base = offset * 9;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9})`;
          });
          await client.query(`INSERT INTO public.tcg_ticket_messages (ticket_id, seq, message_id, author_id, author_name, author_bot, content, attachments,
            created_at_ms) VALUES ${tuples.join(', ')}`, values);
        }
        return (await select(client, 't.id = $1', [id]))[0]!;
      }));
    },
    async reopen(guildId, id) {
      checkGuild(guildId);
      if (!UUID.test(id)) throw notFound();
      return run(client => transaction(client, async () => {
        const ticket = (await select(client, 't.guild_id = $1 AND t.id = $2 FOR UPDATE OF t', [guildId, id]))[0];
        if (!ticket) throw notFound();
        if (ticket.status !== 'closed') throw notClosed();
        if ((ticket.reopenableUntilMs ?? 0) <= now()) throw expired();
        try {
          await client.query("UPDATE public.tcg_tickets SET status = 'open', closed_at_ms = NULL, closed_by = NULL, channel_id = NULL WHERE id = $1", [id]);
        } catch (error) { if ((error as { code?: string }).code === '23505') throw busy(); throw error; }
        return (await select(client, 't.id = $1', [id]))[0]!;
      }));
    },
    async transcript(guildId, id) {
      checkGuild(guildId);
      if (!UUID.test(id)) return null;
      return run(async client => {
        const ticket = (await select(client, 't.guild_id = $1 AND t.id = $2', [guildId, id]))[0];
        if (!ticket) return null;
        const rows = await client.query<{ seq: number; message_id: string; author_id: string; author_name: string; author_bot: boolean; content: string;
          attachments: TranscriptAttachmentDto[]; created_at_ms: string }>(
          'SELECT seq, message_id, author_id, author_name, author_bot, content, attachments, created_at_ms FROM public.tcg_ticket_messages WHERE ticket_id = $1 ORDER BY seq', [id]);
        return { ticket, messages: rows.rows.map(row => ({ seq: row.seq, messageId: row.message_id, authorId: row.author_id, authorName: row.author_name,
          authorBot: row.author_bot, content: row.content, attachments: row.attachments, createdAtMs: Number(row.created_at_ms) })) };
      });
    },
    async purgeClosedBefore(guildId, cutoffMs) {
      checkGuild(guildId);
      return run(async client => (await client.query(`DELETE FROM public.tcg_tickets WHERE guild_id = $1 AND status <> 'open' AND closed_at_ms < $2`,
        [guildId, cutoffMs])).rowCount ?? 0);
    }
  };
}

interface MemoryTicket { ticket: Omit<TicketDto, 'messageCount' | 'reopenableUntilMs'>; messages: TranscriptMessageDto[] }

export class MemoryTicketStore implements TicketStore {
  private readonly rows = new Map<string, MemoryTicket>();
  private readonly counters = new MemoryAdminCounters();
  constructor(private readonly now: () => number = Date.now) {}

  private view(row: MemoryTicket): TicketDto {
    return structuredClone({ ...row.ticket, reopenableUntilMs: reopenableUntil(row.ticket.status, row.ticket.closedAtMs), messageCount: row.messages.length });
  }
  private find(guildId: string, id: string): MemoryTicket | undefined {
    const row = this.rows.get(id.toLowerCase());
    return row && row.ticket.guildId === guildId ? row : undefined;
  }
  async open(guildId: string, openerId: string, name: (number: number) => string) {
    checkGuild(guildId);
    if (!SNOWFLAKE.test(openerId)) throw new OpsInputError('Invalid member.');
    const existing = [...this.rows.values()].find(row => row.ticket.guildId === guildId && row.ticket.openerId === openerId && row.ticket.status === 'open');
    if (existing) return { ticket: this.view(existing), created: false };
    const number = this.counters.next(guildId, 'ticket');
    const row: MemoryTicket = { ticket: { id: randomUUID(), guildId, number, openerId, name: name(number).slice(0, 100), channelId: null, status: 'open',
      createdAtMs: this.now(), closedAtMs: null, closedBy: null }, messages: [] };
    this.rows.set(row.ticket.id, row);
    return { ticket: this.view(row), created: true };
  }
  async setChannel(guildId: string, id: string, channelId: string | null) {
    const row = this.find(guildId, id);
    if (!row) throw notFound();
    row.ticket.channelId = channelId;
  }
  async get(guildId: string, id: string) { const row = this.find(guildId, id); return row ? this.view(row) : null; }
  async byChannel(guildId: string, channelId: string) {
    const rows = [...this.rows.values()].filter(row => row.ticket.guildId === guildId && row.ticket.channelId === channelId)
      .sort((a, b) => Number(b.ticket.status === 'open') - Number(a.ticket.status === 'open') || b.ticket.number - a.ticket.number);
    return rows[0] ? this.view(rows[0]) : null;
  }
  async list(guildId: string, query: TicketListQuery = {}) {
    checkGuild(guildId);
    const limit = limitOf(query);
    const rows = [...this.rows.values()].filter(row => row.ticket.guildId === guildId && (!query.status || row.ticket.status === query.status)
      && (query.before == null || row.ticket.number < query.before)).sort((a, b) => b.ticket.number - a.ticket.number);
    const tickets = rows.slice(0, limit).map(row => this.view(row));
    return { tickets, nextBefore: rows.length > limit ? tickets.at(-1)!.number : null };
  }
  async close(guildId: string, id: string, closedBy: string, status: 'closed' | 'deleted', messages: readonly TranscriptMessageInput[]) {
    const row = this.find(guildId, id);
    if (!row) throw notFound();
    if (row.ticket.status !== 'open') return null;
    Object.assign(row.ticket, { status, closedAtMs: this.now(), closedBy: closedBy.slice(0, 64) });
    const start = row.messages.length;
    row.messages.push(...messages.slice(0, L.transcriptMessages).map((message, index) => ({ ...clampTranscriptMessage(message), seq: start + index + 1 })));
    return this.view(row);
  }
  async reopen(guildId: string, id: string) {
    const row = this.find(guildId, id);
    if (!row) throw notFound();
    if (row.ticket.status !== 'closed') throw notClosed();
    if ((reopenableUntil(row.ticket.status, row.ticket.closedAtMs) ?? 0) <= this.now()) throw expired();
    if ([...this.rows.values()].some(other => other !== row && other.ticket.guildId === guildId && other.ticket.openerId === row.ticket.openerId && other.ticket.status === 'open'))
      throw busy();
    Object.assign(row.ticket, { status: 'open', closedAtMs: null, closedBy: null, channelId: null });
    return this.view(row);
  }
  async transcript(guildId: string, id: string) {
    const row = this.find(guildId, id);
    return row ? { ticket: this.view(row), messages: structuredClone(row.messages) } : null;
  }
  async purgeClosedBefore(guildId: string, cutoffMs: number) {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.ticket.guildId === guildId && row.ticket.status !== 'open' && (row.ticket.closedAtMs ?? Infinity) < cutoffMs) { this.rows.delete(id); removed += 1; }
    }
    return removed;
  }
}
