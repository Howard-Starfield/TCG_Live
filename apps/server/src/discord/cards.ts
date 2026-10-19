import { RuleError, type EventState, type MatchId, type MatchState, type Player } from '../rehearsal/domain.js';
import type { CardSlot } from './session.js';
import { visualThumbnail, type VisualState } from './visuals.js';

export interface CardPayload {
  embeds: Array<{ title: string; description: string; color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>; thumbnail?: { url: string } }>;
  components: Array<{ type: 1; components: Array<{ type: 2; style: number; label: string; custom_id: string; disabled?: boolean }> }>;
  allowedMentions: { parse: [] };
}

export type ButtonAction = 'checkin' | 'signupJoin' | 'signupWithdraw' | 'ready' | 'pause' | 'resume' | 'won' | 'lost' | 'confirm' | 'dispute' | 'judge';
export interface ParsedButton {
  eventId: string;
  slot: CardSlot;
  action: ButtonAction;
  revision?: number;
}

const codes: Record<ButtonAction, string> = {
  checkin: 'C', signupJoin: 'sj', signupWithdraw: 'sw', ready: 'R', pause: 'P', resume: 'S', won: 'W', lost: 'L',
  confirm: 'F', dispute: 'D', judge: 'J'
};
const actions = Object.fromEntries(Object.entries(codes).map(([action, code]) => [code, action])) as Record<string, ButtonAction>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buttonId(eventId: string, slot: CardSlot, action: ButtonAction, revision?: number): string {
  const id = `p1:${eventId}:${slot}:${codes[action]}${revision === undefined ? '' : `:${revision}`}`;
  if (id.length > 100) throw new RuleError('Discord control ID is too long.');
  return id;
}

export function parseButtonId(raw: string): ParsedButton {
  if (!raw || raw.length > 100) throw new RuleError('Invalid private Discord control.');
  const parts = raw.split(':');
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== 'p1' || !parts[1] || !UUID.test(parts[1]) ||
      !['checkin', 'M1', 'M2'].includes(parts[2] ?? '') || !parts[3] || !actions[parts[3]]) {
    throw new RuleError('Invalid private Discord control.');
  }
  const slot = parts[2] as CardSlot;
  const action = actions[parts[3]]!;
  if ((slot === 'checkin') !== ['checkin', 'signupJoin', 'signupWithdraw'].includes(action)) throw new RuleError('Invalid private Discord control.');
  const needsRevision = ['resume', 'won', 'lost', 'confirm', 'dispute'].includes(action);
  if ((parts.length === 5) !== needsRevision ||
      (needsRevision && (!/^(0|[1-9]\d*)$/.test(parts[4] ?? '') || !Number.isSafeInteger(Number(parts[4]))))) {
    throw new RuleError('Invalid private Discord control.');
  }
  return { eventId: parts[1], slot, action, ...(needsRevision ? { revision: Number(parts[4]) } : {}) };
}

function row(buttons: Array<{ label: string; action: ButtonAction; revision?: number; disabled?: boolean }>, eventId: string, slot: CardSlot) {
  return { type: 1 as const, components: buttons.map(button => ({
    type: 2 as const, style: ['dispute', 'judge'].includes(button.action) ? 4 :
      ['confirm', 'resume'].includes(button.action) ? 3 : 2, label: button.label,
    custom_id: buttonId(eventId, slot, button.action, button.revision),
    ...(button.disabled ? { disabled: true } : {})
  })) };
}

