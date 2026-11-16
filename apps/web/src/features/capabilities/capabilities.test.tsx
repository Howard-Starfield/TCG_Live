import { CAPABILITIES as SESSION_CAPABILITIES, type EvidenceItemDto, type ModCaseDto, type ModerationFlagDto } from '@tcg-live/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderConsole, sessionFixture } from '../../app/testing';
import { json } from '../../data/test/fakes';
import { adminToolsTabs } from '../admin-tools/registry';
import { formatConsoleHash, parseConsoleHash, writeConsoleRoute } from '../admin-tools/navigation';
import { collectPages, csvCell, exportContent, flattenRow, toCsv } from '../admin-tools/shared/exportData';
import { withEvidence } from '../admin-tools/members/AttachToCase';
import { toggleEvidence } from '../admin-tools/members/CaseEvidencePicker';
import { moderationMenuEntries } from '../admin-tools/members/ModerateMembersMenu';
import { filterFlags } from '../moderation/FlagsTab';
import { CAPABILITIES, CAPABILITY_AREAS, SHORTCUTS, filterCapabilities, filterShortcuts } from './capabilities';
import { CapabilitiesView, navigateTo } from './CapabilitiesPage';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { capabilityStatus, type CapabilityContext } from './status';

MotionGlobalConfig.skipAnimations = true;

const ctx = (patch: Partial<CapabilityContext> = {}): CapabilityContext => ({
  dashboardActions: true, mounted: { tournaments: true, evidence: true, moderation: true, adminTools: true, demo: true },
  voice: { monitor: true, recording: true }, intents: { guildMembers: 'on', messageContent: 'on' }, issues: [], ...patch });
const nav = () => ({ showHome: vi.fn(), showDrafts: vi.fn(), followActive: vi.fn(), showAdminTools: vi.fn() });

afterEach(() => { window.history.replaceState(null, '', '/'); });

