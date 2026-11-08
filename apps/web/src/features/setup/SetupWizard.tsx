import type { SetupChannelDto, SetupCheckDto, SetupGuildDto, SetupSelectionDto, SetupStatusDto } from '@tcg-live/core';
import { useEffect, useState } from 'react';
import { useAdminData } from '../../data';
import { Button, Field, Input, Select, Switch } from '../../ui';
import { BrandMark } from '../shell/BrandMark';

const EMPTY: SetupSelectionDto = { guildId: '', channelId: '', matchChannels: { M1: '', M2: '' },
  adminId: '', publicMatchRooms: true };
const STEPS = ['Server', 'Channels', 'Readiness'] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Setup could not complete. Refresh and try again.';
}

function channelOptions(channels: SetupChannelDto[], type: 'text' | 'voice') {
  const categories = [...new Set(channels.filter(item => item.type === type).map(item => item.category ?? 'Uncategorized'))];
  return categories.map(category => <optgroup key={category} label={category}>
    {channels.filter(item => item.type === type && (item.category ?? 'Uncategorized') === category)
      .map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
  </optgroup>);
}

/** First-start flow; mounted only when the authenticated server marks this a setup session. */
export function SetupWizard() {
  const { api } = useAdminData();
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatusDto | null>(null);
  const [guilds, setGuilds] = useState<SetupGuildDto[]>([]);
  const [channels, setChannels] = useState<SetupChannelDto[]>([]);
  const [selection, setSelection] = useState<SetupSelectionDto>(EMPTY);
  const [check, setCheck] = useState<SetupCheckDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const refresh = async () => {
    setError(null);
    try {
      const next = await api.getSetupStatus();
      setStatus(next);
      if (next.selection) setSelection(next.selection);
      setCheck(next.check);
      const available = await api.listSetupGuilds().catch(() => []);
      setGuilds(available);
    } catch (cause) { setError(errorText(cause)); }
  };
  useEffect(() => { void refresh(); }, [api]);
  useEffect(() => {
    let live = true;
    setChannels([]);
    if (selection.guildId) void api.listSetupChannels(selection.guildId).then(items => {
      if (live) setChannels(items);
    }, cause => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [api, selection.guildId]);

  const set = (patch: Partial<SetupSelectionDto>) => { setSelection(current => ({ ...current, ...patch })); setCheck(null); };
  const setMatch = (slot: 'M1' | 'M2', id: string) => {
    setSelection(current => ({ ...current, matchChannels: { M1: current.matchChannels?.M1 ?? '',
      M2: current.matchChannels?.M2 ?? '', [slot]: id } }));
    setCheck(null);
  };
  const onGuild = (guildId: string) => {
    const owner = guilds.find(item => item.id === guildId)?.ownerId ?? '';
    set({ guildId, channelId: '', matchChannels: { M1: '', M2: '' }, adminId: owner });
  };
  const review = async () => {
    setBusy(true); setError(null);
    try { setCheck(await api.checkSetup(selection)); setStep(2); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true); setError(null);
    try { await api.finishSetup(selection); setOpening(true); }
    catch (cause) { setError(errorText(cause)); setBusy(false); }
  };
  const frozen = status?.frozen ?? false;
  const selectedGuild = guilds.find(item => item.id === selection.guildId);
  const channelName = (id: string) => channels.find(item => item.id === id)?.name ?? id;

  return <div className="min-h-screen bg-canvas px-4 py-8 text-fg sm:px-6">
    <main className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-raised p-5 shadow-raised sm:p-8"
      aria-labelledby="setup-title">
      <div className="flex items-center gap-3"><BrandMark size="lg" />
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">TCG Live</p>
          <h1 id="setup-title" className="text-xl font-semibold">Connect your tournament</h1></div>
      </div>
      <p className="mt-3 text-sm text-fg-muted">Choose where players sign up and where each practice match happens.</p>
      <ol aria-label="Setup progress" className="mt-6 grid grid-cols-3 gap-2">
        {STEPS.map((name, index) => <li key={name} aria-current={index === step ? 'step' : undefined}
          className={`rounded-md border px-2 py-2 text-center text-xs font-medium ${index === step ?
            'border-accent bg-accent-soft text-accent' : 'border-line text-fg-muted'}`}>
          <span className="mr-1 tabular-nums">{index + 1}.</span>{name}</li>)}
      </ol>
      {status?.prerequisite && <p role="alert" className="mt-5 rounded-md border border-danger bg-sunken p-3 text-sm text-fg">
        {status.prerequisite}</p>}
      {status?.handoverError && <p role="alert" className="mt-5 rounded-md border border-danger bg-sunken p-3 text-sm text-fg">
        {status.handoverError}</p>}
      {error && <p role="alert" className="mt-5 rounded-md border border-danger bg-sunken p-3 text-sm text-danger">{error}</p>}
      {!status && !error && <p role="status" className="mt-6 text-sm text-fg-muted">Loading setup…</p>}
      {status && <div className="mt-6 space-y-5">
        {frozen && <p className="rounded-md bg-sunken p-3 text-sm text-fg-muted">
          Active event {status.activeEventId} is preserved. Server, channels, organizer and room mode are locked.</p>}
        {step === 0 && <section aria-label="Server" className="space-y-4">
          <Field label="Discord server" required description="Servers the bot belongs to are shown here.">
            <Select value={selection.guildId} disabled={frozen} onChange={event => onGuild(event.target.value)}>
              <option value="">Choose a server</option>
              {guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
            </Select>
          </Field>
          <Field label="Organizer Discord ID" required description="Defaults to this server’s owner; the organizer cannot join as a player.">
            <Input value={selection.adminId} disabled={frozen} onChange={event => set({ adminId: event.target.value })}
              inputMode="numeric" placeholder="Discord member ID" />
          </Field>
          {selection.guildId && <p className="text-xs text-fg-subtle">{selectedGuild?.name ?? 'Saved server'} · {selection.guildId}</p>}
          <p className="text-xs text-fg-muted">Bot can only discover channels Discord returns. Grant View Channel and refresh if one is missing.</p>
        </section>}
        {step === 1 && <section aria-label="Channels" className="space-y-4">
          <Field label="Signup text channel" required>
            <Select value={selection.channelId} disabled={frozen} onChange={event => set({ channelId: event.target.value })}>
              <option value="">Choose a text channel</option>{channelOptions(channels, 'text')}
            </Select>
          </Field>
          {frozen && selection.matchChannels === null ?
            <p className="rounded-md bg-sunken p-3 text-sm text-fg-muted">
              This saved event uses signup-channel chat for both matches.</p> :
            (['M1', 'M2'] as const).map(slot => <Field key={slot} label={`${slot} match voice room`} required
            description={frozen ? 'This saved event keeps its assigned voice room.' : 'Use a dedicated voice room whose name starts with TCG Match.'}>
              <Select value={selection.matchChannels?.[slot] ?? ''} disabled={frozen}
                onChange={event => setMatch(slot, event.target.value)}>
                <option value="">Choose a voice room</option>{channelOptions(channels, 'voice')}
              </Select>
            </Field>)}
          <Field label="Public match rooms" description="Everyone can enter; only the assigned pair, organizer and bot can post."
            inline><Switch checked={selection.publicMatchRooms} disabled={frozen}
              onCheckedChange={value => set({ publicMatchRooms: value })} /></Field>
          <p className="text-xs text-fg-muted">Bot can only discover channels Discord returns. Grant View Channel and refresh if one is missing.</p>
        </section>}
        {step === 2 && <section aria-label="Readiness" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(['signup', 'M1', 'M2'] as const).map((slot, index) => {
              const id = slot === 'signup' ? selection.channelId : selection.matchChannels?.[slot] ?? selection.channelId;
              const row = check?.capabilities[index];
              return <div key={slot} className="rounded-lg border border-line bg-sunken p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{slot}</p>
                <p className="mt-1 break-words font-medium">{row?.channelName ?? channelName(id)}</p>
                <p className={`mt-2 text-xs ${row?.missing.length ? 'text-danger' : 'text-fg-muted'}`}>
                  {row ? row.missing.length ? `Missing: ${row.missing.join(', ')}` : 'Ready' : 'Check permissions to see status'}</p>
              </div>;
            })}
          </div>
          {check && <><p className="text-sm text-fg-muted">Bot: {check.botName ?? status.botName ?? 'Not connected'}</p>
            {check.issues.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
              {check.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
            <p className="rounded-md border border-line bg-raised p-3 text-sm">{check.guide}</p>
            {check.notice === 'pending' && <p role="status" className="text-sm text-fg-muted">Signup-channel guide delivery is uncertain. Review the channel before trying again.</p>}
            {check.notice === 'cannot_post' && <p role="status" className="text-sm text-fg-muted">The bot cannot post the guide in the signup channel yet.</p>}
          </>}
          {opening && <p role="status" className="text-sm font-medium text-accent">Setup complete. Opening dashboard…</p>}
        </section>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <Button variant="ghost" onClick={() => setStep(value => Math.max(0, value - 1))} disabled={step === 0 || busy || opening}>Back</Button>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void refresh()} disabled={busy || opening}>Refresh</Button>
            {step === 0 && <Button variant="primary" onClick={() => setStep(1)} disabled={!selection.guildId || !selection.adminId}>Next: channels</Button>}
            {step === 1 && <Button variant="primary" onClick={() => void review()} loading={busy}
              disabled={!selection.channelId || (!frozen && (!selection.matchChannels?.M1 || !selection.matchChannels?.M2))}>
              Check readiness</Button>}
            {step === 2 && <><Button variant="secondary" onClick={() => void review()} loading={busy}>Recheck</Button>
              <Button variant="primary" onClick={() => void finish()} loading={busy}
                disabled={!check?.valid || opening}>Save and Start</Button></>}
          </div>
        </div>
      </div>}
    </main>
  </div>;
}
