import type { OpenTournamentSignupRequest, OpenTournamentSignupResult, TournamentDirectoryEntryDto } from '@tcg-live/core';
import { FileClock } from 'lucide-react';
import { useState } from 'react';
import { adminKeys, useAdminData } from '../../data';
import { Button, ConfirmDialog, useToast } from '../../ui';
import { shortDate } from '../shell/labels';
import { useShell } from '../shell/model';
import { tournamentDirectoryKey } from './directory';

const GAME_LABEL: Record<string, string> = {
  'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man', pokemon: 'Pokémon'
};

export function DraftDetails({ draft }: { draft: TournamentDirectoryEntryDto }) {
  const shell = useShell();
  const { api, queryClient } = useAdminData();
  const toast = useToast();
  const [confirm, setConfirm] = useState<OpenTournamentSignupRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.request<OpenTournamentSignupResult>('POST',
        `/tournaments/${encodeURIComponent(draft.eventId)}/open-signup`, { body: confirm });
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey }),
        queryClient.invalidateQueries({ queryKey: adminKeys.events() })
      ]);
      toast.show(result.panels === 'posted'
        ? { title: 'Signup opened in Discord', tone: 'success' }
        : { title: 'Signup opened. Discord panels need attention.', description: 'Use Refresh panels on the live tournament.' });
      shell.selectEvent(result.eventId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Signup could not be opened.');
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };
  return <div className="flex h-full min-h-0 items-start justify-center overflow-y-auto p-6 sm:p-10">
    <section aria-label="Tournament draft" className="console-card w-full max-w-[640px] p-6">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <FileClock className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Draft</p>
          <h1 className="mt-1 break-words text-xl font-semibold text-fg">{draft.name}</h1>
          <p className="mt-1 text-xs text-fg-muted">{draft.game ? GAME_LABEL[draft.game] : 'Game not selected'} · Created {shortDate(draft.createdAtMs)}</p>
        </div>
      </div>
      <p className="mt-5 rounded-lg bg-line-faint p-3 text-sm text-fg-muted">
        Draft signup is not open. Open signup when you’re ready for players to join in the configured Discord channel.
      </p>
      {shell.session.commandsEnabled ? <Button className="mt-4" onClick={() => {
        setError(null);
        setConfirm({ expectedActiveEventId: shell.activeEventId });
      }}>Open signup</Button> : <p className="mt-4 text-sm text-fg-muted">
        Enable tournament commands in this console to open signup.
      </p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <ConfirmDialog open={confirm !== null} pending={busy} onCancel={() => setConfirm(null)}
        onConfirm={() => { void open(); }} title={`Open signup for ${draft.name}?`} confirmLabel="Open signup"
        description={confirm?.expectedActiveEventId && confirm.expectedActiveEventId !== draft.eventId
          ? 'The current tournament will move to History, and this tournament will take over its Discord panels. A round in progress must finish first.'
          : 'Players will be able to join in the configured Discord signup channel.'} />
    </section>
  </div>;
}
