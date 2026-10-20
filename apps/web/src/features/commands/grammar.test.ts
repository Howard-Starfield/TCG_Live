import { CAPABILITIES, type EventSnapshotDto, type SessionDto } from '@tcg-live/core';
import { checkin, FIXTURE_MEMBER_IDS, final, liveDispute, signupOpen } from '@tcg-live/core/fixtures';
import { describe, expect, it } from 'vitest';
import { mentionFor, parseCommand, resolveMention, suggest, type ComposerContext } from './grammar';

const [ava, ben, cy] = FIXTURE_MEMBER_IDS;
const admin: Pick<SessionDto, 'commandsEnabled' | 'capabilities'> = { commandsEnabled: true, capabilities: [...CAPABILITIES] };
const ctx = (snapshot: EventSnapshotDto, session: ComposerContext['session'] = admin): ComposerContext => ({ snapshot, session });
const publishable: EventSnapshotDto = { ...checkin, checkins: ['A', 'B', 'C', 'D'], adminActions: ['publish', 'signupReopen'] };

const ok = (text: string, context: ComposerContext) => {
  const result = parseCommand(text, context);
  if (result.kind !== 'ok') throw new Error(`expected ok for "${text}", got ${JSON.stringify(result)}`);
  return result.intent;
};
const error = (text: string, context: ComposerContext) => {
  const result = parseCommand(text, context);
  if (result.kind !== 'error') throw new Error(`expected an error for "${text}", got ${JSON.stringify(result)}`);
  return result.message;
};
const labels = (text: string, context: ComposerContext, caret = text.length) => suggest(text, caret, context)?.items.map(item => item.label) ?? [];

