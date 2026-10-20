import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdminCommandDto, AdminCommandRequestDto, CommandPreconditionDto, EventSnapshotDto, MatchId } from '@tcg-live/core';
import type { Command } from '../../rehearsal/domain.js';
import { LOCAL_ADMIN } from '../commands.js';
import { runAdminDemo } from '../demo.js';
import { call, freePort, openStream } from '../http/test-support.js';
import { AdminConflictError, AdminNotFoundError, AdminRuleError, AdminUnavailableError,
  type AdminRuntimeChange } from '../runtime-types.js';
import { DEMO_MEMBERS, DemoAdminRuntime, demoScript, type DemoClock, type DemoStep } from './demo-runtime.js';

class FakeClock implements DemoClock {
  timers = new Map<number, { at: number; callback: () => void }>();
  private id = 0;
  constructor(public t = 1_800_000_000_000) {}
  now() { return this.t; }
  setTimeout(callback: () => void, ms: number) { this.timers.set(++this.id, { at: this.t + ms, callback }); return this.id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].callback();
    }
    this.t = end;
  }
}

const [, ava, ben, cy, dee, eli] = DEMO_MEMBERS.map(member => member.id) as [string, string, string, string, string, string];
const join = (member: string): DemoStep => ({ wait: 10, who: { member }, command: { type: 'signupJoin' } });
const seat = (who: 'A' | 'B' | 'C' | 'D', command: Command): DemoStep => ({ wait: 10, who, command });
const HOLD: DemoStep = { wait: 24 * 3_600_000, restart: true };

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

let uuidCounter = 0;
const uuid = () => `0f8fad5b-d9cb-4${String(++uuidCounter).padStart(3, '0')}-a165-70867728950e`;

function demo(script: DemoStep[], options: { mode?: 'autoplay' | 'interactive'; durationMs?: number } = {}) {
  const clock = new FakeClock();
  const runtime = new DemoAdminRuntime({ clock, newEventId: ids(), bootId: 'boot', buildId: 'build', script, ...options });
  const changes: AdminRuntimeChange[] = [];
  runtime.subscribe(change => { changes.push(change); });
  runtime.start();
  return { runtime, clock, changes };
}

function request(eventId: string, command: AdminCommandDto, precondition: CommandPreconditionDto, commandId = uuid()): AdminCommandRequestDto {
  return { commandId, eventId, command, precondition };
}

