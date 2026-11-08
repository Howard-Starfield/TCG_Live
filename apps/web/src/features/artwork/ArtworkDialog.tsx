import { ARTWORK_GAMES, ARTWORK_SLOTS, type ArtworkGame, type ArtworkProfileDto, type ArtworkSlot } from '@tcg-live/core';
import { useEffect, useRef, useState } from 'react';
import { useAdminData } from '../../data';
import { Button, Dialog, Field, Select } from '../../ui';

const labels: Record<ArtworkGame, string> = {
  'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man', pokemon: 'Pokémon'
};
const MAX_BYTES = 4 * 1024 * 1024;

async function readError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return new Error(body.error?.message || `Request failed (${response.status}).`);
  } catch { return new Error(`Request failed (${response.status}).`); }
}

/** Binary artwork requests use the signed-in session token and never put it in a URL. */
function useArtworkApi() {
  const { session } = useAdminData();
  return async (method: string, path: string, body?: BodyInit, contentType?: string, signal?: AbortSignal): Promise<Response> => {
    const token = session.getToken();
    if (!token) throw new Error('Sign in to edit artwork.');
    const response = await fetch(`/api/v1/artwork${path}`, { method, body, signal, cache: 'no-store', credentials: 'omit',
      headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) } });
    if (!response.ok) {
      if (response.status === 401) session.handleUnauthorized(token);
      throw await readError(response);
    }
    return response;
  };
}

function Preview({ game, slot, revision, request }: { game: ArtworkGame; slot: ArtworkSlot;
  revision: string | null; request: ReturnType<typeof useArtworkApi> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    setUrl(null); setError(false);
    if (!revision) return;
    const abort = new AbortController();
    void request('GET', `/${game}/${slot}/preview`, undefined, undefined, abort.signal).then(async response => {
      if (response.status === 204) return;
      const blob = await response.blob();
      if (live) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(() => { if (live && !abort.signal.aborted) setError(true); });
    return () => { live = false; abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [game, slot, revision]);
  if (error) return <p role="alert" className="text-xs text-danger">Preview unavailable. The bot will use its status artwork if this file is missing.</p>;
  if (!revision) return <p className="text-xs text-fg-muted">No compact image selected. Status artwork is used.</p>;
  if (!url) return <p role="status" className="text-xs text-fg-muted">Loading preview…</p>;
  return <img src={url} alt={`${labels[game]} ${slot} preview`} className={slot === 'banner' ?
    'max-h-48 w-full rounded-md border border-line bg-sunken object-contain' :
    'h-24 w-24 rounded-md border border-line bg-sunken object-contain'} />;
}

export function ArtworkDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const request = useArtworkApi();
  const [profile, setProfile] = useState<ArtworkProfileDto | null>(null);
  const [game, setGame] = useState<ArtworkGame>('one-piece');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputs = useRef<Record<ArtworkSlot, HTMLInputElement | null>>({ banner: null, thumbnail: null });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null); setMessage(null);
    void request('GET', '').then(response => response.json() as Promise<ArtworkProfileDto>).then(next => {
      if (live) { setProfile(next); if (next.activeGame) setGame(next.activeGame); }
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'Artwork could not be loaded.'); });
    return () => { live = false; };
  }, [open]);

  const change = async (method: string, path: string, body?: BodyInit, contentType?: string) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await request(method, path, body, contentType);
      setProfile(await response.json() as ArtworkProfileDto);
      setMessage('Saved. Refresh the existing Discord panels to apply this change now; future notices use it automatically.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Artwork could not be saved.'); }
    finally { setBusy(false); }
  };

  const upload = (slot: ArtworkSlot, file: File | undefined) => {
    if (!file) return;
    if (!['image/gif', 'image/png', 'image/jpeg'].includes(file.type) || file.size < 1 || file.size > MAX_BYTES) {
      setError('Choose a GIF, PNG or JPEG image up to 4 MB.');
      return;
    }
    void change('PUT', `/${game}/${slot}`, file, file.type);
    const input = inputs.current[slot];
    if (input) input.value = '';
  };
  const selectGame = () => void change('PUT', '/active-game', JSON.stringify({ game }), 'application/json');
  const clearGame = () => void change('PUT', '/active-game', JSON.stringify({ game: null }), 'application/json');

  return <Dialog open={open} onClose={onClose} title="Game artwork" width="lg"
    description="Choose artwork for each game. The active game determines which visuals the bot uses."
    footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
    <div className="space-y-5">
      <Field label="Game">
        <Select value={game} onChange={event => setGame(event.target.value as ArtworkGame)} disabled={busy}>
          {ARTWORK_GAMES.map(item => <option key={item} value={item}>{labels[item]}</option>)}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy || !profile || profile.activeGame === game} onClick={selectGame}>Use {labels[game]}</Button>
        {profile?.activeGame && <Button variant="ghost" size="sm" disabled={busy} onClick={clearGame}>Use status artwork</Button>}
        <span className="text-xs text-fg-muted">Current: {profile?.activeGame ? labels[profile.activeGame] : 'Status artwork'}</span>
      </div>
      {error && <p role="alert" className="rounded-md border border-danger p-2 text-sm text-danger">{error}</p>}
      {profile?.loadIssue && <p role="alert" className="rounded-md border border-danger p-2 text-sm text-danger">{profile.loadIssue}</p>}
      {message && <p role="status" className="rounded-md border border-line bg-sunken p-2 text-xs text-fg-muted">{message}</p>}
      {!profile && !error && <p role="status" className="text-sm text-fg-muted">Loading artwork…</p>}
      {profile && <div className="grid gap-3 sm:grid-cols-2">
        {ARTWORK_SLOTS.map(slot => {
          const selected = profile.games[game][slot];
          return <section key={slot} aria-label={slot === 'banner' ? 'Tournament banner' : 'Compact thumbnail'}
            className="space-y-3 rounded-lg border border-line bg-raised p-3">
            <div><h3 className="text-sm font-semibold text-fg">{slot === 'banner' ? 'Tournament banner' : 'Compact thumbnail'}</h3>
              <p className="text-xs text-fg-muted">{slot === 'banner' ?
                'Shown on signup and check-in panels.' : 'Shown on match cards, reminders and notices.'}</p></div>
            <div className="flex min-h-28 items-center justify-center rounded-md bg-sunken p-2">
              <Preview game={game} slot={slot} revision={selected.revision} request={request} />
            </div>
            <p className="text-xs text-fg-subtle">{selected.source === 'default' ? 'Packaged GIF' :
              selected.source === 'custom' ? `Custom ${selected.contentType?.replace('image/', '').toUpperCase()}` :
              'No custom thumbnail'}</p>
            <div className="flex flex-wrap gap-2">
              <input ref={element => { inputs.current[slot] = element; }} type="file" accept="image/gif,image/png,image/jpeg"
                className="sr-only" aria-label={`Choose ${slot} image`} onChange={event => upload(slot, event.target.files?.[0])} />
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => inputs.current[slot]?.click()}>Upload image</Button>
              {selected.source === 'custom' && <Button size="sm" variant="ghost" disabled={busy}
                onClick={() => void change('DELETE', `/${game}/${slot}`)}>
                {slot === 'banner' ? 'Restore packaged GIF' : 'Use status artwork'}</Button>}
            </div>
          </section>;
        })}
      </div>}
    </div>
  </Dialog>;
}