describe('capabilities data', () => {
  it('has unique IDs, covers every area and links only to real admin-tools tabs', () => {
    expect(new Set(CAPABILITIES.map(entry => entry.id)).size).toBe(CAPABILITIES.length);
    for (const area of CAPABILITY_AREAS) expect(CAPABILITIES.some(entry => entry.area === area)).toBe(true);
    const tabs = new Set(adminToolsTabs.map(tab => tab.id));
    for (const entry of CAPABILITIES) for (const where of entry.where) {
      if (where.kind === 'dashboard' && where.link?.page === 'admin-tools') {
        expect(where.link.tab, entry.id).toBeDefined();
        expect(tabs.has(where.link.tab!), `${entry.id} -> ${where.link.tab}`).toBe(true);
        // The deep link it ends up in round-trips.
        expect(parseConsoleHash(formatConsoleHash({ page: 'admin-tools', tab: where.link.tab!, item: null })))
          .toEqual({ page: 'admin-tools', tab: where.link.tab, item: null });
      }
      if (where.kind === 'dashboard' && where.link) expect(['home', 'drafts', 'event', 'admin-tools', 'capabilities']).toContain(where.link.page);
      if (where.kind === 'command') expect(where.syntax).toMatch(/^\/tcg-(test|staff|admin) /);
    }
  });

  it('matches the final Discord command structure', () => {
    const syntax = CAPABILITIES.flatMap(entry => entry.where).flatMap(where => where.kind === 'command' ? [where.syntax] : []);
    const sub = (command: string) => new Set(syntax.filter(item => item.startsWith(`/${command} `)).flatMap(item => item.split(' ')[1]!.split('|')));
    // /tcg-test is the player command: evidence and recording-optout only.
    expect([...sub('tcg-test')].sort()).toEqual(['evidence', 'recording-optout']);
    for (const name of ['publish', 'signup-close', 'signup-reopen', 'signup-remove', 'signup-add', 'checkin-for', 'refresh', 'resolve', 'correct', 'judge-resume', 'judge-close', 'evidence-reply'])
      expect(sub('tcg-staff').has(name), name).toBe(true);
    for (const name of ['status', 'warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'case', 'note'])
      expect(sub('tcg-admin').has(name), name).toBe(true);
    // A temporary ban is `ban` with a duration, not its own subcommand.
    expect(sub('tcg-admin').has('tempban')).toBe(false);
  });

  it('describes match rooms and room chat transcripts, linking the Rooms tab', () => {
    const rooms = CAPABILITIES.find(entry => entry.id === 'match-rooms')!;
    expect(rooms.what).toMatch(/2 per 10 minutes/);
    expect(rooms.where).toContainEqual(expect.objectContaining({ kind: 'dashboard', link: { page: 'admin-tools', tab: 'rooms' } }));
    expect(rooms.checks).toContain('perm:tournament.roundRooms');
    const chat = CAPABILITIES.find(entry => entry.id === 'room-chat')!;
    expect(chat.needs).toMatch(/Manage Messages/);
    expect(chat.what).toMatch(/Message Content intent/);
    expect(CAPABILITIES.find(entry => entry.id === 'setup-wizard')!.what).not.toMatch(/voice room/);
  });

  it('states who may use each staff action, and that /tcg-staff is visible to everyone', () => {
    const entry = (id: string) => CAPABILITIES.find(item => item.id === id)!;
    expect(entry('tcg-staff-command').what).toContain('visible to everyone');
    expect(entry('tcg-publish').who).toContain('TCG Organizer');
    expect(entry('tcg-publish').who).toContain('TCG Judge cannot');
    for (const id of ['tcg-resolve', 'tcg-correct', 'tcg-judge-resume', 'tcg-judge-close', 'tcg-evidence-reply'])
      expect(entry(id).who, id).toMatch(/TCG Judge.*not on a match they are playing in/);
    expect(entry('tcg-checkin-for').who).toContain('TCG Judge');
    expect(entry('tcg-signup-add').what).toContain('organizers may play');
    expect(CAPABILITIES.map(item => item.who + item.what).join(' ')).not.toContain('Manage Server by default');
  });

  it('lists every required shortcut', () => {
    const text = SHORTCUTS.map(entry => `${entry.keys.flat().join('+')} ${entry.what}`).join('\n');
    for (const key of ['?', 'Alt+1', 'Alt+2', '/', '@', 'Ctrl+Enter', '⌘+Enter', 'Esc', 'Backspace', 'Home', 'End', 'Space', ','])
      expect(text).toContain(key);
  });

  it('searches by every word across name, syntax, who and needs', () => {
    expect(filterCapabilities(CAPABILITIES, 'judge-resume').map(entry => entry.id)).toContain('tcg-judge-resume');
    expect(filterCapabilities(CAPABILITIES, 'judge-resume reason').map(entry => entry.id)).toEqual(['tcg-judge-resume']);
    expect(filterCapabilities(CAPABILITIES, 'ban members').length).toBeGreaterThan(0);
    expect(filterCapabilities(CAPABILITIES, 'zzz-nothing')).toEqual([]);
    expect(filterShortcuts(SHORTCUTS, 'alt').length).toBe(2);
  });
});

describe('capability status', () => {
  const entry = (id: string) => CAPABILITIES.find(item => item.id === id)!;
  it('is available when every check passes', () => {
    expect(capabilityStatus(entry('tcg-publish'), ctx()).state).toBe('available');
  });
  it('turns off with dashboard actions, voice or a missing feature', () => {
    expect(capabilityStatus(entry('tcg-publish'), ctx({ dashboardActions: false })).state).toBe('off');
    expect(capabilityStatus(entry('voice-recording'), ctx({ voice: { monitor: true, recording: false } }))).toMatchObject({ state: 'off' });
    expect(capabilityStatus(entry('at-cases'), ctx({ mounted: { ...ctx().mounted, adminTools: false } })).state).toBe('off');
  });
  it('needs setup for a missing intent or a permission issue', () => {
    expect(capabilityStatus(entry('at-logs'), ctx({ intents: { guildMembers: 'off', messageContent: 'on' } }))).toMatchObject({ state: 'needs-setup' });
    const issue = { severity: 'warning', kind: 'permission', featureId: 'members.ban', feature: 'Moderation tools', permission: 'Ban Members',
      scope: { kind: 'guild' }, why: 'x', fix: 'Grant it.' } as const;
    expect(capabilityStatus(entry('at-bans'), ctx({ issues: [issue] }))).toEqual({ state: 'needs-setup', reason: 'Ban Members: Grant it.' });
  });
});

describe('Capabilities page', () => {
  it('filters with the search box and links into the dashboard', async () => {
    const user = userEvent.setup();
    const navigator = nav();
    render(<CapabilitiesView nav={navigator} context={ctx({ dashboardActions: false })} />);
    expect(screen.getByRole('heading', { name: /Capabilities & shortcuts/ })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Keyboard shortcuts' })).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search capabilities' }), 'cases');
    const card = document.querySelector('[data-capability="at-cases"]') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Admin tools > Cases/ }));
    expect(navigator.showAdminTools).toHaveBeenCalled();
    expect(window.localStorage.getItem('tcg-admin.admin-tools.tab.v1') ?? 'cases').toBe('cases');
    await user.clear(screen.getByRole('searchbox', { name: 'Search capabilities' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search capabilities' }), 'publish the round');
    const publish = document.querySelector('[data-capability="tcg-publish"]') as HTMLElement;
    expect(within(publish).getByText('Turned off')).toBeTruthy();
    expect(within(publish).getByText('/tcg-staff publish')).toBeTruthy();
  });

  it('navigateTo routes every link kind', () => {
    const navigator = { ...nav(), showCapabilities: vi.fn() };
    navigateTo({ page: 'home' }, navigator); navigateTo({ page: 'drafts' }, navigator); navigateTo({ page: 'event' }, navigator);
    navigateTo({ page: 'capabilities' }, navigator);
    expect(navigator.showHome).toHaveBeenCalled(); expect(navigator.showDrafts).toHaveBeenCalled(); expect(navigator.followActive).toHaveBeenCalled();
    expect(navigator.showCapabilities).toHaveBeenCalled();
  });

  it('every Admin tools link opens its tab and the #/admin-tools/<tab> deep link', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/#/capabilities');
    renderConsole({ setup: server => server.always('GET /session', () => json(200, { ...sessionFixture, adminTools: true, moderation: true,
      capabilities: [...SESSION_CAPABILITIES] })) });
    await screen.findByRole('heading', { name: /Capabilities & shortcuts/ });
    const links = new Map<string, string>();
    for (const entry of CAPABILITIES) for (const where of entry.where)
      if (where.kind === 'dashboard' && where.link?.page === 'admin-tools' && where.link.tab && !links.has(where.link.tab)) links.set(where.link.tab, entry.id);
    expect([...links.keys()]).toEqual(expect.arrayContaining(['members', 'cases', 'settings', 'lfg', 'bots']));
    for (const [tabId, entryId] of links) {
      const card = document.querySelector(`[data-capability="${entryId}"]`) as HTMLElement;
      const button = within(card).getAllByRole('button').find(item => item.textContent?.startsWith('Admin tools >'))!;
      await user.click(button);
      const label = adminToolsTabs.find(item => item.id === tabId)!.label;
      await waitFor(() => expect(screen.getByRole('tab', { name: new RegExp(`^${label}$`), selected: true })).toBeTruthy());
      await waitFor(() => expect(window.location.hash).toBe(`#/admin-tools/${tabId}`));
      await user.click(screen.getAllByRole('button', { name: /^Capabilities$/ })[0]!);
      await screen.findByRole('heading', { name: /Capabilities & shortcuts/ });
    }
  }, 30_000);
});

