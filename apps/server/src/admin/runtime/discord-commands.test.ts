// Wave 3: DiscordAdminRuntime commands delegate to the late-bound controller and map its refusals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdminCommandRequestDto } from '@tcg-live/core';
import type { AdminApplyResult, ExplicitRefreshResult, WebAdminRequest } from '../../discord/controller.js';
import { ControllerUnavailableError } from '../../discord/controller.js';
import { createFixture, RuleError } from '../../rehearsal/domain.js';
import { CommandConflictError, PreconditionFailedError, RetiredSessionError, UnknownEventError } from '../../rehearsal/store.js';
import { CONFLICT, LOCAL_ADMIN } from '../commands.js';
import { AdminConflictError, AdminNotFoundError, AdminRuleError, AdminUnavailableError } from '../runtime-types.js';
import { DiscordAdminRuntime, type AdminGateway, type IntervalScheduler } from './discord-runtime.js';
import type { AdminStore } from './queries.js';
import { EVENT_ID, IDS } from './testing.js';

const RETIRED_ID = '22222222-2222-4222-8222-222222222222';
const UUID = '0F8FAD5B-D9CB-469F-A165-70867728950E';

function store(fail = { value: false }): AdminStore {
  const guard = () => { if (fail.value) throw new Error('connection refused'); };
  return {
    async listEvents() { guard(); return []; },
    async activeEventId() { guard(); return EVENT_ID; },
    async readEvent() { guard(); return null; },
    async readAudit(eventId) { guard(); return eventId === EVENT_ID || eventId === RETIRED_ID ? [] : null; },
    async readActiveVersion() { guard(); return null; }
  };
}

const scheduler: IntervalScheduler = { setInterval: () => 1, clearInterval: () => {} };
const gateway = (ready: boolean): AdminGateway => ({ isReady: () => ready, watch: () => () => {} });

function controller() {
  const requests: WebAdminRequest[] = [];
  let refreshes = 0;
  const state = { failure: null as Error | null,
    result: { outcome: { eventId: EVENT_ID, version: 7, result: 'resolve', applied: true }, cards: 'pending', roomWarning: 'Room M1 pending.',
      reply: 'Saved: resolve. Card update pending. Room setup pending: Room M1 pending.', degraded: false } as AdminApplyResult,
    refresh: { cards: 'refreshed', cardError: null, roomWarning: null, reply: 'Practice cards refreshed.' } as ExplicitRefreshResult };
  return {
    state, requests, get refreshes() { return refreshes; },
    controller: {
      config: { adminId: IDS.admin },
      subscribe: () => () => {},
      status: () => ({ updatePending: false, panelRevision: 0 }),
      async applyAdmin(request: WebAdminRequest) { requests.push(request); if (state.failure) throw state.failure; return state.result; },
      async refreshExplicit() { refreshes++; if (state.failure) throw state.failure; return state.refresh; }
    }
  };
}

function runtime(options: { ready?: boolean; lost?: boolean; attach?: boolean; fail?: { value: boolean } } = {}) {
  const fake = controller();
  const lease = { lost: options.lost ?? false };
  const admin = new DiscordAdminRuntime({ runnerId: 'runner-1', commandsEnabled: true, publicMatchRooms: false,
    store: store(options.fail), scheduler, lease: { isLost: () => lease.lost } });
  admin.attachGateway(gateway(options.ready ?? true), null);
  if (options.attach ?? true) admin.attachController(fake.controller);
  return { admin, fake, lease };
}

const resolve: AdminCommandRequestDto = { commandId: UUID, eventId: EVENT_ID,
  command: { type: 'resolve', matchId: 'M1', winner: 'B', reason: 'Ruling.' },
  precondition: { match: { matchId: 'M1', phase: 'running', proposalRevision: null, finalWinner: null, pauseGeneration: 0 } } };

test('a console command reaches the controller as the web principal with its stored ID, content and precondition', async () => {
  const { admin, fake } = runtime();
  const result = await admin.applyAdminCommand(resolve, LOCAL_ADMIN);
  assert.deepEqual(result, { applied: true, result: 'Saved: resolve. Card update pending. Room setup pending: Room M1 pending.',
    version: 7, cards: 'pending', roomWarning: 'Room M1 pending.' });
  const sent = fake.requests[0]!;
  assert.equal(sent.eventId, EVENT_ID);
  assert.equal(sent.principalId, 'local-admin');
  assert.equal(sent.commandId, `web:${UUID.toLowerCase()}`);
  assert.deepEqual(sent.command, { type: 'resolve', matchId: 'M1', winner: 'B', reason: 'Ruling.' });
  assert.equal(sent.content, JSON.stringify([EVENT_ID, resolve.command, resolve.precondition]));
  const fixture = createFixture(EVENT_ID);
  assert.equal(sent.precondition(fixture), false, 'M1 is in setup, not running');
  fixture.matches[0] = { ...fixture.matches[0], phase: 'running' };
  assert.equal(sent.precondition(fixture), true);

  await admin.applyAdminCommand({ ...resolve, command: { type: 'signupClose' }, precondition: { signup: { status: 'open', rosterSize: 4 } } }, LOCAL_ADMIN);
  assert.deepEqual(fake.requests[1]!.command, { type: 'signupClose', adminId: IDS.admin }, 'the configured admin closes signup');
  fake.state.result = { ...fake.state.result, outcome: { eventId: EVENT_ID, version: 7, result: 'not_joined', applied: false },
    cards: 'updated', roomWarning: null, reply: 'No change: not_joined.' };
  assert.deepEqual(await admin.applyAdminCommand(resolve, LOCAL_ADMIN),
    { applied: false, result: 'No change: not_joined.', version: 7, cards: 'updated', roomWarning: null });
  await admin.close();
});

