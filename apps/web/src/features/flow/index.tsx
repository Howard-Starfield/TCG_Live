// Boundary for the Live preview pane. L5 (web-flow) owns this folder and implements LivePreview;
// L6 (web-shell) hosts it and wires getServerNow from L4's stream clock. Keep these props stable.
import type { EventSnapshotDto, MatchId } from '@tcg-live/core';

export type FlowView = 'event' | 'match';

export interface LivePreviewProps {
  snapshot: EventSnapshotDto;
  view: FlowView;
  /** The match shown in the Match view; null selects the first match needing attention, else M1. */
  matchId: MatchId | null;
  /** Clicking a match node in the Event view requests the Match view. */
  onViewChange(view: FlowView, matchId: MatchId | null): void;
  /** Server-corrected clock for countdowns; defaults to Date.now. */
  getServerNow?: () => number;
  className?: string;
}

/** Wave 0 boundary stub; replaced by L5. */
export function LivePreview({ snapshot, className }: LivePreviewProps) {
  return <div className={className} data-testid="live-preview" data-event={snapshot.eventId} />;
}
