import { ChevronRight, History, PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TournamentDirectoryEntryDto } from '@tcg-live/core';
import { useServerNow, useStreamConnection } from '../../data';
import { Avatar, Button, IconButton, Input, SidebarList, StatusDot, Tooltip, cx, type SidebarItem } from '../../ui';
import { useConsolePreferences } from '../../app/preferences';
import { AccountMenu } from './AccountMenu';
import { BrandMark } from './BrandMark';
import { eventLabel, shortDate, streamLabel } from './labels';
import { useShell } from './model';
import { CreateTournamentDialog } from '../tournaments/CreateTournamentDialog';
import { useTournamentDirectory } from '../tournaments/directory';

/** Events (active first, retired as history), stream status and the account. */
export function Sidebar() {
  const shell = useShell();
  const [preferences, update] = useConsolePreferences();
  const collapsed = preferences.sidebarCollapsed;
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const { events, viewed } = shell;
  const directoryEnabled = !!shell.session.tournaments;
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const serverQuery = collapsed ? '' : debouncedQuery;
  const directory = useTournamentDirectory(serverQuery, directoryEnabled);
  const pendingSearch = directoryEnabled && !collapsed && query.trim() !== debouncedQuery;
  const entries: TournamentDirectoryEntryDto[] = directoryEnabled
    ? directory.data?.entries ?? []
    : events.map(event => ({ ...event, name: eventLabel(event), game: null }));
  const matchesQuery = (event: TournamentDirectoryEntryDto) => collapsed || directoryEnabled ||
    `${event.name} ${event.kind} ${shortDate(event.createdAtMs)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const active = entries.filter(event => event.status !== 'retired' && matchesQuery(event));
  const retired = entries.filter(event => event.status === 'retired' && matchesQuery(event));
  const listState = directoryEnabled ? pendingSearch || directory.isPending ? 'loading' : directory.isError ? 'error' : 'ready'
    : shell.eventsState;
  const select = (eventId: string) => {
    const entry = entries.find(item => item.eventId === eventId);
    if (entry?.status === 'draft') shell.selectDraft(entry);
    else shell.selectEvent(eventId);
  };

  const activeItems: SidebarItem[] = active.map(event => ({
    id: event.eventId,
    label: event.name,
    meta: event.status === 'draft' ? `Draft · Created ${shortDate(event.createdAtMs)}` : `Created ${shortDate(event.createdAtMs)}`,
    live: event.status === 'active',
    active: event.status === 'draft' ? shell.draft?.eventId === event.eventId : viewed.eventId === event.eventId
  }));
  const retiredItems: SidebarItem[] = retired.map(event => ({
    id: event.eventId,
    label: event.name,
    meta: event.retiredAtMs ? `Retired ${shortDate(event.retiredAtMs)}` : `Created ${shortDate(event.createdAtMs)}`,
    icon: <History />,
    active: viewed.eventId === event.eventId
  }));

  return (
    <aside className="shell-sidebar" aria-label="Sidebar" data-collapsed={collapsed || undefined}>
      <div className="shell-sidebar-top">
        <BrandMark />
        {!collapsed && <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">TCG Live</span>}
        <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} describe={false} placement={collapsed ? 'right' : 'bottom'}>
          <IconButton aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}
            size="sm" icon={collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            onClick={() => update({ sidebarCollapsed: !collapsed })} />
        </Tooltip>
      </div>

      <div className={cx('shell-sidebar-tools', collapsed && 'is-collapsed')}>
        {!collapsed && <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input type="search" aria-label="Search tournaments" placeholder="Search tournaments" value={query}
            maxLength={120} onChange={event => setQuery(event.target.value)} className="h-8 pl-8 text-xs" />
        </div>}
        {directoryEnabled && <Tooltip content="Create signup tournament" describe={false} placement="right">
          <IconButton aria-label="Create signup tournament" size="sm" icon={<Plus aria-hidden />}
            onClick={() => setCreateOpen(true)} />
        </Tooltip>}
      </div>
      <div className="shell-sidebar-scroll">
        {listState === 'loading' && (
          <div aria-busy="true" aria-label="Loading events" className="flex flex-col gap-2 px-2 pt-2">
            <span className="shell-skeleton h-8" /><span className="shell-skeleton h-8 opacity-60" />
          </div>
        )}
        {listState === 'error' && (
          <div role="alert" className={cx('px-2 pt-2 text-xs text-fg-muted', collapsed && 'sr-only')}>
            <p>{directoryEnabled && directory.error instanceof Error
              ? directory.error.message : 'Tournaments could not be loaded.'}</p>
            <Button size="sm" variant="ghost" className="-ml-2 mt-1"
              onClick={() => { if (directoryEnabled) void directory.refetch(); else shell.refetchEvents(); }}>Try again</Button>
          </div>
        )}
        {listState === 'ready' && (
          <>
            {!collapsed && <button type="button" className="shell-sidebar-section-toggle" aria-expanded={liveOpen}
              aria-controls="sidebar-live" onClick={() => setLiveOpen(!liveOpen)}>
              <ChevronRight aria-hidden /> Live
            </button>}
            {(collapsed || liveOpen) && <div id="sidebar-live">
              {activeItems.length > 0
                ? <SidebarList label="Active event" collapsed={collapsed} items={activeItems} onSelect={select} />
                : !collapsed && <p className="px-2 pb-2 text-xs text-fg-subtle">
                  {query ? 'No matching live tournaments.' : 'No active event right now.'}
                </p>}
            </div>}
            {!collapsed && <button type="button" className="shell-sidebar-section-toggle mt-3" aria-expanded={historyOpen}
              aria-controls="sidebar-history" onClick={() => setHistoryOpen(!historyOpen)}>
              <ChevronRight aria-hidden /> History
            </button>}
            {(collapsed || historyOpen) && <div id="sidebar-history">
              {retiredItems.length > 0
                ? <SidebarList label="Event history" collapsed={collapsed} items={retiredItems} onSelect={select} />
                : !collapsed && query && <p className="px-2 pb-2 text-xs text-fg-subtle">No matching history.</p>}
            </div>}
          </>
        )}
      </div>
      {directoryEnabled && <CreateTournamentDialog open={createOpen} defaultGame={shell.directory?.defaultGame ?? 'one-piece'}
        onClose={() => setCreateOpen(false)} onSaved={entry => {
          setCreateOpen(false); setQuery(''); setDebouncedQuery(''); setLiveOpen(true); shell.selectDraft(entry);
        }} />}

      <div className="shell-sidebar-bottom">
        <StreamStatus collapsed={collapsed} />
        <AccountMenu placement="top-start" trigger={props => (
          <button type="button" {...props} className={cx('shell-account', collapsed && 'is-collapsed')}
            aria-label={collapsed ? `Account: ${shell.session.principal.label}` : undefined}>
            <Avatar src={null} name={shell.session.principal.label} size="lg" decorative />
            {!collapsed && (
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12.5px] font-medium text-fg">{shell.session.principal.label}</span>
                <span className="block truncate text-2xs text-fg-subtle">
                  {typeof window === 'undefined' ? '' : window.location.host}{shell.session.mode === 'demo' ? ' · demo' : ''}
                </span>
              </span>
            )}
          </button>
        )} />
      </div>
    </aside>
  );
}

/** Live stream state: live, connecting, reconnecting (with countdown) or offline. */
function StreamStatus({ collapsed }: { collapsed: boolean }) {
  const connection = useStreamConnection();
  useServerNow(connection.retryAtMs ? 1000 : null);   // re-render each second while a retry is scheduled
  const retryIn = connection.retryAtMs ? Math.max(0, Math.ceil((connection.retryAtMs - Date.now()) / 1000)) : null;
  const label = streamLabel(connection.state, retryIn);
  return (
    <div className={cx('shell-stream', collapsed && 'is-collapsed')} data-state={connection.state} title={collapsed ? label.text : undefined}>
      <StatusDot tone={label.tone} live={label.live} label={collapsed ? label.text : undefined} />
      {!collapsed && <span className="truncate">{label.text}</span>}
    </div>
  );
}
