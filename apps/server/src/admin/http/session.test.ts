import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from '@tcg-live/core';
import { auditTimeline, FIXTURE_EVENT_ID, liveDispute } from '@tcg-live/core/fixtures';
import { AdminUnavailableError } from '../runtime-types.js';
import { LOGIN_MAX_FAILURES, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from './sessions.js';
import { call, login, startHarness } from './test-support.js';

const HOUR = 3_600_000;

test('the launch token is exchanged for a bearer session describing the local principal', async () => {
  let now = 1_000_000;
  const harness = await startHarness({ mode: 'discord', commandsEnabled: false }, { now: () => now });
  try {
    assert.match(harness.admin.loginUrl()!, new RegExp(`^http://127\\.0\\.0\\.1:${harness.port}/#login=[A-Za-z0-9_-]{43}$`));
    const reply = await call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: harness.launchToken() }) });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['cache-control'], 'no-store');
    const grant = reply.json();
    assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(grant.token, harness.launchToken());
    const expected = {
      principal: { kind: 'local', id: 'local-admin', label: 'Local admin' }, capabilities: [...CAPABILITIES],
      expiresAtMs: now + SESSION_ABSOLUTE_MS, idleExpiresAtMs: now + SESSION_IDLE_MS, mode: 'discord', commandsEnabled: false
    };
    assert.deepEqual(grant.session, expected);
    now += 60_000;
    const current = await call(harness.port, '/api/v1/session', { token: grant.token });
    assert.equal(current.status, 200);
    assert.deepEqual(current.json(), { ...expected, idleExpiresAtMs: now + SESSION_IDLE_MS });
    assert.notEqual((await login(harness)), grant.token, 'each sign-in gets its own token');
  } finally {
    await harness.stop();
  }
});

test('missing, malformed, unknown, expired and logged-out bearer tokens are 401', async () => {
  let now = 5_000_000;
  const harness = await startHarness({}, { now: () => now });
  try {
    const wrong = await call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: 'x'.repeat(43) }) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json().error.code, 'unauthenticated');

    const token = await login(harness);
    const unauthorized = async (headers: Record<string, string>, label: string) => {
      const reply = await call(harness.port, '/api/v1/status', { headers });
      assert.equal(reply.status, 401, label);
      assert.equal(reply.json().error.code, 'unauthenticated', label);
    };
    await unauthorized({}, 'missing');
    await unauthorized({ Authorization: token }, 'no scheme');
    await unauthorized({ Authorization: `Basic ${token}` }, 'wrong scheme');
    await unauthorized({ Authorization: `Bearer  ${token}` }, 'double space');
    await unauthorized({ Authorization: `Bearer ${'A'.repeat(43)}` }, 'unknown');
    await unauthorized({ Authorization: `Bearer ${harness.launchToken()}` }, 'launch token is not a bearer');
    assert.equal((await call(harness.port, '/api/v1/status', { token })).status, 200);

    now += SESSION_IDLE_MS - 1;
    assert.equal((await call(harness.port, '/api/v1/status', { token })).status, 200, 'activity refreshes the idle timer');
    now += SESSION_IDLE_MS - 1;
    assert.equal((await call(harness.port, '/api/v1/status', { token })).status, 200);
    now += SESSION_IDLE_MS;
    assert.equal((await call(harness.port, '/api/v1/status', { token })).status, 401, 'idle expiry');

    const busy = await login(harness);
    const started = now;
    while (now < started + SESSION_ABSOLUTE_MS - HOUR) {
      now += HOUR;
      assert.equal((await call(harness.port, '/api/v1/session', { token: busy })).status, 200);
    }
    now = started + SESSION_ABSOLUTE_MS;
    assert.equal((await call(harness.port, '/api/v1/session', { token: busy })).status, 401, 'absolute expiry');

    const leaving = await login(harness);
    assert.equal((await call(harness.port, '/api/v1/session', { method: 'DELETE', token: leaving })).status, 204);
    assert.equal((await call(harness.port, '/api/v1/session', { token: leaving })).status, 401, 'logged out');
    assert.equal((await call(harness.port, '/api/v1/session', { method: 'DELETE', token: leaving })).status, 401);
  } finally {
    await harness.stop();
  }
});

test('launch-token attempts are rate limited globally', async () => {
  let now = 9_000_000;
  const harness = await startHarness({}, { now: () => now });
  const attempt = (token: string) => call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token }) });
  try {
    for (let index = 0; index < LOGIN_MAX_FAILURES; index += 1) assert.equal((await attempt(`wrong-${index}`)).status, 401);
    const limited = await attempt(harness.launchToken());
    assert.equal(limited.status, 429, 'even the right token waits out the window');
    assert.equal(limited.json().error.code, 'too_many_requests');
    assert.equal(limited.headers['retry-after'], '60');
    now += 60_001;
    assert.equal((await attempt(harness.launchToken())).status, 200);
  } finally {
    await harness.stop();
  }
});

