import type { TournamentDirectoryEntryDto } from '@tcg-live/core';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHarness, sessionFixture } from '../../app/testing';
import { AdminDataProvider, ServerClock, ServerClockContext } from '../../data';
import { ToastProvider } from '../../ui';
import { ShellProvider, type ShellModel } from '../shell/model';
import { DraftDetails } from './DraftDetails';
import { tournamentDirectoryKey } from './directory';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); });

it('polls a draft whose signup time has passed with a backoff capped at 60 s', async () => {
  const harness = createHarness({ stream: false });
  const invalidate = vi.spyOn(harness.data.queryClient, 'invalidateQueries');
  const directoryPolls = () => invalidate.mock.calls.filter(([filters]) => filters?.queryKey === tournamentDirectoryKey).length;
  const draft: TournamentDirectoryEntryDto = { eventId: 'draft-1', name: 'Late Cup', game: 'one-piece', status: 'draft',
    kind: 'signup', createdAtMs: 1, retiredAtMs: null, signupOpensAtMs: Date.now() - 1_000, startsAtMs: Date.now() + 3_600_000 };
  const shell = { session: sessionFixture, directory: { defaultGame: 'one-piece', entries: [draft] }, activeEventId: null,
    selectEvent: () => {} } as unknown as ShellModel;
  render(<AdminDataProvider data={harness.data}>
    <ServerClockContext.Provider value={new ServerClock()}>
      <ToastProvider><ShellProvider value={shell}><DraftDetails draft={draft} /></ShellProvider></ToastProvider>
    </ServerClockContext.Provider>
  </AdminDataProvider>);
  const at = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); return directoryPolls(); };
  const base = directoryPolls();
  expect(await at(2_999)).toBe(base);
  expect(await at(1)).toBe(base + 1);        // 3 s
  expect(await at(6_000)).toBe(base + 2);    // +6 s
  expect(await at(12_000)).toBe(base + 3);   // +12 s
  expect(await at(24_000)).toBe(base + 4);   // +24 s
  expect(await at(48_000)).toBe(base + 5);   // +48 s
  expect(await at(59_999)).toBe(base + 5);   // capped at 60 s
  expect(await at(1)).toBe(base + 6);
  expect(await at(60_000)).toBe(base + 7);
});
