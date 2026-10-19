import type { EventSnapshotDto } from '@tcg-live/core';
import { checkin, final, liveDispute, liveInterrupted, snapshots, FIXTURE_NOW_MS } from '@tcg-live/core/fixtures';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LivePreview, type FlowView, type LivePreviewProps } from './index';

function renderPreview(props: Partial<LivePreviewProps> & { snapshot?: EventSnapshotDto } = {}) {
  const onViewChange = vi.fn<(view: FlowView, matchId: LivePreviewProps['matchId']) => void>();
  const utils = render(
    <div style={{ width: 800, height: 400 }}>
      <LivePreview snapshot={liveDispute} view="event" matchId={null} onViewChange={onViewChange}
        getServerNow={() => FIXTURE_NOW_MS} {...props} />
    </div>
  );
  return { ...utils, onViewChange };
}

const clockText = (id: string): string => screen.getByTestId(`clock-${id}`).textContent ?? '';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockReducedMotion(reduce: boolean): void {
  const original = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...original(query), matches: reduce && query.includes('prefers-reduced-motion')
  }));
}

/** liveDispute with only M2's judge details changed: M1 and its edges are untouched. */
const liveDisputeLater: EventSnapshotDto = {
  ...liveDispute, version: 18,
  matches: [liveDispute.matches[0]!, { ...liveDispute.matches[1]!,
    judge: { reasons: ['dispute', 'called'], sinceMs: FIXTURE_NOW_MS, raisedBy: ['C', 'D'] } }]
};

