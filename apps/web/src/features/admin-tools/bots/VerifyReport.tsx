// Token-free result of POST /moderation/voice-bots/:id/verify.
import type { VoiceBotVerifyReportDto } from '@tcg-live/core';
import { Badge } from '../../../ui';

export function VerifyReport({ report }: { report: VoiceBotVerifyReportDto }) {
  const ok = report.tokenValid && report.inServer && report.problems.length === 0;
  return <div role="status" aria-label="Verify report" className="flex flex-col gap-1.5 rounded-md bg-sunken p-2 text-xs">
    <p className="font-medium text-fg">{ok ? 'Ready: the helper can join every checked room.' : 'Needs attention'}</p>
    <ul className="flex flex-col gap-0.5 text-fg-muted">
      <li>Token: {report.tokenValid ? 'valid' : 'not accepted'}</li>
      <li>In the server: {report.inServer ? 'yes' : 'no'}</li>
      {report.nickname && <li>Nickname: {report.nickname}</li>}
    </ul>
    {report.channels.length > 0 && <ul aria-label="Room checks" className="flex flex-wrap gap-1">
      {report.channels.map(channel => <li key={channel.channelId}>
        <Badge tone={channel.state === 'ok' ? 'success' : channel.state === 'problem' ? 'danger' : 'neutral'}>
          #{channel.channelId}: {channel.state === 'ok' ? 'View + Connect' : channel.state === 'problem' ? 'missing View Channel or Connect' : 'unknown'}
        </Badge>
      </li>)}
    </ul>}
    {report.problems.map(text => <p key={text} className="text-danger">{text}</p>)}
    {report.warnings.map(text => <p key={text} className="text-warning">{text}</p>)}
    {report.inviteUrl && !report.inServer && <a className="text-accent underline" href={report.inviteUrl} target="_blank" rel="noreferrer">Open the invite link</a>}
  </div>;
}
