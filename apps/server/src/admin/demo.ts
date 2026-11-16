// `npm run admin:demo`: serves the console against an in-memory scripted event. No Discord, no PostgreSQL.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../config.js';
import { startServer } from '../server.js';
import { readAdminConfig } from './config.js';
import { createAdminHandler, type AdminHandler, type AdminHandlerOptions } from './mount.js';
import { DemoAdminRuntime, type DemoAdminRuntimeOptions, type DemoRoomProvider } from './runtime/demo-runtime.js';
import { MemoryEvidenceStore } from '../evidence/store.js';
import { createEvidenceSeams } from '../evidence/seams.js';
import { demoReplyDelivery } from '../evidence/replies.js';
import { tmpdir } from 'node:os';
import { MemoryModerationFlagStore } from '../moderation/flags.js';
import { MemoryModerationSettingsStore } from '../moderation/settings.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { MemoryVoiceBotRegistry } from '../voice/tokens.js';
import { createDemoGuild } from '../admin-tools/demo-guild.js';
import { MemoryAdminToolsSettingsStore } from '../admin-tools/settings.js';
import { AdminToolsRuntimeState } from '../admin-tools/status.js';
import { discordFeatures } from '../discord/feature-registry.js';
import { demoPermissionMonitor } from '../permissions/demo.js';
import { PermissionMonitor } from '../permissions/monitor.js';
import { seedDemoOps } from './demo-seed.js';
import { enableDemoCaseSeed } from '../admin-tools/members/demo-cases.js';
import { demoMatchRoomService, voiceRoomPolicyDropper, type MatchRoomSystem } from '../admin-tools/match-rooms/service.js';
import { matchRoomsRouteModule } from '../admin-tools/match-rooms/routes.js';
import { adminToolsRouteModules } from '../admin-tools/route-registry.js';
import type { MatchRoomService } from '../admin-tools/match-rooms/service-port.js';
import type { AdminToolsRouteModule } from '../admin-tools/module.js';
import { demoRoomChatPort, MemoryTranscriptStore } from '../admin-tools/match-rooms/transcripts.js';
import { DEMO_CHANNEL_IDS } from '../admin-tools/demo-guild.js';
import { DEMO_ADMIN_ID } from './runtime/demo-runtime.js';

/** Synthetic Discord server for the demo's in-memory moderation settings. */
export const DEMO_GUILD_ID = '100000000000000001';

/** Where demo evidence files live: a per-process OS temp directory, never data/evidence. */
export function demoEvidenceRoot(): string { return join(tmpdir(), 'tcg-live-demo-evidence', String(process.pid)); }

/** The demo tournament's game, for room and category names. */
export const DEMO_GAME_LABEL = 'One Piece';

/**
 * The demo's match room pool: a memory pool on the DemoGuild, starting from its voice rooms "🎮 M1" and "🎮 M2". Renames show
 * "queued" for a moment before they apply, and are limited to 2 per 10 minutes like Discord's.
 */
export async function demoMatchRooms(ops: Pick<AdminHandlerOptions, 'moderation' | 'adminTools'>, runtime: () => DemoAdminRuntime | undefined): Promise<MatchRoomSystem | null> {
  const tools = ops.adminTools;
  if (!tools?.demo) return null;
  const context = () => runtime()?.roomContext() ?? null;
  const system = await demoMatchRoomService({ demo: tools.demo, applicationId: '910000000000000000', adminId: DEMO_ADMIN_ID, botId: '200000000000000099',
    audit: tools.audit, chat: demoRoomChatPort(), transcripts: new MemoryTranscriptStore(),
    seed: [{ channelId: DEMO_CHANNEL_IDS.matchM1, table: 1 }, { channelId: DEMO_CHANNEL_IDS.matchM2, table: 2 }],
    ...(ops.moderation ? { forgetVoiceRoom: voiceRoomPolicyDropper(ops.moderation.settings, DEMO_GUILD_ID) } : {}),
    activeEvent: async () => {
      const found = context();
      return found ? { eventId: found.eventId, eventName: null, gameLabel: DEMO_GAME_LABEL, round: 1, roundRooms: found.roundRooms, finished: found.finished } : null;
    } });
  return system;
}

