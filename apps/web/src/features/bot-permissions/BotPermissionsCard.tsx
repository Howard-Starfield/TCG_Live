// "Bot permissions" card (top of Admin tools → Settings): OK, or the enabled features' missing permissions
// grouped by feature, with the invite link that grants them, a Re-check button and the role-order note.
import type { PermissionReportDto } from '@tcg-live/core';
import { CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import { Badge, Button } from '../../ui';
import { describeError } from '../evidence/api';
import { usePermissionReport, useRecheckPermissions } from './api';
import { GRANT_EXPLANATION, GrantPermissionsLink, PermissionIssueList, RoleOrderNote } from './PermissionIssues';

function checkedAt(report: PermissionReportDto): string | null {
  if (report.checkedAtMs === null) return null;
  return new Date(report.checkedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function PermissionReportView({ report, onRecheck, rechecking }: { report: PermissionReportDto; onRecheck?: () => void; rechecking?: boolean }) {
  const blocking = report.issues.filter(issue => issue.severity === 'blocking').length;
  const warnings = report.issues.length - blocking;
  const fixableByInvite = report.issues.some(issue => issue.kind === 'permission');
  const time = checkedAt(report);
  return <div className="flex flex-col gap-3">
    {report.unavailable ? <p role="status" className="flex gap-2 text-xs text-fg-muted">
      <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />{report.unavailable}</p>
      : report.ok ? <p role="status" className="flex items-center gap-2 text-xs text-fg-muted">
        <CircleCheck aria-hidden className="size-3.5 text-success" />The bot has every permission your enabled features need.</p>
        : <p role="status" className="text-xs text-fg-muted">
          {blocking > 0 && <><b className="text-danger">{blocking} blocking</b>{warnings > 0 ? ', ' : ''}</>}
          {warnings > 0 && <b className="text-warning">{warnings} warning{warnings === 1 ? '' : 's'}</b>}
          {' '}for the features you use.</p>}
    {report.issues.length > 0 && <PermissionIssueList issues={report.issues} />}
    <RoleOrderNote issues={report.issues} botRoleName={report.botRoleName} />
    <div className="flex flex-wrap items-center gap-2">
      {report.inviteUrl && (fixableByInvite || report.unavailable) && <GrantPermissionsLink href={report.inviteUrl} />}
      {report.inviteUrlAll && report.inviteUrlAll !== report.inviteUrl &&
        <GrantPermissionsLink href={report.inviteUrlAll} label="Grant permissions for all features" variant="secondary" />}
      {onRecheck && <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={rechecking} onClick={onRecheck}>Re-check</Button>}
      {time && <span className="text-2xs text-fg-subtle">Checked {time}</span>}
    </div>
    {report.inviteUrl && <p className="text-2xs text-fg-subtle">{GRANT_EXPLANATION}</p>}
  </div>;
}

export function BotPermissionsCard() {
  const report = usePermissionReport();
  const recheck = useRecheckPermissions();
  const data = report.data;
  const blocking = data?.issues.filter(issue => issue.severity === 'blocking').length ?? 0;
  return <section aria-label="Bot permissions" className="flex flex-col gap-3 rounded-lg border border-line p-4">
    <header className="flex items-center gap-2">
      <h3 className="flex-1 text-[13px] font-semibold text-fg">Bot permissions</h3>
      {data && !data.unavailable && <Badge tone={data.ok ? 'success' : blocking ? 'danger' : 'warning'}>
        {data.ok ? 'OK' : blocking ? 'Needs attention' : 'Warnings'}</Badge>}
    </header>
    {data ? <PermissionReportView report={data} onRecheck={() => recheck.mutate()} rechecking={recheck.isPending} />
      : report.error ? <p role="status" className="text-xs text-danger">{describeError(report.error, 'The permission check could not be loaded.')}{' '}
        <Button size="sm" variant="ghost" onClick={() => { void report.refetch(); }}>Try again</Button></p>
        : <p role="status" className="text-xs text-fg-muted">Checking bot permissions…</p>}
    {recheck.error && <p role="status" className="text-xs text-danger">{describeError(recheck.error, 'Re-check failed.')}</p>}
  </section>;
}
