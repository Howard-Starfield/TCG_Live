import type { SetupCapabilityDto, SetupChannelDto, SetupCheckDto, SetupGuildDto, SetupMatchRoomsDto, SetupSelectionDto, SetupStatusDto, TournamentRolesEnsureResultDto } from '@tcg-live/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdminData } from '../../data';
import { Button, Field, Input, Select, Switch } from '../../ui';
import { BrandMark } from '../shell/BrandMark';
import { BotSetupGuide } from '../bot-permissions/BotSetupGuide';
import { CreateChannelInline } from './CreateChannelInline';
import { GRANT_EXPLANATION, GrantPermissionsLink, PermissionIssueList } from '../bot-permissions/PermissionIssues';
import { LocalSettingsPanel } from './DashboardActionsSwitch';
import { SetupRoomsResult, SetupRolesResult, WhatsNext } from './WhatsNext';

const NO_ROOMS: SetupMatchRoomsDto = { categoryId: null, createCategory: false };
const EMPTY: SetupSelectionDto = { guildId: '', channelId: '', matchChannels: null, matchRooms: NO_ROOMS,
  adminId: '', publicMatchRooms: true };
export const NEW_CATEGORY_LABEL = 'Create a “TCG Live — Matches” category';
export const LEGACY_ROOMS_NOTE = 'Your current rooms join the pool and get the room naming at the next event.';
const STEPS = ['Server', 'Channels', 'Readiness', 'What’s next'] as const;

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

interface ReadinessRow { slot: string; name: string; missing: string[] | null }

