// Wave 3 routes: POST /api/v1/commands and POST /api/v1/panels/refresh. Registered by handler.ts, so they
// sit behind the same Host, Origin, bearer-session and in-flight handling as every other API route.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Capability, ErrorDto } from '@tcg-live/core';
import { LOCAL_ADMIN, parseCommandRequest, parsePanelRefreshRequest, requiredCapability } from '../commands.js';
import { AdminConflictError, AdminRuleError, AdminUnavailableError, type AdminRuntime } from '../runtime-types.js';
import { readJsonBody } from './body.js';
import { HttpError, sendJson } from './respond.js';

export interface CommandRouteOptions {
  runtime: AdminRuntime;
  /** Decision 4: TCG_ADMIN_COMMANDS=1 in Discord mode, always in the demo. */
  commandsEnabled: boolean;
  /** Whether the signed-in principal holds a capability. */
  can(capability: Capability): boolean;
}

interface CommandEndpoint {
  access: 'session' | Capability;
  run(context: { request: IncomingMessage; response: ServerResponse }): Promise<void>;
}

export interface CommandRoute { pattern: RegExp; methods: { POST: CommandEndpoint } }

const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
const DISABLED = 'Admin commands are disabled for this console (TCG_ADMIN_COMMANDS).';

/**
 * Maps runtime refusals: 409 with the latest snapshot of the active event, 422 with the rule message,
 * 503 with the runtime's (generic) reason. Anything else is rethrown for the router (404, or a generic 500).
 */
async function refuse(response: ServerResponse, runtime: AdminRuntime, error: unknown): Promise<void> {
  if (error instanceof AdminConflictError) {
    const body: ErrorDto = { error: { code: 'conflict', message: error.message } };
    try { body.snapshot = await runtime.snapshot(); } catch { /* The conflict stands without a snapshot. */ }
    sendJson(response, 409, body);
    return;
  }
  if (error instanceof AdminRuleError) throw new HttpError(422, 'rule', error.message);
  if (error instanceof AdminUnavailableError) throw new HttpError(503, 'unavailable', error.message);
  throw error;
}

export function commandRoutes(options: CommandRouteOptions): CommandRoute[] {
  const { runtime } = options;
  return [
    { pattern: /^\/api\/v1\/commands$/, methods: {
      // The capability depends on the command type, so it is checked after validation.
      POST: { access: 'session', run: async ({ request, response }) => {
        if (!options.commandsEnabled) throw forbidden(DISABLED);
        const command = parseCommandRequest(await readJsonBody(request));
        if (!options.can(requiredCapability(command.command))) throw forbidden('This session may not do that.');
        let result;
        try { result = await runtime.applyAdminCommand(command, LOCAL_ADMIN); }
        catch (error) { await refuse(response, runtime, error); return; }
        sendJson(response, 200, result);
      } }
    } },
    { pattern: /^\/api\/v1\/panels\/refresh$/, methods: {
      POST: { access: 'panels.refresh', run: async ({ request, response }) => {
        if (!options.commandsEnabled) throw forbidden(DISABLED);
        const { eventId } = parsePanelRefreshRequest(await readJsonBody(request));
        let result;
        try { result = await runtime.refreshPanels(eventId); }
        catch (error) { await refuse(response, runtime, error); return; }
        sendJson(response, 200, result);
      } }
    } }
  ];
}
