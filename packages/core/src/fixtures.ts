// Hand-written contract fixtures for web development, galleries, and tests.
// L2 checks these against real mapper output; keep them consistent with domain.ts rules.
import type { AuditEntryDto, EventSnapshotDto, MatchDto, MemberDto, RuntimeStatusDto,
  SessionDto, Snowflake } from './admin-contract.js';

export const FIXTURE_NOW_MS = 1_792_396_800_000;
export const FIXTURE_EVENT_ID = 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
export const FIXTURE_BOOT_ID = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';
export const FIXTURE_ADMIN_ID: Snowflake = '900000000000000001';
export const FIXTURE_MEMBER_IDS = ['900000000000000011', '900000000000000012',
  '900000000000000013', '900000000000000014'] as const;
const [ava, ben, cy, dee] = FIXTURE_MEMBER_IDS;
const DURATION_MS = 50 * 60_000;
const CREATED_AT_MS = FIXTURE_NOW_MS - 45 * 60_000;

const members: Record<Snowflake, MemberDto> = {
  [FIXTURE_ADMIN_ID]: { id: FIXTURE_ADMIN_ID, displayName: 'Organizer', avatarUrl: null },
  [ava]: { id: ava, displayName: 'Ava Chen', avatarUrl: null },
  [ben]: { id: ben, displayName: 'Ben Ortiz', avatarUrl: null },
  [cy]: { id: cy, displayName: 'Cy Park', avatarUrl: null },
  [dee]: { id: dee, displayName: 'Dee Ross', avatarUrl: null }
};

function setupMatch(id: 'M1' | 'M2'): MatchDto {
  return {
    id, seats: id === 'M1' ? ['A', 'B'] : ['C', 'D'], mode: 'CAM', phase: 'setup', ready: [],
    clock: { durationMs: DURATION_MS, remainingMs: DURATION_MS, runningSinceMs: null, state: 'frozen' },
    pauseGeneration: 0, resumeConsents: [], judge: null, proposal: null,
    finalWinner: null, finalSource: null, confirmedBy: null, adminActions: []
  };
}

function base(version: number): EventSnapshotDto {
  return {
    eventId: FIXTURE_EVENT_ID, version, panelRevision: 0, status: 'active', kind: 'signup',
    createdAtMs: CREATED_AT_MS, retiredAtMs: null,
    game: 'fixture_game', durationMs: DURATION_MS, points: { win: 3, loss: 0 },
    stage: 'signup',
    signup: { status: 'open', capacity: 4, roster: [] },
    seats: { A: null, B: null, C: null, D: null },
    adminId: FIXTURE_ADMIN_ID,
    members: { [FIXTURE_ADMIN_ID]: members[FIXTURE_ADMIN_ID]! },
    checkins: [], published: false,
    matches: [setupMatch('M1'), setupMatch('M2')],
    standings: [
      { seat: 'A', points: 0, rating: 1200 }, { seat: 'B', points: 0, rating: 1200 },
      { seat: 'C', points: 0, rating: 1200 }, { seat: 'D', points: 0, rating: 1200 }
    ],
    adminActions: [],
    discord: {
      guildId: '900000000000000100', channelId: '900000000000000101',
      matchChannels: { M1: '900000000000000102', M2: '900000000000000103' }, publicMatchRooms: false,
      cards: {
        checkin: { messageId: '900000000000000201', repostSuspended: false },
        M1: { messageId: null, repostSuspended: false },
        M2: { messageId: null, repostSuspended: false }
      }
    }
  };
}

const assigned = { A: ava, B: ben, C: cy, D: dee };

/** Signup open with three of four members joined. */
export const signupOpen: EventSnapshotDto = {
  ...base(3),
  signup: { status: 'open', capacity: 4, roster: [ava, ben, cy] },
  members: { [FIXTURE_ADMIN_ID]: members[FIXTURE_ADMIN_ID]!, [ava]: members[ava]!, [ben]: members[ben]!, [cy]: members[cy]! },
  adminActions: ['signupRemove']
};

