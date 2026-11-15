import type { ArtworkGame } from '@tcg-live/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { AdminDataProvider, ServerClock, ServerClockContext } from '../../data';
import { json } from '../../data/test/fakes';
import { ToastProvider } from '../../ui';
import { ShellProvider, type ShellModel } from '../shell/model';
import { CreateTournamentDialog } from './CreateTournamentDialog';

const HOUR = 3_600_000;

/** `datetime-local` value for a local epoch time. */
function localInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function mount(options: { clock?: ServerClock; drafts?: () => Response | Promise<Response> } = {}) {
  const harness = createHarness({ stream: false, setup: server => {
    server.always('GET /tournaments/signup-channels', () => json(200, []));
    server.always('POST /tournaments/drafts', options.drafts ?? (call => {
      const body = call.body as { draftId: string };
      return json(201, { eventId: body.draftId, name: 'Cup', game: 'one-piece', status: 'draft', kind: 'signup',
        createdAtMs: 1, retiredAtMs: null });
    }));
  } });
  const clock = options.clock ?? new ServerClock();
  const shell = { session: { ...sessionFixture, commandsEnabled: true }, directory: undefined, activeEventId: null } as unknown as ShellModel;
  const onSaved = vi.fn();
  const tree = (open: boolean, defaultGame: ArtworkGame): ReactNode =>
    <AdminDataProvider data={harness.data}>
      <ServerClockContext.Provider value={clock}>
        <ToastProvider>
          <ShellProvider value={shell}>
            <CreateTournamentDialog open={open} defaultGame={defaultGame} onClose={() => {}} onSaved={onSaved} />
          </ShellProvider>
        </ToastProvider>
      </ServerClockContext.Provider>
    </AdminDataProvider>;
  const view = render(tree(true, 'one-piece'));
  const rerender = (open: boolean, defaultGame: ArtworkGame) => view.rerender(tree(open, defaultGame));
  return { ...harness, rerender, onSaved };
}

const dialog = () => within(screen.getByRole('dialog', { name: 'Create signup tournament' }));
const nameBox = () => dialog().getByRole('textbox', { name: 'Tournament name' });

describe('CreateTournamentDialog', () => {
  it('keeps typed input when the default game changes, and adopts it while untouched', async () => {
    const user = userEvent.setup();
    const { rerender } = mount();
    expect(nameBox()).toHaveValue('One Piece Tournament');
    // Untouched: a late default (directory loaded) is adopted.
    rerender(true, 'pokemon');
    expect(nameBox()).toHaveValue('Pokémon Tournament');
    expect(dialog().getByRole('combobox', { name: 'Game type' })).toHaveValue('pokemon');
    await user.clear(nameBox());
    await user.type(nameBox(), 'Saturday Cup');
    await user.type(dialog().getByRole('textbox', { name: 'Tournament details' }), 'Bring sleeves.');
    rerender(true, 'one-punch-man');
    expect(nameBox()).toHaveValue('Saturday Cup');
    expect(dialog().getByRole('textbox', { name: 'Tournament details' })).toHaveValue('Bring sleeves.');
    expect(dialog().getByRole('combobox', { name: 'Game type' })).toHaveValue('pokemon');
    // Reopening resets the form.
    rerender(false, 'one-punch-man');
    rerender(true, 'one-punch-man');
    await waitFor(() => expect(nameBox()).toHaveValue('One Punch Man Tournament'));
  });

  it('times "Immediately" and the future-start check with the server clock', async () => {
    const user = userEvent.setup();
    const clock = new ServerClock();
    clock.observe(Date.now() + 2 * HOUR);   // the server runs two hours ahead of this machine
    const { server } = mount({ clock });
    const start = dialog().getByLabelText('Tournament start date and time');
    const create = dialog().getByRole('button', { name: /^Create$/ });
    // One hour ahead locally is already past for the server.
    fireEvent.change(start, { target: { value: localInput(Date.now() + HOUR) } });
    expect(create).toBeDisabled();
    expect(dialog().getByText(/Choose a start time in the future/)).toBeInTheDocument();
    fireEvent.change(start, { target: { value: localInput(Date.now() + 3 * HOUR) } });
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(server.callsTo('POST /tournaments/drafts')).toHaveLength(1));
    const body = server.callsTo('POST /tournaments/drafts')[0]!.body as { signupOpensAtMs: number };
    expect(body.signupOpensAtMs).toBeGreaterThan(Date.now() + HOUR);
    expect(body.signupOpensAtMs).toBeLessThanOrEqual(clock.now());
  });

  it('reuses the draft ID for an identical retry and makes a new one after an edit', async () => {
    const user = userEvent.setup();
    const { server } = mount({ drafts: () => Promise.reject(new TypeError('Failed to fetch')) });
    const save = () => user.click(dialog().getByRole('button', { name: 'Save as draft' }));
    await save();
    await dialog().findByText('The console server could not be reached.');
    await save();
    await waitFor(() => expect(server.callsTo('POST /tournaments/drafts')).toHaveLength(2));
    await user.type(nameBox(), '!');
    await save();
    await waitFor(() => expect(server.callsTo('POST /tournaments/drafts')).toHaveLength(3));
    const ids = server.callsTo('POST /tournaments/drafts').map(call => (call.body as { draftId: string }).draftId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});
