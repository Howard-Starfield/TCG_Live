// Owned by L3 (web-kit): shows every ui/ component state in light and dark.
// Query flags for screenshots: #/__kit?open=confirm,dialog,menu,popover,tooltip&in=light|dark&only=<section title words>
import {
  Activity, Bell, Copy, Flag, Inbox, Moon, MoreHorizontal, Pencil, RefreshCw, Sun, SunMoon, Table2, Trash2, Trophy, Users, Workflow
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Avatar, Badge, Breadcrumb, Button, Chip, CodeBlock, CommandComposer, ConfirmDialog, ConnectionPill, CountBadge, DataTable,
  DecisionCard, Dialog, Disclosure, EmptyState, Field, IconButton, Input, Kbd, Menu, PaneHeader, Popover, PortalScope,
  ScrollFade, SegmentedControl, Select, SidebarList, SplitPane, StatusDot, Switch, TabPanel, TabStrip, Textarea, ThemeProvider,
  ToastProvider, ToggleTab, Tooltip, backoffDelay, useBackoff, useResolvedTheme, useScrollPin, useToast,
  type Column, type ComposerTrigger, type ThemePreference
} from '../ui';
import { GalleryFrame } from './GalleryFrame';

const flags = (() => {
  const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return { open: new Set((query.get('open') ?? '').split(',').filter(Boolean)), in: query.get('in') ?? 'light', only: (query.get('only') ?? '').toLowerCase() };
})();

/** Which gallery column (light or dark) this subtree renders in. */
function useSectionTheme() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<string | null>(null);
  useEffect(() => setTheme(ref.current?.closest<HTMLElement>('[data-theme]')?.dataset.theme ?? null), []);
  return { ref, theme };
}

function Demo({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  if (flags.only && !flags.only.split(',').some(word => title.toLowerCase().includes(word))) return null;
  return (
    <section className={`flex min-w-0 flex-col gap-3 rounded-xl bg-canvas p-4 ${wide ? 'col-span-full' : ''}`}>
      <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</h2>
      {children}
    </section>
  );
}

const Row = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center gap-2">{children}</div>;

interface PlayerRow { seat: string; name: string; avatar: string | null; checkedIn: boolean; match: string; points: number; rating: number }

const PLAYERS: PlayerRow[] = [
  { seat: 'A', name: 'Ash Ketch', avatar: null, checkedIn: true, match: 'M1 · live', points: 0, rating: 1212 },
  { seat: 'B', name: 'Misty', avatar: 'https://cdn.discordapp.com/embed/avatars/1.png', checkedIn: true, match: 'M1 · live', points: 3, rating: 1188 },
  { seat: 'C', name: 'Gary Oak', avatar: 'invalid://broken-avatar', checkedIn: true, match: 'M2 · judge', points: 0, rating: 1240 },
  { seat: 'D', name: 'Brock', avatar: null, checkedIn: false, match: 'M2 · judge', points: 1, rating: 1175 }
];

const PLAYER_COLUMNS: Array<Column<PlayerRow>> = [
  { id: 'seat', header: 'Seat · player', sortValue: row => row.seat, cell: row => (
    <span className="inline-flex items-center gap-2">
      <Badge mono>{row.seat}</Badge><Avatar src={row.avatar} name={row.name} size="sm" decorative />{row.name}
    </span>
  ) },
  { id: 'checkin', header: 'Check-in', cell: row => (row.checkedIn ? <Chip tone="success" className="h-5">in</Chip> : <Chip className="h-5">waiting</Chip>) },
  { id: 'match', header: 'Match', cell: row => <Badge tone={row.match.includes('judge') ? 'danger' : 'accent'}>{row.match}</Badge> },
  { id: 'points', header: 'Pts', numeric: true, descFirst: true, sortValue: row => row.points, cell: row => row.points },
  { id: 'rating', header: 'Elo', numeric: true, descFirst: true, sortValue: row => row.rating, cell: row => row.rating }
];

const COMMANDS = [
  { id: 'publish', label: '/publish', description: 'Publish round 1', insertText: '/publish' },
  { id: 'resolve', label: '/resolve', description: 'Decide a match as judge', insertText: '/resolve' },
  { id: 'judge-resume', label: '/judge-resume', description: 'Resume a paused clock', insertText: '/judge-resume' },
  { id: 'signup-close', label: '/signup-close', description: 'Close signup and assign seats', insertText: '/signup-close' },
  { id: 'refresh', label: '/refresh', description: 'Re-render Discord cards', insertText: '/refresh' }
];

function Feed() {
  const [entries, setEntries] = useState(() => Array.from({ length: 6 }, (_, i) => `Entry ${i + 1}: seat ${'ABCD'[i % 4]} confirmed ready.`));
  const pin = useScrollPin<HTMLDivElement>({ contentKey: entries.length });
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <div className="rounded-lg bg-raised shadow-raised">
          <ScrollFade ref={pin.scrollRef} className="h-36 p-3">
            <ol className="flex flex-col gap-2 text-[13px]">
              {entries.map(entry => (
                <li key={entry} className="flex items-baseline gap-2"><span className="text-2xs text-fg-subtle tabular-nums">21:0{entry.length % 10}</span>{entry}</li>
              ))}
            </ol>
          </ScrollFade>
        </div>
        {!pin.pinned && (
          <Button size="sm" variant="secondary" className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow-pop"
            onClick={() => pin.jumpToLatest()} trailing={pin.hasUnseen ? <StatusDot tone="accent" size="sm" /> : undefined}>
            Jump to latest
          </Button>
        )}
      </div>
      <Row>
        <Button size="sm" icon={<Activity aria-hidden />} onClick={() => setEntries(list => [...list, `Entry ${list.length + 1}: audit event applied.`])}>Add entry</Button>
        <span className="text-xs text-fg-subtle">{pin.pinned ? 'Pinned to latest' : 'Scrolled up'}</span>
      </Row>
    </div>
  );
}

