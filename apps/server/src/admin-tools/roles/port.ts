// Which RolesGuildPort a route uses: the synthetic demo server (one shared port per demo guild, so panel
// and announcement messages live in one place) or the live guild.
import { HttpError } from '../../admin/http/respond.js';
import type { DemoGuild } from '../demo-guild.js';
import type { AdminToolsRouteDeps } from '../module.js';
import { DemoRolesGuildPort, discordFailure, discordGuildPort, type RolesGuildPort } from './guild-port.js';

const demoPorts = new WeakMap<DemoGuild, DemoRolesGuildPort>();

export function demoPortFor(demo: DemoGuild, now?: () => number): DemoRolesGuildPort {
  let port = demoPorts.get(demo);
  if (!port) { port = new DemoRolesGuildPort(demo, now); demoPorts.set(demo, port); }
  return port;
}

export function routePort(deps: AdminToolsRouteDeps): () => Promise<RolesGuildPort> {
  return async () => {
    if (deps.demo) return demoPortFor(deps.demo, deps.now);
    if (!deps.discord) throw new HttpError(503, 'unavailable', 'Discord is not connected.');
    return discordGuildPort(await deps.discord.guild());
  };
}

/** A Discord call from a route: failures become a 409 with a safe message. */
export async function discordCall<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, 'rule', discordFailure(error));
  }
}
