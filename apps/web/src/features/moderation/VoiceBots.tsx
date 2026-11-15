// Voice bot pool. A Discord bot can be in one voice room per server at a time, so each helper bot
// token adds one more room that can be monitored at once. Tokens are typed by the admin, sent once,
// and never shown again: the server stores them only in data/voice-bots.json and never returns them.
import { MODERATION_LIMITS as L, type VoiceBotPoolDto, type VoiceBotRuntimeStatus, type VoiceBotStatusDto,
  type VoiceRoomStatus } from '@tcg-live/core';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAdminData } from '../../data';
import { Badge, Button, ConfirmDialog, Field, Input, StatusDot } from '../../ui';
import { describeError, isNotAvailable } from '../evidence/api';
import { addVoiceBot, getVoiceBots, removeVoiceBot } from './api';

const STATUS_TEXT: Record<VoiceBotRuntimeStatus, string> = {
  idle: 'Idle', 'logging-in': 'Logging in', ready: 'Ready', connecting: 'Connecting', connected: 'Connected',
  'login failed': 'Login failed: check the token', 'not in server': 'Not in the server: invite it', error: 'Error'
};
const STATUS_TONE: Partial<Record<VoiceBotRuntimeStatus, 'success' | 'warning' | 'danger'>> = {
  connected: 'success', ready: 'success', 'logging-in': 'warning', connecting: 'warning',
  'login failed': 'danger', 'not in server': 'danger', error: 'danger'
};
const ROOM_TEXT: Record<VoiceRoomStatus, string> = { monitored: 'monitored', recording: 'recording', unmonitored: 'not monitored' };

/** Shown when the pool reports runtime 'disabled' (the server runs voice only with TCG_DISCORD_VOICE=1). */
export const VOICE_DISABLED_TEXT = 'Voice features are turned off (set TCG_DISCORD_VOICE=1 and restart the bot). Bots show as not connected.';

function BotRow({ bot, onRemove }: { bot: VoiceBotStatusDto; onRemove(): void }) {
  const room = bot.assignedMatchId ? `${bot.assignedMatchId}${bot.assignedChannelId ? ` · #${bot.assignedChannelId}` : ''}`
    : bot.assignedChannelId ? `#${bot.assignedChannelId}` : 'Free';
  return <li className="flex items-center gap-2 rounded-md bg-raised px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--color-line)]" data-bot={bot.id}>
    <StatusDot tone={bot.status ? STATUS_TONE[bot.status] ?? 'neutral' : bot.connected ? 'success' : 'neutral'} size="sm" />
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-1.5">
        <span className="truncate text-xs font-medium text-fg">{bot.label}</span>
        <Badge tone={bot.kind === 'main' ? 'accent' : 'neutral'}>{bot.kind === 'main' ? 'main bot' : 'helper'}</Badge>
      </span>
      <span className="block truncate text-2xs text-fg-subtle">{bot.status ? STATUS_TEXT[bot.status] ?? bot.status : bot.connected ? 'Connected' : 'Not connected'} · {room}</span>
    </span>
    {bot.kind === 'helper' && <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden />} onClick={onRemove}
      aria-label={`Remove ${bot.label}`}>Remove</Button>}
  </li>;
}

