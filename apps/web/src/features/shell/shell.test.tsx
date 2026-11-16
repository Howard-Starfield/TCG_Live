import { final, FIXTURE_NOW_MS, liveDispute, liveInterrupted } from '@tcg-live/core/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoot } from '../../app/AppRoot';
import { mockMatchMedia, renderConsole, sessionFixture, summaryOf } from '../../app/testing';
import { change, frame, json } from '../../data/test/fakes';
import { databasePill, discordPill, eventLabel } from './labels';
import { clampDockWidth, DOCK_MIN, MAIN_MIN } from './PreviewDock';
import { isTypingTarget } from './useShortcuts';

const ready = () => screen.findByRole('heading', { name: /Needs you/ });
const toggle = (name: 'Live preview' | 'List preview') => screen.getByRole('button', { name: new RegExp(`^${name}`) });

let restoreMedia: (() => void) | null = null;
afterEach(() => {
  restoreMedia?.();
  restoreMedia = null;
});

describe('top bar', () => {
  it('shows the breadcrumb TCG Live › event › stage', async () => {
    renderConsole();
    await ready();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('TCG Live')).toBeInTheDocument();
    expect(within(crumbs).getByText(eventLabel(liveDispute))).toBeInTheDocument();
    expect(within(crumbs).getByText('Round 1')).toHaveAttribute('aria-current', 'page');
  });

  it('toggles panes with aria-pressed and persists them', async () => {
    const user = userEvent.setup();
    const { preferences } = renderConsole();
    await ready();
    expect(toggle('Live preview')).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle('Live preview'));
    expect(toggle('Live preview')).toHaveAttribute('aria-pressed', 'true');
    expect(preferences.getSnapshot().panes).toEqual({ live: true, list: false, kanban: false });
    expect(await screen.findByTestId('live-preview')).toHaveAttribute('data-event', liveDispute.eventId);

    await user.click(toggle('List preview'));
    expect(preferences.getSnapshot().panes).toEqual({ live: true, list: true, kanban: false });
    expect(screen.getByTestId('list-preview')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize live and list previews' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close live preview' }));
    expect(preferences.getSnapshot().panes).toEqual({ live: false, list: true, kanban: false });
  });

  it('restores open panes from preferences on the next visit', async () => {
    const first = renderConsole({ preferences: { panes: { live: true, list: true }, sizes: { split: 0.6 } } });
    await ready();
    expect(toggle('Live preview')).toHaveAttribute('aria-pressed', 'true');
    expect(toggle('List preview')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('separator', { name: 'Resize live and list previews' })).toHaveAttribute('aria-valuenow', '60');
    cleanup();
    render(<AppRoot data={first.data} preferences={first.preferences} />);
    await ready();
    expect(toggle('Live preview')).toHaveAttribute('aria-pressed', 'true');
  });

  it('Alt+1 and Alt+2 toggle the previews, but not while typing', async () => {
    const { preferences } = renderConsole();
    await ready();
    fireEvent.keyDown(document.body, { key: '1', code: 'Digit1', altKey: true });
    expect(preferences.getSnapshot().panes.live).toBe(true);
    fireEvent.keyDown(document.body, { key: '2', code: 'Digit2', altKey: true });
    expect(preferences.getSnapshot().panes.list).toBe(true);
    fireEvent.keyDown(document.body, { key: '1', code: 'Digit1', altKey: true });
    expect(preferences.getSnapshot().panes.live).toBe(false);

    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: '1', code: 'Digit1', altKey: true });
    expect(preferences.getSnapshot().panes.live).toBe(false);
    fireEvent.keyDown(document.body, { key: '1', code: 'Digit1', altKey: true, ctrlKey: true });
    expect(preferences.getSnapshot().panes.live).toBe(false);
    input.remove();
  });

  it('chips: demo mode reads "Demo"; real states read sensibly', () => {
    expect(discordPill(undefined).detail).toBe('Checking');
    expect(discordPill({ ...statusOf(), gateway: 'not_applicable' })).toMatchObject({ state: 'idle', detail: 'Demo' });
    expect(discordPill({ ...statusOf(), mode: 'discord', gateway: 'reconnecting' })).toMatchObject({ state: 'reconnecting' });
    expect(databasePill({ ...statusOf(), database: 'not_configured' })).toMatchObject({ state: 'idle', detail: 'Demo' });
    expect(databasePill({ ...statusOf(), mode: 'discord', database: 'unavailable' })).toMatchObject({ state: 'offline', detail: 'Unavailable' });
  });

  it('theme menu updates the preference and rotate link confirms, then toasts', async () => {
    const user = userEvent.setup();
    const { preferences, server } = renderConsole();
    await ready();
    await user.click(screen.getByRole('button', { name: /Theme and account/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    expect(preferences.getSnapshot().theme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');

    await user.click(screen.getByRole('button', { name: /Theme and account/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Rotate console link/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Rotate the console link?' });
    await user.click(within(dialog).getByRole('button', { name: 'Rotate link' }));
    expect(await screen.findByText('New console link printed in the terminal')).toBeInTheDocument();
    expect(server.callsTo('POST /session/rotate-link')).toHaveLength(1);
  });
});

describe('pane focus', () => {
  it('closing a pane from inside returns focus to its top-bar toggle', async () => {
    const user = userEvent.setup();
    renderConsole({ preferences: { panes: { live: true, list: true } } });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Close list preview' }));
    await waitFor(() => expect(document.activeElement).toBe(toggle('List preview')));

    // Alt+1 with focus inside the live pane does the same.
    screen.getByRole('button', { name: 'Close live preview' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: '1', code: 'Digit1', altKey: true });
    await waitFor(() => expect(document.activeElement).toBe(toggle('Live preview')));
  });

  it('the audit counter is quiet unless filters are active', async () => {
    renderConsole({ preferences: { panes: { live: false, list: true }, listTab: 'audit' } });
    await ready();
    const counter = await screen.findByText(/loaded$/);
    expect(counter).toHaveAttribute('aria-live', 'off');
  });
});

describe('preview dock layout', () => {
  it('clamps the dock so the main controls keep their minimum width', () => {
    expect(clampDockWidth(2000, 1200)).toBe(1200 - MAIN_MIN);
    expect(clampDockWidth(100, 1200)).toBe(DOCK_MIN);
    expect(clampDockWidth(500, 1200)).toBe(500);
  });

  it('desktop: panes sit in the dock; the dock width handle is keyboard operable and persists', async () => {
    const { preferences } = renderConsole({ preferences: { panes: { live: true, list: false }, sizes: { dockWidth: 480 } } });
    await ready();
    expect(screen.getByTestId('preview-dock')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-sheet')).not.toBeInTheDocument();
    const handle = screen.getByRole('separator', { name: 'Resize previews' });
    // jsdom bodies measure 800 px, so the dock is clamped to leave the main controls their minimum.
    const before = Number(handle.getAttribute('aria-valuenow'));
    expect(before).toBe(clampDockWidth(480, 800));
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(preferences.getSnapshot().sizes.dockWidth).toBe(before - 16);
  });

  it('below 1100 px the previews open as a dismissible, focus-managed sheet', async () => {
    restoreMedia = mockMatchMedia(query => query.includes('1099'));
    const user = userEvent.setup();
    const { preferences } = renderConsole({ preferences: { panes: { live: true, list: false } } });
    await ready();
    // The persisted pane does not cover the console on load.
    expect(screen.queryByTestId('preview-sheet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-dock')).not.toBeInTheDocument();
    expect(toggle('Live preview')).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle('Live preview'));
    const sheet = await screen.findByRole('dialog', { name: 'Previews' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    expect(within(sheet).getByTestId('live-preview')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Previews' })).not.toBeInTheDocument());
    expect(preferences.getSnapshot().panes.live).toBe(true);   // desktop layout is kept
    expect(toggle('Live preview')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('home', () => {
  it('orders scheduled tournaments, hides dated drafts, and fills a deleted slot with quick create', async () => {
    const user = userEvent.setup();
    const active = { ...summaryOf(liveDispute), name: 'Live Cup', game: 'pokemon' };
    const base = { game: 'pokemon', status: 'draft', kind: 'signup', createdAtMs: 1, retiredAtMs: null };
    const soon = { ...base, eventId: 'soon', name: 'Soon Cup', startsAtMs: 4096000000000, signupOpensAtMs: 4095999000000 };
    const later = { ...base, eventId: 'later', name: 'Later Cup', startsAtMs: 4097000000000, signupOpensAtMs: 4096999000000 };
    const draft = { ...base, eventId: 'draft', name: 'Dated draft', startsAtMs: 4095000000000 };
    let entries = [draft, later, active, soon];
    renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', tournaments: true }));
      server.always('GET /tournaments', () => json(200, { entries, defaultGame: 'pokemon' }));
      server.always('DELETE /tournaments/drafts/soon', () => {
        entries = entries.filter(entry => entry.eventId !== soon.eventId);
        return json(200, {});
      });
    } });
    const region = within(await screen.findByRole('region', { name: 'Upcoming and live' }));
    expect((await region.findAllByRole('heading', { level: 3 })).map(node => node.textContent))
      .toEqual(['Live Cup', 'Soon Cup', 'Later Cup']);
    fireEvent.contextMenu(region.getByRole('button', { name: 'Open Soon Cup' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete draft…' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(region.queryByRole('heading', { name: 'Soon Cup' })).not.toBeInTheDocument());
    await user.click(region.getByRole('button', { name: 'Create tournament' }));
    expect(await screen.findByRole('dialog', { name: 'Create signup tournament' })).toBeInTheDocument();
  });

  it('shows live player counts and opens the match behind a judge or confirmation alert', async () => {
    const user = userEvent.setup();
    renderConsole({
      snapshot: { ...liveDispute, matches: liveDispute.matches.map(match => match.id === 'M1'
        ? { ...match, proposal: { revision: 1, winner: 'A', reporter: 'A', decision: 'open' } }
        : match) },
      setup: server => {
        server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord' }));
      }
    });
    await screen.findByRole('heading', { name: 'Home' });
    const chart = await screen.findByRole('list', { name: 'Player counts' }, { timeout: 5000 });
    expect(within(chart).getAllByRole('listitem').map(row => row.textContent)).toEqual(['Joined4', 'Assigned4', 'Checked in4']);
    const actions = screen.getByRole('region', { name: 'Tournament task board' });
    expect(screen.getByRole('heading', { name: 'Matches' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Action needed' })).not.toBeInTheDocument();
    expect(within(actions).getByText('Awaiting result confirmation')).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Match M1' })).toBeInTheDocument();
    await user.click(within(actions).getByRole('button', { name: 'Match M2' }));
    // The card opens the match drawer; it does not navigate away from Home.
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(screen.getByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Needs you/ })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Open in tournament view' }));
    await ready();
    expect(screen.getByRole('button', { name: 'Match M2', pressed: true })).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    await user.click(within(sidebar).getByRole('button', { name: 'Collapse sidebar' }));
    await user.click(within(sidebar).getByRole('button', { name: 'Home' }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('sidebar', () => {
  it('creates a pending tournament without switching the active signup', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', tournaments: true }));
      server.always('GET /tournaments', () => json(200, { defaultGame: 'one-piece', entries: [{
        eventId: 'previous-one-piece', name: 'Previous Grand Line Cup', game: 'one-piece', status: 'retired', kind: 'signup',
        createdAtMs: 1, retiredAtMs: 2, signupChannelId: '100000000000000008', bannerStyle: 'compact'
      }] }));
      server.always('GET /tournaments/signup-channels', () => json(200, [
        { id: '100000000000000008', name: 'previous-signups' }, { id: '100000000000000009', name: 'one-piece-signups' }
      ]));
      server.always('POST /tournaments/drafts', call => {
        const input = call.body as { draftId: string; startsAtMs: number };
        server.always(`POST /tournaments/${input.draftId}/open-signup`, () => json(200, { eventId: input.draftId, panels: 'posted' }));
        return json(201, { eventId: input.draftId, name: 'Grand Line Cup', game: 'one-piece', status: 'draft',
          kind: 'signup', createdAtMs: liveDispute.createdAtMs, retiredAtMs: null, startsAtMs: input.startsAtMs });
      });
    } });
    await screen.findByRole('list', { name: 'Player counts' });
    await user.click(screen.getByRole('button', { name: 'Create signup tournament' }));
    const dialog = screen.getByRole('dialog', { name: 'Create signup tournament' });
    const title = within(dialog).getByRole('textbox', { name: 'Tournament name' });
    await user.clear(title);
    await user.type(title, 'Grand Line Cup');
    const ruleSettings = within(dialog).getByText('Rule settings');
    expect(ruleSettings.closest('details')).not.toHaveAttribute('open');
    await user.click(ruleSettings);
    const timer = within(dialog).getByRole('spinbutton', { name: 'Match timer in minutes' });
    expect(timer).toHaveValue(30);
    await user.clear(timer);
    await user.type(timer, '35');
    const capacity = within(dialog).getByRole('spinbutton', { name: 'Signup limit' });
    expect(capacity).toHaveValue(100);
    await user.clear(capacity);
    await user.type(capacity, '101');
    const bye = within(dialog).getByRole('spinbutton', { name: 'Pairing bye' });
    expect(bye).toHaveValue(3);
    await user.clear(bye);
    await user.type(bye, '2');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Match format' }), 'bo3');
    await user.click(ruleSettings);
    expect(ruleSettings.closest('details')).not.toHaveAttribute('open');
    await user.type(within(dialog).getByRole('textbox', { name: 'Tournament details' }), 'Bring your camera.');
    const banner = within(dialog).getByRole('combobox', { name: 'Signup banner' });
    expect(banner).toHaveValue('compact');
    await user.selectOptions(banner, 'game');
    await within(dialog).findByRole('option', { name: '#one-piece-signups' });
    const channel = within(dialog).getByRole('combobox', { name: 'Discord signup channel' });
    expect(channel).toHaveValue('100000000000000008');
    await user.selectOptions(channel, '100000000000000009');
    const create = within(dialog).getByRole('button', { name: /^Create$/ });
    expect(create).toBeDisabled();
    const start = '2099-10-21T15:30';
    fireEvent.change(within(dialog).getByLabelText('Tournament start date and time'), { target: { value: start } });
    expect(create).toBeEnabled();
    const signupTiming = within(dialog).getByRole('combobox', { name: 'Signup opens' });
    expect(signupTiming).toHaveValue('immediate');
    await user.selectOptions(signupTiming, 'scheduled');
    expect(create).toBeDisabled();
    await user.selectOptions(signupTiming, 'immediate');
    await user.click(create);
    expect(await screen.findByText('Discord signup queued')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Grand Line Cup' })).toBeInTheDocument();
    const body = server.callsTo('POST /tournaments/drafts')[0]?.body as { draftId: string; signupOpensAtMs: number };
    expect(body.signupOpensAtMs).toBeLessThanOrEqual(Date.now());
    expect(body).toMatchObject({ name: 'Grand Line Cup', game: 'one-piece', matchMinutes: 35, startsAtMs: new Date(start).getTime(),
      description: 'Bring your camera.', signupCapacity: 101, swissRules: { byePoints: 2, matchFormat: 'bo3', roundCount: 0 }, bannerStyle: 'game', signupChannelId: '100000000000000009' });
    expect(server.callsTo(`POST /tournaments/${body.draftId}/open-signup`)).toHaveLength(0);
  });

  it('uses the dashboard context menu to confirm active tournament deletion', async () => {
    const user = userEvent.setup();
    const entry = { eventId: liveDispute.eventId, name: 'Active Cup', game: 'pokemon', status: 'active',
      kind: 'signup', createdAtMs: liveDispute.createdAtMs, retiredAtMs: null };
    let deleted = false;
    const { server } = renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', tournaments: true }));
      server.always('GET /tournaments', () => json(200, { defaultGame: 'pokemon', entries: deleted ? [] : [entry] }));
      server.always(`DELETE /tournaments/${entry.eventId}`, () => {
        deleted = true;
        return json(200, { cleanupPending: false });
      });
    } });
    const sidebar = await screen.findByRole('navigation', { name: 'Active event' });
    expect(fireEvent.contextMenu(screen.getByRole('heading', { name: 'Home' }))).toBe(false);
    fireEvent.contextMenu(within(sidebar).getByRole('button', { name: /Active Cup/ }));
    const menu = await screen.findByRole('menu', { name: 'Actions for Active Cup' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete active tournament…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete Active Cup?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete active tournament' }));
    expect(await screen.findByText('Active tournament deleted')).toBeInTheDocument();
    expect(server.callsTo(`DELETE /tournaments/${entry.eventId}`)).toHaveLength(1);
  });

  it('restarts an ended event with editable settings and saves reusable templates separately', async () => {
    const user = userEvent.setup();
    const ended = { eventId: 'ended-cup', name: 'Grand Line Cup', game: 'one-piece', status: 'retired',
      kind: 'signup', createdAtMs: 1, retiredAtMs: 2, completed: true, startsAtMs: 3,
      description: 'Bring a camera.', matchMinutes: 45, signupCapacity: 80, bannerStyle: 'compact',
      signupChannelId: '100000000000000009' };
    const entries: unknown[] = [ended];
    const { server } = renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', tournaments: true }));
      server.always('GET /tournaments', () => json(200, { defaultGame: 'pokemon', entries }));
      server.always('GET /tournaments/signup-channels', () => json(200, [{ id: ended.signupChannelId, name: 'one-piece-signups' }]));
      server.always('POST /tournaments/drafts', call => {
        const body = call.body as object;
        const template = { ...body, eventId: 'saved-template', status: 'draft', kind: 'signup', createdAtMs: 4, retiredAtMs: null };
        entries.push(template);
        return json(200, template);
      });
    } });
    const history = await screen.findByRole('navigation', { name: 'Event history' });
    const row = within(history).getByRole('button', { name: /Grand Line Cup/ });
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole('menuitem', { name: 'Restart tournament…' }));
    const restart = await screen.findByRole('dialog', { name: 'Restart tournament' });
    expect(within(restart).getByRole('textbox', { name: 'Tournament name' })).toHaveValue(ended.name);
    expect(within(restart).getByRole('textbox', { name: 'Tournament details' })).toHaveValue(ended.description);
    expect(within(restart).getByLabelText('Tournament start date and time')).toHaveValue('');
    await user.click(within(restart).getByText('Rule settings'));
    expect(within(restart).getByRole('spinbutton', { name: 'Match timer in minutes' })).toHaveValue(45);
    expect(within(restart).getByRole('spinbutton', { name: 'Signup limit' })).toHaveValue(80);
    await user.click(within(restart).getByRole('button', { name: 'Cancel' }));
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole('menuitem', { name: 'Save as template' }));
    expect(await screen.findByText('Template saved')).toBeInTheDocument();
    expect(server.callsTo('POST /tournaments/drafts')[0]?.body).toMatchObject({
      isTemplate: true, name: ended.name, description: ended.description, signupChannelId: ended.signupChannelId
    });
    expect(server.callsTo('POST /tournaments/drafts')[0]?.body).not.toHaveProperty('startsAtMs');
    await user.click(screen.getByRole('button', { name: /^Drafts$/ }));
    await user.click(await screen.findByRole('button', { name: 'Use template Grand Line Cup' }));
    const template = await screen.findByRole('dialog', { name: 'Create from template' });
    expect(within(template).getByRole('textbox', { name: 'Tournament details' })).toHaveValue(ended.description);
    expect(within(template).getByLabelText('Tournament start date and time')).toHaveValue('');
  });

  it('shows a safe directory error and caps search to the API limit', async () => {
    renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', tournaments: true }));
      server.always('GET /tournaments', () => json(409,
        { error: { code: 'conflict', message: 'Tournament schema setup is required.' } }));
    } });
    expect(await screen.findByText('Tournament schema setup is required.')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search tournaments' })).toHaveAttribute('maxLength', '120');
  });

  it('queries the tournament directory after search input settles', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', tournaments: true }));
      server.always('GET /tournaments', call => {
        const query = new URL(call.url, 'http://localhost').searchParams.get('q') ?? '';
        return json(200, { entries: query === 'Poke' ? [{ eventId: 'draft-poke', name: 'Pokemon Cup', game: 'pokemon',
          status: 'draft', kind: 'signup', createdAtMs: liveDispute.createdAtMs, retiredAtMs: null, startsAtMs: 4096000000000 }] : [],
        defaultGame: 'pokemon' });
      });
    } });
    await screen.findByRole('searchbox', { name: 'Search tournaments' });
    await user.type(screen.getByRole('searchbox', { name: 'Search tournaments' }), 'Poke');
    expect(await screen.findByRole('button', { name: /Pokemon Cup/ })).toBeInTheDocument();
    expect(server.callsTo('GET /tournaments').some(call => call.url.endsWith('?q=Poke'))).toBe(true);
  });

  it('saves a named game draft without replacing the live event or requesting a match snapshot', async () => {
    const user = userEvent.setup();
    const active = { eventId: liveDispute.eventId, name: 'Live Cup', game: 'pokemon', status: 'active',
      kind: 'signup', createdAtMs: liveDispute.createdAtMs, retiredAtMs: null };
    const entries = [active];
    const { server } = renderConsole({ setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', tournaments: true }));
      server.always('GET /tournaments', call => {
        const query = new URL(call.url, 'http://localhost').searchParams.get('q')?.toLowerCase() ?? '';
        return json(200, { entries: entries.filter(item => item.name.toLowerCase().includes(query)), defaultGame: 'pokemon' });
      });
      server.always('POST /tournaments/drafts', call => {
        const body = call.body as { draftId: string; name: string; game: string };
        expect(body.draftId).toMatch(/^[0-9a-f-]{36}$/);
        const draft = { eventId: body.draftId, name: body.name, game: body.game, status: 'draft',
          kind: 'signup', createdAtMs: liveDispute.createdAtMs + 1, retiredAtMs: null };
        entries.unshift(draft);
        server.always(`POST /tournaments/${draft.eventId}/open-signup`, () => json(409, {
          error: { code: 'conflict', message: 'Finish the current round before opening a new tournament.' }
        }));
        return json(201, draft);
      });
    } });
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Live Cup' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create signup tournament' }));
    const dialog = screen.getByRole('dialog', { name: 'Create signup tournament' });
    expect(within(dialog).getByRole('textbox', { name: 'Tournament name' })).toHaveValue('Pokémon Tournament');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Game type' }), 'one-piece');
    expect(within(dialog).getByRole('textbox', { name: 'Tournament name' })).toHaveValue('One Piece Tournament');
    await user.clear(within(dialog).getByRole('textbox', { name: 'Tournament name' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Tournament name' }), 'Saturday Cup');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Game type' }), 'pokemon');
    expect(within(dialog).getByRole('textbox', { name: 'Tournament name' })).toHaveValue('Saturday Cup');
    await user.click(within(dialog).getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByRole('heading', { name: 'Saturday Cup' })).toBeInTheDocument();
    expect(screen.getByText(/Draft signup is not open/)).toBeInTheDocument();
    const draftRules = within(screen.getByRole('region', { name: 'Tournament draft' }));
    await user.click(draftRules.getByText('Rule settings'));
    expect(draftRules.getByText('100 players')).toBeVisible();
    expect(draftRules.getByText('Automatic from attendance')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Previews' })).not.toBeInTheDocument();
    expect(server.callsTo(`GET /events/${entries[0]!.eventId}/snapshot`)).toHaveLength(0);
    expect(server.callsTo('POST /tournaments/drafts')).toHaveLength(1);
    const activationPath = `POST /tournaments/${entries[0]!.eventId}/open-signup`;
    expect(server.callsTo(activationPath)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Open signup' }));
    const confirmation = await screen.findByRole('alertdialog', { name: 'Open signup for Saturday Cup?' });
    await user.click(within(confirmation).getByRole('button', { name: 'Open signup' }));
    expect(await screen.findByText('Finish the current round before opening a new tournament.')).toBeInTheDocument();
    expect(server.callsTo(activationPath)[0]?.body).toEqual({ expectedActiveEventId: liveDispute.eventId });
    await user.click(screen.getByRole('button', { name: /^Drafts$/ }));
    expect(await screen.findByRole('heading', { name: 'Drafts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Saturday Cup' })).toBeInTheDocument();
    await user.click(screen.getByText('Signup hasn’t opened', { exact: true }));
    expect(await screen.findByRole('heading', { name: 'Saturday Cup' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Drafts$/ }));
    const draft = await screen.findByRole('button', { name: 'Open Saturday Cup' });
    fireEvent.contextMenu(draft);
    const menu = await screen.findByRole('menu', { name: 'Actions for Saturday Cup' });
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Open tournament' })).toBeVisible());
    server.always(`DELETE /tournaments/drafts/${entries[0]!.eventId}`, () => {
      entries.shift();
      return json(200, { deleted: true });
    });
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete draft…' }));
    const deletion = await screen.findByRole('alertdialog', { name: 'Delete Saturday Cup?' });
    await user.click(within(deletion).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open Saturday Cup' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Live Cup/ }));
    expect(await screen.findByRole('group', { name: 'Previews' })).toBeInTheDocument();
  });

  it('filters event names and expands each section independently', async () => {
    const user = userEvent.setup();
    const retired = { ...final, eventId: 'retired-1', status: 'retired' as const, retiredAtMs: final.createdAtMs + 3_600_000 };
    renderConsole({ retired: [retired] });
    await ready();
    const liveToggle = screen.getByRole('button', { name: 'Active', expanded: true });
    const historyToggle = screen.getByRole('button', { name: 'History', expanded: true });
    const live = screen.getByRole('navigation', { name: 'Active event' });
    expect(within(live).getByRole('button')).toHaveTextContent('Created');
    await user.click(liveToggle);
    expect(liveToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Active event' })).not.toBeInTheDocument();
    expect(historyToggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(liveToggle);
    await user.type(screen.getByRole('searchbox', { name: 'Search tournaments' }), 'no such event');
    expect(screen.queryByRole('navigation', { name: 'Active event' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Event history' })).not.toBeInTheDocument();
    expect(screen.getByText('No matching live tournaments.')).toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search tournaments' }));
    expect(screen.getByRole('navigation', { name: 'Event history' })).toBeInTheDocument();
  });

  it('lists the active event first with a live marker and retired events as history', async () => {
    const user = userEvent.setup();
    const retired = { ...final, eventId: 'retired-1', status: 'retired' as const, retiredAtMs: final.createdAtMs + 3_600_000 };
    const { preferences } = renderConsole({ retired: [retired] });
    await ready();
    const live = screen.getByRole('navigation', { name: 'Active event' });
    expect(within(live).getByRole('button', { current: 'page' })).toHaveTextContent('(live)');
    const history = screen.getByRole('navigation', { name: 'Event history' });
    await user.click(within(history).getByRole('button'));
    expect(await screen.findByText('Retired event · read-only history.')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('History')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to the live event' }));
    await waitFor(() => expect(screen.queryByText('Retired event · read-only history.')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(preferences.getSnapshot().sidebarCollapsed).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('banners', () => {
  const banner = (id: string) => document.querySelector(`[data-banner="${id}"]`);

  it('lease lost and cards pending', async () => {
    renderConsole({ status: { lease: 'lost', cards: { updatePending: true } } });
    await ready();
    await waitFor(() => expect(banner('lease')).toHaveTextContent('lost the session lease'));
    expect(banner('lease')?.querySelector('[role="alert"]')).toHaveTextContent('lost the session lease');
    expect(banner('cards')).toHaveTextContent('Discord cards update pending');
  });

  it('database outage: hello without an active event shows a database banner, not "no active event"', async () => {
    renderConsole({ status: { database: 'unavailable' }, helloActiveEventId: null, snapshot: null });
    expect(await screen.findByTestId('waiting-for-database')).toBeInTheDocument();
    expect(banner('database')).toHaveTextContent('PostgreSQL is unavailable');
    expect(screen.queryByText('No active event')).not.toBeInTheDocument();
  });

  it('no active event and a healthy database: says so', async () => {
    renderConsole({ helloActiveEventId: null, snapshot: null });
    expect(await screen.findByText('No active event', { selector: 'p' })).toBeInTheDocument();
  });

  it('an interrupted clock', async () => {
    renderConsole({ snapshot: liveInterrupted });
    await ready();
    await waitFor(() => expect(banner('interrupted')).toHaveTextContent('A running clock belongs to another process…'));
  });

  it('stream reconnecting, with Retry now', async () => {
    const { bodies } = renderConsole();
    await ready();
    await waitFor(() => expect(bodies.length).toBe(1));
    await act(async () => { bodies[0]!.end(); });
    await waitFor(() => expect(banner('reconnecting')).toHaveTextContent('Reconnecting to the live stream'));
    expect(within(banner('reconnecting') as HTMLElement).getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    // The countdown is visible but outside the live region, so it is not re-announced every second.
    const status = banner('reconnecting')!.querySelector('[role="status"]')!;
    expect(status.textContent).not.toMatch(/\d+s/);
    const ticker = banner('reconnecting')!.querySelector('[data-banner-ticker]');
    if (ticker) {
      expect(ticker).toHaveAttribute('aria-hidden', 'true');
      expect(status.contains(ticker)).toBe(false);
    }
  });

  it('a past event that was active when cached shows as retired once a new event takes over', async () => {
    const user = userEvent.setup();
    const { bodies, server } = renderConsole();
    await ready();
    await waitFor(() => expect(bodies.length).toBe(1));
    const next = { ...liveDispute, eventId: 'event-2', version: 1, createdAtMs: liveDispute.createdAtMs + 3_600_000 };
    const retiredCopy = { ...liveDispute, status: 'retired' as const, retiredAtMs: next.createdAtMs, version: 18 };
    server.always('GET /events', () => new Response(JSON.stringify([summaryOf(next), summaryOf(retiredCopy)]), { status: 200, headers: { 'content-type': 'application/json' } }));
    server.always(`GET /events/${liveDispute.eventId}/snapshot`, () => new Response(JSON.stringify(retiredCopy), { status: 200, headers: { 'content-type': 'application/json' } }));
    server.always('GET /events/event-2/snapshot', () => new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } }));
    server.always('GET /events/event-2/audit', () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    const { event, id } = change(next, []);
    await act(async () => { bodies[0]!.push(frame(event, id)); });
    const history = await screen.findByRole('navigation', { name: 'Event history' });
    await user.click(within(history).getByRole('button'));
    expect(await screen.findByText('Retired event · read-only history.')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('History')).toBeInTheDocument();
  });
});

describe('isTypingTarget', () => {
  it('treats text fields and editable content as typing, buttons as not', () => {
    const text = document.createElement('input');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const area = document.createElement('textarea');
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });
});

function statusOf() {
  return {
    mode: 'demo' as const, bootId: 'b', buildId: 'x', serverTimeMs: 0, startedAtMs: 0,
    gateway: 'ready' as const, database: 'ready' as const, lease: 'held' as const,
    cards: { updatePending: false }, rooms: { enabled: false, warning: null }, commandsEnabled: true
  };
}

describe('Home task board and match drawer', () => {
  const discord = (server: { always(route: string, handler: () => unknown): void }) => server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord' }));
  const waitingFor = (minutes: number) => ({ ...liveDispute, matches: liveDispute.matches.map(match => match.id === 'M2' && match.judge
    ? { ...match, judge: { ...match.judge, sinceMs: FIXTURE_NOW_MS - minutes * 60_000 } } : match) });
  const mountHome = (snapshot = liveDispute) => renderConsole({ snapshot, setup: server => { discord(server); } });
  const board = async () => within(await screen.findByRole('region', { name: 'Tournament task board' }));
  const laneHeader = async (name: string) => {
    const heading = await screen.findByRole('heading', { name, level: 3 });
    return within(heading.closest('header') as HTMLElement);
  };
  const called = (patch: Partial<NonNullable<typeof liveDispute.matches[number]['judge']>> = {}) => ({ ...liveDispute, matches: liveDispute.matches.map(match => match.id === 'M1'
    ? { ...match, phase: 'paused' as const, adminActions: ['resolve' as const, 'judgeResume' as const, 'judgeClose' as const],
      judge: { reasons: ['called' as const], sinceMs: FIXTURE_NOW_MS - 60_000, raisedBy: ['A' as const], requests: [], ...patch } } : match) });

  afterEach(() => { window.history.replaceState(null, '', window.location.pathname); });

  it('has no stat-card row; the Judge needed lane header shows its count and an oldest-wait pill that warns after 5 minutes and alarms after 10', async () => {
    mountHome(waitingFor(6));
    await screen.findByRole('list', { name: 'Player counts' }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: /^Judge needed/ })).not.toBeInTheDocument();
    const judge = await laneHeader('Judge needed');
    expect(judge.getByText('1')).toBeInTheDocument();
    expect(await judge.findByText('oldest 6m')).toHaveClass('text-warning');
    expect((await laneHeader('Decision needed')).queryByText(/oldest/)).toBeNull();
    cleanup();
    mountHome(waitingFor(11));
    expect(await screen.findByText('oldest 11m', {}, { timeout: 5000 })).toHaveClass('text-danger');
  });

  it('opens the drawer from the deep link, and closes it with Escape, restoring the hash and focusing the card', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `${window.location.pathname}#/match/${liveDispute.eventId}/M2`);
    mountHome();
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(within(drawer).getByRole('region', { name: 'Judge request' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Match M2/ })).not.toBeInTheDocument());
    expect(window.location.hash).toBe('');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Match M2' })).toHaveFocus());
  });

  it('writes the open match to the hash and puts the previous hash back on close', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `${window.location.pathname}#before`);
    mountHome();
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    await screen.findByRole('dialog', { name: /^Match M1/ });
    expect(window.location.hash).toBe(`#/match/${liveDispute.eventId}/M1`);
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(window.location.hash).toBe('#before');
  });

  it('runs a match action from the drawer through the existing command dialog', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ snapshot: liveDispute, setup: srv => {
      discord(srv);
      srv.always('POST /commands', () => json(403, { error: { code: 'forbidden', message: 'x' } }));
    } });
    await user.click(await (await board()).findByRole('button', { name: 'Match M2' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    await user.click(within(drawer).getByRole('button', { name: 'Resolve M2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve M2' });
    await user.click(within(dialog).getByRole('radio', { name: /Seat C/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Judge ruling' } });
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    await waitFor(() => expect(server.callsTo('POST /commands')).toHaveLength(1));
  });

  it('opens the drawer from the card overflow menu and offers the quick actions', async () => {
    const user = userEvent.setup();
    mountHome();
    await user.click(await (await board()).findByRole('button', { name: 'Actions for match M2' }));
    const names = (await screen.findAllByRole('menuitem')).map(item => item.textContent);
    expect(names).toEqual(expect.arrayContaining(['Open', 'Resolve…', 'Resume play…', 'Copy match ID', 'Open in tournament view']));
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(await screen.findByRole('dialog', { name: /^Match M2/ })).toBeInTheDocument();
  });

  it('opens the same menu from the keyboard with Shift+F10 and keeps controls from opening the drawer', async () => {
    const user = userEvent.setup();
    mountHome();
    const card = await (await board()).findByRole('button', { name: 'Match M1' });
    card.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(await screen.findByRole('menuitem', { name: 'Copy match ID' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /^Match M1/ })).not.toBeInTheDocument();
  });

  it('shows the pill as neutral, then warning, then danger as the server clock advances', async () => {
    const { data } = mountHome(waitingFor(4));
    expect(await screen.findByText('oldest 4m', {}, { timeout: 5000 })).not.toHaveClass('text-warning');
    act(() => { data.clock.observe(FIXTURE_NOW_MS + 2 * 60_000); });
    expect(await screen.findByText('oldest 6m')).toHaveClass('text-warning');
    act(() => { data.clock.observe(FIXTURE_NOW_MS + 7 * 60_000); });
    expect(await screen.findByText('oldest 11m')).toHaveClass('text-danger');
  });

  it('leaves resumed matches out of the pill and says play resumed in the drawer', async () => {
    const user = userEvent.setup();
    const resumed = { ...liveDispute, matches: liveDispute.matches.map(match => match.id === 'M2'
      ? { ...match, phase: 'running' as const, clock: { ...match.clock, state: 'running' as const, runningSinceMs: FIXTURE_NOW_MS } } : match) };
    mountHome(resumed);
    await screen.findByRole('list', { name: 'Player counts' }, { timeout: 5000 });
    const judge = await laneHeader('Judge needed');
    expect(judge.getByText('1')).toBeInTheDocument();
    expect(judge.queryByText(/oldest/)).toBeNull();
    await user.click(await (await board()).findByRole('button', { name: 'Match M2' }));
    expect(await screen.findByText(/play resumed/)).toBeInTheDocument();
  });

  it('starts focus in the drawer content, not on the expand toggle, and expands to a centred panel', async () => {
    const user = userEvent.setup();
    mountHome();
    await user.click(await (await board()).findByRole('button', { name: 'Match M2' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(within(drawer).getByRole('button', { name: 'Expand to centred panel' })).not.toHaveFocus();
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(drawer.className).toContain('h-[calc(100vh-16px)]');
    await user.click(within(drawer).getByRole('button', { name: 'Expand to centred panel' }));
    expect(screen.getByRole('dialog', { name: /^Match M2/ }).className).toContain('max-w-[880px]');
    await user.click(within(drawer).getByRole('button', { name: 'Collapse to side panel' }));
    expect(screen.getByRole('dialog', { name: /^Match M2/ }).className).toContain('h-[calc(100vh-16px)]');
  });

  it('closes the card menu when its "…" button is pressed again', async () => {
    const user = userEvent.setup();
    mountHome();
    const more = await (await board()).findByRole('button', { name: 'Actions for match M2' });
    await user.click(more);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await user.click(more);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await user.click(more);
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(more).toHaveFocus();
  });

  it('hides actions in the drawer and the card menu for a read-only session', async () => {
    const user = userEvent.setup();
    renderConsole({ snapshot: liveDispute, setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', commandsEnabled: false }));
    } });
    await user.click(await (await board()).findByRole('button', { name: 'Actions for match M2' }));
    const names = (await screen.findAllByRole('menuitem')).map(item => item.textContent);
    expect(names).toEqual(['Open', 'Copy match ID', 'Open in tournament view']);
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(within(drawer).queryByRole('button', { name: /^Resolve|^Resume/ })).toBeNull();
  });

  it('updates an open drawer when the match changes lane, and closes it, restoring the hash, when the match leaves', async () => {
    const user = userEvent.setup();
    const { bodies } = renderConsole({ snapshot: liveDispute, setup: server => { discord(server); } });
    await waitFor(() => expect(bodies.length).toBe(1));
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M1/ });
    expect(within(drawer).queryByRole('region', { name: 'Judge request' })).toBeNull();
    const flagged = { ...liveDispute, version: liveDispute.version + 1, matches: liveDispute.matches.map(match => match.id === 'M1'
      ? { ...match, judge: { reasons: ['called' as const], sinceMs: FIXTURE_NOW_MS, raisedBy: ['A' as const], requests: [] } } : match) };
    await act(async () => { const { event, id } = change(flagged, []); bodies[0]!.push(frame(event, id)); });
    expect(await within(await screen.findByRole('dialog', { name: /^Match M1/ })).findByRole('region', { name: 'Judge request' })).toBeInTheDocument();
    expect(window.location.hash).toBe(`#/match/${liveDispute.eventId}/M1`);
    const gone = { ...flagged, version: flagged.version + 1, matches: flagged.matches.filter(match => match.id !== 'M1') };
    await act(async () => { const { event, id } = change(gone, []); bodies[0]!.push(frame(event, id)); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Match M1/ })).not.toBeInTheDocument());
    expect(window.location.hash).toBe('');
  });

  it('drops the drawer and its hash when another event takes over, so a repeated match ID does not reopen it', async () => {
    const user = userEvent.setup();
    const { bodies, server } = renderConsole({ snapshot: liveDispute, setup: srv => { discord(srv); } });
    await waitFor(() => expect(bodies.length).toBe(1));
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    await screen.findByRole('dialog', { name: /^Match M1/ });
    const next = { ...liveDispute, eventId: 'event-2', version: 1, createdAtMs: liveDispute.createdAtMs + 3_600_000 };
    const retiredCopy = { ...liveDispute, status: 'retired' as const, retiredAtMs: next.createdAtMs, version: 18 };
    const reply = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    server.always('GET /events', reply([summaryOf(next), summaryOf(retiredCopy)]));
    server.always(`GET /events/${liveDispute.eventId}/snapshot`, reply(retiredCopy));
    server.always('GET /events/event-2/snapshot', reply(next));
    server.always('GET /events/event-2/audit', reply([]));
    await act(async () => { const { event, id } = change(next, []); bodies[0]!.push(frame(event, id)); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Match M1/ })).not.toBeInTheDocument());
    expect(window.location.hash).toBe('');
  });

  it('clears a match link that names a match or event that does not exist', async () => {
    window.history.replaceState(null, '', `${window.location.pathname}#/match/${liveDispute.eventId}/M9`);
    mountHome();
    await screen.findByRole('list', { name: 'Player counts' }, { timeout: 5000 });
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.queryByRole('dialog', { name: /^Match/ })).not.toBeInTheDocument();
    cleanup();
    window.history.replaceState(null, '', `${window.location.pathname}#/match/other-event/M1`);
    mountHome();
    await screen.findByRole('list', { name: 'Player counts' }, { timeout: 5000 });
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.queryByRole('dialog', { name: /^Match/ })).not.toBeInTheDocument();
  });

  it('explains a staff conflict in the drawer and judge card instead of offering rulings', async () => {
    const user = userEvent.setup();
    const conflicted = { ...called(), matches: called().matches.map(match => match.id === 'M1'
      ? { ...match, adminActions: [], staffConflict: true as const } : match) };
    renderConsole({ snapshot: conflicted, setup: server => { discord(server); } });
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M1/ });
    const card = within(drawer).getByRole('region', { name: 'Judge request' });
    expect(within(card).getByRole('note')).toHaveTextContent('You’re playing in this match, so a TCG Judge must rule on it.');
    expect(within(drawer).queryByRole('button', { name: /Close issue|^Resolve|^Resume/ })).toBeNull();
    expect(within(drawer).getAllByRole('note')).toHaveLength(1);
  });

  it('shows the conflict once in the drawer of a match without a judge call', async () => {
    const user = userEvent.setup();
    const conflicted = { ...liveDispute, matches: liveDispute.matches.map(match => match.id === 'M1'
      ? { ...match, adminActions: [], staffConflict: true as const } : match) };
    renderConsole({ snapshot: conflicted, setup: server => { discord(server); } });
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M1/ });
    expect(within(drawer).getAllByRole('note')).toHaveLength(1);
    expect(within(drawer).getByRole('note')).toHaveTextContent('a TCG Judge must rule on it');
  });

  it('closes a judge call from the drawer with a note: notes start focused, the button needs a note, and Ctrl+Enter sends once', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { server } = renderConsole({ snapshot: called(), setup: srv => {
      discord(srv);
      srv.always('POST /commands', async () => { await gate; return json(200, { applied: true, result: 'ok', version: 99, cards: 'updated', roomWarning: null }); });
    } });
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M1/ });
    const notes = within(drawer).getByRole('textbox', { name: /Notes/ });
    expect(notes).toHaveFocus();
    const close = within(drawer).getByRole('button', { name: 'Close issue' });
    expect(within(drawer).queryByRole('button', { name: /^Close issue…/ })).toBeNull();
    expect(close).toBeDisabled();
    await user.type(notes, 'Checked the table, all fine');
    expect(close).toBeEnabled();
    await user.keyboard('{Control>}{Enter}{Enter}{/Control}');
    release();
    await waitFor(() => expect(server.callsTo('POST /commands')).toHaveLength(1));
    expect(JSON.stringify(server.callsTo('POST /commands')[0]!.body)).toContain('"type":"judgeClose"');
    expect(JSON.stringify(server.callsTo('POST /commands')[0]!.body)).toContain('Checked the table, all fine');
    await waitFor(() => expect(notes).toHaveValue(''));
  });

  it('shows the server error inline and keeps the note when closing fails', async () => {
    const user = userEvent.setup();
    renderConsole({ snapshot: called(), setup: srv => {
      discord(srv);
      srv.always('POST /commands', () => json(422, { error: { code: 'rule', message: 'The judge call was already closed.' } }));
    } });
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M1/ });
    await user.type(within(drawer).getByRole('textbox', { name: /Notes/ }), 'Done');
    await user.click(within(drawer).getByRole('button', { name: 'Close issue' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('The judge call was already closed.');
    expect(within(drawer).getByRole('textbox', { name: /Notes/ })).toHaveValue('Done');
  });

  it('sends a dispute to Resolve instead of offering Close issue', async () => {
    const user = userEvent.setup();
    mountHome();
    await user.click(await (await board()).findByRole('button', { name: 'Match M2' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(within(drawer).getByText(/This is a dispute: choose a winner with Resolve/)).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Close issue' })).toBeNull();
    expect(within(drawer).getByRole('button', { name: 'Resolve M2' })).toBeInTheDocument();
  });

  it('has no notes field for a read-only session', async () => {
    const user = userEvent.setup();
    renderConsole({ snapshot: called(), setup: srv => {
      srv.always('GET /session', () => json(200, { ...sessionFixture, mode: 'discord', commandsEnabled: false }));
    } });
    await user.click(await (await board()).findByRole('button', { name: 'Match M1' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M1/ });
    expect(within(drawer).getByRole('region', { name: 'Judge request' })).toBeInTheDocument();
    expect(within(drawer).queryByRole('textbox', { name: /Notes/ })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Close issue' })).toBeNull();
  });

  it('lays the drawer out as a rail of sections when expanded, and a summary strip when narrow', async () => {
    const user = userEvent.setup();
    mountHome();
    await user.click(await (await board()).findByRole('button', { name: 'Match M2' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(within(drawer).getByRole('region', { name: 'Match summary' })).toBeInTheDocument();
    expect(within(drawer).queryByRole('region', { name: 'Status' })).toBeNull();
    expect(within(drawer).getByRole('region', { name: 'Players' })).toBeInTheDocument();
    expect(within(drawer).getByRole('region', { name: 'Links' })).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Expand to centred panel' }));
    const rail = within(screen.getByRole('complementary', { name: 'Match properties' }));
    expect(['Status', 'Players', 'Actions', 'Links'].every(name => rail.queryByRole('region', { name }))).toBe(true);
    expect(within(drawer).queryByRole('region', { name: 'Match summary' })).toBeNull();
  });
});

describe('Kanban pane', () => {
  const kanban = () => screen.getByRole('button', { name: 'Kanban' });
  const pane = () => within(screen.getByTestId('kanban-pane'));

  it('toggles from the top bar, persists, and the preview toggles no longer draw Alt hints', async () => {
    const user = userEvent.setup();
    const { preferences } = renderConsole();
    await ready();
    expect(kanban()).toHaveAttribute('aria-pressed', 'false');
    for (const name of [/^Live preview/, /^List preview/]) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveTextContent(/^(Live|List) preview$/);
      expect(within(button).queryByText('Alt')).toBeNull();
    }
    expect(screen.getByRole('button', { name: /^Live preview/ })).toHaveAttribute('aria-keyshortcuts', 'Alt+1');
    expect(screen.getByRole('button', { name: /^List preview/ })).toHaveAttribute('aria-keyshortcuts', 'Alt+2');
    await user.click(kanban());
    expect(kanban()).toHaveAttribute('aria-pressed', 'true');
    expect(preferences.getSnapshot().panes.kanban).toBe(true);
    expect(await screen.findByTestId('kanban-pane')).toBeInTheDocument();
    await user.click(kanban());
    await waitFor(() => expect(screen.queryByTestId('kanban-pane')).not.toBeInTheDocument());
    expect(preferences.getSnapshot().panes.kanban).toBe(false);
    // The shortcuts still work.
    fireEvent.keyDown(document.body, { key: '2', code: 'Digit2', altKey: true });
    expect(preferences.getSnapshot().panes.list).toBe(true);
  });

  it('shows the viewed event\'s matches and opens the match drawer from a card', async () => {
    const user = userEvent.setup();
    renderConsole({ preferences: { panes: { live: false, list: false, kanban: true } } });
    await ready();
    const board = within(await pane().findByRole('region', { name: 'Tournament task board' }));
    expect(board.getByRole('button', { name: 'Match M1' })).toBeInTheDocument();
    expect(board.getByRole('button', { name: 'Match M2' })).toBeInTheDocument();
    expect(board.getByText('Result disputed')).toBeInTheDocument();
    await user.click(board.getByRole('button', { name: 'Match M2' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(window.location.hash).toBe(`#/match/${liveDispute.eventId}/M2`);
    expect(within(drawer).getByRole('button', { name: 'Resolve M2' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Match M2/ })).not.toBeInTheDocument());
    expect(window.location.hash).toBe('');
  });

  it('is read-only for a retired event: its own matches, no actions, no Close issue', async () => {
    const user = userEvent.setup();
    const retired = { ...liveDispute, eventId: 'retired-1', status: 'retired' as const, retiredAtMs: liveDispute.createdAtMs + 3_600_000,
      matches: liveDispute.matches.filter(match => match.id === 'M2') };
    renderConsole({ retired: [retired], preferences: { panes: { live: false, list: false, kanban: true } } });
    await ready();
    const history = screen.getByRole('navigation', { name: 'Event history' });
    await user.click(within(history).getByRole('button'));
    await screen.findByText('Retired event · read-only history.');
    const board = within(await pane().findByRole('region', { name: 'Tournament task board' }));
    await waitFor(() => expect(board.queryByRole('button', { name: 'Match M1' })).not.toBeInTheDocument());
    await user.click(board.getByRole('button', { name: 'Actions for match M2' }));
    expect((await screen.findAllByRole('menuitem')).map(item => item.textContent)).toEqual(['Open', 'Copy match ID', 'Open in tournament view']);
    await user.click(screen.getByRole('menuitem', { name: 'Open' }));
    const drawer = await screen.findByRole('dialog', { name: /^Match M2/ });
    expect(within(drawer).queryByRole('button', { name: /^Resolve|^Resume|^Correct/ })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Close issue' })).toBeNull();
    expect(within(drawer).queryByRole('textbox', { name: /Notes/ })).toBeNull();
    expect(within(drawer).getByText(/This event is closed/)).toBeInTheDocument();
  });
});

