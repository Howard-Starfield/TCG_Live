import { ARTWORK_GAMES, DEFAULT_MATCH_MINUTES, DEFAULT_SIGNUP_CAPACITY, DEFAULT_TOURNAMENT_SWISS_RULES, MAX_MATCH_MINUTES, MAX_SIGNUP_CAPACITY, type ArtworkGame,
  type SignupBannerStyle, type TournamentDirectoryEntryDto,
  type TournamentSignupChannelDto, type TournamentSwissRules } from '@tcg-live/core';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, CircleHelp } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAdminData, useEventSnapshot } from '../../data';
import { Button, Dialog, Field, IconButton, Input, Select, Textarea, Tooltip, useToast } from '../../ui';
import { useShell } from '../shell/model';
import { tournamentDirectoryKey } from './directory';

export const gameLabel: Record<ArtworkGame, string> = {
  'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man', pokemon: 'Pokémon'
};

const scoringFields = [
  ['winPoints', 'Match win'], ['drawPoints', 'Match draw'], ['lossPoints', 'Match loss'],
  ['gameWinPoints', 'Game win'], ['gameTiePoints', 'Game tie'], ['byePoints', 'Pairing bye']
] as const;

export function CreateTournamentDialog({ open, defaultGame, initial, onClose, onSaved }: {
  open: boolean; defaultGame: ArtworkGame; initial?: TournamentDirectoryEntryDto; onClose(): void;
  onSaved(entry: TournamentDirectoryEntryDto): void;
}) {
  const { api, queryClient } = useAdminData();
  const shell = useShell();
  const toast = useToast();
  const [game, setGame] = useState<ArtworkGame>(defaultGame);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [signupTiming, setSignupTiming] = useState<'immediate' | 'scheduled'>('immediate');
  const [signupStart, setSignupStart] = useState('');
  const plannedSignupMs = signupStart ? new Date(signupStart).getTime() : NaN;
  const immediateSignupMs = useRef<number | null>(null);
  const startsAtMs = start ? new Date(start).getTime() : NaN;
  const hasFutureStart = Number.isFinite(startsAtMs) && startsAtMs > Date.now();
  const validSignupTiming = signupTiming === 'immediate' ||
    (Number.isFinite(plannedSignupMs) && plannedSignupMs > Date.now() && plannedSignupMs < startsAtMs);
  const [description, setDescription] = useState('');
  const [minutes, setMinutes] = useState(String(DEFAULT_MATCH_MINUTES));
  const [capacity, setCapacity] = useState(String(DEFAULT_SIGNUP_CAPACITY));
  const [swissRules, setSwissRules] = useState<TournamentSwissRules>(DEFAULT_TOURNAMENT_SWISS_RULES);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [bannerOverride, setBannerOverride] = useState<SignupBannerStyle>();
  const [channelOverride, setChannelOverride] = useState<string>();
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
    const selectedGame = initial?.game ?? defaultGame;
    setGame(selectedGame);
    setName(initial?.name ?? `${gameLabel[selectedGame]} Tournament`);
    setStart('');
    setSignupTiming('immediate');
    setSignupStart('');
    immediateSignupMs.current = null;
    setDescription(initial?.description ?? '');
    setMinutes(String(initial?.matchMinutes ?? DEFAULT_MATCH_MINUTES));
    setCapacity(String(initial?.signupCapacity ?? DEFAULT_SIGNUP_CAPACITY));
    setSwissRules(initial?.swissRules ?? DEFAULT_TOURNAMENT_SWISS_RULES);
    setRulesOpen(false);
    setBannerOverride(initial ? initial.bannerStyle ?? 'game' : undefined);
    setChannelOverride(initial ? initial.signupChannelId ?? '' : undefined);
    setError(null);
    draftId.current = null;
  }, [open, defaultGame, initial]);

  async function save(asDraft: boolean) {
    if (busy || (!asDraft && (!hasFutureStart || !validSignupTiming)) || !form.current?.reportValidity()) return;
    setBusy(true);
    setError(null);
    draftId.current ??= crypto.randomUUID();
    try {
      if (!asDraft && signupTiming === 'immediate') immediateSignupMs.current ??= Date.now();
      const entry = await api.createTournamentDraft({
        draftId: draftId.current, name: name.trim() || undefined, game, description: description.trim(),
        startsAtMs: Number.isFinite(startsAtMs) ? startsAtMs : undefined,
        signupOpensAtMs: asDraft ? undefined : signupTiming === 'immediate' ? immediateSignupMs.current ?? undefined : plannedSignupMs,
        matchMinutes: Number(minutes), signupCapacity: Number(capacity), swissRules, bannerStyle, signupChannelId: signupChannelId || undefined
      });
      await queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey });
      if (!asDraft) toast.show({ title: signupTiming === 'immediate' ? 'Discord signup queued' : 'Discord signup scheduled', tone: 'success' });
      onSaved(entry);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The tournament could not be saved.');
    } finally { setBusy(false); }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (unavailable || busy || !hasFutureStart || !validSignupTiming) return;
    void save(false);
  };
  function changeRule<Key extends keyof TournamentSwissRules>(key: Key, value: TournamentSwissRules[Key]) {
    setSwissRules(current => ({ ...current, [key]: value }));
  }

  const fieldsLocked = busy;

  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} dismissible={!busy} width="lg"
    title={initial?.isTemplate ? 'Create from template' : initial ? 'Restart tournament' : 'Create signup tournament'} description="Choose when Discord signup opens and when match play can begin."
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="secondary" disabled={busy} onClick={() => { void save(true); }}>Save as draft</Button>
      <Button variant="primary" type="submit" form="create-tournament-form" disabled={busy || unavailable || !hasFutureStart || !validSignupTiming}>
        {busy ? 'Saving…' : 'Create'}
      </Button></>}>
    <form id="create-tournament-form" ref={form} className="space-y-5" onSubmit={submit}
      onInvalidCapture={event => {
        const details = event.target instanceof Element ? event.target.closest('details') : null;
        if (details) details.open = true;
      }}>
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
        <Field label="Tournament start date and time" description={`Match play can begin at this time. Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`}>
          <Input type="datetime-local" value={start} disabled={fieldsLocked} onChange={event => setStart(event.target.value)} />
        </Field>
        <Field label="Signup opens" description="The bot posts the signup panel in the selected Discord channel.">
          <Select value={signupTiming} disabled={fieldsLocked}
            onChange={event => setSignupTiming(event.target.value === 'scheduled' ? 'scheduled' : 'immediate')}>
            <option value="immediate">Immediately</option>
            <option value="scheduled">Choose a date and time</option>
          </Select>
        </Field>
        {signupTiming === 'scheduled' && <Field label="Signup opening date and time" description="Choose a time before the tournament starts.">
          <Input type="datetime-local" value={signupStart} disabled={fieldsLocked} onChange={event => setSignupStart(event.target.value)} />
        </Field>}
        {signupTiming === 'scheduled' && signupStart && !validSignupTiming && <p className="text-sm text-warning">
          Signup must open in the future and before the tournament starts.
        </p>}
        {start && !hasFutureStart && <p className="text-sm text-warning">Choose a start time in the future to create this tournament.</p>}
        <details className="group rounded-lg border border-line bg-raised"
          open={rulesOpen} onToggle={event => setRulesOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg p-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span>Rule settings</span>
            <span className="flex items-center gap-2 text-xs font-normal text-fg-muted">
              {capacity || '—'} players · {minutes || '—'} min
              <ChevronDown aria-hidden className="size-4 shrink-0 -rotate-90 group-open:rotate-0" />
            </span>
          </summary>
          <div className="grid items-start gap-4 px-4 pb-4 sm:grid-cols-2">
            <Field label="Signup limit" required description="The maximum number of players who can join. Round one pairs players who check in.">
              <Input type="number" min={4} max={MAX_SIGNUP_CAPACITY} step={1} value={capacity} disabled={fieldsLocked}
                onChange={event => setCapacity(event.target.value)} />
            </Field>
            <Field label="Match timer in minutes" required labelAction={
              <Tooltip content="Each match gets this many minutes. The clock starts once both players click Ready. When it expires, a judge is needed to resolve the match.">
                <IconButton size="sm" className="!size-6" aria-label="How the match timer works" icon={<CircleHelp aria-hidden />} />
              </Tooltip>
            }>
              <Input type="number" min={1} max={MAX_MATCH_MINUTES} step={1} value={minutes} disabled={fieldsLocked}
                onChange={event => setMinutes(event.target.value)} />
            </Field>
          </div>
          <fieldset disabled={fieldsLocked} className="mx-4 mb-4 space-y-4 border-t border-line pt-4">
            <legend className="sr-only">Swiss rules</legend>
            <div>
              <h3 className="text-sm font-semibold">Swiss rules</h3>
              <p className="mt-1 text-xs text-fg-muted">Saved with this tournament. Swiss pairing and scoring are pending. The current rehearsal runs one best-of-one camera round.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Match format">
                <Select value={swissRules.matchFormat} onChange={event => changeRule('matchFormat', event.target.value === 'bo3' ? 'bo3' : 'bo1')}>
                  <option value="bo1">Best of one</option>
                  <option value="bo3">Best of three</option>
                </Select>
              </Field>
              <Field label="Swiss rounds" required description="0 suggests a round count from checked-in attendance.">
                <Input type="number" min={0} max={30} step={1} value={Number.isNaN(swissRules.roundCount) ? '' : swissRules.roundCount}
                  onChange={event => changeRule('roundCount', event.currentTarget.valueAsNumber)} />
              </Field>
              <Field label="Tournament finish">
                <Select value={swissRules.finish} onChange={event => changeRule('finish', event.target.value === 'playoffs' ? 'playoffs' : 'standings')}>
                  <option value="standings">Standings</option>
                  <option value="playoffs">Playoffs</option>
                </Select>
              </Field>
              <Field label="Next-round release">
                <Select value={swissRules.roundRelease} onChange={event => changeRule('roundRelease', event.target.value === 'manual' ? 'manual' : 'automatic')}>
                  <option value="automatic">Automatic after results are final</option>
                  <option value="manual">Organizer releases the round</option>
                </Select>
              </Field>
            </div>
            <div>
              <h4 className="mb-3 text-sm font-semibold">Scoring points</h4>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {scoringFields.map(([key, label]) => <Field key={key} label={label} required>
                  <Input type="number" min={0} max={100} step="any"
                    value={Number.isNaN(swissRules[key]) ? '' : swissRules[key]}
                    onChange={event => changeRule(key, event.currentTarget.valueAsNumber)} />
                </Field>)}
              </div>
              <p className="mt-3 text-xs text-fg-muted">With odd attendance, one player gets a pairing bye. Fewest prior byes comes first, then lowest points, then a random draw. An assigned opponent’s no-show goes to a judge.</p>
            </div>
          </fieldset>
        </details>
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
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>}
    </form>
  </Dialog>;
}