/** Signup closed and seats assigned; three of four players checked in. */
export const checkin: EventSnapshotDto = {
  ...base(8),
  stage: 'checkin',
  signup: { status: 'assigned', capacity: 4, roster: [ava, ben, cy, dee] },
  seats: assigned, members,
  checkins: ['A', 'B', 'C'],
  adminActions: ['signupReopen']
};

/** Round live: M1 running, M2 paused with a disputed proposal awaiting a judge. */
export const liveDispute: EventSnapshotDto = {
  ...base(17),
  panelRevision: 2,
  stage: 'live',
  signup: { status: 'assigned', capacity: 4, roster: [ava, ben, cy, dee] },
  seats: assigned, members,
  checkins: ['A', 'B', 'C', 'D'], published: true,
  matches: [
    { ...setupMatch('M1'), phase: 'running', ready: ['A', 'B'],
      clock: { durationMs: DURATION_MS, remainingMs: DURATION_MS, runningSinceMs: CREATED_AT_MS + 540_000, state: 'running' },
      adminActions: ['resolve'] },
    { ...setupMatch('M2'), phase: 'paused', ready: ['C', 'D'], pauseGeneration: 1,
      clock: { durationMs: DURATION_MS, remainingMs: 1_345_000, runningSinceMs: null, state: 'frozen' },
      judge: { reasons: ['dispute'], sinceMs: FIXTURE_NOW_MS - 90_000, raisedBy: ['D'] },
      proposal: { revision: 1, winner: 'C', reporter: 'C', decision: 'disputed' },
      adminActions: ['resolve', 'judgeResume'] }
  ],
  discord: { ...base(0).discord, cards: {
    checkin: { messageId: '900000000000000201', repostSuspended: false },
    M1: { messageId: '900000000000000202', repostSuspended: false },
    M2: { messageId: '900000000000000203', repostSuspended: false }
  } }
};

/** M1's persisted running clock belongs to another process (shown frozen, labelled interrupted). */
export const liveInterrupted: EventSnapshotDto = {
  ...liveDispute,
  matches: [
    { ...liveDispute.matches[0]!,
      clock: { ...liveDispute.matches[0]!.clock, state: 'interrupted' }, adminActions: [] },
    // domain.ts and store.ts refuse every command while a running clock is interrupted.
    { ...liveDispute.matches[1]!, adminActions: [] }
  ]
};

/** Both matches final: M1 agreed by the opponent, M2 resolved by the admin. */
export const final: EventSnapshotDto = {
  ...liveDispute,
  version: 20,
  stage: 'complete',
  matches: [
    { ...liveDispute.matches[0]!, phase: 'final',
      clock: { durationMs: DURATION_MS, remainingMs: 12 * 60_000 + 5_000, runningSinceMs: null, state: 'frozen' },
      proposal: { revision: 1, winner: 'A', reporter: 'A', decision: 'open' },
      finalWinner: 'A', finalSource: 'agreed', confirmedBy: 'B', adminActions: ['correct'] },
    { ...liveDispute.matches[1]!, phase: 'final', judge: null,
      finalWinner: 'D', finalSource: 'admin', confirmedBy: null, adminActions: ['correct'] }
  ],
  standings: [
    { seat: 'A', points: 3, rating: 1216 }, { seat: 'B', points: 0, rating: 1184 },
    { seat: 'C', points: 0, rating: 1184 }, { seat: 'D', points: 3, rating: 1216 }
  ]
};

export const snapshots = { signupOpen, checkin, liveDispute, liveInterrupted, final } as const;
export type SnapshotFixtureName = keyof typeof snapshots;

