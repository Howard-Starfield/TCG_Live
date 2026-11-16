// One card per voice bot (main and each helper): status, room, health and the helper actions.
import { MODERATION_LIMITS as L, type VoiceBotErrorCode, type VoiceBotPoolDto, type VoiceBotRuntimeStatus, type VoiceBotStatusDto,
  type VoiceBotVerifyReportDto } from '@tcg-live/core';
import { Copy, KeyRound, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { Badge, Button, ConfirmDialog, Field, Input, StatusDot, Switch, cx } from '../../../ui';
import { describeError } from '../../evidence/api';
import { removeVoiceBot } from '../../moderation/api';
import { replaceVoiceBotToken, retryVoiceBot, updateVoiceBot, verifyVoiceBot } from './api';
import { VerifyReport } from './VerifyReport';

export const STATUS_TEXT: Record<VoiceBotRuntimeStatus, string> = {
  idle: 'Idle', 'logging-in': 'Logging in', ready: 'Ready', connecting: 'Connecting', connected: 'Connected',
  'login failed': 'Login failed: check the token', 'not in server': 'Not in the server: invite it', error: 'Error'
};
const STATUS_TONE: Partial<Record<VoiceBotRuntimeStatus, 'success' | 'warning' | 'danger'>> = {
  connected: 'success', ready: 'success', 'logging-in': 'warning', connecting: 'warning',
  'login failed': 'danger', 'not in server': 'danger', error: 'danger'
};
export const ERROR_TEXT: Record<VoiceBotErrorCode, string> = {
  'invalid-token': 'Discord refused the token', network: 'Discord could not be reached', timeout: 'Login timed out',
  'not-in-server': 'Not in the server', 'join-failed': 'Could not join a room', disconnected: 'Voice connection dropped',
  'missing-permissions': 'Missing permissions', 'rate-limited': 'Rate limited by Discord', unknown: 'Unknown error'
};

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function BotCard({ bot, channelIds, disabled, onPool, cardRef, highlightClass }: {
  bot: VoiceBotStatusDto; channelIds: string[]; disabled: boolean; onPool(pool: VoiceBotPoolDto): void;
  cardRef?: (el: HTMLElement | null) => void; highlightClass?: string;
}) {
  const { api } = useAdminData();
  const helper = bot.kind === 'helper';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [report, setReport] = useState<VoiceBotVerifyReportDto | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState('');
  const [nickname, setNickname] = useState(bot.nickname ?? '');
  const [removing, setRemoving] = useState(false);

  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true); setError(null); setMessage(null);
    try { await work(); } catch (cause) { setError(describeError(cause, fallback)); } finally { setBusy(false); }
  };
  const room = bot.assignedMatchId ? `${bot.assignedMatchId}${bot.assignedChannelId ? ` · #${bot.assignedChannelId}` : ''}` : 'Free';
  const enabled = bot.enabled !== false;
  const status = !enabled ? 'Disabled' : bot.status ? STATUS_TEXT[bot.status] ?? bot.status : bot.connected ? 'Connected' : 'Not connected';
  const nicknameError = nickname.trim().length > L.voiceBotNicknameLength ? `Up to ${L.voiceBotNicknameLength} characters.` : null;

  return <li ref={cardRef} className={cx('flex flex-col gap-2 rounded-lg bg-raised p-3 shadow-[inset_0_0_0_1px_var(--color-line)]', highlightClass)} data-bot={bot.id} aria-label={`Bot ${bot.label}`}>
    <div className="flex items-center gap-2">
      <StatusDot tone={!enabled ? 'neutral' : bot.status ? STATUS_TONE[bot.status] ?? 'neutral' : bot.connected ? 'success' : 'neutral'} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-fg">{bot.label}</span>
          {bot.nickname && <span className="truncate text-2xs text-fg-subtle">“{bot.nickname}”</span>}
          <Badge tone={helper ? 'neutral' : 'accent'}>{helper ? 'helper' : 'main bot'}</Badge>
        </span>
        <span className="block truncate text-2xs text-fg-subtle">{status} · {room}
          {bot.lastReadyAtMs ? ` · connected ${time(bot.lastReadyAtMs)}` : ''}
          {bot.lastErrorCode ? ` · ${ERROR_TEXT[bot.lastErrorCode] ?? bot.lastErrorCode}` : ''}</span>
      </span>
      {helper && <Switch aria-label={`Enable ${bot.label}`} checked={enabled} disabled={disabled || busy}
        onCheckedChange={value => { void run(async () => onPool(await updateVoiceBot(api, bot.id, { enabled: value })), 'The bot could not be changed.'); }} />}
    </div>
    {helper && <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="ghost" icon={<ShieldCheck aria-hidden />} disabled={disabled || busy}
        onClick={() => { void run(async () => setReport(await verifyVoiceBot(api, bot.id, channelIds.length ? channelIds : undefined)), 'The bot could not be verified.'); }}>Verify</Button>
      <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden />} disabled={disabled || busy}
        onClick={() => { void run(async () => { onPool(await retryVoiceBot(api, bot.id)); setMessage('Retrying now.'); }, 'Retry failed.'); }}>Retry</Button>
      <Button size="sm" variant="ghost" icon={<KeyRound aria-hidden />} disabled={disabled || busy} onClick={() => setReplacing(value => !value)}>Replace token</Button>
      {bot.inviteUrl && <Button size="sm" variant="ghost" icon={<Copy aria-hidden />} disabled={busy}
        onClick={() => { void navigator.clipboard?.writeText(bot.inviteUrl!).then(() => setMessage('Invite link copied.'), () => setMessage(bot.inviteUrl!)); }}>Copy invite link</Button>}
      <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden />} disabled={disabled || busy} onClick={() => setRemoving(true)}
        aria-label={`Remove ${bot.label}`}>Remove</Button>
    </div>}
    {helper && replacing && <form className="flex items-end gap-2" aria-label={`Replace token of ${bot.label}`} onSubmit={event => {
      event.preventDefault();
      const value = token.trim();
      setToken('');
      void run(async () => { onPool(await replaceVoiceBotToken(api, bot.id, { token: value })); setReplacing(false); setMessage('Token replaced.'); },
        'The token could not be replaced.');
    }}>
      <Field label="New token" description="The same helper application's reset token.">
        <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} />
      </Field>
      <Button type="submit" size="sm" variant="primary" disabled={!token || busy}>Save token</Button>
    </form>}
    {helper && <form className="flex items-end gap-2" aria-label={`Nickname of ${bot.label}`} onSubmit={event => {
      event.preventDefault();
      void run(async () => { onPool(await updateVoiceBot(api, bot.id, { nickname: nickname.trim() || null })); setMessage('Nickname saved.'); },
        'The nickname could not be saved.');
    }}>
      <Field label="Nickname in this server" error={nicknameError} description="Tells players which bot records them, for example TCG Recorder 2.">
        <Input value={nickname} placeholder="Keep the username" disabled={disabled || busy} onChange={event => setNickname(event.target.value)} />
      </Field>
      <Button type="submit" size="sm" variant="ghost" disabled={disabled || busy || !!nicknameError || nickname.trim() === (bot.nickname ?? '')}>Save nickname</Button>
    </form>}
    {report && <VerifyReport report={report} />}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {message && <p role="status" className="break-all text-xs text-fg-muted">{message}</p>}
    <ConfirmDialog open={removing} danger pending={busy} title={`Remove ${bot.label}?`} confirmLabel="Remove bot"
      description="Its token is deleted from this PC and its room pins are cleared. The room it covered is not monitored until another bot is free."
      onCancel={() => setRemoving(false)}
      onConfirm={() => { void run(async () => { onPool(await removeVoiceBot(api, bot.id)); setRemoving(false); }, 'The bot could not be removed.'); }} />
  </li>;
}
