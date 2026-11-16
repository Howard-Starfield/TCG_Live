// The kanban board of one event's matches: lanes derived from match state, a quick-action menu on every card and the
// match drawer. Used by Home (the active event) and the Kanban dock pane (the event being viewed). Retired events are
// read-only: the drawer and the menus offer no actions.
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { CircleCheck, Clock, Gavel, ListChecks, MoreHorizontal } from 'lucide-react';
import type { EventSnapshotDto, MatchDto } from '@tcg-live/core';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useServerNow } from '../../data';
import { Badge, IconButton, Menu, type MenuEntry, type Tone } from '../../ui';
import { useCommands } from '../commands';
import { availableMatchActions, MATCH_ACTION_LABEL } from '../commands/model';
import { seatName } from './labels';
import { MatchDrawer, matchStatusLabel } from './MatchDrawer';
import { useShell } from './model';
import './home.css';

// The open match lives in the hash (#/match/<eventId>/<matchId>): match IDs repeat across events, so the event is part of
// the link. The console's own routes are #/admin-tools and #/capabilities, which ignore this form.
const MATCH_HASH = /^#\/match\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/;
interface DrawerTarget { eventId: string; matchId: string }
const readMatchHash = (): DrawerTarget | null => {
  const found = window.location.hash.match(MATCH_HASH);
  return found ? { eventId: found[1]!, matchId: found[2]! } : null;
};
const writeHash = (hash: string) => window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);

