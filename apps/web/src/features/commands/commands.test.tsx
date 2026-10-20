// Console admin actions end to end over the real data layer and a scripted fetch (no server).
import type { AdminCommandRequestDto, AdminCommandResultDto, EventSnapshotDto, SessionDto } from '@tcg-live/core';
import { checkin, final, liveDispute, signupOpen } from '@tcg-live/core/fixtures';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { describe, expect, it } from 'vitest';
import { renderConsole, sessionFixture, type HarnessOptions } from '../../app/testing';
import { adminKeys } from '../../data';
import { json, type FakeServer } from '../../data/test/fakes';

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
