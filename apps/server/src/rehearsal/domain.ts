export const PLAYERS = ['A', 'B', 'C', 'D'] as const;
export type Player = typeof PLAYERS[number];
export const ADMIN = 'admin:fixture';
export const MATCH_IDS = ['M1', 'M2'] as const;
export type MatchId = typeof MATCH_IDS[number];
export type ActorId = string;

export class RuleError extends Error {}

export type Command =
  | { type: 'signupJoin' }
  | { type: 'signupWithdraw' }
  | { type: 'signupRemove'; memberId: string }
  | { type: 'signupClose'; adminId: string }
  | { type: 'signupReopen' }
  | { type: 'checkin' }
  | { type: 'publish' }
  | { type: 'ready'; matchId: MatchId }
  | { type: 'pause'; matchId: MatchId }
  | { type: 'callJudge'; matchId: MatchId }
  | { type: 'resumeConsent'; matchId: MatchId; pauseGeneration: number }
  | { type: 'judgeResume'; matchId: MatchId; reason: string }
  | { type: 'clockCheck'; matchId: MatchId }
  | { type: 'propose'; matchId: MatchId; winner: Player; expectedRevision: number }
  | { type: 'confirm'; matchId: MatchId; revision: number }
  | { type: 'dispute'; matchId: MatchId; revision: number }
  | { type: 'resolve'; matchId: MatchId; winner: Player; reason: string }
  | { type: 'correct'; matchId: MatchId; winner: Player; reason: string };

export interface Proposal {
  revision: number;
  winner: Player;
  reporter: Player;
  decision: 'open' | 'disputed';
}

export interface MatchState {
  id: MatchId;
  players: [Player, Player];
  mode: 'CAM';
  phase: 'setup' | 'running' | 'paused' | 'expired' | 'final';
  ready: Player[];
  remainingMs: number;
  startedAtMs: number | null;
  runnerId: string | null;
  pauseGeneration: number;
  resumeConsents: Player[];
  judgeAttention: boolean;
  proposal: Proposal | null;
  finalWinner: Player | null;
  confirmedBy?: Player;
}

export interface EventState {
  id: string;
  schemaVersion: 1 | 2;
  version: number;
  game: 'fixture_game';
  points: { win: number; loss: number };
  durationMs: number;
  checkins: Player[];
  published: boolean;
  matches: [MatchState, MatchState];
  signup?: { status: 'open' | 'assigned'; roster: string[]; assignment?: Record<Player, string> };
}

export interface Outcome {
  eventId: string;
  version: number;
  result: string;
  applied: boolean;
}

export interface Transition {
  state: EventState;
  outcome: Outcome;
}

export function createFixture(id: string, durationMs = 60_000): EventState {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new RuleError('Invalid fixture duration.');
  const match = (matchId: MatchId, players: [Player, Player]): MatchState => ({
    id: matchId, players, mode: 'CAM', phase: 'setup', ready: [], remainingMs: durationMs,
    startedAtMs: null, runnerId: null, pauseGeneration: 0, resumeConsents: [],
    judgeAttention: false, proposal: null, finalWinner: null
  });
  return {
    id, schemaVersion: 1, version: 0, game: 'fixture_game', points: { win: 3, loss: 0 }, durationMs,
    checkins: [], published: false,
    matches: [match('M1', ['A', 'B']), match('M2', ['C', 'D'])]
  };
}

export function createSignupFixture(id: string, durationMs = 60_000): EventState {
  return { ...createFixture(id, durationMs), schemaVersion: 2,
    signup: { status: 'open', roster: [] } };
}

function playerActor(actor: ActorId): Player | null {
  for (const player of PLAYERS) if (actor === `player:${player}`) return player;
  return null;
}

function requireAdmin(actor: ActorId): void {
  if (actor !== ADMIN) throw new RuleError('Fixture admin action denied.');
}

function requireParticipant(match: MatchState, actor: ActorId): Player {
  const player = playerActor(actor);
  if (!player || !match.players.includes(player)) throw new RuleError('Match participant action denied.');
  return player;
}

function requireReason(reason: string): void {
  if (typeof reason !== 'string' || !reason.trim()) throw new RuleError('A nonempty reason is required.');
}

function materialize(match: MatchState, nowMs: number, runnerId: string): void {
  if (match.phase !== 'running') return;
  // A new process must not infer whether a persisted running clock expired.
  if (match.runnerId !== runnerId) throw new RuleError('Running-clock continuation from another process is unsupported.');
  if (match.startedAtMs === null || nowMs < match.startedAtMs) throw new RuleError('Clock moved backward.');
  match.remainingMs = Math.max(0, match.remainingMs - (nowMs - match.startedAtMs));
  if (match.remainingMs === 0) {
    match.phase = 'expired';
    match.startedAtMs = null;
    match.runnerId = null;
    match.judgeAttention = true;
  } else {
    match.startedAtMs = nowMs;
  }
}

