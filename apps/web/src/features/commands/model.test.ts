import { ADMIN_REASON_MAX_LENGTH, CAPABILITIES, type SessionDto } from '@tcg-live/core';
import { checkin, FIXTURE_MEMBER_IDS, final, liveDispute, liveInterrupted, signupOpen } from '@tcg-live/core/fixtures';
import { describe, expect, it } from 'vitest';
import { availableEventActions, availableMatchActions, canRefreshPanels, canRemoveMember, canRunAny, checkReason,
  preconditionFor, refreshToasts, resultToasts, PENDING_DESCRIPTION } from './model';

type Gate = Pick<SessionDto, 'commandsEnabled' | 'capabilities'>;
const admin: Gate = { commandsEnabled: true, capabilities: [...CAPABILITIES] };
const readOnly: Gate = { commandsEnabled: false, capabilities: ['dashboard.read'] };
const m = (snapshot: typeof liveDispute, id: 'M1' | 'M2') => snapshot.matches.find(match => match.id === id)!;

describe('gating (decision 4)', () => {
  it('offers nothing when the server does not enable commands, even with every capability', () => {
    const disabled = { ...admin, commandsEnabled: false };
    expect(canRunAny(disabled)).toBe(false);
    expect(canRunAny(readOnly)).toBe(false);
    expect(canRefreshPanels(disabled)).toBe(false);
    expect(availableEventActions(disabled, checkin)).toEqual([]);
    expect(availableMatchActions(disabled, liveDispute, m(liveDispute, 'M2'))).toEqual([]);
  });

  it('hides each action whose capability the session lacks', () => {
    const judge: Gate = { commandsEnabled: true, capabilities: ['dashboard.read', 'match.judge'] };
    expect(availableMatchActions(judge, liveDispute, m(liveDispute, 'M2'))).toEqual(['resolve', 'judgeResume']);
    expect(availableMatchActions(judge, final, m(final, 'M1'))).toEqual([]);
    expect(availableEventActions(judge, checkin)).toEqual([]);
    expect(canRefreshPanels(judge)).toBe(false);
    expect(canRunAny(judge)).toBe(true);
    const panelsOnly: Gate = { commandsEnabled: true, capabilities: ['dashboard.read', 'panels.refresh'] };
    expect(canRunAny(panelsOnly)).toBe(true);
  });

  it('follows adminActions from the snapshot', () => {
    expect(availableEventActions(admin, signupOpen)).toEqual(['signupRemove']);
    expect(availableEventActions(admin, checkin)).toEqual(['signupReopen']);
    expect(availableMatchActions(admin, liveDispute, m(liveDispute, 'M1'))).toEqual(['resolve']);
    expect(availableMatchActions(admin, liveDispute, m(liveDispute, 'M2'))).toEqual(['resolve', 'judgeResume']);
    expect(availableMatchActions(admin, final, m(final, 'M2'))).toEqual(['correct']);
    expect(availableMatchActions(admin, liveInterrupted, m(liveInterrupted, 'M1'))).toEqual([]);
  });

  it('never acts on retired events', () => {
    const retired = { ...liveDispute, status: 'retired' as const };
    expect(availableMatchActions(admin, retired, m(retired, 'M2'))).toEqual([]);
    expect(availableEventActions(admin, { ...checkin, status: 'retired' })).toEqual([]);
  });

  it('removes only roster members while signup is open', () => {
    expect(canRemoveMember(admin, signupOpen, FIXTURE_MEMBER_IDS[0])).toBe(true);
    expect(canRemoveMember(admin, signupOpen, FIXTURE_MEMBER_IDS[3])).toBe(false);
    expect(canRemoveMember(admin, checkin, FIXTURE_MEMBER_IDS[0])).toBe(false);
    expect(canRemoveMember(readOnly, signupOpen, FIXTURE_MEMBER_IDS[0])).toBe(false);
  });
});

