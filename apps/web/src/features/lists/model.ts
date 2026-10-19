// Pure derivations for the List preview tables (no React). Owned by L7 (web-lists).
import { SEATS, type AuditEntryDto, type EventSnapshotDto, type JudgeReason, type MatchDto, type MatchId,
  type MatchPhase, type Seat, type Snowflake, type StandingDto } from '@tcg-live/core';
import type { Tone } from '../../ui';
import { formatAuditEntry, memberName } from '../../data';

export interface StatusMeta { label: string; tone: Tone; live?: boolean }

// ---------------------------------------------------------------- players

/** `roster`: joined an open signup; `assigned`: seated by signup close; `seated`: legacy event seat. */
export type SignupState = 'roster' | 'assigned' | 'seated';

export interface PlayerRow {
  key: string;
  seat: Seat | null;
  memberId: Snowflake | null;
  /** 1-based join order in the signup roster. */
  rosterPosition: number | null;
  signup: SignupState;
  /** Null before seats exist (check-in is per seat). */
  checkedIn: boolean | null;
  match: MatchDto | null;
  standing: StandingDto | null;
  status: StatusMeta;
}

/** True once the event has seats (signup closed, or a legacy event). */
export function hasSeats(snapshot: EventSnapshotDto): boolean {
  if (snapshot.signup?.status === 'open') return false;
  return SEATS.some(seat => snapshot.seats[seat] !== null) || snapshot.signup === null;
}

export function matchOfSeat(snapshot: EventSnapshotDto, seat: Seat): MatchDto | null {
  return snapshot.matches.find(match => match.seats.includes(seat)) ?? null;
}

export function playerStatus(snapshot: EventSnapshotDto, seat: Seat, match: MatchDto | null): StatusMeta {
  if (!snapshot.published) {
    return snapshot.checkins.includes(seat)
      ? { label: 'Checked in', tone: 'success' }
      : { label: 'Not checked in', tone: 'warning' };
  }
  if (!match) return { label: 'No match', tone: 'neutral' };
  if (match.phase === 'final') {
    return match.finalWinner === seat ? { label: 'Won', tone: 'success' } : { label: 'Lost', tone: 'neutral' };
  }
  if (match.judge) return { label: 'Needs judge', tone: 'danger' };
  if (match.clock.state === 'interrupted') return { label: 'Clock interrupted', tone: 'warning' };
  switch (match.phase) {
    case 'running': return { label: 'Playing', tone: 'accent', live: true };
    case 'paused': return { label: 'Paused', tone: 'warning' };
    case 'expired': return { label: 'Time expired', tone: 'danger' };
    case 'setup': return match.ready.includes(seat) ? { label: 'Ready', tone: 'success' } : { label: 'Not ready', tone: 'neutral' };
  }
}

/** One row per seat once seats exist, otherwise one row per roster member in join order. */
export function playerRows(snapshot: EventSnapshotDto): PlayerRow[] {
  const roster = snapshot.signup?.roster ?? [];
  const position = (memberId: Snowflake | null) => {
    const index = memberId ? roster.indexOf(memberId) : -1;
    return index >= 0 ? index + 1 : null;
  };
  if (!hasSeats(snapshot)) {
    return roster.map((memberId, index) => ({
      key: `member-${memberId}`, seat: null, memberId, rosterPosition: index + 1, signup: 'roster' as const,
      checkedIn: null, match: null, standing: null, status: { label: 'Joined', tone: 'neutral' as const }
    }));
  }
  return SEATS.map(seat => {
    const memberId = snapshot.seats[seat];
    const match = matchOfSeat(snapshot, seat);
    return {
      key: `seat-${seat}`, seat, memberId, rosterPosition: position(memberId),
      signup: snapshot.signup ? 'assigned' as const : 'seated' as const,
      checkedIn: snapshot.checkins.includes(seat),
      match,
      standing: snapshot.standings.find(standing => standing.seat === seat) ?? null,
      status: memberId ? playerStatus(snapshot, seat, match) : { label: 'Open seat', tone: 'neutral' as const }
    };
  });
}

