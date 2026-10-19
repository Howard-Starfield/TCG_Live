// `npm run admin:demo`: serves the console against an in-memory scripted event. No Discord, no PostgreSQL.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../config.js';
import { startServer } from '../server.js';
import { readAdminConfig } from './config.js';
import { createAdminHandler, type AdminHandler, type AdminHandlerOptions } from './mount.js';
import { DemoAdminRuntime, type DemoAdminRuntimeOptions } from './runtime/demo-runtime.js';

export interface AdminDemo {
  port: number;
  runtime: DemoAdminRuntime;
  handler: AdminHandler;
  /** Handler first (ends streams), then the scenario, then the HTTP server. Idempotent. */
  stop(): Promise<void>;
}

export interface AdminDemoOptions {
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  runtime?: DemoAdminRuntimeOptions;
  createHandler?: (options: AdminHandlerOptions) => AdminHandler;
}

export async function runAdminDemo(options: AdminDemoOptions = {}): Promise<AdminDemo> {
  const env = options.env ?? process.env;
  const write = options.write ?? (text => { process.stdout.write(text); });
  // Only PORT matters here; the demo never connects to PostgreSQL.
  const { port } = readConfig({ PORT: env.PORT });
  const adminConfig = readAdminConfig('demo', env);
  const runtime = new DemoAdminRuntime(options.runtime);
  const handler = (options.createHandler ?? createAdminHandler)({
    runtime, port, mode: 'demo', commandsEnabled: true, webDist: adminConfig.webDist,
    devOrigin: adminConfig.devOrigin, fixedLoginToken: adminConfig.fixedLoginToken
  });
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ port, database: null }, { admin: handler });
  } catch (error) {
    await handler.close().catch(() => {});
    await runtime.close();
    throw error;
  }
  runtime.start();
  write(`TCG Live admin demo listening on 127.0.0.1:${port}\n`);
  const url = handler.loginUrl();
  write(url ? `Admin console: ${url}\n` : 'Admin console link unavailable: the admin HTTP layer did not issue a launch token.\n');
  if (!existsSync(join(adminConfig.webDist, 'index.html')))
    write('Web assets not found; run npm run build:web for the console UI (the API is served regardless).\n');
  let stopping: Promise<void> | undefined;
  return {
    port, runtime, handler,
    stop() {
      stopping ??= (async () => {
        await handler.close().catch(() => {});
        await runtime.close();
        await server.stop();
      })();
      return stopping;
    }
  };
}

async function main(): Promise<void> {
  let demo: AdminDemo;
  try {
    demo = await runAdminDemo();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Admin demo failed to start.'}\n`);
    process.exitCode = 1;
    return;
  }
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const watchdog = setTimeout(() => { process.stderr.write('Admin demo shutdown deadline exceeded.\n'); process.exit(1); }, 5_000);
    void demo.stop().then(() => {
      clearTimeout(watchdog);
      process.stdout.write('Admin demo stopped.\n');
    }, () => {
      process.stderr.write('Admin demo shutdown failed.\n');
      process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGBREAK', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) void main();
