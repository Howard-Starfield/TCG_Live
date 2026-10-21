// Server contract of the Wave 3 routes over raw HTTP (POST /api/v1/commands and /api/v1/panels/refresh):
// every error status with its body shape, the order of checks (a stored result first, then the active
// event and the precondition, then the domain rule), idempotent retries, and decision 4 (commands off).
// The interactive demo holds still at each admin decision, so the state under test does not move.
import { expect, test } from '@playwright/test';
import {
  activeSnapshot, eventAudit, MEMBER, matchOf, newCommandId, postCommand, postRefresh, signupOf, waitForHold, waitForPause,
  type JsonResponse, type Snapshot
} from './support/commands';
import { apiGet, apiLogin } from './support/console';
import { startDemo, type DemoProcess } from './support/demo';
import { rawRequest } from './support/http';

const DISABLED = 'Admin commands are disabled for this console (TCG_ADMIN_COMMANDS).';

/** An error body: exactly { error: { code, message } }, plus a snapshot only for 409. */
function expectError(response: JsonResponse, status: number, code: string, message?: string | RegExp): void {
  expect(response.status, response.text).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/json/);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(Object.keys(response.body).sort()).toEqual(status === 409 ? ['error', 'snapshot'] : ['error']);
  expect(Object.keys(response.body.error).sort()).toEqual(['code', 'message']);
  expect(response.body.error.code).toBe(code);
  if (message instanceof RegExp) expect(response.body.error.message).toMatch(message);
  else if (message !== undefined) expect(response.body.error.message).toBe(message);
}

