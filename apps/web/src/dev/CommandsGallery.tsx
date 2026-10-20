// Owned by L10 (web-commands): action slots, dialogs and the composer per fixture, light and dark.
// A fake command client answers after a short delay, so pending states and toasts are visible;
// `#/__commands?outcome=pending|warning|conflict|rule` picks the answer.
import { CAPABILITIES, type AdminCommandResultDto, type EventSnapshotDto, type SessionDto } from '@tcg-live/core';
import { checkin, FIXTURE_NOW_MS, final, liveDispute, signupOpen } from '@tcg-live/core/fixtures';
import { useMemo, type ReactNode } from 'react';
import { ApiError } from '../data';
import { CommandsProvider, ConsoleComposer, EventActions, MatchActions, RemoveMemberAction, type CommandClient } from '../features/commands';
import { NeedsYou, StageStepper } from '../features/console';
import { FixtureDataProvider } from '../features/lists/fixtureData';
import { ToastProvider } from '../ui';
import { GalleryFrame } from './GalleryFrame';

const session: SessionDto = {
  principal: { kind: 'local', id: 'local-admin', label: 'Local admin' }, capabilities: [...CAPABILITIES],
  expiresAtMs: FIXTURE_NOW_MS + 3_600_000, idleExpiresAtMs: FIXTURE_NOW_MS + 3_600_000, mode: 'demo', commandsEnabled: true
};
const publishable: EventSnapshotDto = { ...checkin, checkins: ['A', 'B', 'C', 'D'], adminActions: ['publish', 'signupReopen'] };
const fullSignup: EventSnapshotDto = { ...signupOpen, signup: { ...signupOpen.signup!, roster: [...checkin.signup!.roster] },
  members: checkin.members, adminActions: ['signupClose', 'signupRemove'] };

function fakeClient(outcome: string | null): CommandClient {
  const wait = () => new Promise(resolve => setTimeout(resolve, 900));
  const answer = async (): Promise<AdminCommandResultDto> => {
    await wait();
    if (outcome === 'conflict') throw new ApiError({ code: 'conflict', status: 409, message: 'Precondition failed' });
    if (outcome === 'rule') throw new ApiError({ code: 'rule', status: 422, message: 'M2 has an open proposal; confirm or dispute it first.' });
    return { applied: true, result: 'ok', version: 1, cards: outcome === 'pending' ? 'pending' : 'updated',
      roomWarning: outcome === 'warning' ? 'Could not move Seat D into the M2 voice room.' : null };
  };
  return {
    send: answer,
    refreshPanels: async () => { await answer(); return { cards: outcome === 'pending' ? 'pending' : 'refreshed', roomWarning: null }; }
  };
}

function Specimen({ title, snapshot, children }: { title: string; snapshot: EventSnapshotDto; children: (snapshot: EventSnapshotDto) => ReactNode }) {
  const outcome = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('outcome');
  const client = useMemo(() => fakeClient(outcome), [outcome]);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="text-xs font-semibold text-fg">{title}</figcaption>
      <div className="flex flex-col gap-3 rounded-xl bg-base p-3 shadow-hairline">
        <FixtureDataProvider snapshot={snapshot} liveTail={0}>
          <CommandsProvider session={session} client={client}>{children(snapshot)}</CommandsProvider>
        </FixtureDataProvider>
      </div>
    </figure>
  );
}

export function CommandsGallery() {
  return (
    <ToastProvider>
      <GalleryFrame title="Admin actions">
        {() => (
          <div className="flex flex-col gap-6">
            <Specimen title="Stepper row · check-in complete (publish, reopen, refresh)" snapshot={publishable}>
              {snapshot => <StageStepper snapshot={snapshot} status={undefined} frozen={false} />}
            </Specimen>
            <Specimen title="Stepper row · four joined (close signup) and player removal" snapshot={fullSignup}>
              {snapshot => (
                <>
                  <EventActions snapshot={snapshot} />
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                    {snapshot.signup!.roster.map(memberId => (
                      <li key={memberId} className="flex items-center justify-between rounded-md bg-raised px-2.5 py-1 shadow-raised">
                        {snapshot.members[memberId]?.displayName}<RemoveMemberAction snapshot={snapshot} memberId={memberId} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Specimen>
            <Specimen title="Decision card actions and the composer · live dispute" snapshot={liveDispute}>
              {snapshot => (
                <div className="flex h-[360px] flex-col justify-between gap-3">
                  <NeedsYou snapshot={snapshot} onOpenMatch={() => {}} readOnly={false} />
                  <ConsoleComposer snapshot={snapshot} />
                </div>
              )}
            </Specimen>
            <Specimen title="Matches row menus · final (corrections)" snapshot={final}>
              {snapshot => (
                <div className="flex gap-3">
                  {snapshot.matches.map(match => (
                    <span key={match.id} className="inline-flex items-center gap-1 rounded-md bg-raised px-2.5 py-1 text-[13px] shadow-raised">
                      {match.id} · {match.finalWinner} won <MatchActions snapshot={snapshot} match={match} variant="menu" />
                      <MatchActions snapshot={snapshot} match={match} />
                    </span>
                  ))}
                </div>
              )}
            </Specimen>
            <Specimen title="Retired event · no actions, no composer" snapshot={{ ...liveDispute, status: 'retired', retiredAtMs: FIXTURE_NOW_MS }}>
              {snapshot => (
                <>
                  <NeedsYou snapshot={snapshot} onOpenMatch={() => {}} readOnly />
                  <ConsoleComposer snapshot={snapshot} readOnly />
                </>
              )}
            </Specimen>
          </div>
        )}
      </GalleryFrame>
    </ToastProvider>
  );
}
