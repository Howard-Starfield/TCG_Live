// Boundary for the List preview pane. L7 (web-lists) owns this folder and implements ListPreview;
// L6 (web-shell) hosts it. Keep these props stable.
import type { EventSnapshotDto } from '@tcg-live/core';

export type ListTab = 'players' | 'matches' | 'audit' | 'panels';

export interface ListPreviewProps {
  snapshot: EventSnapshotDto;
  /** Persisted in preferences by the shell (`listTab`). */
  tab: ListTab;
  onTabChange(tab: ListTab): void;
  /** Selecting a match row asks the shell to open that match in the Live preview. */
  onOpenMatch?(matchId: EventSnapshotDto['matches'][number]['id']): void;
  className?: string;
}

/** Wave 2 boundary stub; replaced by L7. Audit data comes from `useAudit(snapshot.eventId)` in `src/data`. */
export function ListPreview({ snapshot, className }: ListPreviewProps) {
  return <div className={className} data-testid="list-preview" data-event={snapshot.eventId} />;
}
