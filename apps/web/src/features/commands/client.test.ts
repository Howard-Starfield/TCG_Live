import type { AdminCommandRequestDto, AdminCommandResultDto, ErrorCode } from '@tcg-live/core';
import { liveDispute } from '@tcg-live/core/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '../../data';
import { FakeServer, json } from '../../data/test/fakes';
import { createCommandClient } from './client';
import { errorMessage, newCommandId, preconditionFor } from './model';

const applied: AdminCommandResultDto = { applied: true, result: 'resolve', version: 18, cards: 'updated', roomWarning: null };

function setup(retryDelaysMs: number[] = [10, 20]) {
  const server = new FakeServer();
  const api = createApiClient({ fetch: server.fetch, getToken: () => 'bearer-token' });
  const sleep = vi.fn(async () => {});
  const client = createCommandClient(api, { retryDelaysMs, sleep });
  return { server, client, sleep };
}

function request(): AdminCommandRequestDto {
  const command = { type: 'resolve' as const, matchId: 'M2' as const, winner: 'C' as const, reason: 'Judge ruling' };
  return { commandId: newCommandId(), eventId: liveDispute.eventId, command, precondition: preconditionFor(liveDispute, command) };
}

const failure = (status: number, code: ErrorCode, message = 'nope', extra: Record<string, unknown> = {}) =>
  () => json(status, { error: { code, message }, ...extra });

describe('command client', () => {
  it('posts the request body unchanged to /api/v1/commands with the bearer token', async () => {
    const { server, client } = setup();
    server.always('POST /commands', () => json(200, applied));
    const body = request();
    await expect(client.send(body)).resolves.toEqual(applied);
    const [call] = server.callsTo('POST /commands');
    expect(call!.headers).toMatchObject({ Authorization: 'Bearer bearer-token', 'Content-Type': 'application/json' });
    expect(call!.body).toEqual({
      commandId: body.commandId,
      eventId: liveDispute.eventId,
      command: { type: 'resolve', matchId: 'M2', winner: 'C', reason: 'Judge ruling' },
      precondition: { match: { matchId: 'M2', phase: 'paused', proposalRevision: 1, finalWinner: null, pauseGeneration: 1 } }
    });
    expect(body.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('retries a network error and a 503 with the same commandId, then returns the stored result', async () => {
    const { server, client, sleep } = setup();
    server.once('POST /commands', () => { throw new TypeError('Failed to fetch'); });
    server.once('POST /commands', failure(503, 'unavailable'));
    server.once('POST /commands', () => json(200, applied));
    const body = request();
    await expect(client.send(body)).resolves.toEqual(applied);
    const calls = server.callsTo('POST /commands');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(call => (call.body as AdminCommandRequestDto).commandId))).toEqual(new Set([body.commandId]));
    expect(calls.map(call => call.body)).toEqual([body, body, body]);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });

  it('gives up after the bounded number of attempts', async () => {
    const { server, client } = setup([1]);
    server.always('POST /commands', failure(503, 'unavailable'));
    await expect(client.send(request())).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    expect(server.callsTo('POST /commands')).toHaveLength(2);
  });

  it('does not wait for a Retry-After beyond five seconds', async () => {
    const { server, client } = setup();
    server.always('POST /commands', () => json(503, { error: { code: 'unavailable', message: 'x' } }, { 'retry-after': '30' }));
    await expect(client.send(request())).rejects.toMatchObject({ code: 'unavailable' });
    expect(server.callsTo('POST /commands')).toHaveLength(1);
  });

  it.each([
    [400, 'bad_request'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict'], [422, 'rule'], [500, 'internal']
  ] as const)('does not retry %i and rejects with code %s', async (status, code) => {
    const { server, client } = setup();
    server.always('POST /commands', failure(status, code, 'Rule says no', status === 409 ? { snapshot: liveDispute } : {}));
    const error = await client.send(request()).catch(caught => caught as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code, status });
    if (status === 409) expect((error as ApiError).snapshot?.eventId).toBe(liveDispute.eventId);
    expect(server.callsTo('POST /commands')).toHaveLength(1);
  });

  it('posts panel refreshes as { eventId } and retries them the same way', async () => {
    const { server, client } = setup();
    server.once('POST /panels/refresh', failure(503, 'unavailable'));
    server.once('POST /panels/refresh', () => json(200, { cards: 'refreshed', roomWarning: null }));
    await expect(client.refreshPanels({ eventId: liveDispute.eventId })).resolves.toEqual({ cards: 'refreshed', roomWarning: null });
    expect(server.callsTo('POST /panels/refresh').map(call => call.body)).toEqual([{ eventId: liveDispute.eventId }, { eventId: liveDispute.eventId }]);
  });

  it('fresh commandIds differ per intent', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newCommandId()));
    expect(ids.size).toBe(20);
  });
});

describe('error messages', () => {
  const error = (code: ApiError['code'], message = 'Server text') => new ApiError({ code, status: 1, message });

  it('shows the server text only for rule errors', () => {
    expect(errorMessage(error('rule', 'M2 is already final.'))).toBe('M2 is already final.');
    for (const code of ['bad_request', 'forbidden', 'not_found', 'conflict', 'unavailable', 'network', 'internal', 'too_many_requests',
      'method_not_allowed', 'unauthenticated'] as const) {
      const text = errorMessage(error(code));
      expect(text).not.toContain('Server text');
      expect(text.length).toBeGreaterThan(10);
    }
    expect(errorMessage(error('conflict'))).toMatch(/latest state/);
    // A 503 may follow a commit whose reply was lost: hedged like a network error, never "nothing changed".
    expect(errorMessage(error('unavailable'))).toMatch(/If the action went through, it appears in the activity stream/);
    expect(errorMessage(error('unavailable'))).not.toMatch(/Nothing was changed/);
    expect(errorMessage(error('forbidden'))).toMatch(/not allowed/);
  });
});