test.describe('commands on the interactive demo', () => {
  test.describe.configure({ mode: 'serial' });
  let demo: DemoProcess;
  let bearer: string;
  let at: Snapshot;

  test.beforeAll(async () => {
    demo = await startDemo({ scenario: { steps: 28, mode: 'interactive' } });
    bearer = await apiLogin(demo.origin, demo.token);
    await waitForPause(demo, 'signupRemove', null);
    at = await activeSnapshot(demo.origin, bearer);
  });
  test.afterAll(async () => { await demo?.kill(); });

  const remove = (snapshot: Snapshot, memberId: string = MEMBER.eli, commandId = newCommandId()) =>
    ({ commandId, eventId: snapshot.eventId, command: { type: 'signupRemove', memberId }, precondition: signupOf(snapshot) });

  test('the session holds every capability; the routes need a bearer and an allowed Origin', async () => {
    const session = await apiGet<{ commandsEnabled: boolean; capabilities: string[] }>(demo.origin, bearer, '/session');
    expect(session.commandsEnabled).toBe(true);
    expect(session.capabilities.sort()).toEqual(['dashboard.read', 'event.publish', 'match.correct', 'match.judge', 'panels.refresh', 'signup.manage']);
    expectError(await postCommand(demo.origin, null, remove(at)), 401, 'unauthenticated');
    expectError(await postRefresh(demo.origin, null, { eventId: at.eventId }), 401, 'unauthenticated');
    expectError(await postCommand(demo.origin, bearer, remove(at), { Origin: 'http://evil.example' }), 403, 'bad_origin');
    const get = await rawRequest(demo.origin, 'GET', '/api/v1/commands', { Authorization: `Bearer ${bearer}` });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect((await activeSnapshot(demo.origin, bearer)).version).toBe(at.version);
  });

  test('400: strict validation, before anything is looked up', async () => {
    const valid = remove(at);
    const resolve = (reason: unknown) => ({ commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'resolve', matchId: 'M1', winner: 'A', reason }, precondition: matchOf(at, 'M1') });
    const cases: Array<[string, unknown, string]> = [
      ['empty body', undefined, 'Request body is required.'],
      ['not JSON', '{"commandId":', ''],
      ['an array', '[]', 'Request body must be a JSON object.'],
      ['an unknown key', { ...valid, extra: 1 }, 'Request body has unknown fields.'],
      ['no precondition', { commandId: valid.commandId, eventId: valid.eventId, command: valid.command }, 'Request body is missing precondition.'],
      ['commandId not a UUID', { ...valid, commandId: 'web-1' }, 'commandId must be a UUID v4.'],
      ['commandId a v1 UUID', { ...valid, commandId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }, 'commandId must be a UUID v4.'],
      ['eventId malformed', { ...valid, eventId: 'no such/event' }, 'Invalid event ID.'],
      ['a player command', { ...valid, command: { type: 'signupJoin' } }, 'Unknown command type.'],
      ['an extra command field', { ...valid, command: { type: 'signupRemove', memberId: MEMBER.eli, reason: 'x' } }, 'command has unknown fields.'],
      ['a bad member ID', { ...valid, command: { type: 'signupRemove', memberId: '12' } }, 'command.memberId must be a Discord member ID.'],
      ['match M3', { ...resolve('x'), command: { type: 'resolve', matchId: 'M3', winner: 'A', reason: 'x' } }, 'command.matchId must be M1 or M2.'],
      ['winner E', { ...resolve('x'), command: { type: 'resolve', matchId: 'M1', winner: 'E', reason: 'x' } }, 'command.winner must be a seat A to D.'],
      ['an empty reason', resolve(''), 'A reason is required.'],
      ['a blank reason', resolve(' \t\n '), 'A reason is required.'],
      ['a zero-width reason', resolve('​‍﻿'), 'A reason is required.'],
      ['a 501-character reason', resolve(` ${'r'.repeat(501)} `), 'A reason may be at most 500 characters.'],
      ['a numeric reason', resolve(5), 'command.reason must be a string.'],
      ['publish without eventVersion', { ...valid, command: { type: 'publish' }, precondition: {} }, 'publish needs precondition.eventVersion.'],
      ['a negative eventVersion', { ...valid, command: { type: 'publish' }, precondition: { eventVersion: -1 } }, 'precondition.eventVersion must be an integer from 0.'],
      ['resolve with the other match', { ...resolve('x'), precondition: matchOf(at, 'M2') }, 'resolve needs precondition.match for M1.'],
      ['close without the signup', { ...valid, command: { type: 'signupClose' }, precondition: {} }, 'signupClose needs precondition.signup.'],
      ['a bad signup status', { ...valid, precondition: { signup: { status: 'closed', rosterSize: 4 } } }, 'precondition.signup.status must be open or assigned.'],
      ['an unknown precondition key', { ...valid, precondition: { ...signupOf(at), stage: 'signup' } }, 'precondition has unknown fields.']
    ];
    for (const [name, body, message] of cases) {
      const response = await postCommand(demo.origin, bearer, body);
      expectError(response, 400, 'bad_request', message || undefined);
      expect(response.body.error.message, name).toBeTruthy();
    }
    expectError(await postRefresh(demo.origin, bearer, {}), 400, 'bad_request', 'Request body is missing eventId.');
    expectError(await postRefresh(demo.origin, bearer, { eventId: at.eventId, force: true }), 400, 'bad_request', 'Request body has unknown fields.');
    // A 500-character reason after trimming is fine as far as validation goes: it reaches the domain (422 here).
    expectError(await postCommand(demo.origin, bearer, resolve(`  ${'r'.repeat(500)}  `)), 422, 'rule');
    expect((await activeSnapshot(demo.origin, bearer)).version).toBe(at.version);
    expect((await demo.state()).pausedAt?.decision).toBe('signupRemove');
  });

  test('404 for an unknown event; 422 for a domain rule, with the rule text', async () => {
    expectError(await postCommand(demo.origin, bearer, { ...remove(at), eventId: 'no-such-event' }), 404, 'not_found');
    expectError(await postRefresh(demo.origin, bearer, { eventId: 'no-such-event' }), 404, 'not_found');
    expectError(await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'publish' }, precondition: { eventVersion: at.version } }), 422, 'rule', 'Signup is still open.');
    expectError(await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'resolve', matchId: 'M1', winner: 'C', reason: 'Wrong match.' }, precondition: matchOf(at, 'M1') }),
    422, 'rule', 'Winner is not in the selected match.');
    expectError(await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'judgeResume', matchId: 'M1', reason: 'Too early.' }, precondition: matchOf(at, 'M1') }),
    422, 'rule', 'Fixture round is not published.');
    expect((await eventAudit(demo.origin, bearer, at.eventId)).length).toBe(at.version);
  });

  test('409 + the latest snapshot when the precondition no longer holds (checked before the domain rule)', async () => {
    const stale = await postCommand(demo.origin, bearer, { ...remove(at), precondition: { signup: { status: 'open', rosterSize: 3 } } });
    expectError(stale, 409, 'conflict', 'The event changed since this action was prepared; review the latest state.');
    expect(stale.body.snapshot).toMatchObject({ eventId: at.eventId, version: at.version, status: 'active' });
    // A stale eventVersion beats the rule error that the same publish would get with the right version.
    const publish = await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'publish' }, precondition: { eventVersion: at.version - 1 } });
    expectError(publish, 409, 'conflict');
    expect(publish.body.snapshot.version).toBe(at.version);
  });

  test('200, then an identical retry returns the stored result even though the state moved on', async () => {
    const commandId = newCommandId();
    const body = remove(at, MEMBER.eli, commandId);
    const first = await postCommand(demo.origin, bearer, body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ applied: true, result: 'Saved: signupRemove.', version: at.version + 1, cards: 'updated', roomWarning: null });
    // The scenario resumes: Dee joins and the script waits for the close. The precondition (open, 4) holds
    // again by chance, so prove "moved on" with the version.
    await waitForPause(demo, 'signupClose', null);
    const moved = await activeSnapshot(demo.origin, bearer);
    expect(moved.version).toBeGreaterThan(first.body.version);

    const retry = await postCommand(demo.origin, bearer, body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    // Upper-case IDs name the same command and the same event.
    const upper = await postCommand(demo.origin, bearer, { ...body, commandId: commandId.toUpperCase(), eventId: at.eventId.toUpperCase() });
    expect(upper.status).toBe(200);
    expect(upper.body).toEqual(first.body);
    const audit = await eventAudit(demo.origin, bearer, at.eventId);
    expect(audit.filter(entry => entry.commandId === `web:${commandId}`)).toHaveLength(1);
    expect(audit.find(entry => entry.commandId === `web:${commandId}`)).toMatchObject({ via: 'web', principalId: 'local-admin',
      actor: { kind: 'admin' }, command: { type: 'signupRemove', memberId: MEMBER.eli } });

    // The same ID with other content (another member, another precondition, another event) is a conflict.
    for (const other of [remove(at, MEMBER.ben, commandId), { ...body, precondition: { signup: { status: 'open', rosterSize: 2 } } },
      { ...body, eventId: 'another-event' }]) {
      const reused = await postCommand(demo.origin, bearer, other);
      expectError(reused, 409, 'conflict', 'This command ID was already used for a different command.');
      expect(reused.body.snapshot).toMatchObject({ eventId: at.eventId, version: moved.version });
    }
    expect((await activeSnapshot(demo.origin, bearer)).version).toBe(moved.version);
  });

  test('a no-op is a 200 with applied false; panel refresh is a 200 that moves only panelRevision', async () => {
    const now = await activeSnapshot(demo.origin, bearer);
    const noop = await postCommand(demo.origin, bearer, remove(now, MEMBER.eli));
    expect(noop.status).toBe(200);
    expect(noop.body).toEqual({ applied: false, result: 'No change: not_joined.', version: now.version, cards: 'updated', roomWarning: null });
    const refresh = await postRefresh(demo.origin, bearer, { eventId: now.eventId });
    expect(refresh.status).toBe(200);
    expect(refresh.body).toEqual({ cards: 'refreshed', roomWarning: null });
    const after = await activeSnapshot(demo.origin, bearer);
    expect(after).toMatchObject({ version: now.version, panelRevision: now.panelRevision + 1 });
    expect((await demo.state()).pausedAt?.decision).toBe('signupClose');
  });

  test('503 once the runtime is unavailable (HTTP still up)', async () => {
    const now = await activeSnapshot(demo.origin, bearer);
    await demo.closeRuntime();
    expectError(await postCommand(demo.origin, bearer, remove(now, MEMBER.ava)), 503, 'unavailable');
    expectError(await postRefresh(demo.origin, bearer, { eventId: now.eventId }), 503, 'unavailable');
  });
});

