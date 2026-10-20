import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from '@tcg-live/core';
import { FIXTURE_EVENT_ID, liveDispute } from '@tcg-live/core/fixtures';
import { LOCAL_ADMIN } from '../commands.js';
import { AdminConflictError, AdminNotFoundError, AdminRuleError, AdminUnavailableError } from '../runtime-types.js';
import { MAX_BODY_BYTES } from './body.js';
import { call, login, startHarness, type Harness } from './test-support.js';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const resolveBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  commandId: UUID, eventId: FIXTURE_EVENT_ID,
  command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: '  Judge ruling.  ' },
  precondition: { match: { matchId: 'M2', phase: 'running', proposalRevision: 1, finalWinner: null, pauseGeneration: 0 } },
  ...overrides
});
const publishBody = JSON.stringify({ commandId: UUID, eventId: FIXTURE_EVENT_ID, command: { type: 'publish' },
  precondition: { eventVersion: 3 } });
const refreshBody = JSON.stringify({ eventId: FIXTURE_EVENT_ID });

async function post(harness: Harness, token: string, path: string, body: string, headers: Record<string, string> = {}) {
  return call(harness.port, path, { method: 'POST', token, body, headers });
}

test('decision 4: with commands off the session only reads and both command routes answer 403', async () => {
  const harness = await startHarness({ mode: 'discord', commandsEnabled: false });
  try {
    const token = await login(harness);
    const session = (await call(harness.port, '/api/v1/session', { token })).json();
    assert.deepEqual(session.capabilities, ['dashboard.read']);
    assert.equal(session.commandsEnabled, false);
    assert.equal((await call(harness.port, '/api/v1/status', { token })).status, 200, 'reading still works');
    for (const [path, body] of [['/api/v1/commands', publishBody], ['/api/v1/panels/refresh', refreshBody]] as const) {
      const reply = await post(harness, token, path, body);
      assert.equal(reply.status, 403, path);
      assert.equal(reply.json().error.code, 'forbidden', path);
    }
    // A malformed body is still 403: nothing is parsed while commands are off.
    assert.equal((await post(harness, token, '/api/v1/commands', '{')).status, 403);
    assert.equal(harness.runtime.commands.length + harness.runtime.refreshes.length, 0);
  } finally {
    await harness.stop();
  }
});

test('decision 4: with commands on (and always in the demo) the session holds every capability', async () => {
  for (const options of [{ mode: 'discord' as const, commandsEnabled: true }, { mode: 'demo' as const, commandsEnabled: true }]) {
    const harness = await startHarness(options);
    try {
      const session = (await call(harness.port, '/api/v1/session', { token: await login(harness) })).json();
      assert.deepEqual(session.capabilities, [...CAPABILITIES]);
      assert.equal(session.commandsEnabled, true);
    } finally {
      await harness.stop();
    }
  }
});

test('a valid command reaches the runtime normalized, for the local admin, and its result is returned', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    harness.runtime.commandResult = { applied: true, result: 'Saved: resolve. Card update pending.', version: 9, cards: 'pending',
      roomWarning: 'Public match room M2 requires bot Move Members permission.' };
    const reply = await post(harness, token, '/api/v1/commands', resolveBody({ commandId: UUID.toUpperCase() }));
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.deepEqual(reply.json(), harness.runtime.commandResult);
    assert.deepEqual(harness.runtime.commands, [{ principal: LOCAL_ADMIN, request: {
      commandId: UUID, eventId: FIXTURE_EVENT_ID,
      command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'Judge ruling.' },
      precondition: { match: { matchId: 'M2', phase: 'running', proposalRevision: 1, finalWinner: null, pauseGeneration: 0 } }
    } }]);
  } finally {
    await harness.stop();
  }
});

test('POST /commands validates strictly: every malformed request is 400 and never reaches the runtime', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    const cases: Array<[string, string, Record<string, string>?]> = [
      ['malformed JSON', '{"commandId":'],
      ['empty body', ''],
      ['JSON array', '[]'],
      ['unknown command type', resolveBody({ command: { type: 'checkin' } })],
      ['commandId not a UUID v4', resolveBody({ commandId: 'abc' })],
      ['extra field', resolveBody({ actor: 'admin' })],
      ['missing precondition part', resolveBody({ precondition: { eventVersion: 3 } })],
      ['bad seat', resolveBody({ command: { type: 'resolve', matchId: 'M2', winner: 'Z', reason: 'x' } })],
      ['blank reason', resolveBody({ command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: '   ' } })],
      ['long reason', resolveBody({ command: { type: 'resolve', matchId: 'M2', winner: 'D', reason: 'x'.repeat(501) } })],
      ['not JSON content', publishBody, { 'Content-Type': 'text/plain' }],
      ['too large', JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) })]
    ];
    for (const [label, body, headers] of cases) {
      const reply = await post(harness, token, '/api/v1/commands', body, headers);
      assert.equal(reply.status, 400, `${label}: ${reply.text}`);
      assert.equal(reply.json().error.code, 'bad_request', label);
    }
    assert.equal(harness.runtime.commands.length, 0);
  } finally {
    await harness.stop();
  }
});

