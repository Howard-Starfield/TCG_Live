// Shared pieces of the permission check: the grouped issue list, the "Grant missing permissions" link and
// the role-order note. Used by the Admin tools permission card and the setup wizard's Readiness step.
import type { PermissionIssueDto, PermissionScopeDto } from '@tcg-live/core';
import { ExternalLink } from 'lucide-react';
import { Badge, cx } from '../../ui';

export function scopeLabel(scope: PermissionScopeDto): string {
  return scope.kind === 'guild' ? 'Server-wide' : scope.kind === 'channel' ? `#${scope.name}` : `@${scope.name}`;
}

/** Issues grouped by feature, in the order the server sorted them (blocking first). */
export function groupIssues(issues: readonly PermissionIssueDto[]): Array<{ feature: string; issues: PermissionIssueDto[] }> {
  const groups = new Map<string, PermissionIssueDto[]>();
  for (const issue of issues) groups.set(issue.feature, [...groups.get(issue.feature) ?? [], issue]);
  return [...groups].map(([feature, list]) => ({ feature, issues: list }));
}

export function PermissionIssueList({ issues }: { issues: readonly PermissionIssueDto[] }) {
  return <div className="flex flex-col gap-3">
    {groupIssues(issues).map(group => <section key={group.feature} aria-label={group.feature} className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-fg">{group.feature}</h4>
      <ul className="flex flex-col gap-1.5">
        {group.issues.map((issue, index) => <li key={`${issue.featureId}:${scopeLabel(issue.scope)}:${index}`}
          data-severity={issue.severity} className="rounded-md bg-line-faint p-2 text-xs">
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge tone={issue.severity === 'blocking' ? 'danger' : 'warning'}>{issue.severity === 'blocking' ? 'Blocking' : 'Warning'}</Badge>
            <b className="font-medium text-fg">{issue.permission}</b>
            <span className="text-fg-subtle">· {scopeLabel(issue.scope)}</span>
          </p>
          <p className="mt-1 text-fg-muted">{issue.why}</p>
          <p className="mt-0.5 text-fg">{issue.fix}</p>
        </li>)}
      </ul>
    </section>)}
  </div>;
}

/**
 * Opens Discord's authorize page in a new tab. The admin presses Authorize there; the dashboard never
 * submits anything on their behalf.
 */
export function GrantPermissionsLink({ href, label = 'Grant missing permissions in Discord', variant = 'primary' }:
  { href: string; label?: string; variant?: 'primary' | 'secondary' }) {
  return <a href={href} target="_blank" rel="noopener noreferrer"
    className={cx('ui-press inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium [&_svg]:size-3.5',
      variant === 'primary' ? 'bg-accent-fill text-fg-on-accent hover:bg-accent-fill-hover' : 'bg-raised text-fg shadow-raised hover:bg-sunken')}>
    <ExternalLink aria-hidden />{label}<span className="sr-only"> (opens in a new tab)</span>
  </a>;
}

export const GRANT_EXPLANATION = 'Opens Discord in a new tab. Pick Authorize there yourself: re-authorizing updates the bot\'s own ' +
  'role with these permissions. It cannot undo a channel\'s own permission settings or change role order.';

/** Shown when any issue is about role order: the invite link cannot fix it. */
export function RoleOrderNote({ issues, botRoleName }: { issues: readonly PermissionIssueDto[]; botRoleName: string | null }) {
  const roles = [...new Set(issues.filter(issue => issue.kind === 'hierarchy' && issue.scope.kind === 'role' && /drag/i.test(issue.fix))
    .map(issue => issue.scope.kind === 'role' ? issue.scope.name : ''))];
  if (!roles.length) return null;
  return <p role="note" className="rounded-md border border-warning bg-warning-soft p-2 text-xs text-fg">
    <b>Role order:</b> drag {botRoleName ? <b>{botRoleName}</b> : 'the bot\'s role'} above {roles.map(name => `@${name}`).join(', ')} in
    Server Settings → Roles. The invite link cannot change role order, and integration-managed roles can never be given by a bot.
  </p>;
}
