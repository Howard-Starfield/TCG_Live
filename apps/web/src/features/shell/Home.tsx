import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { ArrowUpRight, CircleCheck, Clock, Gavel, ListChecks, Plus, Search, UserRound } from 'lucide-react';
import { DEFAULT_MATCH_MINUTES, DEFAULT_SIGNUP_CAPACITY, type MatchDto, type TournamentDirectoryEntryDto } from '@tcg-live/core';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useServerNow } from '../../data';
import { Button, Input, Menu } from '../../ui';
import { CreateTournamentDialog, gameLabel } from '../tournaments/CreateTournamentDialog';
import { eventLabel, seatName, shortDate, STAGE_LABEL } from './labels';
import { useShell } from './model';
import { useTournamentDirectory } from '../tournaments/directory';
import { useTournamentMenu } from '../tournaments/useTournamentMenu';
import './home.css';

const PlayerChart = lazy(() => import('./PlayerChart'));

function DraftCard({ draft, menu }: { draft: TournamentDirectoryEntryDto; menu: ReturnType<typeof useTournamentMenu> }) {
  const shell = useShell();
  return <article className="home-event" onClick={event => {
    if (event.target instanceof Node && event.currentTarget.contains(event.target)) shell.selectDraft(draft);
  }}>
    <div className="home-event-heading">
      <div><p>{draft.startsAtMs === undefined ? 'Draft' : 'Pending'}{draft.game && ` · ${gameLabel[draft.game]}`}</p>
        <h3><Menu label={`Actions for ${draft.name}`} items={menu.items(draft, () => shell.selectDraft(draft))}
          openOnContext trigger={props => <button {...props} type="button" aria-label={`Open ${draft.name}`} title={draft.name}
            onClick={() => shell.selectDraft(draft)}>{draft.name}</button>} /></h3></div>
    </div>
    <div className="home-draft-seats" aria-hidden="true">
      {['A', 'B', 'C', 'D'].map(seat => <span key={seat}><UserRound /></span>)}
    </div>
    <div className="home-draft-footer"><strong>Signup hasn’t opened</strong>
      {draft.startsAtMs !== undefined && <span>Starts {shortDate(draft.startsAtMs)}</span>}
      <span>{draft.signupCapacity ?? DEFAULT_SIGNUP_CAPACITY} signup spots · BO1 · {draft.matchMinutes ?? DEFAULT_MATCH_MINUTES} min</span></div>
  </article>;
}

