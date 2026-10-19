// Main controls (L6): stage stepper, needs-you queue and activity stream. Wave 3 adds actions here.
import { CalendarClock, CalendarX, DatabaseZap, LoaderCircle } from 'lucide-react';
import { Button, EmptyState } from '../../ui';
import { useShell } from '../shell/model';
import { ActivityStream } from './ActivityStream';
import { NeedsYou } from './NeedsYou';
import { StageStepper } from './StageStepper';

export { ActivityStream, groupActivity, lineText } from './ActivityStream';
export { NeedsYou, judgeCardMode, judgeMatches } from './NeedsYou';
export { StageStepper, stepModel } from './StageStepper';

/** The main window: what is happening, what needs the admin, and what changed. */
export function MainControls() {
  const shell = useShell();
  const { viewed } = shell;

  if (viewed.waitingForDatabase && viewed.status !== 'ready') {
    return (
      <div className="console-column grid place-items-center" data-testid="waiting-for-database">
        <EmptyState icon={<DatabaseZap />} title="Waiting for the database"
          description="PostgreSQL is unavailable, so the event cannot be read. The console reconnects to it on its own and shows the event as soon as a read succeeds." />
      </div>
    );
  }
  if (viewed.status === 'none') {
    const hasHistory = shell.events.some(event => event.status === 'retired');
    return (
      <div className="console-column grid place-items-center">
        <EmptyState icon={<CalendarClock />} title="No active event"
          description={`The console follows the active event automatically once one starts in Discord.${hasHistory ? ' Past events are in the sidebar under History.' : ''}`} />
      </div>
    );
  }
  if (viewed.status === 'error') {
    return (
      <div className="console-column grid place-items-center">
        <EmptyState icon={<CalendarX />} title="This event could not be loaded" description={viewed.error?.message}
          action={<Button size="sm" onClick={viewed.retry}>Try again</Button>} />
      </div>
    );
  }
  if (viewed.status === 'loading' || !viewed.snapshot || !viewed.eventId) {
    return (
      <div className="console-column grid place-items-center" role="status">
        <span className="inline-flex items-center gap-2 text-xs text-fg-subtle"><LoaderCircle aria-hidden className="size-4 animate-spin" />Loading event…</span>
      </div>
    );
  }

  const { snapshot } = viewed;
  return (
    <div className="console-column" data-event={snapshot.eventId}>
      <div className="console-top">
        <StageStepper snapshot={snapshot} status={shell.status} frozen={viewed.retired} />
        <NeedsYou snapshot={snapshot} onOpenMatch={shell.openMatch} readOnly={viewed.retired} />
      </div>
      <ActivityStream key={snapshot.eventId} eventId={snapshot.eventId} snapshot={snapshot} />
    </div>
  );
}
