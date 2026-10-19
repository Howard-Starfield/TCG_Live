import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { remainingMsAt, type EventSnapshotDto } from '@tcg-live/core';
import { runAdminDemo } from '../demo.js';
import type { AdminHandler } from '../mount.js';
import { AdminNotFoundError, type AdminRuntimeChange } from '../runtime-types.js';
import { DEMO_ADMIN_ID, DemoAdminRuntime, type DemoClock } from './demo-runtime.js';

class FakeClock implements DemoClock {
  timers = new Map<number, { at: number; callback: () => void }>();
  private id = 0;
  constructor(public t = 1_800_000_000_000, private readonly earlyMs = 0) {}
  now() { return this.t; }
  setTimeout(callback: () => void, ms: number) {
    // An early clock fires up to earlyMs before the requested delay, but never immediately for a positive delay.
    this.timers.set(++this.id, { at: this.t + (ms > 0 ? Math.max(1, ms - this.earlyMs) : 0), callback });
    return this.id;
  }
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

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function demo(clock = new FakeClock(), keepRetired?: number) {
  const runtime = new DemoAdminRuntime({ clock, newEventId: ids(), bootId: 'demo-boot', buildId: 'demo-build',
    ...(keepRetired ? { keepRetired } : {}) });
  return { runtime, clock };
}

async function play(runtime: DemoAdminRuntime, clock: FakeClock, totalMs: number, stepMs = 250): Promise<EventSnapshotDto[]> {
  const snapshots: EventSnapshotDto[] = [];
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    clock.advance(stepMs);
    snapshots.push(await runtime.snapshot());
  }
  return snapshots;
}

test('demo autoplay is deterministic under an injected clock', async () => {
  const first = demo();
  const second = demo();
  first.runtime.start();
  second.runtime.start();
  const a = await play(first.runtime, first.clock, 260_000, 1_000);
  const b = await play(second.runtime, second.clock, 260_000, 1_000);
  assert.deepEqual(a, b);
  assert.deepEqual(await first.runtime.listEvents(), await second.runtime.listEvents());
  const eventId = a[0]!.eventId;
  assert.deepEqual(await first.runtime.audit(eventId, 0, 500), await second.runtime.audit(eventId, 0, 500));
  await first.runtime.close();
  await second.runtime.close();
});

test('the scripted scenario walks every stage, judge state and final source with the real domain rules', async () => {
  const { runtime, clock } = demo();
  assert.deepEqual(runtime.status(), { mode: 'demo', bootId: 'demo-boot', buildId: 'demo-build',
    serverTimeMs: clock.t, startedAtMs: clock.t, gateway: 'not_applicable', database: 'not_configured',
    lease: 'not_applicable', cards: { updatePending: false }, rooms: { enabled: false, warning: null }, commandsEnabled: true });
  const changes: AdminRuntimeChange[] = [];
  runtime.subscribe(change => { changes.push(change); });
  runtime.start();
  const first = (await runtime.snapshot()).eventId;
  const snaps = (await play(runtime, clock, 235_000)).filter(snapshot => snapshot.eventId === first);
  const find = (label: string, predicate: (snapshot: EventSnapshotDto) => boolean) => {
    const found = snaps.find(predicate);
    assert.ok(found, label);
    return found;
  };
  find('signup with a removable member', s => s.stage === 'signup' && s.adminActions.includes('signupRemove'));
  find('signup ready to close', s => s.stage === 'signup' && s.adminActions.includes('signupClose'));
  find('check-in, reopen available', s => s.stage === 'checkin' && s.adminActions.includes('signupReopen'));
  find('sticky repost moved the panel revision', s => s.panelRevision === 1 && s.stage === 'checkin');
  find('ready to publish', s => s.adminActions.includes('publish'));
  const running = find('M1 running on this runner', s => s.matches[0]!.clock.state === 'running');
  assert.equal(running.matches[0]!.clock.durationMs, 90_000);
  assert.ok(remainingMsAt(running.matches[0]!.clock, clock.t) <= 90_000);
  find('M1 paused with a judge call', s => s.matches[0]!.phase === 'paused' &&
    s.matches[0]!.judge?.reasons.join() === 'called' && s.matches[0]!.adminActions.includes('judgeResume'));
  find('M2 disputed', s => s.matches[1]!.proposal?.decision === 'disputed' && s.matches[1]!.judge?.reasons.join() === 'dispute');
  find('M2 re-proposed after the dispute keeps the judge', s => s.matches[1]!.proposal?.revision === 2 &&
    s.matches[1]!.proposal.decision === 'open' && s.matches[1]!.judge?.reasons.join() === 'dispute');
  find('M2 resolved by the admin', s => s.matches[1]!.finalSource === 'admin' && s.matches[1]!.finalWinner === 'D');
  find('M1 expired by the timer', s => s.matches[0]!.phase === 'expired' &&
    s.matches[0]!.judge?.reasons.join() === 'called,expired');
  const done = find('complete with an agreed M1', s => s.stage === 'complete' && s.matches[0]!.finalSource === 'agreed');
  assert.deepEqual(done.standings.map(row => row.points), [3, 0, 0, 3]);
  assert.equal(done.members[DEMO_ADMIN_ID]?.displayName, 'Organizer');
  assert.equal(Object.values(done.members).length, 6, 'admin, four players and the removed member');

  const audit = await runtime.audit(first, 0, 500);
  assert.deepEqual(audit.map(entry => entry.sequence), audit.map((_entry, index) => index + 1));
  const timer = audit.find(entry => entry.via === 'system');
  assert.deepEqual(timer?.actor, { kind: 'system', source: 'timer' });
  assert.match(timer?.commandId ?? '', /^timer:M1:1:\d+$/);
  assert.ok(audit.filter(entry => entry.via !== 'system').every(entry => entry.via === 'discord' && /^discord:\d+$/.test(entry.commandId)));
  assert.ok(changes.some(change => change.type === 'panels'));
  assert.ok(changes.some(change => change.type === 'event' && change.eventId === first));

  // After completion the scenario restarts under a new event ID; the old event becomes read-only history.
  assert.equal(runtime.cycles, 1);
  const events = await runtime.listEvents();
  assert.equal(events[0]!.status, 'active');
  assert.notEqual(events[0]!.eventId, first);
  assert.deepEqual(events.slice(1).map(event => [event.eventId, event.status]), [[first, 'retired']]);
  const retired = await runtime.snapshot(first);
  assert.equal(retired.status, 'retired');
  assert.ok(retired.retiredAtMs !== null);
  assert.deepEqual(retired.matches.map(match => match.adminActions), [[], []]);
  assert.equal(await runtime.activeEventId(), events[0]!.eventId);
  await assert.rejects(runtime.snapshot('missing'), AdminNotFoundError);
  await runtime.close();
});

