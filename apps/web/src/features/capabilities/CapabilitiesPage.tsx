// Capabilities & shortcuts: everything the bot and the dashboard can do, grouped by area, with where to find
// it (exact Discord syntax or a clickable dashboard link), who may use it, what Discord must grant, and a live
// status. Searchable; the keyboard shortcut list sits at the end.
import { ArrowRight, BookOpen, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useSession } from '../../data';
import { DashboardActionsSwitch, VoiceMonitoringSwitch } from '../setup/DashboardActionsSwitch';
import { Badge, EmptyState, Input, type Tone } from '../../ui';
import { requestAdminToolsTab } from '../admin-tools/navigation';
import { CAPABILITIES, CAPABILITY_AREAS, SHORTCUTS, filterCapabilities, filterShortcuts, type CapabilityEntry, type CapabilityLink,
  type CapabilityWhere } from './capabilities';
import { ShortcutList } from './ShortcutsOverlay';
import { capabilityStatus, useCapabilityContext, type CapabilityContext, type CapabilityState } from './status';

/** Where a dashboard link goes; the page gets this from the shell. */
export interface CapabilityNavigator {
  showHome(): void;
  showDrafts(): void;
  followActive(): void;
  showAdminTools(): void;
  showCapabilities?(): void;
}

export function navigateTo(link: CapabilityLink, nav: CapabilityNavigator): void {
  switch (link.page) {
    case 'home': nav.showHome(); return;
    case 'drafts': nav.showDrafts(); return;
    case 'event': nav.followActive(); return;
    case 'admin-tools': if (link.tab) requestAdminToolsTab(link.tab); nav.showAdminTools(); return;
    case 'capabilities': nav.showCapabilities?.(); return;
  }
}

const STATE: Record<CapabilityState, { label: string; tone: Tone }> = {
  available: { label: 'Available', tone: 'success' },
  'needs-setup': { label: 'Needs setup', tone: 'warning' },
  off: { label: 'Turned off', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' }
};

function Where({ where, nav }: { where: CapabilityWhere; nav: CapabilityNavigator }) {
  if (where.kind === 'command') return <code className="break-all rounded-[5px] bg-line-faint px-1.5 py-0.5 font-mono text-2xs text-fg">{where.syntax}</code>;
  if (where.kind === 'button') return <span className="text-xs text-fg"><b className="font-medium">{where.label}</b> <span className="text-fg-subtle">on {where.on}</span></span>;
  if (where.kind === 'automatic') return <span className="text-xs text-fg-muted">Automatic: {where.detail}</span>;
  if (!where.link) return <span className="text-xs text-fg">{where.path}</span>;
  const link = where.link;
  return <button type="button" onClick={() => navigateTo(link, nav)}
    className="inline-flex items-center gap-1 text-left text-xs text-accent-text underline decoration-line-strong underline-offset-2 hover:decoration-current">
    {where.path}<ArrowRight aria-hidden className="size-3" />
  </button>;
}

function Entry({ entry, ctx, nav }: { entry: CapabilityEntry; ctx: CapabilityContext; nav: CapabilityNavigator }) {
  const status = capabilityStatus(entry, ctx);
  const meta = STATE[status.state];
  return <li data-capability={entry.id} className="flex flex-col gap-1.5 rounded-lg border border-line p-3">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-[13px] font-semibold text-fg">{entry.name}</h3>
      {entry.wave && <Badge tone="accent" title="Added in this release">New</Badge>}
      <Badge tone={meta.tone} className="ml-auto" title={status.reason ?? undefined}>{meta.label}</Badge>
    </div>
    <p className="text-xs text-fg-muted">{entry.what}</p>
    <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[7rem_1fr]">
      <dt className="text-fg-subtle">Where</dt>
      <dd className="flex min-w-0 flex-col items-start gap-1">{entry.where.map((where, index) => <Where key={index} where={where} nav={nav} />)}</dd>
      <dt className="text-fg-subtle">Who</dt><dd className="text-fg">{entry.who}</dd>
      {entry.needs && <><dt className="text-fg-subtle">Bot needs</dt><dd className="text-fg">{entry.needs}</dd></>}
      {status.reason && <><dt className="text-fg-subtle">Status</dt><dd role="note" className="text-fg">{status.reason}</dd></>}
    </dl>
  </li>;
}

/** The page body; `context` overrides the live status (tests, galleries). */
export function CapabilitiesView({ nav, context, switches }: { nav: CapabilityNavigator; context: CapabilityContext; switches?: ReactNode }) {
  const [query, setQuery] = useState('');
  const entries = useMemo(() => filterCapabilities(CAPABILITIES, query), [query]);
  const shortcuts = useMemo(() => filterShortcuts(SHORTCUTS, query), [query]);
  return <section aria-labelledby="capabilities-title" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 sm:p-6">
    <header className="flex flex-col gap-1">
      <h1 id="capabilities-title" className="inline-flex items-center gap-2 text-lg font-semibold text-fg"><BookOpen aria-hidden className="size-5" />Capabilities & shortcuts</h1>
      <p className="text-xs text-fg-muted">What the bot and this dashboard can do, where to find it, who can use it and what Discord must allow. Press <kbd className="font-mono">?</kbd> anywhere for the shortcuts.</p>
    </header>
    {switches && <section aria-label="Quick switches" className="flex flex-col gap-2 rounded-lg border border-line p-3">{switches}</section>}
    <div className="relative max-w-md">
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
      <Input type="search" aria-label="Search capabilities" placeholder="Search: evidence, /tcg-test, ban, Alt…" value={query}
        maxLength={120} onChange={event => setQuery(event.target.value)} className="pl-8" />
    </div>
    <p aria-live="polite" className="text-2xs text-fg-subtle">{entries.length} of {CAPABILITIES.length} capabilities · {shortcuts.length} shortcuts</p>
    {CAPABILITY_AREAS.map(area => {
      const items = entries.filter(entry => entry.area === area);
      if (!items.length) return null;
      return <section key={area} aria-label={area} className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">{area}</h2>
        <ul className="grid gap-2 lg:grid-cols-2">{items.map(entry => <Entry key={entry.id} entry={entry} ctx={context} nav={nav} />)}</ul>
      </section>;
    })}
    {shortcuts.length > 0 && <section aria-label="Keyboard shortcuts" className="flex flex-col gap-2">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-fg-subtle">Keyboard shortcuts</h2>
      <ShortcutList entries={shortcuts} />
    </section>}
    {entries.length === 0 && shortcuts.length === 0 && <EmptyState compact icon={<Search />} title="Nothing matches" description="Try another word." />}
  </section>;
}

export function CapabilitiesPage({ nav }: { nav: CapabilityNavigator }) {
  const context = useCapabilityContext();
  const session = useSession();
  // The setup profile's switches (dashboard actions, voice monitoring), reused from the setup feature.
  const switches = session.session?.localSettings ? <><DashboardActionsSwitch /><VoiceMonitoringSwitch /></> : undefined;
  return <CapabilitiesView nav={nav} context={context} switches={switches} />;
}
