import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  applyRehearsalCommand, countRehearsalEvents, createRehearsalEvent,
  getRehearsalAudit, getRehearsalEvent, setupRehearsalSchema
} from './store.js';
import { ADMIN, deriveFixture, type Command, RuleError } from './domain.js';

const runnerId = randomUUID();
const START_MS = 1_700_000_000_000;

async function continueRegistration(eventId: string, nowMs: number): Promise<void> {
  if (!Number.isSafeInteger(nowMs)) throw new RuleError('Invalid rehearsal fixture clock.');
  await applyRehearsalCommand(eventId, 'checkin-C', 'player:C', { type: 'checkin' }, runnerId, nowMs);
  await applyRehearsalCommand(eventId, 'checkin-D', 'player:D', { type: 'checkin' }, runnerId, nowMs);
  const state = await getRehearsalEvent(eventId);
  if (state.checkins.join(',') !== 'A,B,C,D' || state.published) throw new RuleError('Child registration continuation failed.');
  process.stdout.write(`child-registration-complete event=${eventId}\n`);
}

async function rehearse(): Promise<void> {
  const before = await countRehearsalEvents();
  const event = await createRehearsalEvent(60_000);
  const id = event.id;
  let tick = START_MS;
  const run = (commandId: string, actor: string, command: Command, advanceMs = 0) => {
    tick += advanceMs;
    return applyRehearsalCommand(id, commandId, actor, command, runnerId, tick);
  };
  await run('checkin-A', 'player:A', { type: 'checkin' });
  await run('checkin-B', 'player:B', { type: 'checkin' });
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'continue-registration', id, String(tick)], {
    env: process.env, encoding: 'utf8', timeout: 15_000
  });
  if (child.status !== 0 || !child.stdout.includes(`child-registration-complete event=${id}`)) {
    throw new RuleError('Fresh-process registration continuation failed.');
  }
  process.stdout.write(child.stdout);
  await run('publish', ADMIN, { type: 'publish' });
  await run('M1-ready-A', 'player:A', { type: 'ready', matchId: 'M1' });
  await run('M1-ready-B', 'player:B', { type: 'ready', matchId: 'M1' });
  await run('M1-pause-A', 'player:A', { type: 'pause', matchId: 'M1' }, 5_000);
  await run('M1-consent-A', 'player:A', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 });
  await run('M1-consent-B', 'player:B', { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 });
  await run('M1-propose-A', 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }, 4_000);
  await run('M1-dispute-B', 'player:B', { type: 'dispute', matchId: 'M1', revision: 1 });
  await run('M1-repropose-B', 'player:A', { type: 'propose', matchId: 'M1', winner: 'B', expectedRevision: 1 });
  await run('M1-resolve-B', ADMIN, { type: 'resolve', matchId: 'M1', winner: 'B', reason: 'Fixture dispute decision' });
  await run('M1-correct-A', ADMIN, { type: 'correct', matchId: 'M1', winner: 'A', reason: 'Fixture correction before next round' });
  await run('M2-ready-C', 'player:C', { type: 'ready', matchId: 'M2' });
  await run('M2-ready-D', 'player:D', { type: 'ready', matchId: 'M2' });
  await run('M2-propose-C', 'player:C', { type: 'propose', matchId: 'M2', winner: 'C', expectedRevision: 0 }, 7_000);
  await run('M2-confirm-D', 'player:D', { type: 'confirm', matchId: 'M2', revision: 1 });

  const final = await getRehearsalEvent(id);
  const audit = await getRehearsalAudit(id);
  const after = await countRehearsalEvents();
  if (after !== before + 1 || final.version !== audit.length || final.version !== 19 ||
      final.matches[0].finalWinner !== 'A' || final.matches[1].finalWinner !== 'C') {
    throw new RuleError('Rehearsal verification failed.');
  }
  const resolveEntry = audit.find(entry => entry.command_id === 'M1-resolve-B');
  const correctEntry = audit.find(entry => entry.command_id === 'M1-correct-A');
  if (audit.some((entry, index) => entry.sequence !== index + 1) ||
      !resolveEntry || resolveEntry.actor_id !== ADMIN || resolveEntry.mode !== 'CAM' ||
      resolveEntry.action.type !== 'resolve' || resolveEntry.action.winner !== 'B' ||
      resolveEntry.action.reason !== 'Fixture dispute decision' ||
      !correctEntry || correctEntry.sequence <= resolveEntry.sequence ||
      correctEntry.actor_id !== ADMIN || correctEntry.mode !== 'CAM' ||
      correctEntry.action.type !== 'correct' || correctEntry.action.winner !== 'A' ||
      correctEntry.action.reason !== 'Fixture correction before next round') {
    throw new RuleError('Rehearsal audit verification failed.');
  }
  const players = deriveFixture(final);
  if (players.some(player => player.rating !== (player.points === 3 ? 1216 : 1184))) {
    throw new RuleError('Rehearsal rating verification failed.');
  }
  process.stdout.write('clock=accelerated_injected_epoch_ms (not real elapsed time)\n');
  process.stdout.write(`event=${id} prior_events=${before} current_events=${after} audit_entries=${audit.length}\n`);
  for (const player of players) {
    process.stdout.write(`${player.player}: points=${player.points} rating=${player.rating}\n`);
  }
}

async function main(): Promise<void> {
  const [command, argument, clockArgument] = process.argv.slice(2);
  try {
    switch (command) {
      case 'setup': {
        const outcome = await setupRehearsalSchema();
        process.stdout.write(`rehearsal-schema=${outcome}\n`);
        break;
      }
      case 'rehearse':
        await rehearse();
        break;
      case 'continue-registration':
        if (!argument || !clockArgument) throw new RuleError('Event ID and fixture clock are required.');
        await continueRegistration(argument, Number(clockArgument));
        break;
      case 'status': {
        if (!argument) throw new RuleError('Event ID is required.');
        const state = await getRehearsalEvent(argument);
        process.stdout.write(`${JSON.stringify({ event: state, players: deriveFixture(state) })}\n`);
        break;
      }
      case 'audit': {
        if (!argument) throw new RuleError('Event ID is required.');
        process.stdout.write(`${JSON.stringify(await getRehearsalAudit(argument))}\n`);
        break;
      }
      default:
        throw new RuleError('Use setup, rehearse, status EVENT_ID, or audit EVENT_ID.');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof RuleError ? error.message : 'Rehearsal command failed.'}\n`);
    process.exitCode = 1;
  }
}

void main();