const signupOf = (snapshot: EventSnapshotDto) => ({ status: snapshot.signup!.status, rosterSize: snapshot.signup!.roster.length });
const matchOf = (snapshot: EventSnapshotDto, matchId: MatchId) => {
  const match = snapshot.matches.find(item => item.id === matchId)!;
  return { matchId, phase: match.phase, proposalRevision: match.proposal?.revision ?? null, finalWinner: match.finalWinner,
    pauseGeneration: match.pauseGeneration };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('demo commands apply with the real rules, are audited via web, and notify the stream', async () => {
  const { runtime, clock, changes } = demo([join(ava), join(ben), join(cy), join(dee), HOLD]);
  clock.advance(100);
  const before = await runtime.snapshot();
  assert.deepEqual(before.adminActions, ['signupClose', 'signupRemove']);
  changes.length = 0;
  const close = request(before.eventId, { type: 'signupClose' }, { signup: signupOf(before) });
  const result = await runtime.applyAdminCommand(close, LOCAL_ADMIN);
  assert.deepEqual(result, { applied: true, result: 'Saved: signupClose.', version: before.version + 1, cards: 'updated', roomWarning: null });
  const after = await runtime.snapshot();
  assert.equal(after.stage, 'checkin');
  assert.deepEqual(after.seats, { A: ava, B: ben, C: cy, D: dee });
  const entry = (await runtime.audit(before.eventId, 0, 500)).at(-1)!;
  assert.equal(entry.via, 'web');
  assert.equal(entry.principalId, 'local-admin');
  assert.equal(entry.commandId, `web:${close.commandId}`);
  assert.deepEqual(entry.actor, { kind: 'admin' });
  assert.deepEqual(entry.command, { type: 'signupClose' }, 'adminId is never exposed');
  await tick();
  assert.deepEqual(changes, [{ type: 'event', eventId: before.eventId }]);
  await runtime.close();
});

test('a stored result is returned before preconditions; other content under the same ID is a conflict', async () => {
  const { runtime, clock } = demo([join(ava), join(ben), join(cy), join(dee), HOLD]);
  clock.advance(100);
  const before = await runtime.snapshot();
  const close = request(before.eventId, { type: 'signupClose' }, { signup: signupOf(before) });
  const first = await runtime.applyAdminCommand(close, LOCAL_ADMIN);
  const audit = (await runtime.audit(before.eventId, 0, 500)).length;
  // The precondition (open, 4) no longer holds, yet the retry is answered from the stored outcome.
  assert.deepEqual(await runtime.applyAdminCommand(structuredClone(close), LOCAL_ADMIN), first);
  assert.equal((await runtime.audit(before.eventId, 0, 500)).length, audit, 'no second audit row');
  await assert.rejects(runtime.applyAdminCommand({ ...close, precondition: { signup: { status: 'open', rosterSize: 3 } } }, LOCAL_ADMIN),
    (error: unknown) => error instanceof AdminConflictError && /different command/.test(error.message));
  await assert.rejects(runtime.applyAdminCommand({ ...close, eventId: 'not-this-event' }, LOCAL_ADMIN), AdminNotFoundError);
  // A fresh ID with the stale precondition is a 409 (state changed); a matching one meets the domain rule (422).
  await assert.rejects(runtime.applyAdminCommand(request(before.eventId, { type: 'signupClose' }, { signup: { status: 'open', rosterSize: 4 } }), LOCAL_ADMIN),
    (error: unknown) => error instanceof AdminConflictError && /changed/.test(error.message));
  await assert.rejects(runtime.applyAdminCommand(request(before.eventId, { type: 'signupRemove', memberId: eli },
    { signup: { status: 'assigned', rosterSize: 4 } }), LOCAL_ADMIN),
  (error: unknown) => error instanceof AdminRuleError && error.message === 'Signup is closed.');
  await runtime.close();
});

test('no-change outcomes are not stored, rule errors and winner checks are 422, retired events are 409', async () => {
  const { runtime, clock } = demo([join(ava), join(ben), { wait: 1_000, restart: true }, HOLD]);
  clock.advance(100);
  const first = await runtime.snapshot();
  const remove = request(first.eventId, { type: 'signupRemove', memberId: eli }, { signup: signupOf(first) });
  assert.deepEqual(await runtime.applyAdminCommand(remove, LOCAL_ADMIN),
    { applied: false, result: 'No change: not_joined.', version: first.version, cards: 'updated', roomWarning: null });
  await assert.rejects(runtime.applyAdminCommand(request(first.eventId, { type: 'publish' }, { eventVersion: first.version }), LOCAL_ADMIN),
    (error: unknown) => error instanceof AdminRuleError && error.message === 'Signup is still open.');
  await assert.rejects(runtime.applyAdminCommand(request(first.eventId, { type: 'resolve', matchId: 'M1', winner: 'C', reason: 'x' },
    { match: matchOf(first, 'M1') }), LOCAL_ADMIN),
  (error: unknown) => error instanceof AdminRuleError && error.message === 'Winner is not in the selected match.');
  const removeBen = request(first.eventId, { type: 'signupRemove', memberId: ben }, { signup: signupOf(first) });
  const removed = await runtime.applyAdminCommand(removeBen, LOCAL_ADMIN);
  assert.equal(removed.applied, true);

  clock.advance(2_000);   // The scenario restarts: the first event is retired, a new one is active.
  const second = await runtime.snapshot();
  assert.notEqual(second.eventId, first.eventId);
  await assert.rejects(runtime.applyAdminCommand(request(first.eventId, { type: 'signupRemove', memberId: ava },
    { signup: { status: 'open', rosterSize: 1 } }), LOCAL_ADMIN),
  (error: unknown) => error instanceof AdminConflictError && error.message === 'This event is no longer active.');
  // The stored success of a retired event is still returned to a retry, before the active-event check.
  assert.deepEqual(await runtime.applyAdminCommand(removeBen, LOCAL_ADMIN), removed);
  await assert.rejects(runtime.refreshPanels(first.eventId), AdminConflictError);
  await assert.rejects(runtime.refreshPanels('missing'), AdminNotFoundError);
  await runtime.close();
  await assert.rejects(runtime.applyAdminCommand(removeBen, LOCAL_ADMIN), AdminUnavailableError);
  await assert.rejects(runtime.refreshPanels(second.eventId), AdminUnavailableError);
});

test('panel refresh in the demo is a no-op that moves panelRevision', async () => {
  const { runtime, changes } = demo([HOLD]);
  const before = await runtime.snapshot();
  changes.length = 0;
  assert.deepEqual(await runtime.refreshPanels(before.eventId), { cards: 'refreshed', roomWarning: null });
  const after = await runtime.snapshot();
  assert.equal(after.panelRevision, before.panelRevision + 1);
  assert.equal(after.version, before.version);
  await tick();
  assert.deepEqual(changes, [{ type: 'panels', eventId: before.eventId }]);
  await runtime.close();
});

test('a console judge-resume restarts the clock under the demo runner', async () => {
  const steps: DemoStep[] = [join(ava), join(ben), join(cy), join(dee),
    { wait: 10, who: 'admin', command: { type: 'signupClose', adminId: DEMO_MEMBERS[0]!.id } },
    ...(['A', 'B', 'C', 'D'] as const).map(who => seat(who, { type: 'checkin' })),
    { wait: 10, who: 'admin', command: { type: 'publish' } },
    seat('A', { type: 'ready', matchId: 'M1' }), seat('B', { type: 'ready', matchId: 'M1' }),
    seat('A', { type: 'pause', matchId: 'M1' }), HOLD];
  const { runtime, clock } = demo(steps, { durationMs: 60_000 });
  clock.advance(1_000);
  const paused = await runtime.snapshot();
  assert.equal(paused.matches[0]!.phase, 'paused');
  const resume = request(paused.eventId, { type: 'judgeResume', matchId: 'M1', reason: 'Board checked.' }, { match: matchOf(paused, 'M1') });
  assert.equal((await runtime.applyAdminCommand(resume, LOCAL_ADMIN)).result, 'Saved: judgeResume.');
  const running = await runtime.snapshot();
  assert.equal(running.matches[0]!.phase, 'running');
  assert.equal(running.matches[0]!.clock.state, 'running');
  assert.equal(running.matches[0]!.clock.runningSinceMs, clock.t);
  assert.equal((await runtime.audit(paused.eventId, 0, 500)).at(-1)!.command.reason, 'Board checked.');
  await runtime.close();
});

async function until(runtime: DemoAdminRuntime, clock: FakeClock, label: string, check: () => boolean, limitMs = 1_200_000) {
  for (let elapsed = 0; elapsed <= limitMs; elapsed += 500) {
    if (check()) return;
    clock.advance(500);
  }
  assert.fail(`timed out waiting for ${label} (paused at ${JSON.stringify(runtime.pausedAt)})`);
}

test('interactive demo: players keep acting, the script pauses at each admin decision and resumes when it lands', async () => {
  const { runtime, clock } = demo(demoScript(), { mode: 'interactive', durationMs: 300_000 });
  assert.equal(runtime.playMode, 'interactive');
  const decide = async (decision: string, matchId: MatchId | null, command: (snapshot: EventSnapshotDto) => AdminCommandRequestDto) => {
    await until(runtime, clock, decision, () => runtime.pausedAt?.decision === decision);
    assert.equal(runtime.pausedAt!.matchId, matchId, decision);
    const held = await runtime.snapshot();
    clock.advance(60_000);
    const later = await runtime.snapshot();
    assert.equal(later.version, held.version, `${decision}: nothing moves while the admin decides`);
    assert.ok(runtime.pausedAt, `${decision}: still paused`);
    const result = await runtime.applyAdminCommand(command(later), LOCAL_ADMIN);
    assert.equal(result.applied, true, decision);
    assert.equal(runtime.pausedAt, null, `${decision}: resumed`);
    return later;
  };
  const eventId = (await runtime.snapshot()).eventId;
  const atRemove = await decide('signupRemove', null, s => request(s.eventId, { type: 'signupRemove', memberId: eli }, { signup: signupOf(s) }));
  assert.deepEqual(atRemove.signup!.roster, [ava, ben, eli, cy], 'the players joined on their own');
  await decide('signupClose', null, s => request(s.eventId, { type: 'signupClose' }, { signup: signupOf(s) }));
  const atPublish = await decide('publish', null, s => request(s.eventId, { type: 'publish' }, { eventVersion: s.version }));
  assert.deepEqual(atPublish.checkins, ['A', 'B', 'C', 'D']);
  const atResume = await decide('judgeResume', 'M1', s => request(s.eventId,
    { type: 'judgeResume', matchId: 'M1', reason: 'Checked.' }, { match: matchOf(s, 'M1') }));
  assert.deepEqual(atResume.matches[0]!.judge?.reasons, ['called']);
  const atResolve = await decide('resolve', 'M2', s => request(s.eventId,
    { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Ruling.' }, { match: matchOf(s, 'M2') }));
  assert.deepEqual(atResolve.matches[1]!.judge?.reasons, ['dispute']);
  const atExpiry = await decide('resolve', 'M1', s => request(s.eventId,
    { type: 'resolve', matchId: 'M1', winner: 'A', reason: 'Time.' }, { match: matchOf(s, 'M1') }));
  assert.equal(atExpiry.matches[0]!.phase, 'expired');
  // The finished event is held so a result can still be corrected; a correction lets the scenario restart.
  const atFinal = await decide('correct', null, s => request(s.eventId,
    { type: 'correct', matchId: 'M2', winner: 'C', reason: 'Score sheet.' }, { match: matchOf(s, 'M2') }));
  assert.equal(atFinal.stage, 'complete');
  await until(runtime, clock, 'restart', () => runtime.cycles === 1);
  assert.notEqual((await runtime.snapshot()).eventId, eventId);
  const audit = await runtime.audit(eventId, 0, 500);
  const adminEntries = audit.filter(entry => entry.actor.kind === 'admin' && entry.via !== 'system');
  assert.deepEqual(adminEntries.map(entry => [entry.command.type, entry.via]), [['signupRemove', 'web'], ['signupClose', 'web'],
    ['publish', 'web'], ['judgeResume', 'web'], ['resolve', 'web'], ['resolve', 'web'], ['correct', 'web']]);
  await runtime.close();
});

test('interactive demo: a decision taken early is not waited for, and resumeScript() skips one', async () => {
  const steps = demoScript().slice(0, 7).concat(HOLD);   // joins, remove Eli, Dee joins, close
  const { runtime, clock } = demo(steps, { mode: 'interactive' });
  await until(runtime, clock, 'three joins', () => runtime.step === 3);
  const early = await runtime.snapshot();
  assert.deepEqual(early.signup!.roster, [ava, ben, eli]);
  await runtime.applyAdminCommand(request(early.eventId, { type: 'signupRemove', memberId: eli }, { signup: signupOf(early) }), LOCAL_ADMIN);
  await until(runtime, clock, 'close decision', () => runtime.pausedAt !== null);
  assert.deepEqual(runtime.pausedAt, { step: 6, decision: 'signupClose', matchId: null }, 'the moot removal was skipped');
  assert.deepEqual((await runtime.snapshot()).signup!.roster, [ava, ben, cy, dee]);
  assert.equal(runtime.resumeScript(), true);
  assert.equal(runtime.resumeScript(), false);
  assert.equal(runtime.pausedAt, null);
  clock.advance(10_000);
  assert.equal((await runtime.snapshot()).signup!.status, 'open', 'the skipped close was not applied by the script');
  await runtime.close();
});

test('interactive demo: only a command for the awaited decision resumes; others apply without resuming', async () => {
  const admin = (command: Command): DemoStep => ({ wait: 10, who: 'admin', command });
  const steps: DemoStep[] = [join(ava), join(ben), join(cy), join(dee), admin({ type: 'signupClose', adminId: DEMO_MEMBERS[0]!.id }),
    ...(['A', 'B', 'C', 'D'] as const).map(who => seat(who, { type: 'checkin' })), admin({ type: 'publish' }),
    seat('A', { type: 'ready', matchId: 'M1' }), seat('B', { type: 'ready', matchId: 'M1' }),
    seat('C', { type: 'ready', matchId: 'M2' }), seat('D', { type: 'ready', matchId: 'M2' }),
    seat('A', { type: 'pause', matchId: 'M1' }), seat('B', { type: 'callJudge', matchId: 'M1' }),
    admin({ type: 'judgeResume', matchId: 'M1', reason: 'Scripted.' }), seat('A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }), HOLD];
  const { runtime, clock } = demo(steps, { mode: 'interactive' });
  const answer = async (decision: string, build: (snapshot: EventSnapshotDto) => AdminCommandRequestDto) => {
    await until(runtime, clock, decision, () => runtime.pausedAt?.decision === decision);
    await runtime.applyAdminCommand(build(await runtime.snapshot()), LOCAL_ADMIN);
  };
  await answer('signupClose', s => request(s.eventId, { type: 'signupClose' }, { signup: signupOf(s) }));
  await answer('publish', s => request(s.eventId, { type: 'publish' }, { eventVersion: s.version }));
  await until(runtime, clock, 'judge-resume decision', () => runtime.pausedAt?.decision === 'judgeResume');
  const waiting = await runtime.snapshot();
  const other = await runtime.applyAdminCommand(request(waiting.eventId, { type: 'resolve', matchId: 'M2', winner: 'C', reason: 'Early.' },
    { match: matchOf(waiting, 'M2') }), LOCAL_ADMIN);
  assert.equal(other.applied, true);
  assert.deepEqual(runtime.pausedAt, { step: 16, decision: 'judgeResume', matchId: 'M1' }, 'M2 does not answer the M1 decision');
  await runtime.applyAdminCommand(request(waiting.eventId, { type: 'judgeResume', matchId: 'M1', reason: 'Checked.' },
    { match: matchOf(waiting, 'M1') }), LOCAL_ADMIN);
  assert.equal(runtime.pausedAt, null);
  clock.advance(100);
  const after = await runtime.snapshot();
  assert.equal(after.matches[0]!.proposal?.winner, 'A', 'the players continue after the decision');
  assert.equal((await runtime.audit(after.eventId, 0, 500)).filter(entry => entry.command.reason === 'Scripted.').length, 0,
    'the scripted admin step is never applied in interactive mode');
  await runtime.close();
});

test('autoplay stays the default, and TCG_ADMIN_DEMO_MODE=interactive selects interactive for admin:demo', async () => {
  assert.equal(new DemoAdminRuntime().playMode, 'autoplay');
  for (const [env, expected] of [[{}, 'autoplay'], [{ TCG_ADMIN_DEMO_MODE: 'interactive' }, 'interactive']] as const) {
    const port = await freePort();
    const output: string[] = [];
    const running = await runAdminDemo({ env: { PORT: String(port), TCG_ADMIN_WEB_DIST: 'no-such-web-dist', ...env },
      write: text => output.push(text), runtime: { script: [HOLD] } });
    try {
      assert.equal(running.runtime.playMode, expected);
      assert.ok(output.some(line => line.includes(`(${expected})`)));
    } finally {
      await running.stop();
    }
  }
  const port = await freePort();
  const explicit = await runAdminDemo({ env: { PORT: String(port), TCG_ADMIN_DEMO_MODE: 'interactive' }, write: () => {},
    runtime: { script: [HOLD], mode: 'autoplay' } });
  try { assert.equal(explicit.runtime.playMode, 'autoplay', 'an explicit runtime option wins'); }
  finally { await explicit.stop(); }
});

test('end to end on admin:demo: a console command over HTTP lands as a normal stream change with a web audit entry', async () => {
  const port = await freePort();
  const token = 'e2e-fixed-launch-token-0123456789abcdef';
  const running = await runAdminDemo({ env: { PORT: String(port), TCG_ADMIN_LOGIN_TOKEN: token, TCG_ADMIN_WEB_DIST: 'no-such-web-dist' },
    write: () => {}, runtime: { script: [join(ava), join(ben), HOLD].map(step => ({ ...step, wait: 'restart' in step ? step.wait : 1 })) } });
  try {
    const grant = await call(port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token }) });
    const bearer = grant.json().token as string;
    for (let attempt = 0; attempt < 100 && (await running.runtime.snapshot()).signup!.roster.length < 2; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const stream = await openStream(port, bearer);
    try {
      await stream.nextEvent('hello');
      const first = await stream.nextEvent('change');
      const body = JSON.stringify({ commandId: uuid(), eventId: first.eventId,
        command: { type: 'signupRemove', memberId: ben }, precondition: { signup: signupOf(first.snapshot) } });
      const reply = await call(port, '/api/v1/commands', { method: 'POST', token: bearer, body });
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(reply.json(), { applied: true, result: 'Saved: signupRemove.', version: first.version + 1, cards: 'updated', roomWarning: null });
      const change = await stream.nextEvent('change');
      assert.equal(change.version, first.version + 1);
      assert.deepEqual(change.snapshot.signup!.roster, [ava]);
      assert.deepEqual(change.audit.map(entry => [entry.via, entry.principalId, entry.command.type]), [['web', 'local-admin', 'signupRemove']]);
      const stale = await call(port, '/api/v1/commands', { method: 'POST', token: bearer, body: JSON.stringify({ commandId: uuid(),
        eventId: first.eventId, command: { type: 'signupRemove', memberId: ava }, precondition: { signup: signupOf(first.snapshot) } }) });
      assert.equal(stale.status, 409);
      assert.equal(stale.json().error.code, 'conflict');
      assert.equal(stale.json().snapshot.version, first.version + 1, 'the 409 carries the latest snapshot');
    } finally {
      stream.close();
    }
  } finally {
    await running.stop();
  }
});