describe('LivePreview', () => {
  it('renders every fixture in both views in jsdom', () => {
    for (const snapshot of Object.values(snapshots)) {
      for (const view of ['event', 'match'] as const) {
        const { unmount } = renderPreview({ snapshot, view });
        const pane = screen.getByTestId('live-preview');
        expect(pane).toHaveAttribute('data-event', snapshot.eventId);
        expect(pane).toHaveAttribute('data-view', view);
        expect(pane.querySelectorAll('[data-node]')).toHaveLength(view === 'event' ? 6 : 8);
        unmount();
      }
    }
  });

  it('labels match nodes descriptively and shows the frozen and running clocks at the injected time', () => {
    renderPreview();
    expect(screen.getByRole('button', { name: /^M2, paused, judge needed: dispute, 22:25 left/ })).toBeInTheDocument();
    // M1 started 36 minutes before FIXTURE_NOW_MS on a 50-minute clock.
    expect(screen.getByRole('button', { name: /^M1, running, about 14 minutes left/ })).toBeInTheDocument();
    expect(clockText('M1')).toBe('14:00');
    expect(clockText('M2')).toBe('22:25');
    expect(screen.getByRole('group', { name: 'Check-in, done, 4 / 4 in' })).toHaveAttribute('tabindex', '0');
  });

  it('marks node states for styling: live ring, judge ring, interrupted without ring', () => {
    const { container, unmount } = renderPreview();
    expect(container.querySelector('[data-node="M1"]')).toHaveClass('is-live');
    expect(container.querySelector('[data-node="M2"]')).toHaveClass('is-waiting');
    unmount();
    const interrupted = renderPreview({ snapshot: liveInterrupted });
    const m1 = interrupted.container.querySelector('[data-node="M1"]')!;
    expect(m1).toHaveClass('is-interrupted');
    expect(m1).not.toHaveClass('is-live');
    expect(m1).toHaveTextContent('Interrupted');
    expect(screen.getByTestId('clock-M1')).toHaveAttribute('data-clock-state', 'interrupted');
  });

  it('ticks a running clock inside the node without touching a frozen one', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = FIXTURE_NOW_MS;
    renderPreview({ getServerNow: () => now });
    expect(clockText('M1')).toBe('14:00');
    const m1Node = screen.getByTestId('clock-M1').closest('.react-flow__node') as HTMLElement;
    const transformBefore = m1Node.style.transform;
    now += 61_000;
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(clockText('M1')).toBe('12:59');
    expect(clockText('M2')).toBe('22:25');
    expect(m1Node.style.transform).toBe(transformBefore);
  });

  it('an interrupted clock stays frozen as time passes', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = FIXTURE_NOW_MS;
    renderPreview({ snapshot: liveInterrupted, getServerNow: () => now });
    const before = clockText('M1');
    now += 120_000;
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(clockText('M1')).toBe(before);
  });

  it('clicking a match node in the Event view requests its Match view', async () => {
    const { onViewChange } = renderPreview();
    await userEvent.click(screen.getByRole('button', { name: /^M2,/ }));
    expect(onViewChange).toHaveBeenCalledWith('match', 'M2');
  });

  it('Enter and Space on a focused match node open it too', () => {
    const { onViewChange } = renderPreview();
    const m1 = screen.getByRole('button', { name: /^M1,/ });
    m1.focus();
    expect(m1).toHaveFocus();
    fireEvent.keyDown(m1, { key: 'Enter' });
    fireEvent.keyDown(m1, { key: ' ' });
    expect(onViewChange.mock.calls).toEqual([['match', 'M1'], ['match', 'M1']]);
  });

  it('match nodes are not buttons in the Match view, and nodes are not draggable', () => {
    const { container } = renderPreview({ view: 'match', matchId: 'M2' });
    expect(screen.queryByRole('button', { name: /^M2,/ })).toBeNull();
    expect(screen.getByRole('group', { name: 'M2 Judge, waiting on a judge, dispute' })).toBeInTheDocument();
    expect(container.querySelector('.react-flow__node.draggable')).toBeNull();
    expect(container.querySelector('.react-flow__node.connectable')).toBeNull();
  });

  it('the view switcher requests views and reflects the current one', async () => {
    const { onViewChange } = renderPreview({ view: 'match', matchId: null });
    expect(screen.getByTestId('live-preview')).toHaveAttribute('data-match', 'M2');
    expect(screen.getByRole('button', { name: 'Match M2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Event' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Match M1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Event' }));
    expect(onViewChange.mock.calls).toEqual([['match', 'M1'], ['event', 'M2']]);
  });

  it('has fit and zoom controls', () => {
    renderPreview();
    for (const name of ['Fit view', 'Zoom out', 'Zoom in']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('throttles snapshot updates into the graph', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const onViewChange = vi.fn();
    const props = { view: 'event' as const, matchId: null, onViewChange, getServerNow: () => FIXTURE_NOW_MS };
    const { container, rerender } = render(<LivePreview snapshot={checkin} {...props} />);
    const checkinState = () => container.querySelector('[data-node="checkin"]')!.getAttribute('data-state');
    expect(checkinState()).toBe('live');
    rerender(<LivePreview snapshot={liveDispute} {...props} />);
    rerender(<LivePreview snapshot={final} {...props} />);
    // Still inside the 200 ms window that started at mount.
    expect(checkinState()).toBe('live');
    act(() => { vi.advanceTimersByTime(200); });
    expect(checkinState()).toBe('done');
    expect(container.querySelector('[data-node="standings"]')).toHaveAttribute('data-state', 'done');
  });

  it('keeps edge elements mounted across snapshot updates, so animations never restart', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const props = { view: 'event' as const, matchId: null, onViewChange: vi.fn(), getServerNow: () => FIXTURE_NOW_MS };
    const { container, rerender } = render(<LivePreview snapshot={liveDispute} {...props} />);
    const edgeElements = () => Array.from(container.querySelectorAll('.react-flow__edge'));
    const before = edgeElements();
    expect(before).toHaveLength(6);
    const traveler = container.querySelector('.tcg-flow-traveler');
    expect(traveler).not.toBeNull();
    const labels = Array.from(container.querySelectorAll('.tcg-flow-edge-label'));

    act(() => { vi.advanceTimersByTime(1_000); });
    rerender(<LivePreview snapshot={liveDisputeLater} {...props} />);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(container.querySelector('[data-node="M2"]')).toHaveAccessibleName(/judge needed: dispute, called/);

    const after = edgeElements();
    expect(after).toHaveLength(6);
    after.forEach((element, index) => expect(element).toBe(before[index]));
    expect(container.querySelector('.tcg-flow-traveler')).toBe(traveler);
    Array.from(container.querySelectorAll('.tcg-flow-edge-label'))
      .forEach((element, index) => expect(element).toBe(labels[index]));
  });

  it('a paused match without a judge gets a static clay edge and no traveling dot', () => {
    const paused: EventSnapshotDto = { ...liveDispute, matches: [
      { ...liveDispute.matches[0]!, phase: 'paused', pauseGeneration: 1,
        clock: { ...liveDispute.matches[0]!.clock, state: 'frozen', runningSinceMs: null, remainingMs: 600_000 } },
      liveDispute.matches[1]!
    ] };
    const { container } = renderPreview({ snapshot: paused });
    expect(container.querySelector('[data-node="M1"]')).toHaveClass('is-current');
    expect(container.querySelector('path.tcg-flow-edge.is-current')).not.toBeNull();
    expect(container.querySelector('path.tcg-flow-edge.is-active')).toBeNull();
    expect(container.querySelector('.tcg-flow-traveler')).toBeNull();
  });

  it('renders live and waiting rings as SVG overlays, and no ring for an interrupted clock', () => {
    const { container, unmount } = renderPreview();
    expect(container.querySelector('[data-node="M1"] .tcg-flow-ring.is-live')).not.toBeNull();
    expect(container.querySelector('[data-node="M2"] .tcg-flow-ring.is-waiting')).not.toBeNull();
    unmount();
    const interrupted = renderPreview({ snapshot: liveInterrupted });
    expect(interrupted.container.querySelector('[data-node="M1"] .tcg-flow-ring')).toBeNull();
  });

  it('honours prefers-reduced-motion: flagged canvas, no traveling dot, rings kept static', () => {
    mockReducedMotion(true);
    const { container } = renderPreview();
    expect(screen.getByTestId('live-preview')).toHaveAttribute('data-reduced-motion', 'true');
    expect(container.querySelector('path.tcg-flow-edge.is-active')).not.toBeNull();
    expect(container.querySelector('.tcg-flow-traveler')).toBeNull();
    expect(container.querySelector('.tcg-flow-ring.is-live')).not.toBeNull();
  });

  it('without reduced motion the active edge carries a traveling dot', () => {
    mockReducedMotion(false);
    const { container } = renderPreview();
    expect(screen.getByTestId('live-preview')).not.toHaveAttribute('data-reduced-motion');
    expect(container.querySelector('.tcg-flow-traveler')).not.toBeNull();
  });

  it('moves focus to the active view button after a match node is opened from the keyboard', () => {
    function Host() {
      const [view, setView] = useState<FlowView>('event');
      const [matchId, setMatchId] = useState<LivePreviewProps['matchId']>(null);
      return (
        <LivePreview snapshot={liveDispute} view={view} matchId={matchId} getServerNow={() => FIXTURE_NOW_MS}
          onViewChange={(next, id) => { setView(next); setMatchId(id); }} />
      );
    }
    render(<Host />);
    const m1 = screen.getByRole('button', { name: /^M1,/ });
    m1.focus();
    fireEvent.keyDown(m1, { key: 'Enter' });
    expect(screen.getByTestId('live-preview')).toHaveAttribute('data-view', 'match');
    expect(screen.getByRole('button', { name: 'Match M1' })).toHaveFocus();
  });

  it('a new inline getServerNow from the parent does not restart clock intervals', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const onViewChange = vi.fn();
    let now = FIXTURE_NOW_MS;
    const { rerender } = render(
      <LivePreview snapshot={liveDispute} view="event" matchId={null} onViewChange={onViewChange} getServerNow={() => now} />
    );
    const intervals = setIntervalSpy.mock.calls.length;
    expect(intervals).toBeGreaterThan(0);
    for (let index = 0; index < 3; index += 1) {
      rerender(<LivePreview snapshot={liveDispute} view="event" matchId={null} onViewChange={onViewChange}
        getServerNow={() => now + 0} />);
    }
    expect(setIntervalSpy.mock.calls.length).toBe(intervals);
    now += 60_000;
    act(() => { vi.advanceTimersByTime(500); });
    expect(clockText('M1')).toBe('13:00');
  });
});
