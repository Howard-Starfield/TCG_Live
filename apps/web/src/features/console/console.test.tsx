import { auditTimeline, checkin, final, liveDispute, signupOpen } from '@tcg-live/core/fixtures';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderConsole } from '../../app/testing';
import { formatAuditEntry } from '../../data';
import { groupActivity, judgeMatches, lineText, stepModel } from '.';

const ready = () => screen.findByRole('heading', { name: /Needs you/ });

describe('stage stepper', () => {
  it('models counts and states for every stage', () => {
    expect(stepModel(signupOpen).map(step => [step.state, step.detail])).toEqual([
      ['current', '3/4 joined'], ['pending', '0/4 in'], ['pending', '0/2 final'], ['pending', 'Waiting']
    ]);
    expect(stepModel(checkin).map(step => step.state)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(stepModel(checkin)[1]?.detail).toBe('3/4 in');
    const live = stepModel(liveDispute);
    expect(live.map(step => step.state)).toEqual(['done', 'done', 'current', 'pending']);
    expect(live[2]).toMatchObject({ detail: '0/2 final · 1 live · 1 judge', attention: true });
    expect(stepModel(final).map(step => step.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(stepModel(final)[2]?.detail).toBe('2/2 final');
  });

  it('highlights the current stage', async () => {
    renderConsole();
    await ready();
    const steps = within(screen.getByRole('region', { name: 'Event progress' })).getAllByRole('listitem');
    expect(steps.map(step => step.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(steps[2]).toHaveTextContent('Round 1');
    expect(screen.queryByRole('button', { name: /publish|refresh/i })).not.toBeInTheDocument();   // no actions in Wave 2
  });
});

describe('needs-you queue', () => {
  it('renders a decision card per match with judge attention, from liveDispute', async () => {
    renderConsole();
    await ready();
    expect(judgeMatches(liveDispute).map(match => match.id)).toEqual(['M2']);
    const card = screen.getByRole('article', { name: 'M2 needs a judge' });
    expect(within(card).getByRole('list', { name: 'Reasons' })).toHaveTextContent('Dispute');
    expect(card).toHaveTextContent('Cy Park (Seat C) vs Dee Ross (Seat D)');
    expect(card).toHaveTextContent('reported that they won');
    expect(card).toHaveTextContent('disputed');
    expect(card).toHaveTextContent('Raised by Dee Ross (Seat D)');
    expect(card).toHaveTextContent(/waiting 1:30/);
    expect(screen.getByRole('heading', { name: /Needs you/ })).toHaveTextContent('1');
  });

  it('"Open in live preview" opens the Live pane in Match view for that match', async () => {
    const user = userEvent.setup();
    const { preferences } = renderConsole();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Open M2 in live preview' }));
    expect(preferences.getSnapshot()).toMatchObject({ panes: { live: true }, canvasView: 'match' });
    const canvas = await screen.findByTestId('live-preview');
    expect(canvas).toHaveAttribute('data-view', 'match');
    expect(canvas).toHaveAttribute('data-match', 'M2');
  });

  it('shows an empty state when nothing needs the admin', async () => {
    renderConsole({ snapshot: checkin, audit: auditTimeline.slice(0, 7) });
    expect(await screen.findByTestId('needs-you-empty')).toHaveTextContent('Nothing needs you.');
  });
});

describe('activity stream', () => {
  it('groups consecutive entries by actor and drops the repeated actor label', () => {
    const groups = groupActivity(auditTimeline, liveDispute);
    // Four joins by four members, then the admin, then four check-ins by four seats, ...
    expect(groups[0]?.lines).toHaveLength(1);
    const [pause, dispute] = groups.slice(-2);
    // Same actor, but more than five minutes apart: two groups.
    expect(pause?.actor).toEqual({ kind: 'player', seat: 'D' });
    expect(pause?.lines.map(line => line.text)).toEqual(['Paused M2']);
    expect(dispute?.lines.map(line => line.text)).toEqual(['Disputed the result of M2']);
    // The four ready commands within a minute by different seats stay separate; same-seat runs merge.
    const merged = groupActivity([auditTimeline[10]!, { ...auditTimeline[10]!, sequence: 99, command: { type: 'pause', matchId: 'M1' } }], liveDispute);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.lines.map(line => line.text)).toEqual(['Is ready for M1', 'Paused M1']);
    expect(lineText(formatAuditEntry(auditTimeline[4]!, liveDispute))).toBe('Closed signup and assigned seats');
  });

  it('renders the audit chat-style, newest at the bottom, and says it shows applied changes only', async () => {
    renderConsole();
    await ready();
    const log = await screen.findByRole('log', { name: 'Activity' });
    await waitFor(() => expect(within(log).getAllByRole('article').length).toBeGreaterThan(5));
    const articles = within(log).getAllByRole('article');
    expect(articles[articles.length - 1]).toHaveTextContent('Disputed the result of M2');
    expect(articles[0]).toHaveTextContent('Ava Chen');
    expect(screen.getByText('Applied changes only')).toBeInTheDocument();
    expect(within(log).getByText("Start of this event's activity")).toBeInTheDocument();
  });

  it('offers Jump to latest after the user scrolls up, and pins again when used', async () => {
    renderConsole();
    await ready();
    const log = await screen.findByRole('log', { name: 'Activity' });
    await waitFor(() => expect(within(log).getAllByRole('article').length).toBeGreaterThan(5));
    let top = 1700;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: value => { top = value; } });
    log.scrollTo = ((options: ScrollToOptions) => { top = Math.min(1700, options.top ?? top); }) as typeof log.scrollTo;

    await act(async () => {
      fireEvent.scroll(log);
      fireEvent.wheel(log);
      top = 200;
      fireEvent.scroll(log);
    });
    const jump = await screen.findByRole('button', { name: /Jump to latest/ });
    await act(async () => { fireEvent.click(jump); });
    expect(top).toBe(1700);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Jump to latest/ })).not.toBeInTheDocument());
  });

  it('loads older history on demand', async () => {
    const user = userEvent.setup();
    const recent = auditTimeline.slice(10);
    const { server } = renderConsole({
      audit: recent,
      setup: fake => fake.always(`GET /events/${liveDispute.eventId}/audit`, call =>
        new Response(JSON.stringify(call.url.includes('after=0') ? recent : auditTimeline.slice(0, 10)), { status: 200, headers: { 'content-type': 'application/json' } }))
    });
    await ready();
    const older = await screen.findByRole('button', { name: 'Load older activity' });
    await user.click(older);
    const log = screen.getByRole('log', { name: 'Activity' });
    await waitFor(() => expect(within(log).getAllByRole('article')[0]).toHaveTextContent('Ava Chen'));
    expect(server.callsTo(`GET /events/${liveDispute.eventId}/audit`).length).toBeGreaterThan(0);
  });
});
