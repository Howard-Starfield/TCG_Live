import { final, liveDispute, liveInterrupted } from '@tcg-live/core/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRoot } from '../../app/AppRoot';
import { mockMatchMedia, renderConsole } from '../../app/testing';
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

describe('sidebar', () => {
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
    expect(banner('lease')).toHaveAttribute('role', 'alert');
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
