// The Evidence drawer's item header: the selected item's ID with Copy, "Attach to case…" and "Moderate"
// for the match's players (and the recorded or submitting member). Case tools need admin tools + members.moderate.
import type { EventSnapshotDto, EvidenceItemDto, MatchId } from '@tcg-live/core';
import { memberName } from '../../../data';
import { CopyIdButton } from '../../lists/shared';
import { AttachToCaseButton } from './AttachToCase';
import { ModerateMembersMenu } from './ModerateMembersMenu';

const SNOWFLAKE = /^[1-9]\d{14,21}$/;

/** Members an evidence item concerns: the match's seated players, then the recorded or submitting member. */
export function evidenceMembers(snapshot: EventSnapshotDto, item: EvidenceItemDto, matchId: MatchId): Array<{ id: string; name: string }> {
  const match = snapshot.matches.find(entry => entry.id === matchId);
  const ids = [...(match ? match.seats.map(seat => snapshot.seats[seat] ?? null) : []), item.recordedUserId ?? null,
    SNOWFLAKE.test(item.submittedBy) ? item.submittedBy : null].filter((id): id is string => !!id);
  return [...new Set(ids)].map(id => ({ id, name: memberName(snapshot, id) }));
}

export function EvidenceCaseTools({ snapshot, item, matchId }: { snapshot: EventSnapshotDto; item: EvidenceItemDto; matchId: MatchId }) {
  const members = evidenceMembers(snapshot, item, matchId);
  return <div className="flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle" aria-label="Evidence ID and case tools" role="group">
    <span>ID</span>
    <span className="min-w-0 max-w-[16rem] truncate font-mono text-fg-muted" title={item.id}>{item.id}</span>
    <CopyIdButton value={item.id} what="evidence" />
    <span className="ml-auto flex items-center gap-1.5">
      <AttachToCaseButton evidenceId={item.id} members={members} eventId={snapshot.eventId} matchId={matchId} />
      <ModerateMembersMenu members={members} eventId={snapshot.eventId} matchId={matchId} evidenceIds={[item.id]} variant="button"
        label={`Moderate a member of ${matchId}`} />
    </span>
  </div>;
}
