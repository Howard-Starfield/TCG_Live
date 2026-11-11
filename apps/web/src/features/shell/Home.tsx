import { ArrowUpRight, Gavel, House, ListChecks } from 'lucide-react';
import type { EventSnapshotDto } from '@tcg-live/core';
import { Button, IconButton } from '../../ui';
import { gameLabel } from '../tournaments/CreateTournamentDialog';
import { eventLabel, STAGE_LABEL } from './labels';
import { useShell } from './model';
import './home.css';

function PlayerChart({ snapshot }: { snapshot: EventSnapshotDto }) {
  const seats = Object.values(snapshot.seats);
  const assigned = seats.filter(seat => seat !== null).length;
  const capacity = snapshot.signup?.capacity ?? seats.length;
  const counts = [
    { label: 'Joined', value: snapshot.signup?.roster.length ?? assigned },
    { label: 'Assigned', value: assigned },
    { label: 'Checked in', value: snapshot.checkins.length }
  ];
  return <>
    <p className="home-card-count"><strong>{assigned}</strong><span> / {capacity} assigned</span></p>
    <ul className="home-chart" aria-label="Player counts">
      {counts.map(({ label, value }) => <li key={label}>
        <span className="home-chart-track" aria-hidden="true">
          <span style={{ height: `${100 * value / capacity}%` }} />
        </span>
        <span>{label}</span><strong>{value}</strong>
      </li>)}
    </ul>
  </>;
}

export function Home() {
  const shell = useShell();
  const active = shell.events.find(event => event.eventId === shell.activeEventId);
  const snapshot = shell.viewed.snapshot?.status === 'active' ? shell.viewed.snapshot : undefined;
  const activeId = shell.activeEventId;
  const named = shell.directory?.entries.find(entry => entry.eventId === activeId);
  const drafts = (shell.directory?.entries ?? []).filter(entry => entry.status === 'draft')
    .sort((left, right) => right.createdAtMs - left.createdAtMs).slice(0, activeId ? 2 : 3);
  const openMatches = snapshot?.matches.filter(match => match.phase !== 'final') ?? [];
  const judges = openMatches.filter(match => match.judge);
  const decisions = openMatches.filter(match => match.proposal?.decision === 'open');
  const countsAvailable = !!snapshot || (!activeId && shell.eventsState === 'ready' && shell.status?.database !== 'unavailable');
  return <div className="home-page">
    <div className="home-inner">
      <h1><span className="home-icon"><House aria-hidden /></span>Home</h1>
      <section aria-labelledby="home-events">
        <div className="home-section-heading">
          <h2 id="home-events">Upcoming and live</h2>
          {activeId && <Button variant="ghost" size="sm" onClick={shell.followActive}>Open live event</Button>}
        </div>
        <div className="home-events">
          {activeId && <article className="home-event">
            <div className="home-event-heading">
              <div><p>{snapshot ? STAGE_LABEL[snapshot.stage] : 'Live event'}{named?.game && ` · ${gameLabel[named.game]}`}</p>
                <h3>{named?.name ?? (active ? eventLabel(active) : 'Live tournament')}</h3></div>
              <IconButton size="sm" aria-label="Open tournament" icon={<ArrowUpRight aria-hidden />} onClick={shell.followActive} />
            </div>
            {snapshot ? <PlayerChart snapshot={snapshot} /> : <p className="home-event-empty">
              {shell.viewed.status === 'error' ? 'Player counts unavailable.' : 'Loading player counts…'}</p>}
          </article>}
          {drafts.map(draft => <article className="home-event" key={draft.eventId}>
            <div className="home-event-heading">
              <div><p>Draft{draft.game && ` · ${gameLabel[draft.game]}`}</p><h3>{draft.name}</h3></div>
              <IconButton size="sm" aria-label={`Open ${draft.name}`} icon={<ArrowUpRight aria-hidden />}
                onClick={() => shell.selectDraft(draft)} />
            </div>
            <p className="home-event-empty">Signup hasn’t opened.</p>
          </article>)}
          {!activeId && drafts.length === 0 && <p className="home-empty">
            {shell.eventsState === 'loading' || shell.directoryState === 'loading' ? 'Loading tournaments…' :
              shell.eventsState === 'error' || shell.directoryState === 'error' ? 'Tournaments could not be loaded.' : 'No live events or saved drafts.'}
          </p>}
        </div>
      </section>
      <section className="home-actions" aria-labelledby="home-actions">
        <h2 id="home-actions">Action needed</h2>
        <div className="home-action-grid">
          <div><Gavel aria-hidden className="text-danger" /><strong>{countsAvailable ? judges.length : '—'}</strong><h3>Judge needed</h3>
            {judges.map(match => <Button key={match.id} variant="ghost" size="sm"
              onClick={() => { shell.followActive(); shell.openMatch(match.id); }}>Match {match.id}</Button>)}</div>
          <div><ListChecks aria-hidden className="text-warning" /><strong>{countsAvailable ? decisions.length : '—'}</strong><h3>Decision needed</h3>
            {decisions.length > 0 && <p>Awaiting result confirmation</p>}
            {decisions.map(match => <Button key={match.id} variant="ghost" size="sm"
              onClick={() => { shell.followActive(); shell.openMatch(match.id); }}>Match {match.id}</Button>)}</div>
        </div>
      </section>
    </div>
  </div>;
}