test('rotate-link prints a fresh link and the old launch token stops working', async () => {
  const fixed = 'F'.repeat(40);
  const harness = await startHarness({ fixedLoginToken: fixed });
  const discord = await startHarness({ mode: 'discord', fixedLoginToken: fixed });
  try {
    assert.equal(harness.admin.loginUrl(), `http://127.0.0.1:${harness.port}/#login=${fixed}`);
    assert.notEqual(discord.launchToken(), fixed, 'the fixed token is demo-only');
    const token = await login(harness);
    assert.equal((await call(harness.port, '/api/v1/session/rotate-link', { method: 'POST' })).status, 401);
    const rotated = await call(harness.port, '/api/v1/session/rotate-link', { method: 'POST', token });
    assert.equal(rotated.status, 204);
    assert.equal(rotated.text, '');
    assert.deepEqual(harness.printed, [harness.admin.loginUrl()]);
    assert.notEqual(harness.launchToken(), fixed);
    const old = await call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: fixed }) });
    assert.equal(old.status, 401);
    assert.equal((await call(harness.port, '/api/v1/session', { token })).status, 200, 'existing sessions survive rotation');
    const direct = harness.admin.rotateLoginUrl();
    assert.equal(direct, harness.admin.loginUrl());
    assert.equal(harness.printed.length, 1, 'rotateLoginUrl() only returns the link');
    assert.equal((await call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: harness.launchToken() }) })).status, 200);
  } finally {
    await harness.stop();
    await discord.stop();
  }
});

test('read routes return runtime data and validate their parameters', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    const status = await call(harness.port, '/api/v1/status', { token });
    assert.equal(status.status, 200);
    assert.equal(status.json().bootId, harness.runtime.statusValue.bootId);
    const events = (await call(harness.port, '/api/v1/events', { token })).json();
    assert.deepEqual(events.map((event: { eventId: string }) => event.eventId), [FIXTURE_EVENT_ID]);
    const snapshot = await call(harness.port, `/api/v1/events/${FIXTURE_EVENT_ID}/snapshot`, { token });
    assert.deepEqual(snapshot.json(), liveDispute);

    const audit = (query: string) => call(harness.port, `/api/v1/events/${FIXTURE_EVENT_ID}/audit${query}`, { token });
    assert.deepEqual((await audit('')).json(), auditTimeline);
    assert.deepEqual((await audit('?after=15')).json().map((entry: { sequence: number }) => entry.sequence), [16, 17]);
    assert.deepEqual((await audit('?after=2&limit=3')).json().map((entry: { sequence: number }) => entry.sequence), [3, 4, 5]);
    assert.equal((await audit('?limit=500')).status, 200);
    for (const query of ['?after=-1', '?after=1.5', '?after=x', '?limit=0', '?limit=501', '?limit=', '?after=1&after=2', `?after=${'9'.repeat(17)}`]) {
      const reply = await audit(query);
      assert.equal(reply.status, 400, query);
      assert.equal(reply.json().error.code, 'bad_request', query);
    }
    for (const id of ['bad_id', 'x'.repeat(65), '%2e%2e', 'a.b']) {
      assert.equal((await call(harness.port, `/api/v1/events/${id}/snapshot`, { token })).status, 400, id);
    }
    const unknown = await call(harness.port, '/api/v1/events/0000-unknown/snapshot', { token });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json().error.code, 'not_found');
    assert.equal((await call(harness.port, '/api/v1/events/0000-unknown/audit', { token })).status, 404);

    harness.runtime.failure = new AdminUnavailableError('pg down at secret-host');
    const down = await call(harness.port, '/api/v1/events', { token });
    assert.equal(down.status, 503);
    assert.equal(down.json().error.code, 'unavailable');
    assert.doesNotMatch(down.text, /secret-host/);
    harness.runtime.failure = new Error('connection string postgres://user:hunter2@x');
    const broken = await call(harness.port, `/api/v1/events/${FIXTURE_EVENT_ID}/snapshot`, { token });
    assert.equal(broken.status, 500);
    assert.deepEqual(broken.json(), { error: { code: 'internal', message: 'Internal error.' } });
  } finally {
    await harness.stop();
  }
});

test('tokens never appear in logs, error bodies or response headers', async () => {
  const captured: string[] = [];
  const restore: (() => void)[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => { stream.write = original; });
  }
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[name];
    console[name] = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
    restore.push(() => { console[name] = original; });
  }
  const seen: string[] = [];
  let launch = '';
  let rotated = '';
  let bearer = '';
  try {
    const harness = await startHarness();
    try {
      launch = harness.launchToken();
      const replies = [
        await call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: `${launch}x` }) }),
        await call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: launch, extra: 1 }) })
      ];
      bearer = await login(harness);
      replies.push(
        await call(harness.port, '/api/v1/status', { headers: { Authorization: `Bearer ${bearer}x` } }),
        await call(harness.port, '/api/v1/session/rotate-link', { method: 'POST', token: bearer }),
        await call(harness.port, '/api/v1/session', { token: bearer }),
        await call(harness.port, '/api/v1/session', { method: 'DELETE', token: bearer }),
        await call(harness.port, '/api/v1/session', { token: bearer })
      );
      rotated = harness.launchToken();
      for (const reply of replies) seen.push(reply.text, JSON.stringify(reply.headers));
      assert.equal(harness.printed.length, 1, 'the rotated link goes only to the injected printer');
    } finally {
      await harness.stop();
    }
  } finally {
    for (const undo of restore) undo();
  }
  const everything = [...captured, ...seen].join('\n');
  assert(launch && rotated && bearer && rotated !== launch);
  assert(!everything.includes(launch), 'launch token leaked');
  assert(!everything.includes(rotated), 'rotated launch token leaked');
  assert(!everything.includes(bearer), 'bearer token leaked');
});