function BackoffDemo() {
  const backoff = useBackoff({ baseMs: 400, maxMs: 6000 });
  const [last, setLast] = useState<number | null>(null);
  const preview = useMemo(() => [0, 1, 2, 3, 4, 5].map(attempt => backoffDelay(attempt, { baseMs: 400, maxMs: 6000, jitter: 'none' })), []);
  return (
    <div className="flex flex-col gap-2 text-xs text-fg-muted">
      <p className="tabular-nums">Caps per attempt: {preview.map(ms => `${(ms / 1000).toFixed(1)}s`).join(' → ')}</p>
      <Row>
        <Button size="sm" icon={<RefreshCw aria-hidden />} onClick={() => setLast(backoff.schedule(() => setLast(null)))}>Simulate failure</Button>
        <Button size="sm" variant="ghost" onClick={() => { backoff.reset(); setLast(null); }}>Reset</Button>
        <span className="tabular-nums">attempt {backoff.attempt}{last !== null ? ` · retry in ${last} ms` : ''}</span>
      </Row>
    </div>
  );
}

function ThemeDemo() {
  const [preference, setPreference] = useState<ThemePreference>('light');
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setBox} className="flex flex-col gap-2 rounded-lg bg-base p-3 text-fg shadow-raised">
      <ThemeProvider theme={preference} target={box}>
        <SegmentedControl label="Theme" value={preference} onChange={setPreference}
          options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]} />
        <ResolvedLabel />
      </ThemeProvider>
    </div>
  );
}

function ResolvedLabel() {
  const resolved = useResolvedTheme();
  return <p className="text-xs text-fg-muted">This box resolves to <b className="text-fg">{resolved}</b> (ThemeProvider with a scoped target).</p>;
}

