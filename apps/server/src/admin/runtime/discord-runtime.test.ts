import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ControllerChange, ControllerStatus } from '../../discord/controller.js';
import { readAdminConfig } from '../config.js';
import type { AdminHandler, AdminHandlerOptions } from '../mount.js';
import { AdminNotFoundError, AdminUnavailableError, type AdminRuntimeChange } from '../runtime-types.js';
import { DiscordAdminRuntime, type AdminGateway, type GatewayState, type IntervalScheduler } from './discord-runtime.js';
import { createDiscordAdmin } from './discord-wiring.js';
import { IdentityCache, type MemberFetcher } from './identity.js';
import type { AdminAuditRow, SummaryRow } from './mappers.js';
import type { AdminEventRecord, AdminStore } from './queries.js';
import { EVENT_ID, IDS, Replay, RUNNER, sessionFor, T0 } from './testing.js';

const RETIRED_ID = '22222222-2222-4222-8222-222222222222';

function fakeStore() {
  const replay = Replay.legacy().published()
    .run('player:A', { type: 'ready', matchId: 'M1' }).run('player:B', { type: 'ready', matchId: 'M1' });
  const old = Replay.legacy();
  old.state = { ...old.state, id: RETIRED_ID };
  const calls: string[] = [];
  let fail = false;
  let version = replay.state.version;
  const records = new Map<string, AdminEventRecord>([
    [EVENT_ID, { session: sessionFor(replay.state), state: replay.state, audit: replay.rows }],
    [RETIRED_ID, { session: sessionFor(old.state, { status: 'retired', retired_at_ms: T0 }), state: old.state, audit: [] }]
  ]);
  const guard = (name: string) => { calls.push(name); if (fail) throw new Error('connection refused'); };
  const store: AdminStore = {
    async listEvents() {
      guard('listEvents');
      return [...records.values()].map((record): SummaryRow => ({ event_id: record.state.id, status: record.session.status,
        kind: null, schema_version: record.state.schemaVersion, created_at_ms: record.session.created_at_ms,
        retired_at_ms: record.session.retired_at_ms, version: record.state.version }));
    },
    async activeEventId() { guard('activeEventId'); return EVENT_ID; },
    async readEvent(eventId) { guard(`readEvent:${eventId}`); return records.get(eventId) ?? null; },
    async readAudit(eventId, after, limit) {
      guard(`readAudit:${eventId}:${after}:${limit}`);
      const record = records.get(eventId);
      return record ? record.audit.filter((row: AdminAuditRow) => Number(row.sequence) > after).slice(0, limit) : null;
    },
    async readActiveVersion() { guard('readActiveVersion'); return { eventId: EVENT_ID, version }; }
  };
  return { store, calls, set fail(value: boolean) { fail = value; }, bump() { version++; } };
}

function fakeScheduler() {
  const intervals = new Map<number, () => void>();
  let next = 0;
  const scheduler: IntervalScheduler = {
    setInterval(callback) { intervals.set(++next, callback); return next; },
    clearInterval(handle) { intervals.delete(handle as number); }
  };
  return { scheduler, intervals, tick() { for (const callback of [...intervals.values()]) callback(); } };
}

function fakeGateway(ready: boolean) {
  let listener: ((state: GatewayState) => void) | undefined;
  const gateway: AdminGateway = {
    isReady: () => ready,
    watch(onChange) { listener = onChange; return () => { listener = undefined; }; }
  };
  return { gateway, emit(state: GatewayState) { listener?.(state); }, get attached() { return !!listener; } };
}

