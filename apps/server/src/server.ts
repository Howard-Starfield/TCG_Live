import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AdminHandler } from './admin/mount.js';
import type { AppConfig } from './config.js';
import { isEvidenceUploadRequest } from './evidence/routes.js';
import { createProbe } from './probe.js';

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

function json(response: ServerResponse, code: number, status: string, allowGet = false): void {
  response.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(allowGet ? { Allow: 'GET' } : {})
  });
  response.end(JSON.stringify({ status }));
}

export interface ServerOptions {
  /** Optional admin console. Consulted for every path except exactly /livez and /readyz. */
  admin?: AdminHandler;
  /** Timeouts; the defaults suit production. */
  timeouts?: Partial<ServerTimeouts>;
  /** Requests that may take arbitrarily long while data keeps flowing; defaults to evidence file uploads. */
  isLongUpload?: (request: IncomingMessage) => boolean;
}

export interface ServerTimeouts {
  /** All request headers must arrive within this (slowloris guard, also for uploads). */
  headersMs: number;
  /** Ordinary requests must have sent their whole body within this, as Node's default requestTimeout did. */
  bodyMs: number;
  /** A long upload is aborted after this long with no data (the total time is unlimited). */
  uploadIdleMs: number;
}
export const DEFAULT_SERVER_TIMEOUTS: ServerTimeouts = { headersMs: 60_000, bodyMs: 300_000, uploadIdleMs: 60_000 };

/**
 * Node's requestTimeout is one deadline for every request, and its 300 s default kills a 2 GiB upload on
 * any link slower than about 6.8 MB/s. It is turned off here and replaced per request: ordinary requests
 * keep a total body deadline (slowloris protection), long uploads get an idle timeout instead.
 */
function guardRequest(request: IncomingMessage, response: ServerResponse, timeouts: ServerTimeouts, longUpload: boolean): void {
  if (longUpload) {
    const socket = request.socket;
    socket.setTimeout(timeouts.uploadIdleMs, () => {
      // No bytes either way for uploadIdleMs: the client stalled (or the server is stuck); free the socket.
      socket.destroy();
    });
    // After the response, Node sets the keep-alive timeout on the same socket, replacing this value.
    return;
  }
  if (request.complete) return;
  const timer = setTimeout(() => {
    if (!request.complete) request.socket.destroy();
  }, timeouts.bodyMs);
  timer.unref();
  const clear = () => clearTimeout(timer);
  request.once('end', clear);
  request.once('close', clear);
  response.once('close', clear);
}

export async function startServer(config: AppConfig, options: ServerOptions = {}): Promise<RunningServer> {
  const admin = options.admin;
  const probe = config.database ? createProbe(config.database) : null;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const timeouts: ServerTimeouts = { ...DEFAULT_SERVER_TIMEOUTS, ...options.timeouts };
  const isLongUpload = options.isLongUpload ?? isEvidenceUploadRequest;
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url;
    guardRequest(request, response, timeouts, isLongUpload(request));
    if (path !== '/livez' && path !== '/readyz') {
      try {
        if (admin?.handle(request, response)) return;
      } catch {
        if (!response.headersSent) json(response, 500, 'internal_error');
        else response.destroy();
        return;
      }
      json(response, 404, 'not_found');
      return;
    }
    if (request.method !== 'GET') {
      json(response, 405, 'method_not_allowed', true);
      return;
    }
    if (path === '/livez') {
      json(response, 200, 'live');
      return;
    }
    if (!probe) {
      json(response, 503, 'not_configured');
      return;
    }
    if (stopping) {
      json(response, 503, 'unavailable');
      return;
    }
    void probe.check().then(ready => {
      if (!response.destroyed) json(response, ready && !stopping ? 200 : 503, ready && !stopping ? 'ready' : 'unavailable');
    }).catch(() => {
      if (!response.destroyed) json(response, 503, 'unavailable');
    });
  });

  server.requestTimeout = 0;
  server.headersTimeout = timeouts.headersMs;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error('Startup failed: PORT is already in use on 127.0.0.1.');
    }
    throw new Error('Startup failed: cannot listen on 127.0.0.1.');
  }

  return {
    port: (server.address() as { port: number }).port,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      const probeStopped = probe?.cancel() ?? Promise.resolve();
      // Admin streams must end before server.close() can complete.
      const adminStopped = admin ? admin.close().catch(() => {}) : Promise.resolve();
      const httpStopped = adminStopped.then(() => new Promise<void>(resolve => {
        const fallback = setTimeout(() => server.closeAllConnections(), 5_000);
        server.close(() => {
          clearTimeout(fallback);
          resolve();
        });
      }));
      stopPromise = Promise.all([httpStopped, probeStopped]).then(() => {});
      return stopPromise;
    }
  };
}
