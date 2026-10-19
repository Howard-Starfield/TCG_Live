import type { SessionDto } from '@tcg-live/core';
import { liveDispute } from '@tcg-live/core/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createAdminData } from './admin-data';
import { createApiClient } from './client';
import { ApiError } from './errors';
import { checkConsoleLink, consumeLoginFragment, launchTokenFromInput, SESSION_TOKEN_KEY, SessionController } from './session';
import { createMemoryStorage } from './storage';
import { FakeServer, flush, json, noContent } from './test/fakes';

const SESSION: SessionDto = {
  principal: { kind: 'local', id: 'local-admin', label: 'Local admin' },
  capabilities: ['dashboard.read', 'panels.refresh'], expiresAtMs: 2e12, idleExpiresAtMs: 2e12,
  mode: 'demo', commandsEnabled: true
};

function fakeLocation(hash: string) {
  const location = { hash, pathname: '/console', search: '?x=1' };
  const history = {
    state: { from: 'test' },
    replaceState: vi.fn((_state: unknown, _unused: string, url?: string | null) => {
      location.hash = url?.includes('#') ? url.slice(url.indexOf('#')) : '';
    })
  };
  return { location, history };
}

describe('API client', () => {
  it('maps ErrorDto bodies to ApiError with code, status, message and snapshot', async () => {
    const server = new FakeServer();
    server.once('GET /status', () => json(409, { error: { code: 'conflict', message: 'Stale' }, snapshot: liveDispute }));
    const api = createApiClient({ fetch: server.fetch, getToken: () => 't' });
    const error = await api.getStatus().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'conflict', status: 409, message: 'Stale' });
    expect((error as ApiError).snapshot?.eventId).toBe(liveDispute.eventId);
  });

  it('maps bodiless errors by status, and fetch failures to network errors', async () => {
    const server = new FakeServer();
    server.once('GET /events', () => new Response('oops', { status: 500 }));
    server.once('GET /events', () => new Response('', { status: 422 }));
    server.once('GET /events', () => { throw new TypeError('Failed to fetch'); });
    const api = createApiClient({ fetch: server.fetch, getToken: () => null });
    await expect(api.listEvents()).rejects.toMatchObject({ code: 'internal', status: 500 });
    await expect(api.listEvents()).rejects.toMatchObject({ code: 'rule', status: 422 });
    await expect(api.listEvents()).rejects.toMatchObject({ code: 'network', status: 0 });
  });

  it('injects the bearer token, builds audit query strings, and passes AbortSignal through', async () => {
    const server = new FakeServer();
    server.always('GET /events/abc%2Fdef/audit', () => json(200, []));
    const api = createApiClient({ fetch: server.fetch, getToken: () => 'secret', baseUrl: 'http://127.0.0.1:3000' });
    await api.getAudit('abc/def', { after: 4, limit: 50 });
    const call = server.calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:3000/api/v1/events/abc%2Fdef/audit?after=4&limit=50');
    expect(call.headers.Authorization).toBe('Bearer secret');
    const controller = new AbortController();
    controller.abort();
    await expect(api.getAudit('abc/def', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('calls onUnauthorized with the token it sent, only for authenticated requests', async () => {
    const server = new FakeServer();
    server.always('GET /session', () => json(401, { error: { code: 'unauthenticated', message: 'no' } }));
    server.always('POST /session', () => json(401, { error: { code: 'unauthenticated', message: 'bad link' } }));
    const onUnauthorized = vi.fn();
    const api = createApiClient({ fetch: server.fetch, getToken: () => 'old', onUnauthorized });
    await expect(api.getSession()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledWith(expect.any(ApiError), 'old');
    await expect(api.createSession('launch')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(server.calls[1]!.headers.Authorization).toBeUndefined();
  });
});

describe('fragment login', () => {
  it('reads #login= and strips it, keeping other fragment parameters', () => {
    const { location, history } = fakeLocation('#view=match&login=abc_DEF-123');
    expect(consumeLoginFragment(location, history)).toBe('abc_DEF-123');
    expect(history.replaceState).toHaveBeenCalledWith({ from: 'test' }, '', '/console?x=1#view=match');
    expect(consumeLoginFragment(fakeLocation('#/__kit').location, history)).toBeNull();
  });

  it('accepts pasted links or bare tokens', () => {
    expect(launchTokenFromInput(' http://127.0.0.1:3000/#login=tok123 ')).toBe('tok123');
    expect(launchTokenFromInput('tok123')).toBe('tok123');
    expect(launchTokenFromInput('http://127.0.0.1:3000/')).toBeNull();
    expect(launchTokenFromInput('')).toBeNull();
  });

  it('strips history before any await, then exchanges the token for a stored bearer session', async () => {
    const server = new FakeServer();
    server.once('POST /session', () => json(200, { token: 'bearer-1', session: SESSION }));
    const storage = createMemoryStorage();
    const { location, history } = fakeLocation('#login=launch-token');
    const data = createAdminData({ fetch: server.fetch, sessionStorage: storage, location, history,
      stream: { eventTarget: null, isOnline: () => false } });
    data.start();
    // Synchronously, before the POST resolves:
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe('');
    expect(data.session.getState().status).toBe('signing-in');
    await flush();
    expect(server.callsTo('POST /session')[0]!.body).toEqual({ token: 'launch-token' });
    expect(storage.getItem(SESSION_TOKEN_KEY)).toBe('bearer-1');
    expect(data.session.getState()).toEqual({ status: 'signed-in', session: SESSION });
    expect(localStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(data.stream.getSnapshot().state).toBe('offline');   // the stream started with the session
    data.stop();
  });

  it('shows an error state for a rejected link', async () => {
    const server = new FakeServer();
    server.once('POST /session', () => json(401, { error: { code: 'unauthenticated', message: 'Invalid link' } }));
    const { location, history } = fakeLocation('#login=stale');
    const session = new SessionController({ api: createApiClient({ fetch: server.fetch, getToken: () => null }),
      storage: createMemoryStorage(), location, history });
    await session.bootstrap();
    const state = session.getState();
    expect(state.status).toBe('error');
    expect(state.status === 'error' && state.error.code).toBe('unauthenticated');
  });
});

describe('session lifecycle', () => {
  function signedIn() {
    const server = new FakeServer();
    server.once('GET /session', () => json(200, SESSION));
    const storage = createMemoryStorage();
    storage.setItem(SESSION_TOKEN_KEY, 'bearer-1');
    const data = createAdminData({ fetch: server.fetch, sessionStorage: storage, location: null, history: null,
      stream: { eventTarget: null, isOnline: () => false } });
    return { server, storage, data };
  }

  it('validates a stored token on bootstrap', async () => {
    const { server, data } = signedIn();
    data.start();
    expect(data.session.getState().status).toBe('signing-in');
    await flush();
    expect(server.callsTo('GET /session')[0]!.headers.Authorization).toBe('Bearer bearer-1');
    expect(data.session.getState().status).toBe('signed-in');
    expect(data.session.hasCapability('panels.refresh')).toBe(true);
    expect(data.session.hasCapability('match.correct')).toBe(false);
    data.stop();
  });

  it('a 401 on any request clears the token and signs out', async () => {
    const { server, storage, data } = signedIn();
    server.once('GET /status', () => json(401, { error: { code: 'unauthenticated', message: 'Expired' } }));
    data.start();
    await flush();
    data.queryClient.setQueryData(['admin', 'events'], []);
    await expect(data.api.getStatus()).rejects.toMatchObject({ status: 401 });
    expect(data.session.getState()).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(storage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(data.stream.getSnapshot().state).toBe('signed-out');
    expect(data.queryClient.getQueryData(['admin', 'events'])).toBeUndefined();
    data.stop();
  });

  it('a stale stored token ends signed out', async () => {
    const server = new FakeServer();
    server.once('GET /session', () => json(401, { error: { code: 'unauthenticated', message: 'Expired' } }));
    const storage = createMemoryStorage();
    storage.setItem(SESSION_TOKEN_KEY, 'old');
    const data = createAdminData({ fetch: server.fetch, sessionStorage: storage, location: null, history: null,
      stream: { eventTarget: null } });
    data.start();
    await flush();
    expect(data.session.getState()).toEqual({ status: 'signed-out', reason: 'expired' });
    data.stop();
  });

  it('logout deletes the server session and forgets the token; rotateLink posts', async () => {
    const { server, storage, data } = signedIn();
    server.once('POST /session/rotate-link', () => noContent());
    server.once('DELETE /session', () => noContent());
    data.start();
    await flush();
    await data.session.rotateLink();
    expect(server.callsTo('POST /session/rotate-link')[0]!.headers.Authorization).toBe('Bearer bearer-1');
    await data.session.logout();
    expect(server.callsTo('DELETE /session')[0]!.headers.Authorization).toBe('Bearer bearer-1');
    expect(storage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(data.session.getState()).toEqual({ status: 'signed-out', reason: 'logged-out' });
    data.stop();
  });

  it('logout still signs out locally when the server is unreachable', async () => {
    const { server, data } = signedIn();
    server.once('DELETE /session', () => { throw new TypeError('offline'); });
    data.start();
    await flush();
    await data.session.logout();
    expect(data.session.getState()).toEqual({ status: 'signed-out', reason: 'logged-out' });
    data.stop();
  });

  it('ignores a 401 for a request sent with a replaced token', () => {
    const storage = createMemoryStorage();
    storage.setItem(SESSION_TOKEN_KEY, 'new');
    const session = new SessionController({ api: createApiClient({ fetch: new FakeServer().fetch, getToken: () => null }),
      storage, location: null, history: null });
    session.handleUnauthorized('old');
    expect(storage.getItem(SESSION_TOKEN_KEY)).toBe('new');
  });
});

describe('pasted console links (Wave 2 review)', () => {
  it('refuses a link printed for another origin and names it', () => {
    const result = checkConsoleLink('http://127.0.0.1:3000/#login=abc', 'http://127.0.0.1:4410');
    expect(result).toEqual({ ok: false, message: expect.stringContaining('belongs to the console at http://127.0.0.1:3000') });
    expect(checkConsoleLink('http://127.0.0.1:4410/#login=abc', 'http://127.0.0.1:4410')).toEqual({ ok: true, token: 'abc' });
    expect(checkConsoleLink('abc-token', 'http://127.0.0.1:4410')).toEqual({ ok: true, token: 'abc-token' });
    expect(checkConsoleLink('   ', null).ok).toBe(false);
  });

  it('login() never posts a token from another origin', async () => {
    const server = new FakeServer();
    const api = createApiClient({ fetch: server.fetch, getToken: () => null });
    const location = { hash: '', pathname: '/', search: '', origin: 'http://127.0.0.1:4410' };
    const controller = new SessionController({ api, storage: createMemoryStorage(), location, history: null });
    await controller.login('http://localhost:5173/#login=foreign');
    expect(server.calls).toHaveLength(0);
    const state = controller.getState();
    expect(state.status).toBe('error');
    expect(state.status === 'error' && state.error.message).toContain('http://localhost:5173');
  });
});
