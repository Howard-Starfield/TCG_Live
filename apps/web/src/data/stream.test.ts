import type { StreamEventDto } from '@tcg-live/core';
import { auditTimeline, FIXTURE_BOOT_ID, liveDispute } from '@tcg-live/core/fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { createMemoryStorage } from './storage';
import { backoffDelay, StreamClient, type StreamClientOptions, type StreamEventInfo } from './stream';
import { change, FakeServer, FakeStreamBody, frame, hello, json } from './test/fakes';

const TIMERS = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const };

function setup(options: Partial<StreamClientOptions> & { online?: () => boolean } = {}) {
  const server = new FakeServer();
  const bodies: FakeStreamBody[] = [];
  server.always('GET /stream', () => {
    const body = new FakeStreamBody();
    bodies.push(body);
    return body.response();
  });
  const api = createApiClient({ fetch: server.fetch, getToken: () => 'tok' });
  const events: { event: StreamEventDto; info: StreamEventInfo }[] = [];
  const reload = vi.fn();
  const target = new EventTarget();
  const client = new StreamClient({
    api, onEvent: (event, info) => events.push({ event, info }), reload,
    random: () => 0.5, eventTarget: target, isOnline: options.online ?? (() => true),
    storage: createMemoryStorage(), ...options
  });
  return { server, bodies, client, events, reload, target };
}

