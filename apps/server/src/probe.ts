import pg from 'pg';
import type { DatabaseConfig } from './config.js';

const BUDGET_MS = 2_000;

export interface Probe {
  check(): Promise<boolean>;
  cancel(): Promise<void>;
}

export function createProbe(config: DatabaseConfig): Probe {
  let inFlight: Promise<boolean> | undefined;
  let activeClient: pg.Client | undefined;
  let cancelled = false;

  function connectionStream(client: pg.Client): (NodeJS.EventEmitter & { destroy(): void }) | undefined {
    const connection = client as pg.Client & { connection?: { stream?: NodeJS.EventEmitter & { destroy(): void } } };
    return connection.connection?.stream;
  }

  function destroyConnection(client: pg.Client): void {
    connectionStream(client)?.destroy();
  }

  async function attempt(): Promise<boolean> {
    const driverConfig: pg.ClientConfig & { sslnegotiation: string } = {
      ...config,
      ssl: false,
      sslnegotiation: 'postgres',
      options: '-c statement_timeout=1500',
      connectionTimeoutMillis: 1_500,
      query_timeout: 1_500,
      statement_timeout: 1_500,
      application_name: 'tcg_live_health'
    };
    const client = new pg.Client(driverConfig);
    activeClient = client;
    // Socket errors can arrive after a failed connection or query.
    client.on('error', () => {});
    const stream = connectionStream(client);
    const socketClosed = new Promise<void>(resolve => {
      if (stream) stream.once('close', () => resolve());
      else resolve();
    });
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = (async () => {
        await client.connect();
        if (cancelled) return false;
        await client.query('SELECT 1');
        return !cancelled;
      })();
      const deadline = new Promise<false>(resolve => {
        timer = setTimeout(() => {
          destroyConnection(client);
          resolve(false);
        }, BUDGET_MS);
      });
      return await Promise.race([work, deadline]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      const remaining = Math.max(0, BUDGET_MS - (Date.now() - started));
      let cleanupTimer: NodeJS.Timeout | undefined;
      let cleaned = false;
      try {
        const gracefulCleanup = (async () => {
          try { await client.end(); } catch { /* Probe remains unavailable. */ }
          await socketClosed;
          cleaned = true;
        })();
        await Promise.race([
          gracefulCleanup,
          new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, remaining); })
        ]);
      } catch {
        // Readiness stays unavailable; driver failures are never exposed.
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
        if (!cleaned) destroyConnection(client);
      }
      if (activeClient === client) activeClient = undefined;
    }
  }

  return {
    check(): Promise<boolean> {
      if (cancelled) return Promise.resolve(false);
      if (!inFlight) {
        inFlight = attempt().finally(() => { inFlight = undefined; });
      }
      return inFlight;
    },
    cancel(): Promise<void> {
      cancelled = true;
      if (activeClient) destroyConnection(activeClient);
      return inFlight?.then(() => {}) ?? Promise.resolve();
    }
  };
}