/** The signup channel, then the room rows the server reported (rooms, or M1 and M2 for a legacy selection); before a check, a rooms placeholder. */
function readinessRows(check: SetupCheckDto | null, selection: SetupSelectionDto, channelName: (id: string) => string, categoryName: string): ReadinessRow[] {
  const row = (item: SetupCapabilityDto): ReadinessRow => ({ slot: item.slot, name: item.channelName, missing: item.missing });
  const signup = check?.capabilities.find(item => item.slot === 'signup');
  const rest = check?.capabilities.filter(item => item.slot !== 'signup') ?? [];
  return [signup ? row(signup) : { slot: 'signup', name: channelName(selection.channelId), missing: null },
    ...(rest.length > 0 ? rest.map(row) : [{ slot: 'rooms', name: categoryName, missing: check ? [] : null }])];
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
  const [roles, setRoles] = useState<TournamentRolesEnsureResultDto | null>(null);
  const [rooms, setRooms] = useState<{ problem: string | null } | null>(null);

  // Bumped by Refresh so the channel list is re-read too.
  const [refreshCount, setRefreshCount] = useState(0);
  // The saved selection seeds the form once; later refreshes must not overwrite in-progress choices.
  const seeded = useRef(false);
  const refreshAbort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;
    const { signal } = controller;
    setError(null);
    try {
      const next = await api.getSetupStatus(signal);
      if (signal.aborted) return;
      setStatus(next);
      // A frozen setup cannot be edited, so the saved selection always applies.
      if (!seeded.current || next.frozen) {
        seeded.current = true;
        if (next.selection) setSelection(next.selection);
        setCheck(next.check);
      }
      const available = await api.listSetupGuilds(signal).catch(() => []);
      if (signal.aborted) return;
      setGuilds(available);
    } catch (cause) { if (!signal.aborted) setError(errorText(cause)); }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => { refreshAbort.current?.abort(); };
  }, [refresh]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setChannels([]);
    if (selection.guildId) void api.listSetupChannels(selection.guildId, controller.signal).then(items => {
      if (live) setChannels(items);
    }, cause => { if (live) setError(errorText(cause)); });
    return () => { live = false; controller.abort(); };
  }, [api, selection.guildId, refreshCount]);

  const set = (patch: Partial<SetupSelectionDto>) => { setSelection(current => ({ ...current, ...patch })); setCheck(null); };
  const setRoomsChoice = (patch: Partial<SetupMatchRoomsDto>) =>
    set({ matchRooms: { ...(selection.matchRooms ?? NO_ROOMS), ...patch } });
  const onGuild = (guildId: string) => {
    const owner = guilds.find(item => item.id === guildId)?.ownerId ?? '';
    set({ guildId, channelId: '', matchChannels: null, matchRooms: NO_ROOMS, adminId: owner });
  };
  const review = async () => {
    setBusy(true); setError(null);
    try { setCheck(await api.checkSetup(selection)); setStep(2); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true); setError(null);
    try { const done = await api.finishSetup(selection); setRoles(done.roles ?? null); setRooms(done.rooms ?? null); setOpening(true); setStep(3); }
    catch (cause) { setError(errorText(cause)); setBusy(false); }
  };
  /** A signup channel created from the wizard joins the list and is selected. */
  const created = (channel: SetupChannelDto) => {
    setChannels(current => [...current.filter(item => item.id !== channel.id), channel]);
    set({ channelId: channel.id });
  };
  const frozen = status?.frozen ?? false;
  // Selections saved before the room pool name two rooms; they join the pool as adopted tables.
  const legacy = selection.matchChannels !== null;
  const legacyFrozen = frozen && selection.matchChannels === null && selection.matchRooms === undefined;
  const categories = channels.filter(item => item.type === 'category');
  const roomsChoice = selection.matchRooms ?? NO_ROOMS;
  const categoryName = roomsChoice.createCategory ? 'A new “TCG Live — Matches” category'
    : categories.find(item => item.id === roomsChoice.categoryId)?.name ?? 'No category';
  const selectedGuild = guilds.find(item => item.id === selection.guildId);
  const channelName = (id: string) => channels.find(item => item.id === id)?.name ?? id;

  return <div className="min-h-screen bg-canvas px-4 py-8 text-fg sm:px-6">
    <main className="mx-auto w-full max-w-3xl rounded-xl border border-line bg-raised p-5 shadow-raised sm:p-8"
      aria-labelledby="setup-title">
      <div className="flex items-center gap-3"><BrandMark size="lg" />
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">TCG Live</p>
          <h1 id="setup-title" className="text-xl font-semibold">Connect your tournament</h1></div>
      </div>
      <p className="mt-3 text-sm text-fg-muted">Choose where players sign up. The bot makes a voice room for every match.</p>
      <BotSetupGuide inviteUrl={check?.permissions?.inviteUrl ?? null} defaultOpen={!!status?.prerequisite} className="mt-4" />
      <ol aria-label="Setup progress" className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
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
          <Field label="Organizer Discord ID" required description="Defaults to this server’s owner. Gets the TCG Organizer role and may also play.">
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
          {!frozen && <CreateChannelInline guildId={selection.guildId} type="text" defaultName="tcg-signup"
            onCreated={created} />}
          {legacyFrozen ? <p className="rounded-md bg-sunken p-3 text-sm text-fg-muted">
            This saved event uses signup-channel chat for both matches.</p> : <>
            {legacy && <p role="note" className="rounded-md bg-sunken p-3 text-sm text-fg-muted">{LEGACY_ROOMS_NOTE}</p>}
            <Field label="Put match rooms in" description={frozen ? 'This saved event keeps its room settings.'
              : 'The bot creates a voice room for each match here and reuses them. Optional.'}>
              <Select value={roomsChoice.createCategory ? '' : roomsChoice.categoryId ?? ''} disabled={frozen || roomsChoice.createCategory}
                onChange={event => setRoomsChoice({ categoryId: event.target.value || null })}>
                <option value="">No category</option>
                {categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </Select>
            </Field>
            <Field label={NEW_CATEGORY_LABEL} inline><Switch checked={roomsChoice.createCategory} disabled={frozen}
              onCheckedChange={value => setRoomsChoice({ createCategory: value, categoryId: value ? null : roomsChoice.categoryId })} /></Field>
          </>}
          {selection.matchChannels === null && !frozen
            ? <p className="text-xs text-fg-muted"><b className="font-medium text-fg">Public match rooms.</b> Rooms the bot manages are always public:
              everyone can enter; only the assigned pair, organizer and bot can post.</p>
            : <Field label="Public match rooms" description="Everyone can enter; only the assigned pair, organizer and bot can post."
              inline><Switch checked={selection.publicMatchRooms} disabled={frozen}
                onCheckedChange={value => set({ publicMatchRooms: value })} /></Field>}
          <p className="text-xs text-fg-muted">Bot can only discover channels Discord returns. Grant View Channel and refresh if one is missing.
            Creating a channel here needs the bot’s Manage Channels permission.</p>
        </section>}
        {step === 2 && <section aria-label="Readiness" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {readinessRows(check, selection, channelName, categoryName).map(row => <div key={row.slot} className="rounded-lg border border-line bg-sunken p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{row.slot === 'rooms' ? 'Match rooms' : row.slot}</p>
              <p className="mt-1 break-words font-medium">{row.name}</p>
              <p className={`mt-2 text-xs ${row.missing?.length ? 'text-danger' : 'text-fg-muted'}`}>
                {row.missing ? row.missing.length ? `Missing: ${row.missing.join(', ')}` : 'Ready' : 'Check permissions to see status'}</p>
            </div>)}
          </div>
          {check?.permissions && <section aria-label="Bot permissions" className="space-y-3 rounded-lg border border-line p-3">
            <h2 className="text-sm font-semibold">Bot permissions</h2>
            {check.permissions.issues.length ? <PermissionIssueList issues={check.permissions.issues} />
              : <p className="text-sm text-fg-muted">The bot has every permission these channels need.</p>}
            {check.permissions.inviteUrl && <div className="space-y-1.5">
              <GrantPermissionsLink href={check.permissions.inviteUrl}
                label={check.permissions.issues.length ? 'Grant missing permissions in Discord' : 'Open the invite link'}
                variant={check.permissions.issues.length ? 'primary' : 'secondary'} />
              <p className="text-xs text-fg-subtle">{GRANT_EXPLANATION} Then press Recheck.</p>
            </div>}
          </section>}
          {check && <><p className="text-sm text-fg-muted">Bot: {check.botName ?? status.botName ?? 'Not connected'}</p>
            {check.issues.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
              {check.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
            <p className="rounded-md border border-line bg-raised p-3 text-sm">{check.guide}</p>
            {check.notice === 'pending' && <p role="status" className="text-sm text-fg-muted">Signup-channel guide delivery is uncertain. Review the channel before trying again.</p>}
            {check.notice === 'cannot_post' && <p role="status" className="text-sm text-fg-muted">The bot cannot post the guide in the signup channel yet.</p>}
          </>}
          <p className="rounded-md border border-line bg-sunken p-3 text-sm text-fg-muted">
            <b className="font-medium text-fg">Save and Start</b> also creates the <b className="font-medium text-fg">TCG Organizer</b> and{' '}
            <b className="font-medium text-fg">TCG Judge</b> roles (no permissions) and gives TCG Organizer to the organizer above.
            If that fails, setup still completes and you can create them in Admin tools &gt; Settings &gt; Tournament roles.</p>
          <LocalSettingsPanel setup className="rounded-lg border border-line p-3" />
        </section>}
        {step === 3 && <section aria-label="What’s next" className="space-y-4">
          {opening && <p role="status" className="text-sm font-medium text-accent">Setup complete. Opening dashboard…</p>}
          <SetupRolesResult roles={roles} />
          <SetupRoomsResult rooms={rooms} />
          <WhatsNext inviteUrl={check?.permissions?.inviteUrl ?? null} />
        </section>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <Button variant="ghost" onClick={() => setStep(value => Math.max(0, value - 1))} disabled={step === 0 || busy || opening}>Back</Button>
          {step === 3 ? null : <>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => { setRefreshCount(count => count + 1); void refresh(); }} disabled={busy || opening}>Refresh</Button>
            {step === 0 && <Button variant="primary" onClick={() => setStep(1)} disabled={!selection.guildId || !selection.adminId}>Next: channels</Button>}
            {step === 1 && <Button variant="primary" onClick={() => void review()} loading={busy}
              disabled={!selection.channelId}>
              Check readiness</Button>}
            {step === 2 && <><Button variant="secondary" onClick={() => void review()} loading={busy}>Recheck</Button>
              <Button variant="primary" onClick={() => void finish()} loading={busy}
                disabled={!check?.valid || opening}>Save and Start</Button></>}
          </div></>}
        </div>
      </div>}
    </main>
  </div>;
}