/**
 * The route modules a demo handler mounts. The Rooms module gets an explicit service (null: 503), so a demo never falls back to
 * the process-global service the live runtime attaches: an in-dashboard practice demo must not reach the real server's rooms.
 */
export function demoRouteModules(rooms: MatchRoomService | null): readonly AdminToolsRouteModule[] {
  return adminToolsRouteModules.map(module => module.name === 'match-rooms' ? matchRoomsRouteModule({ service: rooms }) : module);
}

/** In-memory evidence, moderation and admin-tools routes for the demo: nothing touches PostgreSQL or data/. */
export function demoOpsOptions(): Pick<AdminHandlerOptions, 'evidence' | 'moderation' | 'adminTools'> {
  const audit = new MemoryOpsAuditStore();
  const settings = new MemoryAdminToolsSettingsStore(audit);
  const demo = createDemoGuild(DEMO_GUILD_ID);
  return {
    // Demo uploads go to a per-process OS temp directory, never data/evidence.
    evidence: { store: new MemoryEvidenceStore(audit), audit,
      seams: createEvidenceSeams({ root: demoEvidenceRoot() }).seams, replyDelivery: demoReplyDelivery() },
    moderation: { settings: new MemoryModerationSettingsStore(audit), flags: new MemoryModerationFlagStore(audit), audit,
      voiceBots: new MemoryVoiceBotRegistry(), guildId: () => DEMO_GUILD_ID },
    // Admin tools act on a synthetic server (members, bans, roles, channels); route modules use Memory* stores.
    adminTools: { settings, audit, storage: 'memory', guildId: () => DEMO_GUILD_ID,
      status: new AdminToolsRuntimeState(discordFeatures(), 'demo'), demo, modules: demoRouteModules(null),
      // A synthetic bot with a couple of missing permissions, so the permission card and banner have something to show.
      permissions: demoPermissionMonitor(demo, settings) }
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
  const ops = demoOpsOptions();
  // The demo pool is the one source of room IDs: the runtime asks it for a published round's rooms.
  let runtimeRef: DemoAdminRuntime | undefined;
  const roomSystem = await demoMatchRooms(ops, () => runtimeRef);
  const rooms: DemoRoomProvider | undefined = roomSystem ? { provision: ({ eventId, matches }) => roomSystem.pool.provision({
    eventId, eventName: null, gameLabel: DEMO_GAME_LABEL, round: 1, matches: matches.map(id => ({ id, pair: [] })), savedRooms: {} }) } : undefined;
  // TCG_ADMIN_DEMO_MODE picks autoplay (default) or interactive; an explicit runtime option wins.
  const runtime = new DemoAdminRuntime({ mode: adminConfig.demoMode, ...(rooms ? { rooms } : {}), ...options.runtime });
  runtimeRef = runtime;
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
    await roomSystem?.start();
    // The Rooms tab talks to this demo's own pool, by explicit module: never through the global service.
    ops.adminTools!.modules = demoRouteModules(roomSystem?.service ?? null);
    // Sample cases, flags and evidence so every screen has something to show (the real demo only, not tests).
    const seed = !options.ephemeral;
    if (seed && ops.adminTools?.demo) enableDemoCaseSeed(ops.adminTools.demo);
    if (seed && ops.moderation && ops.evidence) seedDemoOps(runtime, { guildId: DEMO_GUILD_ID, flags: ops.moderation.flags, evidence: ops.evidence.store,
      evidenceRoot: demoEvidenceRoot() });
    const permissions = ops.adminTools?.permissions;
    if (permissions instanceof PermissionMonitor) {
      runtime.attachPermissions(permissions);
      void permissions.recheck();
    }
    handler = (options.createHandler ?? createAdminHandler)({
      runtime, port: server.port, mode: 'demo', commandsEnabled: true, webDist: options.webDist ?? adminConfig.webDist,
      ...ops,
      ...(options.ephemeral ? {} : { devOrigin: adminConfig.devOrigin, fixedLoginToken: adminConfig.fixedLoginToken })
    });
    runtime.start();
  } catch (error) {
    await roomSystem?.stop();
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
            await roomSystem?.stop();
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
