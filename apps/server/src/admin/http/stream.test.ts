import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN_API_VERSION, formatStreamId, parseStreamId } from '@tcg-live/core';
import { FIXTURE_BOOT_ID, FIXTURE_EVENT_ID, liveDispute } from '@tcg-live/core/fixtures';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from './sessions.js';
import { MAX_STREAMS } from './stream.js';
import { SECOND_EVENT_ID } from './test-runtime.js';
import { call, delay, login, openStream, startHarness, waitFor, type StreamClient } from './test-support.js';

const sequences = (audit: { sequence: number }[]) => audit.map(entry => entry.sequence);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

test('a stream starts with hello, then a change carrying the full snapshot and recent audit', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    const stream = await openStream(harness.port, token);
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(stream.headers['cache-control'], 'no-store');
    assert.equal(stream.headers.connection, 'close');
    assert.equal(stream.headers['x-accel-buffering'], 'no');
    assert.equal(stream.headers['x-content-type-options'], 'nosniff');
    assert(stream.headers['content-security-policy']);
    assert.equal(stream.headers['access-control-allow-origin'], undefined);

    const hello = await stream.next();
    assert.equal(hello.event, 'hello');
    assert.equal(hello.id, undefined);
    assert.equal(hello.data?.type, 'hello');
    if (hello.data?.type !== 'hello') return;
    assert.equal(hello.data.apiVersion, ADMIN_API_VERSION);
    assert.equal(hello.data.bootId, FIXTURE_BOOT_ID);
    assert.equal(hello.data.buildId, 'test-build');
    assert.equal(hello.data.activeEventId, FIXTURE_EVENT_ID);
    assert.equal(hello.data.status.mode, 'demo');

    const change = await stream.next();
    assert.equal(change.event, 'change');
    assert.equal(change.id, `${FIXTURE_BOOT_ID}.${FIXTURE_EVENT_ID}.17.2`);
    assert.deepEqual(parseStreamId(change.id), { bootId: FIXTURE_BOOT_ID, eventId: FIXTURE_EVENT_ID, version: 17, panelRevision: 2 });
    assert.equal(change.data?.type, 'change');
    if (change.data?.type !== 'change') return;
    assert.deepEqual(change.data.snapshot, liveDispute);
    assert.equal(change.data.version, 17);
    assert.equal(change.data.panelRevision, 2);
    assert.deepEqual(sequences(change.data.audit), range(1, 17));
    stream.close();
  } finally {
    await harness.stop();
  }
});

test('Last-Event-ID resumes within the same boot and event, and falls back to the last 200 entries otherwise', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    const resumeFrom = async (lastEventId: string | null) => {
      const stream = await openStream(harness.port, token, lastEventId === null ? {} : { 'Last-Event-ID': lastEventId });
      const change = await stream.nextEvent('change');
      stream.close();
      await stream.ended;
      return change;
    };
    const cursor = { bootId: FIXTURE_BOOT_ID, eventId: FIXTURE_EVENT_ID, version: 15, panelRevision: 2 };
    assert.deepEqual(sequences((await resumeFrom(formatStreamId(cursor))).audit), [16, 17], 'version change');
    assert.deepEqual(sequences((await resumeFrom(formatStreamId({ ...cursor, version: 17 }))).audit), [], 'up to date');
    assert.deepEqual(sequences((await resumeFrom(formatStreamId({ ...cursor, bootId: 'another-boot' }))).audit), range(1, 17), 'reboot');
    assert.deepEqual(sequences((await resumeFrom(formatStreamId({ ...cursor, eventId: SECOND_EVENT_ID }))).audit), range(1, 17), 'other event');
    assert.deepEqual(sequences((await resumeFrom(formatStreamId({ ...cursor, version: 99 }))).audit), range(1, 17), 'from the future');
    assert.deepEqual(sequences((await resumeFrom('garbage')).audit), range(1, 17), 'malformed');

    harness.runtime.addEvent(SECOND_EVENT_ID, 250);
    const big = await resumeFrom(formatStreamId(cursor));
    assert.equal(big.eventId, SECOND_EVENT_ID);
    assert.deepEqual(sequences(big.audit), range(51, 250), 'a different event sends the last 200 entries');
    const behind = await resumeFrom(formatStreamId({ ...cursor, eventId: SECOND_EVENT_ID, version: 10 }));
    assert.deepEqual(sequences(behind.audit), range(51, 250), 'resume never sends more than 200 entries');
  } finally {
    await harness.stop();
  }
});

