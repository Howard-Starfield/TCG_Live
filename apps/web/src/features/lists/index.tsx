// List preview pane (L7 web-lists): Players, Matches, Audit and Discord panels tables.
// L6 (web-shell) hosts it inside the preview dock. Keep the ListPreviewProps contract stable.
// Needs `AdminDataProvider` above it (audit and runtime status come from `src/data`).
import type { EventSnapshotDto } from '@tcg-live/core';
import { History, MessageSquare, Swords, Users } from 'lucide-react';
import { useId } from 'react';
import { CountBadge, TabPanel, TabStrip, cx, type TabItem } from '../../ui';
import { AuditTab } from './AuditTab';
import { MatchesTab } from './MatchesTab';
import { judgeCount, playerRows } from './model';
import { PanelsTab } from './PanelsTab';
import { PlayersTab } from './PlayersTab';

export type ListTab = 'players' | 'matches' | 'audit' | 'panels';

/** Tab order and labels. */
export const LIST_TABS: ReadonlyArray<{ value: ListTab; label: string }> = [
  { value: 'players', label: 'Players' },
  { value: 'matches', label: 'Matches' },
  { value: 'audit', label: 'Audit' },
  { value: 'panels', label: 'Discord' }
];

const ICONS: Record<ListTab, typeof Users> = { players: Users, matches: Swords, audit: History, panels: MessageSquare };

export interface ListPreviewProps {
  snapshot: EventSnapshotDto;
  /** Persisted in preferences by the shell (`listTab`). */
  tab: ListTab;
  onTabChange(tab: ListTab): void;
  /** Selecting a match row asks the shell to open that match in the Live preview. */
  onOpenMatch?(matchId: EventSnapshotDto['matches'][number]['id']): void;
  className?: string;
  /**
   * Render the tab strip inside the pane (default). Set false when the shell places `ListTabStrip`
   * in its own pane header; pass the same `idBase` to both.
   */
  showTabs?: boolean;
  /** Shared id prefix for tabs and the panel; generated when omitted. */
  idBase?: string;
}

export interface ListTabStripProps {
  snapshot: EventSnapshotDto;
  tab: ListTab;
  onTabChange(tab: ListTab): void;
  idBase: string;
  className?: string;
}

/** The four list tabs (arrow keys move and select). Exported so the shell may host it in a header. */
export function ListTabStrip({ snapshot, tab, onTabChange, idBase, className }: ListTabStripProps) {
  const judges = judgeCount(snapshot);
  const people = playerRows(snapshot).filter(row => row.memberId).length;
  const tabs: Array<TabItem<ListTab>> = LIST_TABS.map(({ value, label }) => {
    const Icon = ICONS[value];
    return {
      value,
      label: value === 'panels' ? <><span className="sr-only">Discord panels</span><span aria-hidden>{label}</span></> : label,
      icon: <Icon />,
      badge: value === 'players' && people > 0
        ? <span className="text-2xs font-normal text-fg-subtle tabular-nums"><span className="sr-only">, </span>{people}</span>
        : value === 'matches' && judges > 0
          ? <><span className="sr-only">, </span><CountBadge count={judges} tone="danger" label={`${judges} need a judge`} /></>
          : undefined
    };
  });
  return (
    <TabStrip<ListTab> label="List views" idBase={idBase} tabs={tabs} value={tab} onChange={onTabChange}
      className={cx('lists-tabs w-max rounded-[9px] bg-line-faint p-0.5', className)} />
  );
}

/** List preview: one table per tab, controlled by `tab` / `onTabChange`. */
export function ListPreview({ snapshot, tab, onTabChange, onOpenMatch, className, showTabs = true, idBase }: ListPreviewProps) {
  const generated = useId();
  const base = idBase ?? `lists${generated.replace(/:/g, '')}`;
  return (
    <div className={cx('lists-preview flex h-full min-h-0 min-w-0 flex-col gap-2', className)}
      data-testid="list-preview" data-event={snapshot.eventId}>
      {showTabs && (
        <div className="lists-tabbar shrink-0 overflow-x-auto px-2.5 pt-0.5">
          <ListTabStrip snapshot={snapshot} tab={tab} onTabChange={onTabChange} idBase={base} />
        </div>
      )}
      <TabPanel idBase={base} value={tab} className="flex min-h-0 min-w-0 flex-1 flex-col px-2.5 pb-2.5">
        {tab === 'players' && <PlayersTab snapshot={snapshot} />}
        {tab === 'matches' && <MatchesTab snapshot={snapshot} {...(onOpenMatch ? { onOpenMatch } : {})} />}
        {tab === 'audit' && <AuditTab key={snapshot.eventId} snapshot={snapshot} />}
        {tab === 'panels' && <PanelsTab snapshot={snapshot} />}
      </TabPanel>
    </div>
  );
}