function start(match: MatchState, nowMs: number, runnerId: string): void {
  match.phase = 'running';
  match.startedAtMs = nowMs;
  match.runnerId = runnerId;
  match.resumeConsents = [];
}

export function transition(current: EventState, actor: ActorId, command: Command, nowMs: number, runnerId: string): Transition {
  if (!Number.isSafeInteger(nowMs) || !runnerId) throw new RuleError('Invalid rehearsal clock or runner.');
  const state = structuredClone(current);
  let result = command.type as string;
  if (command.type === 'signupJoin' || command.type === 'signupWithdraw' ||
      command.type === 'signupRemove' || command.type === 'signupClose' || command.type === 'signupReopen') {
    const signup = state.signup;
    if (!signup) throw new RuleError('Signup action requires a signup session.');
    const noChange = (result: string): Transition => ({ state: current,
      outcome: { eventId: current.id, version: current.version, result, applied: false } });
    if (command.type === 'signupJoin' || command.type === 'signupWithdraw') {
      if (signup.status !== 'open') throw new RuleError('Signup is closed.');
      if (!/^member:[1-9]\d{14,21}$/.test(actor)) throw new RuleError('Signup member action denied.');
      const memberId = actor.slice(7);
      const index = signup.roster.indexOf(memberId);
      if (command.type === 'signupJoin') {
        if (index !== -1) return noChange('already_joined');
        if (signup.roster.length === 4) throw new RuleError('Signup is full.');
        signup.roster.push(memberId);
      } else {
        if (index === -1) return noChange('not_joined');
        signup.roster.splice(index, 1);
      }
    } else if (command.type === 'signupRemove') {
      requireAdmin(actor);
      if (signup.status !== 'open') throw new RuleError('Signup is closed.');
      if (!/^[1-9]\d{14,21}$/.test(command.memberId)) throw new RuleError('Invalid signup member ID.');
      const index = signup.roster.indexOf(command.memberId);
      if (index === -1) return noChange('not_joined');
      signup.roster.splice(index, 1);
    } else if (command.type === 'signupClose') {
      requireAdmin(actor);
      if (signup.status !== 'open' || signup.roster.length !== 4 ||
          new Set(signup.roster).size !== 4 || signup.roster.includes(command.adminId))
        throw new RuleError('Signup close requires four distinct nonadmin members.');
      signup.assignment = Object.fromEntries(PLAYERS.map((player, index) => [player, signup.roster[index]])) as Record<Player, string>;
      signup.status = 'assigned';
      result = `signupClose:${JSON.stringify(signup.assignment)}`;
    } else if (command.type === 'signupReopen') {
      requireAdmin(actor);
      if (signup.status !== 'assigned' || state.published ||
          state.matches.some(match => match.phase !== 'setup'))
        throw new RuleError('Signup reopen is unavailable after publication.');
      signup.status = 'open';
      delete signup.assignment;
      state.checkins = [];
    }
  } else if (command.type === 'checkin') {
    if (state.signup?.status !== undefined && state.signup.status !== 'assigned') throw new RuleError('Signup is still open.');
    const player = playerActor(actor);
    if (!player) throw new RuleError('Fixture player action denied.');
    if (state.checkins.includes(player)) {
      return { state: current, outcome: { eventId: current.id, version: current.version, result: 'already_checked_in', applied: false } };
    }
    if (state.published) throw new RuleError('Check-in is closed.');
    state.checkins.push(player);
    state.checkins.sort((a, b) => PLAYERS.indexOf(a) - PLAYERS.indexOf(b));
  } else if (command.type === 'publish') {
    requireAdmin(actor);
    if (state.signup && state.signup.status !== 'assigned') throw new RuleError('Signup is still open.');
    if (state.published || state.checkins.length !== 4) throw new RuleError('Fixture round requires four check-ins and one publication.');
    state.published = true;
  } else {
    if (!state.published) throw new RuleError('Fixture round is not published.');
    const match = state.matches.find(item => item.id === command.matchId);
    if (!match) throw new RuleError('Unknown fixture match.');
    // Ownership must be checked before elapsed time, including at exact expiry.
    if (match.phase === 'running' && match.runnerId !== runnerId) {
      throw new RuleError('Running-clock continuation from another process is unsupported.');
    }
    const wasRunning = match.phase === 'running';
    materialize(match, nowMs, runnerId);
    switch (command.type) {
      case 'ready': {
        const player = requireParticipant(match, actor);
        if (match.phase !== 'setup' || match.ready.includes(player)) throw new RuleError('Ready transition is unavailable.');
        match.ready.push(player);
        if (match.ready.length === 2) start(match, nowMs, runnerId);
        break;
      }
      case 'pause': {
        requireParticipant(match, actor);
        if (match.phase !== 'running') throw new RuleError('Pause is unavailable.');
        match.phase = 'paused';
        match.startedAtMs = null;
        match.runnerId = null;
        match.pauseGeneration += 1;
        match.resumeConsents = [];
        break;
      }
      case 'callJudge': {
        requireParticipant(match, actor);
        if (match.phase === 'final') throw new RuleError('Judge call is unavailable.');
        if (current.matches.find(item => item.id === match.id)?.judgeAttention) {
          return { state: current, outcome: { eventId: current.id, version: current.version, result: 'judge_already_called', applied: false } };
        }
        match.judgeAttention = true;
        break;
      }
      case 'resumeConsent': {
        const player = requireParticipant(match, actor);
        if (command.pauseGeneration !== match.pauseGeneration) throw new RuleError('Stale pause generation.');
        if (match.phase !== 'paused' || match.resumeConsents.includes(player)) throw new RuleError('Resume consent is unavailable.');
        match.resumeConsents.push(player);
        if (match.resumeConsents.length === 2) start(match, nowMs, runnerId);
        break;
      }
      case 'judgeResume': {
        requireAdmin(actor);
        requireReason(command.reason);
        if (match.phase !== 'paused') throw new RuleError('Judge resume is unavailable.');
        start(match, nowMs, runnerId);
        break;
      }
      case 'clockCheck': {
        requireAdmin(actor);
        if (!wasRunning) throw new RuleError('Clock check is unavailable.');
        break;
      }
      case 'propose': {
        const player = requireParticipant(match, actor);
        if (!match.players.includes(command.winner) || match.phase === 'setup' || match.phase === 'final') {
          throw new RuleError('Result proposal is unavailable.');
        }
        const revision = match.proposal?.revision ?? 0;
        if (command.expectedRevision !== revision) throw new RuleError('Stale proposal revision.');
        match.proposal = { revision: revision + 1, winner: command.winner, reporter: player, decision: 'open' };
        delete match.confirmedBy;
        break;
      }
      case 'confirm':
      case 'dispute': {
        const player = requireParticipant(match, actor);
        const proposal = match.proposal;
        if (match.phase === 'final' || !proposal || proposal.revision !== command.revision ||
            (command.type === 'dispute' && proposal.decision !== 'open')) {
          throw new RuleError('Stale proposal revision.');
        }
        if (proposal.reporter === player) throw new RuleError('Reporter cannot decide their own proposal.');
        if (command.type === 'confirm') {
          match.finalWinner = proposal.winner;
          match.confirmedBy = player;
          match.phase = 'final';
          match.startedAtMs = null;
          match.runnerId = null;
          match.judgeAttention = false;
        } else {
          proposal.decision = 'disputed';
          match.judgeAttention = true;
        }
        break;
      }
      case 'resolve': {
        requireAdmin(actor);
        requireReason(command.reason);
        if (!match.players.includes(command.winner) || match.phase === 'setup' || match.phase === 'final') {
          throw new RuleError('Admin resolution is unavailable.');
        }
        match.finalWinner = command.winner;
        delete match.confirmedBy;
        match.phase = 'final';
        match.startedAtMs = null;
        match.runnerId = null;
        match.judgeAttention = false;
        break;
      }
      case 'correct': {
        requireAdmin(actor);
        requireReason(command.reason);
        if (match.phase !== 'final' || !match.players.includes(command.winner) || match.finalWinner === command.winner) {
          throw new RuleError('Result correction is unavailable.');
        }
        match.finalWinner = command.winner;
        delete match.confirmedBy;
        match.judgeAttention = false;
        break;
      }
    }
  }
  state.version += 1;
  return { state, outcome: { eventId: state.id, version: state.version, result, applied: true } };
}

export function deriveFixture(state: EventState): Array<{ player: Player; points: number; rating: number }> {
  const points = Object.fromEntries(PLAYERS.map(player => [player, 0])) as Record<Player, number>;
  const ratings = Object.fromEntries(PLAYERS.map(player => [player, 1200])) as Record<Player, number>;
  for (const match of state.matches) {
    const winner = match.finalWinner;
    if (!winner) continue;
    const loser = match.players.find(player => player !== winner)!;
    points[winner] += state.points.win;
    points[loser] += state.points.loss;
    const expected = 1 / (1 + Math.pow(10, (ratings[loser] - ratings[winner]) / 400));
    const delta = 32 * (1 - expected);
    ratings[winner] += delta;
    ratings[loser] -= delta;
  }
  return PLAYERS.map(player => ({ player, points: points[player], rating: ratings[player] }));
}