test('later changes carry only new audit entries, panel moves and status changes', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    const stream = await openStream(harness.port, token);
    await stream.nextEvent('change');

    harness.runtime.advance();
    const next = await stream.nextEvent('change');
    assert.equal(next.version, 18);
    assert.equal(next.id, `${FIXTURE_BOOT_ID}.${FIXTURE_EVENT_ID}.18.2`);
    assert.deepEqual(sequences(next.audit), [18]);

    harness.runtime.bumpPanels();
    const panels = await stream.nextEvent('change');
    assert.equal(panels.version, 18);
    assert.equal(panels.panelRevision, 3);
    assert.deepEqual(panels.audit, []);

    harness.runtime.emit({ type: 'status' });
    harness.runtime.emit({ type: 'event', eventId: FIXTURE_EVENT_ID });
    await delay(120);
    assert.deepEqual(stream.pending(), [], 'nothing is sent when nothing moved');

    harness.runtime.statusValue = { ...harness.runtime.statusValue, cards: { updatePending: true } };
    harness.runtime.emit({ type: 'status' });
    const status = await stream.nextEvent('status');
    assert.equal(status.status.cards.updatePending, true);

    harness.runtime.addEvent(SECOND_EVENT_ID, 230);
    harness.runtime.emit({ type: 'event', eventId: SECOND_EVENT_ID });
    const switched = await stream.nextEvent('change');
    assert.equal(switched.eventId, SECOND_EVENT_ID);
    assert.deepEqual(sequences(switched.audit), range(31, 230));
    stream.close();
  } finally {
    await harness.stop();
  }
});

test('bursts are coalesced and one snapshot read fans out to every stream', async () => {
  const harness = await startHarness({}, { timings: { coalesceMs: 40 } });
  try {
    const token = await login(harness);
    const streams: StreamClient[] = [];
    for (let index = 0; index < 3; index += 1) {
      const stream = await openStream(harness.port, token);
      await stream.nextEvent('change');
      streams.push(stream);
    }
    const reads = { ...harness.runtime.reads };
    for (let index = 0; index < 5; index += 1) harness.runtime.advance();
    for (const stream of streams) {
      const change = await stream.nextEvent('change');
      assert.equal(change.version, 22);
      assert.deepEqual(sequences(change.audit), range(18, 22));
    }
    await delay(150);
    for (const stream of streams) assert.deepEqual(stream.pending(), [], 'one change per burst');
    assert.equal(harness.runtime.reads.snapshot - reads.snapshot, 1, 'one snapshot read for all streams');
    assert.equal(harness.runtime.reads.audit - reads.audit, 1, 'one audit read for all streams');
    for (const stream of streams) stream.close();
  } finally {
    await harness.stop();
  }
});

test('streams on different cursors share one audit read from the lowest sequence', async () => {
  const harness = await startHarness({}, { timings: { coalesceMs: 20 } });
  try {
    const token = await login(harness);
    const early = await openStream(harness.port, token);
    await early.nextEvent('change');
    harness.runtime.advance(undefined, false);
    harness.runtime.advance(undefined, false);
    const late = await openStream(harness.port, token);
    assert.equal((await late.nextEvent('change')).version, 19);
    const reads = { ...harness.runtime.reads };
    harness.runtime.advance();
    assert.deepEqual(sequences((await early.nextEvent('change')).audit), [18, 19, 20]);
    assert.deepEqual(sequences((await late.nextEvent('change')).audit), [20]);
    assert.equal(harness.runtime.reads.snapshot - reads.snapshot, 1);
    assert.equal(harness.runtime.reads.audit - reads.audit, 1);
    early.close();
    late.close();
  } finally {
    await harness.stop();
  }
});

