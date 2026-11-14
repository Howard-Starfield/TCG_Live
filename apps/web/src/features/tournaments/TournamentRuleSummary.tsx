import { ChevronDown } from 'lucide-react';
import type { TournamentSwissRules } from '@tcg-live/core';

export function TournamentRuleSummary({ capacity, matchMinutes, swissRules }: {
  capacity?: number;
  matchMinutes?: number;
  swissRules?: TournamentSwissRules;
}) {
  const scoring = swissRules && [
    ['Match win', swissRules.winPoints], ['Match draw', swissRules.drawPoints], ['Match loss', swissRules.lossPoints],
    ['Game win', swissRules.gameWinPoints], ['Game tie', swissRules.gameTiePoints], ['Pairing bye', swissRules.byePoints]
  ] as const;

  return <details className="group rounded-lg border border-line bg-raised">
    <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg p-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
      Rule settings
      <ChevronDown aria-hidden className="size-4 -rotate-90 text-fg-muted group-open:rotate-0" />
    </summary>
    <div className="space-y-3 px-3 pb-3 text-sm">
      <dl className="grid grid-cols-2 gap-3">
        {capacity !== undefined && <div><dt className="text-fg-muted">Signup limit</dt><dd>{capacity} players</dd></div>}
        {matchMinutes !== undefined && <div><dt className="text-fg-muted">Match timer</dt><dd>{matchMinutes} minutes</dd></div>}
      </dl>
      {swissRules && scoring ? <>
        <p className="text-fg-muted">Saved Swiss settings. The current bot runs one best-of-one camera round.</p>
        <dl className="grid grid-cols-2 gap-3">
          <div><dt className="text-fg-muted">Match format</dt><dd>{swissRules.matchFormat === 'bo3' ? 'Best of three' : 'Best of one'}</dd></div>
          <div><dt className="text-fg-muted">Swiss rounds</dt><dd>{swissRules.roundCount || 'Automatic from attendance'}</dd></div>
          <div><dt className="text-fg-muted">Tournament finish</dt><dd>{swissRules.finish === 'playoffs' ? 'Playoffs' : 'Standings'}</dd></div>
          <div><dt className="text-fg-muted">Next-round release</dt><dd>{swissRules.roundRelease === 'manual' ? 'Organizer releases the round' : 'Automatic after final results'}</dd></div>
          {scoring.map(([label, points]) => <div key={label}><dt className="text-fg-muted">{label}</dt><dd>{points} points</dd></div>)}
        </dl>
      </> : <p className="text-fg-muted">This tournament uses the rehearsal format. No Swiss settings have been saved for it.</p>}
    </div>
  </details>;
}
