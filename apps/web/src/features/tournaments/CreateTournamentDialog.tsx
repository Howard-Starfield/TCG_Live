import { ARTWORK_GAMES, type ArtworkGame, type TournamentDirectoryEntryDto } from '@tcg-live/core';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAdminData } from '../../data';
import { Button, Dialog, Field, Input, Select } from '../../ui';
import { tournamentDirectoryKey } from './directory';

export const gameLabel: Record<ArtworkGame, string> = {
  'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man', pokemon: 'Pokémon'
};

export function CreateTournamentDialog({ open, defaultGame, onClose, onSaved }: {
  open: boolean; defaultGame: ArtworkGame; onClose(): void;
  onSaved(entry: TournamentDirectoryEntryDto): void;
}) {
  const { api, queryClient } = useAdminData();
  const [game, setGame] = useState<ArtworkGame>(defaultGame);
  const [name, setName] = useState(`${gameLabel[defaultGame]} Tournament`);
  const [customName, setCustomName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftId = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setGame(defaultGame);
    setName(`${gameLabel[defaultGame]} Tournament`);
    setCustomName(false);
    setError(null);
    draftId.current = null;
  }, [open, defaultGame]);

  const changeGame = (next: ArtworkGame) => {
    setGame(next);
    if (!customName) setName(`${gameLabel[next]} Tournament`);
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    draftId.current ??= crypto.randomUUID();
    try {
      const entry = await api.createTournamentDraft({ draftId: draftId.current, name: name.trim() || undefined, game });
      await queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey });
      onSaved(entry);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The draft could not be saved.');
    } finally { setBusy(false); }
  };

  return <Dialog open={open} onClose={() => { if (!busy) onClose(); }} dismissible={!busy}
    title="Create signup tournament" description="Save a tournament draft for later. The current live event keeps running."
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="submit" form="create-tournament-form" disabled={busy}>
        {busy ? 'Saving…' : 'Save draft'}
      </Button></>}>
    <form id="create-tournament-form" className="space-y-4" onSubmit={event => void save(event)}>
      <Field label="Game" required>
        <Select value={game} disabled={busy} onChange={event => changeGame(event.target.value as ArtworkGame)}>
          {ARTWORK_GAMES.map(item => <option key={item} value={item}>{gameLabel[item]}</option>)}
        </Select>
      </Field>
      <Field label="Tournament name" description="Up to 80 characters. The name appears in the sidebar.">
        <Input value={name} maxLength={80} disabled={busy} onChange={event => { setName(event.target.value); setCustomName(true); }} />
      </Field>
      {error && <p role="alert" className="rounded-lg bg-danger-soft p-2 text-sm text-danger">{error}</p>}
    </form>
  </Dialog>;
}
