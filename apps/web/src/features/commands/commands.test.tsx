// Console admin actions end to end over the real data layer and a scripted fetch (no server).
import type { AdminCommandRequestDto, AdminCommandResultDto, EventSnapshotDto, SessionDto } from '@tcg-live/core';
import { checkin, final, liveDispute, signupOpen } from '@tcg-live/core/fixtures';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createHarness, renderConsole, sessionFixture, type HarnessOptions } from '../../app/testing';
import { AdminDataProvider, adminKeys } from '../../data';
import { change, frame, json, type FakeServer } from '../../data/test/fakes';
import { ToastProvider } from '../../ui';
import { createCommandClient } from './client';
import { useAdminCommand, type CommandOutcome } from './useAdminCommand';

MotionGlobalConfig.skipAnimations = true;

const ready = () => screen.findByRole('heading', { name: /Needs you/ });
const main = () => screen.getByRole('main', { name: 'Console' });
const result = (overrides: Partial<AdminCommandResultDto> = {}): AdminCommandResultDto =>
  ({ applied: true, result: 'ok', version: 99, cards: 'updated', roomWarning: null, ...overrides });
const bodies = (server: FakeServer, path = 'POST /commands') => server.callsTo(path).map(call => call.body as AdminCommandRequestDto);
const publishable: EventSnapshotDto = { ...checkin, checkins: ['A', 'B', 'C', 'D'], adminActions: ['publish', 'signupReopen'] };

function withSession(session: Partial<SessionDto>, options: HarnessOptions = {}): HarnessOptions {
  return {
    ...options,
    setup: server => {
      server.always('GET /session', () => json(200, { ...sessionFixture, ...session }));
      options.setup?.(server);
    }
  };
}

function respond(route: string, body: unknown, status = 200): HarnessOptions['setup'] {
  return server => { server.always(route, () => json(status, body)); };
}

