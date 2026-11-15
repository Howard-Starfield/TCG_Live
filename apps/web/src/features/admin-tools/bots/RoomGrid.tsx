// Per voice room policy (keyed by voice channel ID, so it carries over between events), saved through the
// versioned moderation settings (409 on a stale version).
import { DEFAULT_VOICE_ROOM_POLICY, MODERATION_LIMITS as L, type ModerationSettingsDto, type VoiceBotPoolDto, type VoiceRoomCoverage,
  type VoiceRoomPolicyDto, type VoiceRoomPriority, type VoiceRoomRecording } from '@tcg-live/core';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useAdminData } from '../../../data';
import { Badge, Button, Input, Select } from '../../../ui';
import { describeError } from '../../evidence/api';
import { saveModerationSettings } from '../../moderation/api';

const SNOWFLAKE = /^[1-9]\d{15,21}$/;
const COVERAGE: Record<VoiceRoomCoverage, string> = { auto: 'Auto', always: 'Always cover', never: 'Never cover' };
const RECORDING: Record<VoiceRoomRecording, string> = { inherit: 'Global setting', off: 'Off', 'judge-call': 'On judge call', always: 'Always' };
const PRIORITY: Record<VoiceRoomPriority, string> = { normal: 'Normal', high: 'High' };

export function RoomGrid({ settings, pool, disabled, onSaved }: {
  settings: ModerationSettingsDto; pool: VoiceBotPoolDto; disabled: boolean; onSaved(settings: ModerationSettingsDto): void;
}) {
  const { api } = useAdminData();
  const [draft, setDraft] = useState<Record<string, VoiceRoomPolicyDto>>(() => structuredClone(settings.voice.rooms ?? {}));
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const channelIds = [...new Set([...pool.rooms.map(room => room.channelId), ...Object.keys(draft)])];
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.voice.rooms ?? {});
  const set = (channelId: string, patch: Partial<VoiceRoomPolicyDto>) =>
    setDraft(current => ({ ...current, [channelId]: { ...(current[channelId] ?? DEFAULT_VOICE_ROOM_POLICY), ...patch } }));

  const save = async () => {
    setBusy(true); setError(null); setMessage(null);
    // Default policies are not stored.
    const rooms = Object.fromEntries(Object.entries(draft).filter(([, room]) => JSON.stringify(room) !== JSON.stringify(DEFAULT_VOICE_ROOM_POLICY)));
    const { guildId: _guild, version, updatedAtMs: _updated, ...body } = settings;
    try {
      const result = await saveModerationSettings(api, version, { ...body, voice: { ...body.voice, rooms } });
      if (result.ok) { onSaved(result.settings); setDraft(structuredClone(result.settings.voice.rooms ?? {})); setMessage('Room settings saved.'); }
      else { onSaved(result.conflict); setError('Settings changed in another tab. The latest settings are loaded; your room edits are kept, save again.'); }
    } catch (cause) { setError(describeError(cause, 'Room settings could not be saved.')); }
    finally { setBusy(false); }
  };

  return <section aria-label="Match rooms" className="flex flex-col gap-2">
    <h3 className="text-xs font-semibold text-fg">Match rooms</h3>
    <p className="text-xs text-fg-muted">Rooms are kept by voice channel, so their settings carry over to the next event. Judge calls are always covered first, then High rooms. A pinned bot goes to its room whenever that room needs one; only a judge call can take it away.</p>
    {channelIds.length === 0 && <p className="text-xs text-fg-subtle">No match rooms yet. They appear here while an event runs, or add one by its voice channel ID.</p>}
    {channelIds.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-xs">
      <thead className="text-2xs text-fg-subtle"><tr><th className="py-1 pr-2">Room</th><th className="pr-2">Coverage</th><th className="pr-2">Recording</th>
        <th className="pr-2">Priority</th><th className="pr-2">Pinned bot</th><th>Now</th></tr></thead>
      <tbody>{channelIds.map(channelId => {
        const policy = draft[channelId] ?? DEFAULT_VOICE_ROOM_POLICY;
        const live = pool.rooms.find(room => room.channelId === channelId);
        const bot = live?.botId ? pool.bots.find(item => item.id === live.botId) : undefined;
        return <tr key={channelId} className="border-t border-line" data-room={channelId}>
          <td className="py-1.5 pr-2 font-mono">{live ? `${live.matchId} · ` : ''}#{channelId}</td>
          <td className="pr-2"><Select aria-label={`Coverage of ${channelId}`} value={policy.coverage} disabled={disabled || busy}
            onChange={event => set(channelId, { coverage: event.target.value as VoiceRoomCoverage })}>
            {Object.entries(COVERAGE).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</Select></td>
          <td className="pr-2"><Select aria-label={`Recording of ${channelId}`} value={policy.recording} disabled={disabled || busy}
            onChange={event => set(channelId, { recording: event.target.value as VoiceRoomRecording })}>
            {Object.entries(RECORDING).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</Select></td>
          <td className="pr-2"><Select aria-label={`Priority of ${channelId}`} value={policy.priority} disabled={disabled || busy}
            onChange={event => set(channelId, { priority: event.target.value as VoiceRoomPriority })}>
            {Object.entries(PRIORITY).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</Select></td>
          <td className="pr-2"><Select aria-label={`Pinned bot of ${channelId}`} value={policy.pinnedBotId ?? ''} disabled={disabled || busy}
            onChange={event => set(channelId, { pinnedBotId: event.target.value || null })}>
            <option value="">None</option>
            {pool.bots.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></td>
          <td><Badge tone={!live ? 'neutral' : live.botId === null ? 'warning' : live.status === 'recording' ? 'danger' : 'success'}>
            {!live ? 'idle' : live.botId === null ? 'unmonitored' : `${live.status ?? 'monitored'} · ${bot?.label ?? live.botId}`}</Badge></td>
        </tr>;
      })}</tbody>
    </table></div>}
    {policyNotice(draft, settings.recording.mode)}
    <form className="flex items-end gap-2" aria-label="Add room by channel ID" onSubmit={event => {
      event.preventDefault();
      if (!SNOWFLAKE.test(adding.trim()) || channelIds.length >= L.voiceRoomPolicies) return;
      set(adding.trim(), {});
      setAdding('');
    }}>
      <Input aria-label="Voice channel ID" className="font-mono" placeholder="Voice channel ID" inputMode="numeric" value={adding} disabled={disabled || busy}
        onChange={event => setAdding(event.target.value)} />
      <Button type="submit" size="sm" variant="ghost" icon={<Plus aria-hidden />} disabled={disabled || busy || !SNOWFLAKE.test(adding.trim())}>Add room</Button>
      <span className="flex-1" />
      <Button size="sm" variant="primary" loading={busy} disabled={disabled || !dirty} onClick={() => { void save(); }}>Save rooms</Button>
    </form>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {message && <p role="status" className="text-xs text-fg-muted">{message}</p>}
  </section>;
}

function policyNotice(rooms: Record<string, VoiceRoomPolicyDto>, mode: string) {
  const more = Object.values(rooms).filter(room => room.recording === 'always' && mode !== 'always').length;
  if (!more) return null;
  return <p className="text-2xs text-fg-subtle">{more} room{more === 1 ? ' records' : 's record'} more than the global setting; those rooms still show the monitoring notice before anything is captured.</p>;
}