describe('preconditions', () => {
  it('describe what the admin saw, per command family', () => {
    expect(preconditionFor(checkin, { type: 'publish' })).toEqual({ eventVersion: 8 });
    expect(preconditionFor(signupOpen, { type: 'signupRemove', memberId: 'x' })).toEqual({ signup: { status: 'open', rosterSize: 3 } });
    expect(preconditionFor(checkin, { type: 'signupReopen' })).toEqual({ signup: { status: 'assigned', rosterSize: 4 } });
    expect(preconditionFor(final, { type: 'correct', matchId: 'M2', winner: 'C', reason: 'r' }))
      .toEqual({ match: { matchId: 'M2', phase: 'final', proposalRevision: 1, finalWinner: 'D', pauseGeneration: 1 } });
    expect(preconditionFor(liveDispute, { type: 'judgeResume', matchId: 'M1', reason: 'r' }))
      .toEqual({ match: { matchId: 'M1', phase: 'running', proposalRevision: null, finalWinner: null, pauseGeneration: 0 } });
  });
});

describe('reason validation', () => {
  it('requires 1 to 500 characters after trimming', () => {
    expect(checkReason('')).toMatchObject({ ok: false, error: expect.stringMatching(/Enter a reason/) });
    expect(checkReason('   \n\t ')).toMatchObject({ ok: false, error: expect.stringMatching(/Enter a reason/) });
    expect(checkReason('x'.repeat(ADMIN_REASON_MAX_LENGTH + 1))).toMatchObject({ ok: false, length: 501, error: expect.stringMatching(/500 characters \(it has 501\)/) });
    expect(checkReason(`  ${'x'.repeat(ADMIN_REASON_MAX_LENGTH)}  `)).toEqual({ ok: true, reason: 'x'.repeat(500) });
    expect(checkReason('  Judge ruling ')).toEqual({ ok: true, reason: 'Judge ruling' });
  });

  it('treats only-format-character reasons as empty, but trims only whitespace', () => {
    for (const blank of ['​', ' ‍⁠ ', '﻿', '­‎\n']) {
      expect(checkReason(blank)).toMatchObject({ ok: false, error: expect.stringMatching(/Enter a reason/) });
    }
    expect(checkReason(' ​x​ ')).toEqual({ ok: true, reason: '​x​' });
    expect(checkReason(`​${'x'.repeat(500)}`)).toMatchObject({ ok: false, length: 501 });
  });
});

describe('result toasts', () => {
  const command = { type: 'resolve' as const, matchId: 'M2' as const, winner: 'C' as const, reason: 'r' };

  it('success, pending display, room warning and no-op', () => {
    expect(resultToasts(liveDispute, command, { applied: true, result: 'resolve', version: 18, cards: 'updated', roomWarning: null }))
      .toEqual([{ title: 'M2 resolved: Seat C · Cy Park wins', tone: 'success' }]);
    const pending = resultToasts(liveDispute, command, { applied: true, result: 'resolve', version: 18, cards: 'pending', roomWarning: 'Could not move Seat D' });
    expect(pending).toEqual([
      { title: 'M2 resolved: Seat C · Cy Park wins', description: PENDING_DESCRIPTION, tone: 'neutral', duration: 8000 },
      { title: 'Match room warning', description: 'Could not move Seat D', tone: 'danger', duration: null }
    ]);
    expect(resultToasts(liveDispute, command, { applied: false, result: 'judge_already_called', version: 17, cards: 'updated', roomWarning: null }))
      .toEqual([{ title: 'No change', description: 'Nothing changed: judge already called.', tone: 'neutral' }]);
    expect(refreshToasts({ cards: 'pending', roomWarning: null })[0]).toMatchObject({ title: 'Panel refresh saved', description: PENDING_DESCRIPTION });
    expect(refreshToasts({ cards: 'refreshed', roomWarning: 'Rooms off' }).map(toast => toast.title)).toEqual(['Discord panels refreshed', 'Match room warning']);
  });
});