let sequence = 0;
function entry(offsetMs: number, partial: Omit<AuditEntryDto, 'sequence' | 'occurredAtMs' | 'commandId' | 'mode'>
  & { mode?: AuditEntryDto['mode'] }): AuditEntryDto {
  sequence += 1;
  const via = partial.via;
  return {
    sequence, occurredAtMs: CREATED_AT_MS + offsetMs,
    commandId: via === 'web' ? `web:00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
      : via === 'system' ? `timer:M2:1:${CREATED_AT_MS + offsetMs}` : `interaction:${1300000000000000000n + BigInt(sequence)}`,
    mode: partial.mode ?? (partial.command.matchId ? 'CAM' : null),
    ...partial
  };
}

/** An applied-command timeline ending at the liveDispute snapshot (version 17), then on to final. */
export const auditTimeline: AuditEntryDto[] = [
  entry(60_000, { actor: { kind: 'member', memberId: ava }, via: 'discord', principalId: ava, command: { type: 'signupJoin' }, result: 'signupJoin' }),
  entry(95_000, { actor: { kind: 'member', memberId: ben }, via: 'discord', principalId: ben, command: { type: 'signupJoin' }, result: 'signupJoin' }),
  entry(130_000, { actor: { kind: 'member', memberId: cy }, via: 'discord', principalId: cy, command: { type: 'signupJoin' }, result: 'signupJoin' }),
  entry(170_000, { actor: { kind: 'member', memberId: dee }, via: 'discord', principalId: dee, command: { type: 'signupJoin' }, result: 'signupJoin' }),
  entry(240_000, { actor: { kind: 'admin' }, via: 'discord', principalId: FIXTURE_ADMIN_ID, command: { type: 'signupClose' },
    result: `signupClose:${JSON.stringify(assigned)}` }),
  entry(300_000, { actor: { kind: 'player', seat: 'A' }, via: 'discord', principalId: ava, command: { type: 'checkin' }, result: 'checkin' }),
  entry(320_000, { actor: { kind: 'player', seat: 'B' }, via: 'discord', principalId: ben, command: { type: 'checkin' }, result: 'checkin' }),
  entry(350_000, { actor: { kind: 'player', seat: 'C' }, via: 'discord', principalId: cy, command: { type: 'checkin' }, result: 'checkin' }),
  entry(400_000, { actor: { kind: 'player', seat: 'D' }, via: 'discord', principalId: dee, command: { type: 'checkin' }, result: 'checkin' }),
  entry(460_000, { actor: { kind: 'admin' }, via: 'web', principalId: 'local-admin', command: { type: 'publish' }, result: 'publish' }),
  entry(520_000, { actor: { kind: 'player', seat: 'A' }, via: 'discord', principalId: ava, command: { type: 'ready', matchId: 'M1' }, result: 'ready' }),
  entry(540_000, { actor: { kind: 'player', seat: 'B' }, via: 'discord', principalId: ben, command: { type: 'ready', matchId: 'M1' }, result: 'ready' }),
  entry(560_000, { actor: { kind: 'player', seat: 'C' }, via: 'discord', principalId: cy, command: { type: 'ready', matchId: 'M2' }, result: 'ready' }),
  entry(575_000, { actor: { kind: 'player', seat: 'D' }, via: 'discord', principalId: dee, command: { type: 'ready', matchId: 'M2' }, result: 'ready' }),
  entry(2_200_000, { actor: { kind: 'player', seat: 'C' }, via: 'discord', principalId: cy,
    command: { type: 'propose', matchId: 'M2', winner: 'C', expectedRevision: 0 }, result: 'propose' }),
  entry(2_230_000, { actor: { kind: 'player', seat: 'D' }, via: 'discord', principalId: dee,
    command: { type: 'pause', matchId: 'M2' }, result: 'pause' }),
  entry(2_610_000, { actor: { kind: 'player', seat: 'D' }, via: 'discord', principalId: dee,
    command: { type: 'dispute', matchId: 'M2', revision: 1 }, result: 'dispute' })
];
