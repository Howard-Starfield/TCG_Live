import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUDIT_PAGE_LIMIT, type Capability, type SessionDto, type SessionGrantDto } from '@tcg-live/core';
import { sessionCapabilities } from '../commands.js';
import type { AdminHandler, AdminHandlerOptions } from '../mount.js';
import { readEmptyBody, readLoginBody } from './body.js';
import { commandRoutes } from './routes-commands.js';
import { fail, HttpError, sendJson, sendNoContent, unavailable } from './respond.js';
import { SessionStore, type Session } from './sessions.js';
import { createStaticFiles, isHealthPath } from './static.js';
import { DEFAULT_STREAM_TIMINGS, StreamManager, type StreamTimings } from './stream.js';

/** Test seams; production uses the defaults. */
export interface AdminHttpInternals {
  now?: () => number;
  timings?: Partial<StreamTimings>;
  /** Capabilities held by the local principal. Defaults to decision 4: all of them only when commands are enabled. */
  capabilities?: readonly Capability[];
}

export interface AdminHttp extends AdminHandler {
  /** Open stream count, including streams still reading their first snapshot. */
  readonly streamCount: number;
  /** Whether the stream manager currently holds a runtime subscription. */
  readonly subscribed: boolean;
}

type Access = 'public' | 'session' | Capability;

interface Context {
  request: IncomingMessage;
  response: ServerResponse;
  query: URLSearchParams;
  params: string[];
  session: Session | null;
}

interface Endpoint { access: Access; run(context: Context): Promise<void> }
interface Route { pattern: RegExp; methods: Partial<Record<string, Endpoint>> }

const EVENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const DEFAULT_AUDIT_LIMIT = 200;

const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

function single(query: URLSearchParams, name: string): string | null {
  const values = query.getAll(name);
  if (values.length > 1) throw badRequest(`${name} may be given once.`);
  return values[0] ?? null;
}

function integerParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = single(query, name);
  if (raw === null) return fallback;
  if (!/^\d{1,16}$/.test(raw)) throw badRequest(`${name} must be an integer from ${min} to ${max}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw badRequest(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function eventIdParam(raw: string | undefined): string {
  if (!raw || !EVENT_ID.test(raw)) throw badRequest('Invalid event ID.');
  return raw;
}

export function createAdminHttp(options: AdminHandlerOptions, internals: AdminHttpInternals = {}): AdminHttp {
  const { runtime, port } = options;
  const now = internals.now ?? Date.now;
  const capabilities: Capability[] = [...(internals.capabilities ?? sessionCapabilities(options.commandsEnabled))];
  const print = options.printLoginUrl ?? ((url: string) => { process.stdout.write(`Admin console: ${url}\n`); });
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (options.mode === 'demo' && options.devOrigin) origins.add(options.devOrigin);
  const statics = createStaticFiles(options.webDist);
  let closed = false;
  let closing: Promise<void> | null = null;
  /** API requests still being answered; close() drops them so a slow read cannot hold shutdown open. */
  const inFlight = new Set<ServerResponse>();

  const sessions: SessionStore = new SessionStore({
    port, now, fixedLoginToken: options.mode === 'demo' ? options.fixedLoginToken : null,
    onExpire: session => streams.closeSession(session)
  });
  const streams = new StreamManager(runtime, sessions, { ...DEFAULT_STREAM_TIMINGS, ...internals.timings }, now);

  function describe(session: Session): SessionDto {
    return {
      principal: { kind: 'local', id: 'local-admin', label: 'Local admin' },
      capabilities: [...capabilities],
      ...sessions.expiry(session),
      mode: options.mode,
      commandsEnabled: options.commandsEnabled
    };
  }

  const routes: Route[] = [
    { pattern: /^\/api\/v1\/session$/, methods: {
      GET: { access: 'session', run: async ({ response, session }) => sendJson(response, 200, describe(session!)) },
      POST: { access: 'public', run: async ({ request, response }) => {
        const candidate = await readLoginBody(request);
        if (closed) throw unavailable();
        const { token, session } = sessions.login(candidate);
        const grant: SessionGrantDto = { token, session: describe(session) };
        sendJson(response, 200, grant);
      } },
      DELETE: { access: 'session', run: async ({ request, response, session }) => {
        await readEmptyBody(request);
        sessions.revoke(session!);
        streams.closeSession(session!);
        sendNoContent(response);
      } }
    } },
    { pattern: /^\/api\/v1\/session\/rotate-link$/, methods: {
      POST: { access: 'session', run: async ({ request, response }) => {
        await readEmptyBody(request);
        if (closed) throw unavailable();
        const url = sessions.rotate();
        try { print(url); } catch { /* printing is best effort; the link is still rotated */ }
        sendNoContent(response);
      } }
    } },
    { pattern: /^\/api\/v1\/status$/, methods: {
      GET: { access: 'dashboard.read', run: async ({ response }) => sendJson(response, 200, runtime.status()) }
    } },
    { pattern: /^\/api\/v1\/events$/, methods: {
      GET: { access: 'dashboard.read', run: async ({ response }) => sendJson(response, 200, await runtime.listEvents()) }
    } },
    { pattern: /^\/api\/v1\/events\/([^/]+)\/snapshot$/, methods: {
      GET: { access: 'dashboard.read', run: async ({ response, params }) =>
        sendJson(response, 200, await runtime.snapshot(eventIdParam(params[0]))) }
    } },
    { pattern: /^\/api\/v1\/events\/([^/]+)\/audit$/, methods: {
      GET: { access: 'dashboard.read', run: async ({ response, params, query }) => {
        const eventId = eventIdParam(params[0]);
        const after = integerParam(query, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = integerParam(query, 'limit', DEFAULT_AUDIT_LIMIT, 1, AUDIT_PAGE_LIMIT);
        sendJson(response, 200, await runtime.audit(eventId, after, limit));
      } }
    } },
    { pattern: /^\/api\/v1\/stream$/, methods: {
      GET: { access: 'dashboard.read', run: ({ request, response, session }) => streams.open(request, response, session!) }
    } },
    ...commandRoutes({ runtime, commandsEnabled: options.commandsEnabled, can: capability => capabilities.includes(capability) })
  ];

  async function dispatch(request: IncomingMessage, response: ServerResponse, pathname: string, search: string): Promise<void> {
    let route: Route | undefined;
    let match: RegExpExecArray | null = null;
    for (const candidate of routes) {
      match = candidate.pattern.exec(pathname);
      if (match) {
        route = candidate;
        break;
      }
    }
    if (!route || !match) throw new HttpError(404, 'not_found', 'Not found.');
    const endpoint = route.methods[request.method ?? ''];
    if (!endpoint) {
      throw new HttpError(405, 'method_not_allowed', 'Method not allowed.', { Allow: Object.keys(route.methods).join(', ') });
    }
    let session: Session | null = null;
    if (endpoint.access !== 'public') {
      session = sessions.authenticate(request.headers.authorization);
      if (!session) throw new HttpError(401, 'unauthenticated', 'Sign in with the console link.', { 'WWW-Authenticate': 'Bearer' });
      if (endpoint.access !== 'session' && !capabilities.includes(endpoint.access)) {
        throw new HttpError(403, 'forbidden', 'This session may not do that.');
      }
    }
    await endpoint.run({ request, response, query: new URLSearchParams(search), params: match.slice(1), session });
  }

  return {
    get streamCount() { return streams.size; },
    get subscribed() { return streams.subscribed; },

    handle(request, response) {
      try {
        const raw = request.url ?? '';
        if (!raw.startsWith('/')) return false;
        const queryAt = raw.indexOf('?');
        const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
        if (isHealthPath(pathname)) return false;
        const method = request.method ?? '';
        const readOnly = method === 'GET' || method === 'HEAD';
        const api = pathname === '/api' || pathname.startsWith('/api/');
        if (!closed && !api && (!readOnly || !statics.enabled())) return false;
        if (closed) {
          fail(response, unavailable());
          return true;
        }
        if (!hosts.has((request.headers.host ?? '').toLowerCase())) {
          fail(response, new HttpError(403, 'bad_host', 'Unexpected Host header.'));
          return true;
        }
        if (!api) {
          statics.serve(request, response, pathname);
          return true;
        }
        if (!readOnly && !origins.has(request.headers.origin ?? '')) {
          fail(response, new HttpError(403, 'bad_origin', 'Unexpected Origin header.'));
          return true;
        }
        inFlight.add(response);
        response.on('close', () => inFlight.delete(response));
        dispatch(request, response, pathname, queryAt === -1 ? '' : raw.slice(queryAt + 1))
          .catch(error => fail(response, error, `${method} ${pathname}`))
          .finally(() => inFlight.delete(response));
        return true;
      } catch (error) {
        fail(response, error);
        return true;
      }
    },

    loginUrl: () => sessions.loginUrl(),

    rotateLoginUrl: () => sessions.rotate(),

    close() {
      closed = true;
      closing ??= streams.close().catch(() => {}).then(() => {
        for (const response of inFlight) if (!response.writableEnded) response.destroy();
        inFlight.clear();
      });
      return closing;
    }
  };
}