test('ping comments, heartbeats and the version check run on their intervals', async () => {
  const harness = await startHarness({}, { timings: { pingMs: 30, heartbeatMs: 45, versionCheckMs: 60 } });
  try {
    const token = await login(harness);
    const stream = await openStream(harness.port, token);
    await stream.nextEvent('change');
    let ping = false;
    let heartbeat = false;
    while (!ping || !heartbeat) {
      const frame = await stream.next(1_000);
      if (frame.comment === 'ping') ping = true;
      if (frame.data?.type === 'heartbeat') {
        assert.equal(frame.event, 'heartbeat');
        assert(Math.abs(frame.data.serverTimeMs - Date.now()) < 5_000);
        heartbeat = true;
      }
    }
    harness.runtime.advance(undefined, false);
    const safetyNet = await stream.nextEvent('change', 1_000);
    assert.equal(safetyNet.version, 18, 'the version check catches unnotified changes');
    stream.close();
  } finally {
    await harness.stop();
  }
});

test('without an active event, hello says so and no change is sent until one starts', async () => {
  const harness = await startHarness({}, { timings: { coalesceMs: 10 } });
  try {
    harness.runtime.activeId = null;
    const token = await login(harness);
    const stream = await openStream(harness.port, token);
    const hello = await stream.nextEvent('hello');
    assert.equal(hello.activeEventId, null);
    await delay(60);
    assert.deepEqual(stream.pending(), []);
    harness.runtime.activeId = FIXTURE_EVENT_ID;
    harness.runtime.emit({ type: 'event', eventId: FIXTURE_EVENT_ID });
    assert.deepEqual(sequences((await stream.nextEvent('change')).audit), range(1, 17));
    stream.close();
  } finally {
    await harness.stop();
  }
});

test('at most 20 streams are open; the runtime is subscribed only while one is', async () => {
  const harness = await startHarness();
  try {
    const token = await login(harness);
    assert.equal(harness.admin.subscribed, false);
    assert.equal(harness.runtime.listeners.size, 0);
    const streams: StreamClient[] = [];
    for (let index = 0; index < MAX_STREAMS; index += 1) {
      const stream = await openStream(harness.port, token);
      await stream.nextEvent('hello');
      streams.push(stream);
    }
    assert.equal(harness.runtime.listeners.size, 1, 'one subscription shared by every stream');
    const refused = await call(harness.port, '/api/v1/stream', { token });
    assert.equal(refused.status, 429);
    assert.deepEqual(refused.json(), { error: { code: 'too_many_requests', message: 'Too many open streams.' } });
    assert.equal(refused.headers['content-type'], 'application/json; charset=utf-8');

    streams.pop()!.close();
    await waitFor(() => harness.admin.streamCount < MAX_STREAMS, 'a free stream slot');
    const again = await openStream(harness.port, token);
    assert.equal(again.status, 200);
    streams.push(again);

    for (const stream of streams) stream.close();
    await waitFor(() => harness.admin.streamCount === 0, 'every stream to close');
    assert.equal(harness.admin.subscribed, false);
    assert.equal(harness.runtime.listeners.size, 0, 'unsubscribed after the last stream closed');
  } finally {
    await harness.stop();
  }
});