describe('"?" shortcuts overlay', () => {
  it('opens on ? anywhere, not while typing, and links to the page', async () => {
    const open = vi.fn();
    render(<><input aria-label="typing here" /><ShortcutsOverlay onOpenPage={open} /></>);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'typing here' }), { key: '?' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document.body, { key: '?', ctrlKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document.body, { key: '?' });
    const dialog = await screen.findByRole('dialog', { name: /Keyboard shortcuts/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'All capabilities & shortcuts' }));
    expect(open).toHaveBeenCalled();
  });

  it('stays closed while another dialog or a menu has focus', () => {
    render(<><div role="dialog" aria-modal="true" aria-label="Ban member"><button type="button">Cancel</button></div>
      <div role="menu" aria-label="Moderate"><button type="button" role="menuitem">Warn</button></div><ShortcutsOverlay /></>);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: '?' });
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.queryByRole('dialog', { name: /Keyboard shortcuts/ })).toBeNull();
  });

  it('reaches the page from the account menu and keeps it in the address bar', async () => {
    const user = userEvent.setup();
    renderConsole({ setup: server => server.always('GET /session', () => json(200, { ...sessionFixture, capabilities: [...SESSION_CAPABILITIES] })) });
    await user.click(await screen.findByRole('button', { name: /Theme and account/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Capabilities & shortcuts/ }));
    expect(await screen.findByRole('heading', { name: /Capabilities & shortcuts/ })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe('#/capabilities'));
  });
});

