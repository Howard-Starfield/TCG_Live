import { final, liveDispute, liveInterrupted } from '@tcg-live/core/fixtures';
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
    expect(preferences.getSnapshot().panes).toEqual({ live: true, list: false });
    expect(await screen.findByTestId('live-preview')).toHaveAttribute('data-event', liveDispute.eventId);

    await user.click(toggle('List preview'));
    expect(preferences.getSnapshot().panes).toEqual({ live: true, list: true });
    expect(screen.getByTestId('list-preview')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize live and list previews' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close live preview' }));
    expect(preferences.getSnapshot().panes).toEqual({ live: false, list: true });
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
    const actions = screen.getByRole('region', { name: 'Action needed' });
    expect(within(actions).getByText('Awaiting result confirmation')).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Match M1' })).toBeInTheDocument();
    await user.click(within(actions).getByRole('button', { name: 'Match M2' }));
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
