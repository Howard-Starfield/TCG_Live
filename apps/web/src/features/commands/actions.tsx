// Action slots (L10) rendered by the console and list components. Each renders nothing unless the
// session may act (decision 4: commandsEnabled plus the capability), the event is active, and the
// domain currently allows the action (`adminActions`). Read-only mode therefore shows no controls.
import type { EventAdminAction, EventSnapshotDto, MatchAdminAction, MatchDto, Snowflake } from '@tcg-live/core';
import { Clock, Gavel, LockKeyhole, LockKeyholeOpen, MoreHorizontal, PencilLine, Play, RefreshCw, Send, UserMinus } from 'lucide-react';
import { useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { adminKeys, memberName, useAdminData, useServerNow, useSession } from '../../data';
import { Button, Dialog, Field, IconButton, Input, Menu, cx, type MenuEntry } from '../../ui';
import { useShell } from '../shell/model';
import { useTournamentMenu } from '../tournaments/useTournamentMenu';
import { shortDate } from '../shell/labels';
import { ArtworkDialog } from '../artwork/ArtworkDialog';
import { tournamentDirectoryKey } from '../tournaments/directory';
import { TournamentDetailsDialog } from '../tournaments/TournamentDetailsDialog';
import { useCommands, type CommandsApi } from './CommandsProvider';
import { availableEventActions, availableMatchActions, canRefreshPanels, canRemoveMember, canRun, isWritable,
  MATCH_ACTION_LABEL, matchActionKey, REFRESH_KEY } from './model';

type EventButton = Exclude<EventAdminAction, 'signupRemove'>;

const EVENT_BUTTON: Record<EventButton, { label: string; icon: ReactNode; variant: 'primary' | 'secondary' }> = {
  publish: { label: 'Publish round', icon: <Send aria-hidden />, variant: 'primary' },
  signupClose: { label: 'Close signup', icon: <LockKeyhole aria-hidden />, variant: 'primary' },
  signupReopen: { label: 'Reopen signup', icon: <LockKeyholeOpen aria-hidden />, variant: 'secondary' }
};

const MATCH_ICON: Record<MatchAdminAction, ReactNode> = {
  resolve: <Gavel aria-hidden />,
  judgeResume: <Play aria-hidden />,
  correct: <PencilLine aria-hidden />
};

/** Commands for this snapshot, or null when the slot must stay empty. */
function useWritable(snapshot: EventSnapshotDto, readOnly: boolean): CommandsApi | null {
  const commands = useCommands();
  if (!commands || readOnly || !isWritable(snapshot) || !commands.session.commandsEnabled) return null;
  return commands;
}

/** Stage stepper actions row: publish, signup close/reopen, and the Discord panel refresh. */
export function EventActions({ snapshot, readOnly = false }: { snapshot: EventSnapshotDto; readOnly?: boolean }) {
  const commands = useWritable(snapshot, readOnly);
  const session = useSession();
  const { queryClient } = useAdminData();
  const shell = useShell();
  const tournamentMenu = useTournamentMenu();
  const ended = (snapshot.stage === 'complete' || snapshot.status === 'retired') && shell.session.commandsEnabled
    ? shell.directory?.entries.find(entry => entry.eventId === snapshot.eventId) : undefined;
  const now = useServerNow(snapshot.startsAtMs === undefined || snapshot.published ? null : 1_000);
  const scheduled = snapshot.status === 'active' && !snapshot.published ? snapshot.startsAtMs : undefined;
  const publishAfter = scheduled !== undefined && scheduled > now ? shortDate(scheduled) : null;
  const [artworkOpen, setArtworkOpen] = useState(false);
  const artwork = !readOnly && isWritable(snapshot) && session.session?.artwork === true;
  const details = !readOnly && isWritable(snapshot) && session.session?.tournaments === true;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [delayOpen, setDelayOpen] = useState(false);
  const [minutes, setMinutes] = useState('');
  const delayBusy = commands?.isPending('delayStart') ?? false;
  const mayDelay = !!commands && !snapshot.published && snapshot.signup !== null &&
    scheduled !== undefined && canRun(commands.session, 'delayStart');
  const delayMinutes = Number(minutes);
  const newStart = scheduled === undefined ? NaN : Math.max(scheduled, now) + delayMinutes * 60_000;
  const validDelay = Number.isSafeInteger(delayMinutes) && delayMinutes >= 1 && Number.isSafeInteger(newStart) &&
    newStart <= 8_640_000_000_000_000;
  const delay = async (event: FormEvent) => {
    event.preventDefault();
    if (!commands || !mayDelay || !validDelay || delayBusy) return;
    const outcome = await commands.run(snapshot, { type: 'delayStart', delayMinutes });
    if (outcome.status === 'applied' || outcome.status === 'noop') {
      setDelayOpen(false);
      void queryClient.invalidateQueries({ queryKey: adminKeys.snapshot(snapshot.eventId) });
      void queryClient.invalidateQueries({ queryKey: tournamentDirectoryKey });
    }
  };
  const actions = commands ? availableEventActions(commands.session, snapshot).filter((action): action is EventButton => action !== 'signupRemove' && (action !== 'publish' || scheduled === undefined)) : [];
  const refresh = commands ? canRefreshPanels(commands.session) : false;
  if (actions.length === 0 && !refresh && !artwork && !details && scheduled === undefined && !ended) return null;
  return (
    <>
    <div role="group" aria-label="Event actions" className="flex flex-wrap items-center gap-1.5" data-testid="event-actions">
      {actions.map(action => {
        const meta = EVENT_BUTTON[action];
        return (
          <Button key={action} size="sm" variant={meta.variant} icon={meta.icon} loading={commands!.isPending(action)}
            onClick={() => { void commands!.run(snapshot, { type: action }); }}>
            {meta.label}
          </Button>
        );
      })}
      {scheduled !== undefined && <p className="text-xs text-fg-muted">
        {publishAfter ? `Round publishes automatically at ${publishAfter} when check-in is complete.`
          : 'The round publishes automatically once check-in is complete.'}
      </p>}
      {mayDelay && <Button size="sm" variant="secondary" icon={<Clock aria-hidden />}
        onClick={() => { setMinutes(''); setDelayOpen(true); }}>Delay start</Button>}
      {ended && <>
        <Button size="sm" variant="secondary" onClick={() => tournamentMenu.startFrom(ended)}>Restart tournament</Button>
        <Button size="sm" variant="secondary" loading={tournamentMenu.savingTemplate}
          onClick={() => { void tournamentMenu.saveTemplate(ended); }}>Save as template</Button>
      </>}
      {details && <Button size="sm" variant="secondary" icon={<PencilLine aria-hidden />}
        onClick={() => setDetailsOpen(true)}>Edit tournament details</Button>}
      {artwork && <Button size="sm" variant="secondary" icon={<PencilLine aria-hidden />}
        onClick={() => setArtworkOpen(true)}>Edit signup banner</Button>}
      {refresh && (
        <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden />} className="ml-auto" loading={commands!.isPending(REFRESH_KEY)}
          title="Create or repair the check-in and match cards in Discord" onClick={() => { void commands!.refreshPanels(snapshot); }}>
          Refresh panels
        </Button>
      )}
    </div>
    {delayOpen && <Dialog open onClose={() => setDelayOpen(false)} dismissible={!delayBusy} title="Delay tournament start"
      description="The bot updates the Discord signup panel with the new start time."
      footer={<>
        <Button variant="ghost" disabled={delayBusy} onClick={() => setDelayOpen(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="delay-tournament-start" loading={delayBusy}
          disabled={!mayDelay || !validDelay}>Apply delay</Button>
      </>}>
      <form id="delay-tournament-start" onSubmit={event => { void delay(event); }}>
        <Field label="Delay in minutes" required description="Minutes are added to the scheduled start, or to the current time if the start has passed.">
          <Input type="number" min={1} step={1} value={minutes} onChange={event => setMinutes(event.target.value)} />
        </Field>
        {validDelay && <p className="mt-3 text-sm text-fg">New start {shortDate(newStart)}</p>}
      </form>
    </Dialog>}
    {tournamentMenu.confirmation}
    {artwork && <ArtworkDialog open={artworkOpen} onClose={() => setArtworkOpen(false)} />}
    {details && <TournamentDetailsDialog open={detailsOpen} eventId={snapshot.eventId} capacity={snapshot.signup?.capacity} onClose={() => setDetailsOpen(false)} />}
    </>
  );
}

/**
 * Keeps clicks, Enter and Space on row actions from activating the table row (portalled menus bubble
 * here too). Other keys bubble on, so a surrounding sheet still traps Tab and closes on Escape.
 */
function stopRow(event: MouseEvent | KeyboardEvent) {
  if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return;
  event.stopPropagation();
}

export interface MatchActionsProps {
  snapshot: EventSnapshotDto;
  match: MatchDto;
  readOnly?: boolean;
  allowResultRuling?: boolean;
  /** `buttons` for decision cards, `menu` for compact table rows. */
  variant?: 'buttons' | 'menu';
}

/** Resolve, judge-resume and correct for one match, as the domain allows them now. */
export function MatchActions({ snapshot, match, readOnly = false, allowResultRuling = true, variant = 'buttons' }: MatchActionsProps) {
  const commands = useWritable(snapshot, readOnly);
  if (!commands) return null;
  const actions = availableMatchActions(commands.session, snapshot, match)
    .filter(action => allowResultRuling || action !== 'resolve');
  if (actions.length === 0) return null;
  const open = (action: MatchAdminAction) => commands.openMatchAction({ eventId: snapshot.eventId, matchId: match.id, action });
  const busy = (action: MatchAdminAction) => commands.isPending(matchActionKey(action, match.id));

  if (variant === 'menu') {
    const items: MenuEntry[] = actions.map(action => ({
      id: action, label: `${MATCH_ACTION_LABEL[action]}…`, textValue: MATCH_ACTION_LABEL[action], icon: MATCH_ICON[action],
      danger: action === 'correct', disabled: busy(action), onSelect: () => open(action)
    }));
    return (
      <span className="inline-flex" onClick={stopRow} onKeyDown={stopRow}>
        <Menu label={`Actions for ${match.id}`} items={items} placement="bottom-end" trigger={props => (
          <IconButton {...props} size="sm" aria-label={`Actions for ${match.id}`} loading={actions.some(busy)}
            icon={<MoreHorizontal aria-hidden />} />
        )} />
      </span>
    );
  }
  return (
    <>
      {actions.map(action => (
        <Button key={action} size="sm" icon={MATCH_ICON[action]} loading={busy(action)} onClick={() => open(action)}
          variant={action === 'resolve' ? 'primary' : 'secondary'}
          className={cx(action === 'correct' && 'text-danger')}
          aria-label={`${MATCH_ACTION_LABEL[action]} ${match.id}`}>
          {MATCH_ACTION_LABEL[action]}…
        </Button>
      ))}
    </>
  );
}

/** True when the Players table should grow a remove column. */
export function useRemoveAvailable(snapshot: EventSnapshotDto): boolean {
  const commands = useCommands();
  return !!commands && isWritable(snapshot) && availableEventActions(commands.session, snapshot).includes('signupRemove');
}

/** True when the Matches table should grow an actions column. */
export function useMatchActionsAvailable(snapshot: EventSnapshotDto): boolean {
  const commands = useCommands();
  return !!commands && snapshot.matches.some(match => availableMatchActions(commands.session, snapshot, match).length > 0);
}

/** Players table: remove a member from the open signup (with confirmation). */
export function RemoveMemberAction({ snapshot, memberId }: { snapshot: EventSnapshotDto; memberId: Snowflake | null }) {
  const commands = useWritable(snapshot, false);
  if (!commands || !memberId || !canRemoveMember(commands.session, snapshot, memberId)) return null;
  const name = memberName(snapshot, memberId);
  return (
    <span className="inline-flex" onClick={stopRow} onKeyDown={stopRow}>
      <IconButton size="sm" aria-label={`Remove ${name} from the signup`} title={`Remove ${name} from the signup`}
        icon={<UserMinus aria-hidden />} className="hover:text-danger" loading={commands.isPending(`signupRemove:${memberId}`)}
        onClick={() => commands.confirmRemove({ eventId: snapshot.eventId, memberId })} />
    </span>
  );
}