test('store and controller refusals map to 404, 409, 422 and 503', async () => {
  const { admin, fake } = runtime();
  const cases: Array<[Error, (error: unknown) => boolean]> = [
    [new UnknownEventError('Unknown event.'), error => error instanceof AdminNotFoundError],
    [new RetiredSessionError('Private Discord session is retired.'), error => error instanceof AdminConflictError && error.message === CONFLICT.inactive],
    [new PreconditionFailedError('changed'), error => error instanceof AdminConflictError && error.message === CONFLICT.changed],
    [new CommandConflictError('Command ID conflicts with different content.'),
      error => error instanceof AdminConflictError && error.message === CONFLICT.reused],
    [new RuleError('Admin resolution is unavailable.'), error => error instanceof AdminRuleError && error.message === 'Admin resolution is unavailable.'],
    [new ControllerUnavailableError('stopping'), error => error instanceof AdminUnavailableError],
    [new Error('Rehearsal database operation failed.'), error => error instanceof AdminUnavailableError &&
      error.message === 'The rehearsal database is unavailable.']
  ];
  for (const [failure, check] of cases) {
    fake.state.failure = failure;
    await assert.rejects(admin.applyAdminCommand(resolve, LOCAL_ADMIN), check, failure.constructor.name);
  }
  assert.equal(admin.status().database, 'unavailable', 'a database failure shows in the status');
  fake.state.failure = null;
  await admin.applyAdminCommand(resolve, LOCAL_ADMIN);
  assert.equal(admin.status().database, 'ready');
  // Checked before the controller: a winner outside the match (422) and an event ID that cannot exist (404).
  const before = fake.requests.length;
  await assert.rejects(admin.applyAdminCommand({ ...resolve, command: { type: 'correct', matchId: 'M1', winner: 'D', reason: 'x' } }, LOCAL_ADMIN),
    (error: unknown) => error instanceof AdminRuleError && error.message === 'Winner is not in the selected match.');
  await assert.rejects(admin.applyAdminCommand({ ...resolve, eventId: 'not-a-uuid' }, LOCAL_ADMIN), AdminNotFoundError);
  assert.equal(fake.requests.length, before);
  await admin.close();
});

test('503 before the controller attaches, while the gateway is not ready, after the lease is lost and after close', async () => {
  const unattached = runtime({ attach: false });
  await assert.rejects(unattached.admin.applyAdminCommand(resolve, LOCAL_ADMIN), AdminUnavailableError);
  await assert.rejects(unattached.admin.refreshPanels(EVENT_ID), AdminUnavailableError);
  const connecting = runtime({ ready: false });
  await assert.rejects(connecting.admin.applyAdminCommand(resolve, LOCAL_ADMIN),
    (error: unknown) => error instanceof AdminUnavailableError && error.message === 'Discord is not ready.');
  const lost = runtime();
  lost.lease.lost = true;
  await assert.rejects(lost.admin.applyAdminCommand(resolve, LOCAL_ADMIN), AdminUnavailableError);
  await assert.rejects(lost.admin.refreshPanels(EVENT_ID), AdminUnavailableError);
  const closed = runtime();
  await closed.admin.close();
  await assert.rejects(closed.admin.applyAdminCommand(resolve, LOCAL_ADMIN), AdminUnavailableError);
  for (const item of [unattached, connecting, lost, closed]) assert.equal(item.fake.requests.length, 0);
  await Promise.all([unattached, connecting, lost].map(item => item.admin.close()));
});

test('panel refresh: active event only (409 retired, 404 unknown), card rule refusals are 422, results pass through', async () => {
  const { admin, fake } = runtime();
  assert.deepEqual(await admin.refreshPanels(EVENT_ID), { cards: 'refreshed', roomWarning: null });
  await assert.rejects(admin.refreshPanels(RETIRED_ID), (error: unknown) => error instanceof AdminConflictError && error.message === CONFLICT.inactive);
  await assert.rejects(admin.refreshPanels('33333333-3333-4333-8333-333333333333'), AdminNotFoundError);
  await assert.rejects(admin.refreshPanels('nope'), AdminNotFoundError);
  assert.equal(fake.refreshes, 1);
  fake.state.refresh = { cards: 'pending', cardError: null, roomWarning: 'Room M2 pending.', reply: '' };
  assert.deepEqual(await admin.refreshPanels(EVENT_ID), { cards: 'pending', roomWarning: 'Room M2 pending.' });
  fake.state.refresh = { cards: 'pending', cardError: 'Private Discord card permission denied; fix channel permissions before refresh.',
    roomWarning: null, reply: '' };
  await assert.rejects(admin.refreshPanels(EVENT_ID), (error: unknown) => error instanceof AdminRuleError &&
    error.message === 'Private Discord card permission denied; fix channel permissions before refresh.');
  fake.state.failure = new RuleError('Private Discord session has an interrupted running clock; stop and prepare --replace.');
  await assert.rejects(admin.refreshPanels(EVENT_ID), AdminRuleError);
  await admin.close();
  const down = runtime({ fail: { value: true } });
  await assert.rejects(down.admin.refreshPanels(EVENT_ID), AdminUnavailableError);
  await down.admin.close();
});
