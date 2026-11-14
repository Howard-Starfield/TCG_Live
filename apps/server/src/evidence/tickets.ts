// Short-lived playback tickets, kept in memory only. A <video> element cannot send a bearer token, so the
// ticket in the media URL is the credential: 32 random bytes, 15 minutes, and only while the session that
// asked for it is still signed in. The playback route audits evidence.viewed when a ticket is issued.
import { randomBytes } from 'node:crypto';
import { PLAYBACK_TICKET_TTL_MS, type PlaybackTicketDto } from '@tcg-live/core';
import type { EvidenceRecord } from './store.js';

export type TicketTarget = Pick<EvidenceRecord, 'id' | 'storagePath' | 'mime'>;
interface Ticket { target: TicketTarget; expiresAtMs: number; sessionLive: () => boolean }

export interface PlaybackTicketOptions { ttlMs?: number; now?: () => number; maxTickets?: number }

export class PlaybackTickets {
  private readonly tickets = new Map<string, Ticket>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxTickets: number;

  constructor(options: PlaybackTicketOptions = {}) {
    this.ttlMs = options.ttlMs ?? PLAYBACK_TICKET_TTL_MS;
    this.now = options.now ?? Date.now;
    this.maxTickets = options.maxTickets ?? 1_000;
  }

  get size(): number { return this.tickets.size; }

  issue(record: TicketTarget, sessionLive: () => boolean): PlaybackTicketDto {
    this.prune();
    while (this.tickets.size >= this.maxTickets) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + this.ttlMs;
    this.tickets.set(ticket, { target: { id: record.id, storagePath: record.storagePath, mime: record.mime }, expiresAtMs, sessionLive });
    return { url: `/api/v1/media/${ticket}`, expiresAtMs };
  }

  /** The ticket's target, or null when unknown, expired, or its session has ended (the ticket is then dropped). */
  resolve(ticket: string): TicketTarget | null {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    let live = false;
    try { live = entry.sessionLive(); } catch { live = false; }
    if (entry.expiresAtMs <= this.now() || !live) {
      this.tickets.delete(ticket);
      return null;
    }
    return { ...entry.target };
  }

  /** Drops every ticket for an evidence item (after a delete). */
  revoke(evidenceId: string): void {
    for (const [key, entry] of this.tickets) if (entry.target.id === evidenceId) this.tickets.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.tickets) if (entry.expiresAtMs <= now) this.tickets.delete(key);
  }
}
