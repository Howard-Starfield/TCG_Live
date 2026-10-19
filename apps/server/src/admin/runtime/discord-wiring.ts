// Glue between runPrivateDiscord and the admin console. Kept out of discord/runtime.ts so it is unit-testable.
import { Events, type Client, type Guild } from 'discord.js';
import type { AdminConfig } from '../config.js';
import { createAdminHandler, type AdminHandler, type AdminHandlerOptions } from '../mount.js';
import { DiscordAdminRuntime, type AdminController, type AdminGateway, type AdminRooms,
  type DiscordAdminRuntimeOptions, type GatewayState } from './discord-runtime.js';
import type { MemberFetcher } from './identity.js';

export interface DiscordAdminOptions {
  adminConfig: AdminConfig;
  port: number;
  runnerId: string;
  publicMatchRooms: boolean;
  lease?: { isLost(): boolean };
  createRuntime?: (options: DiscordAdminRuntimeOptions) => DiscordAdminRuntime;
  createHandler?: (options: AdminHandlerOptions) => AdminHandler;
  write?: (text: string) => void;
}

export interface DiscordAdmin {
  readonly handler: AdminHandler;
  readonly runtime: DiscordAdminRuntime;
  attachClient(gateway: AdminGateway, members: MemberFetcher | null): void;
  attachController(controller: AdminController): void;
  attachRooms(rooms: AdminRooms): void;
  /** Prints `Admin console: <url>` once, when a launch link exists. */
  announce(): void;
  /** Handler first (ends streams, answers 503), then the runtime. Idempotent; never rejects. */
  close(): Promise<void>;
}

/** Undefined when TCG_ADMIN_CONSOLE is off: the bot then runs exactly as before. */
export function createDiscordAdmin(options: DiscordAdminOptions): DiscordAdmin | undefined {
  if (!options.adminConfig.console) return undefined;
  const runtime = (options.createRuntime ?? (settings => new DiscordAdminRuntime(settings)))({
    runnerId: options.runnerId, commandsEnabled: options.adminConfig.commandsEnabled,
    publicMatchRooms: options.publicMatchRooms, ...(options.lease ? { lease: options.lease } : {})
  });
  const handler = (options.createHandler ?? createAdminHandler)({
    runtime, port: options.port, mode: 'discord', commandsEnabled: options.adminConfig.commandsEnabled,
    webDist: options.adminConfig.webDist
  });
  const write = options.write ?? (text => { process.stdout.write(text); });
  let announced = false;
  let closing: Promise<void> | undefined;
  return {
    handler, runtime,
    attachClient: (gateway, members) => { try { runtime.attachGateway(gateway, members); } catch { /* Console only. */ } },
    attachController: controller => { try { runtime.attachController(controller); } catch { /* Console only. */ } },
    attachRooms: rooms => { try { runtime.attachRooms(rooms); } catch { /* Console only. */ } },
    announce() {
      if (announced) return;
      announced = true;
      let url: string | null = null;
      try { url = handler.loginUrl(); } catch { /* No link. */ }
      if (url) write(`Admin console: ${url}\n`);
    },
    close() {
      closing ??= (async () => {
        try { await handler.close(); } catch { /* Shutdown continues. */ }
        try { await runtime.close(); } catch { /* Shutdown continues. */ }
      })();
      return closing;
    }
  };
}

/** Gateway lifecycle from discord.js shard events. Adds listeners only; no intents or requests. */
export function discordGateway(client: Client): AdminGateway {
  return {
    isReady: () => client.isReady(),
    watch(onChange: (state: GatewayState) => void) {
      const ready = () => onChange('ready');
      const reconnecting = () => onChange('reconnecting');
      const offline = () => onChange('offline');
      client.on(Events.ShardReady, ready);
      client.on(Events.ShardResume, ready);
      client.on(Events.ShardReconnecting, reconnecting);
      client.on(Events.ShardDisconnect, offline);
      client.on(Events.Invalidated, offline);
      return () => {
        client.off(Events.ShardReady, ready);
        client.off(Events.ShardResume, ready);
        client.off(Events.ShardReconnecting, reconnecting);
        client.off(Events.ShardDisconnect, offline);
        client.off(Events.Invalidated, offline);
      };
    }
  };
}

/** One member per REST call (GET /guilds/:guild/members/:user); falls back to the user for former members. */
export function guildMembers(guild: Guild): MemberFetcher {
  return async id => {
    try {
      const member = await guild.members.fetch(id);
      return { displayName: member.displayName, avatarUrl: member.displayAvatarURL({ size: 64 }) };
    } catch (error) {
      if ((error as { code?: number })?.code !== 10007) throw error;   // Unknown Member
    }
    try {
      const user = await guild.client.users.fetch(id);
      return { displayName: user.displayName, avatarUrl: user.displayAvatarURL({ size: 64 }) };
    } catch (error) {
      if ((error as { code?: number })?.code === 10013) return null;   // Unknown User
      throw error;
    }
  };
}