/** Age of the oldest waiting item as the pill reads it ("oldest 4m"); warns after 5 minutes, alarms after 10. */
export function oldestPill(sinceMs: number, nowMs: number): { text: string; tone: Tone } {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  const text = minutes < 1 ? 'oldest <1m' : minutes < 60 ? `oldest ${minutes}m` : `oldest ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return { text, tone: minutes >= 10 ? 'danger' : minutes >= 5 ? 'warning' : 'neutral' };
}

/** The Judge needed lane's oldest wait. Matches whose play already resumed keep their judge flag but wait on nobody. */
function OldestWait({ matches, now }: { matches: MatchDto[]; now: number }) {
  const waiting = matches.filter(match => match.phase !== 'running' && match.judge);
  if (!waiting.length) return null;
  const pill = oldestPill(Math.min(...waiting.map(match => match.judge!.sinceMs)), now);
  return <Badge tone={pill.tone}>{pill.text}</Badge>;
}

/** One kanban card: opens the drawer on click, with an overflow menu that also opens on right-click and Shift+F10. */
function MatchCard({ snapshot, match, status, onOpen, onOpenInTournament }: {
  snapshot: EventSnapshotDto; match: MatchDto; status: string; onOpen(): void; onOpenInTournament(): void;
}) {
  const commands = useCommands();
  const judge = match.judge;
  const allowResultRuling = !judge || judge.reasons.includes('dispute') || judge.reasons.includes('expired');
  const actions = commands && commands.session.commandsEnabled
    ? availableMatchActions(commands.session, snapshot, match).filter(action => allowResultRuling || action !== 'resolve') : [];
  const items: MenuEntry[] = [
    { id: 'open', label: 'Open', onSelect: onOpen },
    ...actions.map(action => ({ id: action, label: `${MATCH_ACTION_LABEL[action]}…`, textValue: MATCH_ACTION_LABEL[action], danger: action === 'correct',
      onSelect: () => commands!.openMatchAction({ eventId: snapshot.eventId, matchId: match.id, action }) })),
    { type: 'separator', id: 'sep' },
    { id: 'copy', label: 'Copy match ID', onSelect: () => { void navigator.clipboard?.writeText(match.id); } },
    { id: 'tournament', label: 'Open in tournament view', onSelect: onOpenInTournament }
  ];
  // The menu anchors on the "…" button: pressing it again is then inside the menu's own trigger, so it closes the menu
  // instead of being taken for an outside click, and Escape returns focus to it.
  return <Menu label={`Actions for match ${match.id}`} items={items} openOnContext placement="bottom-end" trigger={props => <div className="home-task-card-wrap">
    <button type="button" className="home-task-card" aria-label={`Match ${match.id}`} data-match-card={match.id} onClick={onOpen}
      onContextMenu={props.onContextMenu}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) props.onKeyDown(event); }}>
      <span className="home-task-card-heading"><small>Match {match.id}</small></span>
      <strong>{match.seats.map(seat => seatName(snapshot, seat)).join(' vs ')}</strong>
      <span className="home-task-card-footer"><small>{status}</small></span>
    </button>
    <IconButton size="sm" className="home-task-card-more" aria-label={`Actions for match ${match.id}`} icon={<MoreHorizontal aria-hidden />}
      ref={props.ref} onKeyDown={props.onKeyDown} aria-haspopup={props['aria-haspopup']} aria-expanded={props['aria-expanded']} aria-controls={props['aria-controls']} onClick={props.onClick} />
  </div>} />;
}

export function TaskBoard({ snapshot }: { snapshot: EventSnapshotDto }) {
  const shell = useShell();
  const reduceMotion = useReducedMotion();
  const now = useServerNow(30_000);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(readMatchHash);
  const hashBefore = useRef('');
  const board = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sync = () => setDrawer(readMatchHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  // Put the address bar back as it was before the drawer opened (only if it still shows our link).
  const releaseHash = useCallback(() => {
    if (readMatchHash()) writeHash(hashBefore.current);
    hashBefore.current = '';
  }, []);
  useEffect(() => releaseHash, [releaseHash]);
  const openDrawer = useCallback((matchId: string) => {
    if (readMatchHash() === null) hashBefore.current = window.location.hash;
    writeHash(`#/match/${snapshot.eventId}/${matchId}`);
    setDrawer({ eventId: snapshot.eventId, matchId });
  }, [snapshot.eventId]);
  // The drawer can vanish without being closed: the match left the snapshot, another event is shown, or a link named
  // a match that does not exist. Once the data says so, drop the drawer and its hash.
  const drawerStale = !!drawer && (snapshot.eventId !== drawer.eventId || !snapshot.matches.some(match => match.id === drawer.matchId));
  useEffect(() => {
    if (!drawerStale) return;
    releaseHash();
    setDrawer(null);
  }, [drawerStale, releaseHash]);
  const closeDrawer = () => {
    const id = drawer?.matchId;
    releaseHash();
    setDrawer(null);
    setTimeout(() => board.current?.querySelector<HTMLElement>(`[data-match-card="${id}"]`)?.focus(), 0);
  };
  const openInTournament = (id: string) => {
    releaseHash();
    setDrawer(null);
    if (shell.home) shell.selectEvent(snapshot.eventId);
    shell.openMatch(id as MatchDto['id']);
  };

  const openMatches = snapshot.matches.filter(match => match.phase !== 'final');
  const lanes = [
    { label: 'Judge needed', icon: Gavel, tone: 'danger', matches: openMatches.filter(match => match.judge) },
    { label: 'Decision needed', icon: ListChecks, tone: 'warning', matches: openMatches.filter(match => !match.judge && match.proposal?.decision === 'open') },
    { label: 'In progress', icon: Clock, tone: 'accent', matches: openMatches.filter(match => !match.judge && match.proposal?.decision !== 'open') },
    { label: 'Done', icon: CircleCheck, tone: 'success', matches: snapshot.matches.filter(match => match.phase === 'final') }
  ];
  return <>
    <LayoutGroup id={snapshot.eventId}>
      <div className="home-task-viewport" role="region" aria-label="Tournament task board" tabIndex={0} ref={board}>
        <div className="home-task-board">
          {lanes.map(({ label, icon: Icon, tone, matches }) => <section key={label} className="home-task-lane" data-tone={tone} data-lane={label} tabIndex={-1}>
            <header><span className="home-task-lane-icon"><Icon aria-hidden /></span><h3>{label}</h3><small>{matches.length}</small>
              {label === 'Judge needed' && <OldestWait matches={matches} now={now} />}</header>
            {matches.length ? <ul>{matches.map(match => <motion.li key={match.id}
              layout={reduceMotion ? false : 'position'} layoutId={reduceMotion ? undefined : `${snapshot.eventId}:${match.id}`}
              transition={{ duration: reduceMotion ? 0 : 0.16, ease: [0.2, 0.8, 0.2, 1] }}>
              <MatchCard snapshot={snapshot} match={match} status={matchStatusLabel(snapshot, match)}
                onOpen={() => openDrawer(match.id)} onOpenInTournament={() => openInTournament(match.id)} />
            </motion.li>)}</ul> : <p className="home-task-empty">No matches</p>}
          </section>)}
        </div>
      </div>
    </LayoutGroup>
    {drawer && !drawerStale && <MatchDrawer snapshot={snapshot} matchId={drawer.matchId}
      onClose={closeDrawer} onOpenInTournament={() => openInTournament(drawer.matchId)} />}
  </>;
}
