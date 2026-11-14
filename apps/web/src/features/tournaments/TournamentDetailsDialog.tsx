import { ARTWORK_GAMES, type ArtworkGame, type SignupBannerStyle, type TournamentDetailsDto } from '@tcg-live/core';
import { useEffect, useState, type FormEvent } from 'react';
import { useAdminData } from '../../data';
import { Button, Dialog, Field, Input, Select, Textarea } from '../../ui';
import { tournamentDirectoryKey } from './directory';
import { useShell } from '../shell/model';
import { TournamentRuleSummary } from './TournamentRuleSummary';
import { gameLabel } from './CreateTournamentDialog';

export function TournamentDetailsDialog({ open, eventId, capacity, onClose }: {
  open: boolean; eventId: string; capacity?: number; onClose(): void;
}) {
  const { api, queryClient } = useAdminData();
  const tournament = useShell().directory?.entries.find(entry => entry.eventId === eventId);
  const [name, setName] = useState('');
  const [game, setGame] = useState<ArtworkGame>('pokemon');
  const [description, setDescription] = useState('');
  const [bannerStyle, setBannerStyle] = useState<SignupBannerStyle | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const path = `/tournaments/${encodeURIComponent(eventId)}/details`;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoaded(false); setError(null); setMessage(null);
    void api.request<TournamentDetailsDto>('GET', path, { signal: abort.signal }).then(value => {
      if (abort.signal.aborted) return;
      setName(value.name); setGame(value.game ?? 'pokemon'); setDescription(value.description); setBannerStyle(value.bannerStyle); setLoaded(true);
      if (!value.configured) setMessage('No tournament details saved yet. Choose the game and title, then save.');
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Details could not be loaded.'); });
    return () => abort.abort();
  }, [open, eventId, api, path]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !loaded) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const value = await api.request<TournamentDetailsDto>('PUT', path, { body: { name: name.trim(), game, description: description.trim(), bannerStyle } });
      setMessage(value.applyStatus === 'applied' ? 'Saved and updated the Discord signup panel.' :
        'Details saved. Discord update pending; save again to retry, or use Refresh panels to repair missing panels.');
      await queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Details could not be saved.'); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onClose={onClose} dismissible={!busy} title="Tournament details"
    description="Shown on the Discord signup banner. Saving also selects this game’s banner artwork."
    footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Done</Button>
      <Button variant="primary" type="submit" form="tournament-details-form" disabled={busy || !loaded}>
        {busy ? 'Saving…' : 'Save details'}
      </Button></>}>
    <form id="tournament-details-form" onSubmit={event => void save(event)} className="space-y-4">
      <Field label="Tournament title" required><Input value={name} maxLength={80} required disabled={busy || !loaded}
        onChange={event => setName(event.target.value)} /></Field>
      <Field label="Game" required><Select value={game} disabled={busy || !loaded}
        onChange={event => setGame(event.target.value as ArtworkGame)}>
        {ARTWORK_GAMES.map(item => <option key={item} value={item}>{gameLabel[item]}</option>)}
      </Select></Field>
      <Field label="Signup banner"><Select value={bannerStyle ?? 'game'} disabled={busy || !loaded}
        onChange={event => setBannerStyle(event.target.value === 'compact' ? 'compact' : 'game')}>
        <option value="game">Full game banner</option>
        <option value="compact">Compact artwork</option>
      </Select></Field>
      <Field label="Description" description="Optional, up to 500 characters. Keep signup instructions short.">
        <Textarea value={description} maxLength={500} rows={4} disabled={busy || !loaded}
          onChange={event => setDescription(event.target.value)} />
      </Field>
      <TournamentRuleSummary capacity={capacity} matchMinutes={tournament?.matchMinutes} swissRules={tournament?.swissRules} />
      {message && <p role="status" className="text-sm text-fg-muted">{message}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
  </Dialog>;
}
