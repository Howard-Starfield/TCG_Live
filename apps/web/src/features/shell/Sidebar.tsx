import { History, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useServerNow, useStreamConnection } from '../../data';
import { Avatar, Button, IconButton, SidebarList, StatusDot, Tooltip, cx, type SidebarItem } from '../../ui';
import { useConsolePreferences } from '../../app/preferences';
import { AccountMenu } from './AccountMenu';
import { BrandMark } from './BrandMark';
import { eventLabel, shortDateTime, STAGE_LABEL, streamLabel } from './labels';
import { useShell } from './model';

/** Events (active first, retired as history), stream status and the account. */
export function Sidebar() {
  const shell = useShell();
  const [preferences, update] = useConsolePreferences();
  const collapsed = preferences.sidebarCollapsed;
  const now = useServerNow(60_000);
  const { events, viewed, activeEventId } = shell;

  const active = events.filter(event => event.status === 'active');
  const retired = events.filter(event => event.status === 'retired');
  const liveStage = viewed.snapshot && viewed.eventId === activeEventId ? STAGE_LABEL[viewed.snapshot.stage] : null;

  const activeItems: SidebarItem[] = active.map(event => ({
    id: event.eventId,
    label: eventLabel(event, now),
    meta: liveStage ? `${liveStage} · live` : 'Live',
    live: true,
    active: viewed.eventId === event.eventId
  }));
  const retiredItems: SidebarItem[] = retired.map(event => ({
    id: event.eventId,
    label: eventLabel(event, now),
    meta: event.retiredAtMs ? `Retired ${shortDateTime(event.retiredAtMs, now)}` : 'Retired',
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

      <div className="shell-sidebar-scroll">
        {shell.eventsState === 'loading' && (
          <div aria-busy="true" aria-label="Loading events" className="flex flex-col gap-2 px-2 pt-2">
            <span className="shell-skeleton h-8" /><span className="shell-skeleton h-8 opacity-60" />
          </div>
        )}
        {shell.eventsState === 'error' && (
          <div role="alert" className={cx('px-2 pt-2 text-xs text-fg-muted', collapsed && 'sr-only')}>
            <p>Events could not be loaded.</p>
            <Button size="sm" variant="ghost" className="-ml-2 mt-1" onClick={shell.refetchEvents}>Try again</Button>
          </div>
        )}
        {shell.eventsState === 'ready' && (
          <>
            {activeItems.length > 0
              ? <SidebarList label="Active event" heading="Live" collapsed={collapsed} items={activeItems} onSelect={shell.selectEvent} />
              : !collapsed && (
                <div>
                  <div className="px-2 pb-1 pt-1 text-2xs font-semibold tracking-wide text-fg-subtle">Live</div>
                  <p className="px-2 pb-2 text-xs text-fg-subtle">No active event right now.</p>
                </div>
              )}
            {retiredItems.length > 0 && (
              <SidebarList label="Event history" heading="History · read-only" collapsed={collapsed} items={retiredItems}
                onSelect={shell.selectEvent} className="mt-3" />
            )}
          </>
        )}
      </div>

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
