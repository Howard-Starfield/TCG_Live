import { ArrowUpRight, FileClock, Gavel, House, ListChecks, Search, UserRound } from 'lucide-react';
import { DEFAULT_MATCH_MINUTES, type EventSnapshotDto, type TournamentDirectoryEntryDto } from '@tcg-live/core';
import { useEffect, useState } from 'react';
import { Button, IconButton, Input } from '../../ui';
import { gameLabel } from '../tournaments/CreateTournamentDialog';
import { eventLabel, STAGE_LABEL } from './labels';
import { useShell } from './model';
import { useTournamentDirectory } from '../tournaments/directory';
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
  const signup = snapshot.stage === 'signup';
  return <>
    <p className="home-card-count"><strong>{signup ? counts[0]?.value : assigned}</strong><span> of {capacity} {signup ? 'joined' : 'assigned'}</span></p>
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

function DraftCard({ draft }: { draft: TournamentDirectoryEntryDto }) {
  const shell = useShell();
  return <article className="home-event">
    <div className="home-event-heading">
      <div><p>Draft{draft.game && ` · ${gameLabel[draft.game]}`}</p><h3>{draft.name}</h3></div>
      <IconButton size="sm" aria-label={`Open ${draft.name}`} icon={<ArrowUpRight aria-hidden />}
        onClick={() => shell.selectDraft(draft)} />
    </div>
    <div className="home-draft-seats" aria-hidden="true">
      {['A', 'B', 'C', 'D'].map(seat => <span key={seat}><UserRound /></span>)}
    </div>
    <div className="home-draft-footer"><strong>Signup hasn’t opened</strong>
      <span>4 seats · BO1 · {draft.matchMinutes ?? DEFAULT_MATCH_MINUTES} min</span></div>
  </article>;
}

export function Home() {
  const shell = useShell();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 220);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => { setSearch(''); setQuery(''); }, [shell.draftsOpen]);
  const searching = !!search.trim();
  const searchEnabled = !!shell.session.tournaments && !!query;
  const results = useTournamentDirectory(query, searchEnabled);
  const active = shell.events.find(event => event.eventId === shell.activeEventId);
  const snapshot = shell.viewed.snapshot?.status === 'active' ? shell.viewed.snapshot : undefined;
  const activeId = shell.activeEventId;
  const named = shell.directory?.entries.find(entry => entry.eventId === activeId);
  const drafts = (shell.directory?.entries ?? []).filter(entry => entry.status === 'draft')
    .sort((left, right) => right.createdAtMs - left.createdAtMs);
  const visibleDrafts = shell.draftsOpen ? drafts : drafts.slice(0, activeId ? 2 : 3);
  const localResults = shell.events.map(event => ({ ...event, game: null, name: eventLabel(event) }))
    .filter(event => event.name.toLowerCase().includes(search.trim().toLowerCase()));
  const matches = (shell.session.tournaments ? results.data?.entries ?? [] : localResults)
    .filter(entry => !shell.draftsOpen || entry.status === 'draft');
  const openMatches = snapshot?.matches.filter(match => match.phase !== 'final') ?? [];
  const judges = openMatches.filter(match => match.judge);
  const decisions = openMatches.filter(match => match.proposal?.decision === 'open');
  const countsAvailable = !!snapshot || (!activeId && shell.eventsState === 'ready' && shell.status?.database !== 'unavailable');
  return <div className="home-page">
    <div className="home-inner">
      <h1><span className="home-icon">{shell.draftsOpen ? <FileClock aria-hidden /> : <House aria-hidden />}</span>
        {shell.draftsOpen ? 'Drafts' : 'Home'}</h1>
      <div className="home-search">
        <Search aria-hidden />
        <Input type="search" value={search} maxLength={120}
          aria-label={shell.draftsOpen ? 'Search saved drafts' : 'Search all tournaments'}
          placeholder={shell.draftsOpen ? 'Search saved drafts' : 'Search tournaments by name, game or status'}
          onChange={event => setSearch(event.target.value)} />
      </div>
      {searching ? <section aria-labelledby="home-results">
        <h2 id="home-results" className="mb-3">Search results</h2>
        {shell.session.tournaments && (search.trim() !== query || results.isPending) ? <p role="status">Searching…</p>
          : results.isError ? <p role="alert">{results.error.message}</p>
          : matches.length ? <ul className="home-results">{matches.map(entry => <li key={entry.eventId}>
            <button type="button" onClick={() => entry.status === 'draft' ? shell.selectDraft(entry) : shell.selectEvent(entry.eventId)}>
              <span><strong>{entry.name}</strong><small>{entry.status}{entry.game && ` · ${gameLabel[entry.game]}`}</small></span>
              <ArrowUpRight aria-hidden />
            </button>
          </li>)}</ul> : <p className="home-empty">No matching tournaments.</p>}
      </section> : <>
      <section aria-labelledby="home-events">
        <div className="home-section-heading">
          <h2 id="home-events">{shell.draftsOpen ? 'Saved drafts' : 'Upcoming and live'}</h2>
          {!shell.draftsOpen && activeId && <Button variant="ghost" size="sm" onClick={shell.followActive}>Open live event</Button>}
        </div>
        <div className="home-events">
          {!shell.draftsOpen && activeId && <article className="home-event">
            <div className="home-event-heading">
              <div><p>{snapshot ? STAGE_LABEL[snapshot.stage] : 'Live event'}{named?.game && ` · ${gameLabel[named.game]}`}</p>
                <h3>{named?.name ?? (active ? eventLabel(active) : 'Live tournament')}</h3></div>
              <IconButton size="sm" aria-label="Open tournament" icon={<ArrowUpRight aria-hidden />} onClick={shell.followActive} />
            </div>
            {snapshot ? <PlayerChart snapshot={snapshot} /> : <p className="home-event-empty">
              {shell.viewed.status === 'error' ? 'Player counts unavailable.' : 'Loading player counts…'}</p>}
          </article>}
          {visibleDrafts.map(draft => <DraftCard key={draft.eventId} draft={draft} />)}
          {(shell.draftsOpen || !activeId) && visibleDrafts.length === 0 && <p className="home-empty">
            {shell.eventsState === 'loading' || shell.directoryState === 'loading' ? 'Loading tournaments…' :
              shell.eventsState === 'error' || shell.directoryState === 'error' ? 'Tournaments could not be loaded.' :
                shell.draftsOpen ? 'No saved drafts.' : 'No live events or saved drafts.'}
          </p>}
        </div>
      </section>
      {!shell.draftsOpen && <section className="home-actions" aria-labelledby="home-actions">
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
      </section>}
      </>}
    </div>
  </div>;
}
