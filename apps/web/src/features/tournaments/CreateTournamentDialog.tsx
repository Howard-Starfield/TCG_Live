import { ARTWORK_GAMES, DEFAULT_MATCH_MINUTES, MAX_MATCH_MINUTES, type ArtworkGame,
  type OpenTournamentSignupRequest, type OpenTournamentSignupResult, type SignupBannerStyle, type TournamentDirectoryEntryDto,
  type TournamentSignupChannelDto } from '@tcg-live/core';
import { useQuery } from '@tanstack/react-query';
import { CircleHelp } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { adminKeys, useAdminData, useEventSnapshot } from '../../data';
import { Button, Dialog, Field, IconButton, Input, Select, Textarea, Tooltip, useToast } from '../../ui';
import { useShell } from '../shell/model';
import { tournamentDirectoryKey } from './directory';

export const gameLabel: Record<ArtworkGame, string> = {
  'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man', pokemon: 'Pokémon'
};

export function CreateTournamentDialog({ open, defaultGame, onClose, onSaved, onCreated }: {
  open: boolean; defaultGame: ArtworkGame; onClose(): void;
  onSaved(entry: TournamentDirectoryEntryDto): void;
  onCreated(eventId: string): void;
}) {
  const { api, queryClient } = useAdminData();
  const shell = useShell();
  const toast = useToast();
  const [game, setGame] = useState<ArtworkGame>(defaultGame);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState(String(DEFAULT_MATCH_MINUTES));
  const [bannerOverride, setBannerOverride] = useState<SignupBannerStyle>();
  const [channelOverride, setChannelOverride] = useState<string>();
  const [confirm, setConfirm] = useState<OpenTournamentSignupRequest | null>(null);
  const [saved, setSaved] = useState<TournamentDirectoryEntryDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const draftId = useRef<string | null>(null);
  const unavailable = !shell.session.commandsEnabled;
  const active = useEventSnapshot(open ? shell.activeEventId : null).data;
  const destination = active?.status === 'active' ? active.discord : undefined;
  const previous = shell.directory?.entries.filter(entry => entry.game === game && entry.status !== 'draft')
    .sort((left, right) => (right.retiredAtMs ?? Number.MAX_SAFE_INTEGER) - (left.retiredAtMs ?? Number.MAX_SAFE_INTEGER))[0];
  const bannerStyle = bannerOverride ?? previous?.bannerStyle ?? 'game';
  const signupChannelId = channelOverride ?? previous?.signupChannelId ?? destination?.channelId ?? '';
  const channels = useQuery({
    queryKey: ['tournament-signup-channels', shell.activeEventId],
    queryFn: ({ signal }) => api.request<TournamentSignupChannelDto[]>('GET', '/tournaments/signup-channels', { signal }),
    enabled: open,
    staleTime: 0,
    retry: false
  });

  useEffect(() => {
    if (!open) return;
    setGame(defaultGame);
    setName(`${gameLabel[defaultGame]} Tournament`);
    setDescription('');
    setMinutes(String(DEFAULT_MATCH_MINUTES));
    setBannerOverride(undefined);
    setChannelOverride(undefined);
    setConfirm(null);
    setSaved(null);
    setError(null);
    draftId.current = null;
  }, [open, defaultGame]);

  async function save(activation: OpenTournamentSignupRequest | null) {
    if (busy || (!saved && !form.current?.reportValidity())) return;
    setBusy(true);
    setError(null);
    draftId.current ??= crypto.randomUUID();
    try {
      const entry = saved ?? await api.createTournamentDraft({
        draftId: draftId.current, name: name.trim() || undefined, game, description: description.trim(),
        matchMinutes: Number(minutes), bannerStyle, signupChannelId: signupChannelId || undefined
      });
      setSaved(entry);
      if (!activation) {
        await queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey });
        onSaved(entry);
        return;
      }
      const result = await api.request<OpenTournamentSignupResult>('POST',
        `/tournaments/${encodeURIComponent(entry.eventId)}/open-signup`, { body: activation });
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey }),
        queryClient.invalidateQueries({ queryKey: adminKeys.events() })
      ]);
      toast.show(result.panels === 'posted' ? { title: 'Signup opened in Discord', tone: 'success' }
        : { title: 'Tournament created. Discord panels need attention.', description: 'Use Refresh panels on the live tournament.' });
      onCreated(result.eventId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tournament could not be saved.');
      if (activation) void queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey });
    } finally { setBusy(false); }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (unavailable || busy) return;
    const activation = confirm ?? { expectedActiveEventId: shell.activeEventId };
    if (!confirm && activation.expectedActiveEventId) setConfirm(activation);
    else void save(activation);
  };
  const fieldsLocked = busy || !!saved || !!confirm;

  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} dismissible={!busy} width="lg"
    title="Create signup tournament" description="Create to open signup in Discord, or save your settings as a draft."
    footer={<><Button variant="ghost" disabled={busy} onClick={() => confirm ? setConfirm(null) : onClose()}>
      {confirm ? 'Back' : 'Cancel'}
    </Button>
      {!confirm && <Button variant="secondary" disabled={busy} onClick={() => { void save(null); }}>Save as draft</Button>}
      <Button variant="primary" type="submit" form="create-tournament-form" disabled={busy || unavailable}>
        {busy ? 'Saving…' : confirm ? 'Create and open signup' : 'Create'}
      </Button></>}>
    <form id="create-tournament-form" ref={form} className="space-y-5" onSubmit={submit}>
      {confirm ? <div className="rounded-lg border border-line bg-raised p-4 text-sm">
        <p className="font-semibold">Open signup for {name.trim() || `${gameLabel[game]} Tournament`}?</p>
        <p className="mt-2 text-fg-muted">The active tournament moves to History. The new signup opens in the selected channel.
          Players must join the new tournament. Finish any published round before switching.</p>
      </div> : <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tournament name">
            <Input value={name} placeholder={`${gameLabel[game]} Tournament`} maxLength={80} disabled={fieldsLocked}
              onChange={event => setName(event.target.value)} />
          </Field>
          <Field label="Game type" required>
            <Select value={game} disabled={fieldsLocked} onChange={event => {
              const next = ARTWORK_GAMES.find(item => item === event.target.value);
              if (next) {
                if (name === `${gameLabel[game]} Tournament`) setName(`${gameLabel[next]} Tournament`);
                setGame(next);
                setBannerOverride(undefined);
                setChannelOverride(undefined);
              }
            }}>
              {ARTWORK_GAMES.map(item => <option key={item} value={item}>{gameLabel[item]}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid items-start gap-4 rounded-lg border border-line bg-raised p-4 sm:grid-cols-2">
          <div>
            <p className="text-sm font-semibold">Tournament format</p>
            <p className="mt-1 text-xs text-fg-muted">One best-of-one round · Camera play</p>
            <p className="mt-2 text-xs text-fg-muted">Signup limit <strong className="text-fg">4 players</strong></p>
          </div>
          <Field label="Match timer in minutes" required labelAction={
            <Tooltip content="Each match gets this many minutes. The clock starts once both players click Ready. When it expires, a judge is needed to resolve the match.">
              <IconButton size="sm" className="!size-6" aria-label="How the match timer works" icon={<CircleHelp aria-hidden />} />
            </Tooltip>
          }>
            <Input type="number" min={1} max={MAX_MATCH_MINUTES} step={1} value={minutes} disabled={fieldsLocked}
              onChange={event => setMinutes(event.target.value)} />
          </Field>
        </div>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="Signup banner" description="Full banner uses the saved artwork for the selected game.">
            <Select value={bannerStyle} disabled={fieldsLocked}
              onChange={event => setBannerOverride(event.target.value === 'compact' ? 'compact' : 'game')}>
              <option value="game">Full game banner</option>
              <option value="compact">Compact artwork</option>
            </Select>
          </Field>
          <Field label="Discord signup channel" description={channels.isError
            ? 'Channel list unavailable. Use the current channel or retry when Discord is online.'
            : 'The sticky signup panel is posted and pinned here.'}>
            <Select value={signupChannelId} disabled={fieldsLocked} onChange={event => setChannelOverride(event.target.value)}>
              <option value="">Use current signup channel</option>
              {signupChannelId && !channels.data?.some(channel => channel.id === signupChannelId) &&
                <option value={signupChannelId}>{signupChannelId === destination?.channelId ? 'Current signup channel'
                  : 'Previously selected channel'}</option>}
              {channels.data?.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Tournament details" description="Optional. Players see this on the Discord signup panel.">
          <Textarea value={description} maxLength={500} rows={3} disabled={fieldsLocked}
            onChange={event => setDescription(event.target.value)} />
        </Field>
        {unavailable && <p className="text-sm text-fg-muted">Enable tournament commands to create a live tournament.</p>}
      </>}
      {saved && error && <p className="text-sm text-fg-muted">Your tournament was saved. You can retry or open it from Drafts.</p>}
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>}
    </form>
  </Dialog>;
}
