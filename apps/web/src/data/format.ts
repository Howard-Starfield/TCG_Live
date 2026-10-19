import type { AuditEntryDto, EventSnapshotDto, Seat, Snowflake } from '@tcg-live/core';

/** Visual tone of an audit line; the kit maps tones to colors. */
export type AuditTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

/** Icon key for an audit line; the shell maps keys to lucide icons. */
export type AuditIconKey = 'user-plus' | 'user-minus' | 'user-x' | 'lock' | 'unlock' | 'check-in'
  | 'megaphone' | 'ready' | 'pause' | 'gavel' | 'play' | 'timer' | 'flag' | 'check' | 'alert'
  | 'trophy' | 'pencil' | 'clock' | 'activity';

/** Snapshot fields used for naming; any snapshot (or null) works. */
export type AuditNameSource = Pick<EventSnapshotDto, 'members' | 'seats'> | null | undefined;

/** A rendered audit entry. */
export interface FormattedAuditEntry {
  /** Short actor label: `Seat C`, `Ava Chen`, `Admin`, `Timer`. */
  actorLabel: string;
  /** The actor's member display name when known (players and members), for tooltips and avatars. */
  actorName: string | null;
  /** The actor's member ID when known, for avatars. */
  actorMemberId: Snowflake | null;
  /** Full sentence, starting with the actor: `Seat C proposed Seat C won M2`. */
  text: string;
  tone: AuditTone;
  icon: AuditIconKey;
}

/** `Seat C`. */
export function seatLabel(seat: Seat): string {
  return `Seat ${seat}`;
}

/** A member's display name from the snapshot directory, falling back to a short ID. */
export function memberName(names: AuditNameSource, memberId: Snowflake | null | undefined): string {
  if (!memberId) return 'Unknown member';
  const name = names?.members[memberId]?.displayName;
  return name ?? `Member …${memberId.slice(-4)}`;
}

function seatMemberId(names: AuditNameSource, seat: Seat): Snowflake | null {
  return names?.seats[seat] ?? null;
}

const withReason = (text: string, reason: string | undefined) => (reason ? `${text} — ${reason}` : text);

/** Turns an audit entry into a display line, naming people from the snapshot's members and seats. */
export function formatAuditEntry(entry: AuditEntryDto, names?: AuditNameSource): FormattedAuditEntry {
  const { actor, command } = entry;
  let actorLabel: string;
  let actorMemberId: Snowflake | null = null;
  switch (actor.kind) {
    case 'player':
      actorLabel = seatLabel(actor.seat);
      actorMemberId = seatMemberId(names, actor.seat);
      break;
    case 'member':
      actorMemberId = actor.memberId;
      actorLabel = memberName(names, actor.memberId);
      break;
    case 'admin':
      actorLabel = 'Admin';
      break;
    case 'system':
      actorLabel = 'Timer';
      break;
  }
  const actorName = actorMemberId ? (names?.members[actorMemberId]?.displayName ?? null) : null;
  const match = command.matchId ?? 'the match';
  const winner = command.winner ? seatLabel(command.winner) : 'a seat';
  const line = (text: string, tone: AuditTone, icon: AuditIconKey): FormattedAuditEntry =>
    ({ actorLabel, actorName, actorMemberId, text, tone, icon });

  switch (command.type) {
    case 'signupJoin': return line(`${actorLabel} joined signup`, 'neutral', 'user-plus');
    case 'signupWithdraw': return line(`${actorLabel} left signup`, 'neutral', 'user-minus');
    case 'signupRemove':
      return line(withReason(`${actorLabel} removed ${memberName(names, command.memberId)} from signup`, command.reason),
        'warning', 'user-x');
    case 'signupClose': return line(`${actorLabel} closed signup and assigned seats`, 'info', 'lock');
    case 'signupReopen': return line(`${actorLabel} reopened signup`, 'info', 'unlock');
    case 'checkin': return line(`${actorLabel} checked in`, 'success', 'check-in');
    case 'publish': return line(`${actorLabel} published the round`, 'accent', 'megaphone');
    case 'ready': return line(`${actorLabel} is ready for ${match}`, 'neutral', 'ready');
    case 'pause': return line(`${actorLabel} paused ${match}`, 'warning', 'pause');
    case 'callJudge': return line(`${actorLabel} called a judge on ${match}`, 'danger', 'gavel');
    case 'resumeConsent': return line(`${actorLabel} agreed to resume ${match}`, 'neutral', 'play');
    case 'judgeResume': return line(withReason(`${actorLabel} resumed ${match}`, command.reason), 'info', 'play');
    case 'clockCheck':
      return actor.kind === 'system'
        ? line(`Timer expired ${match}`, 'danger', 'timer')
        : line(`${actorLabel} checked the clock on ${match}`, 'neutral', 'clock');
    case 'propose': return line(`${actorLabel} proposed ${winner} won ${match}`, 'neutral', 'flag');
    case 'confirm': return line(`${actorLabel} confirmed the result of ${match}`, 'success', 'check');
    case 'dispute': return line(`${actorLabel} disputed the result of ${match}`, 'danger', 'alert');
    case 'resolve':
      return line(withReason(`${actorLabel} resolved ${match} for ${winner}`, command.reason), 'success', 'trophy');
    case 'correct':
      return line(withReason(`${actorLabel} corrected ${match} to ${winner}`, command.reason), 'warning', 'pencil');
    default:
      return line(`${actorLabel} applied ${command.type}${command.matchId ? ` on ${command.matchId}` : ''}`,
        'neutral', 'activity');
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact relative time: `just now`, `45s ago`, `5m ago`, `2h ago`, `3d ago`, or `in 5m` for the future. */
export function formatRelativeTime(timeMs: number, nowMs: number): string {
  const delta = nowMs - timeMs;
  const abs = Math.abs(delta);
  if (abs < 5 * SECOND) return 'just now';
  let amount: string;
  if (abs < MINUTE) amount = `${Math.floor(abs / SECOND)}s`;
  else if (abs < HOUR) amount = `${Math.floor(abs / MINUTE)}m`;
  else if (abs < DAY) amount = `${Math.floor(abs / HOUR)}h`;
  else amount = `${Math.floor(abs / DAY)}d`;
  return delta >= 0 ? `${amount} ago` : `in ${amount}`;
}

/** Elapsed duration as `m:ss` or `h:mm:ss`, for "waiting 3:05" labels. */
export function formatElapsed(fromMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** Local wall-clock time `HH:MM:SS` (24 h), for audit timestamps. */
export function formatTimeOfDay(timeMs: number): string {
  const date = new Date(timeMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

/** Time until the next change of `formatRelativeTime` output, for scheduling re-renders. */
export function relativeTimeRefreshMs(timeMs: number, nowMs: number): number {
  const abs = Math.abs(nowMs - timeMs);
  if (abs < MINUTE) return SECOND;
  if (abs < HOUR) return MINUTE - (abs % MINUTE);
  return HOUR - (abs % HOUR);
}