// ---------------------------------------------------------------- matches

export const PHASE_META: Record<MatchPhase, StatusMeta & { order: number }> = {
  setup: { label: 'Setup', tone: 'neutral', order: 0 },
  running: { label: 'Running', tone: 'accent', live: true, order: 1 },
  paused: { label: 'Paused', tone: 'warning', order: 2 },
  expired: { label: 'Expired', tone: 'danger', order: 3 },
  final: { label: 'Final', tone: 'success', order: 4 }
};

export const JUDGE_REASON_LABEL: Record<JudgeReason, string> = {
  dispute: 'Dispute', called: 'Judge called', expired: 'Time expired'
};

/** The phase chip for a match; an interrupted clock never shows as live. */
export function matchPhaseMeta(match: MatchDto): StatusMeta {
  const meta = PHASE_META[match.phase];
  if (match.clock.state === 'interrupted') return { label: meta.label, tone: 'warning' };
  return meta;
}

/** Matches whose judge attention is raised. */
export function judgeCount(snapshot: EventSnapshotDto): number {
  return snapshot.matches.filter(match => match.judge !== null).length;
}

// ---------------------------------------------------------------- audit

export type ActorKindFilter = 'all' | AuditEntryDto['actor']['kind'];
export type ViaFilter = 'all' | AuditEntryDto['via'];
export type MatchFilter = 'all' | 'none' | MatchId;

export interface AuditFilters {
  actor: ActorKindFilter;
  via: ViaFilter;
  match: MatchFilter;
  /** `all` or a command type such as `propose`. */
  type: string;
  query: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = { actor: 'all', via: 'all', match: 'all', type: 'all', query: '' };

export function hasActiveFilters(filters: AuditFilters): boolean {
  return filters.actor !== 'all' || filters.via !== 'all' || filters.match !== 'all' || filters.type !== 'all'
    || filters.query.trim() !== '';
}

/** Command types present in the loaded entries, sorted. */
export function commandTypes(entries: readonly AuditEntryDto[]): string[] {
  return [...new Set(entries.map(entry => entry.command.type))].sort();
}

/** Everything the free-text search looks at, lower-cased. */
export function auditSearchText(entry: AuditEntryDto, snapshot: EventSnapshotDto): string {
  const formatted = formatAuditEntry(entry, snapshot);
  const { command } = entry;
  return [
    `#${entry.sequence}`, String(entry.sequence), formatted.text, formatted.actorLabel, formatted.actorName,
    entry.via, entry.commandId, entry.principalId, entry.result, command.type, command.matchId, command.winner,
    command.reason, command.memberId, command.memberId ? memberName(snapshot, command.memberId) : null
  ].filter(Boolean).join('\n').toLowerCase();
}

/** Applies the filters and the text search (all terms must match). */
export function filterAudit(entries: readonly AuditEntryDto[], filters: AuditFilters, snapshot: EventSnapshotDto): AuditEntryDto[] {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    if (filters.actor !== 'all' && entry.actor.kind !== filters.actor) return false;
    if (filters.via !== 'all' && entry.via !== filters.via) return false;
    if (filters.match === 'none' && entry.command.matchId) return false;
    if (filters.match !== 'all' && filters.match !== 'none' && entry.command.matchId !== filters.match) return false;
    if (filters.type !== 'all' && entry.command.type !== filters.type) return false;
    if (terms.length === 0) return true;
    const text = auditSearchText(entry, snapshot);
    return terms.every(term => text.includes(term));
  });
}

/** Short command details beside the type: winner, revision, reason. */
export function commandDetails(entry: AuditEntryDto): string {
  const { command } = entry;
  const parts: string[] = [];
  if (command.winner) parts.push(`→ ${command.winner}`);
  if (command.revision !== undefined) parts.push(`rev ${command.revision}`);
  else if (command.expectedRevision !== undefined) parts.push(`exp rev ${command.expectedRevision}`);
  if (command.pauseGeneration !== undefined) parts.push(`pause ${command.pauseGeneration}`);
  if (command.reason) parts.push(`“${command.reason}”`);
  return parts.join(' · ');
}