test('an early timer is re-armed until the real deadline, and the history is capped', async () => {
  const clock = new FakeClock(1_800_000_000_000, 7);
  const { runtime } = demo(clock, 2);
  runtime.start();
  const snaps = await play(runtime, clock, 3 * 240_000, 1_000);
  const expired = snaps.find(snapshot => snapshot.matches[0]!.phase === 'expired');
  assert.ok(expired, 'expiry still happens');
  assert.equal(expired.matches[0]!.clock.remainingMs, 0);
  assert.ok(runtime.cycles >= 3);
  const events = await runtime.listEvents();
  assert.equal(events.length, 3, 'active plus two retired');
  await runtime.close();
  assert.equal(clock.timers.size, 0, 'close cancels the autoplay timer');
  const version = (await runtime.snapshot()).version;
  clock.advance(60_000);
  assert.equal((await runtime.snapshot()).version, version);
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('admin:demo serves the handler with demo settings and stops cleanly', async () => {
  const port = await freePort();
  const output: string[] = [];
  const order: string[] = [];
  let seen: { mode: string; commandsEnabled: boolean; devOrigin?: string | null; fixedLoginToken?: string | null } | undefined;
  const token = 'e2e-fixed-launch-token-0123456789abcdef';
  const running = await runAdminDemo({
    env: { PORT: String(port), TCG_ADMIN_LOGIN_TOKEN: token, TCG_ADMIN_DEV_ORIGIN: 'http://localhost:5173',
      TCG_ADMIN_WEB_DIST: 'no-such-web-dist', DATABASE_URL: 'not a url' },
    write: text => output.push(text),
    createHandler: (options): AdminHandler => {
      seen = options;
      return { handle: () => false, loginUrl: () => `http://127.0.0.1:${port}/#login=${token}`, rotateLoginUrl: () => '',
        close: async () => { order.push('handler.close'); } };
    }
  });
  try {
    assert.deepEqual({ mode: seen?.mode, commandsEnabled: seen?.commandsEnabled, devOrigin: seen?.devOrigin,
      fixedLoginToken: seen?.fixedLoginToken }, { mode: 'demo', commandsEnabled: true, devOrigin: 'http://localhost:5173',
      fixedLoginToken: token });
    assert.equal((await fetch(`http://127.0.0.1:${port}/livez`)).status, 200);
    assert.ok(output.includes(`Admin console: http://127.0.0.1:${port}/#login=${token}\n`));
    assert.ok(output.some(line => line.startsWith('Web assets not found')));
    assert.ok((await running.runtime.listEvents()).length === 1);
  } finally {
    const runtimeClose = running.runtime.close.bind(running.runtime);
    running.runtime.close = async () => { order.push('runtime.close'); await runtimeClose(); };
    await running.stop();
    await running.stop();
  }
  // server.stop() closes the (idempotent) handler once more; the explicit order is handler, then runtime.
  assert.deepEqual(order.slice(0, 2), ['handler.close', 'runtime.close']);
});