export function VoiceBots({ disabled }: { disabled: boolean }) {
  const { api } = useAdminData();
  const [pool, setPool] = useState<VoiceBotPoolDto | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState<VoiceBotStatusDto | null>(null);

  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    getVoiceBots(api, abort.signal).then(next => { if (live) setPool(next); })
      .catch(cause => { if (live && !abort.signal.aborted) setLoadError(cause); });
    return () => { live = false; abort.abort(); };
  }, [api]);

  const helpers = pool?.bots.filter(bot => bot.kind === 'helper').length ?? 0;
  const labelError = label.trim().length > L.voiceBotLabelLength ? `Up to ${L.voiceBotLabelLength} characters.` : null;
  const canAdd = !disabled && !busy && label.trim().length > 0 && token.length > 0 && !labelError && helpers < L.voiceHelperBots;

  const add = async () => {
    if (!canAdd) return;
    const body = { label: label.trim(), token: token.trim() };
    // The token leaves the form now, whatever happens next.
    setToken('');
    setBusy(true); setError(null); setMessage(null);
    try {
      setPool(await addVoiceBot(api, body));
      setLabel('');
      setMessage('Helper bot added. Invite it to the server with the Connect and Speak permissions.');
    } catch (cause) {
      setError(describeError(cause, 'The bot could not be added.'));
    } finally { setBusy(false); }
  };
  const remove = async (bot: VoiceBotStatusDto) => {
    setBusy(true); setError(null); setMessage(null);
    try { setPool(await removeVoiceBot(api, bot.id)); setRemoving(null); }
    catch (cause) { setError(describeError(cause, 'The bot could not be removed.')); setRemoving(null); }
    finally { setBusy(false); }
  };

  const unmonitored = pool?.rooms.filter(room => room.botId === null) ?? [];
  return <div className="flex flex-col gap-4">
    <p className="text-xs text-fg-muted">A bot can be in one voice room at a time. The main bot covers one match room; each helper bot covers one more at the same time. Rooms without a free bot are not monitored or recorded.</p>
    {loadError ? <p role="alert" className="text-xs text-danger">{isNotAvailable(loadError)
      ? 'Voice bots are not available in this version yet.' : describeError(loadError, 'Voice bots could not be loaded.')}</p> : null}
    {!pool && !loadError && <p role="status" className="text-xs text-fg-muted">Loading voice bots…</p>}
    {pool && <>
      {pool.runtime === 'disabled' && <p className="rounded-md bg-sunken p-2 text-xs text-fg-muted">{VOICE_DISABLED_TEXT}</p>}
      <ul aria-label="Voice bots" className="flex flex-col gap-1.5">
        {pool.bots.map(bot => <BotRow key={bot.id} bot={bot} onRemove={() => setRemoving(bot)} />)}
      </ul>
      {pool.rooms.length > 0 && <ul aria-label="Match rooms" className="flex flex-wrap gap-1.5">
        {pool.rooms.map(room => <li key={room.matchId}>
          <Badge tone={room.botId === null ? 'warning' : room.status === 'recording' ? 'danger' : 'neutral'}>
            {room.matchId}: {ROOM_TEXT[room.status ?? (room.botId === null ? 'unmonitored' : 'monitored')]}
          </Badge>
        </li>)}
      </ul>}
      {unmonitored.length > 0 && <p role="status" className="text-xs text-warning">
        Not monitored (no free bot): {unmonitored.map(room => room.matchId).join(', ')}.
      </p>}
    </>}
    <form aria-label="Add helper bot" className="flex flex-col gap-3 rounded-lg bg-raised p-3 shadow-[inset_0_0_0_1px_var(--color-line)]"
      onSubmit={event => { event.preventDefault(); void add(); }}>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg"><Bot aria-hidden className="size-3.5" />Add helper bot
        <span className="font-normal text-fg-subtle">({helpers} / {L.voiceHelperBots})</span></h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label" error={labelError}>
          <Input value={label} disabled={disabled || busy} onChange={event => setLabel(event.target.value)} placeholder="Helper 1" />
        </Field>
        <Field label="Bot token" description="Type or paste it yourself. It is stored only on this PC and never shown again.">
          <Input type="password" value={token} autoComplete="off" spellCheck={false} disabled={disabled || busy}
            onChange={event => setToken(event.target.value)} />
        </Field>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {message && <p role="status" className="text-xs text-fg-muted">{message}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="primary" icon={<Plus aria-hidden />} loading={busy} disabled={!canAdd}>Add bot</Button>
      </div>
    </form>
    <ConfirmDialog open={removing !== null} danger pending={busy} title={`Remove ${removing?.label ?? 'helper bot'}?`}
      confirmLabel="Remove bot" description="Its token is deleted from this PC. The room it covered is no longer monitored until another bot is free."
      onCancel={() => setRemoving(null)} onConfirm={() => { if (removing) void remove(removing); }} />
  </div>;
}
