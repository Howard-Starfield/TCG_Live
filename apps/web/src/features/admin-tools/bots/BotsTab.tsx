// Admin tools > Bots: the voice bot pool (main bot plus helper bots), guided helper setup, per-room
// policies and the capacity banner. Requires moderation.manage; the server never returns a token.
import type { ModerationSettingsDto, VoiceBotPoolDto } from '@tcg-live/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdminData } from '../../../data';
import { describeError, isNotAvailable } from '../../evidence/api';
import { getModerationSettings, getVoiceBots, useModerationAccess } from '../../moderation/api';
import { VOICE_DISABLED_ENV_TEXT, VOICE_DISABLED_TEXT } from '../../moderation/VoiceBots';
import { VoiceMonitoringSwitch } from '../../setup/DashboardActionsSwitch';
import { useLocalSettingsAvailable } from '../../setup/localSettings';
import { HIGHLIGHT_CLASS, useHighlightNew } from '../shared/useHighlightNew';
import { AddHelperWizard } from './AddHelperWizard';
import { BotCard } from './BotCard';
import { CapacityBanner } from './CapacityBanner';
import { RoomGrid } from './RoomGrid';

export const BOT_POLL_MS = 10_000;

export function BotsTab() {
  const { api } = useAdminData();
  const access = useModerationAccess();
  const voiceSwitch = useLocalSettingsAvailable();
  const [pool, setPool] = useState<VoiceBotPoolDto | null>(null);
  const [settings, setSettings] = useState<ModerationSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  /** The poll in flight; a mutation's answer is newer, so it cancels the poll. */
  const polling = useRef<AbortController | null>(null);
  const highlight = useHighlightNew();
  const applyPool = useCallback((next: VoiceBotPoolDto) => { polling.current?.abort(); setPool(next); }, []);

  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    Promise.all([getVoiceBots(api, abort.signal), getModerationSettings(api, abort.signal)])
      .then(([nextPool, nextSettings]) => { if (live) { setPool(nextPool); setSettings(nextSettings); } })
      .catch(cause => { if (live && !abort.signal.aborted) setLoadError(cause); });
    return () => { live = false; abort.abort(); };
  }, [api]);

  // Bot status changes on its own (logging in, connected, a room assigned): poll the pool while the tab is
  // open and visible. Settings are not polled, so unsaved room edits are never replaced.
  const loaded = pool !== null;
  useEffect(() => {
    if (!loaded) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      polling.current?.abort();
      const abort = new AbortController();
      polling.current = abort;
      getVoiceBots(api, abort.signal).then(next => { if (!abort.signal.aborted) setPool(next); }, () => { /* The next tick tries again. */ });
    }, BOT_POLL_MS);
    return () => { clearInterval(timer); polling.current?.abort(); };
  }, [api, loaded]);

  if (loadError) return <p role="alert" className="text-xs text-danger">{isNotAvailable(loadError)
    ? 'Voice bots are not available in this version yet.' : describeError(loadError, 'Voice bots could not be loaded.')}</p>;
  if (!pool || !settings) return <p role="status" className="text-xs text-fg-muted">Loading voice bots…</p>;
  const channelIds = [...new Set([...pool.rooms.map(room => room.channelId), ...Object.keys(settings.voice.rooms ?? {})])];
  const knownRooms = channelIds.filter(id => settings.voice.rooms?.[id]?.coverage !== 'never').length;
  const helpers = pool.bots.filter(bot => bot.kind === 'helper').length;
  const disabled = !access;
  return <div className="flex flex-col gap-4">
    <p className="text-xs text-fg-muted">A Discord bot can be in one voice room per server. The main bot covers one match room and each helper bot covers one more at the same time. Bots record audio only; video is never recorded by a bot.</p>
    {pool.runtime === 'disabled' && <div className="space-y-2 rounded-md bg-sunken p-2"><p className="text-xs text-fg-muted">{voiceSwitch ? VOICE_DISABLED_TEXT : VOICE_DISABLED_ENV_TEXT}</p><VoiceMonitoringSwitch /></div>}
    <CapacityBanner pool={pool} knownRooms={knownRooms} />
    <AddHelperWizard helpers={helpers} channelIds={channelIds} disabled={disabled} onPool={applyPool}
      onClosed={addedId => { if (addedId) highlight.highlight(addedId); }} />
    <ul aria-label="Voice bots" className="flex flex-col gap-2">
      {pool.bots.map(bot => <BotCard key={`${bot.id}:${bot.nickname ?? ''}`} bot={bot} channelIds={channelIds} disabled={disabled} onPool={applyPool}
        cardRef={highlight.ref(bot.id)} highlightClass={highlight.isHighlighted(bot.id) ? HIGHLIGHT_CLASS : undefined} />)}
    </ul>
    <RoomGrid settings={settings} pool={pool} disabled={disabled} onSaved={setSettings} />
  </div>;
}
