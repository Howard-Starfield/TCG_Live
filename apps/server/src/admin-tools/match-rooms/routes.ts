// Admin tools routes for the bot-managed match rooms (the pool of numbered tables), their chat transcripts and the
// post-event clean-up. Under /api/v1/admin-tools/match-rooms:
//   GET    ''                                (members.read)  rooms, categories, settings, baseline
//   PUT    /settings                         { expectedVersion, template, categoryId, createCategory, baselineChannelIds }
//   PATCH  /rooms/:channelId                 { customName: string | null }   (null = use the template)
//   DELETE /rooms/:channelId                 forget a room (the bot stops managing it; the channel stays)
//   POST   /ensure                           { tables }
//   POST   /adopt                            { channelId }
//   GET    /cleanup                          (members.read)  the preview, with its planToken
//   POST   /cleanup                          { planToken }   nothing is deleted before this
//   GET    /transcripts?eventId=&matchId=    (members.read)
//   GET    /transcripts/:id                  (members.read)
//   PATCH  /transcripts/:id                  { hold }
// Everything except the GETs needs server.manage and is audited. The service is attached by the Discord runtime (or the
// demo); with none attached every route answers 503.
import { LOCAL_ADMIN } from '../../ops/audit.js';
import { isMatchId, MATCH_ROOM_LIMITS, validateMatchRoomTemplate, validMatchRoomName,
  type OpsAuditKind, type SaveMatchRoomSettingsRequestDto } from '@tcg-live/core';
import { readJsonBody, strictObject } from '../../admin/http/body.js';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { OpsConflictError, OpsInputError, OpsNotFoundError } from '../../ops/errors.js';
import { badRequest, onlyParams, readableText, SNOWFLAKE, UUID, type OpsRoute } from '../../ops/http.js';
import { RuleError } from '../../rehearsal/domain.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { currentMatchRoomService, type MatchRoomService } from './service-port.js';

const BASE = '^/api/v1/admin-tools/match-rooms';
const AREA = 'match-rooms';
const NO_SERVICE = 'Rooms are available once the bot is connected.';
/** The baseline lists every voice channel and category of a server: well above any real one, still inside the body limit. */
const BASELINE_MAX = 600;

export interface MatchRoomsRouteOverrides {
  /** Defaults to the service the runtime attached (read on every request). */
  service?: MatchRoomService | null;
}

export function matchRoomsRouteModule(overrides: MatchRoomsRouteOverrides = {}): AdminToolsRouteModule {
  return { name: AREA, routes: deps => matchRoomsRoutes(deps, overrides) };
}

function snowflake(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw badRequest(`${what} must be a Discord ID.`);
  return value;
}

function parseSettings(value: unknown): SaveMatchRoomSettingsRequestDto {
  const body = strictObject(value, ['expectedVersion', 'template', 'categoryId', 'createCategory', 'baselineChannelIds']);
  if (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)
    throw badRequest('expectedVersion must be a whole number.');
  if (typeof body.template !== 'string') throw badRequest('template must be text.');
  const refused = validateMatchRoomTemplate(body.template);
  if (refused) throw badRequest(refused);
  const categoryId = body.categoryId === null || body.categoryId === undefined ? null : snowflake(body.categoryId, 'categoryId');
  let createCategory: string | null = null;
  if (body.createCategory !== null && body.createCategory !== undefined) {
    const name = typeof body.createCategory === 'string' ? body.createCategory.trim() : '';
    if (!name || !readableText(name, MATCH_ROOM_LIMITS.nameLength)) throw badRequest('The new category name must be 1-100 readable characters.');
    createCategory = name;
  }
  if (categoryId && createCategory) throw badRequest('Choose an existing category or create one, not both.');
  const ids = body.baselineChannelIds;
  if (!Array.isArray(ids) || ids.length > BASELINE_MAX) throw badRequest(`baselineChannelIds must be a list of up to ${BASELINE_MAX} channel IDs.`);
  const baselineChannelIds = [...new Set(ids.map(id => snowflake(id, 'Every baseline channel')))];
  return { expectedVersion: body.expectedVersion, template: body.template, categoryId, createCategory, baselineChannelIds };
}