test('the capability is checked per command type after validation', async () => {
  const harness = await startHarness({}, { capabilities: ['dashboard.read', 'match.judge'] });
  try {
    const token = await login(harness);
    assert.equal((await post(harness, token, '/api/v1/commands', resolveBody())).status, 200);
    const correct = await post(harness, token, '/api/v1/commands', resolveBody({
      command: { type: 'correct', matchId: 'M2', winner: 'C', reason: 'x' } }));
    assert.equal(correct.status, 403);
    assert.equal(correct.json().error.code, 'forbidden');
    assert.equal((await post(harness, token, '/api/v1/commands', publishBody)).status, 403);
    assert.equal((await post(harness, token, '/api/v1/panels/refresh', refreshBody)).status, 403, 'panels.refresh not held');
    assert.equal(harness.runtime.commands.length, 1);
  } finally {
    await harness.stop();
  }
});

test('runtime refusals: 404, 409 with the active snapshot, 422 rule, 503 unavailable, generic 500', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    const expect = async (error: Error, status: number, body: unknown) => {
      for (const [path, payload] of [['/api/v1/commands', resolveBody()], ['/api/v1/panels/refresh', refreshBody]] as const) {
        harness.runtime.commandFailure = error;
        const reply = await post(harness, token, path, payload);
        assert.equal(reply.status, status, `${path} ${error.constructor.name}: ${reply.text}`);
        assert.deepEqual(reply.json(), body, path);
      }
    };
    await expect(new AdminNotFoundError('Unknown event.'), 404, { error: { code: 'not_found', message: 'Not found.' } });
    await expect(new AdminConflictError('This event is no longer active.'), 409,
      { error: { code: 'conflict', message: 'This event is no longer active.' }, snapshot: liveDispute });
    await expect(new AdminRuleError('Admin resolution is unavailable.'), 422,
      { error: { code: 'rule', message: 'Admin resolution is unavailable.' } });
    await expect(new AdminUnavailableError('Discord is not ready.'), 503,
      { error: { code: 'unavailable', message: 'Discord is not ready.' } });
    await expect(new Error('secret detail'), 500, { error: { code: 'internal', message: 'Internal error.' } });
    // The conflict stands when the snapshot cannot be read.
    harness.runtime.commandFailure = new AdminConflictError('The event changed since this action was prepared; review the latest state.');
    harness.runtime.failure = new AdminUnavailableError('down');
    const bare = await post(harness, token, '/api/v1/commands', resolveBody());
    assert.equal(bare.status, 409);
    assert.deepEqual(bare.json(), { error: { code: 'conflict',
      message: 'The event changed since this action was prepared; review the latest state.' } });
  } finally {
    await harness.stop();
  }
});

test('panel refresh: 200 with the runtime result; strict body; POST only', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    harness.runtime.refreshResult = { cards: 'pending', roomWarning: 'Room M1 pending.' };
    const reply = await post(harness, token, '/api/v1/panels/refresh', refreshBody);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json(), { cards: 'pending', roomWarning: 'Room M1 pending.' });
    assert.deepEqual(harness.runtime.refreshes, [FIXTURE_EVENT_ID]);
    for (const body of ['', '{}', JSON.stringify({ eventId: 5 }), JSON.stringify({ eventId: FIXTURE_EVENT_ID, all: true })])
      assert.equal((await post(harness, token, '/api/v1/panels/refresh', body)).status, 400, body);
    for (const path of ['/api/v1/commands', '/api/v1/panels/refresh']) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const wrong = await call(harness.port, path, { method, token });
        assert.equal(wrong.status, 405, `${method} ${path}`);
        assert.equal(wrong.headers.allow, 'POST');
      }
    }
  } finally {
    await harness.stop();
  }
});

test('command routes keep the Host, Origin and bearer checks', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    assert.equal((await call(harness.port, '/api/v1/commands', { method: 'POST', body: publishBody })).status, 401);
    const noOrigin = await call(harness.port, '/api/v1/commands', { method: 'POST', token, body: publishBody, origin: false });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.json().error.code, 'bad_origin');
    const foreign = await post(harness, token, '/api/v1/commands', publishBody, { Origin: 'http://evil.example' });
    assert.equal(foreign.json().error.code, 'bad_origin');
    const host = await post(harness, token, '/api/v1/panels/refresh', refreshBody, { Host: 'evil.example' });
    assert.equal(host.json().error.code, 'bad_host');
    assert.equal(harness.runtime.commands.length + harness.runtime.refreshes.length, 0);
  } finally {
    await harness.stop();
  }
});
