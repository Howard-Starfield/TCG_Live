import { ChevronDown, Table2, Workflow } from 'lucide-react';
import { Avatar, Breadcrumb, ConnectionPill, ToggleTab, Tooltip, type BreadcrumbItem } from '../../ui';
import { useConsolePreferences } from '../../app/preferences';
import { AccountMenu, ThemeIcon } from './AccountMenu';
import { databasePill, discordPill, eventLabel, STAGE_LABEL } from './labels';
import { useShell } from './model';

/** Breadcrumb, preview toggles, runtime chips and the theme/account menu. */
export function TopBar() {
  const shell = useShell();
  const [preferences] = useConsolePreferences();
  const { viewed, dock } = shell;
  const source = viewed.summary ?? viewed.snapshot;

  const crumbs: BreadcrumbItem[] = [{
    id: 'root', label: 'TCG Live',
    ...(viewed.retired && shell.activeEventId ? { onSelect: shell.followActive } : {})
  }];
  if (source) crumbs.push({ id: 'event', label: eventLabel(source) });
  if (viewed.snapshot) crumbs.push({ id: 'stage', label: viewed.retired ? 'History' : STAGE_LABEL[viewed.snapshot.stage] });
  else if (viewed.waitingForDatabase) crumbs.push({ id: 'none', label: 'Waiting for the database' });
  else if (viewed.status === 'none') crumbs.push({ id: 'none', label: 'No active event' });

  const discord = discordPill(shell.status);
  const database = databasePill(shell.status);

  return (
    <header className="shell-topbar">
      <Breadcrumb items={crumbs} className="shell-crumbs" />
      <span aria-hidden className="shell-vsep" />
      <div role="group" aria-label="Previews" className="shell-toggles">
        <ToggleTab pressed={dock.visible.live} onPressedChange={() => dock.toggle('live')}
          icon={<Workflow />} shortcut={['Alt', '1']}>Live preview</ToggleTab>
        <ToggleTab pressed={dock.visible.list} onPressedChange={() => dock.toggle('list')}
          icon={<Table2 />} shortcut={['Alt', '2']}>List preview</ToggleTab>
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <Tooltip content={discord.description} placement="bottom">
          <span tabIndex={0} className="shell-pill-wrap">
            <ConnectionPill label="Discord" state={discord.state} detail={<span className="shell-pill-detail">{discord.detail}</span>} />
          </span>
        </Tooltip>
        <Tooltip content={database.description} placement="bottom">
          <span tabIndex={0} className="shell-pill-wrap">
            <ConnectionPill label="PostgreSQL" state={database.state} detail={<span className="shell-pill-detail">{database.detail}</span>} />
          </span>
        </Tooltip>
        <AccountMenu trigger={props => (
          <button type="button" {...props} aria-label={`Theme and account (${shell.session.principal.label})`} className="shell-menu-trigger">
            <span className="grid text-fg-muted [&_svg]:size-4"><ThemeIcon theme={preferences.theme} /></span>
            <Avatar src={null} name={shell.session.principal.label} size="sm" decorative />
            <ChevronDown aria-hidden className="size-3.5 text-fg-subtle" />
          </button>
        )} />
      </div>
    </header>
  );
}