test.describe('an event that is no longer active', () => {
  let demo: DemoProcess;
  // Four joins, then a 3 s gap before the event retires and a fresh one is held.
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 4, retireOnce: true, retireGapMs: 3_000 } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('409 inactive + the active snapshot; a stored success is still returned to a retry', async () => {
    const bearer = await apiLogin(demo.origin, demo.token);
    await waitForHold(demo, 4);
    const before = await activeSnapshot(demo.origin, bearer);
    expect(before.signup?.roster).toHaveLength(4);
    const body = { commandId: newCommandId(), eventId: before.eventId, command: { type: 'signupRemove', memberId: MEMBER.eli }, precondition: signupOf(before) };
    const first = await postCommand(demo.origin, bearer, body);
    expect(first.status).toBe(200);

    await expect.poll(async () => (await apiGet<Array<{ status: string }>>(demo.origin, bearer, '/events')).map(event => event.status),
      { timeout: 15_000 }).toEqual(['active', 'retired']);
    const fresh = await activeSnapshot(demo.origin, bearer);
    expect(fresh.eventId).not.toBe(before.eventId);

    const retry = await postCommand(demo.origin, bearer, body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const late = await postCommand(demo.origin, bearer, { ...body, commandId: newCommandId(), command: { type: 'signupRemove', memberId: MEMBER.ava } });
    expectError(late, 409, 'conflict', 'This event is no longer active.');
    expect(late.body.snapshot).toMatchObject({ eventId: fresh.eventId, status: 'active' });
    const refresh = await postRefresh(demo.origin, bearer, { eventId: before.eventId });
    expectError(refresh, 409, 'conflict', 'This event is no longer active.');
    expect(refresh.body.snapshot.eventId).toBe(fresh.eventId);
  });
});