/** Lets fetch, body reads and parsing run without advancing time. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers({ toFake: [...TIMERS.toFake] }); });
afterEach(() => { vi.useRealTimers(); });

describe('StreamClient', () => {
  it('connects with the bearer token, goes live on hello, then delivers change in order', async () => {
    const { server, bodies, client, events } = setup();
    client.start();
    expect(client.getSnapshot().state).toBe('connecting');
    await settle();
    const call = server.callsTo('GET /stream')[0]!;
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(call.headers.Accept).toBe('text/event-stream');
    expect(call.headers['Last-Event-ID']).toBeUndefined();

    const first = change(liveDispute, auditTimeline.slice(0, 3));
    bodies[0]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(first.event, first.id));
    await settle();
    expect(events.map(item => item.event.type)).toEqual(['hello', 'change']);
    expect(events[1]!.info.auditMode).toBe('replace');
    const snapshot = client.getSnapshot();
    expect(snapshot).toMatchObject({ state: 'live', helloReceived: true, activeEventId: liveDispute.eventId,
      bootId: FIXTURE_BOOT_ID, buildId: 'build-1', lastEventId: first.id });

    const next = change({ ...liveDispute, version: 18 }, auditTimeline.slice(3, 4));
    bodies[0]!.push(frame(next.event, next.id));
    await settle();
    expect(events[2]!.info.auditMode).toBe('append');
    expect(client.getSnapshot().lastEventId).toBe(next.id);
    client.stop();
  });

  it('sends Last-Event-ID on reconnect after the server ends the stream, with backoff', async () => {
    const { server, bodies, client, events } = setup();
    client.start();
    await settle();
    const first = change(liveDispute, auditTimeline);
    bodies[0]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(first.event, first.id));
    await settle();
    bodies[0]!.end();
    await settle();
    // attempt 0, random 0.5: 500 + 0.5 * 500 = 750 ms
    expect(client.getSnapshot()).toMatchObject({ state: 'reconnecting', attempt: 1 });
    await vi.advanceTimersByTimeAsync(749);
    expect(server.callsTo('GET /stream')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const calls = server.callsTo('GET /stream');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers['Last-Event-ID']).toBe(first.id);

    // Same boot and event after resume: the first change appends.
    const resumed = change({ ...liveDispute, version: 18 }, []);
    bodies[1]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(resumed.event, resumed.id));
    await settle();
    expect(events.at(-1)!.info.auditMode).toBe('append');
    expect(client.getSnapshot()).toMatchObject({ state: 'live', attempt: 0 });
    client.stop();
  });

  it('replaces the audit when the boot changes, and reports bootChanged on hello', async () => {
    const { server, bodies, client, events } = setup();
    client.start();
    await settle();
    const first = change(liveDispute, auditTimeline);
    bodies[0]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(first.event, first.id));
    await settle();
    bodies[0]!.end();
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.callsTo('GET /stream')).toHaveLength(2);
    const reboot = change(liveDispute, auditTimeline.slice(0, 2), 'boot-2');
    bodies[1]!.push(frame(hello({ bootId: 'boot-2', activeEventId: liveDispute.eventId })) + frame(reboot.event, reboot.id));
    await settle();
    const helloInfo = events.filter(item => item.event.type === 'hello').at(-1)!.info;
    expect(helloInfo.bootChanged).toBe(true);
    expect(events.at(-1)!.info.auditMode).toBe('replace');
    expect(client.getSnapshot().bootId).toBe('boot-2');
    client.stop();
  });

  it('replaces the audit when the active event changes', async () => {
    const { bodies, client, events } = setup();
    client.start();
    await settle();
    const first = change(liveDispute, auditTimeline);
    const other = change({ ...liveDispute, eventId: 'event-2', version: 1 }, auditTimeline.slice(0, 1));
    bodies[0]!.push(frame(hello({ activeEventId: liveDispute.eventId })) + frame(first.event, first.id) + frame(other.event, other.id));
    await settle();
    expect(events.at(-1)!.info.auditMode).toBe('replace');
    expect(client.getSnapshot().activeEventId).toBe('event-2');
    client.stop();
  });

  it('reconnects when the watchdog sees 45 s of silence; pings keep it alive', async () => {
    const { server, bodies, client } = setup();
    client.start();
    await settle();
    bodies[0]!.push(frame(hello()));
    await settle();
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      bodies[0]!.push(': ping\n\n');
      await settle();
    }
    expect(client.getSnapshot().state).toBe('live');
    expect(server.callsTo('GET /stream')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(bodies[0]!.cancelled).toBe(true);
    expect(client.getSnapshot().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.callsTo('GET /stream')).toHaveLength(2);
    client.stop();
  });

  it('backs off exponentially with jitter up to the cap, honoring Retry-After on 429', async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(attempt => backoffDelay(attempt, () => 0))).toEqual(
      [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(backoffDelay(10, () => 0.999999)).toBeLessThanOrEqual(30_000);
    expect(backoffDelay(10, () => 0.999999)).toBeGreaterThan(29_000);

    const { server, client } = setup();
    server.once('GET /stream', () => json(503, { error: { code: 'unavailable', message: 'Shutting down' } }));
    server.once('GET /stream', () => json(503, { error: { code: 'unavailable', message: 'Shutting down' } }));
    server.once('GET /stream', () => json(429, { error: { code: 'too_many_requests', message: 'Slow down' } }, { 'Retry-After': '20' }));
    client.start();
    await settle();
    expect(client.getSnapshot()).toMatchObject({ state: 'reconnecting', attempt: 1 });
    expect(client.getSnapshot().lastError?.code).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(750);                     // attempt 0: 750 ms
    expect(server.callsTo('GET /stream')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_499);                   // attempt 1: 1500 ms
    expect(server.callsTo('GET /stream')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.callsTo('GET /stream')).toHaveLength(3);      // 429 with Retry-After: 20 s
    expect(client.getSnapshot().lastError?.code).toBe('too_many_requests');
    await vi.advanceTimersByTimeAsync(19_999);
    expect(server.callsTo('GET /stream')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.callsTo('GET /stream')).toHaveLength(4);
    client.stop();
  });

  it('signs out on a 401 instead of retrying', async () => {
    const onUnauthorized = vi.fn();
    const { server, client } = setup({ onUnauthorized });
    server.once('GET /stream', () => json(401, { error: { code: 'unauthenticated', message: 'Sign in again' } }));
    client.start();
    await settle();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().state).toBe('signed-out');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.callsTo('GET /stream')).toHaveLength(1);
  });

  it('reloads when hello reports a different build than the first one, once per build', async () => {
    const { bodies, client, reload } = setup();
    client.start();
    await settle();
    bodies[0]!.push(frame(hello({ buildId: 'build-1' })));
    await settle();
    expect(reload).not.toHaveBeenCalled();
    bodies[0]!.end();
    await vi.advanceTimersByTimeAsync(1_000);
    bodies[1]!.push(frame(hello({ buildId: 'build-2' })));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().state).toBe('signed-out');
  });

  it('reloads for an injected expected build, but never loops on the same mismatch', async () => {
    const storage = createMemoryStorage();
    const first = setup({ expectedBuildId: 'page-build', storage });
    first.client.start();
    await settle();
    first.bodies[0]!.push(frame(hello({ buildId: 'server-build' })));
    await settle();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // After the reload the page still carries 'page-build': accept instead of reloading forever.
    const second = setup({ expectedBuildId: 'page-build', storage });
    second.client.start();
    await settle();
    second.bodies[0]!.push(frame(hello({ buildId: 'server-build' })));
    await settle();
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.client.getSnapshot().state).toBe('live');
    second.client.stop();
  });

  it('goes offline without polling and reconnects immediately when back online', async () => {
    let online = false;
    const { server, bodies, client, target } = setup({ online: () => online });
    client.start();
    expect(client.getSnapshot().state).toBe('offline');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(server.calls).toHaveLength(0);
    online = true;
    target.dispatchEvent(new Event('online'));
    await settle();
    expect(server.callsTo('GET /stream')).toHaveLength(1);
    bodies[0]!.push(frame(hello()));
    await settle();
    expect(client.getSnapshot().state).toBe('live');
    online = false;
    target.dispatchEvent(new Event('offline'));
    expect(client.getSnapshot().state).toBe('offline');
    expect(bodies[0]!.cancelled).toBe(true);
    client.stop();
  });

  it('skips malformed messages and keeps the connection', async () => {
    const { bodies, client, events } = setup();
    client.start();
    await settle();
    bodies[0]!.push('event: hello\ndata: {not json\n\n' + 'data: {"type":"unknown"}\n\n' + frame(hello()));
    await settle();
    expect(events.map(item => item.event.type)).toEqual(['hello']);
    client.stop();
  });

  it('handles a frame split across many chunks', async () => {
    const { bodies, client, events } = setup();
    client.start();
    await settle();
    const text = frame(hello({ activeEventId: liveDispute.eventId }));
    for (let index = 0; index < text.length; index += 5) {
      bodies[0]!.push(text.slice(index, index + 5));
      await settle();
    }
    expect(events.map(item => item.event.type)).toEqual(['hello']);
    client.stop();
  });
});
