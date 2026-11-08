import type { TournamentDirectoryEntryDto } from '@tcg-live/core';
import { FileClock } from 'lucide-react';
import { shortDate } from '../shell/labels';

const GAME_LABEL: Record<string, string> = {
  'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man', pokemon: 'Pokémon'
};

/** Saved plans have no match snapshot or live actions. */
export function DraftDetails({ draft }: { draft: TournamentDirectoryEntryDto }) {
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
        Draft signup is not open. This tournament is saved for later and has no players or matches yet.
      </p>
    </section>
  </div>;
}
