import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AdminCommandRequestDto, AdminCommandResultDto, AuditEntryDto, EventSnapshotDto,
  EventSummaryDto, PanelRefreshResultDto, RuntimeStatusDto } from '@tcg-live/core';
import { readAdminConfig } from '../admin/config.js';
import { createAdminHandler } from '../admin/mount.js';
import { AdminNotFoundError, type AdminPrincipal, type AdminRuntime, type AdminRuntimeListener } from '../admin/runtime-types.js';
import { readConfig } from '../config.js';
import type { PrivateDiscordConfig } from '../discord/config.js';
import { loginAndWaitReady, runPrivateDiscord } from '../discord/runtime.js';
import { privateDiscordClient } from '../discord/sdk.js';
import { prepareSignupSession, requireDiscordSchema, type SessionRow } from '../discord/session.js';
import { withClient } from '../rehearsal/store.js';
import { startServer, type RunningServer } from '../server.js';
import { discordSetupDiscovery } from './discord.js';
import { SetupService } from './service.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Uses an argument list, never a shell command or untrusted URL. */
export function openDefaultBrowser(url: string, platform = process.platform,
  launch: typeof spawn = spawn): void {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/\#login=[A-Za-z0-9_-]{43}$/.test(url)) return;
  const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = launch(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* Terminal login link remains available. */ }
}

class BootstrapRuntime implements AdminRuntime {
  readonly mode = 'discord' as const;
  private readonly bootId = randomUUID();
  private readonly startedAtMs = Date.now();
  status(): RuntimeStatusDto {
    return { mode: 'discord', bootId: this.bootId, buildId: 'setup', serverTimeMs: Date.now(),
      startedAtMs: this.startedAtMs, gateway: 'connecting', database: 'not_configured',
      lease: 'not_applicable', cards: { updatePending: false },
      rooms: { enabled: false, warning: null }, commandsEnabled: false };
  }
  async listEvents(): Promise<EventSummaryDto[]> { return []; }
  async activeEventId(): Promise<string | null> { return null; }
  async snapshot(_eventId?: string): Promise<EventSnapshotDto> { throw new AdminNotFoundError('No event in setup.'); }
  async audit(_eventId: string, _after: number, _limit: number): Promise<AuditEntryDto[]> { return []; }
  subscribe(_listener: AdminRuntimeListener): () => void { return () => {}; }
  async applyAdminCommand(_request: AdminCommandRequestDto, _principal: AdminPrincipal): Promise<AdminCommandResultDto> {
    throw new AdminNotFoundError('No match commands in setup.');
  }
  async refreshPanels(_eventId: string): Promise<PanelRefreshResultDto> {
    throw new AdminNotFoundError('No match panels in setup.');
  }
  async close(): Promise<void> {}
}

async function activeSession(): Promise<SessionRow | null> {
  return withClient(async client => {
    await requireDiscordSchema(client);
    const result = await client.query<SessionRow>(
      "SELECT * FROM public.tcg_rehearsal_sessions WHERE status = 'active'");
    return result.rows[0] ?? null;
  });
}

export interface GuidedStartOptions {
  noBrowser?: boolean;
  openBrowser?: (url: string) => void;
}
export interface GuidedStartHandle { stop(): Promise<void> }

/** Guided entry; safe to import in a local harness. It never reads test credentials or starts on import. */
export async function runGuidedStart(options: GuidedStartOptions = {}): Promise<GuidedStartHandle> {
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.env.TCG_ADMIN_CONSOLE = '1';
  const adminConfig = readAdminConfig('discord');
  const healthConfig = readConfig();
  const token = process.env.TCG_DISCORD_TOKEN?.trim() || process.env.DISCORD_BOT_TOKEN?.trim() || null;
  const open = (url: string | null) => { if (!options.noBrowser && url) {
    try { (options.openBrowser ?? openDefaultBrowser)(url); } catch { /* Link is printed by the runtime. */ }
  } };
  let client: ReturnType<typeof privateDiscordClient> | null = token ? privateDiscordClient() : null;
  let setupServer: RunningServer | null = null;
  let setupHandler: ReturnType<typeof createAdminHandler> | null = null;
  let live: GuidedStartHandle | null = null;
  let liveTask: Promise<GuidedStartHandle> | null = null;
  let stopping = false;
  let stopTask: Promise<void> | null = null;
  const disconnectDiscovery = async () => {
    await client?.destroy();
    client = null;
  };
  const stop = (): Promise<void> => {
    if (stopTask) return stopTask;
    stopping = true;
    stopTask = (async () => {
      await setupHandler?.close().catch(() => {});
      await setupServer?.stop().catch(() => {});
      await client?.destroy().catch(() => {});
      if (liveTask) live = await liveTask.catch(() => null);
      await live?.stop().catch(() => {});
    })();
    return stopTask;
  };
  let setup!: SetupService;
  const launchBootstrap = async () => {
    if (stopping) return;
    setupHandler = createAdminHandler({ runtime: new BootstrapRuntime(), port: healthConfig.port,
      mode: 'discord', commandsEnabled: false, webDist: adminConfig.webDist, setup });
    setupServer = await startServer(healthConfig, { admin: setupHandler });
    const link = setupHandler.loginUrl();
    if (link) { process.stdout.write(`Admin setup: ${link}\n`); open(link); }
    process.stdout.write(`Guided setup listening on 127.0.0.1:${healthConfig.port}.\n`);
  };
  const connectDiscovery = async () => {
    if (!token || stopping) return;
    client ??= privateDiscordClient();
    try {
      await loginAndWaitReady(client, token, () => stopping);
      setup.attach(discordSetupDiscovery(client));
    } catch {
      await client.destroy().catch(() => {});
      client = null;
      setup.unavailable('Discord login is unavailable. Check the bot token in the local .env file.');
    }
  };
  const recoverBootstrap = async () => {
    if (stopping) return;
    await setup.recover('Live startup could not complete. The saved event is intact; review the permissions and try Save and Start again.');
    await connectDiscovery();
    await launchBootstrap();
  };
  const handover = async (config: PrivateDiscordConfig, fresh: boolean) => {
    await setupHandler?.close();
    await setupServer?.stop();
    setupServer = null;
    setupHandler = null;
    await disconnectDiscovery();
    if (stopping) return;
    try { liveTask = runPrivateDiscord(config, open, false, fresh); live = await liveTask; }
    catch {
      try { await recoverBootstrap(); }
      catch { process.stderr.write('Guided recovery could not reopen the console; restart npm start.\n'); }
    }
  };
  setup = new SetupService({ token, databaseConfigured: !!healthConfig.database,
    active: activeSession, prepare: config => prepareSignupSession(config, false), onHandover: handover });
  await connectDiscovery();
  const ready = await setup.readyConfig();
  if (ready) {
    await disconnectDiscovery();
    try { liveTask = runPrivateDiscord(ready, open, false); live = await liveTask; }
    catch { await recoverBootstrap(); }
    return { stop };
  }
  await launchBootstrap();
  return { stop };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some(arg => arg !== '--no-browser')) throw new Error('Unknown guided start option.');
  const handle = await runGuidedStart({ noBrowser: process.argv.includes('--no-browser') });
  process.once('SIGINT', () => { void handle.stop(); });
  process.once('SIGTERM', () => { void handle.stop(); });
  process.once('SIGBREAK', () => { void handle.stop(); });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  void main().catch(() => { process.stderr.write('Guided start failed. Check local configuration and retry.\n'); process.exitCode = 1; });