test.describe('decision 4: commands off', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 4, commands: 'off' } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('the session reads only; both routes answer 403 before validating, and nothing changes', async () => {
    const bearer = await apiLogin(demo.origin, demo.token);
    await waitForHold(demo, 4);
    const session = await apiGet<{ commandsEnabled: boolean; capabilities: string[] }>(demo.origin, bearer, '/session');
    expect(session).toMatchObject({ commandsEnabled: false, capabilities: ['dashboard.read'] });
    const before = await activeSnapshot(demo.origin, bearer);
    const valid = { commandId: newCommandId(), eventId: before.eventId, command: { type: 'signupRemove', memberId: MEMBER.eli }, precondition: signupOf(before) };
    expectError(await postCommand(demo.origin, bearer, valid), 403, 'forbidden', DISABLED);
    expectError(await postCommand(demo.origin, bearer, { nonsense: true }), 403, 'forbidden', DISABLED);
    // The refresh route is gated by its capability in the router first, so it gives the generic 403 text.
    expectError(await postRefresh(demo.origin, bearer, { eventId: before.eventId }), 403, 'forbidden', 'This session may not do that.');
    const after = await activeSnapshot(demo.origin, bearer);
    expect(after).toMatchObject({ version: before.version, panelRevision: before.panelRevision });
    expect(after.signup?.roster).toContain(MEMBER.eli);
  });
});

test.describe('a capability missing', () => {
  let demo: DemoProcess;
  test.beforeAll(async () => { demo = await startDemo({ scenario: { steps: 24, capabilities: ['dashboard.read', 'match.judge'] } }); });
  test.afterAll(async () => { await demo?.kill(); });

  test('403 for commands outside the grant (checked after validation); granted ones apply', async () => {
    const bearer = await apiLogin(demo.origin, demo.token);
    await waitForHold(demo, 24);
    const session = await apiGet<{ commandsEnabled: boolean; capabilities: string[] }>(demo.origin, bearer, '/session');
    expect(session).toMatchObject({ commandsEnabled: true, capabilities: ['dashboard.read', 'match.judge'] });
    const at = await activeSnapshot(demo.origin, bearer);
    const correct = { commandId: newCommandId(), eventId: at.eventId, command: { type: 'correct', matchId: 'M2', winner: 'C', reason: 'x' }, precondition: matchOf(at, 'M2') };
    expectError(await postCommand(demo.origin, bearer, correct), 403, 'forbidden', 'This session may not do that.');
    expectError(await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId, command: { type: 'publish' },
      precondition: { eventVersion: at.version } }), 403, 'forbidden', 'This session may not do that.');
    expectError(await postRefresh(demo.origin, bearer, { eventId: at.eventId }), 403, 'forbidden');
    // Validation still comes first: a malformed request for a missing capability is a 400.
    expectError(await postCommand(demo.origin, bearer, { ...correct, command: { ...correct.command, reason: '' } }), 400, 'bad_request');
    const resolve = await postCommand(demo.origin, bearer, { commandId: newCommandId(), eventId: at.eventId,
      command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Judge ruling.' }, precondition: matchOf(at, 'M2') });
    expect(resolve.status).toBe(200);
    expect(resolve.body.applied).toBe(true);
  });
});
