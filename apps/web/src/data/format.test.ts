import type { AuditEntryDto } from '@tcg-live/core';
import { auditTimeline, FIXTURE_MEMBER_IDS, liveDispute, signupOpen } from '@tcg-live/core/fixtures';
import { describe, expect, it } from 'vitest';
import { formatAuditEntry, formatElapsed, formatRelativeTime, relativeTimeRefreshMs } from './format';

const base = auditTimeline[0]!;
const entry = (partial: Partial<AuditEntryDto>): AuditEntryDto => ({ ...base, ...partial });

describe('formatAuditEntry', () => {
  it('names members and seats from the snapshot', () => {
    expect(formatAuditEntry(auditTimeline[0]!, liveDispute)).toMatchObject({
      actorLabel: 'Ava Chen', actorName: 'Ava Chen', actorMemberId: FIXTURE_MEMBER_IDS[0],
      text: 'Ava Chen joined signup', tone: 'neutral', icon: 'user-plus'
    });
    const propose = auditTimeline.find(item => item.command.type === 'propose')!;
    expect(formatAuditEntry(propose, liveDispute)).toMatchObject({
      actorLabel: 'Seat C', actorName: 'Cy Park', text: 'Seat C proposed Seat C won M2', icon: 'flag'
    });
    const dispute = auditTimeline.find(item => item.command.type === 'dispute')!;
    expect(formatAuditEntry(dispute, liveDispute)).toMatchObject({ text: 'Seat D disputed the result of M2', tone: 'danger' });
  });

  it('formats timer, admin and judge lines', () => {
    expect(formatAuditEntry(entry({ actor: { kind: 'system', source: 'timer' }, via: 'system',
      command: { type: 'clockCheck', matchId: 'M2' } }), liveDispute))
      .toMatchObject({ actorLabel: 'Timer', text: 'Timer expired M2', tone: 'danger', icon: 'timer' });
    expect(formatAuditEntry(entry({ actor: { kind: 'admin' }, via: 'web',
      command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Judge ruling' } }), liveDispute))
      .toMatchObject({ text: 'Admin resolved M2 for Seat D — Judge ruling', tone: 'success', icon: 'trophy' });
    expect(formatAuditEntry(entry({ actor: { kind: 'admin' }, command: { type: 'correct', matchId: 'M1', winner: 'B', reason: 'Misreport' } })).text)
      .toBe('Admin corrected M1 to Seat B — Misreport');
    expect(formatAuditEntry(entry({ actor: { kind: 'player', seat: 'D' }, command: { type: 'callJudge', matchId: 'M2' } }), liveDispute).text)
      .toBe('Seat D called a judge on M2');
    expect(formatAuditEntry(entry({ actor: { kind: 'admin' }, command: { type: 'signupRemove', memberId: FIXTURE_MEMBER_IDS[2] } }), signupOpen).text)
      .toBe('Admin removed Cy Park from signup');
  });

  it('degrades gracefully without names or for unknown commands', () => {
    const unknownMember = entry({ actor: { kind: 'member', memberId: '123456789012345678' } });
    expect(formatAuditEntry(unknownMember).text).toBe('Member …5678 joined signup');
    expect(formatAuditEntry(entry({ actor: { kind: 'player', seat: 'A' } }), null).actorName).toBeNull();
    expect(formatAuditEntry(entry({ actor: { kind: 'admin' }, command: { type: 'futureThing', matchId: 'M1' } })))
      .toMatchObject({ text: 'Admin applied futureThing on M1', icon: 'activity' });
  });
});

describe('time helpers', () => {
  const now = 1_800_000_000_000;
  it('formats relative times', () => {
    expect(formatRelativeTime(now - 2_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 45_000, now)).toBe('45s ago');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d ago');
    expect(formatRelativeTime(now + 5 * 60_000, now)).toBe('in 5m');
  });

  it('formats elapsed durations and refresh intervals', () => {
    expect(formatElapsed(now - 185_000, now)).toBe('3:05');
    expect(formatElapsed(now - 3_725_000, now)).toBe('1:02:05');
    expect(formatElapsed(now + 5_000, now)).toBe('0:00');
    expect(relativeTimeRefreshMs(now - 10_000, now)).toBe(1_000);
    expect(relativeTimeRefreshMs(now - 90_000, now)).toBe(30_000);
  });
});
