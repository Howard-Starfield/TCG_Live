import { checkin, FIXTURE_ADMIN_ID, FIXTURE_MEMBER_IDS, final, liveDispute, liveInterrupted, signupOpen } from '@tcg-live/core/fixtures';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATCH_STACK_CLOCK_BELOW, MATCH_STACK_PLAYERS_BELOW, MATCH_WIDE_FROM } from './MatchesTab';
import { PLAYER_COLUMN_MIN_WIDTH } from './PlayersTab';
import { bodyRows, renderList } from './testUtils';

const [AVA] = FIXTURE_MEMBER_IDS;

afterEach(() => vi.unstubAllGlobals());

/** Makes every ResizeObserver report this content width (the setup shim reports 800 px). */
function stubWidth(width: number) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  });
}

const headers = () => screen.getAllByRole('columnheader').map(header => header.textContent);

describe('ListPreview tabs', () => {
  it('renders four labelled tabs and the selected panel', () => {
    renderList(liveDispute, 'players');
    const tablist = screen.getByRole('tablist', { name: 'List views' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Players, 4', 'Matches, 1', 'Audit', 'Discord panelsDiscord']);
    expect(screen.getByRole('tab', { name: /Discord panels/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Players/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/Players/);
    expect(screen.getByLabelText('1 need a judge')).toBeInTheDocument();
  });

  it('changes tab with the arrow keys (selection follows focus)', async () => {
    const user = userEvent.setup();
    const { onTabChange } = renderList(liveDispute, 'players');
    screen.getByRole('tab', { name: /Players/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('matches');
    expect(screen.getByRole('tab', { name: /Matches/ })).toHaveFocus();
    expect(screen.getByRole('table', { name: /^Matches/ })).toBeInTheDocument();
    await user.keyboard('{End}');
    expect(onTabChange).toHaveBeenLastCalledWith('panels');
    await user.keyboard('{ArrowRight}');
    expect(onTabChange).toHaveBeenLastCalledWith('players');
  });

  it('can leave the tab strip to the shell', () => {
    renderList(liveDispute, 'players');
    expect(screen.getByTestId('list-preview')).toHaveAttribute('data-event', liveDispute.eventId);
  });
});

describe('Players tab', () => {
  it('lists seats with names, check-in, match, standings and status', () => {
    renderList(liveDispute, 'players');
    const rows = bodyRows('Players by seat');
    expect(rows).toHaveLength(4);
    const first = within(rows[0]!);
    expect(first.getByRole('img', { name: 'Seat A' })).toBeInTheDocument();
    expect(first.getByRole('button', { name: 'Ava Chen, copy member ID' })).toBeInTheDocument();
    expect(first.getByText('Assigned')).toBeInTheDocument();
    expect(first.getByRole('img', { name: 'Checked in' })).toBeInTheDocument();
    expect(first.getByText('M1')).toBeInTheDocument();
    expect(first.getByText('1200')).toBeInTheDocument();
    expect(first.getByText('Playing')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Dee Ross')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Needs judge')).toBeInTheDocument();
    expect(screen.getByText(/4 seated · 4 checked in · round published/)).toBeInTheDocument();
  });

  it('shows check-in progress before publication', () => {
    renderList(checkin, 'players');
    const rows = bodyRows('Players by seat');
    expect(within(rows[2]!).getByText('Checked in')).toBeInTheDocument();
    expect(within(rows[3]!).getByRole('img', { name: 'Not checked in' })).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Not checked in', { selector: '.lists-chip' })).toBeInTheDocument();
  });

  it('shows the roster in join order while signup is open', () => {
    renderList(signupOpen, 'players');
    const rows = bodyRows('Signup roster in join order');
    expect(rows.map(row => within(row).getByRole('button').textContent)).toEqual(['Ava Chen', 'Ben Ortiz', 'Cy Park']);
    expect(within(rows[0]!).getByText('In roster')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Joined')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Seat/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Signup open · 3 of 4 joined/)).toBeInTheDocument();
  });

  it('has an empty state for an empty roster', () => {
    renderList({ ...signupOpen, signup: { status: 'open', capacity: 4, roster: [] },
      members: { [FIXTURE_ADMIN_ID]: signupOpen.members[FIXTURE_ADMIN_ID]! } }, 'players');
    expect(screen.getByText('No one has joined yet')).toBeInTheDocument();
  });

  it('sorts by points and rating, with aria-sort', async () => {
    const user = userEvent.setup();
    renderList(final, 'players');
    const header = screen.getByRole('columnheader', { name: /Pts/ });
    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    const rows = bodyRows('Players by seat');
    expect(rows.map(row => within(row).getAllByRole('cell')[5]!.textContent)).toEqual(['3', '3', '0', '0']);
    expect(within(rows[0]!).getByText('Won')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('1216')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Lost')).toBeInTheDocument();
    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  describe('in narrow panes', () => {
    it('keeps seat, member, status and points at 380 px', () => {
      stubWidth(380);
      renderList(liveDispute, 'players');
      expect(headers()).toEqual(['Seat', 'Member', 'Status', 'Pts']);
      expect(within(bodyRows('Players by seat')[3]!).getByText('Needs judge')).toBeInTheDocument();
    });

    it('adds columns by priority as the pane widens', () => {
      stubWidth(PLAYER_COLUMN_MIN_WIDTH.match);
      renderList(liveDispute, 'players');
      expect(headers()).toEqual(['Seat', 'Member', 'Status', 'Check-in', 'Match', 'Pts']);
    });

    it('shows every column when wide', () => {
      stubWidth(PLAYER_COLUMN_MIN_WIDTH.signup);
      renderList(liveDispute, 'players');
      expect(headers()).toEqual(['Seat', 'Member', 'Status', 'Check-in', 'Match', 'Pts', 'Rating', 'Signup']);
    });

    it('shows only roster columns before seats exist', () => {
      stubWidth(380);
      renderList(signupOpen, 'players');
      expect(headers()).toEqual(['#', 'Member', 'Status', 'Signup']);
    });
  });

  it('copies a member ID from the name', async () => {
    const user = userEvent.setup();
    renderList(liveDispute, 'players');
    await user.click(screen.getByRole('button', { name: 'Ava Chen, copy member ID' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(AVA);
    expect(screen.getAllByRole('status').some(node => node.textContent === 'Copied to clipboard')).toBe(true);
  });
});

describe('Matches tab', () => {
  it('shows seats, phase, live clock, judge reasons and the proposal in wide panes', () => {
    stubWidth(MATCH_WIDE_FROM);
    renderList(liveDispute, 'matches');
    expect(headers()).toEqual(['Match', 'Players', 'Phase', 'Clock', 'Judge', 'Proposal', 'Open']);
    const rows = bodyRows(/^Matches/);
    const m1 = within(rows[0]!);
    expect(m1.getByText('Ava Chen')).toBeInTheDocument();
    expect(m1.getByText('Ben Ortiz')).toBeInTheDocument();
    expect(m1.getByText('Running')).toBeInTheDocument();
    expect(m1.getByText('14:00')).toBeInTheDocument();
    expect(rows[0]!.querySelector('[data-clock-state="running"]')).not.toBeNull();
    const m2 = within(rows[1]!);
    expect(m2.getByText('Paused')).toBeInTheDocument();
    expect(m2.getByText('22:25')).toBeInTheDocument();
    expect(m2.getByText('Dispute')).toBeInTheDocument();
    expect(m2.getByText(/by D · since/)).toBeInTheDocument();
    expect(m2.getByText('rev 1')).toBeInTheDocument();
    expect(m2.getByText('C won')).toBeInTheDocument();
    expect(m2.getByText('disputed')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Result/ })).not.toBeInTheDocument();
  });

  it('shows an interrupted clock frozen and labelled', () => {
    renderList(liveInterrupted, 'matches');
    const m1 = bodyRows(/^Matches/)[0]!;
    expect(m1.querySelector('[data-clock-state="interrupted"]')).not.toBeNull();
    expect(within(m1).getByText('interrupted')).toBeInTheDocument();
    expect(within(m1).getByLabelText(/clock interrupted/)).toBeInTheDocument();
    expect(m1.querySelector('[data-live]')).toBeNull();
  });

  it('shows final winners with their source in wide panes', () => {
    stubWidth(MATCH_WIDE_FROM);
    renderList(final, 'matches');
    const [m1, m2] = bodyRows(/^Matches/);
    expect(within(m1!).getByText('Final')).toBeInTheDocument();
    expect(within(m1!).getByText('agreed')).toBeInTheDocument();
    expect(within(m1!).getByText('confirmed by B')).toBeInTheDocument();
    expect(within(m2!).getByText('admin')).toBeInTheDocument();
    expect(within(m2!).getAllByText('Dee Ross').length).toBeGreaterThan(0);
    expect(screen.queryByRole('columnheader', { name: /Judge/ })).not.toBeInTheDocument();
  });

  it('stacks judge, proposal and result under the phase in medium panes', () => {
    stubWidth(MATCH_WIDE_FROM - 1);
    renderList(liveDispute, 'matches');
    expect(headers()).toEqual(['Match', 'Players', 'Phase', 'Clock', 'Open']);
    const m2 = within(bodyRows(/^Matches/)[1]!);
    expect(m2.getByText('Paused')).toBeInTheDocument();
    expect(m2.getByText('Dispute')).toBeInTheDocument();
    expect(m2.getByText('by D')).toBeInTheDocument();
    expect(m2.getByText('C won')).toBeInTheDocument();
    expect(m2.getByText('by C · rev 1')).toBeInTheDocument();
    expect(m2.getByText('disputed')).toBeInTheDocument();
    expect(within(bodyRows(/^Matches/)[0]!).getByText('Ava Chen')).toBeInTheDocument();
    expect(within(bodyRows(/^Matches/)[0]!).getByText('vs')).toBeInTheDocument();
  });

  it('keeps match, players, phase and clock in narrow panes, players stacked', () => {
    stubWidth(MATCH_STACK_PLAYERS_BELOW - 1);
    renderList(final, 'matches');
    expect(headers()).toEqual(['Match', 'Players', 'Phase', 'Clock', 'Open']);
    const [m1, m2] = bodyRows(/^Matches/);
    expect(within(m1!).queryByText('vs')).not.toBeInTheDocument();
    expect(within(m1!).getByText('Won by')).toBeInTheDocument();
    expect(within(m1!).getByText('agreed')).toHaveAttribute('title', 'Agreed by both players, confirmed by B');
    expect(within(m2!).getByText('admin')).toBeInTheDocument();
    expect(within(m2!).getByText('22:25')).toBeInTheDocument();
  });

  it('moves the clock under the match ID in very narrow panes', async () => {
    stubWidth(MATCH_STACK_CLOCK_BELOW - 1);
    const user = userEvent.setup();
    const { onOpenMatch } = renderList(final, 'matches');
    expect(headers()).toEqual(['Match · clock', 'Players', 'Phase']);
    const [m1, m2] = bodyRows(/^Matches/);
    expect(within(m1!).getByText('12:05')).toBeInTheDocument();
    expect(within(m2!).getAllByRole('img', { name: 'Seat D' })).toHaveLength(2);   // player and winner
    expect(within(m2!).getAllByText('Dee Ross')).toHaveLength(1);                 // the result names only the seat
    expect(within(m2!).getByText('admin')).toBeInTheDocument();
    m2!.focus();
    await user.keyboard('{Enter}');
    expect(onOpenMatch).toHaveBeenLastCalledWith('M2');
  });

  it('marks a table that still scrolls sideways', () => {
    stubWidth(360);
    renderList(liveDispute, 'matches');
    const cue = document.querySelector('.lists-scroll-cue')!;
    expect(cue).toBeInTheDocument();
    // jsdom has no layout, so nothing overflows: no edge is faded.
    expect(cue).not.toHaveAttribute('data-more-end');
  });

  it('opens a match on click and with Enter', async () => {
    const user = userEvent.setup();
    const { onOpenMatch } = renderList(liveDispute, 'matches');
    const [m1, m2] = bodyRows(/^Matches/);
    await user.click(m2!);
    expect(onOpenMatch).toHaveBeenLastCalledWith('M2');
    m1!.focus();
    await user.keyboard('{Enter}');
    expect(onOpenMatch).toHaveBeenLastCalledWith('M1');
  });

  it('keeps rows inert without onOpenMatch', () => {
    renderList(liveDispute, 'matches', { withOpenMatch: false });
    expect(bodyRows('Matches')[0]).not.toHaveAttribute('tabindex');
  });

  it('has an empty state without matches', () => {
    renderList({ ...liveDispute, matches: [] }, 'matches');
    expect(screen.getByText('No matches yet')).toBeInTheDocument();
  });
});

describe('Discord panels tab', () => {
  it('lists channels, cards and runtime state', async () => {
    renderList(liveDispute, 'panels', { status: { cards: { updatePending: true },
      rooms: { enabled: true, warning: 'Missing Manage Channels permission' } } });
    expect(screen.getByText(liveDispute.discord.guildId)).toBeInTheDocument();
    expect(screen.getByText(liveDispute.discord.channelId)).toBeInTheDocument();
    expect(screen.getByText(liveDispute.discord.matchChannels!.M2)).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    const rows = bodyRows('Discord cards');
    expect(within(rows[1]!).getByText('900000000000000202')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Posted')).toBeInTheDocument();
    const revision = screen.getByText('Panel revision').nextElementSibling!;
    expect(revision).toHaveTextContent('2');
    expect(await screen.findByText('Update pending')).toBeInTheDocument();
    expect(screen.getByText('Missing Manage Channels permission')).toBeInTheDocument();
  });

  it('shows missing rooms, unposted and suspended cards, and copies IDs', async () => {
    const user = userEvent.setup();
    renderList({ ...checkin, discord: { ...checkin.discord, matchChannels: null, publicMatchRooms: true,
      cards: { ...checkin.discord.cards, checkin: { messageId: '900000000000000201', repostSuspended: true } } } }, 'panels');
    expect(screen.getAllByText('Not created')).toHaveLength(2);
    expect(screen.getByText('Public')).toBeInTheDocument();
    expect(screen.getByText('Repost suspended')).toBeInTheDocument();
    expect(screen.getAllByText('Not posted', { selector: '.lists-chip' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Copy guild ID' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(checkin.discord.guildId);
    expect(await screen.findByText('In sync')).toBeInTheDocument();
  });

  it('says when runtime status is still loading', async () => {
    renderList(liveDispute, 'panels', { statusMode: 'pending' });
    await act(async () => {});
    await waitFor(() => expect(screen.getByText('Checking runtime…')).toBeInTheDocument());
  });
});
