// `npm run admin:demo`: serves the console against an in-memory scripted event. No Discord, no PostgreSQL.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../config.js';
import { startServer } from '../server.js';
import { readAdminConfig } from './config.js';
import { createAdminHandler, type AdminHandler, type AdminHandlerOptions } from './mount.js';
import { DemoAdminRuntime, type DemoAdminRuntimeOptions } from './runtime/demo-runtime.js';
import { MemoryEvidenceStore } from '../evidence/store.js';
import { createEvidenceSeams } from '../evidence/seams.js';
import { tmpdir } from 'node:os';
import { MemoryModerationFlagStore } from '../moderation/flags.js';
import { MemoryModerationSettingsStore } from '../moderation/settings.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { MemoryVoiceBotRegistry } from '../voice/tokens.js';
import { createDemoGuild } from '../admin-tools/demo-guild.js';
import { MemoryAdminToolsSettingsStore } from '../admin-tools/settings.js';
import { AdminToolsRuntimeState } from '../admin-tools/status.js';
import { discordFeatures } from '../discord/feature-registry.js';

/** Synthetic Discord server for the demo's in-memory moderation settings. */
export const DEMO_GUILD_ID = '100000000000000001';

/** In-memory evidence, moderation and admin-tools routes for the demo: nothing touches PostgreSQL or data/. */
export function demoOpsOptions(): Pick<AdminHandlerOptions, 'evidence' | 'moderation' | 'adminTools'> {
  const audit = new MemoryOpsAuditStore();
  return {
    // Demo uploads go to a per-process OS temp directory, never data/evidence.
    evidence: { store: new MemoryEvidenceStore(audit), audit,
      seams: createEvidenceSeams({ root: join(tmpdir(), 'tcg-live-demo-evidence', String(process.pid)) }).seams },
    moderation: { settings: new MemoryModerationSettingsStore(audit), flags: new MemoryModerationFlagStore(audit), audit,
      voiceBots: new MemoryVoiceBotRegistry(), guildId: () => DEMO_GUILD_ID },
    // Admin tools act on a synthetic server (members, bans, roles, channels); route modules use Memory* stores.
    adminTools: { settings: new MemoryAdminToolsSettingsStore(audit), audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
      status: new AdminToolsRuntimeState(discordFeatures(), 'demo'), demo: createDemoGuild(DEMO_GUILD_ID) }
  };
}

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
  ephemeral?: boolean;
  webDist?: string;
  createHandler?: (options: AdminHandlerOptions) => AdminHandler;
}

export async function runAdminDemo(options: AdminDemoOptions = {}): Promise<AdminDemo> {
  const env = options.env ?? process.env;
  const write = options.write ?? (text => { process.stdout.write(text); });
  // Only PORT matters here; the demo never connects to PostgreSQL.
  const requestedPort = options.ephemeral ? 0 : readConfig({ PORT: env.PORT }).port;
  const adminConfig = readAdminConfig('demo', env);
  // TCG_ADMIN_DEMO_MODE picks autoplay (default) or interactive; an explicit runtime option wins.
  const runtime = new DemoAdminRuntime({ mode: adminConfig.demoMode, ...options.runtime });
  let handler: AdminHandler | undefined;
  const adapter: AdminHandler = {
    handle: (request, response) => handler?.handle(request, response) ?? false,
    loginUrl: () => handler?.loginUrl() ?? null,
    rotateLoginUrl: () => handler!.rotateLoginUrl(),
    close: async () => { await handler?.close(); }
  };
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ port: requestedPort, database: null }, { admin: adapter });
    handler = (options.createHandler ?? createAdminHandler)({
      runtime, port: server.port, mode: 'demo', commandsEnabled: true, webDist: options.webDist ?? adminConfig.webDist,
      ...demoOpsOptions(),
      ...(options.ephemeral ? {} : { devOrigin: adminConfig.devOrigin, fixedLoginToken: adminConfig.fixedLoginToken })
    });
    runtime.start();
  } catch (error) {
    await server?.stop();
    await runtime.close();
    throw error;
  }
  const running = server;
  const port = running.port;
  write(`TCG Live admin demo listening on 127.0.0.1:${port} (${runtime.playMode})\n`);
  const url = handler.loginUrl();
  write(url ? `Admin console: ${url}\n` : 'Admin console link unavailable: the admin HTTP layer did not issue a launch token.\n');
  if (!existsSync(join(adminConfig.webDist, 'index.html')))
    write('Web assets not found; run npm run build:web for the console UI (the API is served regardless).\n');
  let stopping: Promise<void> | undefined;
  return {
    port, runtime, handler,
    stop() {
      stopping ??= (async () => {
        await adapter.close().catch(() => {});
        await runtime.close();
        await running.stop();
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