describe('deep links', () => {
  it('parses and formats console routes without touching the login fragment or galleries', () => {
    expect(parseConsoleHash('#/admin-tools/cases/12')).toEqual({ page: 'admin-tools', tab: 'cases', item: '12' });
    expect(parseConsoleHash('#/admin-tools')).toEqual({ page: 'admin-tools', tab: null, item: null });
    expect(parseConsoleHash('#/capabilities')).toEqual({ page: 'capabilities' });
    expect(parseConsoleHash('#login=abc')).toBeNull();
    expect(parseConsoleHash('#/__kit')).toBeNull();
    expect(parseConsoleHash('#/admin-tools/cases/12/x')).toBeNull();
    expect(parseConsoleHash('#/admin-tools/<script>')).toBeNull();
    expect(formatConsoleHash({ page: 'admin-tools', tab: 'tickets', item: 'abc' })).toBe('#/admin-tools/tickets/abc');
  });

  it('never overwrites a pending login fragment', () => {
    window.history.replaceState(null, '', '/#login=secret');
    writeConsoleRoute({ page: 'capabilities' });
    expect(window.location.hash).toBe('#login=secret');
    window.history.replaceState(null, '', '/#/admin-tools/cases');
    writeConsoleRoute(null);
    expect(window.location.hash).toBe('');
  });

  it('a reload on #/admin-tools/cases opens the Cases tab', async () => {
    window.history.replaceState(null, '', '/#/admin-tools/cases/1');
    renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, adminTools: true }));
      server.always('GET /admin-tools/cases?limit=50', () => json(200, { cases: [], nextBefore: null }));
      server.always('GET /admin-tools/cases/1', () => json(404, { error: { code: 'not_found', message: 'No such case.' } }));
    } });
    await waitFor(() => expect(screen.getByRole('tab', { name: /Cases/, selected: true })).toBeTruthy());
  });
});

describe('exports', () => {
  it('flattens, escapes and guards formula cells', () => {
    expect(flattenRow({ a: { b: 1 }, c: [1, 2], d: null })).toEqual({ 'a.b': 1, c: '[1,2]', d: null });
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(' =HYPERLINK("x")')).toBe(`"' =HYPERLINK(""x"")"`);
    expect(csvCell('＝1+1')).toBe("'＝1+1");
    expect(csvCell(-5)).toBe('-5');
    expect(exportContent({ rows: [{ a: 1 }], truncated: false }, 'csv').charCodeAt(0)).toBe(0xfeff);
    expect(toCsv([{ x: 1, y: 'a' }, { x: 2, z: true }])).toBe('x,y,z\r\n1,a,\r\n2,,true\r\n');
  });

  it('pages until the end or the cap, and says when it was cut short', async () => {
    const pages = [[{ n: 1 }, { n: 2 }], [{ n: 3 }], []];
    const result = await collectPages<number>(0, async cursor => ({ rows: pages[cursor]!, next: cursor < 2 ? cursor + 1 : null }));
    expect(result).toEqual({ rows: [{ n: 1 }, { n: 2 }, { n: 3 }], truncated: false });
    const capped = await collectPages<number>(0, async cursor => ({ rows: [{ n: cursor }, { n: cursor }], next: cursor + 1 }), 3);
    expect(capped.rows).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    expect(JSON.parse(exportContent(capped, 'json')).note).toMatch(/first/);
  });
});

describe('case evidence and moderation helpers', () => {
  it('attaches evidence once, up to 10 per case', () => {
    const item = { evidenceIds: ['a'] } as Pick<ModCaseDto, 'evidenceIds'>;
    expect(withEvidence(item, 'b')).toEqual(['a', 'b']);
    expect(withEvidence(item, 'a')).toEqual(['a']);
    expect(withEvidence({ evidenceIds: Array.from({ length: 10 }, (_, i) => String(i)) }, 'x')).toBeNull();
    expect(toggleEvidence(['a'], 'a')).toEqual([]);
    expect(toggleEvidence(Array.from({ length: 10 }, (_, i) => String(i)), 'x')).toHaveLength(10);
  });

  it('builds per-member moderation menus', () => {
    const choose = vi.fn();
    const one = moderationMenuEntries([{ id: '1', name: 'Ava' }], choose);
    expect(one.map(entry => ('label' in entry ? entry.label : ''))).toEqual(['Warn', 'Timeout', 'Kick', 'Ban']);
    const two = moderationMenuEntries([{ id: '1', name: 'Ava' }, { id: '2', name: 'Ben' }], choose);
    expect(two.filter(entry => 'type' in entry && entry.type === 'label')).toHaveLength(2);
  });

  it('filters flags by review state', () => {
    const base = { guildId: '1', channelId: null, eventId: null, matchId: null, userId: null, occurredAtMs: 1, kind: 'volume',
      detail: { peakDbfs: -1, rmsDbfs: -2, sustainedMs: 1, thresholdDbfs: -3 } };
    const flags = [{ ...base, id: 1 }, { ...base, id: 2, review: { state: 'dismissed', atMs: 1, by: 'local-admin' } }] as ModerationFlagDto[];
    expect(filterFlags(flags, 'all', 'all', 'open').map(flag => flag.id)).toEqual([1]);
    expect(filterFlags(flags, 'all', 'all', 'dismissed').map(flag => flag.id)).toEqual([2]);
  });
});

// Keeps the evidence DTO import used for type-level checks of the picker helpers.
export type _Evidence = EvidenceItemDto;