describe('read-only sessions (decision 4)', () => {
  it('shows no action controls and no composer when the server does not enable commands', async () => {
    renderConsole(withSession({ commandsEnabled: false, capabilities: ['dashboard.read'] },
      { snapshot: liveDispute, preferences: { panes: { list: true }, listTab: 'matches' } }));
    await ready();
    expect(await screen.findByRole('table', { name: /Matches/ })).toBeInTheDocument();
    expect(within(main()).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(main()).queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('command-composer')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Event actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resolve|publish|remove|correct|refresh|resume|actions for/i })).not.toBeInTheDocument();
  });

  it('also hides everything when commandsEnabled is false but capabilities are listed', async () => {
    renderConsole(withSession({ commandsEnabled: false }, { snapshot: signupOpen, preferences: { panes: { list: true }, listTab: 'players' } }));
    await screen.findByRole('table', { name: /Signup roster/ });
    expect(screen.queryByRole('button', { name: /remove|refresh/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('command-composer')).not.toBeInTheDocument();
  });

  it('hides an action whose capability the session lacks', async () => {
    renderConsole(withSession({ capabilities: ['dashboard.read', 'match.correct'] }));
    await ready();
    const card = screen.getByRole('article', { name: 'M2 needs a judge' });
    expect(within(card).queryByRole('button', { name: /Resolve|Resume/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh panels' })).not.toBeInTheDocument();
    // match.correct alone still allows a composer, but it offers nothing that liveDispute allows.
    const composer = screen.getByRole('combobox', { name: 'Admin command' });
    fireEvent.focus(composer);
    fireEvent.change(composer, { target: { value: '/', selectionStart: 1 } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('stage stepper actions row', () => {
  it('follows adminActions: reopen at check-in, publish once all four are in', async () => {
    const { unmount } = renderConsole({ snapshot: checkin, audit: [] });
    await ready();
    const row = screen.getByRole('group', { name: 'Event actions' });
    expect(within(row).getAllByRole('button').map(button => button.textContent)).toEqual(['Reopen signup', 'Refresh panels']);
    unmount();

    renderConsole({ snapshot: signupOpen, audit: [] });
    await ready();
    expect(within(screen.getByRole('group', { name: 'Event actions' })).getAllByRole('button').map(button => button.textContent))
      .toEqual(['Refresh panels']);
  });

  it('publishes with the version precondition and shows a success toast', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ snapshot: publishable, audit: [], setup: respond('POST /commands', result({ result: 'publish' })) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publish round' }));
    expect(await screen.findByText('Round published')).toBeInTheDocument();
    const [body] = bodies(server);
    expect(body).toEqual({ commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), eventId: publishable.eventId,
      command: { type: 'publish' }, precondition: { eventVersion: publishable.version } });
  });

  it('says the Discord display is pending and shows the room warning', async () => {
    const user = userEvent.setup();
    renderConsole({ snapshot: publishable, audit: [],
      setup: respond('POST /commands', result({ result: 'publish', cards: 'pending', roomWarning: 'Could not create the M2 voice room.' })) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publish round' }));
    const notifications = await screen.findByRole('region', { name: 'Notifications' });
    await waitFor(() => expect(notifications).toHaveTextContent('The Discord display is pending'));
    expect(notifications).toHaveTextContent('Match room warning');
    expect(notifications).toHaveTextContent('Could not create the M2 voice room.');
  });

  it('refreshes the Discord panels for the active event', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ setup: respond('POST /panels/refresh', { cards: 'refreshed', roomWarning: null }) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Refresh panels' }));
    expect(await screen.findByText('Discord panels refreshed')).toBeInTheDocument();
    expect(bodies(server, 'POST /panels/refresh')).toEqual([{ eventId: liveDispute.eventId }]);
  });

  it('on 409 from a button caches the snapshot first, then the row follows the fresh adminActions', async () => {
    const user = userEvent.setup();
    const latest: EventSnapshotDto = { ...publishable, version: 9, published: true, stage: 'live', adminActions: [] };
    const { data } = renderConsole({ snapshot: publishable, audit: [],
      setup: respond('POST /commands', { error: { code: 'conflict', message: 'stale' }, snapshot: latest }, 409) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publish round' }));
    expect(await screen.findByText('The event changed')).toBeInTheDocument();
    expect(data.queryClient.getQueryData<EventSnapshotDto>(adminKeys.snapshot(publishable.eventId))?.version).toBe(9);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Publish round' })).not.toBeInTheDocument());
  });

  it('shows a mapped error toast when the server refuses', async () => {
    const user = userEvent.setup();
    renderConsole({ snapshot: publishable, audit: [], setup: respond('POST /commands', { error: { code: 'forbidden', message: 'x' } }, 403) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Publish round' }));
    expect(await screen.findByText('Could not publish the round')).toBeInTheDocument();
    expect(screen.getByText('This console session is not allowed to do that.')).toBeInTheDocument();
  });
});

describe('reason dialogs', () => {
  async function openResolve(options: HarnessOptions = {}) {
    const user = userEvent.setup();
    const harness = renderConsole(options);
    await ready();
    const card = screen.getByRole('article', { name: 'M2 needs a judge' });
    expect(within(card).getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual(['Resolve M2', 'Resume play M2', 'Open M2 in live preview']);
    await user.click(within(card).getByRole('button', { name: 'Resolve M2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve M2' });
    return { ...harness, user, dialog };
  }

  it('validates the winner and the reason (empty, whitespace, over 500) before sending', async () => {
    const { user, dialog, server } = await openResolve();
    expect(within(dialog).getByRole('radio', { name: /Seat C · Cy Park/ })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    expect(dialog).toHaveTextContent('Pick the winning seat.');
    expect(dialog).toHaveTextContent('Enter a reason.');
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    fireEvent.change(reason, { target: { value: '    ' } });
    expect(dialog).toHaveTextContent('Enter a reason.');
    fireEvent.change(reason, { target: { value: 'x'.repeat(501) } });
    expect(dialog).toHaveTextContent('Keep the reason to 500 characters (it has 501).');
    expect(dialog).toHaveTextContent('501 / 500');
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    expect(server.callsTo('POST /commands')).toHaveLength(0);
  });

  it('sends the trimmed reason with the match precondition, then closes', async () => {
    const { user, dialog, server } = await openResolve({ setup: respond('POST /commands', result({ result: 'resolve' })) });
    await user.click(within(dialog).getByRole('radio', { name: /Seat D · Dee Ross/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: '  Video review  ' } });
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resolve M2' })).not.toBeInTheDocument());
    expect(bodies(server)).toEqual([{
      commandId: expect.any(String), eventId: liveDispute.eventId,
      command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Video review' },
      precondition: { match: { matchId: 'M2', phase: 'paused', proposalRevision: 1, finalWinner: null, pauseGeneration: 1 } }
    }]);
    expect(await screen.findByText('M2 resolved: Seat D · Dee Ross wins')).toBeInTheDocument();
  });

  it('shows a rule error inline and sends a fresh commandId on the next attempt', async () => {
    const { user, dialog, server } = await openResolve({ setup: server => {
      server.once('POST /commands', () => json(422, { error: { code: 'rule', message: 'Match M2 has an open proposal.' } }));
      server.once('POST /commands', () => json(200, result({ result: 'resolve' })));
    } });
    await user.click(within(dialog).getByRole('radio', { name: /Seat C/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Ruling' } });
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Match M2 has an open proposal.');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    await waitFor(() => expect(server.callsTo('POST /commands')).toHaveLength(2));
    const [first, second] = bodies(server);
    expect(first!.commandId).not.toBe(second!.commandId);
    expect(second!.command).toEqual(first!.command);
  });

  it('on 409 puts the returned snapshot into the cache before the admin decides again', async () => {
    const latest: EventSnapshotDto = { ...final, version: 18 };
    const { user, dialog, data, server } = await openResolve({ setup: server => {
      server.once('POST /commands', () => json(409, { error: { code: 'conflict', message: 'Precondition failed' }, snapshot: latest }));
    } });
    await user.click(within(dialog).getByRole('radio', { name: /Seat C/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Ruling' } });
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    await waitFor(() => expect(data.queryClient.getQueryData<EventSnapshotDto>(adminKeys.snapshot(liveDispute.eventId))?.version).toBe(18));
    expect(dialog).toHaveTextContent('M2 changed while you were deciding. M2 is final now (it was paused).');
    expect(dialog).toHaveTextContent('This action is no longer available: M2 is final now.');
    expect(within(dialog).getByRole('button', { name: 'Resolve match' })).toBeDisabled();
    // The rest of the console shows the fresh state too: M2 no longer needs a judge.
    await waitFor(() => expect(screen.queryByRole('article', { name: 'M2 needs a judge' })).not.toBeInTheDocument());
    expect(server.callsTo('POST /commands')).toHaveLength(1);
  });

  it('Escape closes the dialog (escape layer) and returns focus to the opener', async () => {
    const { user } = await openResolve();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resolve M2' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Resolve M2' })).toHaveFocus();
  });

  it('judge-resume asks only for a reason', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ setup: respond('POST /commands', result({ result: 'judgeResume' })) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Resume play M2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume M2 by judge override' });
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    const reason = within(dialog).getByRole('textbox', { name: /Reason/ });
    expect(reason).toHaveFocus();
    await user.type(reason, 'Both players agreed{Control>}{Enter}{/Control}');
    await waitFor(() => expect(bodies(server)).toHaveLength(1));
    expect(bodies(server)[0]!.command).toEqual({ type: 'judgeResume', matchId: 'M2', reason: 'Both players agreed' });
  });
});

describe('corrections', () => {
  it('need danger styling and an explicit confirmation; the Matches row menu opens them', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ snapshot: final, preferences: { panes: { list: true }, listTab: 'matches' },
      setup: respond('POST /commands', result({ result: 'correct' })) });
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Actions for M2' }));
    await user.click(await screen.findByRole('menuitem', { name: /Correct result/ }));
    const dialog = await screen.findByRole('alertdialog', { name: "Correct M2's result" });
    // The recorded winner cannot be picked again.
    expect(within(dialog).getByRole('radio', { name: /Seat D · Dee Ross/ })).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: /Seat C · Cy Park/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Scoresheet error' } });
    const confirm = within(dialog).getByRole('button', { name: 'Correct result' });
    expect(confirm.className).toMatch(/bg-danger-fill/);
    await user.click(confirm);
    expect(dialog).toHaveTextContent('Confirm that you mean to change a final result.');
    expect(server.callsTo('POST /commands')).toHaveLength(0);
    await user.click(within(dialog).getByRole('checkbox', { name: /replaces the recorded result of M2/ }));
    await user.click(confirm);
    await waitFor(() => expect(bodies(server)).toHaveLength(1));
    expect(bodies(server)[0]).toMatchObject({
      command: { type: 'correct', matchId: 'M2', winner: 'C', reason: 'Scoresheet error' },
      precondition: { match: { matchId: 'M2', phase: 'final', finalWinner: 'D', proposalRevision: 1, pauseGeneration: 1 } }
    });
  });
});

describe('players remove', () => {
  it('confirms, then removes the member with the signup precondition', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ snapshot: signupOpen, audit: [], preferences: { panes: { list: true }, listTab: 'players' },
      setup: respond('POST /commands', result({ result: 'signupRemove' })) });
    await screen.findByRole('table', { name: /Signup roster/ });
    await user.click(screen.getByRole('button', { name: 'Remove Cy Park from the signup' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Cy Park from the signup?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(server.callsTo('POST /commands')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(bodies(server)).toHaveLength(1));
    expect(bodies(server)[0]).toMatchObject({ command: { type: 'signupRemove', memberId: signupOpen.signup!.roster[2] },
      precondition: { signup: { status: 'open', rosterSize: 3 } } });
    expect(await screen.findByText('Removed Cy Park from the signup')).toBeInTheDocument();
  });
});

describe('retired events', () => {
  it('show no actions and no composer, even for a fully privileged session', async () => {
    const user = userEvent.setup();
    const retired = { ...liveDispute, eventId: 'retired-judge', status: 'retired' as const, retiredAtMs: liveDispute.createdAtMs + 60_000 };
    renderConsole({ retired: [retired], preferences: { panes: { list: true }, listTab: 'matches' } });
    await ready();
    expect(screen.getByTestId('command-composer')).toBeInTheDocument();
    await user.click(within(screen.getByRole('navigation', { name: 'Event history' })).getByRole('button'));
    await screen.findByRole('article', { name: 'M2 needed a judge' });
    expect(screen.queryByTestId('command-composer')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Event actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolve|Resume|Actions for|Refresh panels/ })).not.toBeInTheDocument();
  });
});

describe('command composer', () => {
  const composer = () => screen.getByRole('combobox', { name: 'Admin command' }) as HTMLInputElement;

  it('is a combobox with command, match and seat suggestions, and runs a complete command directly', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ setup: respond('POST /commands', result({ result: 'resolve' })) });
    await ready();
    expect(composer()).toHaveAttribute('aria-expanded', 'false');
    await user.click(composer());
    await user.type(composer(), '/r');
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual([
      '/refreshCreate or repair the Discord cards', '/resolveResolve a match'
    ]);
    expect(composer()).toHaveAttribute('aria-expanded', 'true');
    expect(composer()).toHaveAttribute('aria-activedescendant', within(list).getAllByRole('option')[0]!.id);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(composer().value).toBe('/resolve ');
    expect(within(screen.getByRole('listbox', { name: 'Matches' })).getAllByRole('option').map(option => option.textContent?.slice(0, 2)))
      .toEqual(['M1', 'M2']);
    await user.keyboard('{ArrowDown}{Tab}');
    expect(composer().value).toBe('/resolve M2 ');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(composer(), '@C Judge ruling');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bodies(server)).toHaveLength(1));
    expect(bodies(server)[0]!.command).toEqual({ type: 'resolve', matchId: 'M2', winner: 'C', reason: 'Judge ruling' });
    await waitFor(() => expect(composer().value).toBe(''));
  });

  it('explains a command that is not available and keeps the text', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole();
    await ready();
    await user.type(composer(), '/publish{Enter}');
    expect(await within(screen.getByTestId('command-composer')).findByRole('alert')).toHaveTextContent('/publish is not available right now.');
    expect(composer().value).toBe('/publish');
    expect(server.callsTo('POST /commands')).toHaveLength(0);
  });

  it('finishes an incomplete command in the reason dialog, prefilled', async () => {
    const user = userEvent.setup();
    renderConsole();
    await ready();
    await user.type(composer(), '/resolve M2 @Dee_Ross');
    await user.keyboard('{Escape}{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Resolve M2' });
    expect(within(dialog).getByRole('radio', { name: /Seat D/ })).toBeChecked();
    expect(within(dialog).getByRole('textbox', { name: /Reason/ })).toHaveFocus();
  });

  it('mentions roster members for /signup-remove and confirms before removing', async () => {
    const user = userEvent.setup();
    const { server } = renderConsole({ snapshot: signupOpen, audit: [], setup: respond('POST /commands', result({ result: 'signupRemove' })) });
    await ready();
    await user.type(composer(), '/signup-remove @b');
    const options = within(screen.getByRole('listbox', { name: 'Members' })).getAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['@Ben_OrtizBen Ortiz · joined #2']);
    await user.keyboard('{Enter}');
    expect(composer().value).toBe('/signup-remove @Ben_Ortiz ');
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Ben Ortiz from the signup?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(bodies(server)).toHaveLength(1));
    expect(bodies(server)[0]!.command).toEqual({ type: 'signupRemove', memberId: signupOpen.signup!.roster[1] });
    await waitFor(() => expect(composer().value).toBe(''));
  });

  it('ignores Enter while an IME is composing', async () => {
    const { server } = renderConsole({ snapshot: publishable, audit: [] });
    await ready();
    fireEvent.change(composer(), { target: { value: '/publish' } });
    act(() => { fireEvent.keyDown(composer(), { key: 'Enter', keyCode: 229 }); });
    expect(server.callsTo('POST /commands')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- review fix round

/** Pushes a stream `change` for `snapshot` on the open stream. */
async function streamChange(bodies: Array<{ push(text: string): void }>, snapshot: EventSnapshotDto) {
  const { event, id } = change(snapshot, []);
  await act(async () => { bodies[bodies.length - 1]!.push(frame(event, id)); });
}

function withMatch(snapshot: EventSnapshotDto, id: 'M1' | 'M2', patch: Partial<EventSnapshotDto['matches'][number]>, version: number): EventSnapshotDto {
  return { ...snapshot, version, matches: snapshot.matches.map(match => (match.id === id ? { ...match, ...patch } : match)) };
}

const preconditionOf = (server: FakeServer, index = 0) => bodies(server)[index]!.precondition;

describe('dialogs decide on the state captured when they open', () => {
  it('a stream change to the match is not sent until the admin reviews it and confirms again', async () => {
    const user = userEvent.setup();
    const harness = renderConsole({ setup: respond('POST /commands', result({ result: 'resolve' })) });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Resolve M2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve M2' });
    await user.click(within(dialog).getByRole('radio', { name: /Seat C/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Ruling' } });

    // While the admin types, a new proposal revision arrives for the same paused match.
    const moved = withMatch(liveDispute, 'M2', { proposal: { revision: 2, winner: 'D', reporter: 'C', decision: 'open' } }, 18);
    await streamChange(harness.bodies, moved);
    const notice = await within(dialog).findByTestId('changed-notice');
    expect(notice).toHaveTextContent('M2 changed since you opened this. Now:');
    expect(notice).toHaveTextContent('rev 2');
    // What the admin read stays on screen.
    expect(within(dialog).getAllByRole('list', { name: 'Match details' })[0]).toHaveTextContent('rev 1');
    expect(within(dialog).queryByRole('button', { name: 'Resolve match' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Review the change' })).toBeInTheDocument();
    // Enter (form submit) while changed only adopts the new state; it never sends.
    fireEvent.submit(within(dialog).getByTestId('match-action-form'));
    expect(harness.server.callsTo('POST /commands')).toHaveLength(0);
    expect(within(dialog).queryByTestId('changed-notice')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('list', { name: 'Match details' })).toHaveTextContent('rev 2');
    await user.click(within(dialog).getByRole('button', { name: 'Resolve match' }));
    await waitFor(() => expect(harness.server.callsTo('POST /commands')).toHaveLength(1));
    expect(preconditionOf(harness.server))
      .toEqual({ match: { matchId: 'M2', phase: 'paused', proposalRevision: 2, finalWinner: null, pauseGeneration: 1 } });
  });

  it('a correction must be acknowledged again after reviewing a change', async () => {
    const user = userEvent.setup();
    const harness = renderConsole({ snapshot: final, preferences: { panes: { list: true }, listTab: 'matches' },
      setup: respond('POST /commands', result({ result: 'correct' })) });
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Actions for M1' }));
    await user.click(await screen.findByRole('menuitem', { name: /Correct result/ }));
    const dialog = await screen.findByRole('alertdialog', { name: "Correct M1's result" });
    await user.click(within(dialog).getByRole('radio', { name: /Seat B/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Scoresheet' } });
    await user.click(within(dialog).getByRole('checkbox'));
    expect(within(dialog).getByRole('checkbox')).toBeChecked();

    await streamChange(harness.bodies, withMatch(final, 'M1', { pauseGeneration: 2 }, 21));
    await user.click(await within(dialog).findByRole('button', { name: 'Review the change' }));
    expect(within(dialog).getByRole('checkbox')).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Correct result' }));
    expect(dialog).toHaveTextContent('Confirm that you mean to change a final result.');
    expect(harness.server.callsTo('POST /commands')).toHaveLength(0);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Correct result' }));
    await waitFor(() => expect(harness.server.callsTo('POST /commands')).toHaveLength(1));
    expect(preconditionOf(harness.server).match?.pauseGeneration).toBe(2);
  });

  it('a roster change under the removal dialog needs a review before Remove', async () => {
    const user = userEvent.setup();
    const harness = renderConsole({ snapshot: signupOpen, audit: [], preferences: { panes: { list: true }, listTab: 'players' },
      setup: respond('POST /commands', result({ result: 'signupRemove' })) });
    await screen.findByRole('table', { name: /Signup roster/ });
    await user.click(screen.getByRole('button', { name: 'Remove Cy Park from the signup' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove Cy Park from the signup?' });
    await streamChange(harness.bodies, { ...signupOpen, version: 4, signup: { ...signupOpen.signup!, roster: signupOpen.signup!.roster.slice(1) } });
    expect(await within(dialog).findByTestId('changed-notice')).toHaveTextContent('2 of 4 joined: Ben Ortiz, Cy Park');
    expect(within(dialog).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Review the change' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(harness.server.callsTo('POST /commands')).toHaveLength(1));
    expect(preconditionOf(harness.server)).toEqual({ signup: { status: 'open', rosterSize: 2 } });
  });
});

describe('dialog focus and Escape', () => {
  it('returns focus to the row menu trigger that opened the dialog', async () => {
    const user = userEvent.setup();
    renderConsole({ snapshot: final, preferences: { panes: { list: true }, listTab: 'matches' } });
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Actions for M2' }));
    await user.click(await screen.findByRole('menuitem', { name: /Correct result/ }));
    await screen.findByRole('alertdialog', { name: "Correct M2's result" });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actions for M2' })).toHaveFocus());
  });

  it('falls back to the match row when the trigger unmounted while the dialog was open', async () => {
    const user = userEvent.setup();
    const harness = renderConsole({ snapshot: final, preferences: { panes: { list: true }, listTab: 'matches' } });
    await ready();
    await user.click(await screen.findByRole('button', { name: 'Actions for M2' }));
    await user.click(await screen.findByRole('menuitem', { name: /Correct result/ }));
    const dialog = await screen.findByRole('alertdialog', { name: "Correct M2's result" });
    // Nothing is actionable any more: the actions column, and the trigger with it, disappear.
    await streamChange(harness.bodies, { ...final, version: 21, matches: final.matches.map(match => ({ ...match, adminActions: [] })) });
    await within(dialog).findByText(/no longer available/);
    expect(screen.queryByRole('button', { name: 'Actions for M2' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('TR'));
    expect(document.activeElement).toHaveTextContent('M2');
  });

  it('swallows Escape while the request is in flight, then closes on success', async () => {
    const user = userEvent.setup();
    let answer!: (response: Response) => void;
    const harness = renderConsole({ setup: server => {
      server.always('POST /commands', () => new Promise<Response>(resolve => { answer = resolve; }));
    } });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Resume play M2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume M2 by judge override' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), { target: { value: 'Agreed' } });
    await user.click(within(dialog).getByRole('button', { name: 'Resume play' }));
    await waitFor(() => expect(harness.server.callsTo('POST /commands')).toHaveLength(1));

    const prevented: boolean[] = [];
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') prevented.push(event.defaultPrevented); };
    document.addEventListener('keydown', listener);
    try {
      await user.keyboard('{Escape}');
    } finally {
      document.removeEventListener('keydown', listener);
    }
    // Claimed by the dialog's escape layer (so no lower layer acts on it), and ignored while pending.
    expect(prevented).toEqual([true]);
    expect(screen.getByRole('dialog', { name: 'Resume M2 by judge override' })).toBeInTheDocument();
    await act(async () => { answer(json(200, result({ result: 'judgeResume' }))); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resume M2 by judge override' })).not.toBeInTheDocument());
  });
});

describe('useAdminCommand retries', () => {
  it('retries a 503 with the same commandId and stays pending throughout', async () => {
    const harness = createHarness({ snapshot: publishable, audit: [] });
    harness.server.once('POST /commands', () => json(503, { error: { code: 'unavailable', message: 'busy' } }));
    harness.server.once('POST /commands', () => json(200, result({ result: 'publish' })));
    const waits: number[] = [];
    let release!: () => void;
    const client = createCommandClient(harness.data.api, {
      retryDelaysMs: [500],
      sleep: ms => { waits.push(ms); return new Promise<void>(resolve => { release = resolve; }); }
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AdminDataProvider data={harness.data}><ToastProvider>{children}</ToastProvider></AdminDataProvider>
    );
    const { result: hook } = renderHook(() => useAdminCommand(sessionFixture, { client }), { wrapper });

    let first!: Promise<CommandOutcome>;
    act(() => { first = hook.current.run(publishable, { type: 'publish' }); });
    expect(hook.current.isPending('publish')).toBe(true);
    await waitFor(() => expect(waits).toEqual([500]));
    expect(harness.server.callsTo('POST /commands')).toHaveLength(1);
    expect(hook.current.isPending('publish')).toBe(true);
    // A second click during the retry wait is not a second intent.
    await act(async () => { expect(await hook.current.run(publishable, { type: 'publish' })).toEqual({ status: 'skipped' }); });
    expect(hook.current.isPending('publish')).toBe(true);

    await act(async () => { release(); await first; });
    await expect(first).resolves.toMatchObject({ status: 'applied' });
    const ids = bodies(harness.server).map(body => body.commandId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(hook.current.isPending('publish')).toBe(false);
  });
});