test('streams need a bearer token and close on logout', async () => {
  const harness = await startHarness();
  try {
    const anonymous = await call(harness.port, '/api/v1/stream');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json().error.code, 'unauthenticated');
    const token = await login(harness);
    const other = await login(harness);
    const mine = await openStream(harness.port, token);
    const theirs = await openStream(harness.port, other);
    await mine.nextEvent('change');
    await theirs.nextEvent('change');
    assert.equal((await call(harness.port, '/api/v1/session', { method: 'DELETE', token })).status, 204);
    await mine.ended;
    await waitFor(() => harness.admin.streamCount === 1, 'the logged-out stream to close');
    await delay(30);
    assert.equal(harness.admin.streamCount, 1, 'only the logged-out session lost its stream');
    harness.runtime.advance();
    assert.equal((await theirs.nextEvent('change')).version, 18);
    theirs.close();
  } finally {
    await harness.stop();
  }
});

test('an open stream keeps its session alive until the absolute limit, then closes', async () => {
  let now = 50_000_000;
  const harness = await startHarness({}, { now: () => now, timings: { versionCheckMs: 20 } });
  try {
    const token = await login(harness);
    const idle = await login(harness);
    const stream = await openStream(harness.port, token);
    await stream.nextEvent('change');
    now += SESSION_IDLE_MS + 60_000;
    await delay(80);
    await waitFor(async () => (await call(harness.port, '/api/v1/session', { token: idle })).status === 401, 'idle expiry without a stream');
    const alive = await call(harness.port, '/api/v1/session', { token });
    assert.equal(alive.status, 200, 'the stream counted as activity');
    assert.equal(alive.json().idleExpiresAtMs, now + SESSION_IDLE_MS);
    now += SESSION_ABSOLUTE_MS;
    await stream.ended;
    assert.equal((await call(harness.port, '/api/v1/session', { token })).status, 401);
  } finally {
    await harness.stop();
  }
});

test('close() ends open streams quickly, unsubscribes, and answers later requests with 503', async () => {
  const harness = await startHarness({}, { timings: { pingMs: 20, heartbeatMs: 20, versionCheckMs: 20 } });
  try {
    const token = await login(harness);
    const streams = [await openStream(harness.port, token), await openStream(harness.port, token)];
    for (const stream of streams) await stream.nextEvent('change');
    harness.runtime.gate = new Promise(() => {});
    const pending = call(harness.port, '/api/v1/stream', { token }).catch(() => null);
    await waitFor(() => harness.admin.streamCount === 3, 'a stream still reading its first snapshot');

    const started = performance.now();
    await harness.admin.close();
    const elapsed = performance.now() - started;
    assert(elapsed < 1_000, `close() took ${elapsed} ms`);
    await Promise.all(streams.map(stream => stream.ended));
    await pending;
    assert.equal(harness.admin.streamCount, 0);
    assert.equal(harness.admin.subscribed, false);
    assert.equal(harness.runtime.listeners.size, 0);
    await harness.admin.close();

    for (const [path, method] of [['/api/v1/status', 'GET'], ['/api/v1/session', 'POST'], ['/', 'GET'], ['/anything', 'POST']] as const) {
      const reply = await call(harness.port, path, { method, token, body: method === 'POST' ? '{}' : undefined });
      assert.equal(reply.status, 503, `${method} ${path}`);
      assert.equal(reply.json().error.code, 'unavailable');
    }
    assert.equal((await call(harness.port, '/livez')).status, 200);
    assert.equal((await call(harness.port, '/livez/')).status, 404);
  } finally {
    await harness.stop();
  }
});

test('startServer().stop() with an open stream finishes well inside the 5 s watchdog', async () => {
  const harness = await startHarness();
  const token = await login(harness);
  const stream = await openStream(harness.port, token);
  await stream.nextEvent('change');
  const started = performance.now();
  await harness.stop();
  const elapsed = performance.now() - started;
  await stream.ended;
  assert(elapsed < 1_500, `stop() took ${elapsed} ms`);
  assert.equal(harness.runtime.listeners.size, 0);
  await harness.stop();
});