export function Home() {
  const shell = useShell();
  const tournamentMenu = useTournamentMenu();
  const reduceMotion = useReducedMotion();
  const [createOpen, setCreateOpen] = useState(false);
  const now = useServerNow(30_000);
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
  const entries = shell.directory?.entries ?? [];
  const active = shell.events.find(event => event.eventId === shell.activeEventId && event.status === 'active');
  const named = entries.find(entry => entry.eventId === shell.activeEventId && entry.status === 'active')
    ?? entries.find(entry => entry.status === 'active');
  const activeId = named?.eventId ?? active?.eventId;
  const snapshot = shell.viewed.snapshot?.eventId === activeId && shell.viewed.snapshot?.status === 'active'
    ? shell.viewed.snapshot : undefined;
  const liveTitle = named?.name ?? (active ? eventLabel(active) : 'Live tournament');
  const templates = entries.filter(entry => entry.isTemplate);
  const pending = entries.filter(entry => entry.status === 'draft' && !entry.isTemplate &&
    entry.signupOpensAtMs !== undefined && entry.startsAtMs !== undefined);
  const drafts = entries.filter(entry => entry.status === 'draft' && !entry.isTemplate && entry.signupOpensAtMs === undefined);
  const upcoming = pending.filter(entry => entry.startsAtMs! > now)
    .sort((left, right) => left.startsAtMs! - right.startsAtMs! || left.createdAtMs - right.createdAtMs);
  const visibleCards = shell.draftsOpen ? [...pending, ...drafts] : upcoming.slice(0, activeId ? 2 : 3);
  const canCreate = !!shell.session.tournaments && shell.session.commandsEnabled;
  const loaded = shell.eventsState !== 'loading' && shell.directoryState === 'ready';
  const quickCreateCount = !shell.draftsOpen && loaded && canCreate
    ? 3 - Number(!!activeId) - visibleCards.length : 0;
  const openActive = () => { if (activeId) shell.selectEvent(activeId); };
  const localResults: TournamentDirectoryEntryDto[] = shell.events.map(event => ({ ...event, game: null, name: eventLabel(event) }))
    .filter(event => event.name.toLowerCase().includes(search.trim().toLowerCase()));
  const matches = (shell.session.tournaments ? results.data?.entries ?? [] : localResults)
    .filter(entry => shell.draftsOpen ? entry.status === 'draft' :
      entry.status !== 'draft' || (!entry.isTemplate && entry.signupOpensAtMs !== undefined));
  const openMatches = snapshot?.matches.filter(match => match.phase !== 'final') ?? [];
  const judges = openMatches.filter(match => match.judge);
  const decisions = openMatches.filter(match => !match.judge && match.proposal?.decision === 'open');
  const underway = openMatches.filter(match => !match.judge && match.proposal?.decision !== 'open');
  const finished = snapshot?.matches.filter(match => match.phase === 'final') ?? [];
  const lanes = [
    { label: 'Judge needed', icon: Gavel, tone: 'danger', matches: judges },
    { label: 'Decision needed', icon: ListChecks, tone: 'warning', matches: decisions },
    { label: 'In progress', icon: Clock, tone: 'accent', matches: underway },
    { label: 'Done', icon: CircleCheck, tone: 'success', matches: finished }
  ];
  const matchStatus = (match: MatchDto) => {
    if (match.judge) {
      if (match.judge.reasons.includes('dispute')) return 'Result disputed';
      if (match.judge.reasons.includes('expired')) return 'Clock expired';
      return 'Judge requested';
    }
    if (match.phase === 'final') return snapshot && match.finalWinner ? `${seatName(snapshot, match.finalWinner)} won` : 'Result final';
    if (match.proposal?.decision === 'open') return 'Awaiting result confirmation';
    if (match.phase === 'setup') return 'Waiting for Ready';
    return match.phase === 'paused' ? 'Paused' : 'Playing';
  };
  const countsAvailable = !!snapshot || (!activeId && shell.eventsState === 'ready' && shell.status?.database !== 'unavailable');
  return <div className="home-page">
    <div className="home-inner">
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
            <button type="button" disabled={entry.isTemplate && !shell.session.commandsEnabled}
              onClick={() => entry.isTemplate ? tournamentMenu.startFrom(entry) : entry.status === 'draft' ? shell.selectDraft(entry) : shell.selectEvent(entry.eventId)}>
              <span><strong>{entry.name}</strong><small>{entry.isTemplate ? 'Template' : entry.status}{entry.game && ` · ${gameLabel[entry.game]}`}</small></span>
              <ArrowUpRight aria-hidden />
            </button>
          </li>)}</ul> : <p className="home-empty">No matching tournaments.</p>}
      </section> : <>
      <section aria-labelledby="home-events">
        <div className="home-section-heading">
          <h2 id="home-events">{shell.draftsOpen ? 'Saved drafts' : 'Upcoming and live'}</h2>
        </div>
        <div className="home-events">
          {!shell.draftsOpen && activeId && <article className="home-event home-live-event" onClick={event => {
            if (event.target instanceof Node && event.currentTarget.contains(event.target)) openActive();
          }}>
            <div className="home-event-heading">
              <div><p>{snapshot ? STAGE_LABEL[snapshot.stage] : 'Live event'}{named?.game && ` · ${gameLabel[named.game]}`}</p>
                <h3>{named ? <Menu label={`Actions for ${named.name}`} items={tournamentMenu.items(named, openActive)}
                  openOnContext trigger={props => <button {...props} type="button" title={liveTitle} onClick={openActive}>{liveTitle}</button>} />
                  : <button type="button" title={liveTitle}>{liveTitle}</button>}</h3></div>
            </div>
            {snapshot ? <Suspense fallback={<p className="home-event-empty" role="status">Loading player chart…</p>}>
              <PlayerChart snapshot={snapshot} />
            </Suspense> : <p className="home-event-empty">
              {shell.viewed.status === 'error' ? 'Player counts unavailable.' : 'Loading player counts…'}</p>}
          </article>}
          {visibleCards.map(draft => <DraftCard key={draft.eventId} draft={draft} menu={tournamentMenu} />)}
          {Array.from({ length: quickCreateCount }, (_, index) => (
            <button key={index} type="button" className="home-event home-quick-create" onClick={() => setCreateOpen(true)}>
              <span className="home-icon"><Plus aria-hidden /></span>
              Create tournament
            </button>
          ))}
          {(shell.draftsOpen || !activeId) && visibleCards.length === 0 && quickCreateCount === 0 && <p className="home-empty">
            {shell.eventsState === 'loading' || shell.directoryState === 'loading' ? 'Loading tournaments…' :
              shell.eventsState === 'error' || shell.directoryState === 'error' ? 'Tournaments could not be loaded.' :
                shell.draftsOpen ? 'No saved drafts.' : 'No active or upcoming tournaments.'}
          </p>}
        </div>
      </section>
      {shell.draftsOpen && templates.length > 0 && <section className="mt-5" aria-labelledby="home-templates">
        <div className="home-section-heading"><h2 id="home-templates">Templates</h2></div>
        <ul className="home-results">{templates.map(entry => <li key={entry.eventId}>
          <Menu label={`Actions for ${entry.name}`} items={tournamentMenu.items(entry, () => tournamentMenu.startFrom(entry))}
            openOnContext trigger={props => <button {...props} type="button"
              aria-label={`Use template ${entry.name}`} disabled={!shell.session.commandsEnabled}
              onClick={() => tournamentMenu.startFrom(entry)}>
              <span><strong>{entry.name}</strong>{entry.game && <small>{gameLabel[entry.game]}</small>}</span>
              <ArrowUpRight aria-hidden />
            </button>} />
        </li>)}</ul>
      </section>}
      {!shell.draftsOpen && <section className="home-actions" aria-labelledby="home-actions">
        <h2 id="home-actions">Action needed</h2>
        <div className="home-action-grid">
          {lanes.slice(0, 2).map(({ label, icon: Icon, tone, matches }) => <div key={label} data-tone={tone}>
            <Icon aria-hidden /><strong>{countsAvailable ? matches.length : '—'}</strong><h3>{label}</h3>
          </div>)}
        </div>
        <LayoutGroup id={activeId ?? 'home'}>
        <div className="home-task-viewport" role="region" aria-label="Tournament task board" tabIndex={0}>
          <div className="home-task-board">
          {lanes.map(({ label, icon: Icon, tone, matches }) => <section key={label} className="home-task-lane" data-tone={tone}>
            <header><span className="home-task-lane-icon"><Icon aria-hidden /></span><h3>{label}</h3><small>{countsAvailable ? matches.length : '—'}</small></header>
            {matches.length ? <ul>{matches.map(match => <motion.li key={match.id}
              layout={reduceMotion ? false : 'position'} layoutId={reduceMotion ? undefined : match.id}
              transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.2, 0.8, 0.2, 1] }}>
              <button type="button" className="home-task-card" aria-label={`Match ${match.id}`}
                onClick={() => { openActive(); shell.openMatch(match.id); }}>
                <span className="home-task-card-heading"><small>Match {match.id}</small><ArrowUpRight aria-hidden /></span>
                {snapshot && <strong>{match.seats.map(seat => seatName(snapshot, seat)).join(' vs ')}</strong>}
                <span className="home-task-card-footer"><small>{matchStatus(match)}</small></span>
              </button>
            </motion.li>)}</ul> : <p className="home-task-empty">{countsAvailable ? 'No matches' : 'Match data unavailable'}</p>}
          </section>)}
          </div>
        </div>
        </LayoutGroup>
      </section>}
      </>}
      {canCreate && <CreateTournamentDialog open={createOpen} defaultGame={shell.directory?.defaultGame ?? 'one-piece'}
        onClose={() => setCreateOpen(false)} onSaved={entry => { setCreateOpen(false); shell.selectDraft(entry); }} />}
      {tournamentMenu.confirmation}
    </div>
  </div>;
}