function matchRoomsRoutes(deps: AdminToolsRouteDeps, overrides: MatchRoomsRouteOverrides): OpsRoute[] {
  const service = (): MatchRoomService => {
    const found = overrides.service !== undefined ? overrides.service : currentMatchRoomService();
    if (!found) throw new HttpError(503, 'unavailable', NO_SERVICE);
    return found;
  };
  // A service refusal (RuleError) is a conflict with the current state, not an outage: map it before `guarded` can.
  const run = <T>(work: () => Promise<T>): Promise<T> => deps.guarded(async () => {
    try { return await work(); }
    catch (error) {
      if (error instanceof RuleError && !(error instanceof OpsInputError || error instanceof OpsNotFoundError || error instanceof OpsConflictError))
        throw new OpsConflictError(error.message);
      throw error;
    }
  });
  const room = (params: string[]) => snowflake(params[0], 'The room');
  const changed = async (kind: OpsAuditKind, payload: Record<string, unknown>) => {
    await deps.recordAudit(kind, payload);
    deps.notify(AREA);
  };

  return [
    { pattern: new RegExp(`${BASE}$`), methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, []);
        sendJson(response, 200, await run(() => service().describe()));
      } }
    } },
    { pattern: new RegExp(`${BASE}/settings$`), methods: {
      PUT: { access: 'server.manage', run: async ({ request, response }) => {
        const svc = service();
        const input = parseSettings(await readJsonBody(request));
        const saved = await run(() => svc.saveSettings(input));
        await changed('match_rooms.settings', { template: saved.settings.template, categoryId: saved.settings.categoryId,
          createCategory: input.createCategory, baselineCount: saved.settings.baselineChannelIds.length, version: saved.settings.version });
        sendJson(response, 200, saved);
      } }
    } },
    { pattern: new RegExp(`${BASE}/rooms/([^/]+)$`), methods: {
      PATCH: { access: 'server.manage', run: async ({ request, response, params }) => {
        const svc = service();
        const channelId = room(params);
        const body = strictObject(await readJsonBody(request), ['customName']);
        if (!('customName' in body)) throw badRequest('Give customName, or null to use the template.');
        let customName: string | null = null;
        if (body.customName !== null) {
          const name = typeof body.customName === 'string' ? body.customName.trim() : '';
          const refused = validMatchRoomName(name);
          if (refused) throw badRequest(refused);
          customName = name;
        }
        const updated = await run(() => svc.setCustomName(channelId, customName));
        await changed('match_rooms.renamed', { channelId, customName });
        sendJson(response, 200, updated);
      } },
      DELETE: { access: 'server.manage', run: async ({ response, params }) => {
        const svc = service();
        const channelId = room(params);
        await run(() => svc.forget(channelId));
        await changed('match_rooms.forgotten', { channelId });
        sendJson(response, 200, { applied: true });
      } }
    } },
    { pattern: new RegExp(`${BASE}/ensure$`), methods: {
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const svc = service();
        const body = strictObject(await readJsonBody(request), ['tables']);
        if (typeof body.tables !== 'number' || !Number.isSafeInteger(body.tables) || body.tables < 1 || body.tables > MATCH_ROOM_LIMITS.serverChannels)
          throw badRequest(`tables must be a whole number from 1 to ${MATCH_ROOM_LIMITS.serverChannels}.`);
        const tables = body.tables;
        const result = await run(() => svc.ensureTables(tables));
        if (result.created.length) await changed('match_rooms.created', { tables, created: result.created });
        sendJson(response, 200, result);
      } }
    } },
    { pattern: new RegExp(`${BASE}/adopt$`), methods: {
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const svc = service();
        const body = strictObject(await readJsonBody(request), ['channelId']);
        const channelId = snowflake(body.channelId, 'channelId');
        const adopted = await run(() => svc.adopt(channelId));
        await changed('match_rooms.adopted', { channelId, table: adopted.table });
        sendJson(response, 200, adopted);
      } }
    } },
    { pattern: new RegExp(`${BASE}/cleanup$`), methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, []);
        sendJson(response, 200, await run(() => service().cleanupPlan()));
      } },
      POST: { access: 'server.manage', run: async ({ request, response }) => {
        const svc = service();
        const body = strictObject(await readJsonBody(request), ['planToken']);
        if (typeof body.planToken !== 'string' || !body.planToken || body.planToken.length > 256) throw badRequest('planToken is required.');
        const planToken = body.planToken;
        // executeCleanup writes the match_rooms.cleanup summary itself, with this actor; a second row here would double-count.
        const result = await run(() => svc.cleanupConfirm(planToken, LOCAL_ADMIN));
        deps.notify(AREA);
        sendJson(response, 200, result);
      } }
    } },
    { pattern: new RegExp(`${BASE}/transcripts$`), methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, ['eventId', 'matchId']);
        const eventId = query.get('eventId') ?? '';
        if (!eventId || !readableText(eventId, 100)) throw badRequest('eventId is required.');
        const matchId = query.get('matchId');
        if (matchId !== null && !isMatchId(matchId)) throw badRequest('matchId must look like M1.');
        sendJson(response, 200, await run(() => service().transcripts(eventId, matchId ?? undefined)));
      } }
    } },
    { pattern: new RegExp(`${BASE}/transcripts/([^/]+)$`), methods: {
      GET: { access: 'members.read', run: async ({ response, params }) => {
        const id = params[0] ?? '';
        if (!UUID.test(id)) throw badRequest('That is not a transcript ID.');
        sendJson(response, 200, await run(() => service().transcript(id)));
      } },
      PATCH: { access: 'server.manage', run: async ({ request, response, params }) => {
        const svc = service();
        const id = params[0] ?? '';
        if (!UUID.test(id)) throw badRequest('That is not a transcript ID.');
        const body = strictObject(await readJsonBody(request), ['hold']);
        if (typeof body.hold !== 'boolean') throw badRequest('hold must be true or false.');
        const hold = body.hold;
        await run(() => svc.setTranscriptHold(id, hold));
        await changed('match_rooms.transcript', { id, hold });
        sendJson(response, 200, { applied: true });
      } }
    } }
  ];
}