function KitSection() {
  const { ref, theme } = useSectionTheme();
  const toast = useToast();
  const autoOpen = (name: string) => theme !== null && flags.in === theme && flags.open.has(name);
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (autoOpen('dialog')) setDialog(true); if (autoOpen('confirm')) setConfirm(true); }, [theme]);

  const [segment, setSegment] = useState<'event' | 'match' | 'rounds'>('event');
  const [tab, setTab] = useState<'players' | 'matches' | 'audit' | 'panels'>('players');
  const [live, setLive] = useState(true);
  const [list, setList] = useState(false);
  const [sidebar, setSidebar] = useState('practice');
  const [hRatio, setHRatio] = useState(0.55);
  const [vRatio, setVRatio] = useState(0.5);
  const [notify, setNotify] = useState(true);
  const [compact, setCompact] = useState(false);
  const [menuTheme, setMenuTheme] = useState<ThemePreference>('system');
  const [busy, setBusy] = useState(false);
  const tabBase = `kit-tabs-${theme ?? 'x'}`;

  const triggers: ComposerTrigger[] = useMemo(() => [
    { char: '/', atStart: true, label: 'Commands', getSuggestions: query => COMMANDS.filter(command => command.label.slice(1).startsWith(query.toLowerCase())) },
    { char: '@', label: 'Members', getSuggestions: query => PLAYERS
      .filter(player => player.name.toLowerCase().startsWith(query.toLowerCase()))
      .map(player => ({ id: player.seat, label: player.name, description: `Seat ${player.seat}`, insertText: `@${player.name.split(' ')[0]}`,
        icon: <Avatar src={player.avatar} name={player.name} size="xs" decorative /> })) }
  ], []);

  // Render once the column is known, so `open=` flags reach components that read them at mount.
  if (theme === null) return <div ref={ref} />;
  return (
    <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
      <Demo title="Buttons">
        <Row>
          <Button variant="primary">Publish round</Button>
          <Button>Secondary</Button>
          <Button variant="ghost" icon={<RefreshCw aria-hidden />}>Refresh panels</Button>
          <Button variant="danger" icon={<Trash2 aria-hidden />}>Remove</Button>
        </Row>
        <Row>
          <Button size="sm" variant="primary">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button loading variant="primary">Saving</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <Tooltip content="Copy event id" describe={false} defaultOpen={autoOpen('tooltip')}>
            <IconButton aria-label="Copy event id" icon={<Copy aria-hidden />} />
          </Tooltip>
          <Tooltip content="Toggle live preview" shortcut={['Alt', '1']} describe={false}>
            <IconButton aria-label="Toggle live preview" variant="secondary" icon={<Workflow aria-hidden />} />
          </Tooltip>
          <IconButton aria-label="Edit" size="sm" icon={<Pencil aria-hidden />} />
          <IconButton aria-label="Delete" variant="danger" size="sm" icon={<Trash2 aria-hidden />} />
          <IconButton aria-label="Working" loading icon={<Bell aria-hidden />} />
        </Row>
      </Demo>

      <Demo title="Status, badges, chips, keys">
        <Row>
          <StatusDot tone="accent" live label="Live" />
          <StatusDot tone="success" label="Done" />
          <StatusDot tone="warning" live label="Connecting" />
          <StatusDot tone="danger" live label="Needs judge" />
          <StatusDot label="Not reached" />
          <CountBadge count={2} label="2 decisions" />
          <CountBadge count={14} tone="neutral" />
        </Row>
        <Row>
          <ConnectionPill label="Discord" state="connected" />
          <ConnectionPill label="PostgreSQL" state="connected" detail="Ready" />
          <ConnectionPill label="Stream" state="reconnecting" />
          <ConnectionPill label="Lease" state="offline" detail="Lost" />
          <ConnectionPill label="Gateway" state="idle" />
        </Row>
        <Row>
          <Badge tone="danger">dispute</Badge><Badge tone="danger">called</Badge><Badge tone="warning">expired</Badge>
          <Badge tone="accent">running</Badge><Badge tone="success">final</Badge><Badge mono>M1</Badge><Badge mono>rev 2</Badge>
        </Row>
        <Row>
          <Chip tone="accent" dot live>Round 1 · live</Chip>
          <Chip tone="success" dot>Cards in sync</Chip>
          <Chip icon={<Users aria-hidden />}>4 / 4 joined</Chip>
          <Kbd keys={['Alt', '1']} /><Kbd keys="Esc" /><Kbd keys={['Shift', 'Enter']} />
        </Row>
      </Demo>

      <Demo title="Navigation">
        <div className="flex gap-3">
          <div className="w-52 rounded-lg bg-canvas">
            <SidebarList label="Events" heading="Events" onSelect={setSidebar} items={[
              { id: 'practice', label: 'Practice · signup session', meta: 'Round 1 · live', live: true, active: sidebar === 'practice' },
              { id: 'fixture', label: 'Practice · fixture', meta: '14 Oct · retired', active: sidebar === 'fixture' },
              { id: 'rehearsal', label: 'Rehearsal run', meta: '12 Oct · retired', active: sidebar === 'rehearsal' }
            ]} />
          </div>
          <div className="w-11 rounded-lg bg-canvas py-1">
            <SidebarList label="Events (collapsed)" collapsed onSelect={setSidebar} items={[
              { id: 'practice', label: 'Practice · signup session', live: true, active: sidebar === 'practice' },
              { id: 'fixture', label: 'Practice · fixture', active: sidebar === 'fixture' }
            ]} />
          </div>
        </div>
        <div className="flex items-center gap-3 overflow-hidden rounded-lg bg-raised px-3 py-2 shadow-raised">
          <Breadcrumb items={[
            { id: 'root', label: 'TCG Live', onSelect: () => toast.show({ title: 'Breadcrumb: TCG Live' }) },
            { id: 'event', label: 'Practice · signup session', onSelect: () => toast.show({ title: 'Breadcrumb: event' }) },
            { id: 'stage', label: 'Round 1' }
          ]} />
          <span aria-hidden className="h-[18px] w-px bg-line" />
          <div role="toolbar" aria-label="Preview panes" className="flex gap-1">
            <ToggleTab pressed={live} onPressedChange={setLive} icon={<Workflow />} shortcut={['Alt', '1']}>Live preview</ToggleTab>
            <ToggleTab pressed={list} onPressedChange={setList} icon={<Table2 />} shortcut={['Alt', '2']}>List preview</ToggleTab>
          </div>
        </div>
        <div className="rounded-lg bg-raised shadow-raised">
          <PaneHeader title="Live preview" icon={<Workflow />} onClose={() => toast.show({ title: 'Pane closed' })}>
            <SegmentedControl label="Canvas view" value={segment} onChange={setSegment} options={[
              { value: 'event', label: 'Event' }, { value: 'match', label: 'Match' },
              { value: 'rounds', label: 'Rounds', disabled: true, title: 'Arrives with multi-round Swiss' }
            ]} />
          </PaneHeader>
          <div className="px-3 pb-3">
            <TabStrip label="List preview" idBase={tabBase} value={tab} onChange={setTab} tabs={[
              { value: 'players', label: 'Players', icon: <Users /> },
              { value: 'matches', label: 'Matches', icon: <Flag /> },
              { value: 'audit', label: 'Audit', badge: <CountBadge count={14} tone="neutral" /> },
              { value: 'panels', label: 'Panels', disabled: true }
            ]} />
            <TabPanel idBase={tabBase} value={tab} className="mt-2 rounded-md bg-sunken px-3 py-2 text-xs text-fg-muted">
              Selected tab: <b className="text-fg">{tab}</b>. Arrow keys move between tabs.
            </TabPanel>
          </div>
        </div>
      </Demo>

      <Demo title="Decision cards">
        <DecisionCard title="Needs a judge" reasons={['M2 · dispute']} meta="rev 2 · 21:04"
          actions={<>
            <Button size="sm" onClick={() => setConfirm(true)}>Gary won…</Button>
            <Button size="sm" onClick={() => setConfirm(true)}>Brock won…</Button>
            <Button size="sm" variant="ghost" icon={<Workflow aria-hidden />} onClick={() => toast.show({ title: 'Opening M2 in live preview' })}>Open in live preview</Button>
          </>}>
          <b>Gary</b> reported that he won. <b>Brock</b> disputed it. Nothing is decided automatically.
        </DecisionCard>
        <DecisionCard title="Clock expired" tone="warning" reasons={[{ label: 'M1 · expired', tone: 'warning' }, { label: 'called', tone: 'danger' }]} meta="21:31">
          Time ran out before a result was reported.
        </DecisionCard>
      </Demo>

      <Demo title="Fields">
        <Field label="Display name" description="Shown in the audit log.">
          <Input placeholder="Organizer" defaultValue="Local admin" />
        </Field>
        <Field label="Reason" error="A reason is required." required>
          <Textarea rows={2} placeholder="Why are you changing the result?" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Winner">
            <Select defaultValue="C"><option value="C">Seat C · Gary</option><option value="D">Seat D · Brock</option></Select>
          </Field>
          <Field label="Disabled input"><Input disabled value="read only" readOnly /></Field>
        </div>
        <Field label="Desktop notifications" description="Alert when a match needs a judge." inline>
          <Switch checked={notify} onCheckedChange={setNotify} />
        </Field>
        <Field label="Compact tables" inline>
          <Switch checked={compact} onCheckedChange={setCompact} size="sm" />
        </Field>
      </Demo>

      <Demo title="Data table" wide>
        <DataTable label="Players" columns={PLAYER_COLUMNS} rows={PLAYERS} getRowId={row => row.seat} dense={compact}
          defaultSort={{ columnId: 'seat', direction: 'asc' }} isRowSelected={row => row.seat === 'C'}
          onRowActivate={row => toast.show({ title: `Opened seat ${row.seat}`, description: row.name })} />
        <DataTable label="Matches (empty)" columns={PLAYER_COLUMNS} rows={[]} getRowId={row => row.seat} dense
          empty={<EmptyState compact icon={<Inbox />} title="No matches yet" description="Matches appear once round 1 is published." />} />
      </Demo>

      <Demo title="Split panes">
        <div className="h-44 overflow-hidden rounded-lg bg-raised shadow-raised">
          <SplitPane ratio={hRatio} onChange={setHRatio} defaultRatio={0.55} minFirst={80} minSecond={80} collapseThreshold={0.12} label="Resize controls and preview"
            first={<div className="grid h-full place-items-center text-xs text-fg-muted tabular-nums">Controls · {Math.round(hRatio * 100)}%</div>}
            second={<div className="grid h-full place-items-center bg-sunken text-xs text-fg-muted">Preview dock</div>} />
        </div>
        <div className="h-44 overflow-hidden rounded-lg bg-raised shadow-raised">
          <SplitPane direction="vertical" ratio={vRatio} onChange={setVRatio} minFirst={40} minSecond={40} label="Resize live and list preview"
            first={<div className="grid h-full place-items-center text-xs text-fg-muted tabular-nums">Live preview · {Math.round(vRatio * 100)}%</div>}
            second={<div className="grid h-full place-items-center text-xs text-fg-muted">List preview</div>} />
        </div>
        <p className="text-xs text-fg-subtle">Drag (4 px deadzone), double-click or Enter to reset, arrows to resize; the top pane collapses below 12%.</p>
      </Demo>

      <Demo title="Command composer">
        <div className="pt-20">
          <CommandComposer triggers={triggers} busy={busy} placeholder="Type / for commands, @ for members"
            onSubmit={value => { setBusy(true); setTimeout(() => { setBusy(false); toast.show({ title: 'Submitted', description: value, tone: 'success' }); }, 600); }}
            footer={<>{COMMANDS.slice(0, 4).map(command => <span key={command.id} className="rounded-full bg-line-faint px-2 py-0.5 font-mono text-fg-muted">{command.label}</span>)}<span className="pl-1">Enter to send · Shift+Enter for a new line</span></>} />
        </div>
        <CommandComposer disabled onSubmit={() => {}} placeholder="Disabled composer (commands arrive in Wave 3)" />
      </Demo>

      <Demo title="Overlays">
        <Row>
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>Correct result…</Button>
          <Menu label="Account" defaultOpen={autoOpen('menu')} placement="bottom-start" items={[
            { type: 'label', id: 'theme-label', label: 'Theme' },
            { id: 'light', label: 'Light', icon: <Sun />, checked: menuTheme === 'light', onSelect: () => setMenuTheme('light') },
            { id: 'dark', label: 'Dark', icon: <Moon />, checked: menuTheme === 'dark', onSelect: () => setMenuTheme('dark') },
            { id: 'system', label: 'System', icon: <SunMoon />, checked: menuTheme === 'system', onSelect: () => setMenuTheme('system') },
            { type: 'separator', id: 'sep' },
            { id: 'rotate', label: 'Rotate console link', icon: <RefreshCw />, onSelect: () => toast.show({ title: 'Console link rotated', tone: 'success' }) },
            { id: 'copy', label: 'Copy event id', icon: <Copy />, shortcut: ['Ctrl', 'C'], onSelect: () => toast.show({ title: 'Copied' }) },
            { id: 'disabled', label: 'Export (later)', disabled: true, onSelect: () => {} },
            { id: 'logout', label: 'Sign out', danger: true, onSelect: () => toast.show({ title: 'Signed out', tone: 'danger' }) }
          ]} trigger={props => <Button {...props} icon={<MoreHorizontal aria-hidden />}>Menu</Button>} />
          <Popover label="Event details" defaultOpen={autoOpen('popover')} trigger={props => <Button variant="ghost" {...props}>Popover</Button>}>
            {close => (
              <div className="flex w-56 flex-col gap-2 text-xs text-fg-muted">
                <p className="font-semibold text-fg">Practice · signup session</p>
                <p>Created 21:00 · version 14 · panel revision 3</p>
                <Button size="sm" onClick={close}>Close</Button>
              </div>
            )}
          </Popover>
        </Row>
        <Row>
          <Button size="sm" onClick={() => toast.show({ title: 'Round 1 published', description: 'Cards posted to both match rooms.', tone: 'success' })}>Success toast</Button>
          <Button size="sm" onClick={() => toast.show({ title: 'Stream reconnected' })}>Neutral toast</Button>
          <Button size="sm" onClick={() => toast.show({ title: 'Command rejected', description: 'The match changed since you looked.', tone: 'danger', duration: null, action: { label: 'Reload', onClick: () => toast.show({ title: 'Reloaded latest state' }) } })}>Danger toast</Button>
        </Row>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Rotate the console link?"
          description="The current link stops working. Open tabs stay signed in."
          footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => { setDialog(false); toast.show({ title: 'Link rotated', tone: 'success' }); }}>Rotate link</Button></>}>
          <CodeBlock language="url" code="http://127.0.0.1:3000/#login=••••••••" />
        </Dialog>
        <ConfirmDialog open={confirm} danger requireReason pending={pending} title="Correct M2 result"
          description="Changes the final winner of M2 to Brock. Standings are recalculated."
          confirmLabel="Correct result" reasonPlaceholder="What did the judge decide?"
          onCancel={() => setConfirm(false)}
          onConfirm={reason => { setPending(true); setTimeout(() => { setPending(false); setConfirm(false); toast.show({ title: 'Result corrected', description: reason, tone: 'success' }); }, 700); }} />
      </Demo>

      <Demo title="Scroll fade and pinning">
        <Feed />
      </Demo>

      <Demo title="Code, disclosure, empty state">
        <Disclosure summary="Raw audit entry" meta="#14" defaultOpen>
          <CodeBlock language="json" code={JSON.stringify({ sequence: 14, commandId: 'discord:1299', actor: { kind: 'player', seat: 'D' }, command: { type: 'dispute', matchId: 'M2', revision: 2 }, result: 'applied' }, null, 2)} />
        </Disclosure>
        <Disclosure summary="Collapsed section" meta="3 items">
          <p className="text-xs text-fg-muted">Hidden until expanded.</p>
        </Disclosure>
        <EmptyState icon={<Trophy />} title="No standings yet" description="Standings appear when both matches are final."
          action={<Button size="sm" variant="secondary" onClick={() => toast.show({ title: 'Opening matches' })}>View matches</Button>} />
      </Demo>

      <Demo title="Avatars, theme, backoff">
        <Row>
          {PLAYERS.map(player => <Avatar key={player.seat} src={player.avatar} name={player.name} size="lg" />)}
          <Avatar src={null} name={null} size="lg" />
          <Avatar src={null} name="Local admin" size="md" shape="rounded" />
          <Avatar src={null} name="Brock" size="sm" />
        </Row>
        <ThemeDemo />
        <BackoffDemo />
      </Demo>
    </div>
  );
}

export function KitGallery() {
  return (
    <GalleryFrame title="UI kit">
      {() => (
        <PortalScope>
          <ToastProvider>
            <KitSection />
          </ToastProvider>
        </PortalScope>
      )}
    </GalleryFrame>
  );
}
