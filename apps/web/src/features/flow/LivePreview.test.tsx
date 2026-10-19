import type { EventSnapshotDto } from '@tcg-live/core';
import { checkin, final, liveDispute, liveInterrupted, snapshots, FIXTURE_NOW_MS } from '@tcg-live/core/fixtures';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

afterEach(() => vi.useRealTimers());

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
    expect(screen.getByRole('button', { name: /^M1, running, 14:00 left/ })).toBeInTheDocument();
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
});
