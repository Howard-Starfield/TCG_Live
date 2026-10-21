// Display labels shared by the sidebar, top bar and console.
import type { EventSnapshotDto, EventSummaryDto, MatchDto, RuntimeStatusDto, Seat } from '@tcg-live/core';
import { memberName, type ConnectionState } from '../../data';
import type { ConnectionPillProps } from '../../ui';

type Stage = EventSnapshotDto['stage'];

export const STAGE_LABEL: Record<Stage, string> = {
  signup: 'Signup',
  checkin: 'Check-in',
  live: 'Round 1',
  complete: 'Standings'
};

const pad = (value: number) => String(value).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `14:05`, or `12 Oct 14:05` when not today. */
export function shortDateTime(timeMs: number, nowMs: number = Date.now()): string {
  const date = new Date(timeMs);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Date(nowMs).toDateString() === date.toDateString() ? time : `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

/** Events have no names; label them by kind and start time. */
export function eventLabel(event: Pick<EventSummaryDto, 'kind' | 'createdAtMs'>, nowMs?: number): string {
  return `${event.kind === 'signup' ? 'Signup session' : 'Session'} · ${shortDateTime(event.createdAtMs, nowMs)}`;
}

/** `Seat C · Cy Park`. */
export function seatWithName(snapshot: Pick<EventSnapshotDto, 'members' | 'seats'>, seat: Seat): string {
  const id = snapshot.seats[seat];
  return id ? `Seat ${seat} · ${memberName(snapshot, id)}` : `Seat ${seat}`;
}

/** Player name for a seat, or the seat label when unassigned. */
export function seatName(snapshot: Pick<EventSnapshotDto, 'members' | 'seats'>, seat: Seat): string {
  const id = snapshot.seats[seat];
  return id ? memberName(snapshot, id) : `Seat ${seat}`;
}

export function matchesNeedingJudge(snapshot: EventSnapshotDto): MatchDto[] {
  return snapshot.matches.filter(match => match.judge !== null);
}

export function hasInterruptedClock(snapshot: EventSnapshotDto | undefined): boolean {
  return !!snapshot?.matches.some(match => match.clock.state === 'interrupted');
}

type Pill = Pick<ConnectionPillProps, 'state'> & { detail: string; description: string };

/** Discord gateway chip. */
export function discordPill(status: RuntimeStatusDto | undefined): Pill {
  if (!status) return { state: 'connecting', detail: 'Checking', description: 'Waiting for the runtime status.' };
  switch (status.gateway) {
    case 'ready': return { state: 'connected', detail: 'Ready', description: 'The bot is connected to the Discord gateway.' };
    case 'connecting': return { state: 'connecting', detail: 'Connecting', description: 'The bot is logging in to Discord.' };
    case 'reconnecting': return { state: 'reconnecting', detail: 'Reconnecting', description: 'The Discord gateway dropped; the bot is reconnecting.' };
    case 'offline': return { state: 'offline', detail: 'Offline', description: 'The bot is not connected to Discord.' };
    case 'not_applicable':
      return status.mode === 'demo'
        ? { state: 'idle', detail: 'Demo', description: 'Demo mode: there is no Discord connection; a script plays the event.' }
        : { state: 'idle', detail: 'Not applicable', description: 'No Discord connection in this mode.' };
  }
}

/** PostgreSQL chip. */
export function databasePill(status: RuntimeStatusDto | undefined): Pill {
  if (!status) return { state: 'connecting', detail: 'Checking', description: 'Waiting for the runtime status.' };
  switch (status.database) {
    case 'ready': return { state: 'connected', detail: 'Ready', description: 'PostgreSQL is reachable.' };
    case 'unavailable': return { state: 'offline', detail: 'Unavailable', description: 'PostgreSQL cannot be reached; reads may fail or be stale.' };
    case 'not_configured':
      return status.mode === 'demo'
        ? { state: 'idle', detail: 'Demo', description: 'Demo mode keeps the event in memory; no database is used.' }
        : { state: 'idle', detail: 'Not configured', description: 'No database is configured.' };
  }
}

/** Stream connection wording for the sidebar footer. */
export function streamLabel(state: ConnectionState, retryInSeconds: number | null): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; live: boolean } {
  switch (state) {
    case 'live': return { text: 'Live updates', tone: 'success', live: true };
    case 'connecting': return { text: 'Connecting…', tone: 'warning', live: true };
    case 'reconnecting':
      return { text: retryInSeconds !== null && retryInSeconds > 0 ? `Reconnecting in ${retryInSeconds}s` : 'Reconnecting…', tone: 'warning', live: true };
    case 'offline': return { text: 'Offline', tone: 'danger', live: false };
    case 'signed-out': return { text: 'Not connected', tone: 'neutral', live: false };
  }
}