function matchCard(state: EventState, match: MatchState, runnerId?: string,
  players?: Record<Player, string>): CardPayload {
  const slot = match.id;
  const interrupted = match.phase === 'running' && !!runnerId && match.runnerId !== runnerId;
  const visual: VisualState = match.phase === 'final' ? 'final' : interrupted ? 'error' :
    match.proposal?.decision === 'disputed' ? 'disputed' : match.proposal ? 'proposal' :
      match.phase === 'expired' ? 'expired' : match.phase === 'paused' ? 'paused' :
        match.phase === 'running' ? 'running' : 'setup';
  const runningDeadline = match.phase === 'running' && match.startedAtMs !== null
    ? `<t:${Math.ceil((match.startedAtMs + match.remainingMs) / 1_000)}:R>` : null;
  const time = runningDeadline ? `Deadline ${runningDeadline}` :
    `Remaining ${Math.ceil(match.remainingMs / 1_000)} seconds (frozen)`;
  const mention = (player: Player) => players?.[player] ? `<@${players[player]}>` : player;
  const awaitingSignup = !!state.signup && state.signup.status === 'open';
  const waiting = match.phase === 'paused' ? match.players.filter(player => !match.resumeConsents.includes(player)) : [];
  const waitingText = waiting.map(mention).join(', ');
  const proposalOpponent = match.proposal ? match.players.find(player => player !== match.proposal!.reporter)! : null;
  const finalText = match.finalWinner ?
    `Finished — ${match.finalWinner} wins${players?.[match.finalWinner] ? ` (${mention(match.finalWinner)})` : ''}` :
    'Finished';
  const details = match.phase === 'final' ? [
    `Practice BO1 CAM · ${match.players.map(mention).join(' vs ')}`, finalText,
    match.confirmedBy ? `Agreed by ${mention(match.confirmedBy)}` : ''
  ].filter(Boolean).join('\n') : [
    awaitingSignup ? 'Awaiting signup; players will be assigned on close' : `Practice BO1 CAM · ${match.players.map(mention).join(' vs ')}`,
    `State: ${interrupted ? 'interrupted; local prepare --replace required' : match.phase}`,
    `Ready: ${match.ready.map(mention).join(', ') || 'none'}`,
    match.phase === 'setup' ? '' : time,
    match.proposal ? `Proposal #${match.proposal.revision}: ${mention(match.proposal.reporter)} reports ${mention(match.proposal.winner)} won (${match.proposal.decision})` : '',
    match.proposal && proposalOpponent ? match.proposal.decision === 'open' ?
      `Waiting for ${mention(proposalOpponent)} to Agree or Dispute` :
      `Disputed by ${mention(proposalOpponent)}; judge needed` : '',
    match.phase === 'paused' ? `Resume agreed: ${match.resumeConsents.map(mention).join(', ') || 'none'}` : '',
    waiting.length ? `Waiting to resume: ${waitingText}` : '',
    match.judgeAttention ? 'Judge needed' : '',
    match.phase === 'expired' ? 'Clock expired; a judge must resolve the match. Pause and resume are unavailable.' : ''
  ].filter(Boolean).join('\n');
  const buttons: Array<{ label: string; action: ButtonAction; revision?: number; disabled?: boolean }> = [];
  if (interrupted) buttons.push({ label: 'Interrupted', action: 'ready', disabled: true });
  else if (!state.published) buttons.push({ label: awaitingSignup ? 'Awaiting signup' : 'Awaiting round', action: 'ready', disabled: true });
  else if (match.phase === 'setup') buttons.push({ label: 'Ready', action: 'ready' });
  else if (match.phase !== 'final') {
    buttons.push({ label: '🟠 Pause', action: 'pause', disabled: match.phase !== 'running' });
    buttons.push({ label: 'Resume', action: 'resume', revision: match.pauseGeneration,
      disabled: match.phase !== 'paused' });
    const revision = match.proposal?.revision ?? 0;
    buttons.push({ label: 'I won', action: 'won', revision,
      disabled: match.proposal?.decision === 'open' });
    if (match.proposal) buttons.push(
      { label: 'Agree', action: 'confirm', revision },
      { label: 'Dispute', action: 'dispute', revision, disabled: match.proposal.decision !== 'open' }
    );
    buttons.push({ label: 'Call judge', action: 'judge' });
  }
  return {
    embeds: [{ title: `Practice match ${slot}`, description: details,
      color: match.phase === 'final' ? 0x22c55e : match.phase === 'paused' ? 0xef4444 : 0xf59e0b,
      thumbnail: visualThumbnail(visual) }],
    components: buttons.length ? [row(buttons.slice(0, 5), state.id, slot), ...(buttons.length > 5 ? [row(buttons.slice(5), state.id, slot)] : [])] : [],
    allowedMentions: { parse: [] }
  };
}

export function renderCard(state: EventState, slot: CardSlot, runnerId?: string,
  players?: Record<Player, string>): CardPayload {
  if (slot !== 'checkin') {
    const match = state.matches.find(item => item.id === slot as MatchId)!;
    return matchCard(state, match, runnerId, players);
  }
  if (state.signup) {
    const signup = state.signup;
    const roster = signup.roster.map(id => `<@${id}>`).join(', ') || 'none';
    const assigned = signup.status === 'assigned';
    return { embeds: [{ title: 'Practice signup and check-in',
      description: `Signup: ${assigned ? 'closed' : 'open'} · ${signup.roster.length}/4 joined\nRoster: ${roster}\n` +
        (assigned ? `Assigned: ${(['A', 'B', 'C', 'D'] as const).map(player =>
          `${player} <@${signup.assignment![player]}>`).join(', ')}\nChecked in: ${state.checkins.map(player => `<@${players?.[player] ?? signup.assignment?.[player]}>`).join(', ') || 'none'}\n${state.published ? 'Round published' : 'Check in to publish the round'}` :
          'Join or Withdraw before the admin closes signup.'), color: 0xf59e0b,
      thumbnail: visualThumbnail(!assigned ? 'signup' : state.published ? 'notice' : 'checkin') }],
      components: state.published ? [] : assigned ? [row([{ label: 'Check in', action: 'checkin' }], state.id, slot)] :
        [row([{ label: 'Join', action: 'signupJoin' }, { label: 'Withdraw', action: 'signupWithdraw' }], state.id, slot)],
      allowedMentions: { parse: [] } };
  }
  return {
    embeds: [{
      title: 'Practice check-in',
      description: `Four-player private rehearsal · ${state.checkins.length}/4 checked in\nChecked in: ${state.checkins.map(player => players?.[player] ? `<@${players[player]}>` : player).join(', ') || 'none'}\n${state.published ? 'Round published' : 'Setup has no deadline'}`,
      color: 0xf59e0b,
      thumbnail: visualThumbnail(state.published ? 'notice' : 'checkin')
    }],
    components: state.published ? [] : [row([{ label: 'Check in', action: 'checkin' }], state.id, slot)],
    allowedMentions: { parse: [] }
  };
}