describe('composer parsing', () => {
  it('parses the event commands as /tcg-test spells them', () => {
    expect(ok('/publish', ctx(publishable))).toEqual({ kind: 'event', type: 'publish' });
    expect(ok('/tcg-test publish', ctx(publishable))).toEqual({ kind: 'event', type: 'publish' });
    expect(ok('  /SIGNUP-REOPEN ', ctx(checkin))).toEqual({ kind: 'event', type: 'signupReopen' });
    expect(ok('/refresh', ctx(liveDispute))).toEqual({ kind: 'refresh' });
  });

  it('parses positional and named match arguments, with the reason last', () => {
    expect(ok('/resolve M2 C Judge saw the final turn', ctx(liveDispute)))
      .toEqual({ kind: 'match', action: 'resolve', matchId: 'M2', winner: 'C', reason: 'Judge saw the final turn' });
    expect(ok('/resolve match:m2 winner:@D reason:Slow play  warning', ctx(liveDispute)))
      .toEqual({ kind: 'match', action: 'resolve', matchId: 'M2', winner: 'D', reason: 'Slow play  warning' });
    expect(ok('/judge-resume 2 Both players agreed at the table', ctx(liveDispute)))
      .toEqual({ kind: 'match', action: 'judgeResume', matchId: 'M2', winner: null, reason: 'Both players agreed at the table' });
    expect(ok('/correct M1 @Ben_Ortiz Scorekeeping error', ctx(final)))
      .toEqual({ kind: 'match', action: 'correct', matchId: 'M1', winner: 'B', reason: 'Scorekeeping error' });
  });

  it('leaves a missing winner or reason for the dialog', () => {
    expect(ok('/resolve M2', ctx(liveDispute))).toEqual({ kind: 'match', action: 'resolve', matchId: 'M2', winner: null, reason: null });
    expect(ok('/resolve M2 @Cy_Park', ctx(liveDispute))).toMatchObject({ winner: 'C', reason: null });
  });

  it('explains what is wrong', () => {
    expect(error('publish', ctx(publishable))).toMatch(/start with \//);
    expect(error('/launch', ctx(publishable))).toMatch(/Unknown command \/launch/);
    expect(error('/tcg-test', ctx(publishable))).toMatch(/Add a subcommand/);
    expect(error('/publish now', ctx(publishable))).toMatch(/takes no options/);
    expect(error('/resolve', ctx(liveDispute))).toMatch(/Name the match/);
    expect(error('/resolve M3 C x', ctx(liveDispute))).toMatch(/Unknown match "M3"/);
    expect(error('/resolve M2 A reason', ctx(liveDispute))).toMatch(/Seat A does not play in M2/);
    expect(error('/resolve M2 @Ava_Chen reason', ctx(liveDispute))).toMatch(/Ava Chen \(Seat A\) does not play in M2/);
    expect(error('/resolve M2 because it is late', ctx(liveDispute))).toMatch(/"because" is not a seat or a member/);
    expect(error(`/resolve M2 C ${'x'.repeat(501)}`, ctx(liveDispute))).toMatch(/500 characters \(it has 501\)/);
  });

  it('refuses an option given twice instead of letting the later one win', () => {
    expect(error('/resolve M1 A winner:B ruling', ctx(liveDispute))).toMatch(/The winner is given twice \("A" and "B"\)/);
    expect(error('/judge-resume M1 match:M2 ruling', ctx(liveDispute))).toMatch(/The match is given twice \("M1" and "M2"\)/);
    expect(error('/resolve match:M1 match:M2 A ruling', ctx(liveDispute))).toMatch(/match is given twice/);
    expect(error(`/signup-remove @Cy_Park member-id:${ben}`, ctx(signupOpen))).toMatch(/member is given twice/);
  });

  it('treats a reason of only whitespace or invisible format characters as missing', () => {
    expect(error('/resolve M2 C ​‍', ctx(liveDispute))).toMatch(/Enter a reason/);
    expect(error('/resolve M2 C reason:⁠', ctx(liveDispute))).toMatch(/Enter a reason/);
    expect(ok('/resolve M2 C ​ok', ctx(liveDispute))).toMatchObject({ reason: '​ok' });
  });

  it('follows adminActions and the capabilities', () => {
    expect(error('/publish', ctx(checkin))).toMatch(/not available right now. It needs all four check-ins/);
    expect(error('/correct M1 A x', ctx(liveDispute))).toMatch(/Correct result is not available for M1 right now \(it is running\)/);
    expect(error('/judge-resume M1 x', ctx(liveDispute))).toMatch(/not available for M1/);
    const judgeOnly = { commandsEnabled: true, capabilities: ['dashboard.read', 'match.judge'] as SessionDto['capabilities'] };
    expect(error('/correct M1 B x', ctx(final, judgeOnly))).toMatch(/cannot run \/correct/);
    expect(error('/refresh', ctx(final, judgeOnly))).toMatch(/cannot refresh/);
    expect(error('/resolve M2 C x', ctx(liveDispute, { commandsEnabled: false, capabilities: [...CAPABILITIES] }))).toMatch(/cannot run/);
  });

  it('refuses everything on a retired event', () => {
    const retired = { ...liveDispute, status: 'retired' as const };
    expect(error('/resolve M2 C x', ctx(retired))).toMatch(/history/);
    expect(error('/refresh', ctx(retired))).toMatch(/history/);
  });

  it('resolves signup members by mention, Discord mention or ID, only from the roster', () => {
    expect(ok('/signup-remove @Cy_Park', ctx(signupOpen))).toEqual({ kind: 'remove', memberId: cy });
    expect(ok(`/signup-remove member-id:${ben}`, ctx(signupOpen))).toEqual({ kind: 'remove', memberId: ben });
    expect(ok(`/signup-remove <@!${ava}>`, ctx(signupOpen))).toEqual({ kind: 'remove', memberId: ava });
    expect(error('/signup-remove @Organizer', ctx(signupOpen))).toMatch(/not in the signup roster/);
    expect(error('/signup-remove @Nobody', ctx(signupOpen))).toMatch(/No member called @Nobody/);
    expect(error('/signup-remove', ctx(signupOpen))).toMatch(/Name the member/);
    expect(error('/signup-remove @Cy_Park', ctx(checkin))).toMatch(/only while signup is open/);
  });
});

describe('mentions', () => {
  it('mentions members by name with underscores, falling back to the ID when ambiguous', () => {
    expect(mentionFor(liveDispute, cy)).toBe('@Cy_Park');
    const twins = { members: { ...liveDispute.members, x: { id: 'x', displayName: 'Cy  Park', avatarUrl: null } } };
    expect(mentionFor(twins, cy)).toBe(`@${cy}`);
    expect(mentionFor({ members: {} }, cy)).toBe(`@${cy}`);
    // Clashes are case-insensitive, as matching is.
    const cased = { members: { ...liveDispute.members, y: { id: 'y', displayName: 'cy park', avatarUrl: null } } };
    expect(mentionFor(cased, cy)).toBe(`@${cy}`);
    expect(mentionFor(cased, 'y')).toBe('@y');
    // An all-digit name would read as a member ID.
    const digits = { members: { ...liveDispute.members, [cy]: { id: cy, displayName: '1337', avatarUrl: null } } };
    expect(mentionFor(digits, cy)).toBe(`@${cy}`);
    expect(resolveMention(liveDispute, '@cy_park')).toEqual({ memberId: cy });
    expect(resolveMention(liveDispute, '@c')).toEqual({ seat: 'C' });
    expect(resolveMention(liveDispute, 'd')).toEqual({ seat: 'D' });
  });
});

describe('composer suggestions', () => {
  it('lists the commands available now, filtered by the typed prefix', () => {
    expect(labels('/', ctx(liveDispute))).toEqual(['/refresh', '/resolve', '/judge-resume']);
    expect(labels('/re', ctx(liveDispute))).toEqual(['/refresh', '/resolve', '/judge-resume']);
    expect(labels('/resu', ctx(liveDispute))).toEqual(['/judge-resume']);
    expect(labels('/j', ctx(liveDispute))).toEqual(['/judge-resume']);
    expect(labels('/', ctx(publishable))).toEqual(['/publish', '/signup-reopen', '/refresh']);
    expect(labels('/', ctx(signupOpen))).toEqual(['/signup-remove', '/refresh']);
    expect(labels('/', ctx(final))).toEqual(['/refresh', '/correct']);
    expect(labels('/', ctx({ ...liveDispute, status: 'retired' }))).toEqual([]);
    expect(labels('hello /', ctx(liveDispute))).toEqual([]);
  });

  it('suggests the matches the action applies to, then that match\'s seats', () => {
    expect(labels('/resolve ', ctx(liveDispute))).toEqual(['M1', 'M2']);
    expect(labels('/judge-resume ', ctx(liveDispute))).toEqual(['M2']);
    expect(labels('/resolve M2 ', ctx(liveDispute))).toEqual(['@C', '@D']);
    expect(labels('/resolve M2 @d', ctx(liveDispute))).toEqual(['@D']);
    expect(labels('/resolve M2 @Cy', ctx(liveDispute))).toEqual(['@C']);
    expect(labels('/resolve match:', ctx(liveDispute))).toEqual(['M1', 'M2']);
    expect(suggest('/resolve match:', 15, ctx(liveDispute))?.items[0]?.insertText).toBe('match:M1');
    // The reason is free text: no list.
    expect(labels('/resolve M2 C some', ctx(liveDispute))).toEqual([]);
    expect(labels('/publish ', ctx(publishable))).toEqual([]);
  });

  it('marks the current winner when correcting', () => {
    const list = suggest('/correct M2 ', 12, ctx(final));
    expect(list?.items.map(item => item.description)).toEqual(['Seat C · Cy Park', 'Seat D · Dee Ross · current winner']);
  });

  it('suggests roster members for signup-remove, with the replaced range', () => {
    expect(labels('/signup-remove ', ctx(signupOpen))).toEqual(['@Ava_Chen', '@Ben_Ortiz', '@Cy_Park']);
    const list = suggest('/signup-remove @b', 17, ctx(signupOpen));
    expect(list).toMatchObject({ heading: 'Members', start: 15, end: 17 });
    expect(list?.items.map(item => item.insertText)).toEqual(['@Ben_Ortiz']);
  });
});
