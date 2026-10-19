// Owned by L5 (web-flow): renders the live canvas for every core fixture, in both views, light and dark.
// `#/__flow?fixture=liveDispute` limits the page to one fixture; `&view=match` to one view.
import type { EventSnapshotDto, MatchId } from '@tcg-live/core';
import { FIXTURE_NOW_MS, snapshots, type SnapshotFixtureName } from '@tcg-live/core/fixtures';
import { useState } from 'react';
import { LivePreview, type FlowView } from '../features/flow';
import { GalleryFrame } from './GalleryFrame';

/** Fixed server time: every fixture clock renders deterministically. */
const fixedNow = (): number => FIXTURE_NOW_MS;

/** Live-ticking server time that starts at the fixture's "now". */
const pageLoadedAt = Date.now();
const tickingNow = (): number => FIXTURE_NOW_MS + (Date.now() - pageLoadedAt);

const FIXTURE_NAMES = Object.keys(snapshots) as SnapshotFixtureName[];

function readFilter(): { fixtures: SnapshotFixtureName[]; views: FlowView[] } {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const fixture = query.get('fixture');
  const view = query.get('view');
  return {
    fixtures: fixture && fixture in snapshots ? [fixture as SnapshotFixtureName] : FIXTURE_NAMES,
    views: view === 'event' || view === 'match' ? [view] : ['event', 'match']
  };
}

function Specimen({ title, snapshot, initialView, initialMatch = null, getServerNow, height = 340 }: {
  title: string; snapshot: EventSnapshotDto; initialView: FlowView; initialMatch?: MatchId | null;
  getServerNow: () => number; height?: number;
}) {
  const [view, setView] = useState<FlowView>(initialView);
  const [matchId, setMatchId] = useState<MatchId | null>(initialMatch);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="flex items-baseline gap-2 text-xs text-fg-muted">
        <span className="font-semibold text-fg">{title}</span>
        <span>view: {view}{view === 'match' ? ` · ${matchId ?? 'auto'}` : ''}</span>
      </figcaption>
      <div className="overflow-hidden rounded-lg shadow-hairline" style={{ height }}>
        <LivePreview snapshot={snapshot} view={view} matchId={matchId} getServerNow={getServerNow}
          onViewChange={(next, id) => { setView(next); setMatchId(id); }} />
      </div>
    </figure>
  );
}

export function FlowGallery() {
  const { fixtures, views } = readFilter();
  return (
    <GalleryFrame title="Live canvas">
      {() => (
        <div className="flex flex-col gap-6">
          <Specimen title="liveDispute · live-ticking clock" snapshot={snapshots.liveDispute} initialView="event"
            getServerNow={tickingNow} />
          {fixtures.flatMap(name => views.map(view => (
            <Specimen key={`${name}-${view}`} title={`${name} · ${view}`} snapshot={snapshots[name]}
              initialView={view} getServerNow={fixedNow} height={view === 'match' ? 380 : 320} />
          )))}
          {fixtures.includes('liveInterrupted') && views.includes('match') && (
            <Specimen title="liveInterrupted · match M1 (interrupted clock)" snapshot={snapshots.liveInterrupted}
              initialView="match" initialMatch="M1" getServerNow={fixedNow} height={380} />
          )}
        </div>
      )}
    </GalleryFrame>
  );
}
