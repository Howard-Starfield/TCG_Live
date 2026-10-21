import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastOptions } from './Toast';
import { skipMotion } from './testing';

beforeAll(skipMotion);
// Only the dismiss timers are faked; motion keeps real animation frames for its exit transitions.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

let api: ReturnType<typeof useToast>;
function Capture() {
  api = useToast();
  return null;
}

function renderProvider(duration = 4000) {
  render(<ToastProvider duration={duration}><Capture /></ToastProvider>);
}

function show(options: ToastOptions) {
  let id = '';
  act(() => { id = api.show(options); });
  return id;
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** Waits (in real time) for the exit transition to unmount the toast. */
async function expectGone(text: string) {
  await vi.waitFor(() => expect(screen.queryByText(text)).not.toBeInTheDocument(), { timeout: 2000 });
}

describe('Toast', () => {
  it('announces neutral toasts politely and danger toasts assertively', () => {
    renderProvider();
    show({ title: 'Round 1 published', tone: 'success' });
    show({ title: 'Command rejected', description: 'The match changed.', tone: 'danger' });
    const polite = screen.getByRole('status');
    const assertive = screen.getByRole('alert');
    expect(polite).toHaveAttribute('aria-live', 'polite');
    expect(assertive).toHaveAttribute('aria-live', 'assertive');
    expect(within(polite).getByText('Round 1 published')).toBeInTheDocument();
    expect(within(assertive).getByText('Command rejected')).toBeInTheDocument();
    expect(within(assertive).getByText('The match changed.')).toBeInTheDocument();
  });

  it('auto-dismisses after the duration', async () => {
    renderProvider(4000);
    show({ title: 'Saved' });
    await advance(3900);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    await advance(200);
    await expectGone('Saved');
  });

  it('pauses while hovered and resumes with the remaining time', async () => {
    renderProvider(4000);
    show({ title: 'Hover me' });
    await advance(3000);
    const region = screen.getByRole('region', { name: 'Notifications' });
    fireEvent.pointerEnter(region);
    await advance(10_000);
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    fireEvent.pointerLeave(region);
    await advance(900);
    expect(screen.getByText('Hover me')).toBeInTheDocument();
    await advance(200);
    await expectGone('Hover me');
  });

  it('keeps sticky toasts, runs the action and dismisses by button', async () => {
    renderProvider();
    const onRetry = vi.fn();
    show({ title: 'Sticky', duration: null, action: { label: 'Retry', onClick: onRetry } });
    show({ title: 'Other', duration: null });
    await advance(60_000);
    expect(screen.getByText('Sticky')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectGone('Sticky');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    await expectGone('Other');
  });

  it('throws a clear error outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Capture />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
