import { RuleError, type EventState, type MatchId, type MatchState, type Player } from '../rehearsal/domain.js';
import type { CardSlot } from './session.js';
import { visualBanner, visualThumbnail, type VisualState } from './visuals.js';
import type { TournamentDetailsDto } from '@tcg-live/core';

const gameLabels = { pokemon: 'Pokémon', 'one-piece': 'One Piece', 'one-punch-man': 'One Punch Man' };
const literal = (value: string) => value.replace(/([\\`*_~|<>\[\]#])/g, '\\$1');

export interface CardPayload {
  embeds: Array<{ title: string; description: string; color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>; thumbnail?: { url: string }; image?: { url: string } }>;
  components: Array<{ type: 1; components: Array<{ type: 2; style: number; label: string; custom_id: string; disabled?: boolean }> }>;
  allowedMentions: { parse: [] };
}

export type ButtonAction = 'checkin' | 'signupJoin' | 'signupWithdraw' | 'signupRoster' | 'ready' | 'pause' | 'resume' | 'won' | 'lost' | 'confirm' | 'dispute' | 'judge' | 'evidence';

/** Evidence stays open this long after a match's final result (players may still send a clip). */
export const EVIDENCE_WINDOW_MS = 24 * 3_600_000;

/** Runtime extras for card rendering; every field is optional so pure callers keep the old output. */
export interface CardOptions {
  /** Match IDs whose voice room is being recorded now ("🔴 Audio recording active"). */
  recording?: ReadonlySet<string>;
  /** The recording policy line for the signup card; null/absent when recording mode is off. */
  recordingNotice?: string | null;
  /** Current time, for the evidence window; Date.now() when absent. */
  nowMs?: number;
}

/** "Submit evidence" is offered while a judge is needed or a dispute is open, and for 24 h after the result. */
export function evidenceWindowOpen(match: MatchState, nowMs: number): boolean {
  if (match.judgeAttention || match.proposal?.decision === 'disputed' || match.phase === 'expired') return true;
  return match.phase === 'final' && (match.finalAtMs === undefined || nowMs - match.finalAtMs <= EVIDENCE_WINDOW_MS);
}
export interface ParsedButton {
  eventId: string;
  slot: CardSlot;
  action: ButtonAction;
  revision?: number;
}

const codes: Record<ButtonAction, string> = {
  checkin: 'C', signupJoin: 'sj', signupWithdraw: 'sw', signupRoster: 'sr', ready: 'R', pause: 'P', resume: 'S', won: 'W', lost: 'L',
  confirm: 'F', dispute: 'D', judge: 'J', evidence: 'E'
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
      (parts[2] !== 'checkin' && !/^M[1-9]\d*$/.test(parts[2] ?? '')) || !parts[3] || !actions[parts[3]]) {
    throw new RuleError('Invalid private Discord control.');
  }
  const slot = parts[2] as CardSlot;
  const action = actions[parts[3]]!;
  if ((slot === 'checkin') !== ['checkin', 'signupJoin', 'signupWithdraw', 'signupRoster'].includes(action)) throw new RuleError('Invalid private Discord control.');
  const needsRevision = ['resume', 'won', 'lost', 'confirm', 'dispute'].includes(action);
  if ((parts.length === 5) !== needsRevision ||
      (needsRevision && (!/^(0|[1-9]\d*)$/.test(parts[4] ?? '') || !Number.isSafeInteger(Number(parts[4]))))) {
    throw new RuleError('Invalid private Discord control.');
  }
  return { eventId: parts[1], slot, action, ...(needsRevision ? { revision: Number(parts[4]) } : {}) };
}

function row(buttons: Array<{ label: string; action: ButtonAction; revision?: number; disabled?: boolean }>, eventId: string, slot: CardSlot) {
  return { type: 1 as const, components: buttons.map(button => ({
    type: 2 as const, style: ['dispute', 'judge'].includes(button.action) ? 4 : button.action === 'evidence' ? 1 :
      ['confirm', 'resume'].includes(button.action) ? 3 : 2, label: button.label,
    custom_id: buttonId(eventId, slot, button.action, button.revision),
    ...(button.disabled ? { disabled: true } : {})
  })) };
}

function matchCard(state: EventState, match: MatchState, runnerId?: string,
  players?: Record<Player, string>, options: CardOptions = {}): CardPayload {
  const recordingLine = options.recording?.has(match.id) ? '🔴 Audio recording active' : '';
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
    match.confirmedBy ? `Agreed by ${mention(match.confirmedBy)}` : '', recordingLine
  ].filter(Boolean).join('\n') : [
    recordingLine,
    awaitingSignup ? 'Awaiting signup; players will be assigned on close' : `Practice BO1 CAM · ${match.players.map(mention).join(' vs ')}`,
    `State: ${interrupted ? 'interrupted; local prepare --replace required' : match.phase}`,
    !state.published && state.startsAtMs !== undefined
      ? `Scheduled start: <t:${Math.floor(state.startsAtMs / 1000)}:F>` : '',
    `Ready: ${match.ready.map(mention).join(', ') || 'none'}`,
    match.phase === 'setup' ? '' : time,
    match.proposal ? `Proposal #${match.proposal.revision}: ${mention(match.proposal.reporter)} reports ${mention(match.proposal.winner)} won (${match.proposal.decision})` : '',
    match.proposal && proposalOpponent ? match.proposal.decision === 'open' ?
      `Waiting for ${mention(proposalOpponent)} to Agree or Disagree` :
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
    if (match.proposal?.decision === 'open') {
      buttons.push({ label: 'Agree', action: 'confirm', revision }, { label: 'Disagree', action: 'dispute', revision });
    } else {
      buttons.push({ label: 'I won', action: 'won', revision });
      if (match.proposal) buttons.push({ label: 'Agree', action: 'confirm', revision });
    }
    buttons.push({ label: 'Call judge', action: 'judge' });
  }
  if (!interrupted && state.published && evidenceWindowOpen(match, options.nowMs ?? Date.now()))
    buttons.push({ label: 'Submit evidence', action: 'evidence' });
  return {
    embeds: [{ title: `Practice match ${slot}`, description: details,
      color: match.phase === 'final' ? 0x22c55e : match.phase === 'paused' ? 0xef4444 : 0xf59e0b,
      thumbnail: visualThumbnail(visual) }],
    components: buttons.length ? [row(buttons.slice(0, 5), state.id, slot), ...(buttons.length > 5 ? [row(buttons.slice(5), state.id, slot)] : [])] : [],
    allowedMentions: { parse: [] }
  };
}

export function renderTournamentRecap(state: EventState, players: Record<Player, string> | null,
  tournament?: TournamentDetailsDto): CardPayload {
  const lines = state.matches.map(match => {
    const winner = match.finalWinner;
    return `Match ${match.id.slice(1)} · ${winner && players ? `<@${players[winner]}>` : winner ?? '—'} won`;
  });
  const bye = state.firstRound?.bye;
  if (bye && players) lines.unshift(`Bye · <@${players[bye]}>`);
  const results = lines.join('\n');
  const description = results.length <= 4_096 ? results
    : `${results.slice(0, results.lastIndexOf('\n', 3_950))}\nSee full results in the tournament dashboard.`;
  return {
    embeds: [{ title: `${tournament?.name ?? 'Signup tournament'} results`, color: 0x22c55e, description }],
    components: [], allowedMentions: { parse: [] }
  };
}

export function renderCard(state: EventState, slot: CardSlot, runnerId?: string,
  players?: Record<Player, string>, tournament?: TournamentDetailsDto, signupChannelId?: string, options: CardOptions = {}): CardPayload {
  if (slot !== 'checkin') {
    const match = state.matches.find(item => item.id === slot as MatchId)!;
    return matchCard(state, match, runnerId, players, options);
  }
  if (state.signup) {
    const signup = state.signup;
    const assigned = signup.status === 'assigned';
    const startsAtMs = state.startsAtMs ?? tournament?.startsAtMs;
    const banner = tournament?.bannerStyle === 'compact' ? null : visualBanner();
    const description = [
      `🎮 **Game:** ${tournament?.game ? gameLabels[tournament.game] : 'Not set by organizer'}`,
      ...(startsAtMs !== undefined ? [`🗓️ **Scheduled start:** <t:${Math.floor(startsAtMs / 1000)}:F>`] : []),
      ...(signupChannelId ? [`📍 **Signup channel:** <#${signupChannelId}>`] : []),
      `🎥 **Format:** ${state.firstRound ? 'BO1' : '4-player rehearsal · BO1'} · camera play · ${state.durationMs / 60_000} min per match`,
      ...(options.recordingNotice ? [`🎙️ **Recording:** ${literal(options.recordingNotice)} Players can opt out with /tcg-test recording-optout.`] : []),
      ...(tournament?.description ? ['', '📝 **Tournament details**', literal(tournament.description)] : []),
      '',
      `👥 **Signup:** ${assigned ? 'closed' : 'open'} · ${signup.roster.length}/${signup.capacity ?? 4} joined`,
      ...(assigned ? [
        `✅ **Checked in:** ${state.checkins.length}/${state.firstRound ? signup.roster.length : 4}`,
        state.published ? `**Round published**${state.firstRound?.bye && players ? ` · Bye: <@${players[state.firstRound.bye]}>` : ''}`
          : startsAtMs === undefined ? 'Check in to publish the round.'
            : 'Check in before the scheduled start. The round publishes then with everyone checked in (at least 2 players).'
      ] : ['Choose **Join** to sign up or **Withdraw** to leave the roster.'])
    ].join('\n');
    return { embeds: [{ title: `🌟 ${tournament?.name ?? 'Signup tournament'}`, description, color: 0xf59e0b,
      ...(banner ? { image: banner } :
        { thumbnail: visualThumbnail(!assigned ? 'signup' : state.published ? 'notice' : 'checkin') }) }],
      components: state.published ? [row([{ label: 'View roster', action: 'signupRoster' }], state.id, slot)] :
        assigned ? [row([{ label: 'Check in', action: 'checkin' }, { label: 'View roster', action: 'signupRoster' }], state.id, slot)] :
        [row([{ label: 'Join', action: 'signupJoin' }, { label: 'Withdraw', action: 'signupWithdraw' },
          { label: 'View roster', action: 'signupRoster' }], state.id, slot)],
      allowedMentions: { parse: [] } };
  }
  return {
    embeds: [{
      title: 'Practice check-in',
      description: `Four-player private rehearsal · ${state.checkins.length}/4 checked in\nChecked in: ${state.checkins.map(player => players?.[player] ? `<@${players[player]}>` : player).join(', ') || 'none'}\n${state.published ? 'Round published' : 'Setup has no deadline'}`,
      color: 0xf59e0b,
      ...(visualBanner() ? { image: visualBanner()! } :
        { thumbnail: visualThumbnail(state.published ? 'notice' : 'checkin') })
    }],
    components: state.published ? [] : [row([{ label: 'Check in', action: 'checkin' }], state.id, slot)],
    allowedMentions: { parse: [] }
  };
}
