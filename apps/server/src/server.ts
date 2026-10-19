import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AdminHandler } from './admin/mount.js';
import type { AppConfig } from './config.js';
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
}

export async function startServer(config: AppConfig, options: ServerOptions = {}): Promise<RunningServer> {
  const admin = options.admin;
  const probe = config.database ? createProbe(config.database) : null;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url;
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
    port: config.port,
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