function fakeController() {
  let listener: ((change: ControllerChange) => void) | undefined;
  let subscriptions = 0;
  const status: ControllerStatus = { updatePending: false, panelRevision: 4 };
  return {
    controller: {
      config: { adminId: IDS.admin },
      subscribe(next: (change: ControllerChange) => void) { subscriptions++; listener = next; return () => { listener = undefined; }; },
      status: () => ({ ...status }),
      // Wave 3 command surface; these read-model tests never issue commands.
      applyAdmin: () => Promise.reject(new Error('not used')),
      refreshExplicit: () => Promise.reject(new Error('not used'))
    },
    status, emit(change: ControllerChange) { listener?.(change); },
    get subscribed() { return !!listener; }, get subscriptions() { return subscriptions; }
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function runtimeWith(overrides: Partial<ConstructorParameters<typeof DiscordAdminRuntime>[0]> = {}) {
  const store = fakeStore();
  const timers = fakeScheduler();
  let now = T0;
  const runtime = new DiscordAdminRuntime({ runnerId: RUNNER, commandsEnabled: false, publicMatchRooms: true,
    store: store.store, scheduler: timers.scheduler, now: () => now, bootId: 'boot-1', buildId: 'build-1', ...overrides });
  const changes: AdminRuntimeChange[] = [];
  return { runtime, store, timers, changes, advance(ms: number) { now += ms; },
    listen() { return runtime.subscribe(change => { changes.push(change); }); } };
}

test('before late binding: reads work and status is connecting', async () => {
  const { runtime } = runtimeWith();
  assert.deepEqual(runtime.status(), { mode: 'discord', bootId: 'boot-1', buildId: 'build-1', serverTimeMs: T0,
    startedAtMs: T0, gateway: 'connecting', database: 'ready', lease: 'held', cards: { updatePending: false },
    rooms: { enabled: true, warning: null }, commandsEnabled: false });
  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.eventId, EVENT_ID);
  assert.equal(snapshot.matches[0]!.clock.state, 'running');
  assert.equal(snapshot.panelRevision, 0, 'no controller yet');
  assert.deepEqual(snapshot.members[IDS.a], { id: IDS.a, displayName: null, avatarUrl: null });
  assert.deepEqual((await runtime.listEvents()).map(event => [event.eventId, event.status]),
    [[EVENT_ID, 'active'], [RETIRED_ID, 'retired']]);
  const retired = await runtime.snapshot(RETIRED_ID);
  assert.equal(retired.status, 'retired');
  assert.equal(await runtime.activeEventId(), EVENT_ID);
  await runtime.close();
});

test('not-found and paging rules', async () => {
  const { runtime, store } = runtimeWith();
  await assert.rejects(runtime.snapshot('33333333-3333-4333-8333-333333333333'), AdminNotFoundError);
  await assert.rejects(runtime.snapshot('not-a-uuid'), AdminNotFoundError);
  await assert.rejects(runtime.audit('not-a-uuid', 0, 10), AdminNotFoundError);
  await assert.rejects(runtime.audit('33333333-3333-4333-8333-333333333333', 0, 10), AdminNotFoundError);
  const page = await runtime.audit(EVENT_ID, 2, 3);
  assert.deepEqual(page.map(entry => entry.sequence), [3, 4, 5]);
  await runtime.audit(EVENT_ID, -5, 10_000);
  assert.ok(store.calls.includes(`readAudit:${EVENT_ID}:0:500`), 'after clamps to 0 and limit to 500');
  assert.ok(!store.calls.some(call => call.includes('not-a-uuid')), 'invalid IDs never reach SQL');
  await runtime.close();
});

test('database failures report unavailable status and AdminUnavailableError, then recover', async () => {
  const { runtime, store, changes } = runtimeWith();
  runtime.subscribe(change => { changes.push(change); });
  await tick();
  store.fail = true;
  await assert.rejects(runtime.snapshot(), AdminUnavailableError);
  await assert.rejects(runtime.listEvents(), AdminUnavailableError);
  assert.equal(runtime.status().database, 'unavailable');
  await tick();
  assert.ok(changes.some(change => change.type === 'status'));
  store.fail = false;
  await runtime.listEvents();
  assert.equal(runtime.status().database, 'ready');
  await runtime.close();
});

test('late binding: gateway, controller and rooms attach after creation and drive status and changes', async () => {
  const { runtime, timers, changes, listen } = runtimeWith();
  const gateway = fakeGateway(true);
  runtime.attachGateway(gateway.gateway, null);
  assert.equal(runtime.status().gateway, 'ready');
  const unsubscribe = listen();
  assert.equal(timers.intervals.size, 1, 'polling starts with the first subscriber');
  await tick();
  changes.length = 0;   // the first poll's notice
  gateway.emit('reconnecting');
  assert.equal(runtime.status().gateway, 'reconnecting');
  await tick();
  assert.deepEqual(changes.at(-1), { type: 'status' });

  const controller = fakeController();
  runtime.attachController(controller.controller);
  assert.equal(controller.subscribed, true, 'subscribes immediately because a listener is open');
  controller.emit({ type: 'event', eventId: EVENT_ID });
  controller.emit({ type: 'panels', eventId: EVENT_ID });
  await tick();
  assert.deepEqual(changes.slice(-2), [{ type: 'event', eventId: EVENT_ID }, { type: 'panels', eventId: EVENT_ID }]);
  controller.status.updatePending = true;
  controller.emit({ type: 'status' });
  await tick();
  assert.deepEqual(changes.at(-1), { type: 'status' });
  assert.deepEqual(runtime.status().cards, { updatePending: true });
  assert.equal((await runtime.snapshot()).panelRevision, 4, 'panelRevision comes from the controller');

  const rooms = { trigger: async (explicit?: boolean) => { if (!explicit) throw new Error('raw failure'); } };
  runtime.attachRooms(rooms);
  await assert.rejects(rooms.trigger(false), /raw failure/, 'callers still see the original rejection');
  await tick();
  assert.deepEqual(runtime.status().rooms, { enabled: true, warning: 'Public match room setup failed.' });
  await rooms.trigger(true);
  await tick();
  assert.deepEqual(runtime.status().rooms, { enabled: true, warning: null });

  unsubscribe();
  assert.equal(controller.subscribed, false, 'controller unsubscribed with the last listener');
  assert.equal(timers.intervals.size, 0, 'polling stops with the last listener');
  const count = changes.length;
  controller.emit({ type: 'event', eventId: EVENT_ID });
  await tick();
  assert.equal(changes.length, count);
  await runtime.close();
  assert.equal(gateway.attached, false, 'close detaches the gateway');
  assert.equal(runtime.status().gateway, 'offline');
});

test('the controller is subscribed only while the runtime has subscribers', async () => {
  const { runtime } = runtimeWith();
  const controller = fakeController();
  runtime.attachController(controller.controller);
  assert.equal(controller.subscribed, false);
  const first = runtime.subscribe(() => {});
  const second = runtime.subscribe(() => {});
  assert.equal(controller.subscriptions, 1);
  first();
  assert.equal(controller.subscribed, true);
  second();
  second();
  assert.equal(controller.subscribed, false);
  await runtime.close();
});

test('the safety-net poll reports unannounced version changes and lease loss', async () => {
  let lost = false;
  const { runtime, store, timers, changes, listen } = runtimeWith({ lease: { isLost: () => lost } });
  listen();
  await tick();
  assert.deepEqual(changes, [{ type: 'event', eventId: EVENT_ID }],
    'the first poll notifies, covering writes between the first read of a subscriber and the baseline');
  changes.length = 0;
  store.bump();
  timers.tick();
  await tick();
  assert.deepEqual(changes, [{ type: 'event', eventId: EVENT_ID }]);
  timers.tick();
  await tick();
  assert.equal(changes.length, 1, 'no repeat without a new version');
  lost = true;
  timers.tick();
  await tick();
  assert.equal(runtime.status().lease, 'lost');
  assert.deepEqual(changes.at(-1), { type: 'status' });
  await runtime.close();
  assert.equal(timers.intervals.size, 0, 'close stops polling');
});

test('a throwing runtime subscriber does not stop delivery to others', async () => {
  const { runtime } = runtimeWith();
  const controller = fakeController();
  runtime.attachController(controller.controller);
  const seen: AdminRuntimeChange[] = [];
  runtime.subscribe(() => { throw new Error('listener failure'); });
  runtime.subscribe(change => { seen.push(change); });
  await tick();
  seen.length = 0;      // the first poll's notice
  controller.emit({ type: 'event', eventId: EVENT_ID });
  await tick();
  assert.deepEqual(seen.filter(change => change.type === 'event'), [{ type: 'event', eventId: EVENT_ID }]);
  await runtime.close();
});

test('identity cache fetches single members by ID, deduplicates, and keeps them for five minutes', async () => {
  let now = T0;
  const requests: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher: MemberFetcher = async id => {
    requests.push(id);
    await gate;
    if (id === IDS.e) return null;
    if (id === IDS.d) throw new Error('transient');
    return { displayName: `Name ${id.slice(-2)}`, avatarUrl: `https://cdn.discordapp.com/avatars/${id}/x.png` };
  };
  const cache = new IdentityCache({ now: () => now, timeoutMs: 1_000 });
  cache.attach(fetcher);
  const first = cache.resolve([IDS.a, IDS.a, IDS.e, IDS.d]);
  const concurrent = cache.resolve([IDS.a]);
  release();
  await Promise.all([first, concurrent]);
  assert.deepEqual(requests, [IDS.a, IDS.e, IDS.d], 'one request per member, none repeated concurrently');
  assert.deepEqual(cache.get(IDS.a), { id: IDS.a, displayName: 'Name 11', avatarUrl: `https://cdn.discordapp.com/avatars/${IDS.a}/x.png` });
  assert.deepEqual(cache.get(IDS.e), { id: IDS.e, displayName: null, avatarUrl: null });
  assert.deepEqual(cache.get(IDS.d), { id: IDS.d, displayName: null, avatarUrl: null });
  now += 4 * 60_000;
  await cache.resolve([IDS.a, IDS.e]);
  assert.deepEqual(requests, [IDS.a, IDS.e, IDS.d, IDS.e], 'misses expire after 30 s, hits after 5 min');
  now += 61_000;
  await cache.resolve([IDS.a]);
  assert.equal(requests.at(-1), IDS.a);

  const slow = new IdentityCache({ timeoutMs: 10 });
  slow.attach(() => new Promise(() => {}));
  await slow.resolve([IDS.b]);
  assert.deepEqual(slow.get(IDS.b), { id: IDS.b, displayName: null, avatarUrl: null }, 'a hung REST call is bounded');
});

test('snapshot resolves member names through the attached gateway fetcher', async () => {
  const { runtime } = runtimeWith();
  const asked: string[] = [];
  runtime.attachGateway(fakeGateway(false).gateway, async id => { asked.push(id); return { displayName: `M${id.slice(-2)}`, avatarUrl: null }; });
  assert.equal(runtime.status().gateway, 'connecting');
  const snapshot = await runtime.snapshot();
  assert.deepEqual(asked.sort(), [IDS.admin, IDS.a, IDS.b, IDS.c, IDS.d].sort());
  assert.equal(snapshot.members[IDS.c]?.displayName, 'M13');
  await runtime.close();
});

function fakeHandler(log: string[], url: string | null): (options: AdminHandlerOptions) => AdminHandler {
  return options => {
    log.push(`handler:${options.mode}:${options.commandsEnabled}:${options.port}`);
    return { handle: () => false, loginUrl: () => url, rotateLoginUrl: () => '',
      close: async () => { log.push('handler.close'); throw new Error('close failure'); } };
  };
}

test('console off: no runtime, no handler, nothing printed', () => {
  const log: string[] = [];
  const admin = createDiscordAdmin({ adminConfig: readAdminConfig('discord', {}), port: 3000, runnerId: RUNNER,
    publicMatchRooms: false, createHandler: fakeHandler(log, 'x'),
    createRuntime: () => { log.push('runtime'); throw new Error('must not be created'); }, write: text => log.push(text) });
  assert.equal(admin, undefined);
  assert.deepEqual(log, []);
});

test('console on: handler wraps the runtime, announces once, and closes handler before runtime', async () => {
  const log: string[] = [];
  const admin = createDiscordAdmin({ adminConfig: readAdminConfig('discord', { TCG_ADMIN_CONSOLE: '1', TCG_ADMIN_COMMANDS: '1' }),
    port: 3456, runnerId: RUNNER, publicMatchRooms: false, lease: { isLost: () => false },
    createHandler: fakeHandler(log, 'http://127.0.0.1:3456/#login=abc'),
    createRuntime: options => {
      log.push(`runtime:${options.commandsEnabled}`);
      const runtime = new DiscordAdminRuntime({ ...options, store: fakeStore().store, scheduler: fakeScheduler().scheduler });
      const close = runtime.close.bind(runtime);
      runtime.close = async () => { log.push('runtime.close'); await close(); };
      return runtime;
    }, write: text => log.push(text) });
  assert.ok(admin);
  admin.announce();
  admin.announce();
  admin.attachClient(fakeGateway(true).gateway, null);
  admin.attachController(fakeController().controller);
  assert.equal(admin.runtime.status().gateway, 'ready');
  await admin.close();
  await admin.close();
  assert.deepEqual(log, ['runtime:true', 'handler:discord:true:3456', 'Admin console: http://127.0.0.1:3456/#login=abc\n',
    'handler.close', 'runtime.close']);

  const quiet: string[] = [];
  const noLink = createDiscordAdmin({ adminConfig: readAdminConfig('discord', { TCG_ADMIN_CONSOLE: '1' }), port: 1,
    runnerId: RUNNER, publicMatchRooms: false, createHandler: fakeHandler([], null),
    createRuntime: options => new DiscordAdminRuntime({ ...options, store: fakeStore().store }), write: text => quiet.push(text) });
  noLink!.announce();
  assert.deepEqual(quiet, [], 'nothing printed without a launch link');
  await noLink!.close();
});

test('a controller notice does not hide an out-of-process write that lands before the next poll', async () => {
  const { runtime, store, timers, changes, listen } = runtimeWith();
  const controller = fakeController();
  runtime.attachController(controller.controller);
  listen();
  await tick();
  changes.length = 0;
  store.bump();                                          // the bot's own command (v+1), announced
  controller.emit({ type: 'event', eventId: EVENT_ID });
  store.bump();                                          // the rehearsal CLI writes v+2 before the poll
  await tick();
  timers.tick();
  await tick();
  assert.deepEqual(changes, [{ type: 'event', eventId: EVENT_ID }, { type: 'event', eventId: EVENT_ID }],
    'the poll still reports the newer version');
  await runtime.close();
});
